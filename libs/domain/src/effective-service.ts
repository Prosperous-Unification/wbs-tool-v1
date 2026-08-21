import { effectiveLabelsOf } from './effective-label';

/**
 * A row of a plan, as far as the service is concerned: its own id, its
 * parent's, and whichever service somebody put on it.
 *
 * Structural rather than be-01's `LabelledWorkItem` or fe-01's `TreeRow`, for
 * {@link TagsLabelled}'s reason — the point of this module is that both sides
 * read the same rule.
 *
 * `serviceId` is **single-valued and nullable**, which is where this dimension's
 * row shape differs from the other two: a work item is delivered by one service
 * (design.md D2), so the store holds a column rather than a join table. `null`
 * is _unstated_ — the state that inherits — and there is deliberately no third
 * "deliberately no service" state, for the reason there is none for teams or
 * tags (Dany, 2026-08-13, Q4).
 */
export interface ServiceLabelled {
  id: string;
  parentId: string | null;
  serviceId: string | null;
}

/** Which service delivers this row, and which row said so. */
export interface EffectiveServices {
  /**
   * The service in force for this row: the one the nearest stating row carries.
   *
   * A single id rather than a set, because the column is single-valued — the
   * set lives one layer down, inside the walk, and never surfaces. Widening the
   * cardinality later changes this field and the two lines that build it, not
   * the inheritance.
   *
   * Never null. A row with no service anywhere above it is absent from the map
   * instead, so "unstated" has one spelling here as it does in the other two
   * dimensions.
   */
  serviceId: string;
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
 * **Set-shaped inside, single-valued outside** (design.md D2). The column goes
 * in as a singleton set and the answer comes back out of one, so the walk that
 * the other two dimensions share needs no special case for the one dimension
 * that stores a column. Widening to many services per item is then a migration
 * and these two conversions, not a redesign of the inheritance.
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
    (row) => (row.serviceId === null ? [] : [row.serviceId]),
    // `labelIds[0]` is always there: `effectiveLabelsOf` calls `wrap` only for a
    // set it has already found non-empty, and the only set this dimension puts
    // in is the singleton above. The other member of that pair is the `[]` for a
    // null column, which never reaches here.
    ({ labelIds, fromId }) => ({ serviceId: labelIds[0], fromId }),
    (startedAt) => new ServiceAncestryCycleError(startedAt),
  );
}
