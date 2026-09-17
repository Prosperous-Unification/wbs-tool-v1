import type { DependencyStore } from '../ports/dependency-store';

interface RetainedDependencyReads {
  all(projectId: string): ReturnType<DependencyStore['listByProject']>;
  byWorkItems(
    projectId: string,
    ids: readonly string[],
  ): ReturnType<DependencyStore['listByWorkItems']>;
}

/**
 * Builds the dependency part of a batch-owned working plan.
 *
 * A successful edge write refreshes both endpoint rows and the retained edge
 * set before resolving. Bulk removal captures every surviving endpoint before
 * the source deletes the incident edges. A source refusal or throw advances
 * nothing; errors escape to abandon the admitted unit of work.
 */
export function createWorkingPlanEdges(
  source: () => DependencyStore,
  projectId: string,
  reads: RetainedDependencyReads,
  assertOpen: () => void,
  refreshRows: (ids: readonly string[]) => Promise<void>,
): DependencyStore {
  return {
    listByProject: async (projectId) => reads.all(projectId),
    listByWorkItems: async (projectId, ids) => reads.byWorkItems(projectId, ids),
    add: async (dependency, stamp) => {
      assertOpen();
      await source().add(dependency, stamp);
      await refreshRows([dependency.predecessorId, dependency.successorId]);
    },
    remove: async (predecessorId, successorId, stamp) => {
      assertOpen();
      await source().remove(predecessorId, successorId, stamp);
      await refreshRows([predecessorId, successorId]);
    },
    removeAllFor: async (workItemIds, stamp) => {
      assertOpen();
      const doomed = new Set(workItemIds);
      const incident = await reads.byWorkItems(projectId, workItemIds);
      const survivors = incident
        .flatMap(({ predecessorId, successorId }) => [predecessorId, successorId])
        .filter((id) => !doomed.has(id));
      await source().removeAllFor(workItemIds, stamp);
      await refreshRows([...workItemIds, ...survivors]);
    },
  };
}
