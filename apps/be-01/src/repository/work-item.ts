import { isOrphanedNotBeforeReason } from '@wbs/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type {
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
} from './index';
import { bumpedWorkItem, bumpedWorkItemOnReparent, bumpWorkItems } from './revision';
import {
  actual,
  assignment,
  dependency,
  estimate,
  roleMeasure,
  roleProgress,
  service,
  serviceTeam,
  tag,
  workItem,
  workItemService,
  workItemTag,
  workItemTeam,
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
function joinRowsFor(rows: readonly WorkItem[]): { workItemId: string; teamId: string }[] {
  return rows.flatMap((row) =>
    row.serviceTeamId === null ? [] : [{ workItemId: row.id, teamId: row.serviceTeamId }],
  );
}

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
  constructor(private readonly db: SQLiteBunDatabase) {}

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
   */
  async listByProject(projectId: string): Promise<LabelledWorkItem[]> {
    const rows = await this.db.select().from(workItem).where(eq(workItem.projectId, projectId));
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
    return rows.map((row) => ({
      ...row,
      teamIds: teamsOf.get(row.id) ?? [],
      tagIds: tagsOf.get(row.id) ?? [],
      serviceIds: servicesOf.get(row.id) ?? [],
    }));
  }

  async findById(id: string): Promise<WorkItem | null> {
    const rows = await this.db.select().from(workItem).where(eq(workItem.id, id)).limit(1);
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
  async insert(toInsert: WorkItem, respaced: readonly Repositioned[]): Promise<void> {
    await Promise.resolve();
    this.db.transaction((tx) => {
      for (const moved of respaced) {
        tx.update(workItem)
          .set({ position: moved.position })
          .where(eq(workItem.id, moved.id))
          .run();
      }
      tx.insert(workItem).values(toInsert).run();
      const joined = joinRowsFor([toInsert]);
      if (joined.length > 0) tx.insert(workItemTeam).values(joined).run();
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
  async patch(id: string, patch: WorkItemPatch): Promise<WorkItemPatched> {
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
      patch.priority === undefined &&
      patch.serviceTeamId === undefined &&
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
      patch.tagIds === undefined
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
    const { maxParallel, tagIds: wantedTags, serviceIds: wantedServices, ...fields } = patch;
    const written =
      maxParallel === undefined ? fields : { ...fields, maxParallel: maxParallel ?? 1 };
    return this.db.transaction((tx) => {
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
      if (patch.startNoEarlierThan !== undefined || patch.startNoEarlierThanReason !== undefined) {
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
      const rows = tx
        .update(workItem)
        .set({ ...written, revision: bumpedWorkItem })
        .where(eq(workItem.id, id))
        .returning()
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
      if (wanted !== undefined) {
        tx.delete(workItemTeam).where(eq(workItemTeam.workItemId, id)).run();
        if (wanted !== null)
          tx.insert(workItemTeam).values({ workItemId: id, teamId: wanted }).run();
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
            .values(distinct.map((tagId) => ({ workItemId: id, tagId })))
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
            .values(distinct.map((serviceId) => ({ workItemId: id, serviceId })))
            .run();
        }
      }
      return { ok: true, workItem: updated };
    });
  }

  async move(
    id: string,
    parentId: string | null,
    position: number,
    respaced: readonly Repositioned[],
  ): Promise<void> {
    await Promise.resolve();
    this.db.transaction((tx) => {
      for (const moved of respaced) {
        tx.update(workItem)
          .set({ position: moved.position })
          .where(eq(workItem.id, moved.id))
          .run();
      }
      tx.update(workItem)
        .set({ parentId, position, revision: bumpedWorkItem })
        .where(eq(workItem.id, id))
        .run();
    });
  }

  async setFrozenNumbers(updates: readonly FrozenNumber[]): Promise<void> {
    await Promise.resolve();
    if (updates.length === 0) return;
    this.db.transaction((tx) => {
      for (const update of updates) {
        tx.update(workItem)
          .set({ frozenNumber: update.frozenNumber, revision: bumpedWorkItem })
          .where(eq(workItem.id, update.id))
          .run();
      }
    });
  }

  /**
   * `promoted` is applied *before* the deletion, and `ids` are deleted in
   * reverse of the order given.
   *
   * Both are forced by the foreign keys. A child still pointing at a parent
   * being deleted fails the constraint, so promotions have to land first; and
   * `ids` arrive ancestors-first from `subtreeOf`, so reversing them removes
   * leaves before the parents they hang from. Estimates go first for the same
   * reason — they reference the work items about to disappear.
   */
  async remove(ids: readonly string[], promoted: readonly Reparented[]): Promise<void> {
    await Promise.resolve();
    if (ids.length === 0) return;
    const deepestFirst = [...ids].reverse();
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
          })
          .where(eq(workItem.id, child.id))
          .run();
      }
      tx.delete(estimate).where(inArray(estimate.workItemId, deepestFirst)).run();
      for (const id of deepestFirst) {
        tx.delete(workItem).where(eq(workItem.id, id)).run();
      }
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
  constructor(private readonly db: SQLiteBunDatabase) {}

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
  async insertSubtree(copy: SubtreeCopy): Promise<void> {
    await Promise.resolve();
    this.db.transaction((tx) => {
      for (const moved of copy.respaced) {
        tx.update(workItem)
          .set({ position: moved.position })
          .where(eq(workItem.id, moved.id))
          .run();
      }
      // One statement per row rather than one multi-row insert: a child
      // referencing a parent in the same `VALUES` list depends on the order
      // SQLite evaluates it in, which is not a contract worth resting a tree on.
      for (const row of copy.rows) tx.insert(workItem).values(row).run();
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
      if (joined.length > 0) tx.insert(workItemTeam).values(joined).run();
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
          })
          .where(eq(workItem.id, child.id))
          .run();
      }
      if (copy.estimates.length > 0)
        tx.insert(estimate)
          .values([...copy.estimates])
          .run();
      // Beside the estimates and written the same way. Empty for a duplication
      // — a copy is work nobody has done — and non-empty for the restore an
      // undo of a delete runs, which has to put back the days the delete took
      // with the rows. See {@link SubtreeCopy.actuals}.
      if (copy.actuals.length > 0)
        tx.insert(actual)
          .values([...copy.actuals])
          .run();
      // Beside the actuals and for the same two reasons: empty for a
      // duplication, because a copy is work nobody has done *or spoken about*,
      // and non-empty for the restore an undo of a delete runs, which has to put
      // back the reading the delete took with the rows. See
      // {@link SubtreeCopy.progress}.
      if (copy.progress.length > 0)
        tx.insert(roleProgress)
          .values([...copy.progress])
          .run();
      // Beside the two above, and the one write here whose emptiness is not a
      // whole-collection decision: a duplication fills this with the original's
      // `token_estimate` rows and none of its recorded figures, a restore fills
      // it in every metric. The rule runs through the collection rather than
      // around it, because the metric is in the key. See
      // {@link SubtreeCopy.measures}.
      if (copy.measures.length > 0)
        tx.insert(roleMeasure)
          .values([...copy.measures])
          .run();
      if (copy.assignments.length > 0)
        tx.insert(assignment)
          .values([...copy.assignments])
          .run();
      // Plain inserts, never `onConflictDoNothing`: every id here was generated
      // for this copy, so a conflict is an id collision and swallowing it would
      // hide the one thing that must never be quiet.
      if (copy.dependencies.length > 0)
        tx.insert(dependency)
          .values([...copy.dependencies])
          .run();
      // Last, and in the same transaction as the rows that make it correct: a
      // restored leaf and the parent still holding that leaf's figures would
      // count the same days twice for as long as the window lasted.
      for (const taken of copy.removedEstimates) {
        tx.delete(estimate)
          .where(and(eq(estimate.workItemId, taken.workItemId), eq(estimate.roleId, taken.roleId)))
          .run();
      }
      // The same statement for the same reason, one table over: a restored leaf
      // and the parent still holding that leaf's recorded days would count the
      // same week twice.
      for (const taken of copy.removedActuals) {
        tx.delete(actual)
          .where(and(eq(actual.workItemId, taken.workItemId), eq(actual.roleId, taken.roleId)))
          .run();
      }
      // And the statements, for the reason above in the tense this table is
      // about: a restored leaf and the parent still saying that leaf's work is
      // finished would report the same branch as done twice, on two rows, one of
      // which is now a parent whose reading is supposed to be folded.
      for (const taken of copy.removedProgress) {
        tx.delete(roleProgress)
          .where(
            and(
              eq(roleProgress.workItemId, taken.workItemId),
              eq(roleProgress.roleId, taken.roleId),
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
        tx.delete(roleMeasure)
          .where(
            and(
              eq(roleMeasure.workItemId, taken.workItemId),
              eq(roleMeasure.roleId, taken.roleId),
              eq(roleMeasure.metric, taken.metric),
            ),
          )
          .run();
      }
      bumpWorkItems(tx, [
        ...copy.removedEstimates.map((taken) => taken.workItemId),
        ...copy.removedActuals.map((taken) => taken.workItemId),
        ...copy.removedProgress.map((taken) => taken.workItemId),
        ...copy.removedMeasures.map((taken) => taken.workItemId),
      ]);
    });
  }
}
