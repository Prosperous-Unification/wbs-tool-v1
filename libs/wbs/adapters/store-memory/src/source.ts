import type {
  PlanEvent,
  PlanInputReads,
  SavedPlanHoldingRow,
  SavedPlanRow,
  SavedPlanStore,
  SavedPlanWrite,
  SavedPlanWriteOutcome,
  Source,
  StoredDependency,
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
import { type CaptureReadSeam, inertMemoryCaptureReadSeam } from './capture-read-seam';
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
import { inMemoryPlanEvents } from './history-fixture';
import { inertMemoryLateWriteSeam, type MemoryLateWriteSeam } from './late-write-seam';
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
    replaceMap(this.tables.eventLog.rows, next.tables.eventLog.rows);
    replaceMap(this.tables.eventLog.nextSeq, next.tables.eventLog.nextSeq);
    replaceArray(this.tables.journal.entries, next.tables.journal.entries);
    replaceArray(this.tables.journal.events, next.tables.journal.events);
  }
}

function bindStores(
  state: MemoryState,
  lateWrite: MemoryLateWriteSeam = inertMemoryLateWriteSeam,
): TransactionalStores {
  const users = inMemoryUsers(state.tables.users);
  let workItems: TransactionalStores['workItems'] | null = null;
  const fixtureDirectory = inMemoryDirectory((projectId) => {
    if (workItems === null) throw new Error('work-item table was read before it was bound');
    return workItems.listByProject(projectId);
  }, state.tables.directory);
  const directory: TransactionalStores['directory'] = {
    ...fixtureDirectory,
    async renameTag(tagId, name, stamp) {
      const written = await fixtureDirectory.renameTag(tagId, name, stamp);
      if (!written.ok) return written;
      // Proof: the coherent capture RED received projectIds: [] after the real
      // attached tag rename; source-owned relations must supply its touched project.
      const projectIds = [
        ...new Set(
          [...state.tables.workItems.byId.values()]
            .filter((row) => state.tables.workItems.tagsOf.get(row.id)?.includes(tagId) === true)
            .map((row) => row.projectId),
        ),
      ].sort();
      return { ...written, projectIds };
    },
  };
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
    planEvents: inMemoryPlanEvents([], { held: state.tables.journal.events }),
    eventLog: inMemoryEventLog(state.tables.eventLog),
    journal: inMemoryCommandJournal(state.tables.journal, (journalEventIds) => {
      lateWrite.reach('journal-history-insert', { journalEventIds });
    }),
    subtrees: inMemorySubtrees(
      {
        workItems,
        estimates,
        actuals,
        progress,
        measures,
        dependencies,
        directory,
      },
      (satelliteKeys) => {
        lateWrite.reach('subtree-final-satellite', { satelliteKeys });
      },
    ),
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
  return openMemorySourceWithSeams(inertMemoryLateWriteSeam, inertMemoryCaptureReadSeam).source;
}

/**
 * Conformance-only source fixture with a reader for the journal's own history table.
 *
 * @internal
 */
