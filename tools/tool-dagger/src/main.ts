import { readFileSync, statfsSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

import type { BuildArg, Platform } from '@dagger.io/dagger';
import { connect } from '@dagger.io/dagger';

import {
  digestRef,
  imageRef,
  parseDigest,
  type ReleaseRecord,
  renderRelease,
  type Tier,
} from './lib/publish';

const DOCKERFILE: Record<Tier, string> = {
  be: 'apps/be-01/Dockerfile',
  gw: 'apps/gw-01/Dockerfile',
  fe: 'apps/fe-01/Dockerfile',
};

const PUBLIC_URL = process.env['WBS_PUBLIC_URL'] ?? 'https://wbs.bulletpoints.club';
const REGISTRY = process.env['REGISTRY'] ?? 'registry.infra.bulletpoints.club';
const REGISTRY_USER = process.env['REGISTRY_USER'] ?? 'wbs';

const GIBIBYTE = 1024 ** 3;
const ENGINE_NAME = 'wbs-dagger-engine';
const ENGINE_IMAGE = 'registry.dagger.io/engine:v0.21.8';
const ENGINE_MEMORY_BYTES = 8 * GIBIBYTE;
const ENGINE_NANO_CPUS = 6_000_000_000;
const ENGINE_PIDS = 2048;
const ENGINE_RUNNER_HOST = 'tcp://127.0.0.1:8081';
const ENGINE_COMMAND = [
  '--addr',
  'unix:///run/buildkit/buildkitd.sock',
  '--addr',
  'unix:///run/dagger/engine.sock',
  '--addr',
  'tcp://0.0.0.0:8080',
];

export interface BuildCapacity {
  availableMemoryBytes: number;
  tmpfsAvailableBytes: number;
  tmpfsCapacityBytes: number;
  load1: number;
  cpuCount: number;
}

export interface EngineControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CapacitySource {
  meminfoPath?: string;
  tmpPath?: string;
  shmPath?: string;
  load1?: () => number;
  cpuCount?: () => number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: string[]) => CommandResult;

function filesystemCapacity(path: string): { availableBytes: number; capacityBytes: number } {
  const stats = statfsSync(path, { bigint: true });
  const availableBytes = Number(stats.bavail * stats.bsize);
  const capacityBytes = Number(stats.blocks * stats.bsize);
  if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(capacityBytes)) {
    throw new Error(`filesystem capacity for ${path} exceeds the safe integer range`);
  }
  return { availableBytes, capacityBytes };
}

/** Reads the fail-closed host snapshot consumed by {@link assertBuildCapacity}. */
export function readBuildCapacity(source: CapacitySource = {}): BuildCapacity {
  const meminfoPath = source.meminfoPath ?? '/proc/meminfo';
  const meminfo = readFileSync(meminfoPath, 'utf8');
  const availableMatch = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (availableMatch?.[1] === undefined) {
    throw new Error(`${meminfoPath} has no valid MemAvailable measurement`);
  }
  const availableMemoryBytes = Number(availableMatch[1]) * 1024;
  if (!Number.isSafeInteger(availableMemoryBytes)) {
    throw new Error(`${meminfoPath} MemAvailable exceeds the safe integer range`);
  }

  const tmpfs = filesystemCapacity(source.tmpPath ?? '/tmp');
  const sharedMemory = filesystemCapacity(source.shmPath ?? '/dev/shm');
  return {
    availableMemoryBytes,
    tmpfsAvailableBytes: tmpfs.availableBytes + sharedMemory.availableBytes,
    tmpfsCapacityBytes: tmpfs.capacityBytes + sharedMemory.capacityBytes,
    load1: (source.load1 ?? (() => loadavg()[0] ?? Number.NaN))(),
    cpuCount: (source.cpuCount ?? availableParallelism)(),
  };
}

/**
 * Refuses a release before Dagger starts when h2puni cannot keep serving the
 * application beside the build. See `protect-release-build-capacity`.
 */
