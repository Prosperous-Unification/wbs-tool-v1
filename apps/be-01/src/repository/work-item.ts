import { isOrphanedNotBeforeReason } from '@wbs/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import type { Gate } from './gate';
import type {
  ExternalRef,
  FrozenNumber,
  LabelledWorkItem,
  Reparented,
  Repositioned,
  SubtreeCopy,
  SubtreeStore,
  WorkItem,
  WorkItemPatch,
  WorkItemPatched,
  WorkItemStore,
  WriteStamp,
} from './index';
import { bumpedWorkItem, bumpedWorkItemOnReparent, bumpWorkItems } from './revision';
import {
  actual,
  assignment,
  dependency,
  estimate,
  externalSystem,
  service,
  serviceTeam,
  stepMeasure,
  stepProgress,
  tag,
  workItem,
  workItemExternalRef,
  workItemService,
  workItemTag,
  workItemTeam,
  workItemType,
  workItemWorkItemType,
} from './schema';

/**
 * The not-before pair as the row will stand: what the patch names, and what the
 * row holds where the patch names nothing.
 *
 * The merge, and not the patch, is what the pair rule is asked about. A patch
 * carrying only a reason is legal on a row that already has a date and illegal
 * on one that does not, and the patch alone cannot tell which — so reading the
 * rule off the request would refuse the ordinary case of adding words to an
 * existing floor, or accept the orphan it exists to prevent, depending on which
 * way it was written.
 */
function mergedNotBefore(
  stored: { startNoEarlierThan: string | null; startNoEarlierThanReason: string | null },
  patch: WorkItemPatch,
): { date: string | null; reason: string | null } {
  return {
    date:
      patch.startNoEarlierThan === undefined ? stored.startNoEarlierThan : patch.startNoEarlierThan,
    reason:
      patch.startNoEarlierThanReason === undefined
        ? stored.startNoEarlierThanReason
        : patch.startNoEarlierThanReason,
  };
}

/**
 * The join rows one write owes, derived from the column it is writing.
 *
 * The direction is deliberate and it is `team-sets`' design.md D2: the write
 * path still takes one team, the column is what the journal and the outgoing
 * release read, and the set is written from it. R2-4 turns this around — the
 * request carries the set, and the column becomes the derived copy — and R2-6
 * deletes the column and this function with it.
 */
function joinRowsFor(
  rows: readonly (WorkItem & { teamIds?: readonly string[] })[],
): { workItemId: string; teamId: string }[] {
  return rows.flatMap((row) => {
    const teamIds = row.teamIds ?? (row.serviceTeamId === null ? [] : [row.serviceTeamId]);
    return [...new Set(teamIds)].sort().map((teamId) => ({ workItemId: row.id, teamId }));
  });
}

/**
 * The columns a {@link WorkItem} is, named once because both reads here want
 * exactly them.
 *
 * Spelled out rather than left to `select()`, which is the convention this folder
 * already keeps for a retired column (see `directory.ts`'s `listTeams`): a bare
 * select reads every column drizzle knows about, and since the audit columns are
 * **recorded, not published**, that would put `created_at`, `updated_at` and
 * `created_by` into `LabelledWorkItem` — which `listByProject` spreads straight
 * into its answer — and from there into the plan payload. The declared return
 * types check the list is complete.
 */
export const WORK_ITEM_COLUMNS = {
  id: workItem.id,
  projectId: workItem.projectId,
  parentId: workItem.parentId,
  position: workItem.position,
  name: workItem.name,
  notes: workItem.notes,
  frozenNumber: workItem.frozenNumber,
  startNoEarlierThan: workItem.startNoEarlierThan,
  startNoEarlierThanReason: workItem.startNoEarlierThanReason,
  // Named here the moment the column became writable, not later: `remove`'s
  // `restore_subtree` inverse journals `rowOf(rows, …)` — whole rows off this
  // very projection — so a column missing from this list is a column an undo of
  // a delete puts back as null. `tasks.md` 1.3 made that a precondition of the
  // write path rather than a follow-up to it.
  deadline: workItem.deadline,
  priority: workItem.priority,
  serviceTeamId: workItem.serviceTeamId,
  serviceId: workItem.serviceId,
  maxParallel: workItem.maxParallel,
  revision: workItem.revision,
};

/**
 * Every method that writes more than one row does so in one transaction.
 *
 * The reason is the derived number: two siblings sharing a position, or a child
 * pointing at a parent that is already gone, both produce a tree that cannot be
 * numbered. A reader landing between two separate writes would see that state
 * and have no way to tell it from the truth.
 *
 * **Revisions move in the `SET` of the statement that changes the row**, never
 * in a second statement afterwards. A respaced sibling is the one write here
 * that does not move one: its `position` changed, and position is storage
 * detail — see the column's JSDoc in `schema.ts` for why the derived number is
 * deliberately outside what a revision covers.
 */
