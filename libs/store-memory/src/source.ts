import type {
  PlanInputReads,
  SavedPlanRow,
  SavedPlanStore,
  SavedPlanWrite,
  Source,
  StoredSavedPlan,
  TransactionalStores,
} from '@wbs/core';

import { inMemoryActuals, type MemoryActualTable, memoryActualTable } from './actual-fixture';
import { inMemoryUsers, type MemoryUserTable, memoryUserTable } from './auth-fixture';
import {
  inMemoryCalendarMarkers,
  type MemoryCalendarMarkerTable,
  memoryCalendarMarkerTable,
} from './calendar-marker-fixture';
import {
  inMemoryCapacity,
  type MemoryCapacityTable,
  memoryCapacityTable,
} from './capacity-fixture';
import {
  inMemoryCommandJournal,
  type MemoryCommandJournalTables,
  memoryCommandJournalTables,
} from './command-journal-fixture';
import {
  inMemoryDependencies,
  type MemoryDependencyTable,
  memoryDependencyTable,
} from './dependency-fixture';
import {
  inMemoryDirectory,
  type MemoryDirectoryTables,
  memoryDirectoryTables,
} from './directory-fixture';
import {
  inMemoryEstimates,
  type MemoryEstimateTable,
  memoryEstimateTable,
} from './estimate-fixture';
import {
  inMemoryPlanEvents,
  type MemoryPlanEventTable,
  memoryPlanEventTable,
} from './history-fixture';
import { inMemoryMeasures, type MemoryMeasureTable, memoryMeasureTable } from './measure-fixture';
import {
  inMemoryWorkItems,
  type MemoryWorkItemTables,
  memoryWorkItemTables,
} from './memory-work-item-fixture';
import {
  inMemoryPriorityBands,
  type MemoryPriorityBandTable,
  memoryPriorityBandTable,
} from './priority-band-fixture';
import {
  inMemoryProgress,
  type MemoryProgressTable,
  memoryProgressTable,
} from './progress-fixture';
import { inMemoryProjects, type MemoryProjectTables, memoryProjectTables } from './project-fixture';
import {
  inMemoryEventLog,
  type MemoryEventLogTables,
  memoryEventLogTables,
} from './replay-fixture';
import { inMemorySteps, type MemoryStepTable, memoryStepTable } from './step-fixture';
import { inMemorySubtrees } from './subtree-fixture';

interface MemoryTables {
  readonly users: MemoryUserTable;
  readonly projects: MemoryProjectTables;
  readonly directory: MemoryDirectoryTables;
  readonly steps: MemoryStepTable;
  readonly dependencies: MemoryDependencyTable;
  readonly workItems: MemoryWorkItemTables;
  readonly estimates: MemoryEstimateTable;
  readonly actuals: MemoryActualTable;
  readonly measures: MemoryMeasureTable;
  readonly progress: MemoryProgressTable;
  readonly capacity: MemoryCapacityTable;
  readonly priorityBands: MemoryPriorityBandTable;
  readonly calendarMarkers: MemoryCalendarMarkerTable;
  readonly planEvents: MemoryPlanEventTable;
  readonly eventLog: MemoryEventLogTables;
  readonly journal: MemoryCommandJournalTables;
}

function emptyTables(): MemoryTables {
  return {
    users: memoryUserTable(),
    projects: memoryProjectTables(),
    directory: memoryDirectoryTables(),
    steps: memoryStepTable(),
    dependencies: memoryDependencyTable(),
    workItems: memoryWorkItemTables(),
    estimates: memoryEstimateTable(),
    actuals: memoryActualTable(),
    measures: memoryMeasureTable(),
    progress: memoryProgressTable(),
    capacity: memoryCapacityTable(),
    priorityBands: memoryPriorityBandTable(),
    calendarMarkers: memoryCalendarMarkerTable(),
    planEvents: memoryPlanEventTable(),
    eventLog: memoryEventLogTables(),
    journal: memoryCommandJournalTables(),
  };
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, structuredClone(value));
}