export function assertBuildCapacity(capacity: BuildCapacity): void {
  if (capacity.availableMemoryBytes < 8 * GIBIBYTE) {
    throw new Error(
      `unsafe available memory: ${String(capacity.availableMemoryBytes)} bytes; need at least ${String(8 * GIBIBYTE)}`,
    );
  }
  if (capacity.tmpfsCapacityBytes <= 0) {
    throw new Error('unsafe tmpfs occupancy: combined capacity must be positive');
  }
  const tmpfsUsedBytes = capacity.tmpfsCapacityBytes - capacity.tmpfsAvailableBytes;
  if (tmpfsUsedBytes / capacity.tmpfsCapacityBytes > 0.25) {
    throw new Error(
      `unsafe tmpfs occupancy: ${String(tmpfsUsedBytes)} of ${String(capacity.tmpfsCapacityBytes)} bytes used; maximum is 25%`,
    );
  }
  if (!Number.isInteger(capacity.cpuCount) || capacity.cpuCount <= 0) {
    throw new Error(`unsafe one-minute load input: invalid CPU count ${String(capacity.cpuCount)}`);
  }
  if (!Number.isFinite(capacity.load1) || capacity.load1 > capacity.cpuCount) {
    throw new Error(
      `unsafe one-minute load: ${String(capacity.load1)} for ${String(capacity.cpuCount)} CPUs; maximum is one runnable task per CPU`,
    );
  }
}

