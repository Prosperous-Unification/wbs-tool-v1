import { SOLVER_SUPERVISOR_BUN } from '@wbs/deploy-contract';
import { describe, expect, it } from 'bun:test';

import { decodeProdContainerImages, prepareTargetSolverBinding } from './solver-binding-host';
import {
  createTargetSolverBindingRuntime,
  type SolverBindingRuntimeInvocation,
} from './solver-binding-runtime';

const SHA = 'a'.repeat(40);
const IDENTITY = 'b'.repeat(64);
const BLUE = `registry.example/wbs-be@sha256:${'c'.repeat(64)}`;
const GREEN = `registry.example/wbs-be@sha256:${'d'.repeat(64)}`;
const DEV = `registry.example/wbs-be@sha256:${'e'.repeat(64)}`;
const ROOT = '/home/puni1/wbs-dev/bin/sync.target';
const SOURCE_REPOSITORY = '/home/puni1/wbs-dev/src';
const BUN = '/home/puni1/wbs-dev/bin/bun';
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const installed = bytes(
  JSON.stringify({
    socketPath: '/run/user/1000/wbs-solver/supervisor.sock',
    maxSearchWorkers: 2,
    maxMemoryLimitMb: 512,
    pidsLimit: 128,
    maxManagedContainers: 16,
    devSourceSha: 'f'.repeat(40),
    images: [
      { callerName: 'be-01-blue', callerImage: BLUE, solverImage: BLUE },
      { callerName: 'be-01-green', callerImage: GREEN, solverImage: GREEN },
      { callerName: 'wbs-dev-src', callerImage: null, solverImage: GREEN },
    ],
  }),
);