function replaceArray<T>(target: T[], source: T[]): void {
  target.splice(0, target.length, ...structuredClone(source));
}

/** Prevents a source reader from retaining a reference to its stored value. */
function detachedStore<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return structuredClone(member);
      return (...args: unknown[]): unknown => {
        const returned: unknown = Reflect.apply(member, target, args);
        if (returned instanceof Promise) {
          return returned.then((value: unknown) => structuredClone(value));
        }
        return structuredClone(returned);
      };
    },
  });
}

/** Applies the one detached-read boundary to every store in the catalog. */
function detachedStores(stores: TransactionalStores): TransactionalStores {
  const wrapped = new Map<PropertyKey, object>();
  return new Proxy(stores, {
    get(target, key, receiver) {
      const store: unknown = Reflect.get(target, key, receiver);
      if (store === null || typeof store !== 'object') return store;
      const existing = wrapped.get(key);
      if (existing !== undefined) return existing;
      const detached = detachedStore(store);
      wrapped.set(key, detached);
      return detached;
    },
  });
}

/** Cloneable transactional table values owned by one memory source. */
export class MemoryState {
  readonly tables: MemoryTables;

  constructor(tables: MemoryTables = emptyTables()) {
    this.tables = tables;
  }

  clone(): MemoryState {
    return new MemoryState(structuredClone(this.tables));
  }

  replaceWith(next: MemoryState): void {
    replaceMap(this.tables.users.byId, next.tables.users.byId);
    replaceMap(this.tables.projects.projects, next.tables.projects.projects);
    replaceMap(this.tables.projects.steps, next.tables.projects.steps);
    replaceMap(this.tables.projects.opened, next.tables.projects.opened);
    replaceMap(this.tables.directory.teams, next.tables.directory.teams);
    replaceMap(this.tables.directory.tags, next.tables.directory.tags);
    replaceMap(this.tables.directory.services, next.tables.directory.services);
    replaceMap(this.tables.directory.workItemTypes, next.tables.directory.workItemTypes);
    replaceMap(this.tables.directory.people, next.tables.directory.people);
    replaceMap(this.tables.directory.memberships, next.tables.directory.memberships);
    replaceMap(this.tables.directory.owned, next.tables.directory.owned);
    replaceMap(this.tables.directory.assignments, next.tables.directory.assignments);
    replaceArray(this.tables.steps.rows, next.tables.steps.rows);
    replaceArray(this.tables.dependencies.rows, next.tables.dependencies.rows);
    replaceMap(this.tables.workItems.byId, next.tables.workItems.byId);
    replaceMap(this.tables.workItems.teamsOf, next.tables.workItems.teamsOf);
    replaceMap(this.tables.workItems.tagsOf, next.tables.workItems.tagsOf);
    replaceMap(this.tables.workItems.servicesOf, next.tables.workItems.servicesOf);
    replaceMap(this.tables.workItems.typesOf, next.tables.workItems.typesOf);
    replaceMap(this.tables.workItems.refsOf, next.tables.workItems.refsOf);
    replaceArray(this.tables.estimates.rows, next.tables.estimates.rows);
    replaceArray(this.tables.actuals.rows, next.tables.actuals.rows);
    replaceArray(this.tables.measures.rows, next.tables.measures.rows);
    replaceArray(this.tables.progress.rows, next.tables.progress.rows);
    replaceMap(this.tables.capacity.held, next.tables.capacity.held);
    replaceMap(this.tables.priorityBands.held, next.tables.priorityBands.held);
    replaceMap(this.tables.calendarMarkers.held, next.tables.calendarMarkers.held);
    replaceArray(this.tables.planEvents.held, next.tables.planEvents.held);
    replaceMap(this.tables.eventLog.rows, next.tables.eventLog.rows);
    replaceMap(this.tables.eventLog.nextSeq, next.tables.eventLog.nextSeq);
    replaceArray(this.tables.journal.entries, next.tables.journal.entries);
    replaceArray(this.tables.journal.events, next.tables.journal.events);
  }
}

