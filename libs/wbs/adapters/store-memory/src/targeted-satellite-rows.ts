import type { Step, StepStore, WorkItemStore } from '@wbs/core';

interface SatelliteRow {
  readonly workItemId: string;
  readonly stepId: string;
}

interface TargetedSatelliteRows<Row> {
  readonly rows: Row[];
  readonly steps: Step[] | undefined;
}

/**
 * Admits requested memory satellite rows through their project boundary.
 *
 * Stored rows are trusted state, so a requested row whose work item is missing
 * is an invariant failure. A valid row owned by another project is filtered as
 * the complete project reader filters it; only admitted rows then have their
 * step reference and family-specific value validated. The returned project
 * steps are the same read used for validation and subsequent ordering.
 *
 * @throws When a requested row has an invalid reference or stored value.
 */
export async function readTargetedSatelliteRows<Row extends SatelliteRow>(
  family: 'actual' | 'estimate' | 'measure' | 'progress',
  stored: readonly Row[],
  projectId: string,
  workItemIds: readonly string[],
  workItems: WorkItemStore,
  steps: StepStore | undefined,
  validate: (row: Row) => void,
): Promise<TargetedSatelliteRows<Row>> {
  if (workItemIds.length === 0) return { rows: [], steps: undefined };
  const requested = new Set(workItemIds);
  const rows = stored.filter(({ workItemId }) => requested.has(workItemId));
  const owners = new Map<string, string>();
  for (const { workItemId } of rows) {
    if (owners.has(workItemId)) continue;
    const workItem = await workItems.findById(workItemId);
    if (workItem === null) {
      throw new Error(`targeted ${family} has an invalid work-item reference`);
    }
    owners.set(workItemId, workItem.projectId);
  }
  const admitted = rows.filter(({ workItemId }) => owners.get(workItemId) === projectId);
  const projectSteps = await steps?.listByProject(projectId);
  if (projectSteps !== undefined) {
    const stepIds = new Set(projectSteps.map(({ id }) => id));
    for (const row of admitted) {
      if (!stepIds.has(row.stepId)) {
        throw new Error(`${family} ${row.workItemId}/${row.stepId} has an invalid step reference`);
      }
    }
  }
  admitted.forEach(validate);
  return { rows: admitted, steps: projectSteps };
}
