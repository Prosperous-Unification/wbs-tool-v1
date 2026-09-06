import { describe, expect, it } from 'bun:test';

import { decodeSolverSupervisorConfig } from './solver-supervisor-config';

const BLUE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const SOLVER = `registry.example/wbs-solver@sha256:${'b'.repeat(64)}`;
const CONFIG = {
  socketPath: '/run/user/1000/wbs-solver/supervisor.sock',
  maxSearchWorkers: 2,
  maxMemoryLimitMb: 512,
  pidsLimit: 128,
  maxManagedContainers: 16,
  devSourceSha: 'd'.repeat(40),
  images: [{ callerName: 'be-01-blue', callerImage: BLUE, solverImage: SOLVER }],
};

describe('the solver supervisor host config', () => {
  it('builds the bounded runtime options and exact image policy', () => {
    const now = () => 12_345;
    const decoded = decodeSolverSupervisorConfig(CONFIG, now);
    expect(decoded.connection).toEqual({
      unix: CONFIG.socketPath,
      allowedNamePatterns: [/^be-01-blue$/],
      maxInputBytes: 2 * 1024 * 1024,
      bindTimeoutMs: 5_000,
      maxSearchWorkers: 2,
      maxMemoryLimitMb: 512,
      now,
    });
    expect(decoded.lifecycle).toEqual({
      pidsLimit: 128,
      maxManagedContainers: 16,
      outputLimits: {
        maxPayloadBytes: 64 * 1024,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
    });
    expect(decoded.imageFor({ id: '1', name: 'be-01-blue', image: BLUE })).toBe(SOLVER);
  });

  it('refuses paths outside the service runtime directory and excess host caps', () => {
    expect(() =>
      decodeSolverSupervisorConfig({ ...CONFIG, socketPath: '/tmp/supervisor.sock' }),
    ).toThrow(/runtime-directory/);
    for (const [key, value] of [
      ['maxSearchWorkers', 3],
      ['maxMemoryLimitMb', 513],
      ['pidsLimit', 129],
      ['maxManagedContainers', 17],
    ] as const) {
      expect(() => decodeSolverSupervisorConfig({ ...CONFIG, [key]: value })).toThrow(
        new RegExp(key),
      );
    }
  });

  it('rejects missing, unknown, fractional, and embedded-authority fields', () => {
    const missing = {
      socketPath: CONFIG.socketPath,
      maxSearchWorkers: CONFIG.maxSearchWorkers,
      maxMemoryLimitMb: CONFIG.maxMemoryLimitMb,
      pidsLimit: CONFIG.pidsLimit,
      maxManagedContainers: CONFIG.maxManagedContainers,
      devSourceSha: CONFIG.devSourceSha,
    };
    expect(() => decodeSolverSupervisorConfig(missing)).toThrow(/missing key images/);
    expect(() =>
      decodeSolverSupervisorConfig({ ...CONFIG, dockerSocket: '/var/run/docker.sock' }),
    ).toThrow(/unknown key dockerSocket/);
    expect(() => decodeSolverSupervisorConfig({ ...CONFIG, pidsLimit: 1.5 })).toThrow(/pidsLimit/);
    expect(() => decodeSolverSupervisorConfig({ ...CONFIG, devSourceSha: 'main' })).toThrow(
      /full lowercase commit SHA/,
    );
    expect(() =>
      decodeSolverSupervisorConfig({
        ...CONFIG,
        images: [{ ...CONFIG.images[0], network: 'host' }],
      }),
    ).toThrow(/unknown key network/);
  });
});
