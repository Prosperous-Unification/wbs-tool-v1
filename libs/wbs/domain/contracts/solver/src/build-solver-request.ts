import {
  contractVersionOf,
  type DependencyEdge,
  type DependencyReach,
  expandToLeaves,
  groupSlicesByLeaf,
  indexTree,
  leafDeadlinesOf,
  leafFloorsOf,
  type PlannedRow,
  type PoolSizes,
  priorityByLeaf,
  priorityWeights,
  type Slice,
  SOLVER_QUANTUM,
} from '@wbs/domain';

import { buildSolverEdges } from './build-solver-edges';
import { buildSolverPools } from './build-solver-pools';
import { buildSolverSlices } from './build-solver-slices';
import { preflightSolverRequest, type SolverPreflightFailure } from './solver-preflight';
import { isValidStageBudgetSplit, STAGE_BUDGET_SPLIT } from './stage-budget';
import {
  SOLVER_WIRE_VERSION,
  type SolverObjective,
  type SolverOffsetMap,
  type SolverRequest,
  type SolverStageBudgetSplit,
} from './wire-types';

/**
 * The canonical scheduling input: **the exact argument tuple of `schedule()`**,
 * plus the seventh argument it does not take yet.
 *
 * Named as a record rather than taken as seven positional parameters because
 * this is 1.1's canonical form and the hash is computed over the same shape —
 * two readings of one tuple, and a positional list of seven is where the fourth
 * and the fifth get swapped. The field names are `schedule()`'s own.
 *
 * `deadlines` is the seventh argument, keyed by **as-authored** id like every
 * other constraint map. It is legitimately **empty** for TASK-219: the
 * `deadline` column and `deadlineOffsetOf` do not exist yet, and 1.6's no-op
 * proof requires the empty source to leave the golden corpus byte-identical. It
 * is a parameter rather than an omission so that TASK-241 populates a source
 * instead of widening a signature.
 */
export interface SolverRequestPlan {
  readonly rows: readonly PlannedRow[];
  readonly edges: readonly DependencyEdge[];
  readonly slices: readonly Slice[];
  readonly notBefore: ReadonlyMap<string, number>;
  readonly poolSizes: PoolSizes;
  readonly reach: DependencyReach;
  readonly deadlines: ReadonlyMap<string, number>;
}

/**
 * What the spawn contributes, which the plan cannot.
 *
 * 2.2 names this argument `baseline`, and it grew to a record for a stated
 * reason rather than by drift: `contractVersion` is
 * `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"`, and neither `solverVersion`
 * nor `budgetMs` is a fact about the plan — they are facts about the process
 * about to be started. Three of the schema's thirteen required members come
 * from here and there is nowhere else in the tuple they could come from.
 *
 * **`baselineOffsets` is passed in rather than computed here**, which is the
 * substance of 2.2's original name. `quantisedFastBaseline` takes exactly this
 * plan's first six fields, so the builder *could* call it — and must not: the
 * PRI and Time requests for one plan are two calls to this function, MOVEMENT
 * is measured against the baseline in both, and a baseline computed twice is
 * two chances for the two runs to be scored against different schedules. One
 * baseline, computed once by the coordinator, handed to both.
 */
export interface SolverSpawn {
  /** 2.11's quantised baseline. Also the `fastHint` — one map, sent twice. */
  readonly baselineOffsets: SolverOffsetMap;
  /** The Python package's own version. The right half of `contractVersion`. */
  readonly solverVersion: string;
  /** Wall clock for the whole staged run. */
  readonly budgetMs: number;
  /** Defaults to {@link STAGE_BUDGET_SPLIT}; validated whatever it is. */
  readonly stageBudgetSplit?: SolverStageBudgetSplit;
}

/**
 * A request, or the pre-spawn refusal that means no process should start.
 *
 * The failure arm is `preflightSolverRequest`'s verbatim — same tokens, same
 * `detail` — because a caller records one of them either way and a second
 * vocabulary for the same two arithmetic facts would be a second thing to
 * translate.
 */
export type BuiltSolverRequest =
  | { readonly ok: true; readonly request: SolverRequest }
  | { readonly ok: false; readonly failure: SolverPreflightFailure; readonly detail: string };

