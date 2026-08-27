// The blue/green swap executor. `lib/docker.ts` and `lib/site.ts` hold the
// pure command builders, parsers, and template contexts; everything here is
// the thin IO shell that actually runs `docker`, touches the filesystem, and
// drives the ordered `SwapStep`s a `SwapPlan` (lib/reconcile.ts) produces.
//
// `--dry-run` is the default. `--execute` opts in to anything destructive.
//
// How the Caddy/Compose templates reach the server: they are NOT read from a
// path on disk at runtime. `@wbs/tool-compose` imports both `.tmpl` files as
// raw text with `with { type: 'text' }`, which Bun's bundler inlines at
// build time into the single `swap.js` produced by this project's `build`
// target — the same file `install.ts` already documents rsync-ing to
// `/srv/wbs/bin/`. So shipping one file ships the templates too; nothing
// separate needs to exist on the server. Verified: `bun build --target=bun`
// on a throwaway file with the same import pattern inlines the text and the
// resulting bundle still runs correctly when moved and executed from an
// unrelated directory.
import { unlink } from 'node:fs/promises';

import { renderTemplate, siteCaddyTmpl, tierComposeTmpl } from '@wbs/tool-compose';

import { writeAtomic } from './lib/atomic';
import {
  assertDigestPinnedRef,
  assertOidcEnvAllowed,
  assertTierEnvAllowed,
  composeUpArgs,
  containerName,
  CURRENT_ENV,
  deriveTierSecrets,
  EDGE_CONTAINER,
  type EnvLayout,
  grantAliasCommands,
  manifestInspectArgs,
  migrateDownCommand,
  migrateStatusCommand,
  NETWORK,
  PORT,
  psColorsFrom,
  revokeAliasCommands,
  ROOT,
  SHARED_ENV_PATH,
  tierComposeContext,
  tierComposeFile,
  tierEnvFiles,
  tierHasSecrets,
  tierSecretsFile,
} from './lib/docker';
import { drain } from './lib/drain';
import { waitForHealthy } from './lib/health';
import { withLock } from './lib/lock';
import { readPhase, writePhase } from './lib/phase';
import { type Observed, planSwap, type SwapPlan, type SwapStep } from './lib/reconcile';
import { mcpExposureEnabled, routedColorFromAdminConfig, siteContext } from './lib/site';
import { type Color, parseStateJson, renderStateJson, type Tier } from './lib/state';

// No REGISTRY here, deliberately. The publish address arrives as part of
// `--image`, which is `release.json`'s `image` field passed through verbatim
// by tool-deploy — see lib/docker.ts's assertDigestPinnedRef for why a second
// default on this side was a live defect rather than a redundancy.
// The default is the environment's own address, not a literal: with a literal
// here, a dev swap that forgot to export SITE_ADDRESS would render a site
// block for `wbs.bulletpoints.club` into dev's file and Caddy would then hold
// two blocks for the live hostname, one of them pointing at dev's containers.
const SITE_ADDRESS = process.env['SITE_ADDRESS'] ?? CURRENT_ENV.siteAddress;

// Not `${ROOT}/caddy/site.caddy`: the one edge container mounts PROD's caddy
// directory, so the site file is the single environment-varying path that does
// not live under the environment's own root. lib/env.ts states that exception.
const SITE_CADDY_PATH = CURRENT_ENV.siteCaddyPath;

/**
 * Whether this environment's reviewed public MCP surface is enabled.
 *
 * Three outcomes, all fail-closed and all reached before `writeAtomic`: prod
 * never reads a marker at all, an absent dev marker is pre-cutover, and
 * anything present that is not exactly `enabled` — including a file that
 * cannot be read — stops the swap rather than rewriting the vhost without
 * knowing what it is allowed to serve.
 *
 * `layout` is a required parameter rather than a direct `CURRENT_ENV` read so
 * a test can drive it: `CURRENT_ENV` is frozen at import, so nothing else can
 * reach the environment branch, the ENOENT tolerance, or the unreadable-file
 * refusal. Required rather than `= CURRENT_ENV` (the shape `containerName` and
 * `tierEnvFiles` use in lib/docker.ts) because those have many call sites and
 * this has exactly one: a default here would be a production path no test ever
 * takes, so a mutation to the default would leave the whole suite green.
 */
export async function readMcpExposure(layout: EnvLayout): Promise<boolean> {
  if (layout.env !== 'dev') return false;
  const path = `${layout.stateDir}/mcp-exposure`;
  try {
    return mcpExposureEnabled(await Bun.file(path).text());
  } catch (e: unknown) {
    if (isFileAbsent(e)) return false;
    throw new Error(
      `cannot read ${path}; refusing to rewrite the dev vhost without its exposure state ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

// fe-01 is a static Caddy server with no /health route; design decision 5's
// health gate for it is "fetch / and assert 200 + a non-empty body" instead.
const HEALTH_PATH: Record<Tier, string> = { be: '/health', gw: '/health', fe: '/' };

async function sh(args: string[]): Promise<string> {
  const p = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${await new Response(p.stderr).text()}`);
  }
  return out;
}

