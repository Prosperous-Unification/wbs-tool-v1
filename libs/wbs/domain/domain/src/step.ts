/**
 * The gap between two consecutive steps' positions.
 *
 * Ten, like a work item's, and for the same reason: a step can be put between
 * two others without rewriting either.
 */
export const STEP_POSITION_STEP = 10;

/** What a step holds, counted for that step alone. */
export interface StepHoldings {
  estimates: number;
  actuals: number;
  progress: number;
  measures: number;
  assignments: number;
}

/**
 * Whether removing this step would take a statement with it.
 *
 * **One function because there are two callers and they had drifted.**
 * `StepService.remove` refuses early so a reader is asked to confirm before a
 * transaction opens, and the source transaction refuses again because the early
 * answer can be stale by the time the deletes would run. Those are two moments,
 * deliberately — but they are one rule, and the early one had been written as
 * `estimates > 0 || assignments > 0`. A step holding only recorded days, or only
 * progress, or only measures was let through the gate and refused by the
 * transaction instead, so a reader saw a generic failure where they were owed
 * the "this would take N statements" confirmation. {@link StepUsageRows.actuals}
 * argues at length that exactly that case must refuse.
 *
 * Proof: with the `actuals` term dropped, `refuses a step holding only recorded
 * days at the gate, before a transaction opens` fails on
 * `expect(received).toMatchObject(expected) · - "ok": false · + "ok": true` —
 * both callers ask this function, so a missing term deletes the step rather
 * than merely letting it past the gate (2026-09-02).
 */
export function stepIsInUse(held: StepHoldings): boolean {
  return (
    held.estimates > 0 ||
    held.actuals > 0 ||
    held.progress > 0 ||
    held.measures > 0 ||
    held.assignments > 0
  );
}
