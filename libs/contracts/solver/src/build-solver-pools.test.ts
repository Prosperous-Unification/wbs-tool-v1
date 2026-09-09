import { describe, expect, it } from 'bun:test';

import { buildSolverPools, poolIdsNamedBy } from './build-solver-pools';
import type { SolverSlice } from './wire-types';

const sliceOf = (poolIds: readonly string[]): SolverSlice => ({
  workItemKey: 'work',
  key: `k${poolIds.join('')}`,
  durationUnits: 48,
  width: 1,
  personId: null,
  poolIds,
  priorityWeight: 0,
  notBeforeUnits: 0,
  deadlineUnits: null,
  workItemIsMilestone: false,
});

describe('poolIdsNamedBy', () => {
  it('collects every pool any slice names, once', () => {
    expect([...poolIdsNamedBy([sliceOf(['a', 'b']), sliceOf(['b', 'c'])])].sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('is empty for a plan that names no sized team, which is most plans', () => {
    expect(poolIdsNamedBy([sliceOf([])]).size).toBe(0);
  });
});

describe('buildSolverPools', () => {
  it('emits only the pools the request names, not every size the project holds', () => {
    // A size for a team no slice is labelled with constrains nothing, and the
    // request is hashed as a cache key — so shipping it would invalidate a
    // cached result on an edit to a team this plan does not use.
    const pools = buildSolverPools(
      [sliceOf(['a'])],
      new Map([
        ['a', 2],
        ['unused', 9],
      ]),
    );
    expect(pools).toEqual({ a: 2 });
  });

  it('is an empty object when no slice names a pool', () => {
    expect(buildSolverPools([sliceOf([])], new Map([['a', 2]]))).toEqual({});
  });

  it('refuses a named pool with no size, pre-spawn', () => {
    // schedule.ts's `no size for pool` throw, promoted to the wire. A default
    // here would be a capacity constraint silently not applied: the solver
    // would place the slice unconstrained, and the re-validator would reject
    // the solver's own answer as if the solver were at fault.
    expect(() => buildSolverPools([sliceOf(['a'])], new Map())).toThrow(/no size for pool a/);
  });

  it('refuses a zero-slot pool rather than clamping it to one', () => {
    // A pool of 0 slots is a plan of Infinity dates, and the column's floor is
    // enforced at be-01's boundary — so a zero here means two readings came
    // apart. Clamping would invent a slot nobody has.
    expect(() => buildSolverPools([sliceOf(['a'])], new Map([['a', 0]]))).toThrow(
      /pool a has a size that is not a whole number of slots: 0/,
    );
  });

  it('refuses a fractional size', () => {
    expect(() => buildSolverPools([sliceOf(['a'])], new Map([['a', 1.5]]))).toThrow(
      /not a whole number of slots: 1.5/,
    );
  });
});