function bindStores(state: MemoryState): TransactionalStores {
  const users = inMemoryUsers(state.tables.users);
  let workItems: TransactionalStores['workItems'] | null = null;
  const directory = inMemoryDirectory((projectId) => {
    if (workItems === null) throw new Error('work-item table was read before it was bound');
    return workItems.listByProject(projectId);
  }, state.tables.directory);
  const dependencies = inMemoryDependencies([], state.tables.dependencies);
  workItems = inMemoryWorkItems(directory, state.tables.workItems);
  const estimates = inMemoryEstimates(workItems, state.tables.estimates);
  const actuals = inMemoryActuals(workItems, state.tables.actuals);
  const measures = inMemoryMeasures(workItems, state.tables.measures);
  const progress = inMemoryProgress(workItems, state.tables.progress);
  const stores: TransactionalStores = {
    users,
    projects: inMemoryProjects(users, state.tables.projects),
    directory,
    steps: inMemorySteps([], state.tables.steps),
    workItems,
    estimates,
    actuals,
    measures,
    progress,
    dependencies,
    capacity: inMemoryCapacity({}, state.tables.capacity),
    priorityBands: inMemoryPriorityBands({}, state.tables.priorityBands),
    calendarMarkers: inMemoryCalendarMarkers([], state.tables.calendarMarkers),
    planEvents: inMemoryPlanEvents([], state.tables.planEvents),
    eventLog: inMemoryEventLog(state.tables.eventLog),
    journal: inMemoryCommandJournal(state.tables.journal),
    subtrees: inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      progress,
      measures,
      dependencies,
      directory,
    }),
  };
  return detachedStores(stores);
}

class MemoryCoordinator {
  private turn = Promise.resolve();

  async run<T>(act: () => Promise<T>): Promise<T> {
    const prior = this.turn;
    let release = (): void => undefined;
    this.turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await act();
    } finally {
      release();
    }
  }
}

function coordinatedStore<T extends object>(
  store: T,
  writes: readonly PropertyKey[],
  coordinator: MemoryCoordinator,
): T {
  const guarded = new Set(writes);
  return new Proxy(store, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return member;
      const invoke = (...args: unknown[]): unknown => {
        const outcome: unknown = Reflect.apply(member, target, args);
        return outcome;
      };
      if (!guarded.has(key)) return invoke;
      return (...args: unknown[]) =>
        coordinator.run(async () => await Promise.resolve(invoke(...args)));
    },
  });
}

function coordinatedStores(
  stores: TransactionalStores,
  coordinator: MemoryCoordinator,
): TransactionalStores {
  return {
    users: coordinatedStore(stores.users, ['create', 'resolveOidcIdentity'], coordinator),
    projects: coordinatedStore(stores.projects, ['create', 'recordOpen', 'update'], coordinator),
    directory: coordinatedStore(
      stores.directory,
      [
        'addTag',
        'renameTag',
        'removeTag',
        'addWorkItemType',
        'renameWorkItemType',
        'removeWorkItemType',
        'addService',
        'renameService',
        'removeService',
        'addTeam',
        'patchTeam',
        'addPerson',
        'patchPerson',
        'removePerson',
        'removeTeam',
        'assign',
      ],
      coordinator,
    ),
    capacity: coordinatedStore(stores.capacity, ['set'], coordinator),
    priorityBands: coordinatedStore(stores.priorityBands, ['replace'], coordinator),
    calendarMarkers: coordinatedStore(
      stores.calendarMarkers,
      ['create', 'rename', 'recolor', 'remove'],
      coordinator,
    ),
    eventLog: coordinatedStore(stores.eventLog, ['recordEvent', 'pruneBeyond'], coordinator),
    planEvents: coordinatedStore(stores.planEvents, ['pruneOlderThan'], coordinator),
    steps: coordinatedStore(stores.steps, ['add', 'rename', 'remove'], coordinator),
    workItems: coordinatedStore(
      stores.workItems,
      ['insert', 'patch', 'move', 'setPositions', 'setFrozenNumbers', 'remove'],
      coordinator,
    ),
    estimates: coordinatedStore(stores.estimates, ['set', 'remove', 'moveAll'], coordinator),
    actuals: coordinatedStore(stores.actuals, ['set', 'remove', 'moveAll'], coordinator),
    measures: coordinatedStore(stores.measures, ['set', 'remove', 'moveAll'], coordinator),
    progress: coordinatedStore(stores.progress, ['set', 'remove', 'moveAll'], coordinator),
    dependencies: coordinatedStore(
      stores.dependencies,
      ['add', 'remove', 'removeAllFor'],
      coordinator,
    ),
    subtrees: coordinatedStore(stores.subtrees, ['insertSubtree'], coordinator),
    journal: coordinatedStore(
      stores.journal,
      ['append', 'flip', 'restamp', 'discard'],
      coordinator,
    ),
  };
}

