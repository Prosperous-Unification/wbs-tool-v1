import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';

import {
  AuthorityContentionError,
  openAuthorityStore,
  resolveAuthorityDatabasePath,
} from './authority-store';
import { acquireClaims } from './claims';

const WORKER_SOURCE = `
const [{ openAuthorityStore }, { acquireClaims, expandClaims }] = await Promise.all([
  import(process.argv[2]),
  import(process.argv[3]),
]);
const input = JSON.parse(process.argv[4]);
const store = openAuthorityStore(input.worktreePath, input.options);
try {
  if (input.readyPath) await Bun.write(input.readyPath, 'ready');
  if (input.startPath) {
    for (let attempt = 0; attempt < 5000 && !require('node:fs').existsSync(input.startPath); attempt += 1) {
      Bun.sleepSync(1);
    }
    if (!require('node:fs').existsSync(input.startPath)) throw new Error('worker start barrier absent');
  }
  const output = input.kind === 'expand'
    ? expandClaims(store, input.request)
    : acquireClaims(store, input.request);
  console.log(JSON.stringify({ ok: true, output }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
} finally {
  store.close();
}
`;

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { force: true, recursive: true });
});

interface FixtureRepository {
  readonly root: string;
  readonly worktreeA: string;
  readonly worktreeB: string;
  readonly worker: string;
}

function git(cwd: string, argv: readonly string[]): void {
  const invocation = Bun.spawnSync(['git', '-C', cwd, ...argv], { stderr: 'pipe', stdout: 'pipe' });
  if (invocation.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(invocation.stderr));
  }
}

function fixtureRepository(): FixtureRepository {
  const fixture = mkdtempSync(join(tmpdir(), 'wiki-authority-'));
  scratchRoots.push(fixture);
  const root = join(fixture, 'repository');
  const worktreeA = join(fixture, 'worktree-a');
  const worktreeB = join(fixture, 'worktree-b');
  const worker = join(fixture, 'claims-worker.ts');
  mkdirSync(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '--message', 'fixture']);
  git(root, ['worktree', 'add', '--quiet', '-b', 'worker-a', worktreeA]);
  git(root, ['worktree', 'add', '--quiet', '-b', 'worker-b', worktreeB]);
  writeFileSync(worker, WORKER_SOURCE);
  return { root, worker, worktreeA, worktreeB };
}

interface WorkerInput {
  readonly kind: 'acquire' | 'expand';
  readonly worktreePath: string;
  readonly request: unknown;
  readonly readyPath?: string;
  readonly startPath?: string;
  readonly options?: { readonly maxBusyAttempts: number; readonly busyDelayMilliseconds: number };
}

function spawnWorker(fixture: FixtureRepository, input: WorkerInput) {
  const storeModule = pathToFileURL(join(import.meta.dir, 'authority-store.ts')).href;
  const claimsModule = pathToFileURL(join(import.meta.dir, 'claims.ts')).href;
  return Bun.spawn(
    [process.execPath, fixture.worker, storeModule, claimsModule, JSON.stringify(input)],
    { cwd: input.worktreePath, stderr: 'pipe', stdout: 'pipe' },
  );
}

interface WorkerObservation {
  readonly ok: boolean;
  readonly message?: string;
  readonly output?: { readonly generation: number; readonly sessionId: string };
}

async function observation(child: ReturnType<typeof spawnWorker>): Promise<WorkerObservation> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`worker exited ${String(exitCode)}: ${stderr}`);
  // Test boundary: the worker emits this closed shape from the literal above.
  return JSON.parse(stdout.trim()) as WorkerObservation;
}

function waitForFiles(paths: readonly string[]): void {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (paths.every(existsSync)) return;
    Bun.sleepSync(1);
  }
  throw new Error(`worker readiness absent: ${paths.join(', ')}`);
}

function claim(sessionId: string, worktreePath: string, path: string) {
  return {
    owner: { sessionId, worktreePath },
    paths: [{ access: 'write' as const, path }],
    conflictGroups: [],
  };
}

test('resolves linked and symlinked worktrees to one canonical common-Git authority', () => {
  const fixture = fixtureRepository();
  const alias = join(fixture.root, '..', 'worktree-alias');
  symlinkSync(fixture.worktreeA, alias, 'dir');

  const paths = [fixture.root, fixture.worktreeA, fixture.worktreeB, alias].map(
    resolveAuthorityDatabasePath,
  );
  expect(new Set(paths).size).toBe(1);
  expect(paths[0]).toEndWith('/.git/wbs-wiki/authority.sqlite');

  const first = openAuthorityStore(fixture.worktreeA);
  expect(acquireClaims(first, claim('session-a', fixture.worktreeA, 'libs/contracts'))).toEqual({
    generation: 1,
    sessionId: 'session-a',
  });
  first.close();
  const second = openAuthorityStore(fixture.worktreeB);
  expect(() =>
    acquireClaims(second, claim('session-b', fixture.worktreeB, 'libs/contracts/src')),
  ).toThrow('path claim overlaps session session-a');
  second.close();
});