/** The single reproducible Docker creation contract for the release engine. */
export function engineCreateArgs(): string[] {
  return [
    'docker',
    'run',
    '--detach',
    '--privileged',
    `--name=${ENGINE_NAME}`,
    '--memory=8g',
    '--memory-swap=8g',
    '--cpus=6',
    '--pids-limit=2048',
    '--publish',
    '127.0.0.1:8081:8080',
    '--volume',
    `${ENGINE_NAME}:/var/lib/dagger`,
    ENGINE_IMAGE,
    ...ENGINE_COMMAND,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${label}: expected an object`);
  return value;
}

/** Validates the external Docker inspect document before the named engine is reused. */
export function assertEngineContract(value: unknown): void {
  const engine = requireRecord(value, 'engine inspect');
  const state = requireRecord(engine['State'], 'engine State');
  const config = requireRecord(engine['Config'], 'engine Config');
  const host = requireRecord(engine['HostConfig'], 'engine HostConfig');

  if (state['Running'] !== false) {
    throw new Error('engine running state mismatch: expected a stopped engine before reuse');
  }

  if (config['Image'] !== ENGINE_IMAGE) {
    throw new Error(`engine image mismatch: expected ${ENGINE_IMAGE}`);
  }
  const command = config['Cmd'];
  if (
    !Array.isArray(command) ||
    command.length !== ENGINE_COMMAND.length ||
    command.some((argument, index) => argument !== ENGINE_COMMAND[index])
  ) {
    throw new Error('engine listener mismatch: expected loopback TCP engine API');
  }
  if (host['Memory'] !== ENGINE_MEMORY_BYTES || host['MemorySwap'] !== ENGINE_MEMORY_BYTES) {
    throw new Error('engine memory mismatch: expected 8 GiB with no swap expansion');
  }
  if (host['NanoCpus'] !== ENGINE_NANO_CPUS) {
    throw new Error('engine CPU mismatch: expected 6 CPUs');
  }
  if (host['PidsLimit'] !== ENGINE_PIDS) {
    throw new Error(`engine PID mismatch: expected ${String(ENGINE_PIDS)}`);
  }
  if (host['Privileged'] !== true) {
    throw new Error('engine privilege mismatch: expected privileged mode');
  }
  const restartPolicy = requireRecord(host['RestartPolicy'], 'engine restart policy');
  if (restartPolicy['Name'] !== 'no') {
    throw new Error('engine restart policy mismatch: expected no automatic restart');
  }
  if (host['NetworkMode'] !== 'bridge') {
    throw new Error('engine network mode mismatch: expected the default bridge network');
  }

  const ports = requireRecord(host['PortBindings'], 'engine port bindings');
  if (Object.keys(ports).length !== 1 || !Object.hasOwn(ports, '8080/tcp')) {
    throw new Error('engine port mismatch: expected only the loopback engine API binding');
  }
  const bindings = ports['8080/tcp'];
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error('engine port mismatch: expected one loopback binding');
  }
  const binding = requireRecord(bindings[0], 'engine port binding');
  if (binding['HostIp'] !== '127.0.0.1' || binding['HostPort'] !== '8081') {
    throw new Error('engine port mismatch: expected 127.0.0.1:8081');
  }

  const mounts = engine['Mounts'];
  if (!Array.isArray(mounts)) throw new Error('invalid engine mounts: expected an array');
  const cacheMatches = mounts.some(
    (mount) =>
      isRecord(mount) &&
      mount['Type'] === 'volume' &&
      mount['Name'] === ENGINE_NAME &&
      mount['Destination'] === '/var/lib/dagger' &&
      mount['RW'] === true,
  );
  if (!cacheMatches) {
    throw new Error(`engine cache mismatch: expected volume ${ENGINE_NAME}`);
  }

  const networkSettings = requireRecord(engine['NetworkSettings'], 'engine NetworkSettings');
  const networks = requireRecord(networkSettings['Networks'], 'engine networks');
  if (Object.keys(networks).length !== 1 || !Object.hasOwn(networks, 'bridge')) {
    throw new Error('engine network mismatch: expected only the default bridge network');
  }
}

function runCommand(argv: string[]): CommandResult {
  const process = Bun.spawnSync(argv);
  return {
    exitCode: process.exitCode,
    stdout: process.stdout.toString('utf8'),
    stderr: process.stderr.toString('utf8'),
  };
}

function requireCommand(run: CommandRunner, argv: string[]): CommandResult {
  const result = run(argv);
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result;
}

/** Creates or validates, starts, and stops the single bounded release engine. */
export function createDockerEngineControl(run: CommandRunner = runCommand): EngineControl {
  return {
    start: (): Promise<void> => {
      const inspected = run(['docker', 'container', 'inspect', ENGINE_NAME]);
      if (inspected.exitCode === 0) {
        const parsed: unknown = JSON.parse(inspected.stdout);
        if (!Array.isArray(parsed) || parsed.length !== 1) {
          throw new Error('invalid engine inspect: expected exactly one container');
        }
        assertEngineContract(parsed[0]);
        requireCommand(run, ['docker', 'start', ENGINE_NAME]);
        return Promise.resolve();
      }
      if (!inspected.stderr.toLowerCase().includes('no such container')) {
        throw new Error(`docker inspect ${ENGINE_NAME} failed: ${inspected.stderr.trim()}`);
      }
      requireCommand(run, engineCreateArgs());
      return Promise.resolve();
    },
    stop: (): Promise<void> => {
      requireCommand(run, ['docker', 'stop', '--time', '30', ENGINE_NAME]);
      return Promise.resolve();
    },
  };
}

/**
 * Owns the engine lifetime around one release attempt. Stop is deliberately
 * outside the work callback so success cannot leave resident build capacity.
 */
export async function runEngineLifecycle<T>(
  engine: EngineControl,
  work: () => Promise<T>,
): Promise<T> {
  let stopPromise: Promise<void> | undefined;
  let result: T | undefined;
  let workFailed = false;
  let workFailure: unknown;
  let stopFailed = false;
  let stopFailure: unknown;
  let signalExitStarted = false;
  const stopOnce = (): Promise<void> => {
    stopPromise ??= engine.stop();
    return stopPromise;
  };
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const exitAfterCleanup = (signal: 'SIGINT' | 'SIGTERM', exitCode: number): void => {
    if (signalExitStarted) return;
    signalExitStarted = true;
    void stopOnce()
      .catch((error: unknown) => {
        console.error(`[tool-dagger] engine stop after ${signal} failed: ${message(error)}`);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };
  const onSigint = (): void => {
    exitAfterCleanup('SIGINT', 130);
  };
  const onSigterm = (): void => {
    exitAfterCleanup('SIGTERM', 143);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    await engine.start();
  } catch (error: unknown) {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    throw error;
  }

  try {
    result = await work();
  } catch (error: unknown) {
    workFailed = true;
    workFailure = error;
  }
  try {
    await stopOnce();
  } catch (error: unknown) {
    stopFailed = true;
    stopFailure = error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }

  if (workFailed && stopFailed) {
    throw new AggregateError(
      [workFailure, stopFailure],
      `publish failed: ${message(workFailure)}; engine stop also failed: ${message(stopFailure)}`,
      { cause: workFailure },
    );
  }
  if (workFailed) throw workFailure;
  if (stopFailed) throw stopFailure;
  return result as T;
}

/** The admission ordering used by the real publish entrypoint. */
export async function runAdmittedPublish<T>(
  capacity: BuildCapacity,
  engine: EngineControl,
  work: () => Promise<T>,
): Promise<T> {
  assertBuildCapacity(capacity);
  return runEngineLifecycle(engine, work);
}

// linux/amd64 is pinned explicitly so a client running on arm64 (a dev laptop,
// or a build host) produces the same image the amd64 production host runs.
// When the engine isn't natively amd64 it builds this under QEMU emulation —
// that's what apps/fe-01/Dockerfile's BUN_JSC_useJIT=0 works around; that
// workaround lives in the Dockerfile itself, so it carries over unchanged
// regardless of who invokes the build (docker CLI or Dagger).
const TARGET_PLATFORM = 'linux/amd64' as Platform;

function buildArgs(tier: Tier): BuildArg[] {
  if (tier !== 'fe') return [];
  const wsHost = PUBLIC_URL.replace(/^https?:\/\//, '');
  const wsScheme = PUBLIC_URL.startsWith('https://') ? 'wss' : 'ws';
  return [
    { name: 'VITE_BE_URL', value: PUBLIC_URL },
    { name: 'VITE_GW_URL', value: PUBLIC_URL },
    { name: 'VITE_WS_URL', value: `${wsScheme}://${wsHost}/ws` },
  ];
}

