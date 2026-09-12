import type {
  DirectoryStore,
  ExternalRef,
  FrozenNumber,
  Repositioned,
  WorkItem,
  WorkItemStore,
  WriteStamp,
} from '@wbs/core';
import { isOrphanedNotBeforeReason } from '@wbs/domain';

export interface MemoryWorkItemTables {
  readonly byId: Map<string, WorkItem>;
  readonly teamsOf: Map<string, readonly string[]>;
  readonly tagsOf: Map<string, readonly string[]>;
  readonly servicesOf: Map<string, readonly string[]>;
  readonly typesOf: Map<string, readonly string[]>;
  readonly refsOf: Map<string, readonly ExternalRef[]>;
}

export function memoryWorkItemTables(): MemoryWorkItemTables {
  return {
    byId: new Map(),
    teamsOf: new Map(),
    tagsOf: new Map(),
    servicesOf: new Map(),
    typesOf: new Map(),
    refsOf: new Map(),
  };
}

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
   *
   * The **service** is checked the same way and against the same directory. It
   * is checked here rather than left to a foreign key because this store has
   * none: production reads `service` inside the patch's own transaction and
   * answers `unknown_service`, and a fixture that accepted any id at all would
   * let a route's 404 arm pass untested — which it did, for one chunk, and
   * `work-item.controller.test.ts` said so out loud until this line existed.
   */
  teams?: Pick<DirectoryStore, 'listTeams' | 'listServices'>,
  tables: MemoryWorkItemTables = memoryWorkItemTables(),
): WorkItemStore {
  const { byId, teamsOf, tagsOf, servicesOf, typesOf, refsOf } = tables;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  /**
   * The teams each work item is joined to, held apart from the row exactly as
   * `work_item_team` is held apart from `work_item`.
   *
   * Derived on write from the label being written rather than on read from the
   * label stored, and the difference is the whole point: a fixture that
   * answered `[serviceTeamId]` on read could never see a write path that
   * forgets the join, which is the fault the real repository's tests inject.
   */
  /**
   * The tags each work item is joined to, held apart from the row for
   * `teamsOf`'s reason — and unlike the teams, with no column to derive from.
   * A tag set arrives on the patch and nowhere else, so this map is written only
   * where the patch names one.
   */
  /**
   * The service sets, `tagsOf`'s shape and for its reason: since task 10.2 the
   * dimension is `work_item_service` and there is no column to derive it from.
   * `work_item.service_id` is still on the row below and is still written by
   * this fixture, exactly as the real store leaves it standing — and, exactly as
   * the real store, nothing here reads it back.
   */
  /**
   * The type sets, `servicesOf`'s shape and for its reason: no column to derive
   * from, so a type set arrives on the patch and nowhere else.
   *
   * Unlike the three above it, what this map holds is the *whole* answer rather
   * than the stated half of one — a type does not inherit
   * (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`), so no walk
   * stands between this and what a reader sees.
   */
  /**
   * The refs each work item carries, in order — `servicesOf`'s shape, holding
   * records rather than ids because a ref is a vocabulary name plus an address.
   */

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
          .map((row) =>
            structuredClone({
              ...row,
              teamIds: teamsOf.get(row.id) ?? [],
              tagIds: tagsOf.get(row.id) ?? [],
              serviceIds: servicesOf.get(row.id) ?? [],
              typeIds: typesOf.get(row.id) ?? [],
              externalRefs: refsOf.get(row.id) ?? [],
            }),
          ),
      );
    },
    findById(id) {
      const found = byId.get(id);
      return Promise.resolve(found === undefined ? null : structuredClone(found));
    },
    insert(workItem, respaced, _stamp) {
      reposition(respaced);
      byId.set(workItem.id, structuredClone(workItem));
      teamsOf.set(workItem.id, joinFor(workItem));
      return Promise.resolve();
    },
    async patch(id, patch, _stamp) {
      const existing = byId.get(id);
      if (existing === undefined) return { ok: false, reason: 'not_found' };
      const wanted = patch.serviceTeamId;
      const wantedTeamIds = patch.teamIds;
      if (
        teams !== undefined &&
        (wantedTeamIds !== undefined || (wanted !== undefined && wanted !== null))
      ) {
        const held = await teams.listTeams();
        const named = wantedTeamIds ?? (wanted === null || wanted === undefined ? [] : [wanted]);
        if ([...new Set(named)].some((id) => !held.some((each) => each.id === id))) {
          return { ok: false, reason: 'unknown_team' };
        }
      }
      const wantedServices = patch.serviceIds;
      if (teams !== undefined && wantedServices !== undefined && wantedServices.length > 0) {
        const held = await teams.listServices();
        // Every named id, and counted against the **distinct** ones — the real
        // store's rule, mirrored so a repeated id passes here exactly as it
        // passes there. One unknown member refuses the whole patch.
        const distinct = new Set(wantedServices);
        if ([...distinct].some((each) => !held.some((one) => one.id === each))) {
          return { ok: false, reason: 'unknown_service' };
        }
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
        deadline: patch.deadline === undefined ? existing.deadline : patch.deadline,
        priority: patch.priority === undefined ? existing.priority : patch.priority,
        serviceTeamId:
          wantedTeamIds !== undefined
            ? ([...new Set(wantedTeamIds)].sort().at(0) ?? null)
            : patch.serviceTeamId === undefined
              ? existing.serviceTeamId
              : patch.serviceTeamId,
        // **Left where it stands**, which is task 10.2's rule and the reverse of
        // what this line used to do: the column is the outgoing release's copy
        // and the join is the fact, so a patch moves the set and never this.
        // Writing it from the patch would make the fixture laxer than the store
        // in the direction that matters least and stricter in the one that
        // matters most — a test could watch the column follow a set it cannot
        // hold.
        serviceId: existing.serviceId,
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
      if (wantedTeamIds !== undefined) {
        teamsOf.set(id, [...new Set(wantedTeamIds)].sort());
      } else if (patch.serviceTeamId !== undefined) {
        teamsOf.set(id, joinFor(updated));
      }
      // The service set, whole and deduplicated, only where the patch names the
      // dimension — the real store's write, mirrored. `[]` is written as an
      // empty set rather than a delete so a later read answers the same either
      // way, which is what `listByProject`'s `?? []` above already means.
      if (wantedServices !== undefined) servicesOf.set(id, [...new Set(wantedServices)]);
      // The type set, whole and deduplicated, only where the patch names the
      // dimension — the real store's write, mirrored, `wantedServices`' line
      // exactly.
      const wantedTypes = patch.typeIds;
      if (wantedTypes !== undefined) typesOf.set(id, [...new Set(wantedTypes)]);
      // The ref list, whole and in order, only where the patch names it — the
      // real store's write mirrored, ids minted here as they are there.
      const wantedRefs = patch.externalRefs;
      if (wantedRefs !== undefined) {
        refsOf.set(
          id,
          wantedRefs.map((each) => ({ id: crypto.randomUUID(), ...each })),
        );
      }
      return { ok: true, workItem: updated };
    },
    move(id, parentId, position, respaced, _stamp) {
      const existing = byId.get(id);
      if (existing === undefined) throw new Error(`cannot move unknown ${id}`);
      reposition(respaced);
      byId.set(id, { ...existing, parentId, position });
      return Promise.resolve();
    },
    setPositions(placements: readonly Repositioned[], _moved: readonly string[], _stamp) {
      // `moved` decides revisions, and this fixture keeps none — `reposition`
      // is the same helper `move` uses for its respaced siblings.
      reposition(placements);
      return Promise.resolve();
    },
    setFrozenNumbers(updates: readonly FrozenNumber[], _stamp: WriteStamp) {
      for (const update of updates) {
        const existing = byId.get(update.id);
        if (existing === undefined) throw new Error(`cannot freeze unknown ${update.id}`);
        byId.set(update.id, { ...existing, frozenNumber: update.frozenNumber });
      }
      return Promise.resolve();
    },
    remove(ids, promoted, _stamp) {
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
        servicesOf.delete(id);
        typesOf.delete(id);
        refsOf.delete(id);
      }
      return Promise.resolve();
    },
  };
}
