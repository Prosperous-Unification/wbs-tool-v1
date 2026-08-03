// The deploy orchestrator. It answers two questions before anything touches
// the server: which tiers should move, and is it safe to blue/green them —
// then, for --execute, drives the real per-tier swap over SSH.
//
// It does not build or publish images itself: `nx run tool-dagger:publish-all`
// (Task 4) is a separate, explicit step that writes `release.json`. This CLI
// only reads that file, so a stale or missing release entry fails loudly
// rather than silently deploying an old image.
import { materialize, parseDeployArgs, type Tier } from './affected';
import {
  assertMigrationFlag,
  assertStopTheWorldNotImplemented,
  hasNewMigrations,
  migrationsAtSha,
} from './migrations';
import { readRemoteState, type RemoteTierState } from './remote-state';

export const DEFAULT_HOST = 'h2puni';
export const DEFAULT_RELEASE_PATH = 'dist/tool-dagger/release.json';

export interface ReleaseEntry {
  sha: string;
  digest: string;
  /** The tagged ref the image was pushed to. Traceability only. */
  ref: string;
  /**
   * The digest-pinned ref, registry address included, exactly as
   * `tool-dagger` recorded it. Passed through to `swap.js` verbatim — this
   * CLI is the only thing that talks to both sides, so it is the one place
   * the address could have been lost, and it used to be: only `--digest` and
   * `--sha` crossed the SSH boundary, with no env passthrough, leaving the
   * server to rebuild the ref from its own `REGISTRY` default. See
   * tools/tool-dagger/src/lib/publish.ts's ReleaseEntry.image.
   */
  image: string;
}
export type ReleaseRecord = Partial<Record<Tier, ReleaseEntry>>;

export interface DeployPlan {
  tiers: Tier[];
  steps: string[];
  /**
   * The single remote command that swaps every tier of this run, or empty if
   * no tier is selected. One command, not one per tier: the deploy lock lives
   * inside swap.js, so per-tier invocations released it between tiers and let
   * two concurrent `--all` deploys interleave (finding I1).
   */
  commands: string[];
  /**
   * Read-only registry check covering every tier, run to completion before
   * the command above executes (design decision 10: "SSH, registry, or
   * registry auth unavailable at start — abort before anything starts").
   * Checking all tiers up front is the point: a per-tier check inside each
   * swap would still let tier 1 deploy and tier 2 fail, which is a
   * half-deployed stack.
   */
  preflightCommands: string[];
  dryRun: boolean;
  host: string;
}

export interface DeployPlanDeps {
  readRemoteState: (host: string) => Promise<Partial<Record<Tier, RemoteTierState>>>;
  /** Migration folder names present under apps/be-01/drizzle at `sha`. */
  listMigrations: (sha: string) => string[];
  readRelease: (path: string) => Promise<ReleaseRecord>;
  /**
   * Paths with uncommitted changes in the worktree this CLI is running from;
   * empty means clean. See assertCleanWorktree for why the plan needs it.
   */
  dirtyPaths: () => string[];
}

/**
 * Uncommitted paths, as `git status --porcelain` reports them — staged,
 * unstaged, and untracked alike. Untracked files count: a new
 * `lib/whatever.ts` that `swap.js` imports is uncommitted source that the
 * bundle would nonetheless be built from.
 */
function defaultDirtyPaths(): string[] {
  const p = Bun.spawnSync(['git', 'status', '--porcelain']);
  if (p.exitCode !== 0) {
    throw new Error(`git status --porcelain failed: ${p.stderr.toString('utf8').trim()}`);
  }
  return (
    p.stdout
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      // Porcelain v1 is "XY <path>" with the status in the first two columns.
      .map((l) => l.slice(3).trim())
  );
}

/**
 * Finding I4: `assertBundleInstalled` proves the remote `/srv/wbs/bin/`
 * bundles match the local `dist/` ones, and nothing more. Two stale
 * artifacts match each other perfectly, so on its own that check never
 * establishes which *commit* the orchestrator driving the swap came from.
 *
 * The missing link is supplied here rather than by hashing anything else.
 * `tool-deploy:deploy` declares `dependsOn` builds of `tool-remote-scripts`
 * and `tool-smoke`, so `dist/` is always rebuilt from the current worktree
 * before this CLI runs; if the worktree also equals HEAD, then
 * `dist/` == HEAD, and the existing remote-vs-local hash comparison carries
 * that all the way to the server. A dirty tree is precisely the case that
 * breaks the chain — the bundle would be built from source that exists on
 * no commit, while `release.json`'s images were built by tool-dagger from a
 * clean tree at HEAD. That mismatch is what this refuses.
 *
 * It runs before `readRemoteState`, alongside the `--stop-the-world` and
 * migration gates, so it aborts "before anything starts" (decision 10) —
 * and it runs on dry runs too, so the operator finds out before typing
 * `--execute` rather than after.
 */
