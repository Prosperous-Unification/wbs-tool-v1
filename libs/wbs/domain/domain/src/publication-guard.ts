import type { ScheduleInput } from './canonical-schedule-input';
import { type Schedule, schedule } from './schedule';
import { type RealObjectiveValues, scoreReal } from './score-real';

/**
 * Which of the two schedules the guard chose.
 *
 * Named for the schedules themselves rather than for the wire's
 * `publication: 'solver' | 'quantisation-floor'`, because that vocabulary is
 * `libs/contracts/solver`'s (`optimized-result-dto.ts`,
 * `OPTIMIZED_PUBLICATIONS`) and a second copy of it here is the copy that
 * disagrees after an edit. The caller that assembles the `OptimizedResult` maps
 * `'optimized' → 'solver'` and `'baseline' → 'quantisation-floor'`; that
 * mapping is one line at the boundary, and it is the same direction the quantum
 * and the wire units are already kept out of this library in.
 */
export type PublicationChoice = 'optimized' | 'baseline';

/**
 * The variant's **primary** term — `makespan` for Time, `priority` for PRI.
 *
 * Taken as an argument rather than derived from a solver objective for the same
 * layering reason as {@link PublicationChoice}: `SOLVER_OBJECTIVES` (`'pri' |
 * 'time'`) is a wire vocabulary. What this library knows is which of the three
 * real terms decides, not what the request called it.
 */
export type RealPrimaryTerm = 'makespan' | 'priority';

/**
 * The guard's answer, carrying both sides of the comparison it made.
 *
 * `values` is the chosen schedule's own score and is what 4.12b stores; the two
 * per-side scores are kept beside it because a caller writing a
 * `quantisation-floor` row has to be able to say *why* it wrote one, and
 * recomputing either side to find out would be a second summation the guard has
 * already made in the one order both sides share.
 */
export interface PublicationDecision {
  readonly chosen: PublicationChoice;
  /** The schedule to store: the optimized one, or the Baseline's own. */
  readonly schedule: Schedule;
  /** {@link scoreReal} over {@link PublicationDecision.schedule}. */
  readonly values: RealObjectiveValues;
  /** The Baseline schedule this run computed — real Fast, step (a). */
  readonly baseline: Schedule;
  readonly optimizedValues: RealObjectiveValues;
  readonly baselineValues: RealObjectiveValues;
}

/**
 * Task 4.11b: the real-domain publication guard.
 *
 * It runs **after 4.9's materialisation and before any cache write**, on the
 * materialised schedule, and answers one question: did the trip through the
 * solver's integer axis cost more than the search won?
 *
 * ## Why the guard exists at all
 *
 * The solver does not see workdays. `quantisedFastBaseline` rounds every
 * duration up to a whole `SOLVER_QUANTUM` unit before anything crosses the
 * wire, so the model the solver proves optimal is a *different* plan from the
 * one the user has — 2.11's own fixture is the demonstration: three serial
 * `days=1, width=5` slices finish at 0.6 real workdays and at 30 whole units,
 * and 30 units is 0.625 workdays. A quantisation-optimal answer can therefore
 * be strictly worse than Fast in the domain the answer is stored and rendered
 * in. Nothing else in the pipeline notices, because every other comparison
 * happens on the quantised side of the wire.
 *
 * ## Step (a): the Baseline is computed here, not handed in
 *
 * `input` is the `ScheduleInput` the optimized run itself was built from, and
 * the Baseline is `schedule()` over it with **no** pinned starts — real Fast,
 * fractional `days / width` intact. Taking the input rather than a ready-made
 * `Schedule` is the point: "over the same canonical input" is the property the
 * comparison rests on, and a `baseline: Schedule` parameter would let a caller
 * satisfy the type while comparing against another plan's answer, which is
 * exactly the failure the guard is supposed to catch a version of.
 *
 * ## Step (c): the predicate is `worse`, never "not strictly better"
 *
 * An **equal** primary may carry a strictly better secondary term, and
 * discarding that result would throw away a real improvement the user asked
 * for. So the comparison is a single epsilon-free `>` on the primary term and
 * nothing else: ties publish the solver's schedule.
 *
 * The `>` is epsilon-free because {@link scoreReal} sums both sides over the
 * same sorted key list. `Schedule.slices` is written in placement order, the
 * optimized replay and real Fast do not share one, and IEEE-754 addition is not
 * associative — a difference of one ulp arriving from iteration order alone
 * would decide this predicate. That ordering rule lives in the scorer; this
 * function's part of the bargain is to call it twice and compare nothing else.
 *
 * ## What the caller still owes
 *
 * The mapping onto `publication`, and 4.12b's storage rules for a floor row:
 * every `value` recomputed in the real domain (which is {@link
 * PublicationDecision.values}), null `stageValue`/`bound`, and `status:
 * 'unknown'`. A floor row **is** Fast's schedule, so presenting it as a solver
 * win is the thing `publication` is stored rather than inferred to prevent.
 *
 * @param input The canonical input the optimized run was built from.
 * @param optimized 4.9's materialised optimized schedule.
 * @param primary The variant's primary term.
 * @param weightOf A slice key's priority weight — a dense rank over LEAVES,
 *   which is why it arrives as a callback and not as a map keyed by slice.
 * @param baselineStartOf The movement reference, which is the **quantised**
 *   baseline's (CONTEXT.md, "Baseline schedule"). Movement is never the primary
 *   term, so it does not decide anything here; it is scored because a stored
 *   row carries all three.
 */
export function guardRealPublication(
  input: ScheduleInput,
  optimized: Schedule,
  primary: RealPrimaryTerm,
  weightOf: (sliceKey: string) => number,
  baselineStartOf: (sliceKey: string) => number,
): PublicationDecision {
  // Every field of `ScheduleInput`, in the argument tuple's own order. The
  // interface and this signature are the same tuple by design
  // (`canonical-schedule-input.ts`), so a field named there and absent here is
  // a Baseline computed from a different input than the one that was hashed —
  // and `input.deadlines` was exactly that until TASK-280. Nothing caught it:
  // the seventh parameter defaults to `new Map()`, so six arguments type-check
  // and quietly schedule an undeadlined plan. An eighth field cannot be made
  // safe by spreading — `schedule()` is positional and `ScheduleInput` is an
  // object, so `schedule(...input)` does not compile — which is the point: the
  // two are kept in step by hand, and this call is the site where that has
  // already failed once.
  const baseline = schedule(
    input.rows,
    input.edges,
    input.slices,
    input.notBefore,
    input.poolSizes,
    input.reach,
    input.deadlines,
  );

  const optimizedValues = scoreReal(optimized, weightOf, baselineStartOf);
  const baselineValues = scoreReal(baseline, weightOf, baselineStartOf);

  const worse = optimizedValues[primary] > baselineValues[primary];

  return {
    chosen: worse ? 'baseline' : 'optimized',
    schedule: worse ? baseline : optimized,
    values: worse ? baselineValues : optimizedValues,
    baseline,
    optimizedValues,
    baselineValues,
  };
}
