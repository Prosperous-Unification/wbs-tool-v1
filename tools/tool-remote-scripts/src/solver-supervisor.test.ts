import { describe, expect, it } from 'bun:test';

import {
  decodeSolverSupervisorConfigBytes,
  parseSolverSupervisorArgs,
  runSolverSupervisor,
  SUPERVISOR_CONFIG_MAX_BYTES,
} from './solver-supervisor';

const BLUE = `registry.example/wbs-be@sha256:${'a'.repeat(64)}`;
const SOLVER = `registry.example/wbs-solver@sha256:${'b'.repeat(64)}`;
const CONFIG = {
  socketPath: '/run/user/1000/wbs-solver/supervisor.sock',
  maxSearchWorkers: 2,
  maxMemoryLimitMb: 512,
  pidsLimit: 128,
  maxManagedContainers: 16,
  images: [{ callerName: 'be-01-blue', callerImage: BLUE, solverImage: SOLVER }],
};

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('the solver supervisor executable', () => {
  it('accepts only one bounded absolute config argument', () => {
    expect(parseSolverSupervisorArgs(['--config=/etc/wbs/supervisor.json'])).toBe(
      '/etc/wbs/supervisor.json',
    );
    expect(() => parseSolverSupervisorArgs([])).toThrow(/exactly/);
    expect(() => parseSolverSupervisorArgs(['--config=relative.json'])).toThrow(/absolute/);
    expect(() => parseSolverSupervisorArgs(['--config=/a', '--verbose'])).toThrow(/exactly/);
  });

  it('bounds bytes and rejects malformed text before decoding authority', () => {
    expect(decodeSolverSupervisorConfigBytes(encoded(CONFIG)).connection.unix).toBe(
      CONFIG.socketPath,
    );
    expect(() => decodeSolverSupervisorConfigBytes(new Uint8Array())).toThrow(/1 through/);
    expect(() =>
      decodeSolverSupervisorConfigBytes(new Uint8Array(SUPERVISOR_CONFIG_MAX_BYTES + 1)),
    ).toThrow(/1 through/);
    expect(() => decodeSolverSupervisorConfigBytes(new Uint8Array([255]))).toThrow(/UTF-8/);
    expect(() => decodeSolverSupervisorConfigBytes(new TextEncoder().encode('{'))).toThrow(/JSON/);
  });

  it('decodes before start and reports connection errors without logging config', async () => {
    const events: string[] = [];
    await runSolverSupervisor(['--config=/etc/wbs/supervisor.json'], {
      read: (path) => {
        events.push(`read:${path}`);
        return Promise.resolve(encoded(CONFIG));
      },
      start: (options) => {
        events.push(`start:${options.connection.unix}`);
        options.connection.onConnectionError?.(new Error('peer rejected'));
        return Promise.resolve();
      },
      connectionError: (error) => {
        events.push(`error:${error.message}`);
      },
    });

    expect(events).toEqual([
      'read:/etc/wbs/supervisor.json',
      `start:${CONFIG.socketPath}`,
      'error:peer rejected',
    ]);
    expect(events.join('\n')).not.toContain(BLUE);
    expect(events.join('\n')).not.toContain(SOLVER);
  });
});
