import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';

import { type AuthorityStore, MemoryAuthorityStore, openAuthorityStore } from './authority-store';
import { acquireClaims } from './claims';
import {
  abandonGeneration,
  fenceExpiredGenerations,
  heartbeatGeneration,
  integrateGeneration,
  rejectGeneration,
  releaseGeneration,
  submitGeneration,
} from './generations';

const PATCH = '1'.repeat(64);
const DIFF = '2'.repeat(64);
const CONTENT = '3'.repeat(64);
const OTHER_PATCH = '4'.repeat(64);

const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { force: true, recursive: true });
});

function git(cwd: string, argv: readonly string[]): void {
  const invocation = Bun.spawnSync(['git', '-C', cwd, ...argv], { stderr: 'pipe', stdout: 'pipe' });
  if (invocation.exitCode !== 0) throw new Error(new TextDecoder().decode(invocation.stderr));
}

function repository(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'wiki-generations-'));
  scratchRoots.push(fixture);
  const root = join(fixture, 'repository');
  mkdirSync(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '--message', 'fixture']);
  return root;
}

const submission = {
  candidateDiffIdentity: DIFF,
  contentIdentity: CONTENT,
  patchIdentity: PATCH,
};

test('SQLite persists terminal history and immutable submitted claims', () => {
  const root = repository();
  let now = 1_000;
  const store = openAuthorityStore(root, { clock: { read: () => now } });
  const rejected = acquireClaims(store, {
    owner: { sessionId: 'rejected', worktreePath: root },
    paths: [{ access: 'write', path: 'tools/rejected' }],
    conflictGroups: [],
  });
  now = 1_010;
  rejectGeneration(store, rejected);
  now = 1_020;
  const submitted = acquireClaims(store, {
    owner: { sessionId: 'submitted', worktreePath: root },
    paths: [{ access: 'write', path: 'tools/submitted' }],
    conflictGroups: [],
  });
  now = 1_030;
  submitGeneration(store, submitted, submission);
  store.close();

  const reopened = openAuthorityStore(root, { clock: { read: () => 1_040 } });
  expect(reopened.inspect().generations).toEqual([
    {
      claims: [],
      generation: 1,
      heartbeatAt: 1_000,
      sessionId: 'rejected',
      status: 'rejected',
      statusAt: 1_010,
      submission: undefined,
      worktreePath: root,
    },
    {
      claims: [{ access: 'write', identity: 'tools/submitted', kind: 'path' }],
      generation: 2,
      heartbeatAt: 1_020,
      sessionId: 'submitted',
      status: 'submitted',
      statusAt: 1_030,
      submission,
      worktreePath: root,
    },
  ]);
  reopened.close();
});

test('memory and SQLite adapters persist the same lifecycle transitions', () => {
  const root = repository();
  let now = 1_000;
  const memory = new MemoryAuthorityStore(undefined, { read: () => now });
  const sqlite = openAuthorityStore(root, { clock: { read: () => now } });
  const stores: AuthorityStore[] = [memory, sqlite];
  for (const store of stores) {
    const released = acquireClaims(store, {
      owner: { sessionId: 'released', worktreePath: root },
      paths: [{ access: 'write', path: 'tools/released' }],
      conflictGroups: [],
    });
    now = 1_010;
    heartbeatGeneration(store, released);
    now = 1_020;
    expect(fenceExpiredGenerations(store, 10)).toEqual([released]);
    now = 1_030;
    releaseGeneration(store, released);

    now = 1_040;
    const integrated = acquireClaims(store, {
      owner: { sessionId: 'integrated', worktreePath: root },
      paths: [{ access: 'write', path: 'tools/integrated' }],
      conflictGroups: [],
    });
    now = 1_050;
    submitGeneration(store, integrated, submission);
    now = 1_060;
    integrateGeneration(store, integrated);

    now = 1_070;
    const abandoned = acquireClaims(store, {
      owner: { sessionId: 'abandoned', worktreePath: root },
      paths: [{ access: 'write', path: 'tools/abandoned' }],
      conflictGroups: [],
    });
    now = 1_080;
    abandonGeneration(store, abandoned);
    now = 1_000;
  }

  expect(sqlite.transact((transaction) => transaction.readState())).toEqual(memory.inspect());
  sqlite.close();
});

