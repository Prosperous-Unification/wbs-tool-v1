import {
  type DependencyEdge,
  type DependencyReach,
  durationUnits,
  type PlannedRow,
  type PoolSizes,
  schedule,
  type Slice,
  SOLVER_QUANTUM,
} from '@wbs/domain';

import type { SolverOffsetMap } from './wire-types';

/**
 * Fast's own placement re-run over the **rounded** durations, in integer solver
 * units — the request's `baselineOffsets`, and the same map again as `fastHint`.
 *
 * **Real Fast's answer is not a legal answer to the question the solver is
 * asked**, and that is the whole reason this exists. Three serial slices at
 * `days: 1, width: 5` are 0.2 workdays each; Fast finishes them at 0.6 workdays,
 * which is 28.8 units, and 28.8 is not a value any CP-SAT variable can hold.
 * Rounding each duration up to 10 units makes the same three slices need 30.
 * Feeding real Fast's 28.8 in as stage 1's upper bound would hand the search a
 * bound its own arithmetic cannot meet, and the hint would be infeasible in the
 * very model it hints. So the baseline is re-derived in the quantised model
 * rather than converted from the real one.
 *
 * **It re-runs `schedule()` rather than reimplementing the placement.** The
 * baseline has to be Fast's answer — same eligibility ranking, same person
 * queues, same pool windows, same tie-breaks — and a second placement written
 * to agree with that one is a divergence waiting for either to be edited. What
 * is rescaled is the *input*, so the pass itself is untouched and unaware.
 *
 * ## The rescale, and why it is exact
 *
 * `schedule()`'s time axis is workdays and its durations come from
 * `durationOf` = `days / width`. Multiplying that axis by {@link SOLVER_QUANTUM}
 * turns one unit into one "day", and on that axis the duration owed is
 * `durationUnits(slice)` — an integer. So each slice is handed over with
 * `days = durationUnits(slice) × width` and its width untouched, and
 * `durationOf` gives `(u × w) / w`.
 *
 * That is **exactly** `u`, not `u` to within a rounding: `u × w` is an integer
 * product of integers, so where it is a safe integer it is represented with no
 * error at all, the real quotient is `u`, `u` is representable, and IEEE-754
 * division is correctly rounded — the only representable value it may return is
 * the exact one. The safe-integer condition is therefore load bearing and is
 * checked rather than assumed. It is also not close: `horizonUnits` is refused
 * above `2**31 - 1` (2.10) and a width is at most 1000, so a plan that reaches
 * here at all is bounded by about `2**41`.
 *
 * Width is people and a pool size is slots — both dimensionless — so neither
 * scales, and the capacity profile bounds the rescaled run exactly as it bounds
 * the real one. Floors are the one other calendar quantity, and they scale by
 * the same constant. The **fold** stays inside `schedule()`: `leafFloorsOf`
 * takes each leaf's own floor and its ancestors' as a maximum, and
 * `max(k·a, k·b) === k·max(a, b)` for `k > 0`, so scaling the map before the
 * fold and scaling the fold's answer are the same number. One walk, still the
 * domain's.
 *
 * Deadlines are deliberately absent, and TASK-280 amended the reason rather
 * than the decision. The old wording said they "constrain the solver, not
 * Fast", which stopped being true at `work-item-deadline` slice 5: a deadline
 * reorders Fast's ready set by minimum slack. What still holds is the second
 * half — a plan whose quantised baseline misses a deadline is a plan whose
 * real-domain baseline missed it too, which is 4.11b's comparison and 3.1's
 * `plan-infeasible`, not this function's to decide.
 *
 * **Two things are now open here, and both belong to slice 8 rather than to
 * this file.** TASK-280 made `guardRealPublication` pass `input.deadlines`, so
 * the guard's real-domain baseline is deadline-ordered while this one is not:
 * the movement reference is measured against a different order than the
 * schedule it is compared with. That decides nothing — movement is never the
 * primary term — but it is the divergence the sentence above warns about,
 * reached from the other side. And CONTEXT.md allows this map to bound stage 1
 * "because it is feasible in the model the solver actually gets"; whether an
 * undeadlined placement is still feasible in a model carrying hard deadline
 * constraints is exactly what slice 8 answers.
 *
 * ## What the caller gets
 *
 * One offset per slice, keyed by `sliceKey`, with the same key set
 * `buildSolverSlices` projects — both walk the same `groupSlicesByLeaf`
 * grouping, which refuses a slice that is not a leaf's, and `schedule()` refuses
 * a leaf with no slice. Every value is a non-negative safe integer, checked
 * below rather than promised.
 *
 * Throws whatever `schedule()` throws, `ScheduleCycleError` included: a plan Fast
 * cannot schedule has no baseline to hint with, and inventing one would be
 * answering for a plan nobody has.
 */
