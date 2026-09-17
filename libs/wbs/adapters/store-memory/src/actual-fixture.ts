import type { ActualStore, StepStore, StoredActual, WorkItemStore } from '@wbs/core';

import { readTargetedSatelliteRows } from './targeted-satellite-rows';
import { compareValueGroupIds, listValueGroupPlacements } from './value-group-placement';

/** An ActualStore backed by an array, keyed as the composite primary key is. */
export function inMemoryActuals(
  workItems: WorkItemStore,
  table: MemoryActualTable = memoryActualTable(),
  steps?: StepStore,
): ActualStore {
  const { rows } = table;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */

  return {
    async listByProject(projectId) {
      const ids = new Set((await workItems.listByProject(projectId)).map((w) => w.id));
      return order(
        rows.filter((row) => ids.has(row.workItemId)),
        await steps?.listByProject(projectId),
      );
    },
    async listByWorkItems(projectId, workItemIds) {
      const targeted = await readTargetedSatelliteRows(
        'actual',
        rows,
        projectId,
        workItemIds,
        workItems,
        steps,
        (row) => {
          if (typeof row.days !== 'number' || !Number.isFinite(row.days) || row.days < 0) {
            throw new Error(`actual ${row.workItemId}/${row.stepId} has an invalid day value`);
          }
          if (typeof row.recordedAt !== 'number' || !Number.isFinite(row.recordedAt)) {
            throw new Error(`actual ${row.workItemId}/${row.stepId} has an invalid recorded time`);
          }
        },
      );
      return order(targeted.rows, targeted.steps);
    },
    listPlacements: (projectId, ids) => listValueGroupPlacements(rows, projectId, ids, workItems),
    set(toSet, _stamp) {
      const kept = rows.filter(
        (row) => !(row.workItemId === toSet.workItemId && row.stepId === toSet.stepId),
      );
      rows.splice(0, rows.length, ...kept, structuredClone(toSet));
      // `'written'`, always: these fixtures enforce no references at all, so
      // they cannot tell a step that has gone from one that never existed. That
      // is the memory source lagging the SQLite one on a named method (D29),
      // and slice 5 is where it goes on the allowlist or is tightened.
      return Promise.resolve('written' as const);
    },
    remove(workItemId, stepId, _stamp) {
      const kept = rows.filter((row) => !(row.workItemId === workItemId && row.stepId === stepId));
      rows.splice(0, rows.length, ...kept);
      return Promise.resolve();
    },
    moveAll(fromWorkItemId, toWorkItemId, _stamp) {
      const moved = rows.map((row) =>
        row.workItemId === fromWorkItemId ? { ...row, workItemId: toWorkItemId } : row,
      );
      rows.splice(0, rows.length, ...moved);
      return Promise.resolve();
    },
  };
}

function order(
  rows: StoredActual[],
  steps: Awaited<ReturnType<StepStore['listByProject']>> | undefined,
): StoredActual[] {
  if (steps === undefined) return rows;
  const position = new Map(steps.map((step) => [step.id, step.position]));
  return [...rows].sort(
    (left, right) =>
      compareValueGroupIds(left.workItemId, right.workItemId) ||
      (position.get(left.stepId) ?? 0) - (position.get(right.stepId) ?? 0) ||
      left.stepId.localeCompare(right.stepId),
  );
}

export interface MemoryActualTable {
  readonly rows: StoredActual[];
}
export function memoryActualTable(): MemoryActualTable {
  return { rows: [] };
}