test('SQLite refuses malformed lifecycle state before it can be treated as available', () => {
  for (const mutation of [
    "UPDATE authority_generation SET status = 'unknown'",
    'UPDATE authority_generation SET status_at = heartbeat_at - 1',
    "UPDATE authority_generation SET status = 'integrated'",
    `UPDATE authority_generation SET status = 'submitted', patch_identity = 'bad', candidate_diff_identity = '${DIFF}', content_identity = '${CONTENT}'`,
  ]) {
    const root = repository();
    const store = openAuthorityStore(root, { clock: { read: () => 1_000 } });
    acquireClaims(store, {
      owner: { sessionId: 'session-a', worktreePath: root },
      paths: [{ access: 'write', path: 'tools/shared' }],
      conflictGroups: [],
    });
    store.close();
    const database = new Database(join(root, '.git', 'wbs-wiki', 'authority.sqlite'));
    database.run('PRAGMA ignore_check_constraints = ON');
    database.run(mutation);
    database.close();

    expect(() => openAuthorityStore(root)).toThrow('authority database corrupt');
  }
});

test('SQLite refuses a malformed trusted clock adapter during construction', () => {
  const root = repository();
  expect(() => openAuthorityStore(root, { clock: {} })).toThrow('invalid authority clock adapter');
});

const WORKER = `
const [{ openAuthorityStore }, { acquireClaims }, generations] = await Promise.all([
  import(process.argv[2]), import(process.argv[3]), import(process.argv[4]),
]);
const input = JSON.parse(process.argv[5]);
const store = openAuthorityStore(input.root);
try {
  let output;
  if (input.operation === 'acquire') output = acquireClaims(store, input.request);
  else if (input.operation === 'reject') output = generations.rejectGeneration(store, input.token);
  else if (input.operation === 'submit') output = generations.submitGeneration(store, input.token, input.submission);
  else if (input.operation === 'release') output = generations.releaseGeneration(store, input.token);
  else throw new Error('unknown operation');
  console.log(JSON.stringify({ ok: true, output }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
} finally { store.close(); }
`;

interface Observation {
  readonly ok: boolean;
  readonly message?: string;
  readonly output?: { readonly generation: number; readonly sessionId: string };
}

async function runWorker(root: string, input: unknown): Promise<Observation> {
  const worker = join(root, '..', `worker-${crypto.randomUUID()}.ts`);
  writeFileSync(worker, WORKER);
  const child = Bun.spawn(
    [
      process.execPath,
      worker,
      pathToFileURL(join(import.meta.dir, 'authority-store.ts')).href,
      pathToFileURL(join(import.meta.dir, 'claims.ts')).href,
      pathToFileURL(join(import.meta.dir, 'generations.ts')).href,
      JSON.stringify(input),
    ],
    { cwd: root, stderr: 'pipe', stdout: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`worker exited ${String(exitCode)}: ${stderr}`);
  // Test boundary: the literal worker above emits this closed shape.
  return JSON.parse(stdout.trim()) as Observation;
}

function claim(root: string, sessionId: string, path: string) {
  return {
    conflictGroups: [],
    owner: { sessionId, worktreePath: root },
    paths: [{ access: 'write', path }],
  };
}

test('separate processes fence stale generations and preserve a successor and frozen publication', async () => {
  const root = repository();
  const first = await runWorker(root, {
    operation: 'acquire',
    request: claim(root, 'session-a', 'tools/shared'),
    root,
  });
  expect(first).toMatchObject({ ok: true });
  const firstToken = first.output;
  if (firstToken === undefined) throw new Error('first worker omitted its token');
  expect(await runWorker(root, { operation: 'reject', root, token: firstToken })).toMatchObject({
    ok: true,
  });

  const second = await runWorker(root, {
    operation: 'acquire',
    request: claim(root, 'session-b', 'tools/shared'),
    root,
  });
  expect(second).toMatchObject({ ok: true, output: { generation: 2 } });
  expect(
    await runWorker(root, { operation: 'submit', root, submission, token: firstToken }),
  ).toMatchObject({ ok: false, message: 'generation is terminal: session-a' });
  expect(
    await runWorker(root, {
      operation: 'release',
      root,
      token: { generation: 1, sessionId: 'session-b' },
    }),
  ).toMatchObject({ ok: false, message: 'generation does not exist: session-b/1' });

  const secondToken = second.output;
  if (secondToken === undefined) throw new Error('second worker omitted its token');
  expect(
    await runWorker(root, { operation: 'submit', root, submission, token: secondToken }),
  ).toMatchObject({ ok: true });
  expect(
    await runWorker(root, {
      operation: 'submit',
      root,
      submission: { ...submission, patchIdentity: OTHER_PATCH },
      token: secondToken,
    }),
  ).toMatchObject({ ok: false, message: 'generation already submitted: session-b' });

  const store = openAuthorityStore(root);
  expect(store.inspect().generations.find(({ generation }) => generation === 2)).toMatchObject({
    claims: [{ access: 'write', identity: 'tools/shared', kind: 'path' }],
    status: 'submitted',
    submission,
  });
  store.close();
});
