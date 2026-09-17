import type { ActualStore } from '../ports/actual-store';
import type { DependencyStore } from '../ports/dependency-store';
import type { EstimateStore } from '../ports/estimate-store';
import type { MeasureStore } from '../ports/measure-store';
import type { StepProgressStore } from '../ports/progress-store';
import type { PlanTransactionalStores } from '../ports/stores';
import type { Scope } from '../ports/unit-of-work';
import type { LabelledWorkItem } from '../ports/work-item-store';
import { createWorkingPlanDirectory } from './working-plan-directory';
import { createWorkingPlanEdges } from './working-plan-edges';
import { createWorkingPlanRows } from './working-plan-rows';
import { createWorkingPlanSubtrees } from './working-plan-subtrees';
import { createWorkingPlanValues } from './working-plan-values';

/** One project's lazily retained reads, owned by one admitted command batch. */
export interface WorkingPlan {
  readonly stores: PlanTransactionalStores;
  close(): void;
}

/**
 * Creates the retained read graph for one admitted batch.
 *
 * Each retained collection loads from the supplied scope only on its first
 * read and returns detached records thereafter. {@link WorkingPlan.close}
 * permanently refuses retained reads, including callbacks borrowed while the
 * batch was open.
 *
 * Row, step-value, dependency, subtree and directory wrappers advance the
 * authoritative affected identities before returning, so the command service
 * graph can use these stores for the full lifetime of its admitted batch.
 */
