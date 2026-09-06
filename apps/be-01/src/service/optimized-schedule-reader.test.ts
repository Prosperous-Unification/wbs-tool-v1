import { describe, expect, it } from 'bun:test';

import type { CachedOutcome } from '../repository/optimized-schedule-cache';
import { optimizationVariantState } from './optimized-schedule-reader';

const STORED = { generation: 4, createdAt: 12 } as const;

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

  it('reports ready and plan-infeasible rows independently of liveness', () => {
    const ready = {
      kind: 'ok',
      // This mapper reads only the row discriminant; cache decoding owns the
      // result payload and has its own round-trip suite.
      result: null as never,
      ...STORED,
    } satisfies CachedOutcome;
    const items = [
      { ownerWorkItemId: 'parent', boundWorkItemId: 'child', effectiveDeadlineOffset: 10 },
    ];
    const infeasible: CachedOutcome = {
      kind: 'plan-infeasible',
      certificate: { items },
      ...STORED,
    };
    expect(optimizationVariantState(ready, false)).toEqual({ state: 'ready' });
    expect(optimizationVariantState(infeasible, false)).toEqual({
      state: 'plan-infeasible',
      items,
    });
  });
});