/**
 * The assembly: one canonical plan and one objective in, one wire request out.
 *
 * **Almost nothing here is this function's own.** Every field is produced by a
 * seam that owns its rule — `buildSolverSlices` the projection and its two
 * refusals, `buildSolverEdges` the graph, `buildSolverPools` the capacities and
 * the "no size for pool" promotion, `preflightSolverRequest` the horizon and
 * the three overflow bounds, `leafFloorsOf`/`leafDeadlinesOf`/`priorityWeights`
 * the three folds, `SCHEDULER_CONTRACT_VERSION` and `SOLVER_QUANTUM` the two
 * constants. That is the point of the slice order 2.2 was built in: by the time
 * the assembly is written there is no rule left in it, and a rule appearing
 * here would be a second copy of one stated elsewhere.
 *
 * What *is* its own is the **order** the seams run in, and one key-set refusal.
 *
 * ## Why the grouping comes first
 *
 * `groupSlicesByLeaf` is called before anything projects, so a slice for a
 * non-leaf and a fractional width are refused naming the *plan*, not the wire.
 * Run it after `buildSolverSlices` and a slice belonging to a parent would be
 * projected happily, keyed, and then refused several steps later by a function
 * whose message is about positions in a group — the same fault reported as a
 * different one. The grouping is also `buildSolverEdges`' `slicesOf`, and it
 * must be the identical grouping: an edge names its ends by leaf and
 * **position**, so two groupings would disagree about which slice a position
 * is. One call, both readers.
 *
 * ## The key-set refusal, and the direction that had no guard
 *
 * `slices[]`, `baselineOffsets` and `fastHint` are keyed by the same
 * `sliceKey`, and the re-validator (2.4) checks the *response* against the
 * request's slices. `preflightSolverRequest` already throws on a slice with no
 * baseline entry — slices ⊆ baseline. **The other direction had nothing**: a
 * baseline carrying a key no slice names would ship an offset for a slice that
 * is not in the request, and `fastHint` is the solver's starting assignment, so
 * a stale key there is a hint about a slice the model has no variable for.
 * Refused here because this is the first place both sets exist, and it throws
 * rather than returning a failure for the reason the preflight's own missing-key
 * throw does: the key sets are equal by construction when one plan produced
 * both, so an inequality is this package's bug and not a state of anyone's plan.
 *
 * ## The two shapes that are not refusals of the plan
 *
 * An **empty** slice list is refused because the schema's `slices` is
 * `minItems: 1` and its comment says why — a canonical input with no slices
 * allocates nothing and spawns nothing, so an empty array never reaches the
 * wire. Emitting one would be this builder writing a request the schema it
 * validates against rejects. The **stage split** is validated rather than
 * trusted for `isValidStageBudgetSplit`'s stated reason: the builder must check
 * whatever it is handed, and the sum-to-one invariant is one JSON Schema cannot
 * express.
 *
 * Throws whatever its seams throw. Returns a failure only for the three
 * pre-spawn arithmetic bounds, which are the two states a user's plan can
 * genuinely be in.
 */
export function buildSolverRequest(
  plan: SolverRequestPlan,
  objective: SolverObjective,
  spawn: SolverSpawn,
): BuiltSolverRequest {
  if (plan.slices.length === 0) {
    throw new Error('a canonical input with no slices spawns nothing and has no request');
  }

  const index = indexTree(plan.rows);
  const { leafIds } = index;
  // First, so the plan's own two refusals fire before any projection keys
  // anything — and once, so the edge builder reads the grouping the slices were
  // projected from.
  const grouped = groupSlicesByLeaf(leafIds, plan.slices);
  const slicesOf = (leafId: string): readonly Slice[] => {
    const own = grouped.get(leafId);
    // `schedule()`'s refusal, in the same words. A leaf nobody sliced cannot be
    // placed, and dropping it would take every edge through it with it.
    if (own === undefined) throw new Error(`no slice for work item ${leafId}`);
    return own;
  };

  const slices = buildSolverSlices(plan.slices, {
    floors: leafFloorsOf(plan.notBefore, index),
    deadlines: leafDeadlinesOf(plan.deadlines, index),
    weights: priorityWeights(priorityByLeaf(plan.rows, index)),
  });
  const edges = buildSolverEdges(leafIds, slicesOf, expandToLeaves(index, plan.edges), plan.reach);
  const pools = buildSolverPools(slices, plan.poolSizes);

  const named = new Set(slices.map((slice) => slice.key));
  for (const key of Object.keys(spawn.baselineOffsets)) {
    if (!named.has(key)) {
      throw new Error(
        `baseline offset for ${key.replace('\u0000', '/')}, which this request has no slice for`,
      );
    }
  }

  const stageBudgetSplit = spawn.stageBudgetSplit ?? STAGE_BUDGET_SPLIT;
  if (!isValidStageBudgetSplit(stageBudgetSplit)) {
    throw new Error(
      `stage budget split ${JSON.stringify(stageBudgetSplit)} does not spend the budget exactly once`,
    );
  }

  // Last, because it needs the projected slices, and it is what decides whether
  // a process starts at all. The missing-baseline direction throws inside it.
  const preflight = preflightSolverRequest(slices, spawn.baselineOffsets);
  if (!preflight.ok) return preflight;

  return {
    ok: true,
    request: {
      wireVersion: SOLVER_WIRE_VERSION,
      // Both halves, and the schema's `$comment` holds the argument for both:
      // the solver's version describes none of the durations, the leaf
      // expansion or the baseline, all of which Bun produced.
      contractVersion: contractVersionOf(spawn.solverVersion),
      solverVersion: spawn.solverVersion,
      objective,
      budgetMs: spawn.budgetMs,
      stageBudgetSplit,
      quantum: SOLVER_QUANTUM,
      horizonUnits: preflight.horizonUnits,
      slices,
      edges,
      pools,
      baselineOffsets: spawn.baselineOffsets,
      // The same map, deliberately. They are two different questions that
      // happen to have one answer today — `baselineOffsets` is what MOVEMENT is
      // measured from and `fastHint` is where the search starts — and the wire
      // keeps them apart so a later hint (a warm start from the previous cached
      // result, say) does not silently move the objective's origin.
      fastHint: spawn.baselineOffsets,
    },
  };
}