/** Opens a staged in-memory source with no ambient runtime dependencies. */
export function openMemorySource(): Source<TransactionalStores> {
  const committed = new MemoryState();
  const coordinator = new MemoryCoordinator();
  const historyCoordinator = new MemoryCoordinator();
  const historyState: HistoryState = { plans: new Map() };
  const history = memoryHistory(
    historyState,
    () => bindStores(committed.clone()),
    async (act) => await historyCoordinator.run(act),
  );
  const stores = coordinatedStores(bindStores(committed), coordinator);

  return {
    stores,
    history,
    uow: {
      run: (act) =>
        coordinator.run(async () => {
          const staged = committed.clone();
          const decision = await act({ stores: bindStores(staged) });
          if (decision.commit) committed.replaceWith(staged);
          else if (decision.afterRollback !== undefined) {
            await decision.afterRollback({ stores: bindStores(committed) });
          }
          return decision.value;
        }),
    },
    health: () => Promise.resolve({ ok: true }),
    close: () => Promise.resolve(),
  };
}

interface HistoryState {
  readonly plans: Map<string, StoredSavedPlan>;
}

function savedPlanRow(plan: SavedPlanWrite): SavedPlanRow {
  return {
    id: plan.id,
    projectId: plan.projectId,
    name: plan.name,
    createdBy: plan.createdBy,
    createdById: plan.createdById,
    createdAt: plan.createdAt,
    inputSchemaVersion: plan.input.schemaVersion,
    inputBytes: new TextEncoder().encode(plan.input.bytes).byteLength,
    inputSha256: plan.input.sha256,
    scheduleSchemaVersion: plan.schedule.present ? plan.schedule.body.schemaVersion : null,
    scheduleBytes: plan.schedule.present
      ? new TextEncoder().encode(plan.schedule.body.bytes).byteLength
      : null,
    scheduleSha256: plan.schedule.present ? plan.schedule.body.sha256 : null,
    scheduleInputSha256: plan.schedule.present ? plan.schedule.inputSha256 : null,
    schedulerAlgorithmId: plan.schedule.present ? plan.schedule.algorithmId : null,
    scheduleAbsentReason: plan.schedule.present ? null : plan.schedule.absentReason,
  };
}