/**
 * No app-tier ports are published to the host (design decision 1) — only
 * containers on `wbs-net` can resolve each other by container-DNS name.
 * This process runs on the bare host (`/srv/wbs/bin/swap.js`, not inside a
 * container), so it cannot reach `http://be-01-green:3100/...` by name. It
 * instead reaches the container directly by its bridge-network IP: Docker
 * routes host -> bridge-network-container traffic regardless of published
 * ports, only host -> *outside* traffic needs a publish. Verified live on
 * h2puni: `curl` to a container's bridge IP returned 200, and `ip route`
 * shows a direct kernel route to the bridge subnet — this works on the real
 * target, not just in theory.
 */
async function containerIp(name: string): Promise<string> {
  const out = await sh([
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`,
    name,
  ]);
  const ip = out.trim();
  if (ip === '') throw new Error(`${name} has no address on ${NETWORK}`);
  return ip;
}

/** No single poll of gw-01's drain gauge waits longer than this before being treated as unreachable. */
const ACTIVE_CONNECTIONS_TIMEOUT_MS = 5000;

/**
 * The timed part of `activeConnections`, split out so it can be unit tested
 * with a fake `fetchImpl` the way `lib/health.ts`'s `waitForHealthy` and
 * `tool-smoke/src/health.ts`'s `fetchWithTimeout` already are — every other
 * fetch in this codebase follows that `AbortController` + `setTimeout`
 * pattern; this was the one bare `fetch` left with no deadline of its own.
 *
 * Without a deadline, `drain`'s `maxWaitMs` only bounds the whole polling
 * loop (lib/drain.ts), not a single request inside it — a wedged gw-01 (TCP
 * connected, never responds) would block one poll for however long the OS's
 * own TCP timeout is, which can exceed the entire 300s drain ceiling on its
 * own, when the design intent is up to thirty ~10s-spaced polls in that
 * window.
 *
 * A poll that cannot determine the real count — timeout, network error, a
 * non-OK response — returns `Infinity`, not `0`. `drain()`'s loop keeps
 * going on anything `> 0`, so `Infinity` reads as "cannot determine, keep
 * draining": the safe direction. Returning `0` here would make an
 * unreachable gw-01 look fully drained after a single failed poll and let
 * the swap proceed straight to `revoke-alias`/`stop-blue` while real
 * connections might still be open on it. A malformed-but-successful
 * response (200, JSON, no `activeConnections` field) is a different,
 * unrelated case and keeps its prior behaviour of counting as `0`.
 */
export async function pollActiveConnections(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = ACTIVE_CONNECTIONS_TIMEOUT_MS,
): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    ctl.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) {
      console.warn(`[swap-gw] drain poll against ${url} returned HTTP ${String(res.status)}`);
      return Infinity;
    }
    const body = (await res.json()) as { activeConnections?: unknown };
    return typeof body.activeConnections === 'number' ? body.activeConnections : 0;
  } catch (e: unknown) {
    console.warn(
      `[swap-gw] drain poll against ${url} failed or timed out — treating as "cannot ` +
        `determine, keep draining": ${e instanceof Error ? e.message : String(e)}`,
    );
    return Infinity;
  } finally {
    clearTimeout(timer);
  }
}

/** One gauge, read off gw-01's own in-memory counters (see below). */
async function activeConnections(container: string): Promise<number> {
  const ip = await containerIp(container);
  return pollActiveConnections(`http://${ip}:${String(PORT.gw)}/metrics/snapshot`);
}

/**
 * Item 4's fix: a bounded settle held before `be`'s `revoke-alias`.
 *
 * `caddy reload` (the step immediately before this one runs) is graceful for
 * HTTP — a request already in flight when it runs keeps being served by
 * whatever upstream Caddy had already picked for it, which can still be the
 * OUTGOING colour for as long as that one request takes to finish. `be` has
 * no drain step the way `gw` does (see the `'drain'` case below, and
 * lib/docker.ts's revokeAliasCommands doc comment for the full picture), so
 * revoking the outgoing colour's `be-01.internal` alias immediately after
 * reload can cut a request reload's own graceful handling was still trying
 * to let finish.
 *
 * This is a fixed pause, not a real drain: be-01 exposes no equivalent to
 * gw-01's `/metrics/snapshot` activeConnections gauge (`activeConnections`
 * above is gw-specific — be-01's own request lifecycle is not instrumented),
 * so there is nothing for this process to poll to zero. A fixed pause bounds
 * the window to something short instead of leaving it open indefinitely; it
 * does NOT close it to zero — a request slower than this can still be cut.
 * 5s is comfortably longer than a normal be-01 request and short enough not
 * to meaningfully lengthen a `be` swap.
 */
const BE_REVOKE_ALIAS_SETTLE_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `null` means "not there, or unreadable" (first deploy, or a transient
 * read failure) — distinct from `''`, a file that is genuinely present and
 * empty. Collapsing both to `''` (the previous behaviour) made `abortSwap`'s
 * `siteTextBefore !== null` guard pass for a swap that never had a real
 * previous config to go back to, which is exactly the case that must NOT be
 * restored — see `shouldRestoreSiteCaddy`.
 */
export async function readSiteCaddy(path: string = SITE_CADDY_PATH): Promise<string | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    return await f.text();
  } catch {
    return null;
  }
}

/**
 * Whether `abortSwap` should write `siteTextBefore` back out and reload it.
 *
 * `null` (missing/unreadable) and `''` (present but empty) are both "there
 * is no previous config to restore" — and restoring either would write out
 * a `site.caddy` with NO servers in it. `/srv/wbs/caddy/Caddyfile` is
 * literally `import site.caddy`, so that takes down the app site AND the
 * registry block together, and leaves the empty file on disk as a landmine
 * for the next Caddy restart or container recreate. A missing previous
 * config is not something to restore; it is something to leave alone.
 */
