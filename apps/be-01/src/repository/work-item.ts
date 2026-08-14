import { and, eq, inArray } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type {
  FrozenNumber,
  Reparented,
  Repositioned,
  ResourceSets,
  SubtreeCopy,
  SubtreeStore,
  WorkItem,
  WorkItemPatch,
  WorkItemPatched,
  WorkItemStore,
} from './index';
import { bumpedWorkItem, bumpedWorkItemOnReparent, bumpWorkItems } from './revision';
import {
  assignment,
  dependency,
  estimate,
  serviceTeam,
  workItem,
  workItemService,
  workItemTeam,
} from './schema';

/**
 * Pairs into one list per key, keeping the order they arrive in — which the
 * statements above decide, in SQL.
 *
 * A key with no pairs is simply not in the map, which is {@link ResourceSets}'s
 * one spelling of _unstated_.
 */
function groupIds(pairs: readonly (readonly [string, string])[]): ReadonlyMap<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [key, id] of pairs) grouped.set(key, [...(grouped.get(key) ?? []), id]);
  return grouped;
}

/** Whatever can write the mirror — the process connection or a transaction on it. */
type SetWriter = Pick<SQLiteBunDatabase, 'insert' | 'delete'>;

/**
 * Puts one work item's team set where the readers read it, from the column the
 * writers still write.
 *
 * **The whole of the dual write, in one function**, and that is the point of it
 * being one: `resource-model` keeps `work_item.service_team_id` written because
 * the outgoing release selects it, and keeps `work_item_team` written because
 * this release reads it. Two spellings of one fact drift the moment they are
 * maintained in two places, and the drift would show as a plan whose labels
 * depend on which release last touched the row.
 *
 * Delete-then-insert rather than a diff: the set is capped at one member in
 * this release, so the diff would be arithmetic over a set of one. R2-4 rewrites
 * this function around the set the client sends, and this is the seam it
 * replaces.
 *
 * Called inside the caller's transaction, never beside it — a row written with
 * no set, or a set written for a row that is not there, is a foreign key
 * violation at best and a work item whose label vanished at worst.
 */