describe('the production solver binding runtime', () => {
  it('keeps the credential out of argv and drives the exact host transition', async () => {
    const digest = `sha256:${'e'.repeat(64)}`;
    const files = new Map<string, Uint8Array>([
      ['/home/puni1/wbs/.env', bytes('REGISTRY_PASS=protected-value\n')],
      ['/home/puni1/.config/wbs-solver/solver-supervisor.json', installed],
      [
        `${ROOT}/dist/tool-dagger/release.json`,
        bytes(
          JSON.stringify({
            be: { sha: SHA, digest, ref: `registry.example/wbs-be:${SHA}`, image: DEV },
          }),
        ),
      ],
    ]);
    const invocations: SolverBindingRuntimeInvocation[] = [];
    const checkpoints: { path: string; contents: string }[] = [];
    const locks: string[] = [];
    const runtime = createTargetSolverBindingRuntime(
      {
        root: ROOT,
        bunPath: BUN,
        sourceRepository: SOURCE_REPOSITORY,
        sourceSha: SHA,
        compatibilityIdentity: IDENTITY,
      },
      {
        exists: (path) => Promise.resolve(path !== `${ROOT}/.git`),
        isDirectory: () => Promise.resolve(false),
        read: (path) => {
          const contents = files.get(path);
          if (contents === undefined) throw new Error(`fixture has no ${path}`);
          return Promise.resolve(contents);
        },
        command: (invocation) => {
          invocations.push(invocation);
          return Promise.resolve({ exitCode: 0, stderr: '' });
        },
        query: () => Promise.reject(new Error('installed config must avoid container inspection')),
        withLock: async (path, action) => {
          locks.push(path);
          return action();
        },
        writeAtomic: (path, contents) => {
          checkpoints.push({ path, contents });
          return Promise.resolve();
        },
      },
    );

    await prepareTargetSolverBinding(
      { sourceSha: SHA, compatibilityIdentity: IDENTITY },
      undefined,
      runtime.dependencies,
    );

    expect(invocations.map(({ argv }) => argv[0])).toEqual([
      `${SOURCE_REPOSITORY}/bin/with-heavy-lock.sh`,
      BUN,
      BUN,
      BUN,
      'systemctl',
      'test',
      SOLVER_SUPERVISOR_BUN,
      'git',
    ]);
    expect(invocations[0]?.argv).toEqual([
      `${SOURCE_REPOSITORY}/bin/with-heavy-lock.sh`,
      '--',
      'env',
      `WBS_SHA=${SHA}`,
      BUN,
      'run',
      `${ROOT}/tools/tool-dagger/src/main.ts`,
      'be',
    ]);
    expect(invocations[0]?.env).toEqual({
      REGISTRY_PASS: 'protected-value',
      WBS_CLEAN_TREE_REPOSITORY: SOURCE_REPOSITORY,
    });
    expect(invocations.flatMap(({ argv }) => argv)).not.toContain('protected-value');
    expect(invocations[1]?.argv).toContain(`--blue-image=${BLUE}`);
    expect(invocations[1]?.argv).toContain(`--green-image=${GREEN}`);
    expect(invocations[1]?.argv).toContain(`--dev-solver-image=${DEV}`);
    expect(invocations[2]?.argv).toEqual([BUN, 'x', 'nx', 'run', 'tool-remote-scripts:build']);
    expect(invocations[3]?.argv).toContain('--execute');
    expect(invocations[4]?.argv).toEqual([
      'systemctl',
      '--user',
      'is-active',
      '--quiet',
      'wbs-solver-supervisor.service',
    ]);
    expect(invocations[5]?.argv).toEqual([
      'test',
      '-S',
      '/run/user/1000/wbs-solver/supervisor.sock',
    ]);
    expect(invocations[6]?.argv).toContain('--preflight=dev');
    expect(invocations[7]?.argv).toEqual([
      'git',
      '-C',
      SOURCE_REPOSITORY,
      'reset',
      '--hard',
      '--quiet',
      SHA,
    ]);
    expect(checkpoints.map(({ path }) => path)).toEqual([runtime.statePath, runtime.statePath]);
    const phases = checkpoints.map(({ contents }) => {
      const checkpoint = JSON.parse(contents) as unknown;
      if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
        throw new Error('checkpoint fixture is not an object');
      }
      return (checkpoint as Record<string, unknown>)['phase'];
    });
    expect(phases).toEqual(['published', 'complete']);
    expect(locks).toEqual(['/home/puni1/wbs/state/deploy.lock']);
  });

  it('derives a missing config from exact prod container inspection but propagates unreadability', async () => {
    const inspection = [
      { name: '/be-01-blue', running: false, image: BLUE },
      { name: '/be-01-green', running: true, image: GREEN },
    ]
      .map((container) => JSON.stringify(container))
      .join('\n');
    const queries: SolverBindingRuntimeInvocation[] = [];
    const missing = createTargetSolverBindingRuntime(
      { root: ROOT, bunPath: BUN, sourceSha: SHA, compatibilityIdentity: IDENTITY },
      {
        exists: () => Promise.resolve(false),
        isDirectory: () => Promise.resolve(false),
        read: () => Promise.reject(new Error('missing config must not be read')),
        command: () => Promise.resolve({ exitCode: 0, stderr: '' }),
        withLock: (_path, action) => action(),
        query: (invocation) => {
          queries.push(invocation);
          return Promise.resolve({ exitCode: 0, stdout: inspection, stderr: '' });
        },
        writeAtomic: () => Promise.resolve(),
      },
    );

    expect(await missing.dependencies.readInstalledConfig()).toBeUndefined();
    expect(decodeProdContainerImages(await missing.dependencies.readProdContainers())).toEqual({
      blueImage: BLUE,
      greenImage: GREEN,
    });
    expect(queries[0]?.argv.slice(0, 3)).toEqual(['docker', 'inspect', '--format']);
    expect(queries[0]?.argv.slice(-2)).toEqual(['be-01-blue', 'be-01-green']);

    const unreadable = createTargetSolverBindingRuntime(
      { root: ROOT, bunPath: BUN, sourceSha: SHA, compatibilityIdentity: IDENTITY },
      {
        exists: () => Promise.resolve(true),
        isDirectory: () => Promise.resolve(false),
        read: () => Promise.reject(new Error('EACCES installed config')),
        command: () => Promise.resolve({ exitCode: 0, stderr: '' }),
        withLock: (_path, action) => action(),
        query: () => Promise.reject(new Error('unreadable config must not fall back')),
        writeAtomic: () => Promise.resolve(),
      },
    );
    let rejection: unknown;
    try {
      await unreadable.dependencies.readInstalledConfig();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toMatch(/EACCES/);
  });

  // Proof: forcing the repository override for this `.git`-backed candidate
  // makes this assertion fail and weakens the candidate's own clean-tree gate.
  it('keeps a git-backed candidate on its own clean-tree guard', async () => {
    const invocations: SolverBindingRuntimeInvocation[] = [];
    const runtime = createTargetSolverBindingRuntime(
      {
        root: ROOT,
        bunPath: BUN,
        sourceRepository: SOURCE_REPOSITORY,
        sourceSha: SHA,
        compatibilityIdentity: IDENTITY,
      },
      {
        exists: () => Promise.resolve(true),
        isDirectory: (path) => Promise.resolve(path === `${ROOT}/.git`),
        read: () => Promise.resolve(bytes('{}')),
        command: (invocation) => {
          invocations.push(invocation);
          return Promise.resolve({ exitCode: 0, stderr: '' });
        },
        query: () => Promise.reject(new Error('publish must not query')),
        writeAtomic: () => Promise.resolve(),
        withLock: (_path, action) => action(),
      },
    );

    await runtime.dependencies.publish(SHA, 'protected-value');
    expect(invocations[0]?.env).toEqual({ REGISTRY_PASS: 'protected-value' });
  });
});
