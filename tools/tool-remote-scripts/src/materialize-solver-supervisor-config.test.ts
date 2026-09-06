import { describe, expect, it } from 'bun:test';

import {
  materializeSolverSupervisorConfig,
  parseSolverSupervisorConfigArgs,
  renderSolverSupervisorConfig,
  type SolverSupervisorConfigDependencies,
} from './materialize-solver-supervisor-config';
import { decodeSolverSupervisorConfigBytes } from './solver-supervisor';

const BLUE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const GREEN = `registry.example/wbs-be@sha256:${'b'.repeat(64)}`;
const DEV = `registry.example/wbs-be@sha256:${'c'.repeat(64)}`;

const ARGS = {
  blueImage: BLUE,
  greenImage: GREEN,
  devSolverImage: DEV,
  devSourceSha: 'd'.repeat(40),
  output: '/work/supervisor.json',
  replace: false,
};

describe('solver supervisor config materialization', () => {
  it('renders the complete fixed-cap host document with all three callers', () => {
    const contents = renderSolverSupervisorConfig(ARGS);
    const parsed = JSON.parse(contents) as {
      socketPath: string;
      maxSearchWorkers: number;
      maxMemoryLimitMb: number;
      pidsLimit: number;
      maxManagedContainers: number;
      devSourceSha: string;
      images: { callerName: string; callerImage: string | null; solverImage: string }[];
    };
    expect(parsed).toEqual({
      socketPath: '/run/user/1000/wbs-solver/supervisor.sock',
      maxSearchWorkers: 2,
      maxMemoryLimitMb: 512,
      pidsLimit: 128,
      maxManagedContainers: 16,
      devSourceSha: 'd'.repeat(40),
      images: [
        { callerName: 'be-01-blue', callerImage: BLUE, solverImage: BLUE },
        { callerName: 'be-01-green', callerImage: GREEN, solverImage: GREEN },
        { callerName: 'wbs-dev-src', callerImage: null, solverImage: DEV },
      ],
    });
    expect(
      decodeSolverSupervisorConfigBytes(new TextEncoder().encode(contents)).imageFor({
        id: '1',
        name: 'wbs-dev-src',
        image: 'wbs-dev-src:1',
      }),
    ).toBe(DEV);
  });

  it('rejects tag-only images before writing output', async () => {
    const writes: string[] = [];
    const dependencies: SolverSupervisorConfigDependencies = {
      exists: () => Promise.resolve(false),
      write: (path) => {
        writes.push(path);
        return Promise.resolve();
      },
    };
    const error = await materializeSolverSupervisorConfig(
      { ...ARGS, devSolverImage: 'registry.example/wbs-be:latest' },
      dependencies,
    ).then(
      () => new Error('expected rejection'),
      (failure: unknown) => (failure instanceof Error ? failure : new Error(String(failure))),
    );
    expect(error.message).toContain('solverImage is not digest-pinned');
    expect(writes).toEqual([]);
  });

  it('refuses an existing output unless replacement is explicit', async () => {
    const writes: string[] = [];
    const dependencies: SolverSupervisorConfigDependencies = {
      exists: () => Promise.resolve(true),
      write: (path) => {
        writes.push(path);
        return Promise.resolve();
      },
    };
    const error = await materializeSolverSupervisorConfig(ARGS, dependencies).then(
      () => new Error('expected rejection'),
      (failure: unknown) => (failure instanceof Error ? failure : new Error(String(failure))),
    );
    expect(error.message).toContain('pass --replace');
    expect(writes).toEqual([]);
    await materializeSolverSupervisorConfig({ ...ARGS, replace: true }, dependencies);
    expect(writes).toEqual(['/work/supervisor.json']);
  });
});

describe('parseSolverSupervisorConfigArgs', () => {
  it('requires every explicit image and rejects duplicates or unknown options', () => {
    expect(
      parseSolverSupervisorConfigArgs([
        `--blue-image=${BLUE}`,
        `--green-image=${GREEN}`,
        `--dev-solver-image=${DEV}`,
        `--dev-source-sha=${'d'.repeat(40)}`,
        '--output=/work/supervisor.json',
        '--replace',
      ]),
    ).toEqual({ ...ARGS, replace: true });
    expect(() => parseSolverSupervisorConfigArgs(['--output=/work/config.json'])).toThrow(
      '--blue-image=',
    );
    expect(() =>
      parseSolverSupervisorConfigArgs([`--blue-image=${BLUE}`, `--blue-image=${BLUE}`]),
    ).toThrow('duplicate --blue-image');
    expect(() => parseSolverSupervisorConfigArgs(['--from-ambient-state'])).toThrow(
      'unexpected argument',
    );
  });
});