export interface MemorySourceFixture {
  readonly source: Source<TransactionalStores>;
  /** Runs capture and directory writes in one forbidden staged owner, then rolls it back. */
  captureWithStagedDirectoryRollback(
    projectId: string,
    stamp: { readonly at: number; readonly by: string },
    observe: (evidence: {
      readonly project: PlanInputReads['project'];
      readonly tag: Awaited<ReturnType<TransactionalStores['directory']['renameTag']>>;
      readonly person: Awaited<ReturnType<TransactionalStores['directory']['patchPerson']>>;
      readonly tags: Awaited<ReturnType<TransactionalStores['directory']['listTags']>>;
      readonly people: Awaited<ReturnType<TransactionalStores['directory']['listPeople']>>;
    }) => void,
  ): Promise<never>;
  /** Reproduces forbidden ID-keyed dependency uniqueness in source-owned state. */
  storeDependencyById(dependency: StoredDependency): void;
  /** Reproduces the forbidden retained-row sequence derivation in source-owned state. */
  deriveNextEventSeqFromRetained(subscription: string): void;
  /**
   * Moves one committed journal event into adapter-owned disconnected storage.
   * @throws Error when the committed journal has no event with `eventId`.
   */
  routeJournalEventToIndependent(eventId: string): PlanEvent;
  /** Reads the fixture's disconnected journal-event storage as detached records. */
  independentJournalHistoryFor(): Promise<PlanEvent[]>;
  journalHistoryFor(projectId: string): Promise<PlanEvent[]>;
  /** Reproduces UTF-16 counts in adapter-owned history state. @throws When the plan is missing. */
  setSavedPlanByteCounts(savedPlanId: string, inputBytes: number, scheduleBytes: number): void;
  /** Reproduces a header whose bodies were lost. @throws When the plan or either body is missing. */
  removeSavedPlanBodies(savedPlanId: string): void;
  /** Reproduces altered input bytes. @throws When the plan or input body is missing. */
  replaceSavedPlanInputBody(savedPlanId: string, bytes: string): void;
  /** Reproduces an altered schedule hash. @throws When the plan or schedule hash is missing. */
  replaceSavedPlanScheduleHash(savedPlanId: string, sha256: string): void;
  /** Models split/omitted saved-plan body persistence at the real history owner. */
  writeSavedPlanSplit<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
    includeInput: boolean,
    observeBoundary?: (stored: StoredSavedPlan) => void,
  ): Promise<never>;
  /** Routes one history write through the forbidden command coordinator. */
  writeSavedPlanThroughCommandCoordinator<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
  ): Promise<SavedPlanWriteOutcome<Refusal>>;
  /** Runs the real quota callback but suppresses the target state replacement. */
  claimSavedPlanWriteWithoutState<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
  ): Promise<SavedPlanWriteOutcome<Refusal>>;
  /** Activates a history state owned by the current command stage. */
  activateCommandHistoryStage(): void;
  /** Discards the forbidden command-owned history state. */
  discardCommandHistoryStage(): void;
  /** History port backed by the active command-owned stage. */
  readonly commandStagedSavedPlans: SavedPlanStore;
}

/** Opens the conformance fixture with access to adapter-owned persistence seams. @internal */
export function openMemorySourceFixture(): MemorySourceFixture {
  return openMemorySourceWithSeams(inertMemoryLateWriteSeam, inertMemoryCaptureReadSeam);
}

/** @internal */
export function openMemorySourceWithLateWriteSeam(
  lateWrite: MemoryLateWriteSeam,
): MemorySourceFixture {
  return openMemorySourceWithSeams(lateWrite, inertMemoryCaptureReadSeam);
}

/** @internal */
export function openMemorySourceWithCaptureReadSeam(
  captureRead: CaptureReadSeam,
): MemorySourceFixture {
  return openMemorySourceWithSeams(inertMemoryLateWriteSeam, captureRead);
}

