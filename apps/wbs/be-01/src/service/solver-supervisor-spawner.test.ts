import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import type { ReservedSpawnRequest } from './optimization-coordinator';
import { buildSolverRequestPair } from './solver-request-pair';
import type { SolverSupervisorRequest } from './solver-supervisor-client';
import { solverSupervisorSpawner } from './solver-supervisor-spawner';

const INPUT: ScheduleInput = {
  rows: [{ id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: null }],
  edges: [],
  slices: [
    {
      workItemId: 'w-1',
      stepId: 's-1',
      days: 1,
      personId: null,
      width: 1,
      poolIds: [],
    },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

describe('solverSupervisorSpawner', () => {
  it('sends only the reserved attempt and exposes authenticated terminal evidence', async () => {
    const built = buildSolverRequestPair(INPUT, '0.1.0', 60_000).pri;
    if (!built.ok) throw new Error('fixture request did not pass preflight');
    const request: ReservedSpawnRequest = {
      key: {
        projectId: '11111111-1111-4111-8111-111111111111',
        inputHash: 'input-hash',
        contractVersion: '7+0.1.0',
        budgetMs: 60_000,
      },
      objective: 'pri',
      generation: 7,
      admission: {
        kind: 'reserved',
        attemptToken: '22222222-2222-4222-8222-222222222222',
        admittedCancelEpoch: 3,
        childDeadlineAt: 70_000,
        admittedDeadlineAt: 85_000,
      },
      request: { ...built.request },
      input: INPUT,
    };
    const stdout = new ReadableStream<Uint8Array>();
    const stderr = new ReadableStream<Uint8Array>();
    const terminal = Promise.resolve({
      type: 'terminal' as const,
      exitCode: 0,
      deadlineKilled: false,
      oomKilled: false,
    });
    const controls: string[] = [];
    let captured: SolverSupervisorRequest | undefined;
    const spawn = solverSupervisorSpawner({
      unix: '/run/wbs-solver/supervisor.sock',
      callerId: 'a'.repeat(12),
      searchWorkers: 2,
      memoryLimitMb: 512,
      connect: (wire) => {
        captured = wire;
        return Promise.resolve({
          pid: 4321,
          stdout,
          stderr,
          terminal,
          verdict: (value) => {
            controls.push(value);
            return Promise.resolve();
          },
          kill: () => {
            controls.push('kill');
            return Promise.resolve();
          },
        });
      },
    });

    const child = await spawn(request);
    expect(captured).toEqual({
      unix: '/run/wbs-solver/supervisor.sock',
      callerId: 'aaaaaaaaaaaa',
      projectId: request.key.projectId,
      objective: 'pri',
      attemptToken: request.admission.attemptToken,
      childDeadlineAt: request.admission.childDeadlineAt,
      searchWorkers: 2,
      memoryLimitMb: 512,
      request: { ...built.request },
    });
    expect(child.pid).toBe(4321);
    expect(child.stdout).toBe(stdout);
    expect(child.stderr).toBe(stderr);
    expect(child.terminal).toBe(terminal);
    expect(await child.exited).toBe(0);
    await child.verdict('bound');
    await child.kill();
    expect(controls).toEqual(['bound', 'kill']);
  });
});
