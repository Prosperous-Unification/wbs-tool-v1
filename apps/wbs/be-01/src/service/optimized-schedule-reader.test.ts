import type { OptimizedResult } from '@wbs/contracts/solver/optimized-result';
import { describe, expect, it } from 'bun:test';

import type { CachedOutcome } from '../repository/optimized-schedule-cache';
import { optimizationVariantState } from './optimized-schedule-reader';

const STORED = { generation: 4, createdAt: 12 } as const;

function result(
  publication: OptimizedResult['publication'],
  statuses: readonly [
    'optimal' | 'feasible' | 'unknown',
    'optimal' | 'feasible' | 'unknown',
    'optimal' | 'feasible' | 'unknown',
  ],
): OptimizedResult {
  const term = (status: 'optimal' | 'feasible' | 'unknown') => ({
    value: 0,
    stageValue: 0,
    bound: 0,
    status,
  });
  return {
    publication,
    objectiveValues: {
      makespan: term(statuses[0]),
      priority: term(statuses[1]),
      movement: term(statuses[2]),
    },
    schedule: null as never,
  };
}

describe('optimizationVariantState', () => {
  it('distinguishes a cold miss from queued or running work', () => {
    const miss: CachedOutcome = { kind: 'miss' };
    expect(optimizationVariantState(miss, false)).toEqual({ state: 'idle' });
    expect(optimizationVariantState(miss, true)).toEqual({ state: 'pending' });
  });

  it('distinguishes terminal failures from a live retry', () => {
    const failed: CachedOutcome = { kind: 'failed', reason: 'timeout', ...STORED };
    const corrupt: CachedOutcome = { kind: 'corrupt', reason: 'bad payload', ...STORED };
    expect(optimizationVariantState(failed, false)).toEqual({
      state: 'failed',
      reason: 'timeout',
    });
    expect(optimizationVariantState(corrupt, false)).toEqual({
      state: 'corrupt',
      message: 'bad payload',
    });
    expect(optimizationVariantState(failed, true)).toEqual({ state: 'retrying' });
    expect(optimizationVariantState(corrupt, true)).toEqual({ state: 'retrying' });
  });

  it('reports a solver result as proven only when every objective term is optimal', () => {
    const ready = {
      kind: 'ok',
      result: result('solver', ['optimal', 'optimal', 'optimal']),
      ...STORED,
    } satisfies CachedOutcome;
    const stopped = {
      ...ready,
      result: result('solver', ['optimal', 'feasible', 'unknown']),
    } satisfies CachedOutcome;
    expect(optimizationVariantState(ready, false)).toEqual({
      state: 'ready',
      proof: 'proven',
    });
    expect(optimizationVariantState(stopped, false)).toEqual({
      state: 'ready',
      proof: 'incomplete',
    });
  });

  it('keeps a quantisation-floor publication distinct from an unfinished search', () => {
    const floor = {
      kind: 'ok',
      result: result('quantisation-floor', ['unknown', 'unknown', 'unknown']),
      ...STORED,
    } satisfies CachedOutcome;
    expect(optimizationVariantState(floor, false)).toEqual({
      state: 'ready',
      proof: 'quantisation-floor',
    });
  });

  it('reports plan-infeasible rows independently of liveness', () => {
    const items = [
      { ownerWorkItemId: 'parent', boundWorkItemId: 'child', effectiveDeadlineOffset: 10 },
    ];
    const infeasible: CachedOutcome = {
      kind: 'plan-infeasible',
      certificate: { items },
      ...STORED,
    };
    expect(optimizationVariantState(infeasible, false)).toEqual({
      state: 'plan-infeasible',
      items,
    });
  });
});