export class WorkItemRepository implements WorkItemStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * A read per dimension rather than a left join, and merged here: a join would
   * return one row per (work item, team) pair times one per (work item, tag)
   * pair times one per (work item, service) pair, so the caller would be
   * reassembling exactly these maps out of a result set that multiplies. One
   * indexed read each, and all three label reads are empty on most plans.
   *
   * **One per dimension, and not one more per row**: the shape is a read plus a
   * `setOf` per dimension, which is linear in the dimensions and flat in the
   * rows. What it must never become is a read per row.
   *
   * Four since task 10.2, and the sentence that stood here — "still three, and
   * that is the point of storing it as a column" — was true only while a row
   * delivered one service. It delivers a set now, so the fourth read is the
   * price of the fact being multi-valued, and it is the same price the other
   * two joins pay: one indexed read, not one per row.
   *
   * Ordered by label id in every dimension, which is what makes two reads of an
   * unchanged plan answer the same arrays — design.md D6, and the property
   * `EffectiveTeams.teamIds`, `EffectiveTags.tagIds` and
   * `EffectiveServices.serviceIds` all document.
   *
   * **The work-item select is ordered by `work_item.id`, and that order is a
   * promise this method makes rather than a property of the query plan.** It is
   * load-bearing, which is why it is stated here and in the spec rather than
   * left to a reader to notice: `slicesOf` walks these rows in order and emits
   * its `slices` argument in that order, and `deriveNumbers` sorts each sibling
   * group **stably** — so for two siblings tied on `position` the array order is
   * what breaks the tie, and the derived number is the third of `goesFirst`'s
   * four tie-breaks. Unordered, two reads of an unchanged project hand Fast two
   * different argument tuples and produce two different plans.
   *
   * A tied `position` is a legal and reachable state rather than a corruption to
   * repair — `work_item_siblings` is a plain index and `placeAfter` appends
   * without a lock — and `work_item.id` is its documented resolution:
   * arbitrary, because ids are UUIDv4, but **stable**, which is the property
   * the defect was about. Why the tie is tolerated instead of constrained
   * unique, and what the one-time date movement cost: `docs/adr/0016-a-tied-sibling-position-is-legal-and-the-row-id-resolves-it.md`.
   *
   * Index-served rather than sorted: `work_item_project_id_id` —
   * `(project_id, id)` — covers this `WHERE` and this `ORDER BY` as one read.
   * `work_item_siblings` opens on `project_id` too, so the filter always
   * resolved; what did not was the sort, which SQLite spent a temp B-tree on.
   *
   * The optimized cache key is unaffected either way: `canonical-schedule-input`
   * groups slices by work item rather than hashing the array it was handed, so
   * the key does not read this order.
   */
  async listByProject(projectId: string): Promise<LabelledWorkItem[]> {
    const rows = await this.db
      .select(WORK_ITEM_COLUMNS)
      .from(workItem)
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItem.id));
    const joined = await this.db
      .select({ workItemId: workItemTeam.workItemId, teamId: workItemTeam.teamId })
      .from(workItemTeam)
      .innerJoin(workItem, eq(workItemTeam.workItemId, workItem.id))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItemTeam.teamId));
    const tagged = await this.db
      .select({ workItemId: workItemTag.workItemId, tagId: workItemTag.tagId })
      .from(workItemTag)
      .innerJoin(workItem, eq(workItemTag.workItemId, workItem.id))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItemTag.tagId));
    // The third dimension's join, read exactly as the two above it. `service_id`
    // is still on the row this `select` returns and is still ignored here: the
    // column belongs to the release that is still running (design D2), and a
    // reader that took it would answer with one service on a row that delivers
    // three.
    const serviced = await this.db
      .select({ workItemId: workItemService.workItemId, serviceId: workItemService.serviceId })
      .from(workItemService)
      .innerJoin(workItem, eq(workItemService.workItemId, workItem.id))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItemService.serviceId));
    // The fourth dimension's join, read exactly as the three above it — and the
    // only one whose result needs no walk afterwards. A type does not inherit
    // (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`), so what
    // comes back here is already the answer a reader gets, where the other three
    // are the *stated* sets that `effectiveTeamsOf` and its neighbours resolve.
    const typed = await this.db
      .select({ workItemId: workItemWorkItemType.workItemId, typeId: workItemWorkItemType.typeId })
      .from(workItemWorkItemType)
      .innerJoin(workItem, eq(workItemWorkItemType.workItemId, workItem.id))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItemWorkItemType.typeId));
    const teamsOf = new Map<string, string[]>();
    for (const each of joined) {
      teamsOf.set(each.workItemId, [...(teamsOf.get(each.workItemId) ?? []), each.teamId]);
    }
    const tagsOf = new Map<string, string[]>();
    for (const each of tagged) {
      tagsOf.set(each.workItemId, [...(tagsOf.get(each.workItemId) ?? []), each.tagId]);
    }
    const servicesOf = new Map<string, string[]>();
    for (const each of serviced) {
      servicesOf.set(each.workItemId, [...(servicesOf.get(each.workItemId) ?? []), each.serviceId]);
    }
    const typesOf = new Map<string, string[]>();
    for (const each of typed) {
      typesOf.set(each.workItemId, [...(typesOf.get(each.workItemId) ?? []), each.typeId]);
    }
    // The refs, in `position` order, which is the order they were added — the
    // one read here that is a list of records rather than of ids, because a ref
    // carries an address as well as a vocabulary name.
    const referenced = await this.db
      .select({
        id: workItemExternalRef.id,
        workItemId: workItemExternalRef.workItemId,
        systemId: workItemExternalRef.systemId,
        url: workItemExternalRef.url,
      })
      .from(workItemExternalRef)
      .innerJoin(workItem, eq(workItemExternalRef.workItemId, workItem.id))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(workItemExternalRef.position));
    const refsOf = new Map<string, ExternalRef[]>();
    for (const each of referenced) {
      refsOf.set(each.workItemId, [
        ...(refsOf.get(each.workItemId) ?? []),
        { id: each.id, systemId: each.systemId, url: each.url },
      ]);
    }
    return rows.map((row) => ({
      ...row,
      teamIds: teamsOf.get(row.id) ?? [],
      tagIds: tagsOf.get(row.id) ?? [],
      serviceIds: servicesOf.get(row.id) ?? [],
      typeIds: typesOf.get(row.id) ?? [],
      externalRefs: refsOf.get(row.id) ?? [],
    }));
  }

  async findById(id: string): Promise<WorkItem | null> {
    const rows = await this.db
      .select(WORK_ITEM_COLUMNS)
      .from(workItem)
      .where(eq(workItem.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The join row goes in with the row, in the same transaction, whenever the
   * row arrives carrying a label.
   *
   * `create` never does — a new work item is unlabelled — so this arm exists for
   * the writes that hand a whole row over: a restore, and any caller seeding a
   * plan. Leaving it out would make the column and the join disagree from the
   * row's first instant, which is the one thing {@link joinRowsFor} exists to
   * prevent.
   */
  async insert(
    toInsert: WorkItem,
    respaced: readonly Repositioned[],
    stamp: WriteStamp,
  ): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        for (const moved of respaced) {
          // A respaced sibling is stamped even though it is deliberately **not**
          // bumped — see {@link bumpedWorkItemOnReparent} for the other half. The
          // two answer different questions: `revision` is a precondition other
          // clients hold, so moving it for a shift nobody asked about would defeat
          // their edits, while `updated_at` is a record of what was written and
          // this row's `position` column was written. A row whose column changed
          // and whose `updated_at` did not is a row the audit trail lies about.
          tx.update(workItem)
            .set({ position: moved.position, ...auditOnUpdate(stamp) })
            .where(eq(workItem.id, moved.id))
            .run();
        }
        tx.insert(workItem)
          .values({ ...toInsert, ...auditOnCreate(stamp) })
          .run();
        const joined = joinRowsFor([toInsert]);
        if (joined.length > 0)
          tx.insert(workItemTeam)
            .values(joined.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
      });
    });
  }

  /**
   * Applies the patch, and reads any `serviceTeamId` it names **in the same
   * transaction as the `UPDATE`**.
   *
   * The check and the write cannot be pulled apart, and that is the whole point
   * of it living here. A service-level precheck followed by the update is two
   * statements with a delete-sized gap between them: the check passes for a
   * team removed inside it, and the update then fails on the column's own
   * foreign key — a raw `FOREIGN KEY constraint failed`, which is a 500 for a
   * request whose only fault is being out of date.
   *
   * That the column has a foreign key at all was measured on 2026-08-14 and is
   * the opposite of what this comment claimed; see {@link WorkItemPatched}. The
   * refusal below is the right answer under either reading, which is why the
   * behaviour is unchanged and only the reason is.
   *
   * Proof: with the `unknown_team` read removed, `refuses a label naming a team
   * that has been removed` fails — the work item came back carrying the dead
   * id, which is the dangle this exists to prevent; watched 2026-08-09.
   */
  async patch(id: string, patch: WorkItemPatch, stamp: WriteStamp): Promise<WorkItemPatched> {
    return await this.gate.enter(async () => {
      if (
        patch.name === undefined &&
        patch.notes === undefined &&
        patch.startNoEarlierThan === undefined &&
        // Proof: this line deleted, so a patch naming only the reason is taken as
        // naming nothing — **19 pass, 2 fail**. `writes a reason beside the date
        // it explains` failed on `Expected: "waiting on client sign-off" /
        // Received: null`, which is the write path silently doing nothing while
        // every face reports success; and `refuses a reason with no date to be
        // about` failed with it, because the branch this line guards returns
        // before the transaction the pair rule lives in. Watched 2026-08-18.
        patch.startNoEarlierThanReason === undefined &&
        // Proof: this line deleted, so a patch naming only the deadline is taken
        // as naming nothing — the store answers `ok` with the row it read and the
        // column is never written. Watched with `writes a deadline and reads it
        // back` failing on `Expected: "2026-03-31" / Received: null`, which is
        // the not-before line's own red one column over.
        patch.deadline === undefined &&
        patch.priority === undefined &&
        patch.serviceTeamId === undefined &&
        patch.teamIds === undefined &&
        // Proof: this line deleted, so a patch naming only the service takes the
        // no-field branch, writes nothing and answers `ok` with the row it found
        // — every face reporting a write that never happened, which is the tag
        // line's own red one dimension over. Watched 2026-08-21; see the log.
        patch.serviceIds === undefined &&
        patch.maxParallel === undefined &&
        // Proof: this line missing is how the tag write path was first written,
        // and all six cases in `a tag set is undone whole, which a scalar habit
        // would not do` failed — the first read is `expected [ "…" ] to deeply
        // equal []`. A patch naming only the tags took this branch, wrote
        // nothing, and answered `ok` with the row it had found: every face
        // reporting a successful write that never happened. Found by the tests
        // rather than by reading, 2026-08-19.
        patch.tagIds === undefined &&
        // Proof: this line deleted and `a type set is undone whole` fails on
        // `expected [] to deeply equal [ "…" ]` — a patch naming only the types
        // takes the no-field branch, writes nothing and answers `ok` with the row
        // it found, every face reporting a write that never happened. The tag
        // line's own red, one dimension over, and the third time this exact
        // omission has been made in this condition. Watched 2026-08-30.
        patch.typeIds === undefined &&
        // Proof: this line deleted and `a ref list is undone whole` fails at its
        // `expectDone` — a patch naming only the refs takes the no-field branch,
        // writes nothing and answers `ok` with the row it found. The tag line's
        // own red, a third time in this one condition.
        patch.externalRefs === undefined
      ) {
        const found = await this.findById(id);
        return found === null ? { ok: false, reason: 'not_found' } : { ok: true, workItem: found };
      }
      await Promise.resolve();
      // `max_parallel` is `NOT NULL`, and `null` on the patch means **back to
      // one at a time** rather than "no answer": 1 and unset are the same fact,
      // which is why the column has a default instead of being nullable. Spread
      // as it arrives it would reach SQLite as a null and fail the constraint.
      //
      // Proof: this normalisation replaced by the plain `...patch` spread and
      // `puts a reset to one at a time back to the number it replaced` failed on
      // `SQLiteError: NOT NULL constraint failed: work_item.max_parallel` —
      // a 500 for a request that means "one at a time"; watched 2026-08-12.
      //
      // `tagIds` comes off the same way and for a blunter reason: there is no
      // column for it. Spread into the `SET` it would reach drizzle as a field
      // `work_item` does not have — the set lives in `work_item_tag` and is
      // written below, in this same transaction.
      // It is bound rather than discarded because the transaction below writes it:
      // one destructure both keeps it out of the `SET` and names the set to write.
      //
      // `serviceIds` joins it since task 10.2, and its column-shaped predecessor
      // came off this line the other way round: `serviceId` was spread into the
      // `SET` because it *was* a column. There is still a `work_item.service_id`
      // and it must not be reached by this `SET` any more — the field naming it is
      // gone from the patch, so the only way one could arrive is a caller inventing
      // it, and drizzle would refuse that.
      const {
        maxParallel,
        teamIds: wantedTeams,
        tagIds: wantedTags,
        serviceIds: wantedServices,
        // Off the `SET` for `tagIds`' blunter reason: there is no column for it
        // either. `work_item_work_item_type` is the whole of the fact.
        typeIds: wantedTypes,
        // Off the `SET` for `tagIds`' reason: `work_item_external_ref` is the whole
        // of the fact and there is no column for it.
        externalRefs: wantedRefs,
        ...fields
      } = patch;
      const written =
        maxParallel === undefined ? fields : { ...fields, maxParallel: maxParallel ?? 1 };
      return this.db.transaction((tx) => {
        const normalizedTeams =
          wantedTeams === undefined ? undefined : [...new Set(wantedTeams)].sort();
        // The not-before pair as the row will stand, and the one pair it may not
        // stand in. Asked here rather than at the service for `unknown_team`'s
        // reason below it: a check one statement earlier is a check with a
        // concurrent write's worth of gap in front of the `UPDATE` it guards, and
        // a patch clearing the date inside that gap leaves exactly the row this
        // refuses. There is no constraint behind it — the migration argues why a
        // `CHECK` on this table would 500 the outgoing release mid-swap — so this
        // is the whole of the guarantee.
        //
        // Only when the patch names one of the two. A rename, a priority or a
        // label reads nothing extra, which is what keeps every write that existed
        // before this column at the statement count it had.
        if (
          patch.startNoEarlierThan !== undefined ||
          patch.startNoEarlierThanReason !== undefined
        ) {
          const stored = tx
            .select({
              startNoEarlierThan: workItem.startNoEarlierThan,
              startNoEarlierThanReason: workItem.startNoEarlierThanReason,
            })
            .from(workItem)
            .where(eq(workItem.id, id))
            .all()
            .at(0);
          // A row that is not there is `not_found`, answered by the update's own
          // empty `returning()` below — there is no pair here to have an opinion
          // about.
          if (stored !== undefined) {
            const willStand = mergedNotBefore(stored, patch);
            // Proof: this refusal deleted — **19 pass, 2 fail** — and both
            // `refuses a reason with no date to be about` and `refuses a date
            // cleared out from under the words beside it` failed on
            // `Expected: false, Received: true`: the row stored and returned
            // carrying words about a floor it does not have, which no face can
            // show and nothing can clear. Watched 2026-08-18.
            if (isOrphanedNotBeforeReason(willStand.date, willStand.reason)) {
              return { ok: false, reason: 'not_before_reason_needs_a_date' };
            }
          }
        }
        const wanted = patch.serviceTeamId;
        if (normalizedTeams !== undefined && normalizedTeams.length > 0) {
          const held = tx
            .select({ id: serviceTeam.id })
            .from(serviceTeam)
            .where(inArray(serviceTeam.id, normalizedTeams))
            .all();
          if (held.length !== normalizedTeams.length) {
            return { ok: false, reason: 'unknown_team' };
          }
        }
        // `null` takes the label off and names no team, so there is nothing to
        // read; only a non-null id can be one the directory has lost.
        if (wanted !== undefined && wanted !== null) {
          const held = tx
            .select({ id: serviceTeam.id })
            .from(serviceTeam)
            .where(eq(serviceTeam.id, wanted))
            .all();
          if (held.length === 0) return { ok: false, reason: 'unknown_team' };
        }
        // The third dimension's, in the same shape and the same transaction, and
        // read against the set rather than the column since task 10.2.
        //
        // The argument for reading it here got *stronger* with the join table, and
        // the comment that stood here said the opposite: while the column carried
        // the fact, its own foreign key would have answered `FOREIGN KEY
        // constraint failed` for an unknown id, so this read only made the answer
        // readable. `work_item_service.service_id` cascades instead, so a service
        // removed between a precheck and this write leaves nothing to catch on the
        // way in — the same hole `unknown_tag` is read for, one dimension over.
        //
        // The whole patch is refused, rename included: a request naming a service
        // that is gone is out of date about the thing it is editing, and writing
        // half of it would leave the caller to work out which half.
        //
        // An empty set names nothing and so can name nothing missing, which is why
        // the read is skipped for it rather than run against `IN ()` — SQLite
        // refuses that, and the tag arm below has the same guard for it.
        if (wantedServices !== undefined && wantedServices.length > 0) {
          const held = tx
            .select({ id: service.id })
            .from(service)
            .where(inArray(service.id, [...wantedServices]))
            .all();
          // Counted against the **distinct** ids asked for, `unknown_tag`'s rule:
          // a payload naming one service twice is one service, and the raw length
          // would refuse a request whose only fault is repetition.
          if (held.length < new Set(wantedServices).size) {
            return { ok: false, reason: 'unknown_service' };
          }
        }
        // The other dimension's refusal, read in this transaction for
        // `unknown_team`'s reason and one of its own: `work_item_tag.tag_id`
        // cascades, so a tag removed between a precheck and this write leaves
        // nothing for a foreign key to catch on the way in — the insert simply
        // refuses against a `tag` row that is gone, and a reader would get a 500
        // where the honest answer names the tag.
        //
        // An empty set names nothing and so can name nothing missing, which is
        // why the read is skipped for it rather than run against `IN ()` —
        // SQLite refuses that, and `directory.ts` has the same guard for the same
        // reason.
        if (wantedTags !== undefined && wantedTags.length > 0) {
          const held = tx
            .select({ id: tag.id })
            .from(tag)
            .where(inArray(tag.id, [...wantedTags]))
            .all();
          // Counted against the **distinct** ids asked for: a payload naming one
          // tag twice is one tag, and comparing against the raw length would
          // refuse a request whose only fault is repetition.
          if (held.length < new Set(wantedTags).size) return { ok: false, reason: 'unknown_tag' };
        }
        // The fourth dimension's refusal, read in this transaction for the tag's
        // reason unchanged: `work_item_work_item_type.type_id` cascades, so a type
        // removed between a precheck and this write leaves nothing for a foreign
        // key to catch, and a reader would get a 500 where the honest answer names
        // the type. The empty set is skipped rather than run against `IN ()`,
        // which SQLite refuses.
        if (wantedTypes !== undefined && wantedTypes.length > 0) {
          const held = tx
            .select({ id: workItemType.id })
            .from(workItemType)
            .where(inArray(workItemType.id, [...wantedTypes]))
            .all();
          // Counted against the **distinct** ids asked for, `unknown_tag`'s rule.
          if (held.length < new Set(wantedTypes).size) return { ok: false, reason: 'unknown_type' };
        }
        // The systems every named ref points at, refused in this transaction for
        // the tag's reason unchanged: `work_item_external_ref.system_id` cascades,
        // so a system removed between a precheck and this write leaves nothing for
        // a foreign key to catch.
        if (wantedRefs !== undefined && wantedRefs.length > 0) {
          const wantedSystems = [...new Set(wantedRefs.map((each) => each.systemId))];
          const held = tx
            .select({ id: externalSystem.id })
            .from(externalSystem)
            .where(inArray(externalSystem.id, wantedSystems))
            .all();
          if (held.length < wantedSystems.length) return { ok: false, reason: 'unknown_system' };
        }
        const rows = tx
          .update(workItem)
          .set({
            ...written,
            ...(normalizedTeams === undefined
              ? {}
              : { serviceTeamId: normalizedTeams.at(0) ?? null }),
            revision: bumpedWorkItem,
            ...auditOnUpdate(stamp),
          })
          .where(eq(workItem.id, id))
          // Named, like every read in this file and for the same reason: a bare
          // `.returning()` answers every column drizzle knows about, and this row
          // is handed back as `{ ok: true, workItem }` — so the audit columns
          // would ride a patch out to the caller. See {@link WORK_ITEM_COLUMNS}.
          .returning(WORK_ITEM_COLUMNS)
          .all();
        const updated = rows.at(0);
        if (updated === undefined) return { ok: false, reason: 'not_found' };
        // The set, written in the same transaction as the column and only when
        // the patch names the label at all — a rename must not empty the join.
        // Replace rather than merge: the write path states the whole set, and it
        // states at most one member until R2-4.
        //
        // Proof, both watched 2026-08-14. The `insert` deleted: `labels the join
        // as well as the column` and `leaves the join alone when the patch does
        // not name the label` failed on `+ []` where the join row was owed — 14
        // pass / 2 fail, and the second of those is the one that says the column
        // and the join came apart while both looked written. The `delete`
        // removed: `empties the join when the label is taken off` failed with the
        // old row still standing — 15 pass / 1 fail, a label the scheduler still
        // spends slots on and no screen shows.
        if (normalizedTeams !== undefined) {
          tx.delete(workItemTeam).where(eq(workItemTeam.workItemId, id)).run();
          if (normalizedTeams.length > 0) {
            tx.insert(workItemTeam)
              .values(
                normalizedTeams.map((teamId) => ({
                  workItemId: id,
                  teamId,
                  ...auditOnCreate(stamp),
                })),
              )
              .run();
          }
        } else if (wanted !== undefined) {
          tx.delete(workItemTeam).where(eq(workItemTeam.workItemId, id)).run();
          if (wanted !== null)
            tx.insert(workItemTeam)
              .values({ workItemId: id, teamId: wanted, ...auditOnCreate(stamp) })
              .run();
        }
        // The tag set, in the same transaction and only when the patch names the
        // dimension at all — an edit to the name must not empty the tags.
        //
        // Replace rather than merge, because the patch states the **whole** set:
        // `[]` is "no tags" and is written by the delete alone, which is the one
        // spelling of taking them off. Deduplicated on the way in: the primary
        // key would refuse a repeated pair, and a payload naming one tag twice is
        // a client being untidy rather than a request that means anything else.
        //
        // Unlike the team above there is no column beside this to keep in step —
        // `work_item_tag` is the whole of the fact — so this write has no second
        // half that can silently disagree with it.
        if (wantedTags !== undefined) {
          tx.delete(workItemTag).where(eq(workItemTag.workItemId, id)).run();
          const distinct = [...new Set(wantedTags)];
          if (distinct.length > 0) {
            tx.insert(workItemTag)
              .values(distinct.map((tagId) => ({ workItemId: id, tagId, ...auditOnCreate(stamp) })))
              .run();
          }
        }
        // The type set, written exactly as the tag set above and for its reasons:
        // the whole set, `[]` written by the delete alone, deduplicated because
        // the primary key would refuse the repeat, and no column beside it to keep
        // in step.
        //
        // What differs is only what `[]` *means* to a reader afterwards. An empty
        // tag set puts the row back to inheriting its ancestors'; an empty type
        // set is the answer — a row with no types has none
        // (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`). The write
        // is identical; the reading is not.
        if (wantedTypes !== undefined) {
          tx.delete(workItemWorkItemType).where(eq(workItemWorkItemType.workItemId, id)).run();
          const distinct = [...new Set(wantedTypes)];
          if (distinct.length > 0) {
            tx.insert(workItemWorkItemType)
              .values(
                distinct.map((typeId) => ({ workItemId: id, typeId, ...auditOnCreate(stamp) })),
              )
              .run();
          }
        }
        // The ref list, replaced whole and **positioned**, which is the one thing
        // the three label writes above do not have to do: a set has no order and a
        // list does, so the index is written rather than left to the read.
        //
        // Deduplicated **by URL**, not by the pair: two refs into one system are
        // two different links (a row may honestly name two GitHub PRs), and the
        // only untidiness worth collapsing is the same address twice. The schema
        // deliberately refuses neither, so this is where it happens.
        //
        // Ids are minted here rather than taken from the caller: a ref's identity
        // is the store's, and accepting one would let a client rewrite another
        // row's ref by naming its id.
        if (wantedRefs !== undefined) {
          tx.delete(workItemExternalRef).where(eq(workItemExternalRef.workItemId, id)).run();
          const seen = new Set<string>();
          const distinct = wantedRefs.filter((each) =>
            seen.has(each.url) ? false : (seen.add(each.url), true),
          );
          if (distinct.length > 0) {
            tx.insert(workItemExternalRef)
              .values(
                distinct.map((each, at) => ({
                  id: crypto.randomUUID(),
                  workItemId: id,
                  systemId: each.systemId,
                  url: each.url,
                  position: at,
                  ...auditOnCreate(stamp),
                })),
              )
              .run();
          }
        }
        // The service set, written exactly as the tag set above and for its
        // reasons: the whole set, `[]` written by the delete alone, deduplicated
        // because the primary key would refuse the repeat.
        //
        // `work_item.service_id` is deliberately **not** written beside it, and
        // that is the one line that makes the join authoritative (design D2 as
        // amended). The team arm above keeps its column in step because the
        // outgoing release reads that column to schedule with; nothing schedules
        // on a service, so the stale `service_id` is read by no release that
        // matters and a write here could only disagree with the set — one row's
        // worth of a fact that now has many.
        if (wantedServices !== undefined) {
          tx.delete(workItemService).where(eq(workItemService.workItemId, id)).run();
          const distinct = [...new Set(wantedServices)];
          if (distinct.length > 0) {
            tx.insert(workItemService)
              .values(
                distinct.map((serviceId) => ({
                  workItemId: id,
                  serviceId,
                  ...auditOnCreate(stamp),
                })),
              )
              .run();
          }
        }
        return { ok: true, workItem: updated };
      });
    });
  }

  async move(
    id: string,
    parentId: string | null,
    position: number,
    respaced: readonly Repositioned[],
    stamp: WriteStamp,
  ): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        for (const moved of respaced) {
          tx.update(workItem)
            .set({ position: moved.position, ...auditOnUpdate(stamp) })
            .where(eq(workItem.id, moved.id))
            .run();
        }
        tx.update(workItem)
          .set({ parentId, position, revision: bumpedWorkItem, ...auditOnUpdate(stamp) })
          .where(eq(workItem.id, id))
          .run();
      });
    });
  }

  /**
   * Freezes every number in one statement, not one per row.
   *
   * A freeze names **every** work item in the project, so the loop this replaces
   * issued 2,000 `UPDATE`s for a 2,000-row plan — inside the outer transaction
   * and therefore inside the process-wide write lock (ADR 0007), which is the
   * cost that ADR names as the first thing to revisit.
   *
   * `CASE id WHEN … THEN …` with one `IN` list is the whole of it: the numbers
   * differ per row and everything else does not, so one statement can carry all
   * of them. Built with `sql.join` rather than by concatenation — every id and
   * every number goes in as a parameter, which is what keeps a work item id from
   * being anything but a value.
   *
   * Proof: `freezes every number in a single statement` counts the statements
   * drizzle logs for a three-row freeze. With the loop restored it failed on
   * `expect(received).toHaveLength(expected)` — three where one is owed
   * (2026-09-02).
   */
  async setFrozenNumbers(updates: readonly FrozenNumber[], stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      if (updates.length === 0) return;
      const arms = updates.map(
        (update) => sql`when ${workItem.id} = ${update.id} then ${update.frozenNumber}`,
      );
      this.db.transaction((tx) => {
        tx.update(workItem)
          .set({
            frozenNumber: sql`case ${sql.join(arms, sql` `)} end`,
            revision: bumpedWorkItem,
            ...auditOnUpdate(stamp),
          })
          .where(
            inArray(
              workItem.id,
              updates.map((update) => update.id),
            ),
          )
          .run();
      });
    });
  }

  /**
   * `promoted` is applied *before* the deletion, and the whole subtree goes in
   * one `DELETE`.
   *
   * The promotions are forced by the foreign keys: a child still pointing at a
   * parent being deleted fails the constraint, so they have to land first.
   * Estimates go first for the same reason — they reference the work items
   * about to disappear.
   *
   * **The order within `ids` is not.** This used to delete one row per
   * statement, deepest first, on the reasoning that `work_item.parent_id`
   * references `work_item.id` and so a parent cannot go before its child.
   * That is true statement by statement and irrelevant inside one: SQLite
   * checks an *immediate* foreign key at the **end of the statement**, not
   * after each row, so a single `DELETE … WHERE id IN (…)` naming a parent and
   * its child is legal however SQLite happens to visit them. Measured directly
   * against a self-referencing table before this was written — ancestors-first,
   * leaves-first and with `defer_foreign_keys` all succeeded. So a subtree of
   * 2,000 rows costs one statement rather than 2,000, inside the outer
   * transaction and therefore inside the process-wide write lock (ADR 0007).
   *
   * Proof: `deletes a whole subtree in one statement` with the per-row loop
   * restored, watched failing on `expect(received).toHaveLength(expected)` ·
   * `Expected length: 2` · `Received length: 4` (2026-09-02).
   */
  async remove(
    ids: readonly string[],
    promoted: readonly Reparented[],
    stamp: WriteStamp,
  ): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      if (ids.length === 0) return;
      this.db.transaction((tx) => {
        for (const child of promoted) {
          // A promoted child gained a new parent, which is a change to its own
          // stored fields. Its former siblings are in this same list and gained
          // only a position, which is not — see {@link bumpedWorkItemOnReparent}.
          tx.update(workItem)
            .set({
              parentId: child.parentId,
              position: child.position,
              revision: bumpedWorkItemOnReparent(child.parentId),
              ...auditOnUpdate(stamp),
            })
            .where(eq(workItem.id, child.id))
            .run();
        }
        tx.delete(estimate).where(inArray(estimate.workItemId, ids)).run();
        tx.delete(workItem).where(inArray(workItem.id, ids)).run();
      });
    });
  }
}

