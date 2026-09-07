import { describe, expect, it } from 'bun:test';

import { ASSUMED_SLICE_WORKDAYS } from './assumed-duration';
import { isOnTime } from './on-time';
import { durationOf, type Slice } from './schedule';
import { durationRoundedUp, durationUnits, SOLVER_QUANTUM } from './solver-quantum';

function slice(days: number | null, width: number): Slice {
  return { workItemId: 'w', stepId: null, days, personId: null, width, poolIds: [] };
}

describe('SOLVER_QUANTUM', () => {
  it('is 48 — a half-hour of an eight-hour day', () => {
    expect(SOLVER_QUANTUM).toBe(48);
  });
});

describe('durationUnits', () => {
  it('divides an estimate by width, and never divides the assumption', () => {
    // The two arms of `durationOf`, asserted end to end through the quantum
    // because the plan restated them and got both wrong: it divided the
    // assumption by `width` too, which would make a plan naming three people on
    // an unsized step a third as long as one naming one.
    expect(durationOf(slice(1, 2))).toBe(0.5);
    expect(durationUnits(slice(1, 2))).toBe(24);

    expect(durationOf(slice(null, 3))).toBe(ASSUMED_SLICE_WORKDAYS);
    expect(durationUnits(slice(null, 3))).toBe(ASSUMED_SLICE_WORKDAYS * SOLVER_QUANTUM);
    expect(durationUnits(slice(null, 3))).toBe(96);
  });

  it('rounds up a width the quantum does not divide, and says that it did', () => {
    // 1/5 of a workday is 9.6 units and the solver cannot start the next slice
    // at 9.6. Rounding down instead would hand back a schedule that overlaps a
    // pool the instant it is materialised.
    expect(durationUnits(slice(1, 5))).toBe(10);
    expect(durationRoundedUp(slice(1, 5))).toBe(true);
  });

  it('keeps an exact multiple exact even when the double overshoots it', () => {
    // `65 / 6` workdays over width 5 is exactly 13/6 days, exactly 104 units.
    // The double is 104.00000000000001, so a bare ceiling reads 105 and the
    // slice becomes a half-hour longer in the solver's model than in Fast's for
    // a reason nobody could find in the estimate.
    const drifted = slice(65 / 6, 5);
    expect(durationOf(drifted) * SOLVER_QUANTUM).not.toBe(104);
    expect(durationUnits(drifted)).toBe(104);
    expect(durationRoundedUp(drifted)).toBe(false);
  });

  it('never reports a duration below the real one, for every width 1 to 96', () => {
    // SOLVER_QUANTUM's feasibility argument in one assertion: quantisation may
    // cost optimality and may never cost validity, so no width may ever produce
    // fewer units than the real duration needs.
    for (let width = 1; width <= 96; width += 1) {
      const s = slice(65 / 6, width);
      expect(durationUnits(s)).toBeGreaterThanOrEqual(durationOf(s) * SOLVER_QUANTUM - 1e-9);
      expect(Number.isInteger(durationUnits(s))).toBe(true);
    }
  });

  it('gives zero units to an explicit zero, which is an answer and not a gap', () => {
    expect(durationUnits(slice(0, 4))).toBe(0);
    expect(durationRoundedUp(slice(0, 4))).toBe(false);
  });

  it('refuses a width the engine would have refused at its own door', () => {
    // `durationOf` was private until this change and the only route to it was
    // `groupByWorkItem`, which refuses `width < 1` for exactly this reason.
    // Publishing it put the solver outside that door, and `Math.ceil(Infinity)`
    // is `Infinity` — so without this guard a width of 0 reaches the wire as a
    // *duration*, and is diagnosed there as the builder's own request violating
    // the schema rather than as the width nobody refused.
    expect(() => durationUnits(slice(5, 0))).toThrow(/no finite duration/);
    expect(() => durationUnits(slice(5, -2))).toThrow(/no finite duration/);
    expect(() => durationRoundedUp(slice(5, 0))).toThrow(/no finite duration/);

    // A null estimate never divides, so it is finite at every width and stays
    // an answer rather than becoming an error.
    expect(durationUnits(slice(null, 0))).toBe(ASSUMED_SLICE_WORKDAYS * SOLVER_QUANTUM);
  });

  it('is 30 units for 2.11’s fixture where real Fast finishes at 28.8 — measured, not claimed', () => {
    // The number 2.11 turns on, pinned here before 2.11 is written so its
    // "quantised baseline, never real Fast" is starting from an established
    // gap rather than from a sentence in the plan.
    //
    // Three serial slices, each 1 day of effort over 5 people. Real Fast runs
    // each for 0.2 days, so the chain finishes at 0.6 days — 28.8 units, which
    // is not a number CP-SAT can hold. Rounded UP per slice it is 10 each, so
    // the quantised model needs 30. Taking stage 1's upper bound from real
    // Fast would therefore hand the solver a bound its own arithmetic cannot
    // meet, and the hint would be infeasible in the model it hints.
    const each = slice(1, 5);
    expect(durationOf(each)).toBeCloseTo(0.2, 12);
    expect(durationOf(each) * 3 * SOLVER_QUANTUM).toBeCloseTo(28.8, 9);
    expect(durationUnits(each)).toBe(10);
    expect(durationUnits(each) * 3).toBe(30);
    expect(durationRoundedUp(each)).toBe(true);
  });
});

