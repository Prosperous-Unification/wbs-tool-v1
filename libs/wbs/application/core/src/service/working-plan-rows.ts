import type { WorkItemStore } from '../ports/work-item-store';

interface RetainedWorkItemReads {
  all(): ReturnType<WorkItemStore['listByProject']>;
  byIds(ids: readonly string[]): ReturnType<WorkItemStore['listByIds']>;
  placements(ids: readonly string[]): ReturnType<WorkItemStore['listPlacements']>;
}

/**
 * Builds the work-item part of a batch-owned working plan.
 *
 * Successful row mutations refresh every directly or structurally affected
 * identity before resolving. Refused patches leave the retained rows exactly
 * as they were before the store call.
 */
export function createWorkingPlanRows(
  source: () => WorkItemStore,
  reads: RetainedWorkItemReads,
  assertOpen: () => void,
  refreshRows: (ids: readonly string[], insertedIds?: readonly string[]) => Promise<void>,
): WorkItemStore {
  const guarded =
    <Arguments extends readonly unknown[], Value>(
      operation: (...parameters: Arguments) => Promise<Value>,
    ): ((...parameters: Arguments) => Promise<Value>) =>
    (...parameters) => {
      assertOpen();
      return operation(...parameters);
    };

  return {
    listByProject: async () => reads.all(),
    listByIds: async (_projectId, ids) => reads.byIds(ids),
    listPlacements: async (_projectId, ids) => reads.placements(ids),
    findById: guarded((id) => source().findById(id)),
    insert: guarded(async (workItem, respaced, stamp) => {
      await source().insert(workItem, respaced, stamp);
      await refreshRows(
        [
          workItem.id,
          ...(workItem.parentId === null ? [] : [workItem.parentId]),
          ...respaced.map(({ id }) => id),
        ],
        [workItem.id],
      );
    }),
    patch: guarded(async (id, patch, stamp) => {
      const written = await source().patch(id, patch, stamp);
      if (written.ok) await refreshRows([id]);
      return written;
    }),
    move: guarded(async (id, parentId, position, respaced, stamp) => {
      const moving = (await reads.byIds([id])).at(0);
      await source().move(id, parentId, position, respaced, stamp);
      await refreshRows([
        id,
        ...(moving?.parentId === null || moving?.parentId === undefined ? [] : [moving.parentId]),
        ...(parentId === null ? [] : [parentId]),
        ...respaced.map(({ id: respacedId }) => respacedId),
      ]);
    }),
    setPositions: guarded(async (placements, moved, stamp) => {
      await source().setPositions(placements, moved, stamp);
      // Proof: removing this refresh made the runner regression freeze B="020",
      // A="010" after setPositions had stored B@10, A@20.
      await refreshRows(placements.map(({ id }) => id));
    }),
    setFrozenNumbers: guarded(async (updates, stamp) => {
      await source().setFrozenNumbers(updates, stamp);
      await refreshRows(updates.map(({ id }) => id));
    }),
    remove: guarded(async (ids, promoted, stamp) => {
      const before = await reads.byIds([...ids, ...promoted.map(({ id }) => id)]);
      await source().remove(ids, promoted, stamp);
      await refreshRows([
        ...ids,
        ...promoted.map(({ id }) => id),
        ...before.flatMap(({ parentId }) => (parentId === null ? [] : [parentId])),
        ...promoted.flatMap(({ parentId }) => (parentId === null ? [] : [parentId])),
      ]);
    }),
  };
}
