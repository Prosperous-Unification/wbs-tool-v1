import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { buildSolverRequestPair } from './solver-request-pair';

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

describe('buildSolverRequestPair', () => {
  it('builds both objectives over one quantised Fast baseline', () => {
    const pair = buildSolverRequestPair(INPUT, '0.1.0', 60_000);
    if (!pair.pri.ok || !pair.time.ok) throw new Error('expected two solver requests');

    expect(pair.pri.request.objective).toBe('pri');
    expect(pair.time.request.objective).toBe('time');
    expect(pair.pri.request.baselineOffsets).toBe(pair.time.request.baselineOffsets);
    expect(pair.pri.request.fastHint).toBe(pair.time.request.fastHint);
    expect({ ...pair.pri.request, objective: 'time' }).toEqual(pair.time.request);
  });

  it('returns both preflight refusals without manufacturing a request', () => {
    const tooLate: ScheduleInput = {
      ...INPUT,
      notBefore: new Map([['w-1', 50_000_000]]),
    };

    const pair = buildSolverRequestPair(tooLate, '0.1.0', 60_000);
    expect(pair.pri).toMatchObject({ ok: false, failure: 'horizon-overflow' });
    expect(pair.time).toMatchObject({ ok: false, failure: 'horizon-overflow' });
  });
});
