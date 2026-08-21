import { isOrphanedNotBeforeReason } from '@wbs/domain';

import type {
  DirectoryStore,
  FrozenNumber,
  Repositioned,
  WorkItem,
  WorkItemStore,
} from '../repository';
import { WorkItemService } from '../service/work-item.service';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryActuals } from './actual-fixture';
import { recordingBroadcaster } from './broadcast-fixture';
import { inMemoryCommandJournal } from './command-journal-fixture';
import { inMemoryDependencies } from './dependency-fixture';
import { inMemoryEstimates } from './estimate-fixture';
import { inMemoryProgress } from './progress-fixture';
import { inMemoryProjects } from './project-fixture';
import { inMemorySubtrees } from './subtree-fixture';

/**
 * A WorkItemStore backed by a Map.
 *
 * `insert`, `move` and `remove` each apply their whole argument list before
 * returning, matching the single transaction the SQLite repository runs. A
 * fixture that applied only the primary write would let a test pass while the
 * respacing that keeps siblings distinct was silently dropped.
 */
export function inMemoryWorkItems(
  /**
   * The directory a `serviceTeamId` is checked against, as production checks it
   * inside `patch`'s own transaction.
   *
   * Optional because most callers never label anything, and a fixture that
   * invented a team list would be answering a question it cannot know. Given
   * one, `patch` refuses an unknown team exactly as the repository does; without
   * one it cannot, and no test may assert that refusal through it.
   */
  teams?: Pick<DirectoryStore, 'listTeams'>,
): WorkItemStore {
  const byId = new Map<string, WorkItem>();
  /**
   * The teams each work item is joined to, held apart from the row exactly as
   * `work_item_team` is held apart from `work_item`.
   *
   * Derived on write from the label being written rather than on read from the
   * label stored, and the difference is the whole point: a fixture that
   * answered `[serviceTeamId]` on read could never see a write path that
   * forgets the join, which is the fault the real repository's tests inject.
   */
  const teamsOf = new Map<string, readonly string[]>();
  /**
   * The tags each work item is joined to, held apart from the row for
   * `teamsOf`'s reason — and unlike the teams, with no column to derive from.
   * A tag set arrives on the patch and nowhere else, so this map is written only
   * where the patch names one.
   */
  const tagsOf = new Map<string, readonly string[]>();

  /** The join rows one write owes, as `WorkItemRepository` derives them. */
  const joinFor = (row: WorkItem): readonly string[] =>
    row.serviceTeamId === null ? [] : [row.serviceTeamId];

  function reposition(updates: readonly Repositioned[]): void {
    for (const update of updates) {
      const existing = byId.get(update.id);
      if (existing === undefined) throw new Error(`cannot reposition unknown ${update.id}`);
      byId.set(update.id, { ...existing, position: update.position });
    }
  }

  return {
    listByProject(projectId) {
      return Promise.resolve(
        [...byId.values()]
          .filter((w) => w.projectId === projectId)
          .map((row) => ({
            ...row,
            teamIds: teamsOf.get(row.id) ?? [],
            tagIds: tagsOf.get(row.id) ?? [],
          })),
      );
    },
    findById(id) {
      return Promise.resolve(byId.get(id) ?? null);
    },
    insert(workItem, respaced) {
      reposition(respaced);
      byId.set(workItem.id, workItem);
      teamsOf.set(workItem.id, joinFor(workItem));
      return Promise.resolve();
    },
    async patch(id, patch) {
      const existing = byId.get(id);
      if (existing === undefined) return { ok: false, reason: 'not_found' };
      const wanted = patch.serviceTeamId;
      if (teams !== undefined && wanted !== undefined && wanted !== null) {
        const held = await teams.listTeams();
        if (!held.some((each) => each.id === wanted)) return { ok: false, reason: 'unknown_team' };
      }
      const updated: WorkItem = {
        ...existing,
        name: patch.name ?? existing.name,
        notes: patch.notes ?? existing.notes,
        startNoEarlierThan:
          patch.startNoEarlierThan === undefined
            ? existing.startNoEarlierThan
            : patch.startNoEarlierThan,
        startNoEarlierThanReason:
          patch.startNoEarlierThanReason === undefined
            ? existing.startNoEarlierThanReason
            : patch.startNoEarlierThanReason,
        priority: patch.priority === undefined ? existing.priority : patch.priority,
        serviceTeamId:
          patch.serviceTeamId === undefined ? existing.serviceTeamId : patch.serviceTeamId,
        // `null` **clears** where the parallelism below resets: the real column
        // is nullable and null is unstated, so taking the service off is a
        // value and not an absence. `?? existing` would make the two the same
        // and quietly leave the label on.
        //
        // Found by a controller test rather than by reading: without this line
        // the fixture dropped every service a patch named, so a route test
        // could watch a 200 come back and the column never move. The lax-mirror
        // fault this file's other notes warn about, one dimension over.
        serviceId: patch.serviceId === undefined ? existing.serviceId : patch.serviceId,
        // `null` is **back to one at a time**, not "no answer": the real column
        // is `NOT NULL` and would refuse a null outright, so a fixture that
        // stored one would be laxer than the schema it stands for and would let
        // a `maxParallel: null` test pass here and fail against SQLite.
        maxParallel:
          patch.maxParallel === undefined ? existing.maxParallel : (patch.maxParallel ?? 1),
      };
      // The pair rule, mirrored from `WorkItemRepository.patch` for the reason
      // the parallelism note above states: a fixture laxer than the store it
      // stands for lets a test pass here and fail against SQLite. Asked against
      // the merged row, which `updated` already is — and asked after the merge
      // rather than off the patch, because a patch naming only the reason is
      // legal on a row that has a date and illegal on one that does not.
      //
      // Proof: this refusal deleted — **85 pass, 1 fail** in
      // `work-item.service.test.ts` — and `refuses words on a row with no date,
      // through the service` failed on `Expected: false, Received: true`: the
      // fixture accepting a row the database refuses, which is the whole class
      // of fault this mirror exists to prevent. Watched 2026-08-18.
      if (isOrphanedNotBeforeReason(updated.startNoEarlierThan, updated.startNoEarlierThanReason)) {
        return { ok: false, reason: 'not_before_reason_needs_a_date' };
      }
      byId.set(id, updated);
      // Only where the patch names the label, as the repository's own
      // transaction does: a rename must leave the join alone.
      if (patch.serviceTeamId !== undefined) teamsOf.set(id, joinFor(updated));
      return { ok: true, workItem: updated };
    },
    move(id, parentId, position, respaced) {
      const existing = byId.get(id);
      if (existing === undefined) throw new Error(`cannot move unknown ${id}`);
      reposition(respaced);
      byId.set(id, { ...existing, parentId, position });
      return Promise.resolve();
    },
    setFrozenNumbers(updates: readonly FrozenNumber[]) {
      for (const update of updates) {
        const existing = byId.get(update.id);
        if (existing === undefined) throw new Error(`cannot freeze unknown ${update.id}`);
        byId.set(update.id, { ...existing, frozenNumber: update.frozenNumber });
      }
      return Promise.resolve();
    },
    remove(ids, promoted) {
      // Promotions land before the deletion, and deletion runs deepest-first,
      // because that is the order the foreign keys force on the real
      // repository. A fixture free to do it in any order would let a test pass
      // against a sequence SQLite rejects.
      for (const child of promoted) {
        const existing = byId.get(child.id);
        if (existing === undefined) throw new Error(`cannot promote unknown ${child.id}`);
        byId.set(child.id, { ...existing, parentId: child.parentId, position: child.position });
      }
      // The join rows go with the row, which is the cascade doing it in SQLite.
      for (const id of [...ids].reverse()) {
        byId.delete(id);
        teamsOf.delete(id);
      }
      return Promise.resolve();
    },
  };
}

/** A WorkItemService over in-memory stores, for tests that only need `buildApp` to construct. */
export function testWorkItemService(): WorkItemService {
  const directory = inMemoryDirectory();
  const workItems = inMemoryWorkItems(directory);
  const estimates = inMemoryEstimates(workItems);
  const actuals = inMemoryActuals(workItems);
  const progress = inMemoryProgress(workItems);
  const dependencies = inMemoryDependencies();
  return new WorkItemService({
    workItems,
    projects: inMemoryProjects(),
    estimates,
    actuals,
    progress,
    dependencies,
    directory,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    subtrees: inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      progress,
      dependencies,
      directory,
    }),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });
}
