import { ASSUMED_SLICE_WORKDAYS, type Slice, sliceKey, SOLVER_QUANTUM } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildSolverSlices, type LeafConstraintMaps } from './build-solver-slices';

const none: LeafConstraintMaps = { floors: new Map(), deadlines: new Map(), weights: new Map() };

const sliceOf = (over: Partial<Slice> = {}): Slice => ({
  workItemId: 'L1',
  stepId: null,
  days: 2,
  personId: null,
  width: 1,
  poolIds: [],
  ...over,
});

describe('buildSolverSlices', () => {
  it('projects one wire slice per canonical slice, in the order given', () => {
    const built = buildSolverSlices(
      [sliceOf({ workItemId: 'A' }), sliceOf({ workItemId: 'B' })],
      none,
    );
    expect(built.map((slice) => slice.key)).toEqual([sliceKey('A', null), sliceKey('B', null)]);
  });

  it('reads duration through durationUnits rather than multiplying here', () => {
    // Fast's exact rule: days / width, no snapWorkdays, then × quantum rounded
    // up. 1 day over width 5 is 0.2 workdays — 9.6 units — and the solver
    // cannot start the next slice at 9.6.
    expect(buildSolverSlices([sliceOf({ days: 1, width: 5 })], none)[0].durationUnits).toBe(10);
  });

  it('reads a null estimate as the assumed duration WITHOUT dividing by width', () => {
    // The arm the plan restated wrong twice. Nothing in the pre-existing domain
    // suite held it until 2.8's slice did.
    const built = buildSolverSlices([sliceOf({ days: null, width: 4 })], none);
    expect(built[0].durationUnits).toBe(ASSUMED_SLICE_WORKDAYS * SOLVER_QUANTUM);
  });

  it('emits poolIds as a sorted set, whatever the caller hands it', () => {
    const built = buildSolverSlices([sliceOf({ poolIds: ['z', 'a', 'z'] })], none);
    expect(built[0].poolIds).toEqual(['a', 'z']);
  });

  it('carries the folded floor on EVERY slice of the leaf, not just the first', () => {
    // schedule() puts it on the first slice alone and lets the intra-item chain
    // carry it. The wire's field is per-slice and defines itself as the fold,
    // so a zero on a later slice would be that slice claiming to be unfloored.
    const built = buildSolverSlices([sliceOf({ stepId: 's1' }), sliceOf({ stepId: 's2' })], {
      ...none,
      floors: new Map([['L1', 3]]),
    });
    expect(built.map((slice) => slice.notBeforeUnits)).toEqual([
      3 * SOLVER_QUANTUM,
      3 * SOLVER_QUANTUM,
    ]);
  });

  it('carries the effective deadline on every slice and null on unconstrained ones', () => {
    const built = buildSolverSlices(
      [sliceOf({ workItemId: 'L1' }), sliceOf({ workItemId: 'L2' })],
      { ...none, deadlines: new Map([['L1', 4]]) },
    );
    expect(built.map((slice) => slice.deadlineUnits)).toEqual([5 * SOLVER_QUANTUM, null]);
  });

  it('distinguishes a milestone work item from a zero step after real work', () => {
    const built = buildSolverSlices(
      [
        sliceOf({ workItemId: 'mixed', stepId: 'dev', days: 4 }),
        sliceOf({ workItemId: 'mixed', stepId: 'qa', days: 0 }),
        sliceOf({ workItemId: 'milestone', days: 0 }),
      ],
      none,
    );
    expect(built.map(({ workItemIsMilestone }) => workItemIsMilestone)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('reads an unprioritised leaf as weight 0, which is most leaves on most plans', () => {
    const built = buildSolverSlices(
      [sliceOf({ workItemId: 'L1' }), sliceOf({ workItemId: 'L2' })],
      {
        ...none,
        weights: new Map([['L1', 2]]),
      },
    );
    expect(built.map((slice) => slice.priorityWeight)).toEqual([2, 0]);
  });

  it('copies personId and width verbatim, including the unassigned case', () => {
    const built = buildSolverSlices([sliceOf({ personId: 'p1', width: 3 })], none);
    expect(built[0]).toMatchObject({ personId: 'p1', width: 3 });
    expect(buildSolverSlices([sliceOf()], none)[0].personId).toBeNull();
  });

  it('refuses a duplicated (workItemId, stepId) rather than letting it collide', () => {
    // Three maps on the wire are keyed by this string. A duplicate is one row
    // silently overwriting another in all three, and the re-validator would
    // then report the key-set mismatch as a solver fault.
    expect(() =>
      buildSolverSlices([sliceOf({ stepId: 's1' }), sliceOf({ stepId: 's1' })], none),
    ).toThrow(/duplicate slice for work item L1/);
  });

  it('refuses a fractional width, which nothing upstream catches', () => {
    // width 0 is already refused twice (groupByWorkItem, and durationUnits on
    // the non-finite duration). 1.5 is finite and would reach the schema's
    // `type: integer` as a malformed request the builder itself wrote.
    expect(() => buildSolverSlices([sliceOf({ width: 1.5 })], none)).toThrow(
      /not a whole number of people: 1.5/,
    );
  });
});