function assertCleanWorktree(dirty: string[]): void {
  if (dirty.length === 0) return;
  const shown = dirty.slice(0, 10);
  const more = dirty.length - shown.length;
  throw new Error(
    `refusing to deploy from a worktree with uncommitted changes (${String(dirty.length)} path(s)):\n` +
      shown.map((p) => `  ${p}`).join('\n') +
      (more > 0 ? `\n  ...and ${String(more)} more` : '') +
      '\n  The executor bundles are rebuilt from this worktree, so deploying now would\n' +
      '  drive the swap with orchestrator code that exists on no commit, while the\n' +
      '  images in release.json were built from a clean tree. Commit or stash first.',
  );
}

async function defaultReadRelease(path: string): Promise<ReleaseRecord> {
  const text = await Bun.file(path)
    .text()
    .catch(() => null);
  if (text === null) {
    throw new Error(
      `release manifest not found at ${path} — run "nx run tool-dagger:publish-all" first`,
    );
  }
  return JSON.parse(text) as ReleaseRecord;
}

export const defaultDeployPlanDeps: DeployPlanDeps = {
  readRemoteState,
  listMigrations: migrationsAtSha,
  readRelease: defaultReadRelease,
  dirtyPaths: defaultDirtyPaths,
};

/**
 * Builds the deploy plan: which tiers move, what each one's remote swap
 * command will be, and — the safety-critical part — refuses to proceed if a
 * tier carries a migration the operator hasn't explicitly acknowledged via
 * `--with-migrations` or `--stop-the-world`. `deps` defaults to the real SSH
 * + git + filesystem implementations; tests inject fakes.
 */
