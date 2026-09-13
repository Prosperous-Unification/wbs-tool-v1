import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { createLogger } from '@wbs/observability';
import { openSqliteSource } from '@wbs/store-sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { errors } from 'jose';

import { bootBe01, type RunningBe } from './boot';
import type { OidcRouteOptions } from './controller/oidc-options';
import { openDatabase, openDrizzle } from './repository/db';
import type { WriteCoordinator } from './repository/gate';
import { runMigrations } from './repository/migrate';
import { allocateGeneration, readGeneration } from './repository/optimization-generation';
import type { AuthenticatedUser } from './service/auth.service';

/**
 * What `/health` answers, as this suite reads it.
 *
 * Both keys, because both are asserted: the three casts here named one field
 * each and `toEqual` was then comparing an object against a type that did not
 * declare half of it — which is a type error nothing compiled until 2026-09-02.
 */
interface HealthAnswer {
  status: string;
  commit: string | null;
}

const FOLDER = new URL('../drizzle', import.meta.url).pathname;

const dirs: string[] = [];
let running: RunningBe | null = null;

afterEach(async () => {
  if (running !== null) {
    await running.stop();
    running = null;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * `commitDir` defaults to a directory with no repository above it, so `/health`
 * answers a fixed `commit: null` here. Left at the real default it would report
 * whatever commit the checkout running the suite happens to be at, and an
 * assertion on that is an assertion on the developer's afternoon.
 */
function boot(
  commitDir: string = tempDir('wbs-boot-nogit-'),
  oidc?: OidcRouteOptions,
  localIdentity?: AuthenticatedUser,
): RunningBe {
  const dir = tempDir('wbs-boot-');
  const dbPath = join(dir, 'test.db');
  runMigrations(dbPath, FOLDER);
  running = bootBe01({
    appOrigin: oidc?.appOrigin ?? 'http://localhost',
    dbPath,
    port: 0,
    logger: createLogger({ service: 'be-01' }),
    jwtKey: 'k'.repeat(32),
    gwUrl: 'http://gw.invalid',
    internalAuthSecret: 's'.repeat(32),
    oidc,
    localIdentity,
    commitDir,
  });
  return running;
}

function oidcOptions(passwordLoginEnabled: boolean): OidcRouteOptions {
  return {
    appOrigin: 'https://dev.wbs.test',
    mode: 'oidc',
    now: () => 1,
    passwordLoginEnabled,
    random: () => 'r'.repeat(43),
    redirectUri: 'https://dev.wbs.test/api/auth/okta/callback',
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
    tokens: new InMemoryTokenStore(),
    groupPrefix: 'dev',
    groupsClaim: 'wbs_groups',
    verifier: { verify: () => Promise.reject(new errors.JOSEAlgNotAllowed('not an OIDC token')) },
    client: {
      authorizationUrl: () => Promise.resolve(new URL('https://idp.test/authorize')),
      exchange: () => Promise.resolve({ accessToken: 'a', expiresIn: 60 }),
      refresh: () => Promise.resolve({ accessToken: 'a', expiresIn: 60 }),
      revoke: () => Promise.resolve(),
    },
  };
}

describe('bootBe01', () => {
  it('reconciles an abandoned optimizer drain before reporting healthy', async () => {
    const dir = tempDir('wbs-optimizer-reconcile-');
    const dbPath = join(dir, 'test.db');
    runMigrations(dbPath, FOLDER);
    const raw = openDatabase(dbPath);
    try {
      raw.run(
        `INSERT INTO users (id, username, password_hash, created_at)
         VALUES ('u-1', 'owner', 'hash', 1)`,
      );
      raw.run(
        `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                              optimization_enabled, schedule_engine, schedule_objective)
         VALUES ('p-1', 'Plan', 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
      );
    } finally {
      raw.close();
    }
    const observer = openDrizzle(dbPath);
    const contractVersion = '7+0.1.0';
    allocateGeneration(observer, 'p-1', contractVersion, 'abandoned', 1);
    const state = openDatabase(dbPath);
    try {
      state.run(
        `UPDATE optimization_generation SET admission_state = 'draining'
         WHERE project_id = 'p-1' AND contract_version = '${contractVersion}'`,
      );
    } finally {
      state.close();
    }

    running = bootBe01({
      appOrigin: 'http://localhost',
      dbPath,
      port: 0,
      logger: createLogger({ service: 'be-01' }),
      jwtKey: 'k'.repeat(32),
      gwUrl: 'http://gw.invalid',
      internalAuthSecret: 's'.repeat(32),
      optimizer: {
        solverVersion: '0.1.0',
        budgetMs: 60_000,
        spawn: () => {
          throw new Error('startup reconciliation must not spawn');
        },
      },
    });
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      health = await fetch(`http://localhost:${String(running.port)}/health`);
      if (health.status === 200) break;
      await Bun.sleep(10);
    }

    expect(health?.status).toBe(200);
    expect(readGeneration(observer, 'p-1', contractVersion)).toBeNull();

    // Proof: remove `services.optimizer.start()` from boot and the abandoned
    // draining generation remains after health says this process is serving.
  });

  it('hands the installed optimizer runtime into the serving process graph', async () => {
    // This is the boundary main.ts calls. Proof: omit the `optimizer` forwarding
    // from bootBe01 to buildServices and the settings write is refused even
    // though this boot was given a runnable optimizer.
    const dir = tempDir('wbs-optimizer-boot-');
    running = bootBe01({
      appOrigin: 'http://localhost',
      dbPath: join(dir, 'test.db'),
      port: 0,
      logger: createLogger({ service: 'be-01' }),
      jwtKey: 'k'.repeat(32),
      gwUrl: 'http://gw.invalid',
      internalAuthSecret: 's'.repeat(32),
      localIdentity: { id: 'local-dev', username: 'local-dev', scopes: ['read', 'write'] },
      migrateOnStartup: true,
      migrationsFolder: FOLDER,
      optimizer: {
        solverVersion: '0.1.0',
        budgetMs: 60_000,
        spawn: () => {
          throw new Error('the settings write must not spawn');
        },
      },
    });
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      health = await fetch(`http://localhost:${String(running.port)}/health`);
      if (health.status === 200) break;
      await Bun.sleep(10);
    }
    expect(health?.status).toBe(200);
    const created = await running.services.projects.create('Optimizer', 'local-dev');

    expect(
      await running.services.projects.update(created.project.id, 'local-dev', {
        optimizationEnabled: true,
      }),
    ).toHaveProperty('ok', true);
  });

  it('persists the fixed local identity after migrating an empty development database', async () => {
    const dir = tempDir('wbs-local-boot-');
    running = bootBe01({
      appOrigin: 'http://localhost',
      dbPath: join(dir, 'test.db'),
      port: 0,
      logger: createLogger({ service: 'be-01' }),
      jwtKey: 'k'.repeat(32),
      gwUrl: 'http://gw.invalid',
      internalAuthSecret: 's'.repeat(32),
      localIdentity: { id: 'local-dev', username: 'local-dev', scopes: ['read', 'write'] },
      migrateOnStartup: true,
      migrationsFolder: FOLDER,
    });
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      health = await fetch(`http://localhost:${String(running.port)}/health`);
      if (health.status === 200) break;
      await Bun.sleep(10);
    }
    expect(health?.status).toBe(200);

    const created = await running.services.projects.create('Local plan', 'local-dev');

    expect(created.project.ownerId).toBe('local-dev');
  });

  it('starts the retention timer', async () => {
    // The gap a reviewer named: every `RetentionTimer` test passed against a
    // process that never called `start()`, which is the same failure as the
    // `runRetention` that had no caller at all.
    //
    // Proof: `services.retention.start()` deleted from `boot.ts` and only this
    // test failed.
    const be = boot();

    expect(be.services.retention.isRunning()).toBe(true);

    await be.stop();
    expect(be.services.retention.isRunning()).toBe(false);
    running = null;
  });

  it('mounts the composed login throttle instead of constructing another public graph', async () => {
    const be = boot();
    const releases = Array.from({ length: 8 }, (_, index) =>
      be.services.loginThrottle.reserve(`held-${String(index)}`, `client-${String(index)}`),
    );
    expect(releases.every((release) => release !== null)).toBe(true);

    const response = await fetch(`http://localhost:${String(be.port)}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ username: 'somebody', password: 'password' }),
    });

    expect(response.status).toBe(429);
    for (const release of releases) release?.();
  });

  it('stops optimizer and retention before closing its opened source', async () => {
    const dir = tempDir('wbs-stop-order-');
    const dbPath = join(dir, 'test.db');
    runMigrations(dbPath, FOLDER);
    let stateAtClose: { optimizerRunning: boolean; retentionRunning: boolean } | undefined;
    const be = bootBe01(
      {
        appOrigin: 'http://localhost',
        dbPath,
        port: 0,
        logger: createLogger({ service: 'be-01' }),
        jwtKey: 'k'.repeat(32),
        gwUrl: 'http://gw.invalid',
        internalAuthSecret: 's'.repeat(32),
        optimizer: {
          solverVersion: '0.1.0',
          budgetMs: 60_000,
          spawn: () => {
            throw new Error('shutdown ordering must not spawn');
          },
        },
      },
      {
        openSource: (options) => {
          const source = openSqliteSource(options);
          return {
            ...source,
            close: async () => {
              stateAtClose = {
                optimizerRunning: be.services.optimizer?.isRunning() ?? false,
                retentionRunning: be.services.retention.isRunning(),
              };
              await source.close();
            },
          };
        },
      },
    );
    running = be;

    await be.stop();
    running = null;

    expect(stateAtClose).toEqual({ optimizerRunning: false, retentionRunning: false });
  });

  it('serves health on the port it bound', async () => {
    const be = boot();

    const res = await fetch(`http://localhost:${String(be.port)}/health`);

    expect(res.status).toBe(200);
    expect((await res.json()) as HealthAnswer).toEqual({ status: 'ok', commit: null });
  });

  it('names the commit its checkout is at, not one captured at startup', async () => {
    // The wiring test for `deployedCommit`. `buildApp` defaults it to a
    // function answering null, so a `boot.ts` that stopped passing the real
    // reader would keep every other test in this file green and report `null`
    // from every deployment — which reads as "prod image, no .git" rather than
    // as a bug. Proof: the `deployedCommit:` line struck from `boot.ts` and
    // only this test failed.
    const repo = tempDir('wbs-boot-git-');
    const sha = 'c'.repeat(39) + '3';
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), sha + '\n');
    const be = boot(repo);

    const first = await fetch(`http://localhost:${String(be.port)}/health`);
    expect((await first.json()) as HealthAnswer).toEqual({ status: 'ok', commit: sha });

    // The deploy this exists for moves the checkout under a process that is
    // never restarted, so the second read has to see the move.
    const moved = 'd'.repeat(39) + '4';
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), moved + '\n');
    const second = await fetch(`http://localhost:${String(be.port)}/health`);
    expect((await second.json()) as HealthAnswer).toEqual({ status: 'ok', commit: moved });
  });

  it('holds a command batch out while the write coordinator is taken', async () => {
    // The one-coordinator wiring, observed rather than restated. `boot.ts`
    // creates one `WriteCoordinator` and passes it to `buildServices` (every
    // store takes its turn at it) and to `buildApp` (`PlanCommandRunner` takes
    // one turn for the whole batch). That those are the SAME object is the
    // whole durability guarantee — a second one excludes nothing, and the
    // batch's rollback goes back to erasing a durable event the push has
    // already left with. Every existing test builds its own pair, so all of
    // them stay green through a split; Sol's Important on PR 204.
    //
    // Proof it is not a restatement: `boot.ts`'s `gate: writeCoordinator`
    // mutated to `gate: new WriteCoordinator()` with `writes.gate` left alone,
    // which is a healthy pair of coordinators and the exact split this guards.
    // The race below then resolves the wrong way round.
    //
    // Read off the real objects at both ends: the coordinator comes from the
    // graph `buildServices` constructed, and the waiting is done by the runner
    // `buildApp` constructed, reached over its own HTTP route. Nothing here
    // rebuilds the wiring it is checking.
    //
    // **It is an ordering race and not an elapsed-time sample, and the
    // difference is the whole test.** A fixed sleep followed by "has it answered
    // yet?" says nothing about *why* it had not: under the split mutation the
    // request can lose the sample to a descheduled process, GC, loopback accept
    // or Elysia's two auth passes and the case goes green while the invariant is
    // broken — a false green on the sole regression protecting it. Sol's second
    // Important on PR 204. So the barrier is the runner's own arrival at THIS
    // lock object, observed by wrapping the instance's `run` for the length of
    // the request. One lock: the wrapper fires and the response is still
    // pending. Split lock: the runner takes the other object, the wrapper never
    // fires, and the 200 wins the race.
    const be = boot(undefined, undefined, {
      id: 'local-dev',
      username: 'local-dev',
      scopes: ['read', 'write'],
    });
    // The process's one write coordinator, read off the built graph — the end
    // of the wiring this case is about. Every store `buildServices` builds
    // takes its turn at this object, and the runner takes one turn for a whole
    // batch, so a turn held here is exactly "a batch cannot start".
    const coordinator = be.services.gate;

    let release!: () => void;
    let announceTaken!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `WriteCoordinator.run` schedules its callback on a microtask rather than running
    // it inline, so a caller that has merely called `run` holds nothing yet.
    // Awaiting this is what puts the batch behind the turn instead of beside it
    // — the same trap that made this change's first durability regression
    // worthless.
    const taken = new Promise<void>((resolve) => {
      announceTaken = resolve;
    });
    const lock = coordinator;
    const turn = lock.enter(async () => {
      announceTaken();
      await held;
    });
    await taken;

    // The seam, installed only after the turn is held so the wrapper cannot see
    // this test's own call: an own property shadowing the prototype method for
    // the length of the request, removed in `finally`.
    let announceReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      announceReached = resolve;
    });
    const seam = lock as { enter?: WriteCoordinator['enter'] };
    const real = lock.enter.bind(lock);
    seam.enter = <T>(work: () => Promise<T>): Promise<T> => {
      announceReached();
      return real(work);
    };

    // An empty batch: `execute` takes the lock before it looks at the commands
    // at all, so nothing else needs to exist for this route to queue on it.
    const batch = fetch(`http://localhost:${String(be.port)}/api/directory/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [] }),
    });
    let first: 'the runner queued on this lock' | 'the batch answered first';
    try {
      first = await Promise.race([
        reached.then(() => 'the runner queued on this lock' as const),
        batch.then(() => 'the batch answered first' as const),
      ]);
    } finally {
      delete seam.enter;
      release();
    }

    expect(first).toBe('the runner queued on this lock');

    await turn;
    const res = await batch;
    expect(res.status).toBe(200);
  });

  it('answers a resume from the log it opened', async () => {
    // End to end through the real HTTP route, the real SQLite file and the
    // services `main.ts` will build: the wiring, not the parts.
    const be = boot();

    const res = await fetch(`http://localhost:${String(be.port)}/internal/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': 's'.repeat(32) },
      body: JSON.stringify({ resume_points: { 'project:unknown': 4 }, trace_id: 't-1' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      'project:unknown': { status: 'denied', reason: 'out_of_range' },
    });
  });
});