function mirrorTeam(tx: SetWriter, row: Pick<WorkItem, 'id' | 'serviceTeamId'>): void {
  tx.delete(workItemTeam).where(eq(workItemTeam.workItemId, row.id)).run();
  if (row.serviceTeamId === null) return;
  tx.insert(workItemTeam).values({ workItemId: row.id, teamId: row.serviceTeamId }).run();
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

  listByProject(projectId: string): Promise<WorkItem[]> {
    return this.db.select().from(workItem).where(eq(workItem.projectId, projectId));
  }

  /**
   * Two statements, joined back to the project through `work_item` rather than
   * filtered in memory: a plan of 500 rows would otherwise read every
   * membership row on the deployment to answer about one project's.
   *
   * Sorted in SQL, because the order reaches the wire: an unsorted read gives
   * SQLite's own row order, and two reads of an unchanged plan that came back
   * in two orders would look like an edit to every client diffing them.
   *
   * Proof: the team read pointed back at `work_item.service_team_id` — the
   * mirror the join is kept in step with, and the one substitution that leaves
   * every schedule identical — and `reads a work item's teams from the join
   * table rather than from the column` failed on `expect(received).toEqual(expected)`,
   * `undefined` where the team id was owed, alone at 13 pass / 1 fail; watched
   * 2026-08-14.
   */
  async resourceSetsOf(projectId: string): Promise<ResourceSets> {
    const teams = await this.db
      .select({ workItemId: workItemTeam.workItemId, teamId: workItemTeam.teamId })
      .from(workItemTeam)
      .innerJoin(workItem, eq(workItem.id, workItemTeam.workItemId))
      .where(eq(workItem.projectId, projectId))
      .orderBy(workItemTeam.workItemId, workItemTeam.teamId);
    const services = await this.db
      .select({ workItemId: workItemService.workItemId, serviceId: workItemService.serviceId })
      .from(workItemService)
      .innerJoin(workItem, eq(workItem.id, workItemService.workItemId))
      .where(eq(workItem.projectId, projectId))
      .orderBy(workItemService.workItemId, workItemService.serviceId);
    return {
      teamIdsOf: groupIds(teams.map((row) => [row.workItemId, row.teamId])),
      serviceIdsOf: groupIds(services.map((row) => [row.workItemId, row.serviceId])),
    };
  }

  async findById(id: string): Promise<WorkItem | null> {
    const rows = await this.db.select().from(workItem).where(eq(workItem.id, id)).limit(1);
    return rows[0] ?? null;
  }

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
      mirrorTeam(tx, toInsert);
    });
  }

  /**
   * Applies the patch, and reads any `serviceTeamId` it names **in the same
   * transaction as the `UPDATE`**.
   *
   * The check and the write cannot be pulled apart, and that is the whole point
   * of it living here. This paragraph used to say the column has no foreign key
   * — "a label is a label, not a constraint" — and **that is wrong about the
   * deployed schema**: `20260806190000_add_teams_and_assignees` writes
   * `REFERENCES service_team(id)` with no `ON DELETE`, which `schema.ts` does not
   * declare. Measured 2026-08-14; see the column's own JSDoc and
   * `resource-model`'s design.md D11. What the key does **not** do is make this
   * read redundant: it refuses a dead id at the moment of the write, and the
   * refusal it produces is an uncaught `SQLiteError`, where this answers the
   * modeled `unknown_team`. A service-level precheck followed by
   * today's unchecked update is two statements with a delete-sized gap between
   * them: the check passes for a team removed inside it, and the row then
   * carries an id the directory does not hold, for ever, with nothing anywhere
   * to report it.
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
      patch.priority === undefined &&
      patch.serviceTeamId === undefined &&
      patch.maxParallel === undefined
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
    const { maxParallel, ...fields } = patch;
    const written =
      maxParallel === undefined ? fields : { ...fields, maxParallel: maxParallel ?? 1 };
    return this.db.transaction((tx) => {
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
      const rows = tx
        .update(workItem)
        .set({ ...written, revision: bumpedWorkItem })
        .where(eq(workItem.id, id))
        .returning()
        .all();
      const updated = rows.at(0);
      if (updated === undefined) return { ok: false, reason: 'not_found' };
      // Only when the patch names the label, and **removing this condition is
      // invisible in this release** — said out loud because R5 is about exactly
      // that. `mirrorTeam` derives the set from the column, a patch that does
      // not name the label leaves the column alone, so the delete-then-insert it
      // would run on every rename writes back what was already there. There is
      // no test here that can see this line go, and none is claimed.
      //
      // It is kept for two reasons that are not safety: two statements per
      // keystroke-committed patch is a cost nothing buys, and R2-4 rewrites
      // `mirrorTeam` around the client's own set — at which point a rename that
      // rewrote the set would flatten a plural one to whatever the column holds,
      // and the line would become load-bearing with nobody having decided it
      // should be. Watched **passing** with the condition removed on 2026-08-14;
      // verify.md records it as a passing injection rather than a red.
      if (patch.serviceTeamId !== undefined) mirrorTeam(tx, updated);
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
      // The set goes with the copy, in the same statement order and the same
      // transaction: a duplicated branch whose rows carried labels and whose
      // copies did not would come back from its own `Ctrl+D` on different
      // pools, which is a date change nobody asked for.
      //
      // Proof: the mirror dropped from this loop and `duplicates a labelled
      // branch onto the same team` failed on `expect(received).toEqual(expected)`,
      // `undefined` where the copied row's team was owed; watched 2026-08-14.
      for (const row of copy.rows) {
        tx.insert(workItem).values(row).run();
        mirrorTeam(tx, row);
      }
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
      bumpWorkItems(
        tx,
        copy.removedEstimates.map((taken) => taken.workItemId),
      );
    });
  }
}
