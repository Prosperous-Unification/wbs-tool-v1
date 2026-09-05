import { buildSolverRequest } from '@wbs/contracts/solver/build-request';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { evaluateSolverOutcome } from './solver-exit-outcome';

const INPUT: ScheduleInput = {
  rows: [{ id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: 2 }],
  edges: [],
  slices: [
    {
      workItemId: 'w-1',
      stepId: 'dev',
      days: 2,
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

const built = buildSolverRequest(INPUT, 'pri', {
  baselineOffsets: { 'w-1\u0000dev': 0 },
  solverVersion: '0.1.0',
  budgetMs: 60_000,
});
if (!built.ok) throw new Error('fixture request refused');
const REQUEST = built.request;

const DEADLINED_INPUT: ScheduleInput = {
  ...INPUT,
  deadlines: new Map([['w-1', 0]]),
};
const deadlined = buildSolverRequest(DEADLINED_INPUT, 'pri', {
  baselineOffsets: { 'w-1\u0000dev': 0 },
  solverVersion: '0.1.0',
  budgetMs: 60_000,
});
if (!deadlined.ok) throw new Error('fixture deadline request refused');

const response = (offset = 0, reportedOffset = offset): string =>
  `${JSON.stringify({
    wireVersion: 1,
    status: 'feasible',
    offsets: { 'w-1\u0000dev': offset },
    objectiveValues: {
      makespan: {
        value: 96 + reportedOffset,
        stageValue: 96 + reportedOffset,
        bound: 96,
        status: 'optimal',
      },
      priority: {
        value: 96 + reportedOffset,
        stageValue: 96 + reportedOffset,
        bound: 96,
        status: 'optimal',
      },
      movement: {
        value: reportedOffset,
        stageValue: reportedOffset,
        bound: 0,
        status: 'optimal',
      },
    },
  })}\n`;

describe('evaluateSolverOutcome', () => {
  it('revalidates, materialises and keeps a feasible solver result', () => {
    const outcome = evaluateSolverOutcome(INPUT, REQUEST, {
      kind: 'response',
      stdout: response(),
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.publication).toBe('solver');
    expect(outcome.result.schedule.slices.get('w-1\u0000dev')?.earliestFinish).toBe(2);
  });

  it('maps framing and revalidation defects to invalid-output', () => {
    expect(evaluateSolverOutcome(INPUT, REQUEST, { kind: 'response', stdout: 'not json' })).toEqual(
      { kind: 'failed', reason: 'invalid-output' },
    );
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, { kind: 'response', stdout: response(1, 0) }),
    ).toEqual({ kind: 'failed', reason: 'invalid-output' });
    expect(
      evaluateSolverOutcome(DEADLINED_INPUT, deadlined.request, {
        kind: 'response',
        stdout: response(),
      }),
    ).toEqual({ kind: 'failed', reason: 'invalid-output' });
  });

  it('keeps classified process failures and distinguishes solver no-answer states', () => {
    expect(evaluateSolverOutcome(INPUT, REQUEST, { kind: 'failed', reason: 'oom' })).toEqual({
      kind: 'failed',
      reason: 'oom',
    });
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"unknown"}\n',
      }),
    ).toEqual({ kind: 'failed', reason: 'no-solution' });
    expect(
      evaluateSolverOutcome(INPUT, REQUEST, {
        kind: 'response',
        stdout: '{"wireVersion":1,"status":"infeasible"}\n',
      }),
    ).toEqual({ kind: 'plan-infeasible' });
  });
});
