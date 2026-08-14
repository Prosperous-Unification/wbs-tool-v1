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
import { recordingBroadcaster } from './broadcast-fixture';
import { inMemoryCommandJournal } from './command-journal-fixture';
import { inMemoryDependencies } from './dependency-fixture';
import { inMemoryEstimates } from './estimate-fixture';
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
   * The mirror, held as its own map rather than derived from `serviceTeamId` on
   * read.
   *
   * A fixture that answered `resourceSetsOf` out of the column would be a
   * fixture that cannot tell a broken mirror from a working one: every test
   * over it would pass against a repository that had stopped writing the join
   * table at all. So this is written where production writes it — inside
   * `insert` and inside the `serviceTeamId` arm of `patch` — and read where
   * production reads it.
   *
   * Services have no writer anywhere in this release, so their map is empty and
   * is deliberately not faked into existence here.
   */
  const teamIdsOf = new Map<string, string[]>();

  function mirrorTeam(row: WorkItem): void {
    if (row.serviceTeamId === null) teamIdsOf.delete(row.id);
    else teamIdsOf.set(row.id, [row.serviceTeamId]);
  }

  function reposition(updates: readonly Repositioned[]): void {
    for (const update of updates) {
      const existing = byId.get(update.id);
      if (existing === undefined) throw new Error(`cannot reposition unknown ${update.id}`);
      byId.set(update.id, { ...existing, position: update.position });
    }
  }

  return {
    listByProject(projectId) {
      return Promise.resolve([...byId.values()].filter((w) => w.projectId === projectId));
    },
    findById(id) {
      return Promise.resolve(byId.get(id) ?? null);
    },
    insert(workItem, respaced) {
      reposition(respaced);
      byId.set(workItem.id, workItem);
      mirrorTeam(workItem);
      return Promise.resolve();
    },
    resourceSetsOf(projectId) {
      const inProject = new Set(
        [...byId.values()].filter((each) => each.projectId === projectId).map((each) => each.id),
      );
      return Promise.resolve({
        teamIdsOf: new Map([...teamIdsOf].filter(([id]) => inProject.has(id))),
        serviceIdsOf: new Map<string, readonly string[]>(),
      });
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
        priority: patch.priority === undefined ? existing.priority : patch.priority,
        serviceTeamId:
          patch.serviceTeamId === undefined ? existing.serviceTeamId : patch.serviceTeamId,
        // `null` is **back to one at a time**, not "no answer": the real column
        // is `NOT NULL` and would refuse a null outright, so a fixture that
        // stored one would be laxer than the schema it stands for and would let
        // a `maxParallel: null` test pass here and fail against SQLite.
        maxParallel:
          patch.maxParallel === undefined ? existing.maxParallel : (patch.maxParallel ?? 1),
      };
      byId.set(id, updated);
      if (patch.serviceTeamId !== undefined) mirrorTeam(updated);
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
      // `ON DELETE CASCADE` in the schema, and by hand here: a work item that
      // has gone must take its label rows with it, or a later read answers for
      // a row nobody can see.
      for (const id of [...ids].reverse()) {
        byId.delete(id);
        teamIdsOf.delete(id);
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
  const dependencies = inMemoryDependencies();
  return new WorkItemService({
    workItems,
    projects: inMemoryProjects(),
    estimates,
    dependencies,
    directory,
    capacity: inMemoryCapacity(),
    subtrees: inMemorySubtrees({ workItems, estimates, dependencies, directory }),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });
}
