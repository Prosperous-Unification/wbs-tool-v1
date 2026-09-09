import { durationUnits, priorityWeightOf, type Slice, sliceKey } from '@wbs/domain';

import { deadlineUnitsOf, notBeforeUnitsOf } from './solver-units';
import type { SolverSlice } from './wire-types';

/**
 * Everything the projection needs that is not on the slice itself, already
 * folded to leaves.
 *
 * Three maps rather than the tree, because that is the division of labour the
 * whole wire rests on: Bun owns duration and graph derivation, Python owns
 * placement only, and no `parentId` ever leaves this process. Each is produced
 * by a published `@wbs/domain` seam — `leafFloorsOf`, `leafDeadlinesOf` and
 * `priorityWeights` over `priorityByLeaf` — and every one of them is absent for
 * the leaves it does not constrain, which is most leaves on most plans.
 */
export interface LeafConstraintMaps {
  /** `leafFloorsOf` — whole workdays from day zero. Absent means day zero. */
  readonly floors: ReadonlyMap<string, number>;
  /** `leafDeadlinesOf` — whole workdays. Absent means unconstrained, not late. */
  readonly deadlines: ReadonlyMap<string, number>;
  /** `priorityWeights` — the dense rank. Absent means nobody prioritised it. */
  readonly weights: ReadonlyMap<string, number>;
}

/**
 * The canonical slices projected onto the wire, one for one and in the order
 * given.
 *
 * **Every field is either copied or read from a published seam.** Nothing here
 * recomputes a rule: `durationUnits` owns the quantisation and its rounding
 * direction, `priorityWeightOf` owns the dense rank, and the two conversions in
 * `solver-units.ts` own the unit arithmetic. This function's own contribution
 * is the assembly and the two refusals below.
 *
 * **The floor is carried on EVERY slice, and `schedule()` puts it on the first
 * only.** That difference is deliberate and it is not a difference in the
 * feasible region: the request's `edges` already carry the intra-item step
 * chain, so a later slice starts at or after its predecessor's finish, which is
 * at or after the first slice's start, which is at or after the floor. The
 * constraint is therefore implied for the rest either way. Two reasons to state
 * it anyway. The schema's field is per-slice and defines itself as the *fold*
 * ("the latest of the leaf's own floor and every ancestor's") rather than as a
 * position, so a zero there would be a slice claiming to be unfloored when it
 * is not; and a projection that depends on which slice comes first has to know
 * the group order, which is precedence and carries meaning — reading it here
 * would put a second grouping rule beside `groupByWorkItem`'s. Redundant
 * constraints cost CP-SAT nothing and propagate earlier.
 *
 * The deadline is on every slice for a simpler reason: an item due on day `D`
 * has no slice that may finish after day `D`.
 *
 * `Proof:` **2.7's second half, watched on h2puni at `6160aebe`.**
 * `durationUnits(slice)` replaced by the **pre-quantisation** `days / width`
 * (with `ASSUMED_SLICE_WORKDAYS` for a null estimate, undivided) gives
 * **146 pass / 10 fail across 16 files**, and the spread is the finding: the
 * fault is caught in **five** files, not one. 2.6's width case fails as the
 * plan promised, and so do both `buildSolverSlices` cases, the golden request
 * corpus in two places, all three baseline-feasibility cases and the projection
 * pairing in `quantised-baseline.test.ts`. A duration is not one field's
 * business — it is the horizon, the offsets, the objective and the bytes — so
 * an unquantised one is refused by the arithmetic, by the fixture and by the
 * re-validator independently. The one that would have caught it *alone* is the
 * golden corpus, because every other assertion is derived from these same
 * seams.
 */
export function buildSolverSlices(
  slices: readonly Slice[],
  leaf: LeafConstraintMaps,
): readonly SolverSlice[] {
  const durations = slices.map(durationUnits);
  const workItemsWithDuration = new Set(
    slices.filter((_, at) => durations[at] > 0).map((slice) => slice.workItemId),
  );
  const seen = new Set<string>();
  return slices.map((slice, at) => {
    const key = sliceKey(slice.workItemId, slice.stepId);
    if (seen.has(key)) {
      // `offsets`, `baselineOffsets` and `fastHint` are all keyed by this
      // string, so a duplicate is not a redundant row — it is one row silently
      // overwriting another in three maps, and the re-validator would then
      // report the key-set mismatch as a solver fault. Refused at the point
      // that can still name the pair. `sliceKey` separates with a NUL, so two
      // distinct pairs cannot collide by running into each other; a duplicate
      // here is a genuinely duplicated `(workItemId, stepId)`.
      throw new Error(
        `duplicate slice for work item ${slice.workItemId}, step ${slice.stepId ?? '(none)'}`,
      );
    }
    seen.add(key);

    if (!Number.isInteger(slice.width) || slice.width < 1) {
      // `groupByWorkItem` refuses `width < 1` and `durationUnits` throws on the
      // non-finite duration that follows from it, so the *zero* case is already
      // covered twice. A fractional width at or above 1 is the case neither
      // catches: `days / 1.5` is a perfectly finite duration, and the request
      // would reach the schema with a `width` its `type: integer` refuses —
      // diagnosed there as a malformed request rather than as people who do not
      // exist.
      throw new Error(
        `slice ${slice.workItemId} has a width that is not a whole number of people: ${String(slice.width)}`,
      );
    }

    return {
      // Group identity is explicit because `key` is opaque outside this
      // builder; neither validator may split it to rediscover the work item.
      workItemKey: slice.workItemId,
      key,
      durationUnits: durations[at],
      width: slice.width,
      personId: slice.personId,
      // A SET, sorted, because the canonical input must hash stably and
      // `effectiveTeamsOf` promises neither. The whole width is spent in every
      // pool named here, so order carries nothing.
      poolIds: [...new Set(slice.poolIds)].sort(),
      priorityWeight: priorityWeightOf(leaf.weights, slice.workItemId),
      notBeforeUnits: notBeforeUnitsOf(leaf.floors, slice.workItemId),
      deadlineUnits: deadlineUnitsOf(leaf.deadlines, slice.workItemId),
      // A zero step after real work does not extend the projected work-item
      // span into the next workday. An all-zero work item is itself a milestone.
      workItemIsMilestone: !workItemsWithDuration.has(slice.workItemId),
    };
  });
}