export function createWorkingPlan(scope: Scope, projectId: string): WorkingPlan {
  let isClosed = false;
  const assertOpen = (): void => {
    if (isClosed) throw new Error(`Working plan for ${projectId} is closed`);
  };
  const assertProject = (requestedProjectId: string): void => {
    assertOpen();
    if (requestedProjectId !== projectId) {
      throw new Error(`Working plan for ${projectId} cannot read project ${requestedProjectId}`);
    }
  };

  const workItems = retainedRows(
    () => scope.stores.workItems.listByProject(projectId),
    cloneWorkItem,
    assertOpen,
  );
  const estimates = retainedRows(
    () => scope.stores.estimates.listByProject(projectId),
    cloneRecord,
    assertOpen,
  );
  const actuals = retainedRows(
    () => scope.stores.actuals.listByProject(projectId),
    cloneRecord,
    assertOpen,
  );
  const measures = retainedRows(
    () => scope.stores.measures.listByProject(projectId),
    cloneRecord,
    assertOpen,
  );
  const progress = retainedRows(
    () => scope.stores.progress.listByProject(projectId),
    cloneRecord,
    assertOpen,
  );
  const dependencies = retainedRows(
    () => scope.stores.dependencies.listByProject(projectId),
    cloneRecord,
    assertOpen,
  );

  const refreshRows = async (
    ids: readonly string[],
    insertedIds: readonly string[] = [],
  ): Promise<void> => {
    assertOpen();
    const requestedIds = [...new Set(ids)];
    if (requestedIds.length === 0) return;
    const requested = new Set(requestedIds);
    await workItems.replaceAndPlace(
      requestedIds,
      insertedIds,
      () => scope.stores.workItems.listByIds(projectId, requestedIds),
      (newIds) => scope.stores.workItems.listPlacements(projectId, newIds),
      ({ id }) => id,
      (row) => {
        if (row.projectId !== projectId) {
          throw new Error(`targeted work item ${row.id} is outside project ${projectId}`);
        }
        if (!requested.has(row.id)) {
          throw new Error(`targeted work item ${row.id} was not requested for refresh`);
        }
      },
    );
    await estimates.replaceGroupsAndPlace(
      requestedIds,
      () => scope.stores.estimates.listByWorkItems(projectId, requestedIds),
      (newIds) => scope.stores.estimates.listPlacements(projectId, newIds),
      ({ workItemId }) => workItemId,
      ({ workItemId }) => {
        assertRequested('estimate', workItemId, requested);
      },
    );
    await actuals.replaceGroupsAndPlace(
      requestedIds,
      () => scope.stores.actuals.listByWorkItems(projectId, requestedIds),
      (newIds) => scope.stores.actuals.listPlacements(projectId, newIds),
      ({ workItemId }) => workItemId,
      ({ workItemId }) => {
        assertRequested('actual', workItemId, requested);
      },
    );
    await measures.replaceGroupsAndPlace(
      requestedIds,
      () => scope.stores.measures.listByWorkItems(projectId, requestedIds),
      (newIds) => scope.stores.measures.listPlacements(projectId, newIds),
      ({ workItemId }) => workItemId,
      ({ workItemId }) => {
        assertRequested('measure', workItemId, requested);
      },
    );
    await progress.replaceGroupsAndPlace(
      requestedIds,
      () => scope.stores.progress.listByWorkItems(projectId, requestedIds),
      (newIds) => scope.stores.progress.listPlacements(projectId, newIds),
      ({ workItemId }) => workItemId,
      ({ workItemId }) => {
        assertRequested('progress', workItemId, requested);
      },
    );
    await dependencies.replaceIncident(
      () => scope.stores.dependencies.listByWorkItems(projectId, requestedIds),
      ({ predecessorId, successorId }) =>
        requested.has(predecessorId) || requested.has(successorId),
      ({ id }) => id,
      (edge) => {
        if (edge.projectId !== projectId) {
          throw new Error(`targeted dependency ${edge.id} is outside project ${projectId}`);
        }
        if (!requested.has(edge.predecessorId) && !requested.has(edge.successorId)) {
          throw new Error(
            `targeted dependency ${edge.id} touches no refreshed work item in project ${projectId}`,
          );
        }
      },
    );
  };

  const retainedWorkItems = createWorkingPlanRows(
    // Keep store selection lazy: admission refusals construct this graph but
    // must never touch transactional mutation ports.
    // Proof: passing the store eagerly made the absent-account admission test
    // throw "something asked it for workItems" before returning `forbidden`.
    () => scope.stores.workItems,
    {
      all: async () => workItems.all(),
      byIds: async (ids) => {
        const requested = new Set(ids);
        return (await workItems.all()).filter(({ id }) => requested.has(id));
      },
      placements: async (ids) => placementsOf(await workItems.all(), ids, ({ id }) => id),
    },
    assertOpen,
    refreshRows,
  );
  const checkedWorkItems = {
    ...retainedWorkItems,
    listByProject: async (requestedProjectId: string) => {
      assertProject(requestedProjectId);
      return retainedWorkItems.listByProject(requestedProjectId);
    },
    listByIds: async (requestedProjectId: string, ids: readonly string[]) => {
      assertProject(requestedProjectId);
      return retainedWorkItems.listByIds(requestedProjectId, ids);
    },
    listPlacements: async (requestedProjectId: string, ids: readonly string[]) => {
      assertProject(requestedProjectId);
      return retainedWorkItems.listPlacements(requestedProjectId, ids);
    },
  };
  const retainedEstimates: EstimateStore = createWorkingPlanValues(
    () => scope.stores.estimates,
    {
      all: async (requestedProjectId) => {
        assertProject(requestedProjectId);
        return estimates.all();
      },
      byWorkItems: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return byWorkItem(await estimates.all(), ids);
      },
      placements: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return placementsOfGroups(await estimates.all(), ids, ({ workItemId }) => workItemId);
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedActuals: ActualStore = createWorkingPlanValues(
    () => scope.stores.actuals,
    {
      all: async (requestedProjectId) => {
        assertProject(requestedProjectId);
        return actuals.all();
      },
      byWorkItems: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return byWorkItem(await actuals.all(), ids);
      },
      placements: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return placementsOfGroups(await actuals.all(), ids, ({ workItemId }) => workItemId);
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedMeasures: MeasureStore = createWorkingPlanValues(
    () => scope.stores.measures,
    {
      all: async (requestedProjectId) => {
        assertProject(requestedProjectId);
        return measures.all();
      },
      byWorkItems: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return byWorkItem(await measures.all(), ids);
      },
      placements: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return placementsOfGroups(await measures.all(), ids, ({ workItemId }) => workItemId);
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedProgress: StepProgressStore = createWorkingPlanValues(
    () => scope.stores.progress,
    {
      all: async (requestedProjectId) => {
        assertProject(requestedProjectId);
        return progress.all();
      },
      byWorkItems: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return byWorkItem(await progress.all(), ids);
      },
      placements: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        return placementsOfGroups(await progress.all(), ids, ({ workItemId }) => workItemId);
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedDependencies: DependencyStore = createWorkingPlanEdges(
    () => scope.stores.dependencies,
    projectId,
    {
      all: async (requestedProjectId) => {
        assertProject(requestedProjectId);
        return dependencies.all();
      },
      byWorkItems: async (requestedProjectId, ids) => {
        assertProject(requestedProjectId);
        const requested = new Set(ids);
        return (await dependencies.all()).filter(
          ({ predecessorId, successorId }) =>
            requested.has(predecessorId) || requested.has(successorId),
        );
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedSubtrees = createWorkingPlanSubtrees(
    () => scope.stores.subtrees,
    {
      byIds: async (ids) => {
        const requested = new Set(ids);
        return (await workItems.all()).filter(({ id }) => requested.has(id));
      },
    },
    assertOpen,
    refreshRows,
  );
  const retainedDirectory = createWorkingPlanDirectory(
    () => scope.stores.directory,
    assertOpen,
    async () => {
      await Promise.all([
        workItems.reload(),
        estimates.reload(),
        actuals.reload(),
        measures.reload(),
        progress.reload(),
        dependencies.reload(),
      ]);
    },
    refreshRows,
  );

  const stores: PlanTransactionalStores = {
    get projects() {
      assertOpen();
      return scope.stores.projects;
    },
    get directory() {
      assertOpen();
      return retainedDirectory;
    },
    get capacity() {
      assertOpen();
      return scope.stores.capacity;
    },
    get priorityBands() {
      assertOpen();
      return scope.stores.priorityBands;
    },
    get calendarMarkers() {
      assertOpen();
      return scope.stores.calendarMarkers;
    },
    get eventLog() {
      assertOpen();
      return scope.stores.eventLog;
    },
    get planEvents() {
      assertOpen();
      return scope.stores.planEvents;
    },
    get steps() {
      assertOpen();
      return scope.stores.steps;
    },
    workItems: checkedWorkItems,
    estimates: retainedEstimates,
    actuals: retainedActuals,
    measures: retainedMeasures,
    progress: retainedProgress,
    dependencies: retainedDependencies,
    subtrees: retainedSubtrees,
    get journal() {
      assertOpen();
      return scope.stores.journal;
    },
  };

  return {
    stores,
    close: () => {
      isClosed = true;
    },
  };
}

class RetainedRows<Row> {
  private rows: readonly Row[] | undefined;

  constructor(
    private readonly load: () => Promise<Row[]>,
    private readonly clone: (row: Row) => Row,
    private readonly assertOpen: () => void,
  ) {}

  async all(): Promise<Row[]> {
    this.assertOpen();
    if (this.rows === undefined) {
      const loaded = await this.load();
      this.assertOpen();
      this.rows = loaded.map(this.clone);
    }
    return this.rows.map(this.clone);
  }

  async reload(): Promise<void> {
    this.assertOpen();
    if (this.rows === undefined) return;
    const loaded = await this.load();
    this.assertOpen();
    this.rows = loaded.map(this.clone);
  }

  async replaceGroupsAndPlace(
    ids: readonly string[],
    load: () => Promise<Row[]>,
    loadPlacements: (
      ids: readonly string[],
    ) => Promise<readonly { id: string; afterId: string | null }[]>,
    groupOf: (row: Row) => string,
    validate: (row: Row) => void,
  ): Promise<void> {
    this.assertOpen();
    if (this.rows === undefined) return;
    const replacements = await load();
    this.assertOpen();
    replacements.forEach(validate);
    const replaced = new Set(ids);
    const replacementsByGroup = new Map<string, Row[]>();
    for (const row of replacements) addToGroup(replacementsByGroup, groupOf(row), row);
    const inserted = new Set<string>();
    const retainedGroups = new Set(this.rows.map(groupOf));
    const retained: Row[] = [];
    for (const row of this.rows) {
      const group = groupOf(row);
      if (!replaced.has(group)) {
        retained.push(row);
        continue;
      }
      if (inserted.has(group)) continue;
      retained.push(...(replacementsByGroup.get(group) ?? []));
      inserted.add(group);
    }
    const newGroups = [...replacementsByGroup.keys()].filter((group) => !retainedGroups.has(group));
    if (newGroups.length === 0) {
      this.rows = retained.map(this.clone);
      return;
    }
    const placements = await loadPlacements(newGroups);
    this.assertOpen();
    const newReplacements = new Map(
      newGroups.map((group) => [group, replacementsByGroup.get(group) ?? []] as const),
    );
    placeGroups(retained, newReplacements, placements, groupOf, 'value group');
    this.rows = retained.map(this.clone);
  }

  async replaceAndPlace(
    ids: readonly string[],
    insertedIds: readonly string[],
    load: () => Promise<Row[]>,
    loadPlacements: (
      ids: readonly string[],
    ) => Promise<readonly { id: string; afterId: string | null }[]>,
    groupOf: (row: Row) => string,
    validate: (row: Row) => void,
  ): Promise<void> {
    this.assertOpen();
    if (this.rows === undefined) return;
    const replacements = await load();
    this.assertOpen();
    replacements.forEach(validate);
    const replaced = new Set(ids);
    const replacementsByIdentity = new Map(replacements.map((row) => [groupOf(row), row] as const));
    const retained: Row[] = [];
    for (const row of this.rows) {
      const identity = groupOf(row);
      if (!replaced.has(identity)) {
        retained.push(row);
        continue;
      }
      const replacement = replacementsByIdentity.get(identity);
      if (replacement !== undefined) {
        retained.push(replacement);
        replacementsByIdentity.delete(identity);
      }
    }

    const inserted = new Set(insertedIds);
    const newIds = [...replacementsByIdentity.keys()];
    for (const id of newIds) {
      if (!inserted.has(id)) throw new Error(`refreshed work item ${id} has no retained position`);
    }
    if (newIds.length === 0) {
      this.rows = retained.map(this.clone);
      return;
    }
    const placements = await loadPlacements(newIds);
    this.assertOpen();
    const newRows = new Map<string, Row[]>(
      [...replacementsByIdentity].map(([id, row]) => [id, [row]]),
    );
    placeGroups(retained, newRows, placements, groupOf, 'work item');
    this.rows = retained.map(this.clone);
  }

  async replaceIncident(
    load: () => Promise<Row[]>,
    isIncident: (row: Row) => boolean,
    identityOf: (row: Row) => string,
    validate: (row: Row) => void,
  ): Promise<void> {
    this.assertOpen();
    if (this.rows === undefined) return;
    const replacements = await load();
    this.assertOpen();
    replacements.forEach(validate);
    const replacementByIdentity = new Map(
      replacements.map((row) => [identityOf(row), row] as const),
    );
    const retained: Row[] = [];
    for (const row of this.rows) {
      if (!isIncident(row)) {
        retained.push(row);
        continue;
      }
      const replacement = replacementByIdentity.get(identityOf(row));
      if (replacement === undefined) continue;
      retained.push(replacement);
      replacementByIdentity.delete(identityOf(row));
    }
    retained.push(...replacementByIdentity.values());
    this.rows = retained.map(this.clone);
  }
}

function retainedRows<Row>(
  load: () => Promise<Row[]>,
  clone: (row: Row) => Row,
  assertOpen: () => void,
): RetainedRows<Row> {
  return new RetainedRows(load, clone, assertOpen);
}

function byWorkItem<Row extends { workItemId: string }>(
  rows: readonly Row[],
  ids: readonly string[],
): Row[] {
  const requested = new Set(ids);
  return rows.filter(({ workItemId }) => requested.has(workItemId));
}

function placementsOf<Row>(
  rows: readonly Row[],
  ids: readonly string[],
  identityOf: (row: Row) => string,
): { id: string; afterId: string | null }[] {
  const requested = new Set(ids);
  return rows.flatMap((row, index) => {
    const id = identityOf(row);
    if (!requested.has(id)) return [];
    return [{ id, afterId: index === 0 ? null : identityOf(rows[index - 1]) }];
  });
}

function placementsOfGroups<Row>(
  rows: readonly Row[],
  ids: readonly string[],
  groupOf: (row: Row) => string,
): { id: string; afterId: string | null }[] {
  const requested = new Set(ids);
  const groups = [...new Set(rows.map(groupOf))];
  return groups.flatMap((id, index) =>
    requested.has(id) ? [{ id, afterId: index === 0 ? null : groups[index - 1] }] : [],
  );
}

function placeGroups<Row>(
  retained: Row[],
  replacements: ReadonlyMap<string, Row[]>,
  placements: readonly { id: string; afterId: string | null }[],
  groupOf: (row: Row) => string,
  noun: 'value group' | 'work item',
): void {
  const expected = new Set(replacements.keys());
  const placed = new Set<string>();
  const known = new Set(retained.map(groupOf));
  for (const { id, afterId } of placements) {
    if (placed.has(id)) throw new Error(`targeted placement returned duplicate ${noun} ${id}`);
    if (!expected.has(id)) throw new Error(`targeted placement returned unexpected ${noun} ${id}`);
    if (afterId !== null && typeof afterId !== 'string') {
      throw new Error(`targeted placement for ${id} has malformed predecessor`);
    }
    if (afterId === id) throw new Error(`targeted placement for ${id} cannot follow itself`);
    if (afterId !== null && !known.has(afterId)) {
      throw new Error(`targeted placement for ${id} follows missing ${noun} ${afterId}`);
    }
    known.add(id);
    placed.add(id);
  }
  if (placed.size !== expected.size) {
    const missing = [...expected].find((id) => !placed.has(id));
    throw new Error(`targeted placement omitted ${noun} ${missing ?? 'unknown'}`);
  }
  for (const { id, afterId } of placements) {
    const rows = replacements.get(id);
    if (rows === undefined) throw new Error(`targeted placement omitted ${noun} ${id}`);
    const index = afterId === null ? 0 : lastGroupIndex(retained, afterId, groupOf) + 1;
    retained.splice(index, 0, ...rows);
  }
}

function lastGroupIndex<Row>(
  rows: readonly Row[],
  id: string,
  groupOf: (row: Row) => string,
): number {
  return rows.findLastIndex((row) => groupOf(row) === id);
}

function cloneRecord<Row extends object>(record: Row): Row {
  return { ...record };
}

function addToGroup<Row>(groups: Map<string, Row[]>, key: string, row: Row): void {
  const rows = groups.get(key);
  if (rows === undefined) groups.set(key, [row]);
  else rows.push(row);
}

function assertRequested(
  collection: string,
  workItemId: string,
  requested: ReadonlySet<string>,
): void {
  if (!requested.has(workItemId)) {
    throw new Error(`targeted ${collection} belongs to unrequested work item ${workItemId}`);
  }
}

/**
 * Detaches a retained row deeply enough that a borrowed before-image cannot
 * rewrite the cache or an inverse already collected from another answer.
 */
function cloneWorkItem(workItem: LabelledWorkItem): LabelledWorkItem {
  return {
    ...workItem,
    teamIds: [...workItem.teamIds],
    tagIds: [...workItem.tagIds],
    serviceIds: [...workItem.serviceIds],
    typeIds: [...workItem.typeIds],
    externalRefs: workItem.externalRefs.map((reference) => ({ ...reference })),
  };
}