test('refuses an authority-directory symlink outside the canonical common Git directory', () => {
  const fixture = fixtureRepository();
  const external = join(fixture.root, '..', 'external-authority');
  mkdirSync(external);
  symlinkSync(external, join(fixture.root, '.git', 'wbs-wiki'), 'dir');

  expect(() => resolveAuthorityDatabasePath(fixture.root)).toThrow(
    'authority directory is not canonical',
  );
});

test('refuses an existing authority database symlink', () => {
  const fixture = fixtureRepository();
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const external = join(fixture.root, '..', 'external-authority.sqlite');
  new Database(external, { create: true }).close();
  symlinkSync(external, databasePath);

  expect(() => openAuthorityStore(fixture.root)).toThrow('authority database is not canonical');
});

test('two Bun processes atomically refuse overlap and both admit disjoint work', async () => {
  const fixture = fixtureRepository();
  const startOverlap = join(fixture.root, 'start-overlap');
  const readyA = join(fixture.root, 'ready-a');
  const readyB = join(fixture.root, 'ready-b');
  const overlapping = [
    spawnWorker(fixture, {
      kind: 'acquire',
      worktreePath: fixture.worktreeA,
      request: {
        owner: { sessionId: 'session-a', worktreePath: fixture.worktreeA },
        paths: [
          { access: 'write', path: 'apps/a-only' },
          { access: 'write', path: 'libs/contracts' },
        ],
        conflictGroups: [],
      },
      readyPath: readyA,
      startPath: startOverlap,
    }),
    spawnWorker(fixture, {
      kind: 'acquire',
      worktreePath: fixture.worktreeB,
      request: {
        owner: { sessionId: 'session-b', worktreePath: fixture.worktreeB },
        paths: [
          { access: 'write', path: 'apps/b-only' },
          { access: 'write', path: 'libs/contracts/src' },
        ],
        conflictGroups: [],
      },
      readyPath: readyB,
      startPath: startOverlap,
    }),
  ];
  waitForFiles([readyA, readyB]);
  writeFileSync(startOverlap, 'start');
  const overlap = await Promise.all(overlapping.map(observation));
  expect(overlap.filter(({ ok }) => ok)).toHaveLength(1);
  expect(overlap.find(({ ok }) => !ok)?.message).toContain('path claim overlaps session');
  const afterOverlap = openAuthorityStore(fixture.root);
  const overlapState = afterOverlap.inspect();
  afterOverlap.close();
  expect(overlapState.owners).toHaveLength(1);
  expect(overlapState.owners[0]?.claims).toHaveLength(2);

  const disjoint = await Promise.all([
    observation(
      spawnWorker(fixture, {
        kind: 'acquire',
        worktreePath: fixture.worktreeA,
        request: claim('session-c', fixture.worktreeA, 'apps/fe-01'),
      }),
    ),
    observation(
      spawnWorker(fixture, {
        kind: 'acquire',
        worktreePath: fixture.worktreeB,
        request: claim('session-d', fixture.worktreeB, 'apps/gw-01'),
      }),
    ),
  ]);
  expect(disjoint.map(({ ok }) => ok)).toEqual([true, true]);
});

test('two Bun processes serialize exclusive conflict-group claims', async () => {
  const fixture = fixtureRepository();
  const start = join(fixture.root, 'start-groups');
  const readyA = join(fixture.root, 'ready-group-a');
  const readyB = join(fixture.root, 'ready-group-b');
  const children = [
    spawnWorker(fixture, {
      kind: 'acquire',
      worktreePath: fixture.worktreeA,
      request: {
        ...claim('session-a', fixture.worktreeA, 'apps/fe-01'),
        conflictGroups: ['root-schema'],
      },
      readyPath: readyA,
      startPath: start,
    }),
    spawnWorker(fixture, {
      kind: 'acquire',
      worktreePath: fixture.worktreeB,
      request: {
        ...claim('session-b', fixture.worktreeB, 'apps/gw-01'),
        conflictGroups: ['root-schema'],
      },
      readyPath: readyB,
      startPath: start,
    }),
  ];
  waitForFiles([readyA, readyB]);
  writeFileSync(start, 'start');
  const observations = await Promise.all(children.map(observation));

  expect(observations.filter(({ ok }) => ok)).toHaveLength(1);
  expect(observations.find(({ ok }) => !ok)?.message).toContain(
    'conflict-group claim belongs to session',
  );
});

