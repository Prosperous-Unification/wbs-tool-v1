#!/usr/bin/env bun
/**
 * The dev deploy. Runs on h2puni, not on the machine that triggers it.
 *
 * Dev serves from a bind-mounted checkout whose tiers already watch their own
 * source -- be-01 and gw-01 under `bun --watch`, fe-01 under Vite HMR. So for
 * ordinary code the deploy is a write into that checkout: fetch, reset, done.
 * Nothing is built and nothing restarts.
 *
 * Some changes cannot reach a running process that way, and those are the
 * whole reason this file exists rather than being one `git reset` in a shell
 * script. See RESTART_PATHS.
 *
 * Run via: `bun tools/tool-devsync/src/sync.ts <sha>`.
 */
import {
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_SERVICE,
  SOLVER_SUPERVISOR_SOCKET,
} from '@wbs/deploy-contract';
import { $ } from 'bun';

const SRC = '/home/puni1/wbs-dev/src';
const CONTAINER = 'wbs-dev-src';
const LOCK = '/home/puni1/wbs-dev/state/devsync.lock';
const CONFIG_MAX_BYTES = 256 * 1024;
export const LOCK_BUSY_EXIT_CODE = 75;
export const SOLVER_COMPATIBILITY_PATHS = ['libs/solver-py', 'apps/be-01/Dockerfile'] as const;

export interface DevSolverMapping {
  sourceSha: string;
  image: string;
}

/** Reads only the independent compatibility identity; the supervisor decodes the whole file. */
export function devSolverMappingOf(text: string): DevSolverMapping {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('solver supervisor config root is not an object');
  }
  const config = value as Record<string, unknown>;
  const sourceSha = config['devSourceSha'];
  if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('solver supervisor config has no valid devSourceSha');
  }
  const images = config['images'];
  if (!Array.isArray(images)) throw new Error('solver supervisor config images is not an array');
  const devRules = images.filter(
    (rule) =>
      typeof rule === 'object' &&
      rule !== null &&
      !Array.isArray(rule) &&
      (rule as Record<string, unknown>)['callerName'] === 'wbs-dev-src',
  );
  if (devRules.length !== 1) throw new Error('solver supervisor config needs one dev image rule');
  const image = (devRules[0] as Record<string, unknown>)['solverImage'];
  if (typeof image !== 'string' || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('solver supervisor config dev image is not digest-pinned');
  }
  return { sourceSha, image };
}

export function assertDevSolverSourceCompatible(changedPaths: readonly string[]): void {
  if (changedPaths.length === 0) return;
  throw new Error(
    `dev solver mapping is stale for ${changedPaths.join(', ')}; publish the backend image and materialize a new supervisor config before deploying`,
  );
}

export interface SolverPreflightDependencies {
  currentSha(): Promise<string>;
  changedPaths(from: string, to: string): Promise<readonly string[]>;
  readConfig(): Promise<Uint8Array | undefined>;
  requireHost(image: string): Promise<void>;
}

async function changedSolverPaths(from: string, to: string): Promise<readonly string[]> {
  return (
    await $`git -C ${SRC} diff --name-only ${from} ${to} -- ${SOLVER_COMPATIBILITY_PATHS}`.text()
  )
    .split('\n')
    .filter((path) => path !== '');
}

const SOLVER_PREFLIGHT_DEPENDENCIES: SolverPreflightDependencies = {
  currentSha: async () => (await $`git -C ${SRC} rev-parse HEAD`.text()).trim(),
  changedPaths: changedSolverPaths,
  readConfig: async () => {
    const file = Bun.file(SOLVER_SUPERVISOR_CONFIG);
    if (!(await file.exists())) return undefined;
    return new Uint8Array(await file.slice(0, CONFIG_MAX_BYTES + 1).arrayBuffer());
  },
  requireHost: async (image) => {
    await $`systemctl --user is-active --quiet ${SOLVER_SUPERVISOR_SERVICE}`;
    await $`test -S ${SOLVER_SUPERVISOR_SOCKET}`;
    await $`${SOLVER_SUPERVISOR_BUN} ${SOLVER_SUPERVISOR_BUNDLE.remote} --preflight=dev --config=${SOLVER_SUPERVISOR_CONFIG} --solver-image=${image}`;
  },
};

