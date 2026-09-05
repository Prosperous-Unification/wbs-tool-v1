import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { createLogger } from '@wbs/observability';
import { afterEach, describe, expect, it } from 'bun:test';

import { bootBe01, type RunningBe } from './boot';
import type { OidcRouteOptions } from './controller/auth.routes';
import { runMigrations } from './repository/migrate';
import type { AuthenticatedUser } from './service/auth.service';
import type { GatewayBroadcaster } from './service/gateway-broadcaster';
import type { WriteLock } from './service/write-lock';

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
    verifier: { verify: () => Promise.reject(new Error('not an OIDC token')) },
    client: {
      authorizationUrl: () => Promise.resolve(new URL('https://idp.test/authorize')),
      exchange: () => Promise.resolve({ accessToken: 'a', expiresIn: 60 }),
      refresh: () => Promise.resolve({ accessToken: 'a', expiresIn: 60 }),
      revoke: () => Promise.resolve(),
    },
  };
}

describe('bootBe01', () => {
  it('persists the fixed local identity after migrating an empty development database', async () => {
    const dir = tempDir('wbs-local-boot-');
    running = bootBe01({
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

  it('holds a command batch out while the broadcaster lock is taken', async () => {
    // The one-lock wiring, observed rather than restated. `boot.ts` creates one
    // `WriteLock` and passes it to `buildServices` (the broadcaster records
    // under it) and to `buildApp` (`PlanCommandRunner` opens its outer
    // transaction under it). That those are the SAME object is the whole
    // durability guarantee — a second lock excludes nothing, and the batch's
    // rollback goes back to erasing a durable event the push has already left
    // with. Every existing test builds its own pair, so all of them stay green
    // through a split; Sol's Important on PR 204.
    //
    // Proof it is not a restatement: `boot.ts` line 75 mutated to
    // `lock: new WriteLock()` with line 126 left alone, which is a healthy pair
    // of locks and the exact split this guards. The race below then resolves the
    // wrong way round.
    //
    // Read off the real objects at both ends: the lock comes from the
    // broadcaster `buildServices` constructed, and the waiting is done by the
    // runner `buildApp` constructed, reached over its own HTTP route. Nothing
    // here rebuilds the wiring it is checking.
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
    // The `GatewayBroadcaster` `announcements` was built around — the object
    // that records under the lock, which is the end of the wiring this reads.
    const broadcaster: GatewayBroadcaster = be.services.gatewayBroadcaster;

    let release!: () => void;
    let announceTaken!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `WriteLock.run` schedules its callback on a microtask rather than running
    // it inline, so a caller that has merely called `run` holds nothing yet.
    // Awaiting this is what puts the batch behind the turn instead of beside it
    // — the same trap that made this change's first durability regression
    // worthless.
    const taken = new Promise<void>((resolve) => {
      announceTaken = resolve;
    });
    const lock = broadcaster.lock;
    const turn = lock.run(async () => {
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
    const seam = lock as { run?: WriteLock['run'] };
    const real = lock.run.bind(lock);
    seam.run = <T>(work: () => Promise<T>): Promise<T> => {
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
      delete seam.run;
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
