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
  isDirectory(path: string): Promise<boolean>;
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

const DEFAULT_IO: SolverBindingRuntimeIo = {
  exists: (path) => Bun.file(path).exists(),
  isDirectory: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
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
        const cleanTreeEnvironment: Readonly<Record<string, string>> = (await io.isDirectory(
          join(target.root, '.git'),
        ))
          ? {}
          : { WBS_CLEAN_TREE_REPOSITORY: sourceRepository };
        await run(
          'solver image publish',
          [
            // The target is an exported, install-free candidate tree. The
            // durable lock wrapper belongs to the live checkout; the build
            // entrypoint below remains pinned to the target candidate.
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
