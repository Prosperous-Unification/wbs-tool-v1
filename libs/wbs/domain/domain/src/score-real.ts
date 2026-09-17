import type { Schedule } from './schedule';

/**
 * The three cost terms of 5.2 in the **real** fractional-workday domain.
 *
 * Named for the domain they are computed in and not for the thing that computes
 * them, because there is a second scorer over the same three terms —
 * `recomputeObjectives` in `revalidate-solver-result.ts`, which works in
 * quantised integer units on `bigint` and answers a different question. **A
 * real term is comparable only against another real term** (design.md,
 * "Comparison semantics for the real domain"): a stored real value is never
 * held against a quantised one, which is why 4.12b skips the
 * `value <= stageValue` relation on a floor row and why the comparison
 * indicator reads `publication` rather than inferring a win from the numbers.
 */
export interface RealObjectiveValues {
  /** `max finish`, and `0` over no slices at all. */
  readonly makespan: number;
  /** `Σ weight(s) · finish(s)`. */
  readonly priority: number;
  /** `Σ |start(s) − baselineStart(s)|`. */
  readonly movement: number;
}

/**
 * Score a materialised schedule in the real domain.
 *
 * **The two sides of 4.11b's publication guard are summed in one order**, and
 * that is the whole reason this iterates a sorted key list rather than the
 * `Map` it is handed. `Schedule.slices` is written in **placement** order, and
 * the optimized schedule and real Fast's place the same slices in different
 * orders by construction — Fast drains its eligible set by priority, the replay
 * drains it by ascending start. IEEE-754 addition is not associative, so
 * summing the same terms in two orders can answer two different doubles, and
 * the guard's predicate is a plain `>` with no epsilon: a difference of one ulp
 * arriving from the iteration order alone would substitute Fast's schedule for
 * a solver answer that was not worse, or publish one that was. Sorting the keys
 * gives both sides the same total order out of the only thing a `Schedule`
 * carries — a `Schedule` holds no canonical index, and reaching back to the
 * canonical input for one would make the scorer need an argument it otherwise
 * does not.
 *
 * The weight and the baseline arrive as callbacks rather than maps because the
 * lookup they do is the caller's fact and not this function's: a weight is a
 * dense rank over LEAVES (`priorityWeightOf`) while these keys name SLICES, and
 * a baseline start belongs to whichever schedule the caller is measuring
 * movement against. What is fixed here is the arithmetic and the order.
 *
 * `makespan` over an empty schedule is `0` rather than `-Infinity` or a throw:
 * nothing is scheduled, so the plan ends where it starts. That is the same
 * reading the quantised scorer takes over an empty placement set.
 */
export function scoreReal(
  produced: Schedule,
  weightOf: (sliceKey: string) => number,
  baselineStartOf: (sliceKey: string) => number,
): RealObjectiveValues {
  let makespan = 0;
  let priority = 0;
  let movement = 0;
  for (const key of [...produced.slices.keys()].sort()) {
    const slice = produced.slices.get(key);
    /* c8 ignore next -- a key taken from the map's own key list is always in it */
    if (slice === undefined) continue;
    if (slice.earliestFinish > makespan) makespan = slice.earliestFinish;
    priority += weightOf(key) * slice.earliestFinish;
    movement += Math.abs(slice.earliestStart - baselineStartOf(key));
  }
  return { makespan, priority, movement };
}
