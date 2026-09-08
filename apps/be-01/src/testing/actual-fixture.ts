import type { ActualStore, StoredActual, WorkItemStore, WriteStamp } from '../repository';

/** An ActualStore backed by an array, keyed as the composite primary key is. */
export function inMemoryActuals(
  workItems: WorkItemStore,
): ActualStore & { stampsSeen: WriteStamp[] } {
  let rows: StoredActual[] = [];
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  const stampsSeen: WriteStamp[] = [];

  return {
    stampsSeen,
    async listByProject(projectId) {
      const ids = new Set((await workItems.listByProject(projectId)).map((w) => w.id));
      return rows.filter((row) => ids.has(row.workItemId));
    },
    set(toSet, stamp) {
      stampsSeen.push(stamp);
      rows = rows.filter(
        (row) => !(row.workItemId === toSet.workItemId && row.stepId === toSet.stepId),
      );
      rows.push(toSet);
      // `'written'`, always: these fixtures enforce no references at all, so
      // they cannot tell a step that has gone from one that never existed. That
      // is the memory source lagging the SQLite one on a named method (D29),
      // and slice 5 is where it goes on the allowlist or is tightened.
      return Promise.resolve('written' as const);
    },
    remove(workItemId, stepId, stamp) {
      stampsSeen.push(stamp);
      rows = rows.filter((row) => !(row.workItemId === workItemId && row.stepId === stepId));
      return Promise.resolve();
    },
    moveAll(fromWorkItemId, toWorkItemId, stamp) {
      stampsSeen.push(stamp);
      rows = rows.map((row) =>
        row.workItemId === fromWorkItemId ? { ...row, workItemId: toWorkItemId } : row,
      );
      return Promise.resolve();
    },
  };
}
