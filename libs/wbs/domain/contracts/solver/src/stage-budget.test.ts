import { describe, expect, it } from 'bun:test';

import { isValidStageBudgetSplit, STAGE_BUDGET_SPLIT } from './stage-budget';
import { SOLVER_STAGE_COUNT } from './wire-types';

describe('STAGE_BUDGET_SPLIT', () => {
  it('is the approved split and has one share per stage', () => {
    expect(STAGE_BUDGET_SPLIT).toEqual([0.6, 0.25, 0.15]);
    expect(STAGE_BUDGET_SPLIT).toHaveLength(SOLVER_STAGE_COUNT);
  });

  it('satisfies its own invariant', () => {
    expect(isValidStageBudgetSplit(STAGE_BUDGET_SPLIT)).toBe(true);
  });

  it('does sum to exactly 1 in doubles — the tolerance is not for THIS split', () => {
    // Written the other way first, and the gate said otherwise. Kept as an
    // assertion so the next reader does not re-guess it: the constant is exact,
    // and the tolerance below exists for the splits that are not.
    expect(0.6 + 0.25 + 0.15).toBe(1);
  });
});

describe('isValidStageBudgetSplit', () => {
  it('accepts an authored split that sums to 1', () => {
    expect(isValidStageBudgetSplit([0.5, 0.3, 0.2])).toBe(true);
  });

  it('accepts a split whose sum drifts, and is not decided by share ORDER', () => {
    // The case the tolerance is actually for: `0.7 + 0.2 + 0.1` is
    // 0.9999999999999999 while `0.1 + 0.2 + 0.7` is exactly 1. An exact
    // comparison would accept or refuse one authored split depending on the
    // order its shares were written in.
    expect(0.7 + 0.2 + 0.1).not.toBe(1);
    expect(isValidStageBudgetSplit([0.7, 0.2, 0.1])).toBe(true);
    expect(isValidStageBudgetSplit([0.1, 0.2, 0.7])).toBe(true);
  });

  it('refuses a split that does not add up', () => {
    expect(isValidStageBudgetSplit([0.5, 0.3, 0.3])).toBe(false);
    expect(isValidStageBudgetSplit([0.5, 0.3, 0.1])).toBe(false);
  });

  it('refuses the wrong number of stages', () => {
    expect(isValidStageBudgetSplit([0.5, 0.5])).toBe(false);
    expect(isValidStageBudgetSplit([0.25, 0.25, 0.25, 0.25])).toBe(false);
  });

  it('refuses a zero share — a stage with no budget cannot run', () => {
    // Matches the schema's `exclusiveMinimum`. Expressing "skip stage 3" as a
    // zero would make the staged matrix read a timeout where a deliberate
    // omission was meant.
    expect(isValidStageBudgetSplit([0.6, 0.4, 0])).toBe(false);
  });

  it('refuses a negative share even when the three still sum to 1', () => {
    expect(isValidStageBudgetSplit([1.2, 0.3, -0.5])).toBe(false);
  });

  it('refuses NaN, which no arithmetic comparison catches on its own', () => {
    expect(isValidStageBudgetSplit([Number.NaN, 0.5, 0.5])).toBe(false);
  });
});
