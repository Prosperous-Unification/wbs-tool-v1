import { leafDeadlinesOf, leafFloorsOf, SOLVER_QUANTUM } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { deadlineUnitsOf, notBeforeUnitsOf } from './solver-units';

describe('notBeforeUnitsOf', () => {
  it('converts a whole workday into units', () => {
    expect(notBeforeUnitsOf(new Map([['L1', 3]]), 'L1')).toBe(3 * SOLVER_QUANTUM);
  });

  it('reads an absent leaf as day zero, which is what unconstrained means', () => {
    expect(notBeforeUnitsOf(new Map(), 'L1')).toBe(0);
  });

  it('does NOT add a day — a floor bounds a start, not a finish', () => {
    // The asymmetry with `deadlineUnitsOf` is the point of testing this at all.
    // Day N begins at unit N × quantum; nothing is inclusive about it.
    expect(notBeforeUnitsOf(new Map([['L1', 1]]), 'L1')).toBe(SOLVER_QUANTUM);
  });
});

describe('deadlineUnitsOf', () => {
  it('converts day D to (D + 1) × quantum, an EXCLUSIVE finish bound', () => {
    // "Due on day 2" is satisfied by work running to the end of day 2, and the
    // last instant of day 2 is the first instant of day 3. Dropping the `+ 1`
    // would require finishing by the START of the due day and lose a whole
    // workday on every deadline in the plan.
    expect(deadlineUnitsOf(new Map([['L1', 2]]), 'L1')).toBe(3 * SOLVER_QUANTUM);
  });

  it('gives a day-zero deadline a whole day of room, not none', () => {
    // The case a missing `+ 1` makes trivially infeasible rather than merely
    // tight: a one-day task due the day it starts.
    expect(deadlineUnitsOf(new Map([['L1', 0]]), 'L1')).toBe(SOLVER_QUANTUM);
  });

  it('is null for a leaf no deadline reaches, never a sentinel', () => {
    expect(deadlineUnitsOf(new Map(), 'L1')).toBeNull();
    expect(deadlineUnitsOf(new Map([['L2', 4]]), 'L1')).toBeNull();
  });
});

describe('the @wbs/domain edge', () => {
  it('reads the folds and the quantum through the package alias', () => {
    // libs/contracts had NO @wbs/domain import before 2026-09-03. This asserts
    // the edge actually resolves under the contracts test target's own cwd
    // (`libs/contracts`), which is a different question from whether `tsc`
    // accepts it — and it is the assertion that fails first if the alias is
    // ever dropped from `tsconfig.base.json`.
    const index = {
      leavesUnder: new Map<string, readonly string[]>([
        ['P', ['L1', 'L2']],
        ['L1', ['L1']],
        ['L2', ['L2']],
      ]),
    };
    const floors = leafFloorsOf(new Map([['P', 2]]), index);
    const deadlines = leafDeadlinesOf(new Map([['P', 9]]), index);

    expect(notBeforeUnitsOf(floors, 'L1')).toBe(2 * SOLVER_QUANTUM);
    expect(deadlineUnitsOf(deadlines, 'L2')).toBe(10 * SOLVER_QUANTUM);
  });
});
