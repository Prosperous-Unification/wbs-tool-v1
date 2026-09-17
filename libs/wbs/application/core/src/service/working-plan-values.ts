import type { StepWriteOutcome } from '../ports/estimate-store';
import type { WriteStamp } from '../ports/write-stamp';

interface StoredValue {
  readonly workItemId: string;
}

interface WorkingValueStore<
  Value extends StoredValue,
  RemoveArguments extends readonly [workItemId: string, ...parameters: unknown[]],
> {
  listByProject(projectId: string): Promise<Value[]>;
  listByWorkItems(projectId: string, ids: readonly string[]): Promise<Value[]>;
  listPlacements(
    projectId: string,
    ids: readonly string[],
  ): Promise<{ id: string; afterId: string | null }[]>;
  set(value: Value, stamp: WriteStamp): Promise<StepWriteOutcome>;
  remove(...parameters: RemoveArguments): Promise<void>;
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}

interface RetainedValueReads<Value> {
  all(projectId: string): Promise<Value[]>;
  byWorkItems(projectId: string, ids: readonly string[]): Promise<Value[]>;
  placements(
    projectId: string,
    ids: readonly string[],
  ): Promise<{ id: string; afterId: string | null }[]>;
}

/**
 * Builds one step-value part of a batch-owned working plan.
 *
 * Successful writes refresh every affected work-item identity before resolving.
 * A modeled set refusal leaves retained values unchanged, and a thrown source or
 * refresh failure escapes without a wrapper-level recovery path.
 */
export function createWorkingPlanValues<
  Value extends StoredValue,
  RemoveArguments extends readonly [workItemId: string, ...parameters: unknown[]],
>(
  source: () => WorkingValueStore<Value, RemoveArguments>,
  reads: RetainedValueReads<Value>,
  assertOpen: () => void,
  refreshRows: (ids: readonly string[]) => Promise<void>,
): WorkingValueStore<Value, RemoveArguments> {
  return {
    listByProject: async (projectId) => reads.all(projectId),
    listByWorkItems: async (projectId, ids) => reads.byWorkItems(projectId, ids),
    listPlacements: async (projectId, ids) => reads.placements(projectId, ids),
    set: async (value, stamp) => {
      assertOpen();
      const written = await source().set(value, stamp);
      if (written === 'written') await refreshRows([value.workItemId]);
      return written;
    },
    remove: async (...parameters) => {
      assertOpen();
      await source().remove(...parameters);
      await refreshRows([parameters[0]]);
    },
    moveAll: async (fromWorkItemId, toWorkItemId, stamp) => {
      assertOpen();
      await source().moveAll(fromWorkItemId, toWorkItemId, stamp);
      await refreshRows([fromWorkItemId, toWorkItemId]);
    },
  };
}