test('two process expansions preserve the refused owner and commit the disjoint owner', async () => {
  const fixture = fixtureRepository();
  for (const [sessionId, worktreePath, path] of [
    ['session-a', fixture.worktreeA, 'docs'],
    ['session-b', fixture.worktreeB, 'libs/contracts'],
    ['session-c', fixture.worktreeA, 'tools'],
  ] as const) {
    expect(
      await observation(
        spawnWorker(fixture, {
          kind: 'acquire',
          worktreePath,
          request: claim(sessionId, worktreePath, path),
        }),
      ),
    ).toMatchObject({ ok: true });
  }

  const [refused, admitted] = await Promise.all([
    observation(
      spawnWorker(fixture, {
        kind: 'expand',
        worktreePath: fixture.worktreeA,
        request: {
          token: { generation: 1, sessionId: 'session-a' },
          paths: [
            { access: 'write', path: 'apps/partial' },
            { access: 'write', path: 'libs' },
          ],
          conflictGroups: [],
        },
      }),
    ),
    observation(
      spawnWorker(fixture, {
        kind: 'expand',
        worktreePath: fixture.worktreeA,
        request: {
          token: { generation: 3, sessionId: 'session-c' },
          paths: [{ access: 'write', path: 'apps/disjoint' }],
          conflictGroups: ['ui-shell'],
        },
      }),
    ),
  ]);
  expect(refused.ok).toBeFalse();
  expect(refused.message).toContain('overlaps');
  expect(admitted).toMatchObject({ ok: true });

  const store = openAuthorityStore(fixture.root);
  const state = store.inspect();
  store.close();
  expect(state.owners.find(({ sessionId }) => sessionId === 'session-a')?.claims).toEqual([
    { access: 'write', identity: 'docs', kind: 'path' },
  ]);
  expect(state.owners.find(({ sessionId }) => sessionId === 'session-c')?.claims).toContainEqual({
    access: 'write',
    identity: 'apps/disjoint',
    kind: 'path',
  });
});

test('fails closed for corrupt, incompatible and unreadable existing state', () => {
  for (const fault of ['corrupt', 'incompatible', 'unreadable'] as const) {
    const fixture = fixtureRepository();
    const databasePath = resolveAuthorityDatabasePath(fixture.root);
    mkdirSync(join(databasePath, '..'), { recursive: true });
    if (fault === 'corrupt') writeFileSync(databasePath, 'not sqlite');
    if (fault === 'incompatible') new Database(databasePath, { create: true }).close();
    if (fault === 'unreadable') {
      writeFileSync(databasePath, 'not readable');
      chmodSync(databasePath, 0o000);
    }
    try {
      expect(() => openAuthorityStore(fixture.root)).toThrow(
        fault === 'incompatible'
          ? 'authority database schema is incompatible'
          : fault === 'unreadable'
            ? 'authority database unreadable'
            : 'authority database corrupt or incompatible',
      );
    } finally {
      if (fault === 'unreadable') chmodSync(databasePath, 0o600);
    }
  }
});

test('refuses an added schema object and an unknown state version', () => {
  for (const fault of ['extra-table', 'extra-index', 'extra-view', 'unknown-version'] as const) {
    const fixture = fixtureRepository();
    const store = openAuthorityStore(fixture.root);
    store.close();
    const databasePath = resolveAuthorityDatabasePath(fixture.root);
    const database = new Database(databasePath);
    if (fault === 'extra-table') database.run('CREATE TABLE foreign_state(id INTEGER) STRICT');
    else if (fault === 'extra-index')
      database.run('CREATE INDEX foreign_index ON authority_owner(worktree_path)');
    else if (fault === 'extra-view')
      database.run('CREATE VIEW foreign_view AS SELECT session_id FROM authority_owner');
    else database.run("UPDATE authority_meta SET schema_version = 'unknown.v99'");
    database.close();

    expect(() => openAuthorityStore(fixture.worktreeA)).toThrow(
      fault === 'unknown-version'
        ? 'authority database version is incompatible'
        : 'authority database schema is incompatible',
    );
  }
});