function openMemorySourceWithSeams(
  lateWrite: MemoryLateWriteSeam,
  captureRead: CaptureReadSeam,
): MemorySourceFixture {
  const committed = new MemoryState();
  const coordinator = new MemoryCoordinator();
  const historyCoordinator = new MemoryCoordinator();
  const historyState: HistoryState = { plans: new Map() };
  let commandHistoryState: HistoryState | null = null;
  const independentJournalEvents: PlanEvent[] = [];
  const history = memoryHistory(
    historyState,
    () => bindStores(committed.clone(), lateWrite),
    async (act) => await historyCoordinator.run(act),
    undefined,
    lateWrite,
    captureRead,
  );
  const stores = coordinatedStores(bindStores(committed, lateWrite), coordinator);
  const activeCommandHistory = (): SavedPlanStore => {
    if (commandHistoryState === null) throw new Error('command history stage is not active');
    return memorySavedPlans(
      commandHistoryState,
      () => bindStores(committed.clone(), lateWrite),
      async (act) => await act(),
      lateWrite,
    );
  };
  const commandStagedSavedPlans: SavedPlanStore = {
    write: (plan, check) => activeCommandHistory().write(plan, check),
    readOf: (id) => activeCommandHistory().readOf(id),
    listOf: (projectId) => activeCommandHistory().listOf(projectId),
    principalsOf: (id) => activeCommandHistory().principalsOf(id),
    renameTo: (id, name) => activeCommandHistory().renameTo(id, name),
    deleteOf: (id) => activeCommandHistory().deleteOf(id),
  };

  return {
    commandStagedSavedPlans,
    activateCommandHistoryStage() {
      if (commandHistoryState !== null) throw new Error('command history stage activated twice');
      commandHistoryState = { plans: structuredClone(historyState.plans) };
    },
    discardCommandHistoryStage() {
      commandHistoryState = null;
    },
    writeSavedPlanThroughCommandCoordinator: (plan, check) =>
      coordinator.run(async () => await history.savedPlans.write(plan, check)),
    claimSavedPlanWriteWithoutState: async (plan, check) => {
      const rows = [...historyState.plans.values()].filter(
        (stored) => stored.header.projectId === plan.projectId,
      );
      const holding = {
        plans: rows.length,
        bytes: rows.reduce(
          (sum, stored) => sum + stored.header.inputBytes + (stored.header.scheduleBytes ?? 0),
          0,
        ),
      };
      const incomingBytes =
        new TextEncoder().encode(plan.input.bytes).byteLength +
        (plan.schedule.present ? new TextEncoder().encode(plan.schedule.body.bytes).byteLength : 0);
      const refusal = await check(holding, incomingBytes);
      return refusal === null ? { outcome: 'written' } : { outcome: 'refused', refusal };
    },
    captureWithStagedDirectoryRollback(projectId, stamp, observe) {
      return coordinator.run(async () => {
        const staged = committed.clone();
        const stagedStores = bindStores(staged, lateWrite);
        await capturePlanInput(stagedStores, projectId, {
          async afterFirstRead({ project }) {
            const tag = await stagedStores.directory.renameTag(
              'tag-a',
              'Tag after interleave',
              stamp,
            );
            const person = await stagedStores.directory.patchPerson(
              'capture-person-unassigned',
              { teamIds: ['team-a'] },
              stamp,
            );
            const [tags, people] = await Promise.all([
              stagedStores.directory.listTags(),
              stagedStores.directory.listPeople(),
            ]);
            observe({ project, tag, person, tags, people });
            throw new Error('injected staged-owner capture rollback');
          },
        });
        throw new Error('staged-owner capture fault did not reject');
      });
    },
    writeSavedPlanSplit: (plan, check, includeInput, observeBoundary) => {
      // Proof: changing the canonical request ID before this adapter boundary used to
      // exercise the split writer for an unrelated record and certify its failure.
      if (plan.id !== 'late-target')
        return Promise.reject(new Error('saved-plan split target must be late-target'));
      const expectedPlan = structuredClone(plan);
      return historyCoordinator.run(async () => {
        const rows = [...historyState.plans.values()].filter(
          (stored) => stored.header.projectId === plan.projectId,
        );
        const holding = {
          plans: rows.length,
          bytes: rows.reduce(
            (sum, stored) => sum + stored.header.inputBytes + (stored.header.scheduleBytes ?? 0),
            0,
          ),
        };
        const incomingBytes =
          new TextEncoder().encode(plan.input.bytes).byteLength +
          (plan.schedule.present
            ? new TextEncoder().encode(plan.schedule.body.bytes).byteLength
            : 0);
        const refusal = await check(holding, incomingBytes);
        if (refusal !== null) throw new Error('split saved-plan fault was unexpectedly refused');
        historyState.plans.set(plan.id, {
          header: savedPlanRow(plan),
          bodies: { input: includeInput ? plan.input.bytes : null, schedule: null },
        });
        const partial = historyState.plans.get(plan.id);
        if (partial !== undefined) observeBoundary?.(structuredClone(partial));
        if (partial !== undefined)
          lateWrite.observeBoundary?.('saved-plan-schedule-body', {
            savedPlan: structuredClone(partial),
          });
        assertSavedPlanScheduleBoundary(expectedPlan, partial);
        if (partial.bodies.schedule !== null)
          throw new Error('split saved-plan fault persisted schedule too early');
        lateWrite.reach('saved-plan-schedule-body', {
          savedPlan: structuredClone(partial),
        });
        throw new Error('split saved-plan fault control did not reject');
      });
    },
    setSavedPlanByteCounts(savedPlanId, inputBytes, scheduleBytes) {
      const stored = historyState.plans.get(savedPlanId);
      // Proof: removing this guard made the regression fail later with
      // `undefined is not an object (evaluating 'stored.header')`.
      if (stored === undefined) throw new Error(`no saved plan ${savedPlanId}`);
      historyState.plans.set(savedPlanId, {
        ...stored,
        header: { ...stored.header, inputBytes, scheduleBytes },
      });
    },
    removeSavedPlanBodies(savedPlanId) {
      const stored = historyState.plans.get(savedPlanId);
      // Proof: removing this guard made the missing-seam regression receive
      // `undefined is not an object (evaluating 'stored.bodies')`.
      if (stored === undefined) throw new Error(`no saved plan ${savedPlanId}`);
      // Proof: removing this guard made `refuses saved-plan persistence mutations
      // without their exact target state` receive undefined from a call expected to throw.
      if (stored.bodies.input === null || stored.bodies.schedule === null)
        throw new Error(`saved plan ${savedPlanId} does not have both bodies`);
      historyState.plans.set(savedPlanId, {
        ...stored,
        bodies: { input: null, schedule: null },
      });
    },
    replaceSavedPlanInputBody(savedPlanId, bytes) {
      const stored = historyState.plans.get(savedPlanId);
      // Proof: removing this guard made the missing-seam regression receive
      // `undefined is not an object (evaluating 'stored.bodies')`.
      if (stored === undefined) throw new Error(`no saved plan ${savedPlanId}`);
      // Proof: removing this guard made `refuses saved-plan persistence mutations
      // without their exact target state` receive undefined from a call expected to throw.
      if (stored.bodies.input === null)
        throw new Error(`saved plan ${savedPlanId} has no input body`);
      historyState.plans.set(savedPlanId, {
        ...stored,
        bodies: { ...stored.bodies, input: bytes },
      });
    },
    replaceSavedPlanScheduleHash(savedPlanId, sha256) {
      const stored = historyState.plans.get(savedPlanId);
      // Proof: removing this guard made the missing-seam regression receive
      // `undefined is not an object (evaluating 'stored.header')`.
      if (stored === undefined) throw new Error(`no saved plan ${savedPlanId}`);
      // Proof: removing this guard made `refuses saved-plan persistence mutations
      // without their exact target state` receive undefined from a call expected to throw.
      if (stored.header.scheduleSha256 === null)
        throw new Error(`saved plan ${savedPlanId} has no schedule hash`);
      historyState.plans.set(savedPlanId, {
        ...stored,
        header: { ...stored.header, scheduleSha256: sha256 },
      });
    },
    storeDependencyById(toAdd) {
      if (committed.tables.dependencies.rows.some(({ id }) => id === toAdd.id)) return;
      committed.tables.dependencies.rows.push(structuredClone(toAdd));
    },
    deriveNextEventSeqFromRetained(subscription) {
      const retained = committed.tables.eventLog.rows.get(subscription) ?? [];
      committed.tables.eventLog.nextSeq.set(subscription, (retained.at(-1)?.seq ?? -1) + 1);
    },
    routeJournalEventToIndependent(eventId) {
      const index = committed.tables.journal.events.findIndex(({ id }) => id === eventId);
      // Proof: removing this guard made the real-fixture missing-route test fail
      // with `Received function did not throw; Received value: undefined`.
      if (index < 0) throw new Error(`no journal event ${eventId}`);
      const found = committed.tables.journal.events[index];
      committed.tables.journal.events.splice(index, 1);
      const moved = structuredClone(found);
      independentJournalEvents.push(moved);
      return structuredClone(moved);
    },
    independentJournalHistoryFor() {
      return Promise.resolve(structuredClone(independentJournalEvents));
    },
    journalHistoryFor(projectId) {
      return Promise.resolve(
        committed.tables.journal.events
          .filter((event) => event.projectId === projectId)
          .map((event) => structuredClone(event)),
      );
    },
    source: {
      stores,
      history,
      uow: {
        run: (act) =>
          coordinator.run(async () => {
            const staged = committed.clone();
            const decision = await act({ stores: bindStores(staged, lateWrite) });
            if (decision.commit) committed.replaceWith(staged);
            else if (decision.afterRollback !== undefined) {
              await decision.afterRollback({ stores: bindStores(committed, lateWrite) });
            }
            return decision.value;
          }),
      },
      health: () => Promise.resolve({ ok: true }),
      close: () => Promise.resolve(),
    },
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

function assertSavedPlanScheduleBoundary(
  plan: SavedPlanWrite,
  stored: StoredSavedPlan | undefined,
): asserts stored is StoredSavedPlan {
  // Proof: removing this guard changed the adapter-owned missing-input proof
  // from `phase-failed` to `observed` after the invalid boundary reached.
  if (
    stored === undefined ||
    JSON.stringify(stored.header) !== JSON.stringify(savedPlanRow(plan)) ||
    stored.bodies.input !== plan.input.bytes
  )
    throw new Error('saved-plan schedule boundary lacks complete header and input');
}

function memorySavedPlans(
  state: HistoryState,
  stores: () => TransactionalStores,
  writeTurn: <T>(act: () => Promise<T>) => Promise<T>,
  lateWrite: MemoryLateWriteSeam,
): SavedPlanStore {
  return {
    write: (plan, check) => {
      const expectedPlan = structuredClone(plan);
      return writeTurn(async () => {
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
        const staged = structuredClone(state.plans);
        const pending: StoredSavedPlan = {
          header: savedPlanRow(plan),
          bodies: {
            input: plan.input.bytes,
            schedule: null,
          },
        };
        staged.set(plan.id, pending);
        if (plan.schedule.present) {
          if (lateWrite.isActive?.('saved-plan-schedule-body') === true) {
            lateWrite.observeBoundary?.('saved-plan-schedule-body', {
              savedPlan: structuredClone(pending),
            });
            assertSavedPlanScheduleBoundary(expectedPlan, pending);
            lateWrite.reach('saved-plan-schedule-body', {
              savedPlan: structuredClone(pending),
            });
          } else lateWrite.reach('saved-plan-schedule-body');
          staged.set(plan.id, {
            ...pending,
            bodies: { ...pending.bodies, schedule: plan.schedule.body.bytes },
          });
        }
        replaceMap(state.plans, staged);
        return { outcome: 'written' };
      });
    },
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
  captureRead: CaptureReadSeam,
): Promise<PlanInputReads | null> {
  const project = await stores.projects.findById(projectId);
  if (project === null) return null;
  await captureRead.afterFirstRead({ projectId, project });
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
  lateWrite: MemoryLateWriteSeam = inertMemoryLateWriteSeam,
  captureRead: CaptureReadSeam = inertMemoryCaptureReadSeam,
): Source<TransactionalStores>['history'] {
  return {
    savedPlans: memorySavedPlans(state, stores, writeTurn, lateWrite),
    savedPlanCapture: {
      readPlanInput(projectId) {
        // Capture gets a detached committed graph before its first awaited read.
        const epoch = stores();
        return captureTurn(async () => await capturePlanInput(epoch, projectId, captureRead));
      },
    },
  };
}
