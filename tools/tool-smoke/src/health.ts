import { APP_NAME, PORT } from '@tools/deploy-contract';

import { resolveColor } from './color';

/** No fetch in this file waits longer than this before failing. */
const DEFAULT_TIMEOUT_MS = 3000;

export interface HealthTarget {
  name: string;
  url: string;
  /**
   * Extra check beyond `res.ok`, run against the response body text.
   * fe-01 is a static Caddy server that can return 200 for a truncated or
   * empty index.html — no status-only check would notice (design
   * decision 5). Optional and additive: be-01/gw-01 leave this unset and
   * keep the plain `res.ok` gate.
   */
  isHealthy?: (body: string) => boolean;
}

export interface HealthCheck {
  name: string;
  url: string;
  status: number;
  ok: boolean;
  /** Populated on failure so a hung/refused/mismatched check is diagnosable
   * from the log line alone, instead of just a bare `FAIL 0`. */
  detail?: string;
}

/**
 * Runs `fetchImpl` with a hard deadline. A target that completes the TCP
 * handshake and then never responds would otherwise leave `nx run
 * tool-smoke:smoke` blocked indefinitely — the same failure class as a
 * check that always silently passes: both hide a real problem instead of
 * reporting it. Mirrors `tools/tool-remote-scripts/src/lib/health.ts`'s
 * `AbortController` + `setTimeout` pattern (not imported directly — this is a
 * different fetch with a different timeout, and `@tools/deploy-contract` carries
 * the names and ports rather than the fetching).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    ctl.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function targetUrl(
  env: NodeJS.ProcessEnv,
  overrideKey: string,
  container: string,
  port: number,
  path: string,
): string {
  return env[overrideKey] ?? `http://${container}-${resolveColor(env)}:${String(port)}${path}`;
}

/**
 * These are container-DNS names, resolvable only on `wbs-net` — smoke has to
 * run inside the network (see project.json's `smoke` target), never against
 * a public URL. Caddy deliberately does not expose `/health` (or `/metrics`,
 * `/internal/*`) publicly, so a public check here could only ever fail.
 */
export function resolveTargets(env: NodeJS.ProcessEnv = process.env): HealthTarget[] {
  return [
    {
      name: APP_NAME.be,
      url: targetUrl(env, 'SMOKE_BE_URL', APP_NAME.be, PORT.be, '/health'),
    },
    {
      name: APP_NAME.gw,
      url: targetUrl(env, 'SMOKE_GW_URL', APP_NAME.gw, PORT.gw, '/health'),
    },
    {
      name: 'fe-01',
      url: targetUrl(env, 'SMOKE_FE_URL', 'fe-01', 80, '/'),
      isHealthy: (body) => body.length > 0,
    },
  ];
}

