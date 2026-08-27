import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { assembleCaddyfile } from './lib/caddy';
import { drain } from './lib/drain';
import { type EnvLayout, envLayout } from './lib/env';
import { waitForHealthy } from './lib/health';
import { flipColor, parseStateJson, renderStateJson } from './lib/state';
import {
  isFileAbsent,
  parseRecordedColor,
  parseTierList,
  pollActiveConnections,
  readMcpExposure,
  readSiteCaddy,
  runSwaps,
  shouldRestoreSiteCaddy,
  startGreen,
  type StartGreenDeps,
  type SwapRunDeps,
} from './swap';

describe('state', () => {
  it('flips color', () => {
    expect(flipColor('blue')).toBe('green');
    expect(flipColor('green')).toBe('blue');
  });

  it('parses + renders state json round-trip', () => {
    const s = { tier: 'be' as const, lastDeployedSha: 'abc', activeColor: 'blue' as const };
    const round = parseStateJson(renderStateJson(s));
    expect(round).toEqual(s);
  });

  it('rejects invalid tier', () => {
    expect(() => parseStateJson('{"tier":"xx","activeColor":"blue"}')).toThrow(/tier/);
  });
});

describe('caddy.assembleCaddyfile', () => {
  it('orders fragments be → gw → fe → observability', () => {
    const out = assembleCaddyfile([
      { tier: 'observability', content: 'OBS' },
      { tier: 'fe', content: 'FE' },
      { tier: 'be', content: 'BE' },
      { tier: 'gw', content: 'GW' },
    ]);
    const idxBe = out.indexOf('BE');
    const idxGw = out.indexOf('GW');
    const idxFe = out.indexOf('FE');
    const idxObs = out.indexOf('OBS');
    expect(idxBe).toBeLessThan(idxGw);
    expect(idxGw).toBeLessThan(idxFe);
    expect(idxFe).toBeLessThan(idxObs);
  });
});

