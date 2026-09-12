import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_SERVICE,
  SOLVER_SUPERVISOR_SOCKET,
  withLock,
  writeAtomic,
} from '@wbs/deploy-contract';

import type { TargetSolverBindingDependencies } from './solver-binding-host';

const LIVE_SOURCE_ROOT = '/home/puni1/wbs-dev/src';
const HOST_STATE_ROOT = '/home/puni1/wbs-dev/state';
const REGISTRY_ENV = '/home/puni1/wbs/.env';
const PROD_DEPLOY_LOCK = '/home/puni1/wbs/state/deploy.lock';
/**
 * Lets an ordinary gate finish ahead of an automatic publish, then refuses.
 * The heavy-lock wrapper still rejects a stale owner immediately and reports a
 * live owner after this 15-minute ceiling instead of waiting without bound.
 */
const SOLVER_PUBLISH_LOCK_WAIT_SECONDS = '900';
const HOST_INPUT_MAX_BYTES = 256 * 1024;
const PROD_CONTAINER_INSPECT_FORMAT =
  '{"name":{{json .Name}},"running":{{json .State.Running}},"image":{{json .Config.Image}}}';

export interface SolverBindingRuntimeInvocation {
  cwd: string;
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export interface SolverBindingRuntimeIo {
  exists(path: string): Promise<boolean>;
  isGitMetadata(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  command(
    invocation: SolverBindingRuntimeInvocation,
  ): Promise<{ exitCode: number; stderr: string }>;
  query(
    invocation: SolverBindingRuntimeInvocation,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeAtomic(path: string, contents: string): Promise<void>;
  withLock<T>(path: string, action: () => Promise<T>): Promise<T>;
}

export interface SolverBindingRuntimeTarget {
  root: string;
  bunPath: string;
  sourceRepository?: string;
  sourceSha: string;
  compatibilityIdentity: string;
}

export interface TargetSolverBindingRuntime {
  statePath: string;
  configPath: string;
  dependencies: TargetSolverBindingDependencies;
}

async function command(
  invocation: SolverBindingRuntimeInvocation,
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([...invocation.argv], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    stdout: 'inherit',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, stderr };
}

async function query(
  invocation: SolverBindingRuntimeInvocation,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...invocation.argv], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Distinguishes absent Git metadata from unreadable or malformed metadata. */
export async function isGitMetadata(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isDirectory() || metadata.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const DEFAULT_IO: SolverBindingRuntimeIo = {
  exists: (path) => Bun.file(path).exists(),
  isGitMetadata,
  read: async (path) =>
    new Uint8Array(
      await Bun.file(path)
        .slice(0, HOST_INPUT_MAX_BYTES + 1)
        .arrayBuffer(),
    ),
  command,
  query,
  writeAtomic: (path, contents) => writeAtomic(path, contents),
  withLock,
};

async function requireCommand(
  label: string,
  invocation: SolverBindingRuntimeInvocation,
  io: SolverBindingRuntimeIo,
): Promise<void> {
  const output = await io.command(invocation);
  if (output.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${String(output.exitCode)}): ${output.stderr.trim()}`);
  }
}

async function requireQuery(
  label: string,
  invocation: SolverBindingRuntimeInvocation,
  io: SolverBindingRuntimeIo,
): Promise<Uint8Array> {
  const output = await io.query(invocation);
  if (output.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${String(output.exitCode)}): ${output.stderr.trim()}`);
  }
  const bytes = new TextEncoder().encode(output.stdout);
  if (bytes.byteLength === 0 || bytes.byteLength > HOST_INPUT_MAX_BYTES) {
    throw new Error(
      `${label} must return 1 through ${String(HOST_INPUT_MAX_BYTES)} bytes of stdout`,
    );
  }
  return bytes;
}

/** Supplies the h2puni-only file and command boundary for one target clone. */
export function createTargetSolverBindingRuntime(
  target: SolverBindingRuntimeTarget,
  io: SolverBindingRuntimeIo = DEFAULT_IO,
): TargetSolverBindingRuntime {
  if (!isAbsolute(target.root) || resolve(target.root) !== target.root) {
    throw new Error('solver binding runtime root must be an absolute normalized path');
  }
  if (!isAbsolute(target.bunPath)) {
    throw new Error('solver binding runtime Bun path must be absolute');
  }
  const sourceRepository = target.sourceRepository ?? LIVE_SOURCE_ROOT;
  if (!isAbsolute(sourceRepository) || resolve(sourceRepository) !== sourceRepository) {
    throw new Error('solver binding source repository must be an absolute normalized path');
  }
  if (!/^[0-9a-f]{40}$/.test(target.sourceSha)) {
    throw new Error('solver binding runtime source SHA is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(target.compatibilityIdentity)) {
    throw new Error('solver binding runtime compatibility identity is invalid');
  }

  const statePath = join(
    HOST_STATE_ROOT,
    `solver-preparation.${target.compatibilityIdentity}.json`,
  );
  const configPath = join(
    HOST_STATE_ROOT,
    `solver-supervisor.${target.compatibilityIdentity}.json`,
  );
  const releasePath = join(target.root, 'dist/tool-dagger/release.json');
  const materializer = join(
    target.root,
    'tools/tool-remote-scripts/src/materialize-solver-supervisor-config.ts',
  );
  const installer = join(target.root, 'tools/tool-remote-scripts/src/install-solver-supervisor.ts');

  const run = (label: string, argv: readonly string[], env?: Readonly<Record<string, string>>) =>
    requireCommand(label, { cwd: target.root, argv, ...(env === undefined ? {} : { env }) }, io);

  return {
    statePath,
    configPath,
    dependencies: {
      readRegistryEnv: () => io.read(REGISTRY_ENV),
      readInstalledConfig: async () =>
        (await io.exists(SOLVER_SUPERVISOR_CONFIG)) ? io.read(SOLVER_SUPERVISOR_CONFIG) : undefined,
      readProdContainers: () =>
        requireQuery(
          'production backend container inspection',
          {
            cwd: target.root,
            argv: [
              'docker',
              'inspect',
              '--format',
              PROD_CONTAINER_INSPECT_FORMAT,
              'be-01-blue',
              'be-01-green',
            ],
          },
          io,
        ),
      publish: async (sourceSha, registryPassword) => {
        const cleanTreeEnvironment: Readonly<Record<string, string>> = (await io.isGitMetadata(
          join(target.root, '.git'),
        ))
          ? {}
          : { WBS_CLEAN_TREE_REPOSITORY: sourceRepository };
        // The recovery candidate owns an install resolved from its own
        // bun.lock. It is retained and pruned with that candidate, so neither
        // a changed target lock nor source-checkout install can cross the
        // target revision boundary.
        await run('solver candidate dependency install', [
          target.bunPath,
          'install',
          '--frozen-lockfile',
        ]);
        await run(
          'solver image publish',
          [
            // The target is a detached, target-lock-installed candidate. The
            // durable lock wrapper belongs to the live checkout; the build
            // entrypoint and dependency resolution remain pinned to the
            // candidate revision.
            join(sourceRepository, 'bin/with-heavy-lock.sh'),
            '--',
            'env',
            `WBS_SHA=${sourceSha}`,
            target.bunPath,
            'run',
            join(target.root, 'tools/tool-dagger/src/main.ts'),
            'be',
          ],
          {
            REGISTRY_PASS: registryPassword,
            HEAVY_LOCK_WAIT_SECONDS: SOLVER_PUBLISH_LOCK_WAIT_SECONDS,
            ...cleanTreeEnvironment,
          },
        );
        return io.read(releasePath);
      },
      materialize: (config) =>
        run('solver config materialization', [
          target.bunPath,
          materializer,
          `--blue-image=${config.blueImage}`,
          `--green-image=${config.greenImage}`,
          `--dev-solver-image=${config.devSolverImage}`,
          `--dev-source-sha=${config.devSourceSha}`,
          `--output=${configPath}`,
          '--replace',
        ]),
      install: async () => {
        await run('solver supervisor bundle build', [
          target.bunPath,
          'x',
          'nx',
          'run',
          'tool-remote-scripts:build',
        ]);
        await run('solver supervisor install', [
          target.bunPath,
          installer,
          '--host=h2puni',
          `--config=${configPath}`,
          '--execute',
        ]);
      },
      preflight: async (binding) => {
        await run('solver supervisor service preflight', [
          'systemctl',
          '--user',
          'is-active',
          '--quiet',
          SOLVER_SUPERVISOR_SERVICE,
        ]);
        await run('solver supervisor socket preflight', ['test', '-S', SOLVER_SUPERVISOR_SOCKET]);
        await run('solver supervisor mapping preflight', [
          SOLVER_SUPERVISOR_BUN,
          SOLVER_SUPERVISOR_BUNDLE.remote,
          '--preflight=dev',
          `--config=${SOLVER_SUPERVISOR_CONFIG}`,
          `--solver-image=${binding.image}`,
        ]);
      },
      checkpoint: (state) => io.writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`),
      withHostMutationLock: (action) => io.withLock(PROD_DEPLOY_LOCK, action),
      reset: (sourceSha) =>
        run('dev checkout reset', [
          'git',
          '-C',
          sourceRepository,
          'reset',
          '--hard',
          '--quiet',
          sourceSha,
        ]),
    },
  };
}