describe('the drift window across the unit boundary', () => {
  // **WATCHED RED — TASK-302 AC #1.** Revert the inner `snapWorkdays` in
  // `quantise` (leave `snapWorkdays(durationOf(slice) * SOLVER_QUANTUM)`) and
  // the first case below fails on `durationUnits`: 49, not 48, while
  // `isOnTime` in the same assertion block still returns `true`. That is the
  // whole defect in one test — the two sides of the seam answering differently
  // about one slice — and it is the reviewer's own input, not a fixture chosen
  // to be convenient.

  it('reads a duration one drift above a whole workday the way the real-domain predicate does', () => {
    // Sol's exact input on TASK-241 PR 256: start 0, duration 1.0000000005
    // workdays, width 1, due day 0, so the exclusive bound is (0 + 1) x 48.
    const s = slice(1.0000000005, 1);
    expect(durationOf(s)).toBe(1.0000000005);

    // The workday side. `snapWorkdays` cleans 5.0e-10 of drift, so the slice
    // is still ON workday 0 and meets a day-0 deadline.
    expect(Math.abs(durationOf(s) - 1)).toBeLessThan(1e-9);
    expect(isOnTime(0, durationOf(s), 0)).toBe(true);

    // The unit side, which before this fix saw 2.4e-8 of drift — the same
    // number multiplied by 48, and so outside a window that was never scaled.
    expect(Math.abs(durationOf(s) * SOLVER_QUANTUM - 48)).toBeGreaterThan(1e-9);
    expect(durationUnits(s)).toBe(48);
    expect(durationRoundedUp(s)).toBe(false);

    // The model's clause verbatim: `startUnits + max(durationUnits, 1) <= deadlineUnits`.
    expect(0 + Math.max(durationUnits(s), 1)).toBeLessThanOrEqual(48);
  });

  it('still refuses a duration that is genuinely past the whole day, by one unit', () => {
    // The negative control the case above needs: a duration outside the drift
    // window must still cost a whole extra unit, or the fix would be "snap
    // everything" rather than "snap the same window on both sides".
    const s = slice(1.000001, 1);
    expect(isOnTime(0, durationOf(s), 0)).toBe(false);
    expect(durationUnits(s)).toBe(49);
    expect(durationRoundedUp(s)).toBe(true);
    expect(0 + Math.max(durationUnits(s), 1)).toBeGreaterThan(48);
  });

  it('leaves every duration that is not within the window of a whole workday exactly where it was', () => {
    // The blast radius, asserted rather than argued. The inner snap fires only
    // within `DRIFT` of a whole workday; everywhere else `quantise` is the
    // expression it always was, so these are the pre-fix numbers unchanged —
    // including the two widths that do not divide 48, which are what the
    // OUTER snap is for and why it stays.
    expect(durationUnits(slice(1, 2))).toBe(24);
    expect(durationUnits(slice(1, 3))).toBe(16);
    expect(durationUnits(slice(5, 3))).toBe(80);
    expect(durationUnits(slice(1, 5))).toBe(10);
    expect(durationUnits(slice(1, 7))).toBe(7);
    expect(durationUnits(slice(2.5, 1))).toBe(120);
    expect(durationUnits(slice(0, 4))).toBe(0);
  });

  it('moves only a duration drifted ABOVE a whole workday, because below one `ceil` already agreed', () => {
    // Which inputs this change can move, stated as a test so the answer is not
    // a paragraph. Under the window and BELOW the whole day, `d * 48` is under
    // `48W` and `ceil` returned `48W` before the fix too — so nothing moves.
    // Above it, `ceil` returned `48W + 1`, and that is the only shift.
    const below = slice(1 - 5e-10, 1);
    const above = slice(1 + 5e-10, 1);
    expect(durationUnits(below)).toBe(48);
    expect(durationUnits(above)).toBe(48);
    expect(isOnTime(0, durationOf(below), 0)).toBe(true);
    expect(isOnTime(0, durationOf(above), 0)).toBe(true);
  });
});
