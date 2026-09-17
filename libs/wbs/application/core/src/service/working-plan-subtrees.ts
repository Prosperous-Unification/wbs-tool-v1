import type { SubtreeStore } from '../ports/subtree-store';
import type { WorkItemStore } from '../ports/work-item-store';

interface RetainedSubtreeReads {
  byIds(ids: readonly string[]): ReturnType<WorkItemStore['listByIds']>;
}

/**
 * Builds the atomic subtree-write part of a batch-owned working plan.
 *
 * Reparented rows are read before persistence so both their old and new
 * parents refresh. After the source succeeds, every copied row is authorized
 * as a new retained identity and every structural, satellite-removal and edge
 * endpoint identity is refreshed before the write resolves.
 */
export function createWorkingPlanSubtrees(
  source: () => SubtreeStore,
  reads: RetainedSubtreeReads,
  assertOpen: () => void,
  refreshRows: (ids: readonly string[], insertedIds?: readonly string[]) => Promise<void>,
): SubtreeStore {
  return {
    insertSubtree: async (copy, stamp) => {
      assertOpen();
      const reparentedBefore =
        copy.reparented.length === 0 ? [] : await reads.byIds(copy.reparented.map(({ id }) => id));
      await source().insertSubtree(copy, stamp);
      const insertedIds = copy.rows.map(({ id }) => id);
      await refreshRows(
        [
          ...insertedIds,
          ...copy.rows.flatMap(({ parentId }) => (parentId === null ? [] : [parentId])),
          ...copy.respaced.map(({ id }) => id),
          ...copy.reparented.flatMap(({ id, parentId }) =>
            parentId === null ? [id] : [id, parentId],
          ),
          ...reparentedBefore.flatMap(({ parentId }) => (parentId === null ? [] : [parentId])),
          ...copy.removedEstimates.map(({ workItemId }) => workItemId),
          ...copy.removedActuals.map(({ workItemId }) => workItemId),
          ...copy.removedProgress.map(({ workItemId }) => workItemId),
          ...copy.removedMeasures.map(({ workItemId }) => workItemId),
          ...copy.dependencies.flatMap(({ predecessorId, successorId }) => [
            predecessorId,
            successorId,
          ]),
        ],
        insertedIds,
      );
    },
  };
}