export async function checkTarget(
  target: HealthTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HealthCheck> {
  try {
    const res = await fetchWithTimeout(target.url, {}, fetchImpl, timeoutMs);
    const body = target.isHealthy === undefined ? undefined : await res.text();
    const ok = res.ok && (body === undefined || target.isHealthy?.(body) === true);
    return {
      name: target.name,
      url: target.url,
      status: res.status,
      ok,
      detail: ok ? undefined : (body ?? `HTTP ${String(res.status)}`),
    };
  } catch (err) {
    return {
      name: target.name,
      url: target.url,
      status: 0,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runHealthChecks(
  targets: HealthTarget[],
  fetchImpl: typeof fetch = fetch,
): Promise<HealthCheck[]> {
  const out: HealthCheck[] = [];
  for (const t of targets) out.push(await checkTarget(t, fetchImpl));
  return out;
}

/**
 * Design decision 9's authenticated `/internal/forward` round trip. This is
 * the check that would have caught the real, weeks-long broken
 * `INTERNAL_AUTH_SECRET` incident this project already had: be-01 and gw-01
 * each read `INTERNAL_AUTH_SECRET` from their own derived, tier-specific
 * secrets file (`be-01.secrets.env` / `gw-01.secrets.env` — see
 * `tools/tool-remote-scripts/src/lib/docker.ts`'s `deriveTierSecrets`),
 * both filtered from the same `/srv/wbs/.env` source of truth.
 * `tier.compose.tmpl`'s `env_file` order (the tier's own app-config file
 * first, its secrets file last — see `tierEnvFiles`) means a stray
 * same-named key accidentally added to the app-config file can never
 * silently shadow the real secret for just one tier — exactly the class of
 * drift a same-process unit test can never see, because tests inject the
 * secret directly rather than reading it from the two independently
 * assembled env chains gw-01 and be-01 actually load. be-01's `onForward`
 * handler is a no-op today (`apps/wbs/be-01/src/app.ts`), so calling it
 * repeatedly has no side effects.
 */
export function resolveInternalForwardUrl(env: NodeJS.ProcessEnv = process.env): string {
  return targetUrl(env, 'SMOKE_INTERNAL_URL', APP_NAME.be, PORT.be, '/internal/forward');
}

export interface InternalForwardCheck {
  ok: boolean;
  status: number;
  detail?: string;
}

export async function checkInternalForward(
  url: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<InternalForwardCheck> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-auth': secret },
        body: JSON.stringify({ message: { type: 'ping' }, trace_id: 'smoke' }),
      },
      fetchImpl,
      timeoutMs,
    );
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, detail: body };

    // A 2xx is not the check. Design decision 9 is about proving the internal
    // round trip *works*, and a proxy, a stub, or a be-01 that answered the route
    // without doing anything all return 200 with something else in the body.
    // `{ack:true}` is the only part of the response that means be-01 handled it.
    if (!acknowledged(body)) {
      return {
        ok: false,
        status: res.status,
        detail: `2xx without {"ack":true}: ${body.slice(0, 200)}`,
      };
    }
    return { ok: true, status: res.status, detail: undefined };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether the body is be-01's `{ack:true}` and not something merely 200. */
function acknowledged(body: string): boolean {
  try {
    return (JSON.parse(body) as { ack?: unknown }).ack === true;
  } catch {
    // Not JSON at all — an error page from something between here and be-01.
    return false;
  }
}

function requireInternalAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env['INTERNAL_AUTH_SECRET'];
  if (secret === undefined || secret === '') {
    throw new Error(
      'INTERNAL_AUTH_SECRET must be set — cannot verify the be-01<->gw-01 internal-auth round ' +
        'trip without it (design decision 9)',
    );
  }
  return secret;
}

/**
 * Runs the full health suite (per-target `/health`/`/` checks, plus the
 * authenticated internal-forward round trip) and reports each result to the
 * console. Returns overall pass/fail rather than calling `process.exit`
 * itself, so `tool-smoke/src/main.ts` (the single bundled entry point wired
 * into `tool-deploy`, see design decision 9) can run this alongside the WS
 * suite and decide the process exit code once, after both have reported.
 * `main()` below is the thin standalone-CLI wrapper for `nx run
 * tool-smoke:health`.
 */
export async function runHealthSuite(): Promise<boolean> {
  const results = await runHealthChecks(resolveTargets());
  for (const r of results) {
    const suffix = r.detail === undefined ? '' : ` — ${r.detail}`;
    console.log(
      `[smoke/health] ${r.ok ? 'ok' : 'FAIL'} ${String(r.status)} ${r.name} ${r.url}${suffix}`,
    );
  }

  const secret = requireInternalAuthSecret();
  const internalUrl = resolveInternalForwardUrl();
  const internalResult = await checkInternalForward(internalUrl, secret);
  const suffix = internalResult.detail === undefined ? '' : ` — ${internalResult.detail}`;
  console.log(
    `[smoke/health] ${internalResult.ok ? 'ok' : 'FAIL'} ${String(internalResult.status)} ` +
      `internal-forward ${internalUrl}${suffix}`,
  );

  return results.every((r) => r.ok) && internalResult.ok;
}

async function main(): Promise<void> {
  if (!(await runHealthSuite())) process.exit(1);
}

if (import.meta.main) {
  await main();
}