test('refuses a sqliteX-prefixed trigger before it can erase authority claims', () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root);
  acquireClaims(store, claim('session-a', fixture.worktreeA, 'libs/contracts'));
  store.close();
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const database = new Database(databasePath);
  database.run(`CREATE TRIGGER sqliteXerase AFTER INSERT ON authority_claim
    BEGIN DELETE FROM authority_claim; END`);
  database.close();

  let refusal: unknown;
  try {
    const reopened = openAuthorityStore(fixture.worktreeA);
    acquireClaims(reopened, claim('session-b', fixture.worktreeB, 'apps/fe-01'));
    reopened.close();
  } catch (error) {
    refusal = error;
  }
  const observed = new Database(databasePath);
  const row = observed
    .query<{ count: number }, []>('SELECT count(*) AS count FROM authority_claim')
    .get();
  observed.close();

  expect({
    claimCount: row?.count,
    refusal: refusal instanceof Error ? refusal.message : undefined,
  }).toEqual({
    claimCount: 1,
    refusal: 'authority database schema is incompatible',
  });
});

test('refuses relational corruption before treating an orphan claim as unowned', () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root);
  store.close();
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const database = new Database(databasePath);
  database.run('PRAGMA foreign_keys = OFF');
  database.run(
    "INSERT INTO authority_claim(session_id, generation, kind, access, identity) VALUES ('absent', 9, 'path', 'write', 'libs/contracts')",
  );
  database.close();

  expect(() => openAuthorityStore(fixture.worktreeA)).toThrow(
    'authority database corrupt: foreign-key check failed',
  );
});

test('refuses malformed persisted owner and claim identities before overlap decisions', () => {
  const faults = [
    {
      message: 'authority database owner session is invalid: bad/session',
      mutations: [
        "UPDATE authority_claim SET session_id = 'bad/session'",
        "UPDATE authority_owner SET session_id = 'bad/session'",
      ],
    },
    {
      message: 'authority database owner worktree is invalid: relative',
      mutations: ["UPDATE authority_owner SET worktree_path = 'relative'"],
    },
    {
      message: 'authority database path claim is invalid: libs/./contracts',
      mutations: ["UPDATE authority_claim SET identity = 'libs/./contracts' WHERE kind = 'path'"],
    },
    {
      message: 'authority database conflict group is invalid: bad/group',
      mutations: ["UPDATE authority_claim SET identity = 'bad/group' WHERE kind = 'group'"],
    },
    {
      message: 'authority database corrupt: quick_check=CHECK constraint failed',
      mutations: [
        'PRAGMA ignore_check_constraints = ON',
        "UPDATE authority_claim SET access = 'execute' WHERE kind = 'path'",
      ],
    },
  ] as const;

  for (const fault of faults) {
    const fixture = fixtureRepository();
    const store = openAuthorityStore(fixture.root);
    acquireClaims(store, {
      ...claim('session-a', fixture.worktreeA, 'libs/contracts'),
      conflictGroups: ['root-schema'],
    });
    store.close();
    const databasePath = resolveAuthorityDatabasePath(fixture.root);
    const database = new Database(databasePath);
    database.run('PRAGMA foreign_keys = OFF');
    for (const mutation of fault.mutations) database.run(mutation);
    database.close();

    expect(() => openAuthorityStore(fixture.worktreeB)).toThrow(fault.message);
  }
});

test('bounds terminal lock contention and retries until a held write commits', async () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root, {
    maxBusyAttempts: 2,
    busyDelayMilliseconds: 0,
  });
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const blocker = new Database(databasePath);
  blocker.run('PRAGMA busy_timeout = 0');
  blocker.run('BEGIN IMMEDIATE');
  expect(() =>
    acquireClaims(store, claim('session-terminal', fixture.worktreeA, 'apps/terminal')),
  ).toThrow(AuthorityContentionError);
  blocker.run('ROLLBACK');
  blocker.close();
  store.close();

  const holderReady = join(fixture.root, 'holder-ready');
  const release = join(fixture.root, 'release');
  const holder = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { Database } from 'bun:sqlite'; import { existsSync, writeFileSync } from 'node:fs'; const db = new Database(process.argv[1]); db.run('PRAGMA busy_timeout = 0'); db.run('BEGIN IMMEDIATE'); writeFileSync(process.argv[2], 'ready'); while (!existsSync(process.argv[3])) Bun.sleepSync(1); db.run('COMMIT'); db.close();`,
      databasePath,
      holderReady,
      release,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  waitForFiles([holderReady]);
  const contenderReady = join(fixture.root, 'contender-ready');
  const contender = spawnWorker(fixture, {
    kind: 'acquire',
    worktreePath: fixture.worktreeB,
    request: claim('session-retry', fixture.worktreeB, 'apps/retry'),
    readyPath: contenderReady,
    options: { maxBusyAttempts: 100, busyDelayMilliseconds: 1 },
  });
  waitForFiles([contenderReady]);
  Bun.sleepSync(10);
  writeFileSync(release, 'release');
  expect(await holder.exited).toBe(0);
  expect(await observation(contender)).toMatchObject({ ok: true });
});

test('retries the complete transaction until a rollback-journal reader releases commit', async () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root, {
    maxBusyAttempts: 100,
    busyDelayMilliseconds: 2,
  });
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const readerReady = join(fixture.root, 'reader-ready');
  const reader = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs'; const db = new Database(process.argv[1]); db.run('PRAGMA busy_timeout = 0'); db.run('BEGIN'); db.query('SELECT count(*) FROM authority_owner').get(); writeFileSync(process.argv[2], 'ready'); Bun.sleepSync(40); db.run('ROLLBACK'); db.close();`,
      databasePath,
      readerReady,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  waitForFiles([readerReady]);

  expect(acquireClaims(store, claim('session-reader', fixture.worktreeA, 'apps/reader'))).toEqual({
    generation: 1,
    sessionId: 'session-reader',
  });
  expect(await reader.exited).toBe(0);
  expect(store.inspect().owners).toHaveLength(1);
  store.close();
});