/** Solver host state is a deploy prerequisite only when its compatibility inputs move. */
export async function preflightSolver(
  sha: string,
  dependencies: SolverPreflightDependencies = SOLVER_PREFLIGHT_DEPENDENCIES,
): Promise<void> {
  const deployedSha = await dependencies.currentSha();
  const targetChanges = await dependencies.changedPaths(deployedSha, sha);
  const bytes = await dependencies.readConfig();
  if (bytes === undefined) {
    if (targetChanges.length === 0) return;
    throw new Error(
      `solver compatibility inputs changed (${targetChanges.join(', ')}), but ${SOLVER_SUPERVISOR_CONFIG} is missing; run materialize-solver-supervisor-config and install-solver-supervisor before deploying`,
    );
  }
  if (bytes.byteLength === 0 || bytes.byteLength > CONFIG_MAX_BYTES) {
    throw new Error(
      `solver supervisor config must contain 1 through ${String(CONFIG_MAX_BYTES)} bytes`,
    );
  }
  const mapping = devSolverMappingOf(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const changed = await dependencies.changedPaths(mapping.sourceSha, sha);
  assertDevSolverSourceCompatible(changed);
  // Proof: sync.test.ts stages a future mapping before an unrelated target and
  // observes refusal before its injected host preflight can run.
  if (targetChanges.length === 0) return;
  await dependencies.requireHost(mapping.image);
}

export function devSyncFailureMessage(exitCode: number): string {
  return exitCode === LOCK_BUSY_EXIT_CODE
    ? '[dev-sync] skipped: another deploy holds the lock'
    : `[dev-sync] failed (exit ${String(exitCode)}); see the error above`;
}

export interface DevSyncLockOptions {
  bunPath?: string;
  flockPath?: string;
  lockPath?: string;
  scriptPath?: string;
}

/** Runs the production child invocation under the deploy lock. */
export async function runDevSyncLock(
  sha: string,
  options: DevSyncLockOptions = {},
): Promise<number> {
  // `process.execPath`, never a bare `bun`. The child is the process that
  // resets, installs, restarts and runs the solver preflight -- the parent
  // only waits on it -- so the child is the run whose interpreter matters.
  // `bin/dev-poll-sync.sh` refuses to start this tool unless the managed
  // interpreter matches `.bun-version`, and a default of `'bun'` handed that
  // decision back to PATH one process later. Measured on h2puni 2026-09-07:
  // the poller's own binary was 1.4.2, `.bun-version` and CI pin 1.3.14, and
  // every logged deploy footer said `Bun v1.2.20` -- the root-owned
  // /usr/local/bin/bun the child resolved to.
  const bunPath = options.bunPath ?? process.execPath;
  const flockPath = options.flockPath ?? 'flock';
  const lockPath = options.lockPath ?? LOCK;
  const scriptPath = options.scriptPath ?? import.meta.path;
  // Proof: removing `-E 75` failed the production-invocation test's exact argv
  // assertion: Expected began "-E", "75"; Received began "-n", devsync.lock.
  const run =
    await $`${flockPath} -E ${LOCK_BUSY_EXIT_CODE} -n ${lockPath} ${bunPath} ${scriptPath} --locked ${sha}`.nothrow();
  return run.exitCode;
}

/**
 * Paths whose change a running dev environment cannot pick up by itself.
 *
 * - `bun.lock` -- `bun install` cannot run inside a live watcher.
 * - `apps/be-01/drizzle` -- migrations are not imported by any watched module,
 *   so `bun --watch` never sees them. be-01 migrates at boot in dev
 *   (MIGRATE_ON_STARTUP=true) and reports migrationsApplied=true either way,
 *   so a missed restart means new code on an old schema, reported healthy.
 * - `package.json`, `nx.json`, `apps/<tier>/project.json` -- the Nx supervisor
 *   reads the serve targets once, at startup. A changed port, command or
 *   project list leaves the old topology running while HEAD moves on.
 * - `apps/fe-01/vite.config.ts` -- Vite reloads app code, not its own config.
 *
 * Not covered, deliberately, because they need more than a restart: the
 * Dockerfile and compose.yml (rebuild/recreate), and the gitignored per-tier
 * .env files (not in git at all). Both are called out in LLM_README.md.
 */
export const RESTART_PATHS: readonly string[] = [
  'bun.lock',
  'package.json',
  'nx.json',
  'apps/be-01/drizzle',
  'apps/be-01/project.json',
  'apps/gw-01/project.json',
  'apps/fe-01/project.json',
  'apps/mcp-01/project.json',
  'apps/fe-01/vite.config.ts',
  // TypeScript config is read once, at process start. A moved path alias
  // resolves against the old mapping in three already-running processes while
  // HEAD says otherwise, which presents as an import that exists in the editor
  // and not at runtime.
  'tsconfig.base.json',
  'apps/be-01/tsconfig.json',
  'apps/gw-01/tsconfig.json',
  'apps/fe-01/tsconfig.json',
  'apps/mcp-01/tsconfig.json',
  // A library's project.json can change what its serve-time build resolves to,
  // and the Nx supervisor read the project graph at startup like the rest.
  // Listed per library rather than as `libs`, which would restart on every
  // source edit and defeat the watchers. `sync.test.ts` fails if a library on
  // disk is missing from this list, so adding one cannot silently skip it.
  'libs/auth/project.json',
  'libs/config/project.json',
  'libs/contracts/project.json',
  'libs/core/project.json',
  'libs/domain/project.json',
  'libs/observability/project.json',
  'libs/realtime/project.json',
  // Proof: removing this entry failed `names every library project.json that exists on disk`
  // on `Expected to contain: "libs/runtime-portable/project.json"`.
  'libs/runtime-portable/project.json',
  'libs/validation/project.json',
  'libs/solver-py/project.json',
];

/**
 * Paths a restart cannot apply: they define the container itself. The running
 * container was created from the old file, so `docker restart` reuses the old
 * mounts, user, limits and image — the deploy would report success for a
 * change that is not in effect anywhere.
 *
 * These fail the deploy instead of being silently ignored. The checkout has
 * already moved by then, which is correct: dev is running the new source, and
 * the operator is told the one thing still outstanding.
 */
export const RECREATE_PATHS: readonly string[] = [
  'deploy/dev-src/compose.yml',
  'deploy/dev-src/Dockerfile',
];

export type Fingerprint = Record<string, string>;

/**
 * Whether the container must be restarted after a pull.
 *
 * Any difference across the manifest counts, including a path that appeared,
 * disappeared, or could not be hashed. Inferring "nothing to do" from missing
 * evidence is how dev ends up serving against a stale schema with no symptom
 * other than behaviour that does not match the code.
 */
export function needsRestart(before: Fingerprint, after: Fingerprint): boolean {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const p of paths) {
    const b = before[p];
    const a = after[p];
    if (!b || !a) return true;
    if (b !== a) return true;
  }
  return false;
}

