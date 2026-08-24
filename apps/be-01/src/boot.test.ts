import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { createLogger } from '@wbs/observability';
import { afterEach, describe, expect, it } from 'bun:test';

import { bootBe01, type RunningBe } from './boot';
import type { OidcRouteOptions } from './controller/auth.controller';
import { runMigrations } from './repository/migrate';

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
function boot(commitDir: string = tempDir('wbs-boot-nogit-'), oidc?: OidcRouteOptions): RunningBe {
  const dir = tempDir('wbs-boot-');
  const dbPath = join(dir, 'test.db');
  runMigrations(dbPath, FOLDER);
  running = bootBe01({
    dbPath,
    port: 0,
    logger: createLogger({ service: 'test' }),
    jwtKey: 'k'.repeat(32),
    gwUrl: 'http://gw.invalid',
    internalAuthSecret: 's'.repeat(32),
    oidc,
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
      logger: createLogger({ service: 'test' }),
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
    expect((await res.json()) as { status: string }).toEqual({ status: 'ok', commit: null });
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
    expect((await first.json()) as { commit: string }).toEqual({ status: 'ok', commit: sha });

    // The deploy this exists for moves the checkout under a process that is
    // never restarted, so the second read has to see the move.
    const moved = 'd'.repeat(39) + '4';
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), moved + '\n');
    const second = await fetch(`http://localhost:${String(be.port)}/health`);
    expect((await second.json()) as { commit: string }).toEqual({ status: 'ok', commit: moved });
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
      headers: { cookie: `__Host-wbs_access=${registered.result.token}` },
    });

    expect(me.status).toBe(401);
  });

  it('accepts an issued password session when the kill switch is true', async () => {
    const be = boot(undefined, oidcOptions(true));
    const registered = await be.services.auth.register('password-user', 'correct-horse-2026');
    if (!registered.ok) throw new Error('password fixture was not registered');

    const me = await fetch(`http://localhost:${String(be.port)}/api/auth/me`, {
      headers: { cookie: `__Host-wbs_access=${registered.result.token}` },
    });

    expect(me.status).toBe(200);
  });
});
