import {
  type DependencyEdge,
  type DependencyReach,
  type PlannedRow,
  type PoolSizes,
  type Schedule,
  schedule,
  ScheduleInvalidOptimizedStartError,
  type Slice,
  SOLVER_QUANTUM,
} from '@wbs/domain';

import type { SolverOffsetMap } from './wire-types';

/**
 * The solver's answer, materialised into a real schedule — 4.11's wiring, and
 * the exact inverse of {@link quantisedFastBaseline}.
 *
 * The baseline turns Fast's workday axis into whole solver units so a hint can
 * go on the wire; this turns the units the solver answers in back into
 * workdays and hands them to `schedule()` as pinned starts. The two live beside
 * each other on purpose: the quantum is the only fact either one knows that the
 * domain does not, and a second file that also divided by it would be the copy
 * that disagreed after an edit.
 *
 * ## Why this is not in `libs/domain`
 *
 * `schedule()` already takes `pinnedStarts` and is the ONE placement pass —
 * 4.9's whole point. What this adds is the boundary between a wire answer and
 * that parameter: the unit conversion, and the two refusals below. Adding it as
 * a second `libs/domain` entry point would put the wire's units inside the
 * engine, which is the direction the quantum is deliberately kept out of.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * A pinned start that the plan itself rejects — before a floor, or inside a
 * full pool — is `schedule()`'s refusal and stays there, as is a slice the map
 * carries no offset for. All three raise
 * {@link ScheduleInvalidOptimizedStartError}, which the caller already maps
 * onto the `invalid-output` disposition and falls back to Fast for, so a
 * malformed answer and an infeasible one reach the caller as one thing.
 *
 * Two refusals are this boundary's own, because `schedule()` cannot make them:
 *
 * - **An offset that is not a whole non-negative unit.** The wire parser checks
 *   this on a parsed response, but this function is also the path a *hint* or a
 *   re-materialisation takes, and dividing 24.5 by the quantum yields a start
 *   half a unit off the axis every other start is on — a placement nothing in
 *   the model could have produced, silently accepted as a plan.
 * - **An offset key naming no slice in this plan.** `schedule()` refuses a
 *   slice with no offset and cannot refuse the converse: `pinnedStarts` is read
 *   through the node list, so a surplus key is invisible to it. A solver answer
 *   carrying a key this plan has no slice for answered a different question —
 *   most likely a stale plan's — and the starts it did return are not
 *   trustworthy either.
 *
 * The surplus check runs **after** the placement rather than before it, which
 * costs a wasted pass on a malformed answer and buys the exactness that matters:
 * the legal key set is the node set `schedule()` itself built, so comparing
 * against `placed.slices` cannot drift from it. Deriving the same set here would
 * be a second copy of the leaf grouping and the leaf refusal.
 *
 * ## The ulp hazard, and where it is closed
 *
 * `offset / SOLVER_QUANTUM` is a single correctly-rounded IEEE division, so it
 * is the nearest double to the exact rational — but the floors it is compared
 * against are Fast's own accumulated `days / width` arithmetic. Compared with
 * bare `===` and `<`, a floor whose exact value is a unit multiple but whose
 * double drifted a ulp above it makes a perfectly feasible pin read as "before
 * its floor" and throw.
 *
 * **That is closed, in `schedule.ts`, and this note is a pointer to the rule
 * rather than a second statement of it.** Both the floor comparison and the
 * pool-window re-ask go through `withinDrift` (`schedule.ts:1159-1211`): equal
 * means `withinDrift`, not `===`, because the two sides are two roundings of
 * one real number — the pin divides back from `k / SOLVER_QUANTUM` and the
 * floor accumulates through `days / width`. It is not a rare case: 106,142 of
 * 480,000 (width, offset) pairs drift one way or the other, and with `===` the
 * plan's OWN quantised baseline came back as a refusal.
 *
 * The window hides no real violation, and the separation is quantified rather
 * than asserted: the solver places integers, so a genuinely early start is
 * early by at least one unit — 0.0208 of a day against a 1e-9 window.
 *
 * An earlier revision of this note said the hazard was "NOT closed here" and
 * survived the fix. Sol's M2 on PR 203 caught it: a note that records an open
 * hazard the code has since closed invites a duplicate workaround and misstates
 * the release safety case.
 */
export function materialiseOptimized(
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  slices: readonly Slice[],
  notBefore: ReadonlyMap<string, number>,
  poolSizes: PoolSizes,
  reach: DependencyReach,
  offsets: SolverOffsetMap,
): Schedule {
  const pinnedStarts = new Map<string, number>();
  for (const [key, offset] of Object.entries(offsets)) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ScheduleInvalidOptimizedStartError(
        key,
        `${String(offset)} is not a whole non-negative unit offset`,
      );
    }
    pinnedStarts.set(key, offset / SOLVER_QUANTUM);
  }

  // `deadlines` is `schedule()`'s seventh argument and `pinnedStarts` its
  // eighth. Stated positionally here rather than skipped, because the empty map
  // is the honest value: the optimized path carries no deadline of its own —
  // the solver has already answered with a start per slice, and this pass only
  // materialises that answer.
  const placed = schedule(
    rows,
    edges,
    slices,
    notBefore,
    poolSizes,
    reach,
    new Map(),
    pinnedStarts,
  );

  for (const key of pinnedStarts.keys()) {
    if (!placed.slices.has(key)) {
      throw new ScheduleInvalidOptimizedStartError(
        key.replace('\u0000', '/'),
        'this plan has no such slice',
      );
    }
  }

  return placed;
}