/**
 * Dagger's TypeScript SDK reads its engine address from
 * _EXPERIMENTAL_DAGGER_RUNNER_HOST (still experimentally prefixed as of
 * v0.21.8), which is an awkward thing to type at a call site. If the
 * friendlier DAGGER_RUNNER_HOST is set and the real variable isn't, copy it
 * across — explicitly, and logged, rather than silently, so a typo in the
 * real variable's name doesn't fail in a way that's hard to trace back here.
 */
export function applyRunnerHostAlias(env: NodeJS.ProcessEnv): void {
  const friendly = env['DAGGER_RUNNER_HOST'];
  const real = env['_EXPERIMENTAL_DAGGER_RUNNER_HOST'];
  if (friendly !== undefined && friendly !== '' && (real === undefined || real === '')) {
    console.error(
      `[tool-dagger] DAGGER_RUNNER_HOST=${friendly} -> _EXPERIMENTAL_DAGGER_RUNNER_HOST (Dagger's real variable)`,
    );
    env['_EXPERIMENTAL_DAGGER_RUNNER_HOST'] = friendly;
  }
}

/**
 * Reads the registry password from the environment, failing loudly rather
 * than letting publishAll silently attempt (and fail) an unauthenticated
 * push. Kept separate from publishAll so the check runs, and can fail,
 * before any Dagger engine connection is opened.
 */
export function requireRegistryPassword(env: NodeJS.ProcessEnv): string {
  const pass = env['REGISTRY_PASS'];
  if (pass === undefined || pass === '') {
    throw new Error(
      'REGISTRY_PASS must be set to authenticate the publish — refusing to attempt an unauthenticated push',
    );
  }
  return pass;
}

/**
 * Refuses to publish from a dirty working tree.
 *
 * `publishAll` snapshots `client.host().directory('.')` — the WORKING TREE —
 * while `publish-all` labels the result `WBS_SHA=$(git rev-parse HEAD)`. Those
 * are the same thing only when the tree is clean, and the gap is not cosmetic:
 * `tool-deploy`'s migration gate (tools/tool-deploy/src/migrations.ts) reads
 * the migration set *from git* at that sha, so an uncommitted migration is
 * baked into the image and simultaneously invisible to the gate.
 * `assertMigrationFlag` then passes, no `--with-migrations` acknowledgement is
 * asked for, and the migration is applied to the database blue and green
 * share. That is the only fail-open in the design's central safety gate, and
 * it is closed here rather than in the gate itself because the gate cannot see
 * inside the image — only the builder knows what it put there.
 *
 * There is deliberately no override flag. `publish-all` pushes to the
 * production registry; "publish something that is not a commit" has no
 * legitimate use, and an escape hatch would just be the fail-open again with
 * an extra step.
 *
 * Scope, stated honestly: this equates the tree with HEAD for *tracked* files.
 * `git status --porcelain` says nothing about ignored files, which the build
 * context can still pick up (see .dockerignore). Migrations are tracked, so
 * the gate this exists to close is fully closed; image hygiene generally is a
 * separate concern.
 */