export async function buildDeployPlan(
  argv: string[],
  affected: Tier[],
  headSha: string,
  deps: DeployPlanDeps = defaultDeployPlanDeps,
): Promise<DeployPlan> {
  const args = parseDeployArgs(argv);
  // Rejected unconditionally, before any tier is even examined (design
  // decision 10's "abort before anything starts" — see
  // assertStopTheWorldNotImplemented's doc comment for why this can't be
  // left to fall through as a migration-gate bypass).
  assertStopTheWorldNotImplemented(args.stopTheWorld);
  // Also before any tier is examined, and before readRemoteState touches the
  // network: the bundle this run would deploy with is built from the
  // worktree, so the worktree has to be a commit. See assertCleanWorktree.
  assertCleanWorktree(deps.dirtyPaths());
  const tiers = materialize(args, affected);
  const host = args.host ?? DEFAULT_HOST;
  const steps: string[] = [];
  const commands: string[] = [];
  const preflightCommands: string[] = [];
  const imageArgs: string[] = [];

  const remote = await deps.readRemoteState(host);
  const release = await deps.readRelease(args.bundle ?? DEFAULT_RELEASE_PATH);
  const headMigrations = deps.listMigrations(headSha);

  for (const t of tiers) {
    const state = remote[t];
    const deployedSha = state?.lastDeployedSha ?? null;
    steps.push(
      `[plan] ${t}: last=${deployedSha ?? '(none)'} active=${state?.activeColor ?? '(never deployed)'}`,
    );

    const deployedMigrations = deployedSha === null ? null : deps.listMigrations(deployedSha);
    const newMigrations = hasNewMigrations(deployedMigrations, headMigrations);
    // Throws (and aborts the whole plan, before any tier touches the
    // network) if this tier has new migrations and --with-migrations wasn't
    // given — see migrations.ts for why this must fail closed.
    // (--stop-the-world is already rejected above, unconditionally.)
    assertMigrationFlag(newMigrations, args.withMigrations);
    if (newMigrations) {
      steps.push(`[plan] ${t}: new migrations present — proceeding under --with-migrations`);
    }

    const entry = release[t];
    if (entry === undefined) {
      throw new Error(
        `no release entry for tier "${t}" in ${args.bundle ?? DEFAULT_RELEASE_PATH} — ` +
          'run "nx run tool-dagger:publish-all" first',
      );
    }

    // The gate above compares migrations *at git shas*, which only describes
    // what is inside the image if the image was built from a commit. That is
    // enforced at build time by tool-dagger's assertCleanTree(), and enforced
    // here by refusing a release that was not built from the commit this
    // deploy is deploying — otherwise `entry` could carry an image built from
    // an entirely different tree while the gate happily diffs HEAD.
    if (entry.sha !== headSha) {
      throw new Error(
        `release entry for tier "${t}" was built at ${entry.sha} but HEAD is ${headSha}.\n` +
          '  The migration gate compares migrations in git at HEAD, so it only describes\n' +
          '  this image if the two agree. Re-run "nx run tool-dagger:publish-all" at HEAD,\n' +
          '  or check out the commit the release was built from.',
      );
    }

    // `--image-<tier>` carries the whole publish address; nothing on the far
    // side reconstructs it (see ReleaseEntry.image).
    imageArgs.push(`--image-${t}=${entry.image}`);
  }

  if (tiers.length > 0) {
    // Finding I1: this used to be one `ssh` invocation *per tier*. The deploy
    // lock lives inside swap.js, so per-tier invocations released it between
    // tiers and two concurrent `--all` deploys could interleave (A swaps be,
    // B swaps all three, A then swaps gw and fe) into a stack neither
    // release intended. One invocation naming every tier is what makes the
    // single existing lock cover the whole run — see swap.ts's runSwaps.
    //
    // Verified against the live host: swap.js is invoked as `ssh h2puni
    // 'cd /srv/wbs && bun bin/swap.js ...'` — no explicit user (the ssh
    // config alias already carries it) and no absolute bun path.
    const base =
      `cd /srv/wbs && bun bin/swap.js ${tiers.join(',')} ` +
      `${imageArgs.join(' ')} --sha=${headSha}`;
    const remoteCmd = base + (args.dryRun ? '' : ' --execute');
    steps.push(`[plan] ssh ${host} ${JSON.stringify(remoteCmd)}`);
    commands.push(remoteCmd);
    // Still read-only, still ahead of every swap: decision 10 requires a
    // registry/auth problem to abort before the FIRST tier starts, and
    // swap.js's --preflight loops all the named tiers without taking a lock.
    preflightCommands.push(`${base} --preflight`);
  }

  return { tiers, steps, commands, preflightCommands, dryRun: args.dryRun, host };
}

// Duplicated from tools/tool-remote-scripts/src/lib/docker.ts's APP/PORT
// rather than imported: that project has no `@wbs/*` public entry point (nx
// enforces cross-project imports go through one — see tool-compose's
// index.ts for what that looks like), and adding one for three constants
// used in exactly one place here was not worth the new surface. tool-smoke's
// own health.ts already hardcodes the same three ports for the same reason.
const TIER_APP: Record<Tier, string> = { be: 'be-01', gw: 'gw-01', fe: 'fe-01' };
const TIER_HEALTH_PORT: Record<Tier, number> = { be: 3100, gw: 3200, fe: 80 };
const TIER_HEALTH_PATH: Record<Tier, string> = { be: '/health', gw: '/health', fe: '/' };

function tierUrl(tier: Tier, path: string, color: 'blue' | 'green'): string {
  return `http://${TIER_APP[tier]}-${color}:${String(TIER_HEALTH_PORT[tier])}${path}`;
}