/**
 * Writes a duplicated subtree, across the four tables it lives in, at once.
 *
 * Its own class rather than a method on {@link WorkItemRepository} because the
 * transaction is genuinely wider than the work item table: hiding an estimate
 * and dependency write inside the work item store would put them where nobody
 * looking for them would find them. It is not, however, novel — `remove` above
 * already deletes from `estimate` in its own transaction, for the same reason
 * the foreign keys give: the writes are one act or neither.
 *
 * See `openspec/changes/duplicate-subtree/design.md` for why the alternative —
 * atomic rows, then the other three stores in order — was rejected.
 */
export class SubtreeRepository implements SubtreeStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * The statement order is forced by the foreign keys, not chosen: rows before
   * anything that references them, the reparenting after the rows it points
   * at exist, and the dependencies last because each references two.
   *
   * **Which revisions move, and which do not.** Every row in `rows` is written
   * for the first time and arrives at whatever revision the caller decided — 0
   * for a copy, which has never been changed since it came into existence, and
   * 0 again for a restore, because a row that has been away and come back is
   * new to every reader holding a number for it. The estimates, assignments
   * and edges belong to those rows, so counting them would count the act of
   * coming into existence as a change to something.
   *
   * `reparented` and `removedEstimates` do move revisions, and must: they are
   * writes to rows that were already there and that somebody may be holding a
   * revision of. `bumpedWorkItemOnReparent` is what keeps a row that only
   * changed position out of that — the same rule as everywhere else here.
   *
   * `async` is load-bearing, as it is in `ProjectRepository.create`:
   * `db.transaction` is synchronous, so without it a constraint violation
   * would throw before the promise this signature advertises exists, and a
   * caller holding it with `.catch()` would never see the rejection.
   */
  async insertSubtree(copy: SubtreeCopy, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        for (const moved of copy.respaced) {
          tx.update(workItem)
            .set({ position: moved.position, ...auditOnUpdate(stamp) })
            .where(eq(workItem.id, moved.id))
            .run();
        }
        // One statement per row rather than one multi-row insert: a child
        // referencing a parent in the same `VALUES` list depends on the order
        // SQLite evaluates it in, which is not a contract worth resting a tree on.
        for (const row of copy.rows) {
          const stored = { ...row };
          Reflect.deleteProperty(stored, 'teamIds');
          tx.insert(workItem)
            .values({ ...stored, ...auditOnCreate(stamp) })
            .run();
        }
        // The teams the copied rows carry, in the same transaction as the rows.
        // A duplicated branch draws from the pools the original drew from, and a
        // restored one comes back on the pool it left — the join rows of a
        // deleted work item went with it through the cascade, so a restore that
        // wrote only the column would put the rows back unpooled and move dates
        // nobody edited.
        //
        // Proof: this write deleted and `carries the teams of every row a copy
        // writes` failed on `Expected - 4 / Received + 0` — the copy landed with
        // no team at all — 15 pass / 1 fail; watched 2026-08-14.
        const joined = joinRowsFor(copy.rows);
        if (joined.length > 0)
          tx.insert(workItemTeam)
            .values(joined.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // After the rows, because these point at them. A restored parent's
        // children come home here, and a row that gained a parent gained a
        // stored field of its own — see {@link bumpedWorkItemOnReparent} for why
        // the former siblings alongside them do not count.
        for (const child of copy.reparented) {
          tx.update(workItem)
            .set({
              parentId: child.parentId,
              position: child.position,
              revision: bumpedWorkItemOnReparent(child.parentId),
              ...auditOnUpdate(stamp),
            })
            .where(eq(workItem.id, child.id))
            .run();
        }
        if (copy.estimates.length > 0)
          tx.insert(estimate)
            .values(copy.estimates.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // Beside the estimates and written the same way. Empty for a duplication
        // — a copy is work nobody has done — and non-empty for the restore an
        // undo of a delete runs, which has to put back the days the delete took
        // with the rows. See {@link SubtreeCopy.actuals}.
        if (copy.actuals.length > 0)
          tx.insert(actual)
            .values(copy.actuals.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // Beside the actuals and for the same two reasons: empty for a
        // duplication, because a copy is work nobody has done *or spoken about*,
        // and non-empty for the restore an undo of a delete runs, which has to put
        // back the reading the delete took with the rows. See
        // {@link SubtreeCopy.progress}.
        if (copy.progress.length > 0)
          tx.insert(stepProgress)
            .values(copy.progress.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // Beside the two above, and the one write here whose emptiness is not a
        // whole-collection decision: a duplication fills this with the original's
        // `token_estimate` rows and none of its recorded figures, a restore fills
        // it in every metric. The rule runs through the collection rather than
        // around it, because the metric is in the key. See
        // {@link SubtreeCopy.measures}.
        if (copy.measures.length > 0)
          tx.insert(stepMeasure)
            .values(copy.measures.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        if (copy.assignments.length > 0)
          tx.insert(assignment)
            .values(copy.assignments.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // Plain inserts, never `onConflictDoNothing`: every id here was generated
        // for this copy, so a conflict is an id collision and swallowing it would
        // hide the one thing that must never be quiet.
        if (copy.dependencies.length > 0)
          tx.insert(dependency)
            .values(copy.dependencies.map((each) => ({ ...each, ...auditOnCreate(stamp) })))
            .run();
        // Last, and in the same transaction as the rows that make it correct: a
        // restored leaf and the parent still holding that leaf's figures would
        // count the same days twice for as long as the window lasted.
        for (const taken of copy.removedEstimates) {
          tx.delete(estimate)
            .where(
              and(eq(estimate.workItemId, taken.workItemId), eq(estimate.stepId, taken.stepId)),
            )
            .run();
        }
        // The same statement for the same reason, one table over: a restored leaf
        // and the parent still holding that leaf's recorded days would count the
        // same week twice.
        for (const taken of copy.removedActuals) {
          tx.delete(actual)
            .where(and(eq(actual.workItemId, taken.workItemId), eq(actual.stepId, taken.stepId)))
            .run();
        }
        // And the statements, for the reason above in the tense this table is
        // about: a restored leaf and the parent still saying that leaf's work is
        // finished would report the same branch as done twice, on two rows, one of
        // which is now a parent whose reading is supposed to be folded.
        for (const taken of copy.removedProgress) {
          tx.delete(stepProgress)
            .where(
              and(
                eq(stepProgress.workItemId, taken.workItemId),
                eq(stepProgress.stepId, taken.stepId),
              ),
            )
            .run();
        }
        // And the figures, for the reason above in every unit that is not days —
        // with the metric in the `where`, because the key is the triple. Deleting
        // by the pair would take a figure off the parent that this restore never
        // handed it: an hours fact it has held since before the delete, gone
        // because a token estimate came home.
        for (const taken of copy.removedMeasures) {
          tx.delete(stepMeasure)
            .where(
              and(
                eq(stepMeasure.workItemId, taken.workItemId),
                eq(stepMeasure.stepId, taken.stepId),
                eq(stepMeasure.metric, taken.metric),
              ),
            )
            .run();
        }
        bumpWorkItems(
          tx,
          [
            ...copy.removedEstimates.map((taken) => taken.workItemId),
            ...copy.removedActuals.map((taken) => taken.workItemId),
            ...copy.removedProgress.map((taken) => taken.workItemId),
            ...copy.removedMeasures.map((taken) => taken.workItemId),
          ],
          stamp,
        );
      });
    });
  }
}