export function quantisedFastBaseline(
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  slices: readonly Slice[],
  notBefore: ReadonlyMap<string, number>,
  poolSizes: PoolSizes,
  reach: DependencyReach,
): SolverOffsetMap {
  const placed = schedule(
    rows,
    edges,
    slices.map(onTheUnitAxis),
    scaleFloors(notBefore),
    poolSizes,
    reach,
  );

  const offsets: Record<string, number> = {};
  for (const [key, slice] of placed.slices) {
    const { earliestStart } = slice;
    // The second net, and MEASURED to be the second rather than assumed to be
    // the first: with the rounding dropped from `onTheUnitAxis` — real
    // durations on the unit axis — four of this file's tests fail, and every
    // one of them fails at that function's product guard, `slice A is
    // 9.600000000000001 units across 5 people`. An unrounded duration is
    // caught before the placement runs, because a fractional duration times a
    // width is not a safe integer either. So this check is not what makes the
    // rescale exact; it is what stops a PLACEMENT that somehow produced a
    // fractional start from putting it on the wire as a `type: integer`
    // violation of a request Bun itself wrote, to be diagnosed there as a
    // malformed request. Safe-integer rather than `Number.isInteger` because
    // the objective sums these and `2**53` is where a sum stops being able to
    // tell two offsets apart. `sliceKey`'s NUL is written as an ESCAPE below
    // and never typed — a literal one makes git call the file binary, and this
    // package has walked into that twice.
    if (!Number.isSafeInteger(earliestStart) || earliestStart < 0) {
      throw new Error(
        `quantised baseline put slice ${key.replace('\u0000', '/')} at ${String(earliestStart)}, which is not a whole unit offset`,
      );
    }
    offsets[key] = earliestStart;
  }
  return offsets;
}

/**
 * One slice as the rescaled run sees it: the same block, its duration rounded up
 * to whole units and restated as an estimate on the unit axis.
 *
 * `personId`, `poolIds` and `width` are carried over untouched — they are who,
 * where and how many, none of which the axis change touches — and `stepId` with
 * them, because the key the offset is returned under is built from it.
 *
 * `days` is synthesised, so a slice nobody estimated arrives here estimated,
 * carrying {@link durationUnits}' fold of `ASSUMED_SLICE_WORKDAYS`. That is the
 * intended reading and not a leak: the assumption is already the duration the
 * real placement used, `durationUnits` is the one function that folds it, and
 * the rescaled schedule's `estimated` flag is read by nobody — this function
 * returns starts.
 */
function onTheUnitAxis(slice: Slice): Slice {
  const units = durationUnits(slice);
  const days = units * slice.width;
  // The exactness of `(u × w) / w` is conditional on this product being
  // representable, and everything downstream — integer offsets, an integer
  // MOVEMENT, a hint CP-SAT can hold — rests on that exactness. A plan this big
  // is refused before it can be silently mis-scheduled instead.
  //
  // It is also, measured, the guard that catches the rounding going missing at
  // all: with `durationUnits` swapped for the real duration, this throws on
  // `9.600000000000001 units across 5 people` before any slice is placed, and
  // four of this file's tests go red there. A fraction times a width is not a
  // safe integer, so the two faults arrive at the same door.
  if (!Number.isSafeInteger(days)) {
    throw new Error(
      `slice ${slice.workItemId} is ${String(units)} units across ${String(slice.width)} people, which has no exact duration on the unit axis`,
    );
  }
  return { ...slice, days };
}

/**
 * The manual floors on the unit axis: day `N` begins at unit `N × quantum`.
 *
 * The same conversion `notBeforeUnitsOf` performs for the wire, and deliberately
 * the same constant, because the baseline must be feasible against the floors
 * the request actually carries. It is applied to the caller's **unfolded** map
 * — the fold is a maximum and commutes with the scale, so `schedule()` keeps
 * doing its own walk over the tree.
 */
function scaleFloors(notBefore: ReadonlyMap<string, number>): Map<string, number> {
  const scaled = new Map<string, number>();
  for (const [workItemId, day] of notBefore) scaled.set(workItemId, day * SOLVER_QUANTUM);
  return scaled;
}