/**
 * Finding I5(b): wires `tool-smoke` (bundled to `/srv/wbs/bin/smoke.js` —
 * see `tools/tool-smoke/project.json`'s `build` target and
 * `tools/tool-smoke/src/main.ts`'s doc comment) into the deploy path.
 * Design decision 9 says smoke runs "after every deploy"; before this,
 * nothing called it at all.
 *
 * Per-tier colour overrides (`SMOKE_BE_URL`/`SMOKE_GW_URL`/`SMOKE_FE_URL`/
 * `SMOKE_INTERNAL_URL` — see `tools/tool-smoke/src/health.ts`'s
 * `resolveTargets`/`resolveInternalForwardUrl`), not a single `SMOKE_COLOR`:
 * each tier's blue/green state moves independently, and a deploy need not
 * leave all three on the SAME colour even with `--all` (each tier flips its
 * OWN current colour; verified live on h2puni mid-branch, where be/gw were
 * both green and fe was still blue). A single global colour would silently
 * smoke-test the wrong container for whichever tier disagreed. `state` is
 * read back from the server's own just-committed state (never guessed, never
 * operator-supplied), which is what "the deploy knows the colours it just
 * swapped to" means here — a tier with no recorded state (never deployed)
 * is simply left without an override rather than guessed at.
 *
 * The JWT signing key and `INTERNAL_AUTH_SECRET` smoke needs never appear on
 * this command line, and this process (running on the operator's machine,
 * not the server) never reads them: they reach the ephemeral smoke
 * container via `--env-file /srv/wbs/gw-01.secrets.env` on the server side,
 * which already carries exactly those two and nothing else (see
 * `lib/docker.ts`'s `SECRET_KEYS`) — "pass them rather than making an
 * operator supply them" without this process ever handling secret bytes.
 */
export function buildSmokeCommand(state: Partial<Record<Tier, RemoteTierState>>): string {
  const overrides: string[] = [];
  const be = state.be?.activeColor;
  const gw = state.gw?.activeColor;
  const fe = state.fe?.activeColor;
  if (be !== undefined) {
    overrides.push(`-e SMOKE_BE_URL=${tierUrl('be', TIER_HEALTH_PATH.be, be)}`);
    overrides.push(`-e SMOKE_INTERNAL_URL=${tierUrl('be', '/internal/forward', be)}`);
  }
  if (gw !== undefined) overrides.push(`-e SMOKE_GW_URL=${tierUrl('gw', TIER_HEALTH_PATH.gw, gw)}`);
  if (fe !== undefined) overrides.push(`-e SMOKE_FE_URL=${tierUrl('fe', TIER_HEALTH_PATH.fe, fe)}`);
  return (
    'cd /srv/wbs && docker run --rm --network wbs-net ' +
    `--env-file /srv/wbs/gw-01.secrets.env ${overrides.join(' ')} ` +
    '-v /srv/wbs/bin/smoke.js:/smoke.js:ro oven/bun:1.3.14-alpine bun run /smoke.js'
  );
}

// The two files the server actually executes: swap.js (run directly by
// host bun for every tier's swap) and smoke.js (run in a container after
// every deploy). Duplicated from tool-remote-scripts/src/install.ts's
// BUNDLE_FILES rather than imported — see this file's own TIER_APP/PORT
// comment above for why a small cross-project constant is duplicated
// instead of wired through an @wbs/* barrel that doesn't exist for that
// project.
const BUNDLE_FILES: { local: string; remote: string }[] = [
  { local: 'dist/tool-remote-scripts/swap.js', remote: '/srv/wbs/bin/swap.js' },
  { local: 'dist/tool-smoke/smoke.js', remote: '/srv/wbs/bin/smoke.js' },
];

async function sha256File(path: string): Promise<string> {
  const buf = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Buffer.from(digest).toString('hex');
}

/** Parses coreutils `sha256sum` output (`<hex>␠␠<path>` per line) into a path -> hash map. */
export function parseSha256sumOutput(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const sp = trimmed.indexOf(' ');
    if (sp === -1) continue;
    result[trimmed.slice(sp).trimStart()] = trimmed.slice(0, sp);
  }
  return result;
}

/**
 * Finding-driven (retire-systemd): `bin/swap.js` and `bin/smoke.js` are
 * ordinary files on the server, installed by a separate, explicit
 * `nx run tool-remote-scripts:install --execute` — this CLI does not run
 * that for the operator, on the same "abort before anything starts, don't
 * silently do the operator's job for them" logic as the release.json / HEAD
 * sha check above. What this DOES own is refusing to drive a deploy against
 * whatever happens to already be sitting in /srv/wbs/bin/: before touching
 * anything, it hashes the same two dist/ files install.ts would have
 * shipped and compares them against what's already on the server. A stale
 * or missing installed bundle now fails loudly here instead of silently
 * running last week's swap.js against this week's images.
 */
