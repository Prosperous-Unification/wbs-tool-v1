// @vitest-environment node
//
// `vite-config.test.ts`'s reason, and the same regex reads this tag: importing
// the Playwright config pulls in `@playwright/test`, and a config module has no
// DOM to test. Kept beside that file rather than under `src/` because both are
// about a config at the root of this app rather than about the app.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The workspace root, which the config under test refuses to run outside of.
 *
 * Computed from this file rather than read from `process.cwd()`: the suite is
 * launched from the workspace root today, and a test that quietly depended on
 * that would fail for the next person who runs it from `apps/fe-01`.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WebServerEntry {
  command?: string;
  url: string;
  env?: Record<string, string>;
}

async function loadConfig(shift?: string) {
  vi.resetModules();
  if (shift === undefined) delete process.env['E2E_PORT_SHIFT'];
  else process.env['E2E_PORT_SHIFT'] = shift;
  const { default: config } = await import('./playwright.config');
  return config;
}

function serversOf(config: { webServer?: unknown }): WebServerEntry[] {
  const { webServer } = config;
  if (!Array.isArray(webServer)) throw new Error('the config starts no servers to assert on');
  return webServer as WebServerEntry[];
}

describe('the browser gate’s port shift', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['E2E_PORT_SHIFT'];
  });

  it('runs on the documented ports when nothing asks it to move', async () => {
    const servers = serversOf(await loadConfig());
    expect(servers.map((server) => server.url)).toEqual([
      'http://localhost:3100/health',
      'http://localhost:3200/health',
      'http://localhost:4200',
    ]);
  });

  it('moves all three tiers together, and every URL they hold about each other', async () => {
    // **Together** is the whole assertion. A shift that moved a listener
    // without moving what points at it boots three servers that cannot talk:
    // be-01 mints tokens for a gw-01 it cannot reach, and the failure arrives
    // forty seconds later as a socket that never opens rather than as a
    // misconfiguration. So the cross-tier URLs are asserted, not only the
    // ports.
    //
    // Proof: `GW_URL` dropped from be-01's env block, this failed on
    // `expected undefined to be 'http://localhost:3700'`; the `VITE_*`
    // block dropped from fe-01's, on the same shape. Watched, 2026-08-29.
    const servers = serversOf(await loadConfig('500'));
    // Or a config that started two servers would satisfy every assertion
    // below about the two it did start.
    expect(servers).toHaveLength(3);
    const [backend, gateway, frontend] = servers;
    expect(backend.url).toBe('http://localhost:3600/health');
    expect(backend.env?.['PORT']).toBe('3600');
    expect(backend.env?.['GW_URL']).toBe('http://localhost:3700');
    expect(gateway.url).toBe('http://localhost:3700/health');
    expect(gateway.env?.['PORT']).toBe('3700');
    expect(gateway.env?.['BE_URL']).toBe('http://localhost:3600');
    expect(frontend.url).toBe('http://localhost:4700');
    expect(frontend.env?.['PORT']).toBe('4700');
    expect(frontend.env?.['VITE_BE_URL']).toBe('http://localhost:3600');
    expect(frontend.env?.['VITE_GW_URL']).toBe('http://localhost:3700');
    expect(frontend.env?.['VITE_WS_URL']).toBe('ws://localhost:3700/ws');
  });

  it('points the browser at the frontend it actually started', async () => {
    const config = (await loadConfig('500')) as { use?: { baseURL?: string } };
    expect(config.use?.baseURL).toBe('http://localhost:4700');
  });

  it('serves the built frontend instead of a source-module graph', async () => {
    const [, , frontend] = serversOf(await loadConfig('500'));

    // A source Vite page fetched more than 100 modules per navigation. A host
    // network notification canceled one batch with `net::ERR_NETWORK_CHANGED`
    // and left only an empty `#root`, twice in two whole-browser runs.
    // Proof: replacing this with `bunx vite` failed on `expected
    // "bunx vite" to be "bunx vite build --minify=false && bunx vite
    // preview"`.
    expect(frontend.command).toBe('bunx vite build --minify=false && bunx vite preview');
  });

  /**
   * How long the out-of-process origin probe below may take, and how long the
   * case that owns it may take.
   *
   * TASK-405 measured every `apps/fe-01` case against vitest's 5000ms default.
   * This one is the tightest in the app by a wide gap — 2813 / 2799 / 2649 /
   * 2485 / 2881ms across five runs on h2puni at load ~8-9, against 350ms for
   * the next slowest case in this file — and it is tight for a reason that
   * cannot be split away: one `bun --eval` that loads be-01's config and app
   * fixture cold. Unlike the four-mount case that opened that task, there is
   * no smaller shape to cut this into.
   *
   * The two budgets are ordered deliberately. Before this, the probe's own
   * 10000ms guard sat inside a case vitest killed at 5000ms, so the guard
   * could never surface first: a hung probe reported `Test timed out in
   * 5000ms` and named nothing. (`execFileSync` is synchronous, so vitest could
   * not actually interrupt it either — watched 2026-09-08, that arm reported
   * 5000ms after burning 9852ms of runner wall clock.) With the case budget
   * above the probe budget, the probe reports first and says which command ran
   * out: `spawnSync bun ETIMEDOUT`.
   *
   * This does not reopen TASK-405's decision to keep the 5000ms default
   * project-wide (recorded in the queue workspace's `notes/decisions.md`,
   * 2026-09-08, not in this repo). That decision is about a global
   * `testTimeout`; this is the per-case fallback the task's own criterion
   * allows, taken here because splitting is not available.
   */
  const PROBE_TIMEOUT_MS = 10_000;
  const PROBE_CASE_TIMEOUT_MS = 15_000;

  it(
    'lets a shifted browser login reach authentication through the configured backend origin',
    async () => {
      const [backend] = serversOf(await loadConfig('500'));
      const env = {
        AUTH_MODE: 'local',
        NODE_ENV: 'development',
        LOG_LEVEL: 'error',
        INTERNAL_AUTH_SECRET: 's'.repeat(32),
        JWT_SIGNING_KEY_CURRENT: 'k'.repeat(32),
        ...backend.env,
      };
      const script = `
      import { loadConfig } from './apps/be-01/src/config.ts';
      import { testApp } from './apps/be-01/src/testing/app-fixture.ts';
      const config = loadConfig(JSON.parse(process.env['ORIGIN_PROBE_CONFIG']));
      const app = testApp({appOrigin: config.appOrigin});
      const response = await app.handle(new Request('http://localhost:3600/api/auth/login', {
        method:'POST', headers:{'content-type':'application/json',origin:'http://localhost:4700'},
        body:JSON.stringify({username:'origin-probe',password:'incorrect'}),
      }));
      console.log(response.status);
    `;
      const status = execFileSync('bun', ['--no-env-file', '--eval', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { PATH: process.env['PATH'], ORIGIN_PROBE_CONFIG: JSON.stringify(env) },
      });
      expect(status.trim()).toBe('401');
    },
    PROBE_CASE_TIMEOUT_MS,
  );

  it('refuses a shift it cannot use rather than reading it as zero', async () => {
    // Unknown is not OK (`AGENTS.md`, R5). A shift silently read as zero is a
    // run against whatever holds the usual ports — a dev server, or another
    // checkout — wearing the costume of an isolated one, which is the exact
    // fault the shift exists to end.
    //
    // Proof: the `Number.isInteger` guard replaced by `Number(asked) || 0`,
    // this failed on `promise resolved instead of rejecting`. Watched,
    // 2026-08-29.
    await expect(loadConfig('half')).rejects.toThrow('E2E_PORT_SHIFT');
    await expect(loadConfig('-1')).rejects.toThrow('E2E_PORT_SHIFT');
    await expect(loadConfig('1.5')).rejects.toThrow('E2E_PORT_SHIFT');
    await expect(loadConfig('10000')).rejects.toThrow('E2E_PORT_SHIFT');
  });

  it('refuses a shift that lands one tier on another tier’s usual port', async () => {
    // The three tiers sit at 3100/3200/4200, so 100 puts be-01 on gw-01's port
    // and 1000 puts gw-01 on fe-01's. An agent asked for 1000 and got
    // `http://localhost:4200/health is already used` from a gateway that had
    // collided with a frontend — and on a developer's machine 4200 is the dev
    // server this whole mechanism exists to run beside (2026-08-30).
    //
    // Refused rather than nudged: the shift is written into runbooks and agent
    // instructions, and a silently adjusted 1000 means something other than
    // what the person typed.
    //
    // Proof: the guard removed, this failed on `promise resolved … instead of
    // rejecting`, and a real run on 1000 died on the gateway's health URL.
    await expect(loadConfig('1000')).rejects.toThrow('4200');
    await expect(loadConfig('100')).rejects.toThrow('3200');
    await expect(loadConfig('1100')).rejects.toThrow('4200');
    // And a shift that clears all three is still accepted, or the guard would
    // be refusing everything and this file could not tell.
    const servers = serversOf(await loadConfig('500'));
    expect(servers).toHaveLength(3);
  });

  it('gives each run a database of its own, under the workspace root', async () => {
    // Never `apps/be-01/local.db`: the specs sign up throwaway accounts and
    // write plans, and doing that to a developer's own dev database is how a
    // gate starts failing for one person only.
    const [backend] = serversOf(await loadConfig());

    expect(backend.env?.['DB_PATH']).toContain(join(repoRoot, 'tmp'));
  });

  it('gives the source backend a deterministic supervisor caller identity', async () => {
    // A CI shell need not export HOSTNAME. Production containers still supply
    // their authenticated Docker hostname; this value belongs only to the
    // isolated browser stack, which must boot before it can run any case.
    const [backend] = serversOf(await loadConfig());
    const callerId = backend.env?.['HOSTNAME'];

    expect(callerId).toBe('e2e000000000');
    expect(callerId).toMatch(/^[0-9a-f]{12}$/);
  });
});
