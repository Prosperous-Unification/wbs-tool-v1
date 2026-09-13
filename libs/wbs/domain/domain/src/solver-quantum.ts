import { durationOf, type Slice } from './schedule';
import { snapWorkdays } from './workday';

/**
 * How many integer units the solver's time axis cuts one workday into.
 *
 * CP-SAT places integers. Fast places doubles — `days / width` for every legal
 * width 1–1000 over an arbitrary finite non-negative estimate — so no
 * denominator makes every duration exact and quantisation is a lossy step with
 * a policy rather than a conversion. 48 is a half-hour on an eight-hour day and
 * divides by 2, 3, 4, 6, 8, 12, 16 and 24, which covers every width a plan
 * actually uses; the widths outside that set are the ones {@link durationUnits}
 * rounds.
 *
 * **The direction of the rounding is the whole of its correctness.** Every
 * quantised duration is at or above its real duration and every start is an
 * exact unit multiple, so any schedule feasible in the quantised model is
 * feasible in the real one — no predecessor, floor, assignee or pool constraint
 * can be broken by dividing the offsets back down and materialising them.
 * Quantisation therefore costs optimality and never validity. Rounding down
 * would invert that: the solver would hand back a plan that overlaps a pool the
 * moment it was materialised, and the re-validator would reject the solver's
 * own answer.
 *
 * Covered by `SCHEDULER_CONTRACT_VERSION`, because changing it changes every
 * cached result's meaning and not just its precision.
 */
export const SOLVER_QUANTUM = 48;

/**
 * One slice's duration on the solver's integer axis.
 *
 * `durationOf(slice) × SOLVER_QUANTUM`, **snapped to an exact multiple first
 * and rounded up only if it is genuinely not one.** Both halves are load
 * bearing and they guard opposite directions:
 *
 * - The ceiling is what makes a width outside 48's divisors legal at all. Three
 *   serial slices at `days: 1, width: 5` are 0.2 workdays each, 9.6 units, and
 *   the solver cannot start the second at 9.6.
 * - The snap is what stops the ceiling inventing a unit out of floating-point
 *   residue. `days: 65/6, width: 5` is exactly 13/6 workdays, which is exactly
 *   104 units — but the double arrives as `104.00000000000001`, and a bare
 *   ceiling reads that as 105. That slice would then be a half-hour longer in
 *   the solver's model than in Fast's for no reason anybody could find in the
 *   estimate, and two estimates that are equal as real numbers would quantise
 *   differently depending on which arithmetic produced them.
 *
 * The window is {@link snapWorkdays}' own, which is the point: the drift here is
 * the same accumulated-division drift that function exists for, so borrowing it
 * keeps one 1e-9 window in the domain instead of two that agree until one is
 * edited.
 *
 * **It is applied TWICE, in two different spaces, and this paragraph said the
 * opposite until 2026-09-07.** Before PR 281 it ran only after the
 * multiplication, and this text defended that as deliberate — but the same 1e-9
 * constant is a window `SOLVER_QUANTUM` times narrower once its argument is
 * units, so a duration `lastWorkdayOf` reads as a whole day could fail to snap
 * here and cost an extra unit. PR 281 (`c1d9a40d`, TASK-302) added the snap in
 * WORKDAY space before the multiplication; the one after it stays, because a
 * duration nowhere near a whole day can still land off a whole unit for a width
 * that does not divide 48. What has not changed is why `durationOf`'s result is
 * not rounded generally: 0.2 is a genuine fraction, not drift, and the inner
 * snap only ever moves a value already within 1e-9 of a whole workday.
 *
 * A doc that still described the old arrangement would invite a maintainer to
 * restore the defect while believing they were following policy — found by peer
 * review on TASK-323, Important 3. `solver-quantum-golden-corpus.ts` is the
 * guard that makes removing either snap a red.
 *
 * Never rounds a real duration down, so {@link SOLVER_QUANTUM}'s feasibility
 * argument holds for every slice.
 */
export function durationUnits(slice: Slice): number {
  return quantise(slice).units;
}

/**
 * Whether {@link durationUnits} had to round this slice up — the per-slice
 * rounding the request records.
 *
 * No production consumer reads it today. Its readers are the golden corpus,
 * `solver-quantum.test.ts`, and an export-surface assertion in
 * `solver-seams.test.ts`. The export is shaped this way so that if a request
 * builder ever needs to report the rounding without recomputing it, the
 * alternative for it would be to multiply and compare against its own drift
 * window, which would be this file's arithmetic written a second time in another
 * package, and the second copy would be the one that disagrees after an edit.
 */
export function durationRoundedUp(slice: Slice): boolean {
  return quantise(slice).rounded;
}

/**
 * The single multiplication and the single drift window both exported readers
 * above are answers about.
 *
 * **Throws on a width the engine would have refused at its own door.** Until
 * 2026-09-03 `durationOf` was private, and the only way to reach it was through
 * `groupByWorkItem`, which refuses `width < 1` precisely because `durationOf`
 * divides by it: a width of 0 is `Infinity` days for a slice with effort and
 * `NaN` for one without. Publishing `durationOf` for the solver put a caller
 * outside that door, and `Math.ceil(Infinity)` is `Infinity` — so an
 * unrefused width would have reached the wire as a duration rather than as an
 * error, and been diagnosed there as a schema violation of the request the
 * builder itself wrote. The guard belongs at the last point that can still name
 * the cause. Throwing rather than returning a code is `groupByWorkItem`'s own
 * choice for the same input: this is malformed input, not a missing default.
 */
function quantise(slice: Slice): { units: number; rounded: boolean } {
  // The drift window is a WORKDAY-space window, so it is applied in workday
  // space **before** the multiplication as well as after it. Snapping only
  // after is what TASK-302 was: `snapWorkdays` cleans to within `DRIFT` of a
  // whole *argument*, so once the argument is units the same constant is a
  // window `SOLVER_QUANTUM` times narrower in the duration it is really about.
  // A duration that `lastWorkdayOf` — which snaps in workday space — reads as
  // a whole day could therefore fail to snap here, `ceil` to one unit more,
  // and make the model report `plan-infeasible` for a plan the real-domain
  // predicate reports on time.
  //
  // The second snap stays, because it answers a different question: a duration
  // nowhere near a whole workday can still land a bit off a whole unit
  // (`days / width` for a width that does not divide 48), and that step onto
  // the integer axis is the one `workday.ts` lists this site for.
  const exact = snapWorkdays(snapWorkdays(durationOf(slice)) * SOLVER_QUANTUM);
  if (!Number.isFinite(exact) || exact < 0) {
    throw new Error(
      `slice ${slice.workItemId} has no finite duration in solver units: width ${String(slice.width)}, days ${String(slice.days)}`,
    );
  }
  const units = Math.ceil(exact);
  return { units, rounded: units !== exact };
}