function memorySavedPlans(
  state: HistoryState,
  stores: () => TransactionalStores,
  writeTurn: <T>(act: () => Promise<T>) => Promise<T>,
): SavedPlanStore {
  return {
    write: (plan, check) =>
      writeTurn(async () => {
        const rows = [...state.plans.values()].filter(
          (stored) => stored.header.projectId === plan.projectId,
        );
        const holding = {
          plans: rows.length,
          bytes: rows.reduce(
            (sum, stored) => sum + stored.header.inputBytes + (stored.header.scheduleBytes ?? 0),
            0,
          ),
        };
        const incoming =
          new TextEncoder().encode(plan.input.bytes).byteLength +
          (plan.schedule.present
            ? new TextEncoder().encode(plan.schedule.body.bytes).byteLength
            : 0);
        const refusal = await check(holding, incoming);
        if (refusal !== null) return { outcome: 'refused', refusal };
        state.plans.set(plan.id, {
          header: savedPlanRow(plan),
          bodies: {
            input: plan.input.bytes,
            schedule: plan.schedule.present ? plan.schedule.body.bytes : null,
          },
        });
        return { outcome: 'written' };
      }),
    readOf(savedPlanId) {
      const found = state.plans.get(savedPlanId);
      return Promise.resolve(found === undefined ? null : structuredClone(found));
    },
    listOf(projectId) {
      const rows = [...state.plans.values()]
        .filter((stored) => stored.header.projectId === projectId)
        .map((stored) => structuredClone(stored.header))
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
      return Promise.resolve(rows);
    },
    async principalsOf(savedPlanId) {
      const found = state.plans.get(savedPlanId);
      if (found === undefined) return null;
      const project = await stores().projects.findById(found.header.projectId);
      if (project === null) throw new Error(`saved plan ${savedPlanId} names an absent project`);
      return {
        savedPlanId,
        projectId: found.header.projectId,
        projectOwnerId: project.ownerId,
        createdById: found.header.createdById,
      };
    },
    renameTo(savedPlanId, name) {
      const found = state.plans.get(savedPlanId);
      if (found === undefined) return Promise.resolve('no_such_plan');
      state.plans.set(savedPlanId, {
        ...found,
        header: { ...found.header, name },
      });
      return Promise.resolve('touched');
    },
    deleteOf(savedPlanId) {
      return Promise.resolve(state.plans.delete(savedPlanId) ? 'touched' : 'no_such_plan');
    },
  };
}

async function capturePlanInput(
  stores: TransactionalStores,
  projectId: string,
): Promise<PlanInputReads | null> {
  const project = await stores.projects.findById(projectId);
  if (project === null) return null;
  const [
    steps,
    workItems,
    estimates,
    actuals,
    progress,
    measures,
    dependencies,
    assignmentRows,
    capacity,
    priorityBands,
    people,
    teams,
    services,
    tags,
    workItemTypes,
    externalSystems,
  ] = await Promise.all([
    stores.projects.stepsOf(projectId),
    stores.workItems.listByProject(projectId),
    stores.estimates.listByProject(projectId),
    stores.actuals.listByProject(projectId),
    stores.progress.listByProject(projectId),
    stores.measures.listByProject(projectId),
    stores.dependencies.listByProject(projectId),
    stores.directory.assignmentsInProject(projectId),
    stores.capacity.slotsFor(projectId),
    stores.priorityBands.listFor(projectId),
    stores.directory.listPeople(),
    stores.directory.listTeams(),
    stores.directory.listServices(),
    stores.directory.listTags(),
    stores.directory.listWorkItemTypes(),
    stores.directory.listExternalSystems(),
  ]);
  return structuredClone({
    project,
    steps,
    workItems,
    estimates,
    actuals,
    progress,
    measures,
    dependencies,
    assignments: assignmentRows.assignments,
    capacity,
    priorityBands,
    people,
    teams,
    services,
    tags,
    workItemTypes,
    externalSystems,
  });
}

function memoryHistory(
  state: HistoryState,
  stores: () => TransactionalStores,
  writeTurn: <T>(act: () => Promise<T>) => Promise<T>,
  captureTurn: <T>(act: () => Promise<T>) => Promise<T> = async (act) => await act(),
): Source<TransactionalStores>['history'] {
  return {
    savedPlans: memorySavedPlans(state, stores, writeTurn),
    savedPlanCapture: {
      readPlanInput(projectId) {
        // Capture gets a detached committed graph before its first awaited read.
        const epoch = stores();
        return captureTurn(async () => await capturePlanInput(epoch, projectId));
      },
    },
  };
}