describe('health.waitForHealthy', () => {
  it('returns true once fetch succeeds', async () => {
    let n = 0;
    const ok = await waitForHealthy({
      url: 'http://example',
      timeoutMs: 10,
      attempts: 3,
      intervalMs: 1,
      fetchImpl: (() => {
        n++;
        if (n < 2) return Promise.reject(new Error('boom'));
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });

  it('returns false when all attempts fail', async () => {
    const ok = await waitForHealthy({
      url: 'http://example',
      timeoutMs: 10,
      attempts: 2,
      intervalMs: 1,
      fetchImpl: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  // fe-01 is a static file server: a truncated/empty index.html still
  // returns 200, so a status-only check would pass a broken deploy. Design
  // decision 5 requires asserting a non-empty body too.
  it('rejects a 200 whose body fails an optional isHealthy predicate', async () => {
    const ok = await waitForHealthy({
      url: 'http://example',
      timeoutMs: 10,
      attempts: 2,
      intervalMs: 1,
      isHealthy: (body) => body.length > 0,
      fetchImpl: (() =>
        Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it('accepts once the body starts satisfying the predicate', async () => {
    let n = 0;
    const ok = await waitForHealthy({
      url: 'http://example',
      timeoutMs: 10,
      attempts: 3,
      intervalMs: 1,
      isHealthy: (body) => body.length > 0,
      fetchImpl: (() => {
        n++;
        return Promise.resolve(new Response(n < 2 ? '' : '<html>ok</html>', { status: 200 }));
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });

  it('leaves be-01/gw-01-style callers unchanged when isHealthy is not provided', async () => {
    // Same body as the rejected case above, but with no predicate: status
    // alone must still be sufficient, exactly as before this change.
    const ok = await waitForHealthy({
      url: 'http://example',
      timeoutMs: 10,
      attempts: 1,
      intervalMs: 1,
      fetchImpl: (() =>
        Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });
});

// Finding I2: activeConnections used to be a bare `fetch` with no deadline,
// so a wedged gw-01 could hold `drain`'s poll (and the deploy lock) for
// however long the OS's own TCP timeout is. `pollActiveConnections` is the
// testable, timed core of it — same AbortController + setTimeout shape as
// lib/health.ts's waitForHealthy and tool-smoke/src/health.ts's
// fetchWithTimeout.
describe('pollActiveConnections', () => {
  it('returns the real count on a healthy JSON response', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ activeConnections: 3 }), { status: 200 }),
      )) as unknown as typeof fetch;
    expect(await pollActiveConnections('http://x', fetchImpl)).toBe(3);
  });

  it('returns 0 (not "cannot determine") for a 200 response missing the field', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({}), { status: 200 }),
      )) as unknown as typeof fetch;
    expect(await pollActiveConnections('http://x', fetchImpl)).toBe(0);
  });

  // The core of the fix: a fetch that never settles unless its AbortSignal
  // fires must not hang the drain loop forever, and must not be mistaken
  // for "drained" (0) — that would let the swap proceed to stop-blue while
  // gw-01 might still hold real connections.
  it('treats a hung request as "cannot determine, keep draining" (Infinity), not drained (0)', async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    const start = Date.now();
    const n = await pollActiveConnections('http://x', fetchImpl, 20);
    expect(n).toBe(Infinity);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('treats a network error the same way — Infinity, not 0', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    expect(await pollActiveConnections('http://x', fetchImpl)).toBe(Infinity);
  });

  it('treats a non-OK response as "cannot determine" rather than trusting its body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ activeConnections: 0 }), { status: 503 }),
      )) as unknown as typeof fetch;
    expect(await pollActiveConnections('http://x', fetchImpl)).toBe(Infinity);
  });

  // Feeds straight into drain()'s own semantics: Infinity must never look
  // drained.
  it('a poll that always times out never lets drain() report drained', async () => {
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    const r = await drain({
      activeConnections: () => pollActiveConnections('http://x', fetchImpl, 5),
      maxWaitMs: 30,
      pollMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(r.drained).toBe(false);
  });
});

describe('drain', () => {
  it('returns drained when connection count reaches zero', async () => {
    let n = 3;
    const r = await drain({
      activeConnections: () => Math.max(0, --n),
      maxWaitMs: 1000,
      pollMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(r.drained).toBe(true);
  });

  it('gives up after maxWait', async () => {
    const r = await drain({
      activeConnections: () => 5,
      maxWaitMs: 5,
      pollMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(r.drained).toBe(false);
  });
});

describe('readSiteCaddy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-swap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist (first deploy, or unreadable)', async () => {
    expect(await readSiteCaddy(join(dir, 'missing.caddy'))).toBeNull();
  });

  it('returns the contents of a file that is present and non-empty', async () => {
    const p = join(dir, 'site.caddy');
    writeFileSync(p, 'import site.caddy contents');
    expect(await readSiteCaddy(p)).toBe('import site.caddy contents');
  });

  it('returns an empty string, not null, for a file that is present but empty', async () => {
    // Distinguishing this from "not there" is the whole point of the fix:
    // both must be treated as "nothing to restore" by shouldRestoreSiteCaddy,
    // but readSiteCaddy itself must still tell the truth about which one it
    // saw, since only the "not there" case is safe to also skip *why* — the
    // empty-but-present case can point at a real problem worth investigating.
    const p = join(dir, 'empty.caddy');
    writeFileSync(p, '');
    expect(await readSiteCaddy(p)).toBe('');
  });
});

// This is the abortSwap guard that was the subject of the post-fix-wave
// review's Important finding: readSiteCaddy() used to swallow every error to
// `''`, so `siteTextBefore` was never `null`, and abortSwap's old
// `siteTextBefore !== null` check always passed — including for a swap where
// there was never a previous site.caddy to restore. Since
// `/home/puni1/wbs/caddy/Caddyfile` does a bare `import site.caddy`, writing that
// empty/absent state back out as a real file produces a Caddy config with NO
// servers in it: the app site AND the registry block both go down, and the
// empty file is a landmine for the next Caddy restart.
//
// Non-vacuity, checked by hand and recorded here rather than only asserted:
// reverting the guard to the pre-fix `siteTextBefore !== null` (i.e. dropping
// the `siteTextBefore.length > 0` half of the condition) makes the
// 'skips restore when previous contents are empty' case below return `true`
// instead of `false`, and the test fails with
// `expect(received).toBe(expected) — Expected: false, Received: true`.
// Restoring the real guard makes it pass again. See the report for the
// transcript.
describe('shouldRestoreSiteCaddy (abortSwap restore guard)', () => {
  it('skips restore when previous contents are null (missing or unreadable)', () => {
    expect(shouldRestoreSiteCaddy(null)).toBe(false);
  });

  it('skips restore when previous contents are empty (present but empty file)', () => {
    expect(shouldRestoreSiteCaddy('')).toBe(false);
  });

  it('restores when previous contents are a real, non-empty config', () => {
    expect(shouldRestoreSiteCaddy('import site.caddy\n')).toBe(true);
  });
});

// `planSwap`/`describePlan` used to live here, hardcoding `activeColor: 'blue'`
// and never touching real Docker or Caddy. Task 9 replaced them: the real
// planner is `planSwap` in `./lib/reconcile.ts` (tested in
// `./lib/reconcile.test.ts`), and this file's `swap.ts` is now the IO shell
// that executes its plan — its pure command builders and parsers live in
// `./lib/docker.ts` and `./lib/site.ts` (tested in `docker.test.ts` and
// `site.test.ts`).

// I1: swap.js took the deploy lock once per tier, but tool-deploy drove a
// multi-tier deploy as one SSH invocation per tier. The lock was therefore
// released between tiers, and two concurrent `--all` deploys could interleave
// into a mismatched stack (be from run A, gw from run B). One invocation now
// carries every tier of a run, so the lock spans the whole run.
describe('parseTierList', () => {
  it('accepts a single tier', () => {
    expect(parseTierList('be')).toEqual(['be']);
  });

  it('accepts a comma-separated list, preserving deploy order', () => {
    expect(parseTierList('be,gw,fe')).toEqual(['be', 'gw', 'fe']);
  });

  it('rejects an unknown tier', () => {
    expect(() => parseTierList('be,xx')).toThrow(/unknown tier/);
  });

  it('rejects an empty list', () => {
    expect(() => parseTierList('')).toThrow(/at least one tier/);
  });

  // A repeated tier would swap the same tier twice inside one lock hold: the
  // second pass observes the colour the first just moved to and swaps it
  // straight back, so the run ends where it started while reporting success.
  it('rejects a repeated tier', () => {
    expect(() => parseTierList('be,gw,be')).toThrow(/repeated tier/);
  });
});

describe('startGreen env preflight', () => {
  const OIDC_ENV_PATH = '/fixture/oidc-dev.env';
  const IMAGE = 'registry.infra.bulletpoints.club/wbs-be-01@sha256:' + 'a'.repeat(64);
  const APP_ENV =
    'PORT=3100\nLOG_LEVEL=info\nGW_URL=http://gw-01:3200\n' +
    'DB_PATH=/data/wbs.db\nAUTH_MODE=oidc\n';

  async function rejectedPreflight(
    readOidc: () => Promise<string>,
  ): Promise<{ events: string[]; message: string }> {
    const events: string[] = [];
    const deps: StartGreenDeps = {
      oidcEnvPath: OIDC_ENV_PATH,
      readText: (path) => {
        if (path.endsWith('/be-01.env')) {
          events.push('read:app');
          return Promise.resolve(APP_ENV);
        }
        if (path === OIDC_ENV_PATH) {
          events.push('read:oidc');
          return readOidc();
        }
        events.push(`read:other:${path}`);
        return Promise.resolve('INTERNAL_AUTH_SECRET=x\nJWT_SIGNING_KEY_CURRENT=y\n');
      },
      writePhaseFile: (_path, phase) => {
        events.push(`phase:${phase}`);
        return Promise.resolve();
      },
      writeAtomicFile: (path) => {
        events.push(`write:${path}`);
        return Promise.resolve();
      },
      runDocker: (args) => {
        events.push(`docker:${args.join(' ')}`);
        return Promise.resolve('');
      },
    };

    let message = '';
    try {
      await startGreen('be', 'green', IMAGE, '/fixture/be.phase', deps);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    return { events, message };
  }

  it('rejects a missing OIDC file before phase, Compose, or routing can change', async () => {
    const { events, message } = await rejectedPreflight(() =>
      Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
    );
    expect(message).toContain('no such file');
    expect(events).toEqual(['read:app', 'read:oidc']);
  });

  it('rejects an unreadable OIDC file before phase, Compose, or routing can change', async () => {
    const { events, message } = await rejectedPreflight(() =>
      Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    );
    expect(message).toContain('permission denied');
    expect(events).toEqual(['read:app', 'read:oidc']);
  });

  it('rejects an extra OIDC key before phase, Compose, or routing can change', async () => {
    const { events, message } = await rejectedPreflight(() =>
      Promise.resolve(
        'AUTH_CLIENT_ID=expected-client\n' + 'PORT=should-not-override-the-app-config\n',
      ),
    );
    expect(message).toContain('PORT');
    expect(message).not.toContain('expected-client');
    expect(message).not.toContain('should-not-override-the-app-config');
    expect(events).toEqual(['read:app', 'read:oidc']);
  });
});

describe('runSwaps', () => {
  function fakeRunDeps(overrides: Partial<SwapRunDeps> = {}): SwapRunDeps {
    return {
      withLock: (_path, fn) => fn(),
      observe: () =>
        Promise.resolve({
          routedColor: 'blue' as const,
          runningColors: ['blue' as const],
          recordedColor: 'blue' as const,
          phase: 'committed' as const,
        }),
      execute: () => Promise.resolve(),
      ...overrides,
    };
  }

  it('takes the lock exactly once for a three-tier run', async () => {
    let locks = 0;
    const deps = fakeRunDeps({
      withLock: (_path, fn) => {
        locks++;
        return fn();
      },
    });
    await runSwaps(['be', 'gw', 'fe'], { be: 'img-be', gw: 'img-gw', fe: 'img-fe' }, 'sha1', deps);
    expect(locks).toBe(1);
  });

  it('executes every tier in the order given, inside that one lock', async () => {
    const events: string[] = [];
    const deps = fakeRunDeps({
      withLock: async (_path, fn) => {
        events.push('lock');
        const r = await fn();
        events.push('unlock');
        return r;
      },
      execute: (plan) => {
        events.push(`execute:${plan.tier}`);
        return Promise.resolve();
      },
    });
    await runSwaps(['be', 'gw', 'fe'], { be: 'img-be', gw: 'img-gw', fe: 'img-fe' }, 'sha1', deps);
    expect(events).toEqual(['lock', 'execute:be', 'execute:gw', 'execute:fe', 'unlock']);
  });

  it('passes each tier its own image', async () => {
    const seen: string[] = [];
    const deps = fakeRunDeps({
      execute: (_plan, image) => {
        seen.push(image);
        return Promise.resolve();
      },
    });
    await runSwaps(['be', 'fe'], { be: 'img-be', fe: 'img-fe' }, 'sha1', deps);
    expect(seen).toEqual(['img-be', 'img-fe']);
  });

  // A failure partway through must not silently continue into the next tier:
  // the whole point of one lock is that the run is one unit.
  it('stops at the first failing tier and does not start the next', async () => {
    const started: string[] = [];
    const deps = fakeRunDeps({
      execute: (plan) => {
        started.push(plan.tier);
        return plan.tier === 'gw' ? Promise.reject(new Error('gw blew up')) : Promise.resolve();
      },
    });
    let message = '';
    try {
      await runSwaps(['be', 'gw', 'fe'], { be: 'b', gw: 'g', fe: 'f' }, 'sha1', deps);
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/gw blew up/);
    expect(started).toEqual(['be', 'gw']);
  });

  // Each tier is observed after the previous tier's swap committed, not all
  // up front: `be`'s swap changes what `gw` should be planned against.
  it('observes each tier after the previous tier finished', async () => {
    const events: string[] = [];
    const deps = fakeRunDeps({
      observe: (tier) => {
        events.push(`observe:${tier}`);
        return Promise.resolve({
          routedColor: 'blue' as const,
          runningColors: ['blue' as const],
          recordedColor: 'blue' as const,
          phase: 'committed' as const,
        });
      },
      execute: (plan) => {
        events.push(`execute:${plan.tier}`);
        return Promise.resolve();
      },
    });
    await runSwaps(['be', 'gw'], { be: 'b', gw: 'g' }, 'sha1', deps);
    expect(events).toEqual(['observe:be', 'execute:be', 'observe:gw', 'execute:gw']);
  });
});

describe('parseRecordedColor', () => {
  it('reads the recorded colour from a well-formed state file', () => {
    const raw = JSON.stringify({ tier: 'be', activeColor: 'green', lastDeployedSha: 'abc' });
    expect(parseRecordedColor('/srv/state/be.json', raw)).toBe('green');
  });

  // Absent and unreadable used to collapse to the same null, and null means
  // "never deployed" to resolveLiveColor — so an unopenable file read as a
  // fresh install and the planner would pick a colour that may be serving.
  it('refuses a malformed state file rather than reporting no colour', () => {
    expect(() => parseRecordedColor('/srv/state/be.json', '{not json')).toThrow(
      /not valid state JSON/,
    );
  });

  it('refuses an empty state file', () => {
    expect(() => parseRecordedColor('/srv/state/be.json', '')).toThrow(/not valid state JSON/);
  });

  it('refuses JSON that is valid but is not a state record', () => {
    expect(() => parseRecordedColor('/srv/state/be.json', '{"hello":"world"}')).toThrow(
      /not valid state JSON/,
    );
  });
});

describe('isFileAbsent', () => {
  it('recognises ENOENT, the one case a missing state file is allowed', () => {
    expect(isFileAbsent(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(true);
  });

  it('does not treat a permission error as absence', () => {
    // Verified against Bun on 2026-08-05: a missing file throws code ENOENT and
    // an unreadable one EACCES, so the distinction this relies on is real.
    expect(isFileAbsent(Object.assign(new Error('permission denied'), { code: 'EACCES' }))).toBe(
      false,
    );
  });

  it('does not treat a non-errno value as absence', () => {
    expect(isFileAbsent(new Error('something else'))).toBe(false);
    expect(isFileAbsent(null)).toBe(false);
  });
});

/**
 * The marker reader is the whole cutover seam, and until now nothing exercised
 * it: the environment branch, the ENOENT tolerance and the unreadable-file
 * refusal were all reachable only from a real swap on a real host. `CURRENT_ENV`
 * is frozen at import, so the layout parameter is the only seam a unit test can
 * drive — the same `layout: EnvLayout = CURRENT_ENV` shape `containerName` and
 * `tierEnvFiles` already use in lib/docker.ts.
 */
describe('readMcpExposure', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-mcp-exposure-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (env: 'prod' | 'dev'): EnvLayout => ({ ...envLayout(env), stateDir: dir });

  it('never reads a marker in prod, even when an enabled one is sitting there', async () => {
    // Not merely "prod returns false": the marker is present and enabled, so a
    // reader that dropped the environment branch would return true here.
    writeFileSync(join(dir, 'mcp-exposure'), 'enabled\n');
    expect(await readMcpExposure(at('prod'))).toBe(false);
  });

  it('never reads the marker path in prod, not even to discard what it read', async () => {
    // Fable round-3 Minor 1: the test above cannot tell "never reads" from
    // "reads, then discards". A directory at the marker path throws EISDIR on
    // any read at all, so this fails the moment the environment branch moves
    // below the read — which would abort a PROD swap on a prod-path marker
    // that prod has no business consulting.
    mkdirSync(join(dir, 'mcp-exposure'));
    expect(await readMcpExposure(at('prod'))).toBe(false);
  });

  it('treats an absent dev marker as pre-cutover rather than an error', async () => {
    expect(await readMcpExposure(at('dev'))).toBe(false);
  });

  it('reads an enabled dev marker as exposed', async () => {
    writeFileSync(join(dir, 'mcp-exposure'), 'enabled\n');
    expect(await readMcpExposure(at('dev'))).toBe(true);
  });

  it('refuses a malformed dev marker instead of quietly dropping the surface', async () => {
    writeFileSync(join(dir, 'mcp-exposure'), 'disabled\n');
    let threw = false;
    try {
      await readMcpExposure(at('dev'));
    } catch (e: unknown) {
      threw = true;
      expect(e instanceof Error && e.message).toMatch(/refusing to rewrite the dev vhost/);
      expect(e instanceof Error && e.message).toMatch(/malformed MCP exposure state/);
    }
    expect(threw).toBe(true);
  });

  it('refuses a permission-denied dev marker, the shape a mode-600 marker fails in', async () => {
    // Fable round-3 Minor 2: EISDIR alone leaves a narrower loosening alive —
    // `isFileAbsent(e) || e.code === 'EACCES'` bypasses isFileAbsent entirely
    // and survives every other test here. The real marker is installed mode
    // 600, so EACCES is its realistic unreadable shape.
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const marker = join(dir, 'mcp-exposure');
    writeFileSync(marker, 'enabled\n');
    chmodSync(marker, 0o000);
    let threw = false;
    try {
      await readMcpExposure(at('dev'));
    } catch (e: unknown) {
      threw = true;
      expect(e instanceof Error && e.message).toMatch(/cannot read/);
    }
    expect(threw).toBe(true);
  });

  it('refuses an unreadable dev marker rather than reading it as absent', async () => {
    // A directory in the marker's place throws EISDIR, not ENOENT: the one
    // distinction `isFileAbsent` exists to make. Reading this as absent would
    // delete the reviewed public surface on the next swap.
    mkdirSync(join(dir, 'mcp-exposure'));
    let threw = false;
    try {
      await readMcpExposure(at('dev'));
    } catch (e: unknown) {
      threw = true;
      expect(e instanceof Error && e.message).toMatch(/cannot read/);
    }
    expect(threw).toBe(true);
  });
});