export async function assertMcpEnv(path = `${SRC}/apps/mcp-01/.env`): Promise<void> {
  if (!(await Bun.file(path).exists())) {
    throw new Error(`missing ${path}; seed the gitignored mcp-01 environment before deploying`);
  }
}

/** sha256 of a file, or of a directory's recursive listing plus contents. */
async function hashPath(path: string): Promise<string> {
  try {
    const out =
      await $`sh -c ${`cd ${SRC} && find ${path} -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum`}`.text();
    return out.split(' ')[0] ?? '';
  } catch {
    return '';
  }
}

async function fingerprint(paths: readonly string[] = RESTART_PATHS): Promise<Fingerprint> {
  const entries = await Promise.all(paths.map(async (p) => [p, await hashPath(p)] as const));
  return Object.fromEntries(entries);
}

export async function sync(sha: string, options: { mcpEnvPath?: string } = {}): Promise<void> {
  await assertMcpEnv(options.mcpEnvPath);
  const before = await fingerprint();
  const containerBefore = await fingerprint(RECREATE_PATHS);

  await $`git -C ${SRC} fetch --quiet origin`;
  await preflightSolver(sha);
  await $`git -C ${SRC} reset --hard --quiet ${sha}`;

  // The reset is only believed once HEAD says so. `git reset` on a SHA the
  // fetch did not deliver fails, but a partially applied reset would otherwise
  // be reported as the requested deploy.
  const head = (await $`git -C ${SRC} rev-parse HEAD`.text()).trim();
  if (!head.startsWith(sha) && !sha.startsWith(head)) {
    throw new Error(`reset did not land: asked for ${sha}, HEAD is ${head}`);
  }

  const after = await fingerprint();

  if (needsRestart(before, after)) {
    const moved = RESTART_PATHS.filter((p) => before[p] !== after[p]);
    console.log(`[dev-sync] restart required, changed: ${moved.join(', ') || 'unknown'}`);
    await $`docker exec ${CONTAINER} bun install --frozen-lockfile`;
    await $`docker restart ${CONTAINER}`;
  } else {
    console.log('[dev-sync] code only: watchers pick it up, nothing restarted');
  }

  console.log(`[dev-sync] dev now at ${head}`);

  const containerAfter = await fingerprint(RECREATE_PATHS);
  const containerMoved = RECREATE_PATHS.filter((p) => containerBefore[p] !== containerAfter[p]);
  if (containerMoved.length > 0) {
    throw new Error(
      `${containerMoved.join(', ')} changed, and a restart cannot apply it.\n` +
        '  The running container was created from the previous file, so its mounts,\n' +
        '  user, limits and image are still the old ones. Dev is serving the new\n' +
        '  source with the old container definition.\n' +
        '  Apply it: ssh h2puni "cd /home/puni1/wbs-dev/src/deploy/dev-src && docker compose up -d"',
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const locked = args[0] === '--locked';
  const sha = locked ? args[1] : args[0];

  if (!sha) {
    console.error('usage: bun sync.ts <sha>');
    process.exit(1);
  }

  if (locked) {
    // Already inside flock: this is the real run.
    await sync(sha);
  } else {
    // Two overlapping runs can interleave their fetch, reset, install and
    // restart, leaving dev on one SHA with another SHA's dependencies. flock
    // makes the whole sequence exclusive; -n fails fast rather than queueing a
    // deploy whose operator has stopped watching. The dedicated conflict exit
    // keeps a child failure from being mislabeled as lock contention.
    const exitCode = await runDevSyncLock(sha);
    if (exitCode !== 0) {
      console.error(devSyncFailureMessage(exitCode));
    }
    process.exit(exitCode);
  }
}
