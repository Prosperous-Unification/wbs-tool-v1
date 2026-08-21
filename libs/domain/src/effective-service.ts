import { effectiveLabelsOf } from './effective-label';

/**
 * A row of a plan, as far as the service is concerned: its own id, its
 * parent's, and whichever service somebody put on it.
 *
 * Structural rather than be-01's `LabelledWorkItem` or fe-01's `TreeRow`, for
 * {@link TagsLabelled}'s reason — the point of this module is that both sides
 * read the same rule.
 *
 * `serviceIds` is a **set**, the `tagIds` shape (Dany, 2026-08-21 07:46 — "can
 * be several services"). Empty is _unstated_ — the state that inherits — and
 * there is deliberately no third "deliberately no service" state, for the
 * reason there is none for teams or tags (Dany, 2026-08-13, Q4).
 *
 * This field was `serviceId: string | null` until chunk 12, when the scope
 * change landed. The walk underneath never moved: it was set-shaped all along
 * and the single column went in as a singleton, which is why widening it is
 * this interface, the two conversions below, and nothing else in the
 * inheritance.
 */
export interface ServiceLabelled {
  id: string;
  parentId: string | null;
  serviceIds: readonly string[];
}

/** Which services deliver this row, and which row said so. */
export interface EffectiveServices {
  /**
   * The services in force for this row: the ones the nearest stating row
   * carries.
   *
   * Never empty. A row with no service anywhere above it is absent from the map
   * instead, so "unstated" has one spelling here as it does in the other two
   * dimensions — and a reader who finds an entry knows somebody stated
   * something.
   */
  serviceIds: readonly string[];
  /**
   * The row that carries the service — this row itself, or the nearest ancestor
   * above it that states one.
   *
   * Carried rather than reduced to a boolean for {@link EffectiveTags.fromId}'s
   * reason: "Payments — inherited from 010 Backend" is the sentence the service
   * cell has to say, and a `true` cannot say it.
   */
  fromId: string;
}

/** A `parentId` chain that runs in a circle, which is not a tree and has no ancestors. */
export class ServiceAncestryCycleError extends Error {
  override name = 'ServiceAncestryCycleError' as const;
  constructor(startedAt: string) {
    super(`the parent chain above ${startedAt} runs in a circle, so it has no nearest service`);
  }
}

/**
 * Every row's effective service: its own, or the nearest ancestor's.
 *
 * The rule is `effectiveTeamsOf`'s and `effectiveTagsOf`'s, unchanged and
 * deliberately so — most-specific wins; override rather than union; unstated
 * spelled only as absence from the map. The walk is literally the same code, in
 * `effective-label.ts`, and every proof comment about its faults is there.
 *
 * **Set-shaped throughout**, since the 2026-08-21 scope change. It was
 * set-shaped inside and single-valued at the edges before it, which is why the
 * widening cost the two conversions below and nothing in the walk. The store is
 * still one nullable column at the time of writing — `work_item.service_id`,
 * design.md D2 — and the migration to a join table is a later chunk of this same
 * change; until it lands the caller folds its column into a singleton and this
 * function cannot tell the difference, which is the point.
 *
 * **Override, not union, still** — and it is worth saying out loud now that the
 * answer is a set: a row stating `[Payments]` under a parent stating `[Checkout,
 * Search]` delivers `[Payments]` alone. The set is the cardinality of one row's
 * statement, never an accumulation down the tree.
 *
 * **Per dimension, independently**, which three dimensions make easier to doubt
 * and no less true: a row stating a service and no teams inherits its ancestor's
 * teams and overrides its ancestor's service, because these are three calls over
 * three fields and none of them reads another.
 *
 * **What a service is not:** it is not a pool and it is not a size. Nothing
 * below `slicesOf` reads it, `service/schedule.ts` has an empty diff in the
 * change that adds it, and a test wires the scheduler to read a service and
 * watches every downstream date move to keep it that way. A team answers _who
 * does the work_ and the engine spends its capacity; a service answers _what is
 * being delivered_ and the engine must never read it.
 *
 * @throws {ServiceAncestryCycleError} when the parent chain loops. Unknown is
 * not OK: a cycle has no nearest ancestor, so there is nothing to fall back to
 * and a default would attribute a row to a service nobody named.
 */
export function effectiveServicesOf(
  rows: readonly ServiceLabelled[],
): Map<string, EffectiveServices> {
  return effectiveLabelsOf(
    rows,
    (row) => row.serviceIds,
    ({ labelIds, fromId }) => ({ serviceIds: labelIds, fromId }),
    (startedAt) => new ServiceAncestryCycleError(startedAt),
  );
}
