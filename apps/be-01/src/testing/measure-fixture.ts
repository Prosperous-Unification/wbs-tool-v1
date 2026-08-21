import type { MeasureStore, StoredMeasure, WorkItemStore } from '../repository';

/**
 * A MeasureStore backed by an array, keyed as the composite primary key is —
 * the pair **and the metric**, which is the one line that differs from
 * `inMemoryActuals` and the whole point of the table.
 */
export function inMemoryMeasures(workItems: WorkItemStore): MeasureStore {
  let rows: StoredMeasure[] = [];

  return {
    async listByProject(projectId) {
      const ids = new Set((await workItems.listByProject(projectId)).map((w) => w.id));
      return rows.filter((row) => ids.has(row.workItemId));
    },
    set(toSet) {
      rows = rows.filter(
        (row) =>
          !(
            row.workItemId === toSet.workItemId &&
            row.roleId === toSet.roleId &&
            row.metric === toSet.metric
          ),
      );
      rows.push(toSet);
      return Promise.resolve();
    },
    remove(workItemId, roleId, metric) {
      rows = rows.filter(
        (row) => !(row.workItemId === workItemId && row.roleId === roleId && row.metric === metric),
      );
      return Promise.resolve();
    },
    moveAll(fromWorkItemId, toWorkItemId) {
      rows = rows.map((row) =>
        row.workItemId === fromWorkItemId ? { ...row, workItemId: toWorkItemId } : row,
      );
      return Promise.resolve();
    },
  };
}
