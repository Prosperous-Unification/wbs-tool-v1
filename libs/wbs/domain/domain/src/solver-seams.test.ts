import { describe, expect, it } from 'bun:test';

import * as domain from './index';

/**
 * The symbols `libs/contracts/solver` imports from this library, asserted on the
 * **barrel** rather than on their own modules.
 *
 * Slice 2.0 of the dual-optimized-scheduler change exists because a plan can
 * name a seam that does not exist: `priorityByLeaf` was declared `function`
 * rather than `export function`, `index.ts` re-exports only what `schedule.ts`
 * exports, and the request builder that was ordered to import it could not have
 * been written. That failure is invisible from inside `schedule.ts` — the
 * symbol is right there and its own tests pass — so the assertion has to be
 * made from where the consumer stands.
 *
 * Cross-package, so it is deliberately a shape check and nothing more. What
 * each function *decides* is tested beside it (`schedule-priority.test.ts`,
 * `solver-quantum.test.ts`); what this file holds is that the decision is
 * reachable, which is the property that broke.
 */
describe('the solver seams libs/domain publishes', () => {
  it('publishes the priority resolver the request builder weights', () => {
    expect(typeof domain.priorityByLeaf).toBe('function');
  });

  it('publishes the duration rule, so nothing downstream restates it', () => {
    expect(typeof domain.durationOf).toBe('function');
  });

  it('publishes the quantum and its two readings', () => {
    expect(domain.SOLVER_QUANTUM).toBe(48);
    expect(typeof domain.durationUnits).toBe('function');
    expect(typeof domain.durationRoundedUp).toBe('function');
  });

  it('publishes the two leaf-upward folds every wire slice carries already folded', () => {
    expect(typeof domain.leafFloorsOf).toBe('function');
    expect(typeof domain.leafDeadlinesOf).toBe('function');
  });

  it('publishes the dense-rank weight and the absent leaf’s reading of it', () => {
    expect(typeof domain.priorityWeights).toBe('function');
    expect(typeof domain.priorityWeightOf).toBe('function');
  });

  it('publishes the slice graph — the chain, the join, and the reach that decides it', () => {
    // `sliceGraphEdges` moved out of `schedule()` in run 8 precisely so
    // `buildSolverEdges` could import it rather than restate it. Moving a
    // function out of a file it was exported from is exactly the edit that
    // silently drops it from the barrel, which `tsc` and every test inside
    // this library would still call green.
    expect(typeof domain.sliceGraphEdges).toBe('function');
    expect(typeof domain.reachedSliceOf).toBe('function');
    expect(typeof domain.expandToLeaves).toBe('function');
    expect(typeof domain.sliceKey).toBe('function');
  });

  it('publishes the one grouping both projections start from', () => {
    // A position on an edge is meaningless against a different grouping, so
    // the builder must reach THIS one.
    expect(typeof domain.groupSlicesByLeaf).toBe('function');
  });
});