export function shouldRestoreSiteCaddy(siteTextBefore: string | null): boolean {
  return siteTextBefore !== null && siteTextBefore.length > 0;
}

/**
 * Registry preflight — design decision 10's "SSH, registry, or registry auth
 * unavailable at start: abort before anything starts. Nothing changed."
 *
 * Runs before the lock is even taken, and `tool-deploy` runs it for *every*
 * tier before executing any of them, so a bad registry cannot leave a
 * half-deployed stack behind. Previously the first symptom of an unreachable
 * or unauthenticated registry was `docker compose up --pull always` failing
 * inside `start-green` — mid-swap, with a partially-created container to
 * clean up.
 */
async function preflightRegistry(image: string): Promise<void> {
  try {
    await sh(manifestInspectArgs(image));
  } catch (e: unknown) {
    throw new Error(
      `registry preflight failed for ${image} — aborting before anything starts.\n` +
        '  This host must be able to reach the registry and authenticate to it\n' +
        '  (docker login <registry>; see tools/tool-bootstrap/src/configure.sh).\n' +
        `  Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * `caddy reload` exits 0 whenever the config it's told to load (its own
 * `Caddyfile`, per the fixed `--config` flag above) is syntactically valid —
 * NOT whenever routing actually changed. If `Caddyfile` doesn't `import
 * site.caddy` at all (verified live: this was exactly what happened before
 * a real Caddyfile was provisioned — reload kept "succeeding" while Caddy
 * silently kept serving deploy/compose/Caddyfile.bootstrap's placeholder
 * forever), the swap reports success and nothing is actually routed. Rather
 * than trust the exit code, read Caddy's own admin API back — the live,
 * currently-active config, not the file on disk — and assert it actually
 * mentions the container this reload was supposed to route to. `wget` (not
 * `curl`) because `caddy:2-alpine`'s base image ships BusyBox wget, not
 * curl; verified live. `127.0.0.1`, not `localhost`: the container's
 * `/etc/hosts` maps `localhost` to both `127.0.0.1` and `::1`, Caddy's
 * admin API only binds the IPv4 address, and BusyBox wget's `localhost`
 * lookup tries `::1` first and reports connection-refused without falling
 * back — verified live (identical command, `localhost` fails, `127.0.0.1`
 * succeeds against the same running admin API).
 */
async function currentCaddyConfig(): Promise<string> {
  return sh(['exec', EDGE_CONTAINER, 'wget', '-qO-', 'http://127.0.0.1:2019/config/']);
}

/**
 * Which colour Caddy is ACTUALLY serving for each tier, right now.
 *
 * This replaces reading the rendered `site.caddy` off disk, and the
 * distinction is not academic. `render-route` writes that file *before*
 * `reload` runs — it has to, since reload's whole job is to load it — so any
 * failure or kill in between leaves the file naming green while Caddy is
 * still serving blue. `observe()` used to read that file, `resolveLiveColor`
 * trusts routing unconditionally, and so the next deploy would plan
 * `green -> blue` and, as its very FIRST step, recreate the container serving
 * production, with a new digest and no health gate in front of it. The
 * inverted window was the exact scenario decision 6 introduced "the rendered
 * Caddy config is the source of truth" to prevent, and reading the file
 * quietly reintroduced it: the file is the *input* to routing, not routing.
 *
 * Caddy's admin API reports the config it has loaded, which cannot be ahead of
 * reality the way the file can. That is the version of decision 6 that is
 * actually true, so it is what `observe()` and `render-route` both read.
 *
 * Chosen over the alternative fix — roll `site.caddy` back to its previous
 * contents when the reload fails — because rollback only covers the failures
 * this process survives to handle. A SIGKILL, an OOM kill, or the box losing
 * power between the write and the reload all leave the file inverted with no
 * `catch` block ever running, and those are the same signals that motivated
 * the `flock` rewrite in lib/lock.ts. Reading live routing has no such window:
 * there is no moment at which the answer is derived from something that has
 * not happened yet. (`abortSwap` restores the file anyway, so an operator
 * reading it is not misled either — but correctness does not depend on that
 * having run.)
 *
 * If Caddy is down this throws rather than falling back to the file. That is
 * deliberate: the fallback would be exactly the stale, possibly-inverted
 * source this exists to stop trusting, and it would be consulted precisely
 * when things are already wrong. A swap cannot complete without Caddy anyway —
 * `reload` targets it — so refusing to plan one costs nothing real and keeps
 * decision 10's "abort before anything starts" honest.
 */
async function liveRoutedColors(): Promise<Record<Tier, Color | null>> {
  let config: string;
  try {
    config = await currentCaddyConfig();
  } catch (e: unknown) {
    throw new Error(
      "cannot read Caddy's live admin config, so the colour actually being served is " +
        'unknown — refusing to plan a swap from the possibly-stale site.caddy file ' +
        '(design decision 6). Is the caddy container up?\n' +
        `  Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // The admin dump is every site on the host at once, so each tier is read
  // from the route that matches THIS environment's address. Reading it as flat
  // text meant dev's block and prod's block were one search space.
  return {
    be: routedColorFromAdminConfig('be', SITE_ADDRESS, config),
    gw: routedColorFromAdminConfig('gw', SITE_ADDRESS, config),
    fe: routedColorFromAdminConfig('fe', SITE_ADDRESS, config),
  };
}

/**
 * ENOENT means the file is genuinely absent — a tier that has never been
 * deployed — which is the one case this reader is meant to tolerate. Every
 * other errno is a file that exists and could not be read.
 */
export function isFileAbsent(e: unknown): boolean {
  return e !== null && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
}

/**
 * The recorded colour, or a thrown error naming why it could not be trusted.
 *
 * Absent and unreadable used to collapse to the same `null`, and `null` means
 * "never deployed" to `resolveLiveColor`. So a state file that merely could not
 * be opened — a bad mode, a directory in its place — read as a fresh install,
 * and the planner would choose blue without knowing whether blue was already
 * serving. This is the same defect `readRemoteState` had in tool-deploy, in the
 * file that decides which colour to tear down.
 *
 * Split from the IO so it can be tested without a filesystem.
 */
export function parseRecordedColor(path: string, raw: string): Color {
  try {
    return parseStateJson(raw).activeColor;
  } catch (e: unknown) {
    throw new Error(
      `${path} is present but is not valid state JSON ` +
        `(${e instanceof Error ? e.message : String(e)}) — refusing rather than ` +
        'treating it as never-deployed, which would let a swap pick a colour ' +
        'that may already be serving.',
    );
  }
}

async function readRecordedColor(tier: Tier): Promise<Color | null> {
  const path = `${ROOT}/state/${tier}.json`;
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (e: unknown) {
    if (isFileAbsent(e)) return null;
    throw new Error(
      `${path} exists but could not be read ` +
        `(${e instanceof Error ? e.message : String(e)}) — refusing rather than ` +
        'treating it as never-deployed.',
    );
  }
  return parseRecordedColor(path, raw);
}

async function observe(tier: Tier): Promise<Observed> {
  const psOutput = await sh(['ps', '--format', '{{.Names}}']);
  const routed = await liveRoutedColors();
  return {
    routedColor: routed[tier],
    runningColors: psColorsFrom(psOutput, tier),
    recordedColor: await readRecordedColor(tier),
    phase: await readPhase(`${ROOT}/state/${tier}.phase`),
  };
}

async function reloadCaddy(): Promise<void> {
  // `docker exec <container>`, not `compose exec caddy`. The edge is shared by
  // every environment and owned by prod's Compose project, so resolving it
  // through the deploying environment's project only works for prod. See
  // EDGE_CONTAINER.
  await sh(['exec', EDGE_CONTAINER, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
}

/** IO seams for the start-green step's preflight and side effects. */
export interface StartGreenDeps {
  readonly oidcEnvPath: string | null;
  readText: (path: string) => Promise<string>;
  writePhaseFile: (path: string, phase: 'preparing') => Promise<void>;
  writeAtomicFile: (path: string, text: string, mode?: number) => Promise<void>;
  runDocker: (args: string[]) => Promise<string>;
}

const START_GREEN_DEPS: StartGreenDeps = {
  oidcEnvPath: CURRENT_ENV.oidcEnvPath,
  readText: (path) => Bun.file(path).text(),
  writePhaseFile: writePhase,
  writeAtomicFile: writeAtomic,
  runDocker: sh,
};

/**
 * Validates every operator-authored env file before recording a phase or
 * starting the idle colour, then performs the start-green side effects.
 */
export async function startGreen(
  tier: Tier,
  to: Color,
  image: string,
  phasePath: string,
  deps: StartGreenDeps = START_GREEN_DEPS,
): Promise<void> {
  const appEnvPath = tierEnvFiles(tier)[0];
  assertTierEnvAllowed(tier, await deps.readText(appEnvPath));

  // Proof: the three `startGreen env preflight` cases observe only the app
  // and OIDC reads when that file is absent, unreadable, or carries PORT.
  // Moving this below the phase/Compose calls makes their event assertions red.
  if (deps.oidcEnvPath !== null && (tier === 'be' || tier === 'gw')) {
    assertOidcEnvAllowed(await deps.readText(deps.oidcEnvPath));
  }

  await deps.writePhaseFile(phasePath, 'preparing');
  // Re-derive on every start, including an empty allowed set, so a stale
  // secrets file cannot outlive deletion from the shared source. Mode 0600
  // applies to the temp file at birth; there is no world-readable interval.
  if (tierHasSecrets(tier)) {
    const secrets = deriveTierSecrets(tier, await deps.readText(SHARED_ENV_PATH));
    await deps.writeAtomicFile(tierSecretsFile(tier), secrets, 0o600);
  }
  const context = tierComposeContext(tier, to, image);
  await deps.writeAtomicFile(tierComposeFile(tier, to), renderTemplate(tierComposeTmpl, context));
  await deps.runDocker(composeUpArgs(tier, to));
}

// Steps at or before `reload` are still reversible: nothing client-facing has
// switched over yet (or, for `reload` itself, the switch is what's failing).
// A failure anywhere in this window must delegate to `abortSwap`. Steps after
// `reload` (`drain`, `revoke-alias`, `stop-blue`, `commit`) are NOT reversible
// by this mechanism: routing has already moved to `to`, which is now the
// legitimately live colour, so rolling back to `from` would be exactly
// backwards. See the boundary enforced in `execute`'s per-step try/catch.
const ABORTABLE_STEPS: ReadonlySet<SwapStep> = new Set<SwapStep>([
  'start-green',
  'migrate',
  'health-gate',
  'grant-alias',
  'render-route',
  'reload',
]);

async function execute(plan: SwapPlan, image: string, sha: string): Promise<void> {
  const { tier, from, to } = plan;
  const phasePath = `${ROOT}/state/${tier}.phase`;
  const greenName = containerName(tier, to);

  // Captured before this attempt writes anything, so an abort can put the
  // phase marker back to exactly what it said before — it must never
  // contradict be.json, which an aborted swap also leaves untouched.
  const phaseBefore = await readPhase(phasePath);

  // Undo state for the abort paths below. Both start "nothing to undo" and
  // are set at the exact point the corresponding action becomes undoable.
  let aliasMovedToGreen = false;
  let siteTextBefore: string | null = null;
  /**
   * The newest migration applied before this deploy touched the schema, or
   * `null` while the migrate step has not run.
   *
   * Blue and green share one SQLite file, so the migrate step changes the
   * schema the still-serving old colour is reading. Restoring routing on an
   * abort does not restore that: without this, a failed health gate left the
   * old release running against a schema it never asked for, and the deploy
   * reported a rollback it had not performed.
   */
  let migrationBaseline: string | null = null;

  /**
   * Design decision 10's abort rows, which were previously undelivered:
   *
   * | Migration step fails | Stop green, abort. Blue untouched and un-migrated. |
   * | `caddy reload` fails | Green is up but unrouted. Stop green, leave blue live, exit non-zero. |
   *
   * Both steps used to simply throw, leaving green running. For `be` that was
   * actively harmful rather than merely untidy: by reload time green already
   * holds `be-01.internal` (granted earlier in the plan), so an abort that
   * left green up left gw forwarding real traffic to a colour Caddy does not
   * route to — and an abort that stopped green without moving the alias back
   * would leave gw forwarding to a stopped container. The alias has to be
   * handed back to the outgoing colour before green stops, which is why this
   * is a helper rather than three lines at each throw site.
   *
   * Reachable from any of `ABORTABLE_STEPS`, including ones that previously
   * threw bare (`start-green`, `grant-alias`, `render-route`'s
   * `liveRoutedColors()`/`writeAtomic`, `health-gate`'s `containerIp`) — see
   * the outer try/catch in `execute`'s loop below. Every undo step here is
   * therefore written to be safe to run having done anywhere from none to
   * all of its own precondition's work already (idempotent), and every undo
   * is best-effort and logged: the original failure is what the operator
   * needs to see, so a failing cleanup must not replace it.
   */
  async function abortSwap(reason: string, cause: unknown): Promise<never> {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[swap-${tier}] aborting: ${reason}: ${detail}`);

    // 0. Schema first, and only while green is still running: green is the
    //    container that holds the new code, so it is the only one with a down
    //    script for the migration that was just applied. Blue is serving
    //    throughout, and it is serving against a schema this deploy changed
    //    under it — putting that back is the whole point of the step.
    //
    //    Best-effort and logged, like every other undo here: a rollback that
    //    fails must not replace the original failure in the operator's output.
    //    It says so explicitly, because a silent failure here is the schema
    //    staying forward while the message says the deploy was rolled back.
    if (migrationBaseline !== null) {
      try {
        const out = await sh(migrateDownCommand(greenName, migrationBaseline));
        console.error(`[swap-${tier}] schema rolled back: ${out.trim()}`);
      } catch (e: unknown) {
        console.error(
          `[swap-${tier}] SCHEMA NOT ROLLED BACK (${e instanceof Error ? e.message : String(e)}) — ` +
            `${from ?? 'the previous release'} is now serving against the migrated schema. ` +
            `Reverse it by hand before the next deploy: docker exec ${greenName} ` +
            `bun run src/migrate-down-cli.ts --to=${migrationBaseline}`,
        );
      }
    }

    // 1. Routing next, while green is still up: put site.caddy back to what
    //    it said before this swap touched it and re-apply it, so the file and
    //    live Caddy agree again. (Correctness does not depend on this — see
    //    liveRoutedColors — but leaving an inverted file for an operator to
    //    read would be gratuitous.) A missing or empty previous config is
    //    NOT restored — see shouldRestoreSiteCaddy — because writing either
    //    back out would leave a site.caddy with no servers in it at all.
    if (siteTextBefore !== null && shouldRestoreSiteCaddy(siteTextBefore)) {
      try {
        await writeAtomic(SITE_CADDY_PATH, siteTextBefore);
        await reloadCaddy();
        console.error(`[swap-${tier}] restored the previous site.caddy and reloaded`);
      } catch (e: unknown) {
        console.error(
          `[swap-${tier}] could not restore routing: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      console.error(
        `[swap-${tier}] skipping site.caddy restore: previous contents were ` +
          `${siteTextBefore === null ? 'missing or unreadable' : 'empty'} — nothing to go back to`,
      );
    }

    // 2. Hand be-01.internal back before stopping the container that holds
    //    it, or gw forwards into a stopped colour. With no outgoing colour
    //    (a first deploy) there is nothing to hand it to, so just strip it.
    if (tier === 'be' && aliasMovedToGreen) {
      const cmds = from === null ? revokeAliasCommands(to) : grantAliasCommands(from);
      try {
        for (const cmd of cmds) await sh(cmd);
        console.error(
          `[swap-${tier}] be-01.internal returned to ${from ?? 'no colour (first deploy)'}`,
        );
      } catch (e: unknown) {
        console.error(
          `[swap-${tier}] could not return be-01.internal: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 3. Green last: it is the thing every step above was protecting traffic
    //    from losing.
    try {
      await sh(['stop', greenName]);
    } catch (e: unknown) {
      console.error(
        `[swap-${tier}] could not stop ${greenName}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 4. Phase marker last: rewind it to what it said before this attempt
    //    (or remove it, if there was none) so it can never contradict
    //    be.json — an aborted swap leaves that file untouched too, so the
    //    tier's last real commit stays the single source of truth for both.
    try {
      if (phaseBefore === null) {
        await unlink(phasePath).catch((e: unknown) => {
          const code = e !== null && typeof e === 'object' && 'code' in e ? e.code : undefined;
          if (code !== 'ENOENT') throw e;
        });
      } else {
        await writePhase(phasePath, phaseBefore);
      }
      console.error(`[swap-${tier}] phase marker rewound to ${phaseBefore ?? '(none)'}`);
    } catch (e: unknown) {
      console.error(
        `[swap-${tier}] could not rewind the phase marker: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    throw new Error(`${reason}: ${detail}; ${from ?? 'nothing'} left live`);
  }

  for (const step of plan.steps) {
    console.log(`[swap-${tier}] ${step}`);
    try {
      switch (step) {
        case 'start-green': {
          await startGreen(tier, to, image, phasePath);
          break;
        }

        case 'migrate':
          // Discrete step before green takes traffic: a failed migration
          // aborts the deploy with the old colour untouched and un-migrated
          // (decision 10). Green is stopped rather than left running, because a
          // container that failed to migrate must not be one health-gate away
          // from taking traffic on a later run. Thrown bare — the outer
          // try/catch below delegates to abortSwap for every step at or
          // before 'reload'.
          //
          // The baseline is read BEFORE migrating and from the same container
          // that is about to migrate, so an abort knows exactly how far back
          // to unwind. A tier that cannot answer fails the deploy here rather
          // than at abort time, when the answer would be needed and missing.
          migrationBaseline = (await sh(migrateStatusCommand(greenName))).trim();
          if (migrationBaseline === '') {
            throw new Error(
              `${greenName} did not report which migrations are applied, so a failed ` +
                'deploy could not roll the schema back',
            );
          }
          await sh(['exec', greenName, 'bun', 'run', 'src/migrate-cli.ts']);
          break;

        case 'health-gate': {
          const ip = await containerIp(greenName);
          const ok = await waitForHealthy({
            url: `http://${ip}:${String(PORT[tier])}${HEALTH_PATH[tier]}`,
            timeoutMs: 2000,
            attempts: 120,
            intervalMs: 500,
            // fe-01 is a static file server: a truncated/empty index.html
            // still returns 200, which no status-only check would catch
            // (design decision 5). be-01/gw-01 keep the plain res.ok gate.
            isHealthy: tier === 'fe' ? (body) => body.length > 0 : undefined,
          });
          if (!ok) {
            throw new Error(
              `${tier}-${to} failed its health gate: no healthy response from ` +
                `${HEALTH_PATH[tier]} within the gate's ceiling`,
            );
          }
          break;
        }

        case 'grant-alias':
          // Incoming colour only — see lib/docker.ts's grantAliasCommands doc
          // comment for why this must run before render-route/reload (nothing
          // routes to this colour yet, so briefly disconnecting/reconnecting
          // it here is safe) and why the outgoing colour's cleanup is a
          // separate step deferred until after reload ('revoke-alias', below).
          for (const cmd of grantAliasCommands(to)) await sh(cmd);
          aliasMovedToGreen = true;
          break;

        case 'render-route': {
          // Live Caddy, not the file on disk — same reason observe() reads it
          // (see liveRoutedColors). Rendering the other tiers' routes from a
          // possibly-inverted file would propagate the lie into the config this
          // swap is about to load.
          //
          // `routedColorFor` returning null for a tier means "genuinely never
          // deployed" — passed straight through as null, NOT defaulted to
          // 'blue'. Defaulting was the bug: it wrote a guessed colour into
          // site.caddy as if it were real routing state, which the next
          // tier's own first deploy then read back as ground truth (routing
          // "wins over the state file, always") and planned a bogus swap
          // from. `siteContext`/`routeBlock` (lib/site.ts) render an honest
          // "not yet deployed" response for null instead, which also means
          // `routedColorFor` still correctly returns null next time.
          //
          // A throw anywhere in this case (liveRoutedColors, writeAtomic) is
          // caught by the outer try/catch below and delegated to abortSwap —
          // by this point grant-alias may already have moved be-01.internal
          // to green, which is exactly the window abortSwap exists to close.
          const colors = await liveRoutedColors();
          colors[tier] = to;
          const rendered = renderTemplate(
            siteCaddyTmpl,
            siteContext(colors, SITE_ADDRESS, await readMcpExposure(CURRENT_ENV)),
          );
          // Captured before the write, so abortSwap can put the file back
          // exactly as it found it.
          siteTextBefore = await readSiteCaddy();
          await writeAtomic(SITE_CADDY_PATH, rendered);
          break;
        }

        case 'reload': {
          // Written BEFORE the reload, like 'preparing' before start-green's
          // compose up: a process killed mid-reload must be classifiable as
          // "was attempting to route" rather than looking identical to having
          // never started. Recovery still re-derives the true live colour from
          // Caddy's live admin config (the source of truth — see
          // liveRoutedColors), never from this marker; it only names which
          // window a kill happened in.
          await writePhase(phasePath, 'routed');
          // Decision 10: "caddy reload fails — green is up but unrouted. Stop
          // green, leave blue live, exit non-zero." Both failure shapes are
          // thrown bare here and delegated to abortSwap by the outer
          // try/catch: the reload command itself failing, and the reload
          // exiting 0 without actually changing routing.
          await reloadCaddy();
          // Trust, but verify: reload exiting 0 only means the config was
          // syntactically valid, not that it's the config we think it is (see
          // currentCaddyConfig's doc comment — this is precisely how the
          // "reload silently no-ops" failure mode stayed invisible before).
          const liveConfig = await currentCaddyConfig();
          // `liveConfig.includes(greenName)` was the check here, and it asked a
          // weaker question than the one that matters: whether the name occurs
          // anywhere in the whole dump, in any site, in any field. It passes on
          // a mention this tier's route does not own — another environment's
          // block, a header value, an error body — and it cannot fail while any
          // stale reference to the container survives somewhere in the config.
          //
          // `routedColorFor` is the parser the planner already trusts to decide
          // which colour is live (liveRoutedColors, design decision 6). Using it
          // here means the reload check and the next deploy's observation read
          // the same config the same way, so they cannot disagree about what
          // happened.
          const routedNow = routedColorFromAdminConfig(tier, SITE_ADDRESS, liveConfig);
          if (routedNow !== to) {
            throw new Error(
              'caddy reload exited 0 but the live admin config ' +
                '(http://127.0.0.1:2019/config/ inside the caddy container) routes ' +
                `${tier} to ${routedNow ?? 'no colour at all'}, not ${to} — routing did ` +
                `not actually change. Check that /srv/wbs/caddy/Caddyfile really imports ` +
                `${SITE_CADDY_PATH.split('/').pop() ?? ''}. ` +
                `(This environment is ${CURRENT_ENV.env}; each environment has its own ` +
                'site file and both must be imported.)',
            );
          }
          break;
        }

        case 'drain': {
          // Existing helper: it polls a supplied counter rather than fetching
          // a URL itself, so getting the count is our job. gw-01's own
          // in-memory counters, exposed as JSON at /metrics/snapshot, are used
          // rather than the Prometheus-format /metrics endpoint — gw-01's
          // GatewayMetrics never registers an OTel instrument for
          // activeConnections, so that gauge does not exist in the Prometheus
          // output today (verified by reading gateway-metrics.ts and
          // otel-plugin.ts).
          const target = containerName('gw', from ?? to);
          const res = await drain({
            activeConnections: () => activeConnections(target),
            maxWaitMs: 300_000,
            pollMs: 10_000,
          });
          if (!res.drained) {
            console.warn(
              `[swap-gw] drain timed out after ${String(res.elapsedMs)}ms; ` +
                'remaining sockets will reconnect and resume via Layer-A',
            );
          }
          break;
        }

        case 'revoke-alias':
          // Outgoing colour only, and only reachable here once `from !== null`
          // (planSwap never includes this step otherwise) — deferred until
          // after reload/drain so Caddy has already switched its own-alias
          // route away from `from` before this disconnects it. See
          // lib/docker.ts's revokeAliasCommands doc comment.
          if (from !== null) {
            // Item 4: bounded settle before cutting the outgoing colour off
            // — see BE_REVOKE_ALIAS_SETTLE_MS's doc comment for why this is
            // a pause rather than a real drain, and what window remains
            // even with it.
            await sleep(BE_REVOKE_ALIAS_SETTLE_MS);
            for (const cmd of revokeAliasCommands(from)) await sh(cmd);
          }
          break;

        case 'stop-blue':
          await writePhase(phasePath, 'old-stopped');
          if (from !== null) await sh(['stop', containerName(tier, from)]);
          break;

        case 'commit':
          await writePhase(phasePath, 'committed');
          await writeAtomic(
            `${ROOT}/state/${tier}.json`,
            renderStateJson({ tier, activeColor: to, lastDeployedSha: sha }),
          );
          break;
      }
    } catch (e: unknown) {
      if (ABORTABLE_STEPS.has(step)) {
        // abortSwap's return type is `Promise<never>` — it always throws, so
        // this call is what actually propagates the failure. Nothing below
        // it in this branch runs.
        await abortSwap(`${tier}-${to} failed during '${step}'`, e);
      }
      // Steps after `reload` (`drain`, `revoke-alias`, `stop-blue`,
      // `commit`): routing has already moved onto `to`, which is now the
      // legitimately live colour — that is the explicit boundary
      // `ABORTABLE_STEPS` draws. Rolling back to `from` here would be
      // exactly backwards: Caddy and (for `be`) gw's forward alias already
      // point at `to`. Surface the failure as a hard non-zero exit instead;
      // it needs a human decision, not an automatic rollback.
      throw e;
    }
  }
}

function argOf(flag: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit === undefined ? '' : hit.slice(flag.length + 3);
}

const TIERS: readonly Tier[] = ['be', 'gw', 'fe'];

/**
 * Finding I1: the deploy lock is taken by `withLock` inside this executor,
 * but a multi-tier deploy used to be one SSH invocation *per tier* — so the
 * lock was acquired and released three times, and two concurrent `--all`
 * deploys could interleave (A swaps be, B swaps all three, A then swaps gw
 * and fe) into a stack that neither release intended.
 *
 * The fix is structural rather than a second lock: one invocation now names
 * every tier of the run, so the single existing lock spans the whole run.
 * Deliberately no "the caller already holds it" bypass flag — that would be
 * a lock that can be silently switched off, which is the failure mode this
 * codebase keeps rediscovering.
 */
export function parseTierList(raw: string): Tier[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) {
    throw new Error(`expected at least one tier (be, gw, fe), got "${raw}"`);
  }
  const out: Tier[] = [];
  for (const p of parts) {
    if (!TIERS.includes(p as Tier)) {
      throw new Error(`unknown tier "${p}" — expected one of ${TIERS.join(', ')}`);
    }
    // A repeated tier inside one lock hold would swap it twice: the second
    // pass observes the colour the first pass just moved to and swaps it
    // straight back, ending where it started while reporting success.
    if (out.includes(p as Tier)) {
      throw new Error(`repeated tier "${p}" in "${raw}" — each tier may appear at most once`);
    }
    out.push(p as Tier);
  }
  return out;
}

/** Injectable seams for `runSwaps`; production passes the real IO. */
export interface SwapRunDeps {
  withLock: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
  observe: (tier: Tier) => Promise<Observed>;
  execute: (plan: SwapPlan, image: string, sha: string) => Promise<void>;
}

/**
 * Drives every tier of one deploy run under a single lock hold.
 *
 * Each tier is observed *after* the previous tier committed, not all up
 * front: `be`'s swap changes what `gw` should be planned against, and
 * planning from state read before exclusion was won is the same staleness
 * bug the per-tier `withLock` comment describes.
 *
 * A tier that throws aborts the run and leaves the remaining tiers
 * untouched. That is deliberate — the failed tier has already run its own
 * abort/rollback path (`abortSwap`), and continuing on to deploy the next
 * tier against a half-swapped predecessor is exactly the mismatched stack
 * this lock exists to prevent.
 */
export async function runSwaps(
  tiers: Tier[],
  images: Partial<Record<Tier, string>>,
  sha: string,
  deps: SwapRunDeps,
): Promise<void> {
  await deps.withLock(`${ROOT}/state/deploy.lock`, async () => {
    for (const tier of tiers) {
      const image = images[tier];
      if (image === undefined) {
        throw new Error(`no --image-${tier}= given for tier "${tier}"`);
      }
      const plan = planSwap(tier, await deps.observe(tier));
      console.log(describePlan(tier, plan));
      await deps.execute(plan, image, sha);
    }
  });
}

function describePlan(tier: Tier, plan: SwapPlan): string {
  return `[swap-${tier}] ${String(plan.from)} -> ${plan.to}: ${plan.steps.join(' -> ')}`;
}

const USAGE =
  'usage: swap <tier[,tier...]> --image-<tier>=<registry/name@sha256:…> --sha=<git-sha> ' +
  '[--execute|--preflight]';

/**
 * Per-tier images. One invocation carries the whole run (see runSwaps), so
 * the image can no longer be a single `--image=`: each tier needs its own,
 * and a missing one has to be an error rather than a silent reuse of some
 * other tier's image.
 */
function imagesFor(tiers: Tier[]): { tier: Tier; image: string }[] {
  return tiers.map((tier) => {
    const raw = argOf(`image-${tier}`);
    if (raw === '') {
      throw new Error(`--image-${tier}=<registry/name@sha256:…> is required. ${USAGE}`);
    }
    return { tier, image: assertDigestPinnedRef(raw, tier) };
  });
}

async function main(): Promise<void> {
  const tiers = parseTierList(process.argv[2] ?? '');

  // Registry reachability/auth check on its own, with no lock and no state
  // change: tool-deploy runs this for every tier before executing any of
  // them, so a registry problem cannot leave one tier swapped and the next
  // one refusing to start (design decision 10).
  if (process.argv.includes('--preflight')) {
    for (const { tier, image } of imagesFor(tiers)) {
      await preflightRegistry(image);
      console.log(`[swap-${tier}] preflight ok: ${image} is present and authenticated`);
    }
    return;
  }

  if (!process.argv.includes('--execute')) {
    // Advisory only — nothing acts on this plan, so it's fine for it to be
    // observed outside the lock and to go stale by the time a real
    // --execute runs.
    for (const tier of tiers) {
      console.log(describePlan(tier, planSwap(tier, await observe(tier))));
    }
    console.log('[swap] dry-run (default). re-run with --execute to perform the swap.');
    return;
  }

  // Everything that can be rejected without touching the host, rejected
  // first: malformed arguments, then the registry. Only then is the lock
  // taken (design decision 10, "abort before anything starts").
  const resolved = imagesFor(tiers);
  const sha = argOf('sha');
  if (sha === '') throw new Error(`--sha=<git-sha> is required to execute. ${USAGE}`);
  for (const { image } of resolved) await preflightRegistry(image);
  const images: Partial<Record<Tier, string>> = {};
  for (const { tier, image } of resolved) images[tier] = image;

  // One lock for every tier in the run. Each tier is still observed and
  // planned only after exclusion is won — see runSwaps, and the staleness
  // argument it inherits from the original per-tier comment: a process that
  // observed state, then sat idle while another full swap ran, would
  // otherwise execute a plan derived from state that is no longer current,
  // and its stale `commit` step would silently overwrite the sha the other
  // process actually deployed.
  await runSwaps(tiers, images, sha, { withLock, observe, execute });
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error('[swap] failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