export function assertCleanTree(): void {
  const p = Bun.spawnSync(['git', 'status', '--porcelain']);
  if (p.exitCode !== 0) {
    throw new Error(`git status --porcelain failed: ${p.stderr.toString('utf8').trim()}`);
  }
  const dirty = p.stdout.toString('utf8').trim();
  if (dirty !== '') {
    throw new Error(
      'refusing to publish from a dirty working tree.\n' +
        '  The build context is the working tree, but the release is labelled with HEAD,\n' +
        "  and tool-deploy's migration gate reads migrations from git at that sha — so an\n" +
        '  uncommitted migration would ship inside the image and be invisible to the gate.\n' +
        '  Commit or stash first. Uncommitted changes:\n' +
        dirty
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
    );
  }
}

export async function publishAll(tiers: Tier[], sha: string): Promise<ReleaseRecord> {
  applyRunnerHostAlias(process.env);
  const registryPassword = requireRegistryPassword(process.env);
  const record: ReleaseRecord = {};
  await connect(
    async (client) => {
      // Wrapped in Dagger's secret mechanism rather than interpolated into
      // any string, so the plaintext password is never logged and can't end
      // up in an error message.
      const registrySecret = client.setSecret('registry-password', registryPassword);
      // A single host directory snapshot is reused as the build context for
      // every tier so each Dockerfile sees the same source tree. This is the
      // WORKING tree, not `sha` — `assertCleanTree()` (called by main, before
      // any of this) is what makes those the same thing.
      const src = client
        .host()
        .directory('.', { exclude: ['node_modules', 'dist', '.git', '.nx'] });
      for (const tier of tiers) {
        const ref = imageRef(REGISTRY, tier, sha);
        const published = await src
          .dockerBuild({
            dockerfile: DOCKERFILE[tier],
            platform: TARGET_PLATFORM,
            buildArgs: buildArgs(tier),
          })
          // The address here is the registry host (REGISTRY), not the
          // per-image ref — withRegistryAuth authenticates against the
          // registry itself, not a specific repository/tag within it.
          .withRegistryAuth(REGISTRY, REGISTRY_USER, registrySecret)
          .publish(ref);
        const digest = parseDigest(published);
        // `image` is the whole address+digest the server will pull, recorded
        // here and carried verbatim from now on — see ReleaseEntry.image.
        record[tier] = { sha, digest, ref, image: digestRef(REGISTRY, tier, digest) };
      }
    },
    { LogOutput: process.stderr },
  );
  return record;
}

async function main(): Promise<void> {
  const sha = process.env['WBS_SHA'];
  if (sha === undefined || sha === '') throw new Error('WBS_SHA must be set');
  // Before any engine connection or push: the label must actually describe
  // what is about to be built.
  assertCleanTree();
  const arg = process.argv[2] ?? 'be,gw,fe';
  const tiers = arg.split(',').filter((t): t is Tier => t === 'be' || t === 'gw' || t === 'fe');
  const capacity = readBuildCapacity();
  console.error(
    `[tool-dagger] capacity: available-memory=${String(capacity.availableMemoryBytes)} ` +
      `tmpfs-available=${String(capacity.tmpfsAvailableBytes)}/${String(capacity.tmpfsCapacityBytes)} ` +
      `load1=${String(capacity.load1)} cpus=${String(capacity.cpuCount)}`,
  );
  process.env['_EXPERIMENTAL_DAGGER_RUNNER_HOST'] = ENGINE_RUNNER_HOST;
  const record = await runAdmittedPublish(capacity, createDockerEngineControl(), () =>
    publishAll(tiers, sha),
  );
  await Bun.write('dist/tool-dagger/release.json', renderRelease(record));
  console.log(renderRelease(record));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error('[tool-dagger] publish failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