test('bounds commit contention by attempts and delay without retaining a partial write', () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root, {
    maxBusyAttempts: 3,
    busyDelayMilliseconds: 10,
  });
  const databasePath = resolveAuthorityDatabasePath(fixture.root);
  const reader = new Database(databasePath);
  reader.run('PRAGMA busy_timeout = 0');
  reader.run('BEGIN');
  reader.query('SELECT count(*) FROM authority_owner').get();
  let callbackAttempts = 0;
  const started = performance.now();

  expect(() => {
    store.transact((transaction) => {
      callbackAttempts += 1;
      const state = transaction.readState();
      transaction.writeState({ ...state, nextGeneration: 2 });
      return undefined;
    });
  }).toThrow(AuthorityContentionError);
  const elapsedMilliseconds = performance.now() - started;
  reader.run('ROLLBACK');
  reader.close();

  expect(callbackAttempts).toBe(3);
  expect(elapsedMilliseconds).toBeGreaterThanOrEqual(20);
  expect(store.inspect().nextGeneration).toBe(1);
  store.close();
});

test('reports both failures and does not retry after rollback leaves transaction state unknown', () => {
  const fixture = fixtureRepository();
  const store = openAuthorityStore(fixture.root, {
    maxBusyAttempts: 3,
    busyDelayMilliseconds: 0,
  });
  const runDescriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'run');
  if (runDescriptor === undefined) throw new Error('Database.run descriptor is absent');
  const originalRun: PropertyDescriptor = runDescriptor;
  const rollbackFailure = new Error('injected rollback failure');
  const transactionFailure = Object.assign(new Error('injected body contention'), {
    code: 'SQLITE_BUSY',
  });
  let callbackAttempts = 0;
  function runWithRollbackFault(this: Database, sql: string) {
    if (sql === 'ROLLBACK') throw rollbackFailure;
    Object.defineProperty(Database.prototype, 'run', originalRun);
    try {
      return this.run(sql);
    } finally {
      Object.defineProperty(Database.prototype, 'run', rollbackFault);
    }
  }
  const rollbackFault: PropertyDescriptor = {
    configurable: true,
    value: runWithRollbackFault,
    writable: true,
  };
  Object.defineProperty(Database.prototype, 'run', rollbackFault);

  let failure: unknown;
  try {
    store.transact(() => {
      callbackAttempts += 1;
      throw transactionFailure;
    });
  } catch (error) {
    failure = error;
  } finally {
    Object.defineProperty(Database.prototype, 'run', originalRun);
  }

  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    errors: [transactionFailure, rollbackFailure],
    message: 'authority transaction and rollback both failed',
  });
  expect(callbackAttempts).toBe(1);
  store.close();
});

test('rejects contention settings outside the finite authority budget', () => {
  const fixture = fixtureRepository();
  expect(() =>
    openAuthorityStore(fixture.root, {
      maxBusyAttempts: 1001,
      busyDelayMilliseconds: 1,
    }),
  ).toThrow('invalid authority busy attempt bound: 1001');
  expect(() =>
    openAuthorityStore(fixture.root, {
      maxBusyAttempts: 1,
      busyDelayMilliseconds: 1001,
    }),
  ).toThrow('invalid authority busy delay: 1001');
});