describe('OIDC boot wiring', () => {
  it('mounts the configured browser login route', async () => {
    const be = boot(undefined, oidcOptions(true));
    const res = await fetch(`http://localhost:${String(be.port)}/api/auth/login`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('stops accepting an issued password session when the kill switch is false', async () => {
    const be = boot(undefined, oidcOptions(false));
    const registered = await be.services.auth.register('password-user', 'correct-horse-2026');
    if (!registered.ok) throw new Error('password fixture was not registered');

    const me = await fetch(`http://localhost:${String(be.port)}/api/auth/me`, {
      headers: { cookie: `__Host-wbs_access=${registered.value.token}` },
    });

    expect(me.status).toBe(401);
  });

  it('accepts an issued password session when the kill switch is true', async () => {
    const be = boot(undefined, oidcOptions(true));
    const registered = await be.services.auth.register('password-user', 'correct-horse-2026');
    if (!registered.ok) throw new Error('password fixture was not registered');

    const me = await fetch(`http://localhost:${String(be.port)}/api/auth/me`, {
      headers: { cookie: `__Host-wbs_access=${registered.value.token}` },
    });

    expect(me.status).toBe(200);
  });
});

for (const passwordLoginEnabled of [false, true]) {
  it(`keeps boot verifier outages as 500 with password login ${String(passwordLoginEnabled)}`, async () => {
    const oidc = oidcOptions(passwordLoginEnabled);
    oidc.verifier = { verify: () => Promise.reject(new Error('discovery unavailable')) };
    const be = boot(undefined, oidc);
    const registered = await be.services.auth.register('password-user', 'correct-horse-2026');
    if (!registered.ok) throw new Error('password fixture was not registered');
    const me = await fetch(`http://localhost:${String(be.port)}/api/auth/me`, {
      headers: { cookie: `__Host-wbs_access=${registered.value.token}` },
    });
    expect(me.status).toBe(500);
  });
}