export async function assertBundleInstalled(host: string): Promise<void> {
  for (const f of BUNDLE_FILES) {
    if (!(await Bun.file(f.local).exists())) {
      throw new Error(
        `${f.local} not found — build it first ` +
          '(nx run tool-remote-scripts:build and nx run tool-smoke:build)',
      );
    }
  }

  const p = Bun.spawn(['ssh', host, `sha256sum ${BUNDLE_FILES.map((f) => f.remote).join(' ')}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(
      `cannot read installed-bundle checksums from ${host} (${err.trim() || `exit ${String(code)}`}) — ` +
        'has "nx run tool-remote-scripts:install --execute" ever been run against this host?',
    );
  }
  const remoteHashes = parseSha256sumOutput(out);

  for (const f of BUNDLE_FILES) {
    const local = await sha256File(f.local);
    // Indexing a plain Record returns `string` here (noUncheckedIndexedAccess
    // is off in this repo), but at runtime a key sha256sum never printed —
    // i.e. the file is missing on the server — comes back `undefined`, which
    // trivially fails this comparison too. One check covers "missing" and
    // "mismatched" alike; the error message says so explicitly.
    if (remoteHashes[f.remote] !== local) {
      throw new Error(
        `${f.remote} on ${host} does not match the local build of ${f.local} (missing or mismatched) — ` +
          'the installed executor/smoke bundle is stale or missing. Run ' +
          `"nx run tool-remote-scripts:install --host=${host} --execute" first, then retry.`,
      );
    }
  }
}

async function runRemote(host: string, cmd: string): Promise<void> {
  const p = Bun.spawn(['ssh', host, cmd], { stdout: 'inherit', stderr: 'inherit' });
  const code = await p.exited;
  if (code !== 0) {
    throw new Error(`remote command failed (exit ${String(code)}) on ${host}: ${cmd}`);
  }
}

function currentHeadSha(): string {
  const p = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  if (p.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${p.stderr.toString('utf8').trim()}`);
  }
  return p.stdout.toString('utf8').trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const headSha = currentHeadSha();
  const plan = await buildDeployPlan(argv, ['be', 'gw', 'fe'], headSha);

  console.log(
    `[tool-deploy] tiers=${plan.tiers.join(',') || '(none)'} host=${plan.host} dry-run=${String(plan.dryRun)}`,
  );
  for (const s of plan.steps) console.log(s);

  if (plan.dryRun) {
    console.log('[tool-deploy] dry-run only. re-run with --execute to perform a live deploy.');
    return;
  }

  // Before any registry or tier check: refuse to drive a deploy against a
  // stale or missing bin/swap.js or bin/smoke.js. See assertBundleInstalled.
  await assertBundleInstalled(plan.host);

  // Every tier's registry check first, then every tier's swap. Decision 10
  // requires a registry/auth problem to abort "before anything starts", which
  // for a multi-tier deploy means before the FIRST tier starts, not before
  // each one.
  for (const cmd of plan.preflightCommands) {
    console.log(`[tool-deploy] $ ssh ${plan.host} ${cmd}`);
    await runRemote(plan.host, cmd);
  }

  // Sequential, one tier at a time: each swap already health-gates its own
  // colour before touching routing, and running tiers concurrently would
  // make a failed swap's console output impossible to attribute.
  for (const cmd of plan.commands) {
    console.log(`[tool-deploy] $ ssh ${plan.host} ${cmd}`);
    await runRemote(plan.host, cmd);
  }

  // Design decision 9: "after every deploy". Strictly after every tier has
  // already swapped and committed — never inside the per-tier loop above —
  // so a smoke failure can only ever report on a deploy that already
  // happened, never influence it.
  if (plan.tiers.length > 0) {
    const postState = await readRemoteState(plan.host);
    const smokeCmd = buildSmokeCommand(postState);
    console.log(`[tool-deploy] $ ssh ${plan.host} ${smokeCmd}`);
    try {
      await runRemote(plan.host, smokeCmd);
      console.log('[tool-deploy] smoke passed');
    } catch (e: unknown) {
      // Decision 10: report loudly and exit non-zero, but do NOT auto-roll
      // back — an automatic rollback on a flaky smoke check is worse than a
      // human looking. Every tier above already committed; this only ever
      // adds a loud, distinguishable failure report on top of that, never a
      // corrective action.
      console.error(
        '[tool-deploy] SMOKE FAILED — every tier above already swapped and committed; this is ' +
          'NOT being auto-rolled-back (design decision 10). Investigate immediately; the ' +
          'previous colour is still available to hand-roll back to if needed.',
      );
      throw e;
    }
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error('[tool-deploy] failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
