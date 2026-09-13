import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertCompleteStateAlternative,
  assertFaultVariantCoverage,
  assertSeedState,
  brokenSource,
  type Capabilities,
  type CaptureDirectoryChange,
  type CaseFixture,
  type CaseId,
  createFaultControl,
  defineFault,
  DEPENDENCY_SURVIVOR_IDS,
  DETERMINISTIC_SEED,
  type ExistingStoreOpeners,
  existingStoreRegistrations,
  expectedCasesFor,
  type Fault,
  type FaultCase,
  type FaultProof,
  type FaultRun,
  type HistoryBatchFixture,
  observePlanInput,
  printCertification,
  PROGRESS_SENTINEL_STEP_ID,
  readSubtreePublicState,
  recordFaultProof,
  replaceMethod,
  runCases,
  savedPlanCaptureExpected,
  seedSavedPlanCapture,
  sourceConformanceRegistrations,
  type SourceDeclaration,
  type SourceReaders,
  sourceRevision,
  subtreeSeedRecords,
} from '@wbs/conformance';
import type {
  JournalEntry,
  PlanEvent,
  PlanInputReads,
  SavedPlanCaptureStore,
  SavedPlanHoldingRow,
  SavedPlanPrincipals,
  SavedPlanRow,
  SavedPlanStore,
  SavedPlanWrite,
  SavedPlanWriteOutcome,
  StoredDependency,
  StoredSavedPlan,
  SubtreeCopy,
  TeamWithServices,
  TransactionalStores,
  User,
  WriteStamp,
} from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { DEFAULT_ESTIMATE_RULE } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';

import type { SqliteLateWriteEvidence } from '../late-write-seam';
import { runMigrations } from '../migrate';
import { SavedPlanCaptureRepository } from '../saved-plan-capture';
import {
  actual as actualTable,
  calendarMarker as markerTable,
  eventSequencer,
  personTeam as personTeamTable,
  stepMeasure as measureTable,
  stepProgress as progressTable,
  tag as tagTable,
  users as userTable,
} from '../schema';
import {
  openSqliteSource,
  type OpenSqliteSourceOptions,
  openSqliteSourceWithCaptureReadSeam,
  type SqliteSource,
} from '../source';
import {
  openSqliteSourceWithFault,
  openSqliteSourceWithMissingSavedPlanInput,
  openSqliteSourceWithNonAtomicSavedPlanFault,
  openSqliteSourceWithNonAtomicSubtreeFault,
  sqliteLateWriteControl,
} from './faults';

const MIGRATIONS = new URL('../../../../apps/be-01/drizzle', import.meta.url).pathname;
type ExistingFamily = Exclude<keyof ExistingStoreOpeners, 'savedPlans' | 'savedPlanCapture'>;
type OpenSource = (options: OpenSqliteSourceOptions) => SqliteSource;
type Task62SqliteSource = SqliteSource & {
  quotaRivalOwner?: { settlement?: Promise<unknown> };
};
type SavedPlanCheck<Refusal> = (
  holding: SavedPlanHoldingRow,
  incomingBytes: number,
) => Promise<Refusal | null>;

async function closeSqliteResources(
  source: SqliteSource | undefined,
  directory: string,
): Promise<void> {
  let didCloseFail = false;
  let closeFailure: unknown;
  if (source !== undefined) {
    try {
      await source.close();
    } catch (failure) {
      didCloseFail = true;
      closeFailure = failure;
    }
  }

  let didRemoveFail = false;
  let removeFailure: unknown;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (failure) {
    didRemoveFail = true;
    removeFailure = failure;
  }

  if (didCloseFail && didRemoveFail) {
    throw new AggregateError(
      [closeFailure, removeFailure],
      'SQLite conformance source close and directory removal failed',
      { cause: closeFailure },
    );
  }
  if (didCloseFail) throw closeFailure;
  if (didRemoveFail) throw removeFailure;
}

async function throwAfterCleanup(
  setupFailure: unknown,
  source: SqliteSource | undefined,
  directory: string,
): Promise<never> {
  try {
    await closeSqliteResources(source, directory);
  } catch (cleanupFailure) {
    throw new AggregateError(
      [setupFailure, cleanupFailure],
      'SQLite conformance setup and cleanup failed',
      { cause: cleanupFailure },
    );
  }
  throw setupFailure;
}

function readersOf(source: SqliteSource): SourceReaders {
  return {
    projects: source.stores.projects,
    workItems: source.stores.workItems,
    steps: source.stores.steps,
    estimates: source.stores.estimates,
    actuals: source.stores.actuals,
    measures: source.stores.measures,
    progress: source.stores.progress,
    dependencies: source.stores.dependencies,
    directory: source.stores.directory,
    journal: source.stores.journal,
    planEvents: source.stores.planEvents,
    savedPlans: source.history.savedPlans,
  };
}

async function seedSqliteSource(
  openSource: OpenSource = openSqliteSource,
  finishSeed?: (source: SqliteSource) => Promise<void>,
): Promise<{
  readonly source: SqliteSource;
  readonly directory: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-sqlite-conformance-'));
  let source: SqliteSource | undefined;
  try {
    const dbPath = join(directory, 'source.db');
    runMigrations(dbPath, MIGRATIONS);
    source = openSource({ dbPath });
    const seed = DETERMINISTIC_SEED;
    for (const [index, ownerId] of seed.ownerIds.entries()) {
      const stamp = seed.stamps[index] ?? seed.stamps[0];
      const projectId = seed.projectIds[index] ?? seed.projectIds[0];
      const stepIds = seed.stepIds[index] ?? seed.stepIds[0];
      await source.stores.users.create(
        {
          id: ownerId,
          username: `owner-${String(index + 1)}`,
          passwordHash: 'x',
          createdAt: stamp.at,
        },
        stamp,
      );
      await source.stores.projects.create(
        {
          id: projectId,
          ownerId,
          name: `Project ${String(index + 1)}`,
          restricted: false,
          estimateMethod: 'pert',
          depReach: 'whole-item',
          pertWeights: DEFAULT_ESTIMATE_RULE.pertWeights,
          estimateRounding: DEFAULT_ESTIMATE_RULE.rounding,
          startDate: null,
          solutionRef: null,
          revision: 0,
          createdAt: stamp.at,
          optimizationEnabled: false,
          scheduleEngine: 'fast',
          scheduleObjective: 'pri',
        },
        stepIds.map((id, stepIndex) => ({
          id,
          projectId,
          name: stepIndex === 0 ? 'Dev' : 'QA',
          position: (stepIndex + 1) * 10,
        })),
        stamp,
      );
      const workItemIds = seed.workItemIds[index] ?? seed.workItemIds[0];
      for (const [rowIndex, id] of workItemIds.entries()) {
        await source.stores.workItems.insert(
          workItemRow({ id, projectId, name: `Work ${String(rowIndex + 1)}` }),
          [],
          stamp,
        );
      }
    }
    for (const [index, teamId] of seed.teamIds.entries()) {
      await source.stores.directory.addTeam(
        { id: teamId, name: `Team ${String(index + 1)}` },
        seed.stamps[0],
      );
    }
    await source.stores.directory.addTag({ id: seed.tagIds[0], name: 'Tag 1' }, seed.stamps[0]);
    await source.stores.directory.addService(
      { id: seed.serviceIds[0], name: 'Service 1' },
      seed.stamps[0],
    );
    await source.stores.directory.addWorkItemType(
      { id: seed.typeIds[0], name: 'Type 1' },
      seed.stamps[0],
    );
    for (const [index, personId] of seed.personIds.entries()) {
      await source.stores.directory.addPerson(
        { id: personId, name: `Person ${String(index + 1)}` },
        [seed.teamIds[index] ?? seed.teamIds[0]],
        seed.stamps[0],
      );
    }
    await verifySqliteSeed(source);
    await finishSeed?.(source);
    return { source, directory };
  } catch (failure) {
    return throwAfterCleanup(failure, source, directory);
  }
}

async function verifySqliteSeed(source: SqliteSource): Promise<void> {
  const seed = DETERMINISTIC_SEED;
  for (const [index, projectId] of seed.projectIds.entries()) {
    const project = await source.stores.projects.findById(projectId);
    expect(project).toMatchObject({
      id: projectId,
      ownerId: seed.ownerIds[index],
      name: `Project ${String(index + 1)}`,
    });
    expect(
      (await source.stores.steps.listByProject(projectId)).map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: seed.stepIds[index][0], name: 'Dev' },
      { id: seed.stepIds[index][1], name: 'QA' },
    ]);
    expect((await source.stores.workItems.listByProject(projectId)).map(({ id }) => id)).toEqual([
      ...seed.workItemIds[index],
    ]);
  }
  expect((await source.stores.directory.listTeams()).map(({ id }) => id).sort()).toEqual([
    ...seed.teamIds,
  ]);
  expect((await source.stores.directory.listPeople()).map(({ id }) => id).sort()).toEqual([
    ...seed.personIds,
  ]);
  expect((await source.stores.directory.listTags()).map(({ id }) => id)).toContain(seed.tagIds[0]);
  expect((await source.stores.directory.listServices()).map(({ id }) => id)).toContain(
    seed.serviceIds[0],
  );
  expect((await source.stores.directory.listWorkItemTypes()).map(({ id }) => id)).toContain(
    seed.typeIds[0],
  );
  expect((await source.stores.directory.listExternalSystems()).map(({ id }) => id)).toContain(
    seed.externalSystemIds[0],
  );
}

function sqliteFixture<Family extends ExistingFamily>(
  source: SqliteSource,
  directory: string,
  family: Family,
  caseId: CaseId,
): CaseFixture<TransactionalStores[Family]> {
  return {
    fixtureId: `sqlite:${caseId}`,
    port: source.stores[family],
    journalAppender: source.stores.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario: { kind: 'ordinary' },
    close: () => closeSqliteResources(source, directory),
  };
}

async function openSqliteCase<Family extends ExistingFamily>(
  family: Family,
  caseId: CaseId,
  openSource: OpenSource = openSqliteSource,
): Promise<CaseFixture<TransactionalStores[Family]>> {
  const lateControl =
    family === 'subtrees' && caseId === 'subtrees.insertSubtree:late-failure'
      ? sqliteLateWriteControl('subtree-final-satellite')
      : family === 'journal' && caseId === 'journal.append:history-atomic'
        ? sqliteLateWriteControl('journal-history-insert')
        : null;
  const selectedOpen: OpenSource =
    lateControl === null
      ? openSource
      : (options) => openSqliteSourceWithFault(options, lateControl);
  const { source, directory } = await seedSqliteSource(
    selectedOpen,
    family === 'progress'
      ? seedProgressStep
      : family === 'dependencies'
        ? seedDependencyWorkItems
        : family === 'subtrees'
          ? seedSubtreeRecords
          : undefined,
  );
  if (family === 'subtrees') {
    return {
      ...sqliteFixture(source, directory, family, caseId),
      scenario:
        lateControl === null
          ? { kind: 'ordinary' }
          : {
              kind: 'late-write',
              point: 'subtree-final-satellite',
              arm: () => {
                lateControl.arm();
              },
              reached: () => lateControl.reached(),
              evidence: () => lateControl.observedSavedPlan(),
            },
    };
  }
  if (family === 'journal') {
    return {
      ...sqliteFixture(source, directory, family, caseId),
      scenario:
        lateControl === null
          ? { kind: 'ordinary' }
          : {
              kind: 'late-write',
              point: 'journal-history-insert',
              arm: () => {
                lateControl.arm();
              },
              reached: () => lateControl.reached(),
              evidence: () => lateControl.observedSavedPlan(),
            },
    };
  }
  return sqliteFixture(source, directory, family, caseId);
}

async function openSqliteSavedPlanCase(
  caseId: CaseId,
  observeBoundary: (evidence: SqliteLateWriteEvidence) => void = () => undefined,
): Promise<CaseFixture<SavedPlanStore>> {
  const lateControl =
    caseId === 'savedPlans.write:late-body-failure'
      ? sqliteLateWriteControl('saved-plan-schedule-body')
      : null;
  const { source, directory } = await seedSqliteSource(
    lateControl === null
      ? openSqliteSource
      : (options) => openSqliteSourceWithFault(options, lateControl, undefined, observeBoundary),
  );
  return {
    fixtureId: `sqlite:${caseId}`,
    port: source.history.savedPlans,
    journalAppender: source.stores.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario:
      caseId === 'savedPlans.write:quota-window'
        ? {
            kind: 'competing-history-write',
            rivalWriter: source.history.savedPlans,
            expectedRival: 'snapshot_busy',
          }
        : lateControl === null
          ? { kind: 'ordinary' }
          : {
              kind: 'late-write',
              point: 'saved-plan-schedule-body',
              arm: () => {
                lateControl.arm();
              },
              reached: () => lateControl.reached(),
              evidence: () => lateControl.observedSavedPlan(),
            },
    close: () => closeSqliteResources(source, directory),
  };
}

async function openSqliteSavedPlanCaptureCase(
  caseId: CaseId,
): Promise<CaseFixture<SavedPlanCaptureStore>> {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  let didEnter = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const openSource: OpenSource =
    caseId === 'savedPlanCapture.readPlanInput:coherent-interleave'
      ? (options) =>
          openSqliteSourceWithCaptureReadSeam(options, {
            async afterFirstRead({ projectId, project }) {
              if (projectId !== 'project-a' || didEnter) return;
              if (project.id !== 'project-a' || project.name !== 'Captured project A')
                throw new Error('SQLite capture first-read evidence is not project A');
              didEnter = true;
              enter();
              await released;
            },
          })
      : openSqliteSource;
  const { source, directory } = await seedSqliteSource(openSource, async (seeded) => {
    await seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED);
  });
  return {
    fixtureId: `sqlite:${caseId}`,
    port: source.history.savedPlanCapture,
    journalAppender: source.stores.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario:
      caseId === 'savedPlanCapture.readPlanInput:coherent-interleave'
        ? {
            kind: 'capture-interleave',
            firstRead: { entered, release },
            changeDirectory: () => changeSqliteCaptureDirectory(source),
          }
        : { kind: 'ordinary' },
    close: async () => {
      release();
      await closeSqliteResources(source, directory);
    },
  };
}

async function openSqliteHistoryBatchCase(
  caseId: CaseId,
  routeThroughCommandCoordinator = false,
): Promise<HistoryBatchFixture> {
  const { source, directory } = await seedSqliteSource();
  const base = source.history.savedPlans;
  const port: SavedPlanStore = routeThroughCommandCoordinator
    ? {
        write: (plan, check) => source.gate.enter(async () => await base.write(plan, check)),
        readOf: (id) => base.readOf(id),
        listOf: (projectId) => base.listOf(projectId),
        principalsOf: (id) => base.principalsOf(id),
        renameTo: (id, name) => base.renameTo(id, name),
        deleteOf: (id) => base.deleteOf(id),
      }
    : base;
  let release: (decision: 'commit' | 'rollback') => void = () => undefined;
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<'commit' | 'rollback'>((resolve) => {
    release = resolve;
  });
  let batch: Promise<void> | undefined;
  let settled = false;
  return {
    fixtureId: `sqlite:${caseId}`,
    port,
    journalAppender: source.stores.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario: {
      kind: 'batch-settlement',
      async begin() {
        if (batch !== undefined) throw new Error('SQLite history batch began twice');
        batch = source.uow.run(async ({ stores }) => {
          const projectId = DETERMINISTIC_SEED.projectIds[0];
          const stamp = { at: 700, by: DETERMINISTIC_SEED.ownerIds[0] };
          const updated = await stores.projects.update(
            projectId,
            { name: `Held ${caseId}` },
            stamp,
          );
          const observed = await stores.projects.findById(projectId);
          if (updated === null || observed?.name !== `Held ${caseId}`)
            throw new Error('SQLite history batch did not complete its in-scope update');
          enter();
          const decision = await released;
          return { commit: decision === 'commit', value: undefined };
        });
        await entered;
      },
      entered,
      async settle(decision) {
        if (batch === undefined) throw new Error('SQLite history batch settled before begin');
        if (settled) throw new Error('SQLite history batch settled twice');
        settled = true;
        release(decision);
        await batch;
      },
    },
    close: async () => {
      if (batch !== undefined && !settled) {
        settled = true;
        release('rollback');
        await batch;
      }
      await closeSqliteResources(source, directory);
    },
  };
}

async function changeSqliteCaptureDirectory(source: SqliteSource): Promise<CaptureDirectoryChange> {
  const stamp = { at: 600, by: DETERMINISTIC_SEED.ownerIds[1] };
  const change = await source.uow.run(async ({ stores }) => {
    const tag = await stores.directory.renameTag('tag-a', 'Tag after interleave', stamp);
    const person = await stores.directory.patchPerson(
      'capture-person-unassigned',
      { teamIds: ['team-a'] },
      stamp,
    );
    return { commit: true, value: { tag, person } };
  });
  const [tags, people] = await Promise.all([
    source.stores.directory.listTags(),
    source.stores.directory.listPeople(),
  ]);
  tags.sort((left, right) => left.id.localeCompare(right.id));
  people.sort((left, right) => left.id.localeCompare(right.id));
  expect({ change, tags, people }).toEqual({
    change: {
      tag: {
        ok: true,
        tag: { id: 'tag-a', name: 'Tag after interleave' },
        projectIds: ['project-a'],
      },
      person: {
        ok: true,
        person: {
          id: 'capture-person-unassigned',
          name: 'Unassigned member',
          kind: 'person',
          teamIds: ['team-a'],
        },
        projectIds: [],
      },
    },
    tags: [
      { id: 'capture-tag-only', name: 'Capture-only tag' },
      { id: 'tag-a', name: 'Tag after interleave' },
    ],
    people: [
      {
        id: 'capture-person-unassigned',
        name: 'Unassigned member',
        kind: 'person',
        teamIds: ['team-a'],
      },
      { id: 'person-a', name: 'Person 1', kind: 'person', teamIds: ['team-a'] },
      { id: 'person-b', name: 'Person 2', kind: 'person', teamIds: ['team-b'] },
    ],
  });
  return change;
}

async function seedProgressStep(source: SqliteSource): Promise<void> {
  await source.stores.steps.add(
    {
      id: PROGRESS_SENTINEL_STEP_ID,
      projectId: DETERMINISTIC_SEED.projectIds[0],
      name: 'Review',
    },
    DETERMINISTIC_SEED.stamps[0],
  );
}

async function seedDependencyWorkItems(source: SqliteSource): Promise<void> {
  for (const [index, id] of DEPENDENCY_SURVIVOR_IDS.entries()) {
    await source.stores.workItems.insert(
      workItemRow({
        id,
        projectId: DETERMINISTIC_SEED.projectIds[0],
        name: `Dependency survivor ${String(index + 1)}`,
        position: (index + 3) * 10,
      }),
      [],
      DETERMINISTIC_SEED.stamps[0],
    );
  }
  expect(
    (await source.stores.workItems.listByProject(DETERMINISTIC_SEED.projectIds[0]))
      .map(({ id }) => id)
      .toSorted(),
  ).toEqual([...DETERMINISTIC_SEED.workItemIds[0], ...DEPENDENCY_SURVIVOR_IDS].toSorted());
}

async function seedSubtreeRecords(source: SqliteSource): Promise<void> {
  const seeded = subtreeSeedRecords(DETERMINISTIC_SEED);
  for (const row of seeded.estimates)
    await source.stores.estimates.set(structuredClone(row), DETERMINISTIC_SEED.stamps[0]);
  for (const row of seeded.actuals)
    await source.stores.actuals.set(structuredClone(row), DETERMINISTIC_SEED.stamps[0]);
  for (const row of seeded.progress)
    await source.stores.progress.set(structuredClone(row), DETERMINISTIC_SEED.stamps[0]);
  for (const row of seeded.measures)
    await source.stores.measures.set(structuredClone(row), DETERMINISTIC_SEED.stamps[0]);
  for (const row of seeded.assignments) {
    expect(
      await source.stores.directory.assign(
        row.workItemId,
        row.stepId,
        row.personId,
        DETERMINISTIC_SEED.stamps[0],
      ),
    ).toEqual({ ok: true });
  }
  for (const row of seeded.dependencies)
    await source.stores.dependencies.add(structuredClone(row), DETERMINISTIC_SEED.stamps[0]);
}

const openers: ExistingStoreOpeners = {
  projects: (caseId) => openSqliteCase('projects', caseId),
  users: (caseId) => openSqliteCase('users', caseId),
  capacity: (caseId) => openSqliteCase('capacity', caseId),
  priorityBands: (caseId) => openSqliteCase('priorityBands', caseId),
  calendarMarkers: (caseId) => openSqliteCase('calendarMarkers', caseId),
  workItems: (caseId) => openSqliteCase('workItems', caseId),
  steps: (caseId) => openSqliteCase('steps', caseId),
  estimates: (caseId) => openSqliteCase('estimates', caseId),
  actuals: (caseId) => openSqliteCase('actuals', caseId),
  measures: (caseId) => openSqliteCase('measures', caseId),
  progress: (caseId) => openSqliteCase('progress', caseId),
  dependencies: (caseId) => openSqliteCase('dependencies', caseId),
  directory: (caseId) => openSqliteCase('directory', caseId),
  eventLog: (caseId) => openSqliteCase('eventLog', caseId),
  planEvents: (caseId) => openSqliteCase('planEvents', caseId),
  subtrees: (caseId) => openSqliteCase('subtrees', caseId),
  journal: (caseId) => openSqliteCase('journal', caseId),
  savedPlans: (caseId) => openSqliteSavedPlanCase(caseId),
  savedPlanCapture: (caseId) => openSqliteSavedPlanCaptureCase(caseId),
};

const sourceOpeners = { ...openers, historyBatch: openSqliteHistoryBatchCase };

const declaration: SourceDeclaration = {
  name: 'sqlite',
  revision: sourceRevision(),
  historyAdmission: 'immediate-busy',
  capabilities: {
    projects: { kind: 'offered', gaps: [], open: openers.projects },
    users: { kind: 'offered', gaps: [], open: openers.users },
    capacity: { kind: 'offered', gaps: [], open: openers.capacity },
    priorityBands: { kind: 'offered', gaps: [], open: openers.priorityBands },
    calendarMarkers: { kind: 'offered', gaps: [], open: openers.calendarMarkers },
    workItems: { kind: 'offered', gaps: [], open: openers.workItems },
    steps: { kind: 'offered', gaps: [], open: openers.steps },
    estimates: { kind: 'offered', gaps: [], open: openers.estimates },
    actuals: { kind: 'offered', gaps: [], open: openers.actuals },
    measures: { kind: 'offered', gaps: [], open: openers.measures },
    progress: { kind: 'offered', gaps: [], open: openers.progress },
    dependencies: { kind: 'offered', gaps: [], open: openers.dependencies },
    directory: { kind: 'offered', gaps: [], open: openers.directory },
    eventLog: { kind: 'offered', gaps: [], open: openers.eventLog },
    planEvents: { kind: 'offered', gaps: [], open: openers.planEvents },
    subtrees: { kind: 'offered', gaps: [], open: openers.subtrees },
    journal: { kind: 'offered', gaps: [], open: openers.journal },
    savedPlans: { kind: 'offered', gaps: [], open: openers.savedPlans },
    savedPlanCapture: { kind: 'offered', gaps: [], open: openers.savedPlanCapture },
  } satisfies Capabilities,
};

function withStores(source: SqliteSource, stores: Partial<TransactionalStores>): SqliteSource {
  return { ...source, stores: { ...source.stores, ...stores } };
}

function withSavedPlans(source: SqliteSource, savedPlans: SavedPlanStore): SqliteSource {
  return { ...source, history: { ...source.history, savedPlans } };
}

function withSavedPlanCapture(
  source: SqliteSource,
  savedPlanCapture: SavedPlanCaptureStore,
): SqliteSource {
  return { ...source, history: { ...source.history, savedPlanCapture } };
}

function captureMatchesOracle(
  capture: PlanInputReads,
  projectIndex: 0 | 1,
  directoryEpoch: 'before' | 'after' = 'before',
): boolean {
  const observed = observePlanInput(capture);
  return (['memory-unbumped', 'sqlite-bumped'] as const).some((revisionPolicy) =>
    Bun.deepEquals(
      observed,
      savedPlanCaptureExpected(DETERMINISTIC_SEED, projectIndex, revisionPolicy, directoryEpoch),
    ),
  );
}

function optionalCaptureMatchesOracle(
  capture: PlanInputReads | null,
  projectIndex: 0 | 1,
): boolean {
  return capture !== null && captureMatchesOracle(capture, projectIndex);
}

function captureObservationMatchesOracle(
  observed: ReturnType<typeof observePlanInput> | null,
  projectIndex: 0 | 1,
): boolean {
  return (
    observed !== null &&
    (['memory-unbumped', 'sqlite-bumped'] as const).some((revisionPolicy) =>
      Bun.deepEquals(
        observed,
        savedPlanCaptureExpected(DETERMINISTIC_SEED, projectIndex, revisionPolicy),
      ),
    )
  );
}

function emptyMissingCapture(): PlanInputReads {
  return {
    project: {
      id: 'capture-project-missing',
      name: 'Invented empty capture',
      ownerId: 'owner-a',
      restricted: false,
      estimateMethod: 'pert',
      depReach: 'whole-item',
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'ceil',
      startDate: null,
      scheduleEngine: 'fast',
      scheduleObjective: 'pri',
      optimizationEnabled: false,
      solutionRef: null,
    },
    steps: [],
    workItems: [],
    estimates: [],
    actuals: [],
    progress: [],
    measures: [],
    dependencies: [],
    assignments: [],
    capacity: new Map(),
    priorityBands: [],
    people: [],
    teams: [],
    services: [],
    tags: [],
    workItemTypes: [],
    externalSystems: [],
  };
}

function captureFaultSource(
  source: SqliteSource,
  control: ReturnType<typeof createFaultControl>,
  mode: 'complete' | 'missing' | 'detached',
  mutateResult = true,
  targetId = mode === 'missing' ? 'capture-project-missing' : 'project-a',
): SqliteSource {
  let retainedTags: readonly { readonly id: string; readonly name: string }[] | null = null;
  let targetReads = 0;
  return withSavedPlanCapture(source, {
    async readPlanInput(projectId) {
      const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
      if (!control.isArmed()) return captured;
      if (mode === 'complete' && projectId === targetId) {
        if (captured === null || !captureMatchesOracle(captured, 0))
          throw new Error('complete capture prerequisite was not established');
        if (!control.reach(control.phase)) return captured;
        return mutateResult ? { ...captured, tags: [] } : captured;
      }
      if (mode === 'missing' && projectId === targetId) {
        if (captured !== null) throw new Error('missing capture prerequisite was not null');
        if (!control.reach(control.phase)) return captured;
        return mutateResult ? emptyMissingCapture() : captured;
      }
      if (mode === 'detached' && projectId === targetId) {
        targetReads += 1;
        if (captured === null || !captureMatchesOracle(captured, 0))
          throw new Error('detached capture prerequisite was not complete');
        if (targetReads === 1) {
          retainedTags = captured.tags;
          return captured;
        }
        if (retainedTags?.length !== 0)
          throw new Error('detached caller mutation was not observed');
        if (!control.reach(control.phase)) return captured;
        return mutateResult ? { ...captured, tags: retainedTags } : captured;
      }
      return captured;
    },
  });
}

function rejectCaptureRead(
  source: SqliteSource,
  targetId: string,
  probe: { attempts: number; closeCalls: number },
): SqliteSource {
  return withSavedPlanCapture(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    replaceMethod(source.history.savedPlanCapture, 'readPlanInput', (readPlanInput) => {
      return (projectId) => {
        if (projectId !== targetId) return readPlanInput(projectId);
        probe.attempts += 1;
        return Promise.reject(new Error('injected capture failure before the real read'));
      };
    }),
  );
}

const captureCompleteFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:complete',
  caseId: 'savedPlanCapture.readPlanInput:complete',
  createControl: () => createFaultControl('saved-plan-capture:complete:omit-tags'),
  mutate: (source: SqliteSource, control) => captureFaultSource(source, control, 'complete'),
});

const captureMissingFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:missing-project',
  caseId: 'savedPlanCapture.readPlanInput:missing-project',
  createControl: () => createFaultControl('saved-plan-capture:missing:empty-capture'),
  mutate: (source: SqliteSource, control) => captureFaultSource(source, control, 'missing'),
});

const captureDetachedFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:detached',
  caseId: 'savedPlanCapture.readPlanInput:detached',
  createControl: () => createFaultControl('saved-plan-capture:detached:shared-tags'),
  mutate: (source: SqliteSource, control) => captureFaultSource(source, control, 'detached'),
});

function coherentCaptureFaultSource(
  source: SqliteSource,
  control: ReturnType<typeof createFaultControl>,
  mutateResult = true,
  targetId = 'project-a',
): SqliteSource {
  let targetReads = 0;
  return withSavedPlanCapture(source, {
    async readPlanInput(projectId) {
      const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
      if (!control.isArmed() || projectId !== targetId) return captured;
      targetReads += 1;
      if (targetReads > 1) return captured;
      if (captured === null || !captureMatchesOracle(captured, 0, 'before'))
        throw new Error('coherent capture prerequisite was not complete before state');
      const [tags, people] = await Promise.all([
        source.stores.directory.listTags(),
        source.stores.directory.listPeople(),
      ]);
      const torn = { ...captured, tags, people };
      if (!captureMatchesOracle(torn, 0, 'after'))
        throw new Error(
          'coherent outside-epoch directory prerequisite was not complete after state',
        );
      if (!control.reach(control.phase)) return captured;
      return mutateResult ? torn : captured;
    },
  });
}

const captureCoherentFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:coherent-interleave',
  caseId: 'savedPlanCapture.readPlanInput:coherent-interleave',
  createControl: () => createFaultControl('saved-plan-capture:coherent:directory-outside-epoch'),
  mutate: (source: SqliteSource, control) => coherentCaptureFaultSource(source, control),
});

function replaceSavedPlanWrite(
  savedPlans: SavedPlanStore,
  replace: (write: SavedPlanStore['write']) => SavedPlanStore['write'],
): SavedPlanStore {
  return {
    write: replace(savedPlans.write.bind(savedPlans)),
    readOf: (savedPlanId) => savedPlans.readOf(savedPlanId),
    listOf: (projectId) => savedPlans.listOf(projectId),
    principalsOf: (savedPlanId) => savedPlans.principalsOf(savedPlanId),
    renameTo: (savedPlanId, name) => savedPlans.renameTo(savedPlanId, name),
    deleteOf: (savedPlanId) => savedPlans.deleteOf(savedPlanId),
  };
}

const capacityProjectTeamFault = defineFault({
  id: 'break:capacity.set:project-team-key',
  caseId: 'capacity.set:project-team-key',
  createControl: () => createFaultControl('capacity.set:project-team-key'),
  mutate(source: SqliteSource, control) {
    const projectByTeam = new Map<string, string>();
    return withStores(source, {
      capacity: replaceMethod(source.stores.capacity, 'set', (set) => {
        return (projectId, teamId, size, stamp) => {
          const firstProjectId = projectByTeam.get(teamId);
          projectByTeam.set(teamId, firstProjectId ?? projectId);
          return set(
            firstProjectId !== undefined &&
              firstProjectId !== projectId &&
              control.reach('capacity.set:project-team-key')
              ? firstProjectId
              : projectId,
            teamId,
            size,
            stamp,
          );
        };
      }),
    });
  },
});

const capacityClearFault = defineFault({
  id: 'break:capacity.set:clear',
  caseId: 'capacity.set:clear',
  createControl: () => createFaultControl('capacity.set:clear'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      capacity: replaceMethod(source.stores.capacity, 'set', (set) => {
        return async (projectId, teamId, size, stamp) => {
          if (size !== null || !control.reach('capacity.set:clear')) {
            return set(projectId, teamId, size, stamp);
          }
          source.db.run(sql.raw('PRAGMA ignore_check_constraints = ON'));
          try {
            return await set(projectId, teamId, 0, stamp);
          } finally {
            source.db.run(sql.raw('PRAGMA ignore_check_constraints = OFF'));
          }
        };
      }),
    });
  },
});

const capacityMissingReferenceFault = defineFault({
  id: 'break:capacity.set:missing-reference',
  caseId: 'capacity.set:missing-reference',
  createControl: () => createFaultControl('capacity.set:missing-reference'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      capacity: replaceMethod(source.stores.capacity, 'set', (set) => {
        return (projectId, teamId, size, stamp) =>
          control.reach('capacity.set:missing-reference')
            ? set(
                projectId === 'project-missing' ? 'project-a' : projectId,
                teamId === 'team-missing' ? 'team-a' : teamId,
                size,
                stamp,
              )
            : set(projectId, teamId, size, stamp);
      }),
    });
  },
});

const priorityDefaultsFault = defineFault({
  id: 'break:priorityBands.listFor:defaults',
  caseId: 'priorityBands.listFor:defaults',
  createControl: () => createFaultControl('priorityBands.listFor:defaults'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      priorityBands: replaceMethod(source.stores.priorityBands, 'listFor', (listFor) => {
        return async (projectId) => {
          const bands = await listFor(projectId);
          return control.reach('priorityBands.listFor:defaults') ? [] : bands;
        };
      }),
    });
  },
});

const priorityFirstRungFault = defineFault({
  id: 'break:priorityBands.replace:whole-project:priority-first-rung',
  caseId: 'priorityBands.replace:whole-project',
  createControl: () => createFaultControl('priorityBands.replace:whole-project:first-rung'),
  mutate(source: SqliteSource, control) {
    const replaceCountByProject = new Map<string, number>();
    return withStores(source, {
      priorityBands: replaceMethod(source.stores.priorityBands, 'replace', (replace) => {
        return async (projectId, bands, stamp) => {
          const replaceCount = (replaceCountByProject.get(projectId) ?? 0) + 1;
          replaceCountByProject.set(projectId, replaceCount);
          if (
            replaceCount !== 2 ||
            !control.reach('priorityBands.replace:whole-project:first-rung')
          ) {
            return replace(projectId, bands, stamp);
          }
          const replacement = bands.at(0);
          if (replacement === undefined) throw new Error('replacement ladder has no first band');
          const existing = await source.stores.priorityBands.listFor(projectId);
          return replace(projectId, [replacement, ...existing.slice(1)], stamp);
        };
      }),
    });
  },
});

const priorityProjectScopeFault = defineFault({
  id: 'break:priorityBands.replace:whole-project:priority-project-scope',
  caseId: 'priorityBands.replace:whole-project',
  createControl: () => createFaultControl('priorityBands.replace:whole-project:project-scope'),
  mutate(source: SqliteSource, control) {
    const replaceCountByProject = new Map<string, number>();
    return withStores(source, {
      priorityBands: replaceMethod(source.stores.priorityBands, 'replace', (replace) => {
        return async (projectId, bands, stamp) => {
          const replaceCount = (replaceCountByProject.get(projectId) ?? 0) + 1;
          replaceCountByProject.set(projectId, replaceCount);
          if (
            replaceCount !== 2 ||
            !control.reach('priorityBands.replace:whole-project:project-scope')
          ) {
            return replace(projectId, bands, stamp);
          }
          source.db.run(
            sql.raw(`CREATE TEMP TRIGGER conformance_priority_band_unscoped_delete
              AFTER DELETE ON project_priority_band
              WHEN OLD.project_id = '${DETERMINISTIC_SEED.projectIds[0]}'
              BEGIN
                DELETE FROM project_priority_band WHERE project_id <> OLD.project_id;
              END`),
          );
          try {
            return await replace(projectId, bands, stamp);
          } finally {
            source.db.run(sql.raw('DROP TRIGGER conformance_priority_band_unscoped_delete'));
          }
        };
      }),
    });
  },
});

const priorityMissingProjectFault = defineFault({
  id: 'break:priorityBands.replace:missing-project',
  caseId: 'priorityBands.replace:missing-project',
  createControl: () => createFaultControl('priorityBands.replace:missing-project'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      priorityBands: replaceMethod(source.stores.priorityBands, 'replace', (replace) => {
        return (projectId, bands, stamp) =>
          replace(
            control.reach('priorityBands.replace:missing-project') ? 'project-a' : projectId,
            bands,
            stamp,
          );
      }),
    });
  },
});

const createUniqueNameFault = defineFault({
  id: 'break:users.create:unique-name',
  caseId: 'users.create:unique-name',
  createControl: () => createFaultControl('users.create:unique-name'),
  mutate(source: SqliteSource, control) {
    const accounts = new Map<string, string>();
    return withStores(source, {
      users: replaceMethod(source.stores.users, 'create', (create) => async (user, stamp) => {
        const existingId = accounts.get(user.username);
        if (existingId !== undefined && control.reach('users.create:unique-name')) {
          source.db.delete(userTable).where(eq(userTable.id, existingId)).run();
        }
        const created = await create(user, stamp);
        if (created !== null) accounts.set(user.username, user.id);
        return created;
      }),
    });
  },
});

function withoutPassword(user: User | null): User | null {
  if (user === null) return null;
  const { passwordHash: _passwordHash, ...incomplete } = user;
  return incomplete as User;
}

const findIdentityFault = defineFault({
  id: 'break:users.find:identity',
  caseId: 'users.find:identity',
  createControl: () => createFaultControl('users.find:identity'),
  mutate(source: SqliteSource, control) {
    const users = replaceMethod(source.stores.users, 'findById', (findById) => async (id) => {
      const user = await findById(id);
      return control.reach('users.find:identity') ? withoutPassword(user) : user;
    });
    return withStores(source, {
      users: replaceMethod(users, 'findByUsername', (findByUsername) => async (username) => {
        const user = await findByUsername(username);
        return control.reach('users.find:identity') ? withoutPassword(user) : user;
      }),
    });
  },
});

const issuerSubjectFault = defineFault({
  id: 'break:users.resolveOidcIdentity:issuer-subject',
  caseId: 'users.resolveOidcIdentity:issuer-subject',
  createControl: () => createFaultControl('users.resolveOidcIdentity:issuer-subject'),
  mutate(source: SqliteSource, control) {
    const issuers = new Map<string, string>();
    return withStores(source, {
      users: replaceMethod(
        source.stores.users,
        'resolveOidcIdentity',
        (resolve) => (identity, create, stamp) => {
          const issuer = issuers.get(identity.subject);
          issuers.set(identity.subject, issuer ?? identity.issuer);
          return resolve(
            issuer !== undefined &&
              issuer !== identity.issuer &&
              control.reach('users.resolveOidcIdentity:issuer-subject')
              ? { ...identity, issuer }
              : identity,
            create,
            stamp,
          );
        },
      ),
    });
  },
});

const verifiedConflictFault = defineFault({
  id: 'break:users.resolveOidcIdentity:verified-conflict',
  caseId: 'users.resolveOidcIdentity:verified-conflict',
  createControl: () => createFaultControl('users.resolveOidcIdentity:verified-conflict'),
  mutate(source: SqliteSource, control) {
    const issuers = new Map<string, string>();
    return withStores(source, {
      users: replaceMethod(
        source.stores.users,
        'resolveOidcIdentity',
        (resolve) => (identity, create, stamp) => {
          const email = identity.email?.toLowerCase() ?? null;
          const issuer = email === null ? undefined : issuers.get(email);
          if (email !== null) issuers.set(email, issuer ?? identity.issuer);
          return resolve(
            issuer !== undefined &&
              issuer !== identity.issuer &&
              control.reach('users.resolveOidcIdentity:verified-conflict')
              ? { ...identity, emailVerified: false }
              : identity,
            create,
            stamp,
          );
        },
      ),
    });
  },
});

const createProjectStepsFault = defineFault({
  id: 'break:projects.create:steps',
  caseId: 'projects.create:steps',
  createControl: () => createFaultControl('projects.create:steps'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      projects: replaceMethod(
        source.stores.projects,
        'create',
        (create) => (project, steps, stamp) =>
          create(project, control.reach('projects.create:steps') ? [] : steps, stamp),
      ),
    });
  },
});

const updateProjectScopeFault = defineFault({
  id: 'break:projects.update:scope',
  caseId: 'projects.update:scope',
  createControl: () => createFaultControl('projects.update:scope'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      projects: replaceMethod(
        source.stores.projects,
        'update',
        (update) => async (id, patch, stamp) => {
          const updated = await update(id, patch, stamp);
          if (id === DETERMINISTIC_SEED.projectIds[0] && control.reach('projects.update:scope')) {
            await update(DETERMINISTIC_SEED.projectIds[1], patch, stamp);
          }
          return updated;
        },
      ),
    });
  },
});

const projectReaderOrderFault = defineFault({
  id: 'break:projects.recordOpen:reader-order',
  caseId: 'projects.recordOpen:reader-order',
  createControl: () => createFaultControl('projects.recordOpen:reader-order'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      projects: replaceMethod(
        source.stores.projects,
        'listFor',
        (listFor) => (userId) =>
          listFor(
            control.reach('projects.recordOpen:reader-order')
              ? DETERMINISTIC_SEED.ownerIds[0]
              : userId,
          ),
      ),
    });
  },
});

const markerOrderFault = defineFault({
  id: 'break:calendarMarkers.listFor:total-order',
  caseId: 'calendarMarkers.listFor:total-order',
  createControl: () => createFaultControl('calendarMarkers.listFor:total-order'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      calendarMarkers: replaceMethod(source.stores.calendarMarkers, 'listFor', (listFor) => {
        return async (projectId) => {
          if (!control.reach('calendarMarkers.listFor:total-order')) return listFor(projectId);
          return await source.db
            .select({
              id: markerTable.id,
              projectId: markerTable.projectId,
              date: markerTable.date,
              name: markerTable.name,
              color: markerTable.color,
              createdAt: markerTable.createdAt,
            })
            .from(markerTable)
            .where(eq(markerTable.projectId, projectId))
            .orderBy(asc(markerTable.date), asc(markerTable.createdAt));
        };
      }),
    });
  },
});

const markerProjectScopeFault = defineFault({
  id: 'break:calendarMarkers.write:project-scope:marker-project-scope',
  caseId: 'calendarMarkers.write:project-scope',
  createControl: () => createFaultControl('calendarMarkers.write:project-scope:project-predicate'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      calendarMarkers: replaceMethod(source.stores.calendarMarkers, 'rename', (rename) => {
        return (projectId, id, name) =>
          rename(
            id === 'marker-owned-a' &&
              projectId === DETERMINISTIC_SEED.projectIds[1] &&
              control.reach('calendarMarkers.write:project-scope:project-predicate')
              ? DETERMINISTIC_SEED.projectIds[0]
              : projectId,
            id,
            name,
          );
      }),
    });
  },
});

const markerLiteralDateFault = defineFault({
  id: 'break:calendarMarkers.write:project-scope:marker-literal-date',
  caseId: 'calendarMarkers.write:project-scope',
  createControl: () => createFaultControl('calendarMarkers.write:project-scope:literal-date'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      calendarMarkers: replaceMethod(source.stores.calendarMarkers, 'create', (create) => {
        return (marker) =>
          create(
            marker.id === 'marker-owned-a' &&
              control.reach('calendarMarkers.write:project-scope:literal-date')
              ? Object.assign(marker, { date: '2026-09-11' })
              : marker,
          );
      }),
    });
  },
});

const insertRespaceFault = defineFault({
  id: 'break:workItems.insert:respace',
  caseId: 'workItems.insert:respace',
  createControl: () => createFaultControl('workItems.insert:respace'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      workItems: replaceMethod(source.stores.workItems, 'insert', (insert) => {
        return (row, respaced, stamp) =>
          insert(
            row,
            row.id === 'work-a-inserted' && control.reach('workItems.insert:respace')
              ? []
              : respaced,
            stamp,
          );
      }),
    });
  },
});

const patchRefusalAtomicFault = defineFault({
  id: 'break:workItems.patch:refusal-atomic',
  caseId: 'workItems.patch:refusal-atomic',
  createControl: () => createFaultControl('workItems.patch:refusal-atomic'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      workItems: replaceMethod(source.stores.workItems, 'patch', (patch) => {
        return async (id, changes, stamp) => {
          if (changes.name === 'Escaped rename' && changes.teamIds?.includes('team-missing')) {
            const scalar = await patch(id, { name: changes.name }, stamp);
            if (!scalar.ok) throw new Error('partial-write setup scalar patch was refused');
            const written = await source.stores.workItems.findById(id);
            if (written?.name !== changes.name) {
              throw new Error('partial-write setup scalar patch was not observable');
            }
            control.reach('workItems.patch:refusal-atomic');
          }
          return patch(id, changes, stamp);
        };
      }),
    });
  },
});

const removePromotionFault = defineFault({
  id: 'break:workItems.remove:promotion',
  caseId: 'workItems.remove:promotion',
  createControl: () => createFaultControl('workItems.remove:promotion'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      workItems: replaceMethod(source.stores.workItems, 'remove', (remove) => {
        return (ids, promoted, stamp) =>
          remove(
            ids,
            control.reach('workItems.remove:promotion')
              ? promoted.filter(({ id }) => id !== 'work-a-child-two')
              : promoted,
            stamp,
          );
      }),
    });
  },
});

const frozenAcquireFault = defineFault({
  id: 'break:workItems.setFrozenNumbers:clear:frozen-acquire',
  caseId: 'workItems.setFrozenNumbers:clear',
  createControl: () => createFaultControl('workItems.setFrozenNumbers:clear:first-freeze'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      workItems: replaceMethod(
        source.stores.workItems,
        'setFrozenNumbers',
        (setFrozenNumbers) => (updates, stamp) => {
          const firstId = DETERMINISTIC_SEED.workItemIds[0][0];
          const preventsFirstFreeze = updates.some(
            ({ id, frozenNumber }) => id === firstId && frozenNumber === '010',
          );
          if (!preventsFirstFreeze) return setFrozenNumbers(updates, stamp);
          control.reach('workItems.setFrozenNumbers:clear:first-freeze');
          // Proof: retaining `010` here restored the focused fault to
          // assertion-passed; null reaches the real source and its bookkeeping.
          return setFrozenNumbers(
            updates.map((update) =>
              update.id === firstId ? { ...update, frozenNumber: null } : update,
            ),
            stamp,
          );
        },
      ),
    });
  },
});

const frozenClearFault = defineFault({
  id: 'break:workItems.setFrozenNumbers:clear:frozen-clear',
  caseId: 'workItems.setFrozenNumbers:clear',
  createControl: () => createFaultControl('workItems.setFrozenNumbers:clear'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      workItems: replaceMethod(
        source.stores.workItems,
        'setFrozenNumbers',
        (setFrozenNumbers) => (updates, stamp) => {
          const isClear = updates.some(({ frozenNumber }) => frozenNumber === null);
          return setFrozenNumbers(
            isClear && control.reach('workItems.setFrozenNumbers:clear')
              ? [...updates, { id: DETERMINISTIC_SEED.workItemIds[0][1], frozenNumber: null }]
              : updates,
            stamp,
          );
        },
      ),
    });
  },
});

const estimateMoveOwnershipFault = defineFault({
  id: 'break:estimates.moveAll:ownership',
  caseId: 'estimates.moveAll:ownership',
  createControl: () => createFaultControl('estimates.moveAll:ownership'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      estimates: replaceMethod(source.stores.estimates, 'moveAll', (moveAll) => {
        return async (fromWorkItemId, toWorkItemId, stamp) => {
          if (!control.reach('estimates.moveAll:ownership')) {
            return moveAll(fromWorkItemId, toWorkItemId, stamp);
          }
          const estimates = await source.stores.estimates.listByProject(
            DETERMINISTIC_SEED.projectIds[0],
          );
          for (const estimate of estimates.filter(
            ({ workItemId }) => workItemId === fromWorkItemId,
          )) {
            await source.stores.estimates.set({ ...estimate, workItemId: toWorkItemId }, stamp);
          }
        };
      }),
    });
  },
});

const actualReplaceRecordedAtFault = defineFault({
  id: 'break:actuals.set:replace',
  caseId: 'actuals.set:replace',
  createControl: () => createFaultControl('actuals.set:replace'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      actuals: replaceMethod(source.stores.actuals, 'set', (set) => {
        return (actual, stamp) =>
          set(
            actual.recordedAt === 201 && control.reach('actuals.set:replace')
              ? { ...actual, recordedAt: 101 }
              : actual,
            stamp,
          );
      }),
    });
  },
});

const actualRemovePairFault = defineFault({
  id: 'break:actuals.remove:pair:actual-remove-pair',
  caseId: 'actuals.remove:pair',
  createControl: () => createFaultControl('actuals.remove:pair'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      actuals: replaceMethod(source.stores.actuals, 'remove', (remove) => {
        return async (workItemId, stepId, stamp) => {
          await remove(workItemId, stepId, stamp);
          if (control.reach('actuals.remove:pair')) {
            await remove(DETERMINISTIC_SEED.workItemIds[0][1], stepId, stamp);
          }
        };
      }),
    });
  },
});

const actualRemoveFirstCallFault = defineFault({
  id: 'break:actuals.remove:pair:actual-remove-first-call',
  caseId: 'actuals.remove:pair',
  createControl: () => createFaultControl('actuals.remove:pair:first-settlement'),
  mutate(source: SqliteSource, control) {
    let removeCount = 0;
    return withStores(source, {
      actuals: replaceMethod(source.stores.actuals, 'remove', (remove) => {
        return (workItemId, stepId, stamp) => {
          removeCount += 1;
          if (removeCount === 1 && control.reach('actuals.remove:pair:first-settlement')) {
            return Promise.resolve();
          }
          return remove(workItemId, stepId, stamp);
        };
      }),
    });
  },
});

const actualMoveOwnershipFault = defineFault({
  id: 'break:actuals.moveAll:ownership',
  caseId: 'actuals.moveAll:ownership',
  createControl: () => createFaultControl('actuals.moveAll:ownership'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      actuals: replaceMethod(source.stores.actuals, 'moveAll', (moveAll) => {
        return async (fromWorkItemId, toWorkItemId, stamp) => {
          if (!control.reach('actuals.moveAll:ownership')) {
            return moveAll(fromWorkItemId, toWorkItemId, stamp);
          }
          const actuals = await source.stores.actuals.listByProject(
            DETERMINISTIC_SEED.projectIds[0],
          );
          for (const actual of actuals.filter(({ workItemId }) => workItemId === fromWorkItemId)) {
            await source.stores.actuals.set({ ...actual, workItemId: toWorkItemId }, stamp);
          }
        };
      }),
    });
  },
});

const actualUnknownStepFault = defineFault({
  id: 'break:actuals.set:unknown_step',
  caseId: 'actuals.set:unknown_step',
  createControl: () => createFaultControl('actuals.set:unknown_step'),
  mutate(source: SqliteSource, control) {
    const acceptingActuals = replaceMethod(source.stores.actuals, 'set', (set) => {
      return (actual, stamp) => {
        if (actual.stepId !== 'no-such-step' || !control.reach('actuals.set:unknown_step')) {
          return set(actual, stamp);
        }
        source.db.run(sql.raw('PRAGMA foreign_keys = OFF'));
        try {
          source.db.insert(actualTable).values(actual).run();
        } finally {
          source.db.run(sql.raw('PRAGMA foreign_keys = ON'));
        }
        return Promise.resolve('written');
      };
    });
    return withStores(source, {
      actuals: replaceMethod(acceptingActuals, 'listByProject', (listByProject) => {
        return async (projectId) => {
          const rows = await listByProject(projectId);
          if (projectId !== DETERMINISTIC_SEED.projectIds[0]) return rows;
          const escaped = await source.db
            .select({
              workItemId: actualTable.workItemId,
              stepId: actualTable.stepId,
              days: actualTable.days,
              recordedAt: actualTable.recordedAt,
            })
            .from(actualTable)
            .where(eq(actualTable.stepId, 'no-such-step'));
          return [...escaped, ...rows];
        };
      }),
    });
  },
});

const measureSetPairIdentityFault = defineFault({
  id: 'break:measures.set:metric-key:measure-set-pair-identity',
  caseId: 'measures.set:metric-key',
  createControl: () => createFaultControl('measures.set:metric-key'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'set', (set) => {
        return async (measure, stamp) => {
          if (measure.value === 21 && control.reach('measures.set:metric-key')) {
            await source.stores.measures.remove(
              measure.workItemId,
              measure.stepId,
              'hours_actual',
              stamp,
            );
            await source.stores.measures.remove(
              measure.workItemId,
              measure.stepId,
              'token_estimate',
              stamp,
            );
          }
          return set(measure, stamp);
        };
      }),
    });
  },
});

const measureSetRecordedAtFault = defineFault({
  id: 'break:measures.set:metric-key:measure-set-recorded-at',
  caseId: 'measures.set:metric-key',
  createControl: () => createFaultControl('measures.set:metric-key:recorded-at'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'set', (set) => {
        return (measure, stamp) =>
          set(
            measure.value === 21 && control.reach('measures.set:metric-key:recorded-at')
              ? { ...measure, recordedAt: 102 }
              : measure,
            stamp,
          );
      }),
    });
  },
});

const measureRemovePairIdentityFault = defineFault({
  id: 'break:measures.remove:metric-key',
  caseId: 'measures.remove:metric-key',
  createControl: () => createFaultControl('measures.remove:metric-key'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'remove', (remove) => {
        return async (workItemId, stepId, metric, stamp) => {
          await remove(workItemId, stepId, metric, stamp);
          if (!control.reach('measures.remove:metric-key')) return;
          await remove(workItemId, stepId, 'hours_actual', stamp);
          await remove(workItemId, stepId, 'token_estimate', stamp);
        };
      }),
    });
  },
});

const measureMoveOneMetricFault = defineFault({
  id: 'break:measures.moveAll:all-metrics:measure-move-one-metric',
  caseId: 'measures.moveAll:all-metrics',
  createControl: () => createFaultControl('measures.moveAll:all-metrics'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'moveAll', (moveAll) => {
        return async (fromWorkItemId, toWorkItemId, stamp) => {
          if (!control.reach('measures.moveAll:all-metrics')) {
            return moveAll(fromWorkItemId, toWorkItemId, stamp);
          }
          const measures = await source.stores.measures.listByProject(
            DETERMINISTIC_SEED.projectIds[0],
          );
          for (const measure of measures.filter(
            ({ workItemId, metric }) =>
              workItemId === fromWorkItemId && metric === 'token_estimate',
          )) {
            await source.stores.measures.set({ ...measure, workItemId: toWorkItemId }, stamp);
            await source.stores.measures.remove(
              fromWorkItemId,
              measure.stepId,
              measure.metric,
              stamp,
            );
          }
        };
      }),
    });
  },
});

const measureMoveRecordedAtFault = defineFault({
  id: 'break:measures.moveAll:all-metrics:measure-move-recorded-at',
  caseId: 'measures.moveAll:all-metrics',
  createControl: () => createFaultControl('measures.moveAll:all-metrics:recorded-at'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'moveAll', (moveAll) => {
        return async (fromWorkItemId, toWorkItemId, stamp) => {
          await moveAll(fromWorkItemId, toWorkItemId, stamp);
          if (!control.reach('measures.moveAll:all-metrics:recorded-at')) return;
          await source.stores.measures.set(
            {
              workItemId: toWorkItemId,
              stepId: DETERMINISTIC_SEED.stepIds[0][0],
              metric: 'token_actual',
              value: 11,
              recordedAt: 999,
            },
            stamp,
          );
        };
      }),
    });
  },
});

const measureUnknownStepFault = defineFault({
  id: 'break:measures.set:unknown_step',
  caseId: 'measures.set:unknown_step',
  createControl: () => createFaultControl('measures.set:unknown_step'),
  mutate(source: SqliteSource, control) {
    const acceptingMeasures = replaceMethod(source.stores.measures, 'set', (set) => {
      return (measure, stamp) => {
        if (measure.stepId !== 'no-such-step' || !control.reach('measures.set:unknown_step')) {
          return set(measure, stamp);
        }
        source.db.run(sql.raw('PRAGMA foreign_keys = OFF'));
        try {
          source.db.insert(measureTable).values(measure).run();
        } finally {
          source.db.run(sql.raw('PRAGMA foreign_keys = ON'));
        }
        return Promise.resolve('written');
      };
    });
    return withStores(source, {
      measures: replaceMethod(acceptingMeasures, 'listByProject', (listByProject) => {
        return async (projectId) => {
          const rows = await listByProject(projectId);
          if (projectId !== DETERMINISTIC_SEED.projectIds[0]) return rows;
          const escaped = await source.db
            .select({
              workItemId: measureTable.workItemId,
              stepId: measureTable.stepId,
              metric: measureTable.metric,
              value: measureTable.value,
              recordedAt: measureTable.recordedAt,
            })
            .from(measureTable)
            .where(eq(measureTable.stepId, 'no-such-step'));
          return [...escaped, ...rows];
        };
      }),
    });
  },
});

const progressReplaceFault = defineFault({
  id: 'break:progress.set:replace',
  caseId: 'progress.set:replace',
  createControl: () => createFaultControl('progress.set:replace'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      progress: replaceMethod(source.stores.progress, 'set', (set) => {
        return (progress, stamp) =>
          set(
            progress.statedAt === 201 && control.reach('progress.set:replace')
              ? { ...progress, state: 'in_progress', statedAt: 101 }
              : progress,
            stamp,
          );
      }),
    });
  },
});

const progressNotStartedSurrogateFault = defineFault({
  id: 'break:progress.remove:absence',
  caseId: 'progress.remove:absence',
  createControl: () => createFaultControl('progress.remove:absence'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      progress: replaceMethod(source.stores.progress, 'remove', (remove) => {
        return async (workItemId, stepId, stamp) => {
          await remove(workItemId, stepId, stamp);
          if (!control.reach('progress.remove:absence')) return;
          // This isolated test database crosses SQLite's CHECK boundary to store
          // the forbidden `not_started` row; `finally` restores enforcement.
          source.db.run(sql.raw('PRAGMA ignore_check_constraints = ON'));
          try {
            source.db.run(
              sql`INSERT INTO step_progress
                    (work_item_id, step_id, state, stated_at, created_at, created_by, updated_at)
                  VALUES (${workItemId}, ${stepId}, 'not_started', 201, ${stamp.at}, ${stamp.by}, ${stamp.at})`,
            );
          } finally {
            source.db.run(sql.raw('PRAGMA ignore_check_constraints = OFF'));
          }
        };
      }),
    });
  },
});

const progressMoveOwnershipFault = defineFault({
  id: 'break:progress.moveAll:ownership',
  caseId: 'progress.moveAll:ownership',
  createControl: () => createFaultControl('progress.moveAll:ownership'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      progress: replaceMethod(source.stores.progress, 'moveAll', (moveAll) => {
        return async (fromWorkItemId, toWorkItemId, stamp) => {
          if (!control.reach('progress.moveAll:ownership')) {
            return moveAll(fromWorkItemId, toWorkItemId, stamp);
          }
          const rows = await source.stores.progress.listByProject(DETERMINISTIC_SEED.projectIds[0]);
          for (const progress of rows.filter(({ workItemId }) => workItemId === fromWorkItemId)) {
            await source.stores.progress.set({ ...progress, workItemId: toWorkItemId }, stamp);
          }
        };
      }),
    });
  },
});

const progressUnknownStepFault = defineFault({
  id: 'break:progress.set:unknown_step',
  caseId: 'progress.set:unknown_step',
  createControl: () => createFaultControl('progress.set:unknown_step'),
  mutate(source: SqliteSource, control) {
    const acceptingProgress = replaceMethod(source.stores.progress, 'set', (set) => {
      return (progress, stamp) => {
        if (progress.stepId !== 'no-such-step' || !control.reach('progress.set:unknown_step')) {
          return set(progress, stamp);
        }
        // This isolated test database crosses SQLite's FK boundary to store the
        // forbidden missing-step row; `finally` restores enforcement.
        source.db.run(sql.raw('PRAGMA foreign_keys = OFF'));
        try {
          source.db.insert(progressTable).values(progress).run();
        } finally {
          source.db.run(sql.raw('PRAGMA foreign_keys = ON'));
        }
        return Promise.resolve('written');
      };
    });
    return withStores(source, {
      progress: replaceMethod(acceptingProgress, 'listByProject', (listByProject) => {
        return async (projectId) => {
          const rows = await listByProject(projectId);
          if (projectId !== DETERMINISTIC_SEED.projectIds[0]) return rows;
          // The public reader's inner step join hides the stored orphan, so this
          // proof reads `step_progress` directly rather than fabricating a row.
          const escaped = await source.db
            .select({
              workItemId: progressTable.workItemId,
              stepId: progressTable.stepId,
              state: progressTable.state,
              statedAt: progressTable.statedAt,
            })
            .from(progressTable)
            .where(eq(progressTable.stepId, 'no-such-step'));
          return [...escaped, ...rows];
        };
      }),
    });
  },
});

const dependencyIdFault = defineFault({
  id: 'break:dependencies.add:idempotent-pair:dependency-id',
  caseId: 'dependencies.add:idempotent-pair',
  createControl: () => createFaultControl('dependencies.add:idempotent-pair:edge-id'),
  mutate(source: SqliteSource, control) {
    let setupAdds = 0;
    let usesIdUniqueness = false;
    return withStores(source, {
      dependencies: replaceMethod(source.stores.dependencies, 'add', (add) => {
        return async (dependency, stamp) => {
          if (dependency.id !== 'dependency-idempotent-second-id') {
            setupAdds += 1;
            if (control.reached()) throw new Error('dependency ID fault reached during setup');
            return add(dependency, stamp);
          }
          if (setupAdds !== 3)
            throw new Error(`dependency ID fault saw ${String(setupAdds)} setup adds`);
          control.reach('dependencies.add:idempotent-pair:edge-id');
          if (!usesIdUniqueness) {
            source.db.run(sql`DROP INDEX dependency_pair`);
            usesIdUniqueness = true;
          }
          await add(dependency, stamp);
          const storedPair = (await source.stores.dependencies.listByProject(dependency.projectId))
            .filter(
              (edge) =>
                edge.predecessorId === dependency.predecessorId &&
                edge.successorId === dependency.successorId,
            )
            .toSorted((left, right) => left.id.localeCompare(right.id));
          // Proof: disabling the isolated index removal left only the complete
          // original edge here; the focused proof then rejected the missing
          // second-ID record before it could claim the shared extra-edge diff.
          expect(storedPair).toEqual([
            { ...dependency, id: 'dependency-idempotent-original' },
            dependency,
          ]);
        };
      }),
    });
  },
});

const dependencyInputMutationFault = defineFault({
  id: 'break:dependencies.add:idempotent-pair:dependency-input-mutation',
  caseId: 'dependencies.add:idempotent-pair',
  createControl: () => createFaultControl('dependencies.add:idempotent-pair:input-id'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      dependencies: replaceMethod(source.stores.dependencies, 'add', (add) => {
        return (dependency, stamp) => {
          if (dependency.id === 'dependency-idempotent-original') {
            control.reach('dependencies.add:idempotent-pair:input-id');
            dependency.id = 'dependency-idempotent-mutated';
          }
          return add(dependency, stamp);
        };
      }),
    });
  },
});

const directoryAssignmentsOfSubsetFault = defineFault({
  id: 'break:directory.assign:scope-replace-clear:directory-assignments-of-subset',
  caseId: 'directory.assign:scope-replace-clear',
  createControl: () => createFaultControl('directory.assign:scope-replace-clear:subset'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      directory: replaceMethod(source.stores.directory, 'assignmentsOf', (assignmentsOf) => {
        return (workItemIds) => {
          const requested = DETERMINISTIC_SEED.workItemIds[0];
          if (
            workItemIds.length !== requested.length ||
            !requested.every((id, index) => workItemIds[index] === id)
          ) {
            return assignmentsOf(workItemIds);
          }
          control.reach('directory.assign:scope-replace-clear:subset');
          // Proof: forwarding only workItemIds made this focused fault
          // assertion-passed; this real reader call ignores the strict subset.
          return assignmentsOf([...workItemIds, DETERMINISTIC_SEED.workItemIds[1][0]]);
        };
      }),
    });
  },
});

const directoryAssignmentScopeFault = defineFault({
  id: 'break:directory.assign:scope-replace-clear:directory-assignment-scope',
  caseId: 'directory.assign:scope-replace-clear',
  createControl: () => createFaultControl('directory.assign:scope-replace-clear:pair-scope'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      directory: replaceMethod(source.stores.directory, 'assign', (assign) => {
        return async (workItemId, stepId, personId, stamp) => {
          if (
            workItemId !== DETERMINISTIC_SEED.workItemIds[0][0] ||
            stepId !== DETERMINISTIC_SEED.stepIds[0][0] ||
            personId !== DETERMINISTIC_SEED.personIds[1]
          ) {
            return assign(workItemId, stepId, personId, stamp);
          }
          control.reach('directory.assign:scope-replace-clear:pair-scope');
          // Proof: omitting this real collateral clear changed the fault result
          // from observed to assertion-passed in the focused proof.
          await source.stores.directory.assign(
            DETERMINISTIC_SEED.workItemIds[0][1],
            stepId,
            null,
            stamp,
          );
          return assign(workItemId, stepId, personId, stamp);
        };
      }),
    });
  },
});

const directoryTeamAtomicityFault = defineFault({
  id: 'break:directory.patchTeam:atomic-refusal',
  caseId: 'directory.patchTeam:atomic-refusal',
  createControl: () => createFaultControl('directory.patchTeam:atomic-refusal:early-rename'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      directory: replaceMethod(source.stores.directory, 'patchTeam', (patchTeam) => {
        return async (teamId, patch, stamp) => {
          if (
            teamId !== DETERMINISTIC_SEED.teamIds[0] ||
            patch.name !== 'Directory escaped' ||
            patch.serviceIds?.[0] !== 'directory-unknown-service'
          ) {
            return patchTeam(teamId, patch, stamp);
          }
          expect(await patchTeam(teamId, { name: patch.name }, stamp)).toEqual({
            ok: true,
            team: {
              id: teamId,
              name: 'Directory escaped',
              serviceIds: [DETERMINISTIC_SEED.serviceIds[0]],
            },
            projectIds: [],
          });
          // Proof: omitting this real early rename made this public snapshot
          // receive Directory original where Directory escaped was expected.
          expect(
            (await source.stores.directory.listTeams())
              .map((team) => ({ ...team, serviceIds: team.serviceIds.toSorted() }))
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ).toEqual([
            {
              id: DETERMINISTIC_SEED.teamIds[0],
              name: 'Directory escaped',
              serviceIds: [DETERMINISTIC_SEED.serviceIds[0]],
            },
            {
              id: DETERMINISTIC_SEED.teamIds[1],
              name: 'Team 2',
              serviceIds: ['directory-service-sentinel'],
            },
          ]);
          control.reach('directory.patchTeam:atomic-refusal:early-rename');
          return patchTeam(teamId, patch, stamp);
        };
      }),
    });
  },
});

const dependencyPairPredicateFault = defineFault({
  id: 'break:dependencies.remove:pair',
  caseId: 'dependencies.remove:pair',
  createControl: () => createFaultControl('dependencies.remove:pair:successor-predicate'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      dependencies: replaceMethod(source.stores.dependencies, 'remove', (remove) => {
        return async (predecessorId, successorId, stamp) => {
          if (!control.reach('dependencies.remove:pair:successor-predicate')) {
            return remove(predecessorId, successorId, stamp);
          }
          const edges = (
            await Promise.all(
              DETERMINISTIC_SEED.projectIds.map((projectId) =>
                source.stores.dependencies.listByProject(projectId),
              ),
            )
          ).flat();
          for (const edge of edges.filter((edge) => edge.predecessorId === predecessorId)) {
            await remove(edge.predecessorId, edge.successorId, stamp);
          }
        };
      }),
    });
  },
});

const dependencyOutgoingOnlyFault = defineFault({
  id: 'break:dependencies.removeAllFor:touching-set:dependency-outgoing-only',
  caseId: 'dependencies.removeAllFor:touching-set',
  createControl: () => createFaultControl('dependencies.removeAllFor:touching-set:outgoing-only'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      dependencies: replaceMethod(source.stores.dependencies, 'removeAllFor', (removeAllFor) => {
        return async (workItemIds, stamp) => {
          if (!control.reach('dependencies.removeAllFor:touching-set:outgoing-only')) {
            return removeAllFor(workItemIds, stamp);
          }
          const doomed = new Set(workItemIds);
          const edges = await source.stores.dependencies.listByProject(
            DETERMINISTIC_SEED.projectIds[0],
          );
          for (const edge of edges.filter((edge) => doomed.has(edge.predecessorId))) {
            await source.stores.dependencies.remove(edge.predecessorId, edge.successorId, stamp);
          }
        };
      }),
    });
  },
});

const dependencyIncompleteSetFault = defineFault({
  id: 'break:dependencies.removeAllFor:touching-set:dependency-incomplete-set',
  caseId: 'dependencies.removeAllFor:touching-set',
  createControl: () => createFaultControl('dependencies.removeAllFor:touching-set:first-only'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      dependencies: replaceMethod(source.stores.dependencies, 'removeAllFor', (removeAllFor) => {
        return (workItemIds, stamp) =>
          removeAllFor(
            control.reach('dependencies.removeAllFor:touching-set:first-only')
              ? workItemIds.slice(0, 1)
              : workItemIds,
            stamp,
          );
      }),
    });
  },
});

const eventRetainedMaximumFault = defineFault({
  id: 'break:eventLog.pruneBeyond:empty-sequence',
  caseId: 'eventLog.pruneBeyond:empty-sequence',
  createControl: () => createFaultControl('eventLog.pruneBeyond:empty-sequence:next-record'),
  mutate(source: SqliteSource, control) {
    let didPruneToEmpty = false;
    const eventLog = replaceMethod(source.stores.eventLog, 'pruneBeyond', (pruneBeyond) => {
      return async (maximum) => {
        const removed = await pruneBeyond(maximum);
        if (control.isArmed() && maximum === 0) didPruneToEmpty = true;
        return removed;
      };
    });
    return withStores(source, {
      eventLog: replaceMethod(eventLog, 'recordEvent', (recordEvent) => {
        return async (subscription, message, createdAt) => {
          if (!didPruneToEmpty) return recordEvent(subscription, message, createdAt);
          const retained = await source.stores.eventLog.rangeSince(subscription, -1);
          const retainedMaximum = retained.at(-1)?.seq ?? -1;
          source.db
            .update(eventSequencer)
            .set({ nextSeq: retainedMaximum + 1 })
            .where(eq(eventSequencer.subscription, subscription))
            .run();
          const recorded = await recordEvent(subscription, message, createdAt);
          control.reach('eventLog.pruneBeyond:empty-sequence:next-record');
          const persisted = await source.stores.eventLog.rangeSince(subscription, -1);
          const latest = await source.stores.eventLog.latestSeq(subscription);
          if (
            persisted.length !== 1 ||
            persisted[0]?.seq !== recorded.seq ||
            latest !== recorded.seq
          ) {
            throw new Error('retained-MAX fault did not persist its returned sequence');
          }
          return recorded;
        };
      }),
    });
  },
});

const addFault = defineFault({
  id: 'break:steps.add:stored-value',
  caseId: 'steps.add',
  createControl: () => createFaultControl('steps.add'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      steps: replaceMethod(
        source.stores.steps,
        'add',
        (add) => async (step, stamp) =>
          add(control.reach('steps.add') ? { ...step, name: 'faulted add' } : step, stamp),
      ),
    });
  },
});

function createSeedFailureFault(observeReach: (reached: boolean) => void) {
  return defineFault({
    id: 'break:steps.add:seed-failure',
    caseId: 'steps.add',
    createControl: () => createFaultControl('steps.add'),
    mutate(source: SqliteSource, control) {
      const decorated = addFault.mutate(source, control);
      return withStores(decorated, {
        projects: replaceMethod(
          decorated.stores.projects,
          'create',
          (create) => async (project, steps, stamp) => {
            await create(project, steps, stamp);
            await decorated.stores.steps.add(
              { id: 'probe-step', projectId: project.id, name: 'Setup step' },
              stamp,
            );
            observeReach(control.reached());
            throw new Error('injected seed failure after actual steps.add');
          },
        ),
      });
    },
  });
}

const cleanupFailureFault = defineFault({
  id: 'break:steps.add:cleanup-failure',
  caseId: 'steps.add',
  createControl: () => createFaultControl('steps.add'),
  mutate(source: SqliteSource, control) {
    const decorated = addFault.mutate(source, control);
    return {
      ...decorated,
      async close() {
        await decorated.close();
        throw new Error('injected cleanup failure after actual steps.add');
      },
    };
  },
});

const seedFailureFault = createSeedFailureFault(() => undefined);

const renameFault = defineFault({
  id: 'break:steps.rename',
  caseId: 'steps.rename',
  createControl: () => createFaultControl('steps.rename'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      steps: replaceMethod(
        source.stores.steps,
        'rename',
        (rename) => (stepId, name, stamp) =>
          rename(stepId, control.reach('steps.rename') ? 'faulted rename' : name, stamp),
      ),
    });
  },
});

const estimateFault = defineFault({
  id: 'break:estimates.set',
  caseId: 'estimates.set',
  createControl: () => createFaultControl('estimates.set'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      estimates: replaceMethod(
        source.stores.estimates,
        'set',
        (set) => (estimate, stamp) =>
          set(
            control.reach('estimates.set')
              ? { ...estimate, realistic: estimate.realistic + 1 }
              : estimate,
            stamp,
          ),
      ),
    });
  },
});

const removeFault = defineFault({
  id: 'break:estimates.remove',
  caseId: 'estimates.remove',
  createControl: () => createFaultControl('estimates.remove'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      estimates: replaceMethod(
        source.stores.estimates,
        'remove',
        (remove) => (workItemId, stepId, stamp) =>
          control.reach('estimates.remove') ? Promise.resolve() : remove(workItemId, stepId, stamp),
      ),
    });
  },
});

const rangeFault = defineFault({
  id: 'break:eventLog.rangeSince',
  caseId: 'eventLog.rangeSince',
  createControl: () => createFaultControl('eventLog.rangeSince'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      eventLog: replaceMethod(
        source.stores.eventLog,
        'rangeSince',
        (rangeSince) => (subscription, sinceSeq) =>
          control.reach('eventLog.rangeSince')
            ? Promise.resolve([])
            : rangeSince(subscription, sinceSeq),
      ),
    });
  },
});

const pruneFault = defineFault({
  id: 'break:eventLog.pruneBeyond',
  caseId: 'eventLog.pruneBeyond',
  createControl: () => createFaultControl('eventLog.pruneBeyond'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      eventLog: replaceMethod(
        source.stores.eventLog,
        'pruneBeyond',
        (pruneBeyond) => (maximum) =>
          control.reach('eventLog.pruneBeyond') ? Promise.resolve(0) : pruneBeyond(maximum),
      ),
    });
  },
});

function task52JournalEntry(
  id: 'flip-target' | 'flip-peer' | 'flip-other-project',
  undone: boolean,
  expectedRevision?: number,
  fromRevision?: number,
): JournalEntry {
  const isTarget = id === 'flip-target';
  const isPeer = id === 'flip-peer';
  const createdAt = isTarget ? 101 : isPeer ? 102 : 103;
  const projectId = id === 'flip-other-project' ? 'project-b' : 'project-a';
  const userId = id === 'flip-other-project' ? 'owner-b' : 'owner-a';
  const revisionKey = isTarget ? 'work-a-one' : isPeer ? 'work-a-two' : id;
  return {
    id,
    projectId,
    userId,
    seq: isPeer ? 2 : 1,
    kind: 'rename',
    payload: { label: `Rename ${id}`, forward: { type: 'rename', name: `After ${id}` } },
    inverse: { type: 'rename', name: `Before ${id}` },
    preconditions: {
      expected: { [revisionKey]: expectedRevision ?? createdAt },
      from: { [revisionKey]: fromRevision ?? createdAt - 1 },
    },
    undone,
    createdAt,
  };
}

function task52FlipHistory(): [PlanEvent[], PlanEvent[]] {
  const expectedEvent = (
    id: 'flip-target' | 'flip-peer' | 'flip-other-project',
    createdAt: number,
  ): PlanEvent => ({
    id: `event-${id}`,
    projectId: id === 'flip-other-project' ? 'project-b' : 'project-a',
    userId: id === 'flip-other-project' ? 'owner-b' : 'owner-a',
    kind: 'rename',
    label: `Rename ${id}`,
    workItemId: `${id}-work`,
    stepId: null,
    before: { type: 'rename', name: `Before ${id}` },
    after: { type: 'rename', name: `After ${id}` },
    createdAt,
  });
  return [
    [expectedEvent('flip-peer', 102), expectedEvent('flip-target', 101)],
    [expectedEvent('flip-other-project', 103)],
  ];
}

async function readTask52FlipState(source: SqliteSource) {
  return {
    entries: await Promise.all([
      source.stores.journal.entriesFor('project-a', 'owner-a'),
      source.stores.journal.entriesFor('project-b', 'owner-b'),
    ]),
    states: await Promise.all([
      source.stores.journal.stateOf('project-a', 'owner-a'),
      source.stores.journal.stateOf('project-b', 'owner-b'),
    ]),
    history: await Promise.all([
      source.stores.planEvents.listFor('project-a', {}),
      source.stores.planEvents.listFor('project-b', {}),
    ]),
  };
}

const journalRetainedPreconditionsFault = defineFault({
  id: 'break:journal.flip:preconditions:journal-retained-preconditions',
  caseId: 'journal.flip:preconditions',
  createControl: () => createFaultControl('journal.flip:preconditions:retain-old'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'flip', (flip) => {
        return async (id, undone, preconditions) => {
          if (!control.isArmed() || id !== 'flip-target') return flip(id, undone, preconditions);
          // Proof: forwarding the supplied preconditions changed all four focused
          // SQLite fault outcomes from `observed` to `assertion-passed`.
          await flip(
            id,
            undone,
            structuredClone({ expected: { 'work-a-one': 11 }, from: { 'work-a-one': 10 } }),
          );
          expect(await readTask52FlipState(source)).toEqual({
            entries: [
              [
                task52JournalEntry('flip-target', true, 11, 10),
                task52JournalEntry('flip-peer', false, 12, 11),
              ],
              [task52JournalEntry('flip-other-project', false)],
            ],
            states: [
              { undoable: true, redoable: true },
              { undoable: true, redoable: false },
            ],
            history: task52FlipHistory(),
          });
          control.reach('journal.flip:preconditions:retain-old');
        };
      }),
    });
  },
});

const journalRestampFlipsFault = defineFault({
  id: 'break:journal.flip:preconditions:journal-restamp-flips',
  caseId: 'journal.flip:preconditions',
  createControl: () => createFaultControl('journal.flip:preconditions:restamp-flips'),
  mutate(source: SqliteSource, control) {
    const flip = source.stores.journal.flip.bind(source.stores.journal);
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'restamp', (restamp) => {
        return async (id, preconditions) => {
          if (!control.isArmed() || id !== 'flip-target') return restamp(id, preconditions);
          // Proof: delegating to restamp preserved `undone: true` and changed the
          // four-fault reversal to four `assertion-passed` outcomes.
          await flip(id, false, structuredClone(preconditions));
          // Proof: removing this complete-effect guard changed the no-op
          // restamp negative from `phase-failed` to `observed`.
          expect(await readTask52FlipState(source)).toEqual({
            entries: [
              [
                task52JournalEntry('flip-target', false, 31, 11),
                task52JournalEntry('flip-peer', false, 12, 11),
              ],
              [task52JournalEntry('flip-other-project', false)],
            ],
            states: [
              { undoable: true, redoable: false },
              { undoable: true, redoable: false },
            ],
            history: task52FlipHistory(),
          });
          control.reach('journal.flip:preconditions:restamp-flips');
        };
      }),
    });
  },
});

function task52PlanEvent(
  id: string,
  projectId: 'project-a' | 'project-b',
  userId: 'owner-a' | 'owner-b',
  workItemId: string | null,
  kind: string,
  createdAt: number,
): PlanEvent {
  const prefix = projectId === 'project-a' ? 'a' : 'b';
  return {
    id: `history-${prefix}-${id}`,
    projectId,
    userId,
    kind,
    label: `History history-${prefix}-${id}`,
    workItemId,
    stepId: null,
    before: { type: `undo_${kind}`, workItemId },
    after: { type: kind, workItemId },
    createdAt,
  };
}

function task52PlanEvents(): [PlanEvent[], PlanEvent[]] {
  return [
    [
      task52PlanEvent('101-wide', 'project-a', 'owner-a', null, 'freeze', 101),
      task52PlanEvent('100-z', 'project-a', 'owner-a', 'work-a-one', 'clear_estimate', 100),
      task52PlanEvent('100-m', 'project-a', 'owner-a', 'work-a-one', 'actual', 100),
      task52PlanEvent('100-a', 'project-a', 'owner-a', 'work-a-two', 'rename', 100),
      task52PlanEvent('99', 'project-a', 'owner-a', 'work-a-one', 'estimate', 99),
    ],
    [
      task52PlanEvent('101-wide', 'project-b', 'owner-b', null, 'freeze', 101),
      task52PlanEvent('100', 'project-b', 'owner-b', 'work-b-two', 'rename', 100),
      task52PlanEvent('99', 'project-b', 'owner-b', 'work-b-one', 'actual', 99),
    ],
  ];
}

function task52HistoryEntry(
  id: string,
  projectId: 'project-a' | 'project-b',
  userId: 'owner-a' | 'owner-b',
  seq: number,
  workItemId: string | null,
  kind: string,
  createdAt: number,
): JournalEntry {
  const prefix = projectId === 'project-a' ? 'a' : 'b';
  const journalId = `journal-${prefix}-${id}`;
  const eventId = `history-${prefix}-${id}`;
  return {
    id: journalId,
    projectId,
    userId,
    seq,
    kind,
    payload: { label: `History ${eventId}`, forward: { type: kind, workItemId } },
    inverse: { type: `undo_${kind}`, workItemId },
    preconditions: { expected: { [journalId]: createdAt }, from: {} },
    undone: false,
    createdAt,
  };
}

function task52HistoryJournals(): [JournalEntry[], JournalEntry[]] {
  return [
    [
      task52HistoryEntry('99', 'project-a', 'owner-a', 1, 'work-a-one', 'estimate', 99),
      task52HistoryEntry('100-z', 'project-a', 'owner-a', 2, 'work-a-one', 'clear_estimate', 100),
      task52HistoryEntry('100-a', 'project-a', 'owner-a', 3, 'work-a-two', 'rename', 100),
      task52HistoryEntry('100-m', 'project-a', 'owner-a', 4, 'work-a-one', 'actual', 100),
      task52HistoryEntry('101-wide', 'project-a', 'owner-a', 5, null, 'freeze', 101),
    ],
    [
      task52HistoryEntry('99', 'project-b', 'owner-b', 1, 'work-b-one', 'actual', 99),
      task52HistoryEntry('100', 'project-b', 'owner-b', 2, 'work-b-two', 'rename', 100),
      task52HistoryEntry('101-wide', 'project-b', 'owner-b', 3, null, 'freeze', 101),
    ],
  ];
}

async function readTask52HistoryState(source: SqliteSource) {
  return {
    projectAEvents: await source.stores.planEvents.listFor('project-a', {}),
    projectBEvents: await source.stores.planEvents.listFor('project-b', {}),
    journals: await Promise.all([
      source.stores.journal.entriesFor('project-a', 'owner-a'),
      source.stores.journal.entriesFor('project-b', 'owner-b'),
    ]),
  };
}

const planEventsIgnoreItemFilterFault = defineFault({
  id: 'break:planEvents.listFor:filters-order',
  caseId: 'planEvents.listFor:filters-order',
  createControl: () => createFaultControl('planEvents.listFor:filters-order:ignore-item'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      planEvents: replaceMethod(source.stores.planEvents, 'listFor', (listFor) => {
        return async (projectId, filter) => {
          if (
            !control.isArmed() ||
            projectId !== 'project-a' ||
            filter.workItemId !== 'work-a-one' ||
            filter.kinds !== undefined
          ) {
            return listFor(projectId, filter);
          }
          // Proof: with the shared prerequisite removed, the two incomplete
          // setup negatives still phase-failed here; removing this guard too
          // changed both outcomes to `observed`.
          expect(await readTask52HistoryState(source)).toEqual({
            projectAEvents: task52PlanEvents()[0],
            projectBEvents: task52PlanEvents()[1],
            journals: task52HistoryJournals(),
          });
          // Proof: forwarding the item filter removed the leaked item-two event
          // and changed the four-fault reversal to `assertion-passed` throughout.
          const leaked = await listFor(projectId, {});
          // Proof: removing this complete-result guard changed the partial real
          // listFor negative from `phase-failed` to `observed`.
          expect(leaked).toEqual(task52PlanEvents()[0]);
          control.reach('planEvents.listFor:filters-order:ignore-item');
          return leaked;
        };
      }),
    });
  },
});

const planEventsInclusivePruneFault = defineFault({
  id: 'break:planEvents.pruneOlderThan:strict-cutoff',
  caseId: 'planEvents.pruneOlderThan:strict-cutoff',
  createControl: () => createFaultControl('planEvents.pruneOlderThan:strict-cutoff:inclusive'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      planEvents: replaceMethod(source.stores.planEvents, 'pruneOlderThan', (pruneOlderThan) => {
        return async (cutoff) => {
          if (!control.isArmed() || cutoff !== 100) return pruneOlderThan(cutoff);
          // Proof: forwarding cutoff 100 retained every cutoff row and changed
          // the four-fault reversal to four `assertion-passed` outcomes.
          const deletedCount = await pruneOlderThan(101);
          const [projectAEvents, projectBEvents] = task52PlanEvents();
          expect({ deletedCount, ...(await readTask52HistoryState(source)) }).toEqual({
            deletedCount: 6,
            projectAEvents: [projectAEvents[0]],
            projectBEvents: [projectBEvents[0]],
            journals: task52HistoryJournals(),
          });
          control.reach('planEvents.pruneOlderThan:strict-cutoff:inclusive');
          return deletedCount;
        };
      }),
    });
  },
});

const journalIndependentHistoryFault = defineFault({
  id: 'break:journal.append:history-atomic:journal-independent-history',
  caseId: 'journal.append:history-atomic',
  createControl: () => createFaultControl('journal.append:history-atomic:independent-history'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          // Proof: disabling only this adapter-owned route changed the permanent
          // four-fault result's first kind from `observed` to `assertion-passed`.
          if (!control.isArmed() || entry.id !== 'atomic-target') return append(entry, event);
          await append(entry, event);
          source.db.run(
            sql`INSERT INTO conformance_independent_journal_history
                SELECT * FROM plan_event WHERE id = ${event.id}`,
          );
          source.db.run(sql`DELETE FROM plan_event WHERE id = ${event.id}`);
          expect(
            source.db.all<{
              id: string;
              projectId: string;
              userId: string;
              kind: string;
              label: string;
              workItemId: string | null;
              stepId: string | null;
              before: string;
              after: string;
              createdAt: number;
            }>(sql`SELECT id, project_id AS projectId, user_id AS userId, kind, label,
                         work_item_id AS workItemId, step_id AS stepId, before, after,
                         created_at AS createdAt
                  FROM conformance_independent_journal_history`),
          ).toEqual([
            {
              id: event.id,
              projectId: event.projectId,
              userId: event.userId,
              kind: event.kind,
              label: event.label,
              workItemId: event.workItemId,
              stepId: event.stepId,
              before: JSON.stringify(event.before),
              after: JSON.stringify(event.after),
              createdAt: event.createdAt,
            },
          ]);
          expect(
            await source.stores.journal.entriesFor(entry.projectId, entry.userId),
          ).toContainEqual({ ...entry, seq: 2, undone: false });
          expect(await source.stores.planEvents.listFor(event.projectId, {})).not.toContainEqual(
            event,
          );
          control.reach('journal.append:history-atomic:independent-history');
        };
      }),
    });
  },
});

function prepareJournalIndependentHistory(source: SqliteSource): Promise<void> {
  source.db.run(
    sql.raw(
      'CREATE TEMP TABLE conformance_independent_journal_history AS SELECT * FROM plan_event WHERE 0',
    ),
  );
  return Promise.resolve();
}

function rejectJournalIndependentHistoryCreate(source: SqliteSource): Promise<void> {
  source.db.run(
    sql.raw(
      'CREATE TEMP TABLE conformance_independent_journal_history AS SELECT * FROM conformance_missing_plan_event WHERE 0',
    ),
  );
  return Promise.resolve();
}

const journalLateOutsideFault = defineFault({
  id: 'break:journal.append:history-atomic:journal-late-outside',
  caseId: 'journal.append:history-atomic',
  createControl: () => createFaultControl('journal.append:history-atomic:outside-transaction'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'atomic-late-target') return;
          expect(
            await source.stores.journal.entriesFor(entry.projectId, entry.userId),
          ).toContainEqual({ ...entry, seq: 3, undone: false });
          expect(await source.stores.planEvents.listFor(event.projectId, {})).toContainEqual(event);
          control.reach('journal.append:history-atomic:outside-transaction');
          throw new Error('injected SQLite journal-history-insert failure outside transaction');
        };
      }),
    });
  },
});

interface JournalIncompleteProbe {
  attempts: number;
  closeCalls: number;
  entries: JournalEntry[][] | null;
  history: PlanEvent[][] | null;
}

function commitJournalWithoutLateHistory(
  source: SqliteSource,
  probe: JournalIncompleteProbe,
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'atomic-late-target') return;
          probe.attempts += 1;
          source.db.run(sql`DELETE FROM plan_event WHERE id = ${event.id}`);
          probe.entries = await Promise.all([
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[0],
              DETERMINISTIC_SEED.ownerIds[0],
            ),
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[0],
              DETERMINISTIC_SEED.ownerIds[1],
            ),
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[1],
              DETERMINISTIC_SEED.ownerIds[1],
            ),
          ]);
          probe.history = await Promise.all(
            DETERMINISTIC_SEED.projectIds.map((projectId) =>
              source.stores.planEvents.listFor(projectId, {}),
            ),
          );
        };
      }),
    },
  );
}

function expectedAtomicEntry(
  id: string,
  projectId: string,
  userId: string,
  seq: number,
  createdAt: number,
): JournalEntry {
  return {
    id,
    projectId,
    userId,
    seq,
    kind: 'rename',
    payload: { label: `Rename ${id}`, forward: { type: 'rename', name: `After ${id}` } },
    inverse: { type: 'rename', name: `Before ${id}` },
    preconditions: { expected: { [id]: createdAt }, from: { [id]: createdAt - 1 } },
    undone: false,
    createdAt,
  };
}

function expectedAtomicEvent(
  id: string,
  projectId: string,
  userId: string,
  createdAt: number,
): PlanEvent {
  return {
    id: `event-${id}`,
    projectId,
    userId,
    kind: 'rename',
    label: `Rename ${id}`,
    workItemId: `${id}-work`,
    stepId: null,
    before: { type: 'rename', name: `Before ${id}` },
    after: { type: 'rename', name: `After ${id}` },
    createdAt,
  };
}

const journalCollateralActorFault = defineFault({
  id: 'break:journal.append:history-atomic:journal-collateral-actor',
  caseId: 'journal.append:history-atomic',
  createControl: () => createFaultControl('journal.append:history-atomic:collateral-actor'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'atomic-target') return;
          await source.stores.journal.discard('atomic-sentinel-b');
          control.reach('journal.append:history-atomic:collateral-actor');
        };
      }),
    });
  },
});

const journalReplacementCorruptionFault = defineFault({
  id: 'break:journal.append:account-redo-depth:journal-replacement-corruption',
  caseId: 'journal.append:account-redo-depth',
  createControl: () => createFaultControl('journal.append:account-redo-depth:replacement-record'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          if (entry.id !== 'redo-a-replacement') return append(entry, event);
          await append({ ...entry, inverse: { broken: 'replacement inverse' } }, event);
          control.reach('journal.append:account-redo-depth:replacement-record');
        };
      }),
    });
  },
});

function expectedActorBRedo() {
  return {
    id: 'redo-b',
    projectId: DETERMINISTIC_SEED.projectIds[0],
    userId: DETERMINISTIC_SEED.ownerIds[1],
    seq: 1,
    kind: 'rename' as const,
    payload: { label: 'Rename redo-b', forward: { type: 'rename', name: 'After redo-b' } },
    inverse: { type: 'rename', name: 'Before redo-b' },
    preconditions: { expected: { 'redo-b': 900 }, from: { 'redo-b': 899 } },
    undone: true,
    createdAt: 102,
  };
}

const journalBroadRedoFault = defineFault({
  id: 'break:journal.append:account-redo-depth:journal-broad-redo',
  caseId: 'journal.append:account-redo-depth',
  createControl: () => createFaultControl('journal.append:account-redo-depth:all-redo'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'redo-a-replacement') return;
          expect(
            await source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[0],
              DETERMINISTIC_SEED.ownerIds[1],
            ),
          ).toEqual([expectedActorBRedo()]);
          await source.stores.journal.discard('redo-b');
          control.reach('journal.append:account-redo-depth:all-redo');
        };
      }),
    });
  },
});

const journalHistoryPruneFault = defineFault({
  id: 'break:journal.append:account-redo-depth:journal-history-prune',
  caseId: 'journal.append:account-redo-depth',
  createControl: () => createFaultControl('journal.append:account-redo-depth:history-prune'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'depth-50') return;
          await source.stores.planEvents.pruneOlderThan(350);
          control.reach('journal.append:account-redo-depth:history-prune');
        };
      }),
    });
  },
});

const subtreeDependencyBackingFault = defineFault({
  id: 'break:subtrees.insertSubtree:complete-copy:subtree-dependency-backing',
  caseId: 'subtrees.insertSubtree:complete-copy',
  createControl: () => createFaultControl('subtrees.insertSubtree:complete-copy:dependencies'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', (insertSubtree) => {
        return async (copy, stamp) => {
          if (!control.isArmed()) return insertSubtree(copy, stamp);
          await insertSubtree({ ...copy, dependencies: [] }, stamp);
          source.db.run(
            sql.raw(
              'CREATE TEMP TABLE IF NOT EXISTS conformance_isolated_dependency (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, predecessor_id TEXT NOT NULL, successor_id TEXT NOT NULL)',
            ),
          );
          for (const edge of copy.dependencies) {
            source.db.run(
              sql`INSERT INTO conformance_isolated_dependency (id, project_id, predecessor_id, successor_id)
                  VALUES (${edge.id}, ${edge.projectId}, ${edge.predecessorId}, ${edge.successorId})`,
            );
          }
          expect(
            source.db.all<StoredDependency>(
              sql`SELECT id, project_id AS projectId, predecessor_id AS predecessorId,
                         successor_id AS successorId
                  FROM conformance_isolated_dependency ORDER BY id`,
            ),
          ).toEqual([...copy.dependencies]);
          // Proof: removing only this complete-state prerequisite changed the
          // successful-incomplete dependency proof from phase-failed to observed.
          assertCompleteStateAlternative(
            await readSubtreePublicState(readersOf(source), DETERMINISTIC_SEED.projectIds[0]),
            DETERMINISTIC_SEED,
            [{ dependencyIds: copy.dependencies.map(({ id }) => id) }, {}],
          );
          control.reach('subtrees.insertSubtree:complete-copy:dependencies');
        };
      }),
    });
  },
});

const subtreeRemovedMeasureFault = defineFault({
  id: 'break:subtrees.insertSubtree:complete-copy:subtree-removed-measure',
  caseId: 'subtrees.insertSubtree:complete-copy',
  createControl: () => createFaultControl('subtrees.insertSubtree:complete-copy:removed-measure'),
  mutate(source: SqliteSource, control) {
    return withStores(source, {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', (insertSubtree) => {
        return async (copy, stamp) => {
          if (!control.isArmed()) return insertSubtree(copy, stamp);
          const metrics = ['token_estimate', 'token_actual', 'hours_actual'] as const;
          const pairWide = copy.removedMeasures.flatMap(({ workItemId, stepId }) =>
            metrics.map((metric) => ({ workItemId, stepId, metric })),
          );
          await insertSubtree({ ...copy, removedMeasures: pairWide }, stamp);
          const [firstItemId, removalItemId] = DETERMINISTIC_SEED.workItemIds[0];
          const [devStepId, qaStepId] = DETERMINISTIC_SEED.stepIds[0];
          // Proof: removing only this complete-state prerequisite changed the
          // successful-incomplete measure proof from phase-failed to observed.
          assertCompleteStateAlternative(
            await readSubtreePublicState(readersOf(source), DETERMINISTIC_SEED.projectIds[0]),
            DETERMINISTIC_SEED,
            [
              {
                measureKeys: [
                  `${removalItemId}\u0000${devStepId}\u0000token_actual`,
                  `${removalItemId}\u0000${devStepId}\u0000hours_actual`,
                  `${firstItemId}\u0000${qaStepId}\u0000token_estimate`,
                ],
              },
              {},
            ],
          );
          control.reach('subtrees.insertSubtree:complete-copy:removed-measure');
        };
      }),
    });
  },
});

const subtreeRollbackFault = defineFault({
  id: 'break:subtrees.insertSubtree:late-failure',
  caseId: 'subtrees.insertSubtree:late-failure',
  createControl: () => createFaultControl('subtrees.insertSubtree:late-failure:no-transaction'),
  mutate(source: SqliteSource, _control) {
    return withStores(source, {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', (insertSubtree) => {
        return (copy, stamp) => {
          return insertSubtree(copy, stamp);
        };
      }),
    });
  },
});

type SqliteSavedPlanWriteFaultId =
  | 'break:savedPlans.write:bytes-and-bodies:utf8-length'
  | 'break:savedPlans.write:bytes-and-bodies:header-only'
  | 'break:savedPlans.write:bytes-and-bodies:altered-body'
  | 'break:savedPlans.write:bytes-and-bodies:altered-hash'
  | 'break:savedPlans.write:bytes-and-bodies:affected-row';

function sqliteSavedPlanWriteFault<const Id extends SqliteSavedPlanWriteFaultId>(
  id: Id,
  phase: string,
  corrupt: (source: SqliteSource) => void | Promise<void>,
  verify: (source: SqliteSource) => Promise<void>,
) {
  return defineFault<SqliteSource, Id, string, ReturnType<typeof createFaultControl<string>>>({
    id,
    // The closed local ID union maps every member to this one manifest case.
    caseId: 'savedPlans.write:bytes-and-bodies' as FaultCase<Id>,
    createControl: () => createFaultControl(phase),
    mutate(source: SqliteSource, control) {
      return withSavedPlans(
        source,
        replaceSavedPlanWrite(
          source.history.savedPlans,
          (write) =>
            async <Refusal>(
              plan: SavedPlanWrite,
              check: SavedPlanCheck<Refusal>,
            ): Promise<SavedPlanWriteOutcome<Refusal>> => {
              const outcome = await write(plan, check);
              if (plan.id !== 'saved-present' || outcome.outcome !== 'written') return outcome;
              expect(await source.history.savedPlans.readOf(plan.id)).toEqual(
                expectedTask61Present(),
              );
              await corrupt(source);
              await verify(source);
              control.reach(phase);
              return outcome;
            },
        ),
      );
    },
  });
}

function expectedTask61Present() {
  return {
    header: {
      id: 'saved-present',
      projectId: 'project-a',
      name: 'Present plan',
      createdBy: 'Ada Display',
      createdById: 'owner-b',
      createdAt: 301,
      inputSchemaVersion: 7,
      inputBytes: 6,
      inputSha256: 'input-hash-present',
      scheduleSchemaVersion: 9,
      scheduleBytes: 2,
      scheduleSha256: 'schedule-hash-present',
      scheduleInputSha256: 'input-hash-present',
      schedulerAlgorithmId: 'scheduler-present',
      scheduleAbsentReason: null,
    },
    bodies: { input: 'A🔦B', schedule: 'é' },
  };
}

function runTask61Mutation(
  source: SqliteSource,
  statement: string,
  expectedChanges: number,
  observeChanges?: (changes: number) => void | Promise<void>,
) {
  const mutation = source.db.run(sql.raw(statement));
  return Promise.resolve(observeChanges?.(mutation.changes)).then(() => {
    // Proof: `rejects a zero-row SQLite saved-plan mutation at its affected-row guard`
    // runs a real zero-row DELETE after the complete write prerequisite. Removing this
    // assertion changed its proof from phase-failed to assertion-passed.
    expect(mutation.changes).toBe(expectedChanges);
  });
}

function expectedTask61Touch(
  id: string,
  projectId: string,
  name: string,
  createdBy: string,
  createdById: string | null,
  createdAt: number,
  schema: number,
  bytes: string,
  inputBytes: number,
  hash: string,
) {
  return {
    header: {
      id,
      projectId,
      name,
      createdBy,
      createdById,
      createdAt,
      inputSchemaVersion: schema,
      inputBytes,
      inputSha256: hash,
      scheduleSchemaVersion: null,
      scheduleBytes: null,
      scheduleSha256: null,
      scheduleInputSha256: null,
      schedulerAlgorithmId: null,
      scheduleAbsentReason: 'not-requested',
    },
    bodies: { input: bytes, schedule: null },
  };
}

async function assertCompleteTask61UnknownState(source: SqliteSource) {
  const target = expectedTask61Touch(
    'touch-target',
    'project-a',
    'Renamed target',
    'External author',
    'owner-b',
    401,
    1,
    'target',
    6,
    'hash-target',
  );
  const nullable = expectedTask61Touch(
    'touch-null-creator',
    'project-a',
    'Null creator',
    'Deleted account display',
    null,
    402,
    2,
    'nullable',
    8,
    'hash-nullable',
  );
  const peer = expectedTask61Touch(
    'touch-peer',
    'project-a',
    'Project peer',
    'Owner A display',
    'owner-a',
    403,
    3,
    'peer',
    4,
    'hash-peer',
  );
  const other = expectedTask61Touch(
    'touch-other-project',
    'project-b',
    'Other project sentinel',
    'Owner A cross-project',
    'owner-a',
    404,
    4,
    'sentinel',
    8,
    'hash-sentinel',
  );
  const ids = [
    'touch-target',
    'touch-null-creator',
    'touch-peer',
    'touch-other-project',
    'missing-touch-plan',
  ];
  expect(await Promise.all(ids.map((id) => source.history.savedPlans.readOf(id)))).toEqual([
    target,
    nullable,
    peer,
    other,
    null,
  ]);
  expect(
    await Promise.all(
      DETERMINISTIC_SEED.projectIds.map((id) => source.history.savedPlans.listOf(id)),
    ),
  ).toEqual([[peer.header, nullable.header, target.header], [other.header]]);
  expect(await Promise.all(ids.map((id) => source.history.savedPlans.principalsOf(id)))).toEqual([
    {
      savedPlanId: 'touch-target',
      projectId: 'project-a',
      projectOwnerId: 'owner-a',
      createdById: 'owner-b',
    },
    {
      savedPlanId: 'touch-null-creator',
      projectId: 'project-a',
      projectOwnerId: 'owner-a',
      createdById: null,
    },
    {
      savedPlanId: 'touch-peer',
      projectId: 'project-a',
      projectOwnerId: 'owner-a',
      createdById: 'owner-a',
    },
    {
      savedPlanId: 'touch-other-project',
      projectId: 'project-b',
      projectOwnerId: 'owner-b',
      createdById: 'owner-a',
    },
    null,
  ]);
}

const savedPlanUtf8LengthFault = sqliteSavedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:utf8-length',
  'saved-plan:utf8-length',
  async (source) => {
    await runTask61Mutation(
      source,
      "UPDATE saved_plan SET input_bytes = 4, schedule_bytes = 1 WHERE id = 'saved-present'",
      1,
    );
  },
  async (source) => {
    // Proof: changing the persisted counts to UTF-16 lengths reached this exact
    // prerequisite and the shared case failed with input 6/4 and schedule 2/1.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      header: { ...expected.header, inputBytes: 4, scheduleBytes: 1 },
    });
  },
);

const savedPlanHeaderOnlyFault = sqliteSavedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:header-only',
  'saved-plan:header-only',
  async (source) => {
    await runTask61Mutation(
      source,
      "DELETE FROM saved_plan_body WHERE saved_plan_id = 'saved-present'",
      2,
    );
  },
  async (source) => {
    // Proof: deleting both real body rows preserved the header and failed the
    // shared complete read with expected multibyte bodies versus null.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      bodies: { input: null, schedule: null },
    });
  },
);

interface SavedPlanAffectedRowProbe {
  attempts: number;
  closeCalls: number;
  changes: number | null;
  state: SavedPlanPublicState | null;
}

function savedPlanAffectedRowFault(probe: SavedPlanAffectedRowProbe) {
  return sqliteSavedPlanWriteFault(
    'break:savedPlans.write:bytes-and-bodies:affected-row',
    'saved-plan:affected-row',
    async (source) => {
      probe.attempts += 1;
      await runTask61Mutation(
        source,
        "DELETE FROM saved_plan_body WHERE saved_plan_id = 'missing-affected-row-plan'",
        2,
        async (changes) => {
          probe.changes = changes;
          probe.state = await readSavedPlanPublicState(source, ['saved-present', 'saved-absent']);
        },
      );
    },
    async (source) => {
      expect(await source.history.savedPlans.readOf('saved-present')).toEqual(
        expectedTask61Present(),
      );
    },
  );
}

function countSavedPlanClose(source: SqliteSource, probe: SavedPlanAffectedRowProbe): SqliteSource {
  return withSavedPlans(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    source.history.savedPlans,
  );
}

const savedPlanAlteredBodyFault = sqliteSavedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:altered-body',
  'saved-plan:body-bytes',
  async (source) => {
    await runTask61Mutation(
      source,
      "UPDATE saved_plan_body SET bytes = 'A🔦C' WHERE saved_plan_id = 'saved-present' AND kind = 'input'",
      1,
    );
  },
  async (source) => {
    // Proof: changing only the persisted input row reached this prerequisite and
    // failed the shared exact-body assertion with A🔦B expected and A🔦C received.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      bodies: { input: 'A🔦C', schedule: 'é' },
    });
  },
);

const savedPlanAlteredHashFault = sqliteSavedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:altered-hash',
  'saved-plan:body-hash',
  async (source) => {
    await runTask61Mutation(
      source,
      "UPDATE saved_plan SET schedule_sha256 = 'schedule-hash-altered' WHERE id = 'saved-present'",
      1,
    );
  },
  async (source) => {
    // Proof: changing only the persisted schedule hash reached this prerequisite
    // and failed with schedule-hash-present expected and schedule-hash-altered received.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      header: { ...expected.header, scheduleSha256: 'schedule-hash-altered' },
    });
  },
);

const savedPlanPrincipalFault = defineFault({
  id: 'break:savedPlans.touch:principals-scope:principal-identity',
  caseId: 'savedPlans.touch:principals-scope',
  createControl: () => createFaultControl('saved-plan:principals'),
  mutate(source: SqliteSource, control) {
    return withSavedPlans(
      source,
      replaceSavedPlanWrite(
        source.history.savedPlans,
        (write) =>
          async <Refusal>(
            plan: SavedPlanWrite,
            check: SavedPlanCheck<Refusal>,
          ): Promise<SavedPlanWriteOutcome<Refusal>> => {
            const outcome = await write(
              plan.id === 'touch-target'
                ? { ...plan, createdById: DETERMINISTIC_SEED.ownerIds[0] }
                : plan,
              check,
            );
            if (plan.id !== 'touch-target' || outcome.outcome !== 'written') return outcome;
            // Proof: conflating the creator with the project owner reached only after
            // the repository and principal query exposed owner-a in both roles.
            expect(await source.history.savedPlans.principalsOf(plan.id)).toEqual({
              savedPlanId: 'touch-target',
              projectId: 'project-a',
              projectOwnerId: 'owner-a',
              createdById: 'owner-a',
            });
            expect(await source.history.savedPlans.readOf(plan.id)).toEqual({
              ...expectedTask61Touch(
                'touch-target',
                'project-a',
                'Touch target',
                'External author',
                'owner-a',
                401,
                1,
                'target',
                6,
                'hash-target',
              ),
              header: {
                ...expectedTask61Touch(
                  'touch-target',
                  'project-a',
                  'Touch target',
                  'External author',
                  'owner-a',
                  401,
                  1,
                  'target',
                  6,
                  'hash-target',
                ).header,
                createdById: 'owner-a',
              },
            });
            control.reach('saved-plan:principals');
            return outcome;
          },
      ),
    );
  },
});

function sqliteSavedPlanUnknownTouchFault(method: 'renameTo' | 'deleteOf', phase: string) {
  return defineFault({
    id:
      method === 'renameTo'
        ? 'break:savedPlans.touch:principals-scope:unknown-rename'
        : 'break:savedPlans.touch:principals-scope:unknown-delete',
    caseId: 'savedPlans.touch:principals-scope',
    createControl: () => createFaultControl(phase),
    mutate(source: SqliteSource, control) {
      const savedPlans =
        method === 'renameTo'
          ? replaceMethod(
              source.history.savedPlans,
              'renameTo',
              (renameTo) => async (savedPlanId, name) => {
                const outcome = await renameTo(savedPlanId, name);
                if (savedPlanId !== 'missing-touch-plan') return outcome;
                // Proof: returning touched only after these repository outcomes and
                // readback checks failed the shared unknown rename assertion.
                expect(outcome).toBe('no_such_plan');
                await assertCompleteTask61UnknownState(source);
                control.reach(phase);
                return 'touched';
              },
            )
          : replaceMethod(
              source.history.savedPlans,
              'deleteOf',
              (deleteOf) => async (savedPlanId) => {
                const outcome = await deleteOf(savedPlanId);
                if (savedPlanId !== 'missing-touch-plan') return outcome;
                // Proof: returning touched only after these repository outcomes and
                // readback checks failed the shared unknown delete assertion.
                expect(outcome).toBe('no_such_plan');
                await assertCompleteTask61UnknownState(source);
                control.reach(phase);
                return 'touched';
              },
            );
      return withSavedPlans(source, savedPlans);
    },
  });
}

const savedPlanUnknownRenameFault = sqliteSavedPlanUnknownTouchFault(
  'renameTo',
  'saved-plan:unknown-rename',
);
const savedPlanUnknownDeleteFault = sqliteSavedPlanUnknownTouchFault(
  'deleteOf',
  'saved-plan:unknown-delete',
);

function expectedTask62Plan(
  id: string,
  name: string,
  createdAt: number,
  input: string,
  inputBytes: number,
  inputSha256: string,
  schedule?: { readonly body: string; readonly bytes: number; readonly sha256: string },
  projectId = 'project-a',
): StoredSavedPlan {
  return {
    header: {
      id,
      projectId,
      name,
      createdBy: 'Quota Writer',
      createdById: 'owner-b',
      createdAt,
      inputSchemaVersion: 11,
      inputBytes,
      inputSha256,
      scheduleSchemaVersion: schedule === undefined ? null : 12,
      scheduleBytes: schedule?.bytes ?? null,
      scheduleSha256: schedule?.sha256 ?? null,
      scheduleInputSha256: schedule === undefined ? null : inputSha256,
      schedulerAlgorithmId: schedule === undefined ? null : 'conformance-scheduler',
      scheduleAbsentReason: schedule === undefined ? 'pending' : null,
    },
    bodies: { input, schedule: schedule?.body ?? null },
  };
}

function task62OtherPlan() {
  return expectedTask62Plan(
    'saved-other-project',
    'Other project sentinel',
    500,
    'é',
    2,
    '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    undefined,
    'project-b',
  );
}

async function assertTask62FaultState(source: SqliteSource, plans: readonly StoredSavedPlan[]) {
  const ids = plans.map(({ header }) => header.id);
  expect(await readSavedPlanPublicState(source, ids)).toEqual({
    reads: [...plans],
    lists: [
      plans
        .filter(({ header }) => header.projectId === 'project-a')
        .map(({ header }) => header)
        .toSorted((a, b) => b.createdAt - a.createdAt),
      plans.filter(({ header }) => header.projectId === 'project-b').map(({ header }) => header),
    ],
    principals: plans.map(({ header }) => ({
      savedPlanId: header.id,
      projectId: header.projectId,
      projectOwnerId: header.projectId === 'project-a' ? 'owner-a' : 'owner-b',
      createdById: header.createdById,
    })),
  });
}

function expectedTask62PublicState(
  ids: readonly string[],
  plans: readonly StoredSavedPlan[],
): SavedPlanPublicState {
  return {
    reads: ids.map((id) => plans.find(({ header }) => header.id === id) ?? null),
    lists: ['project-a', 'project-b'].map((projectId) =>
      plans
        .filter(({ header }) => header.projectId === projectId)
        .map(({ header }) => header)
        .toSorted((a, b) => b.createdAt - a.createdAt),
    ),
    principals: ids.map((id) => {
      const plan = plans.find(({ header }) => header.id === id);
      return plan === undefined
        ? null
        : {
            savedPlanId: id,
            projectId: plan.header.projectId,
            projectOwnerId: plan.header.projectId === 'project-a' ? 'owner-a' : 'owner-b',
            createdById: plan.header.createdById,
          };
    }),
  };
}

function expectedPrematureTask62States(): SavedPlanPublicState[] {
  const other = task62OtherPlan();
  return [
    expectedTask62PublicState(
      ['quota-refused', 'quota-held', 'saved-other-project'],
      [
        expectedTask62Plan(
          'quota-held',
          'Quota held',
          501,
          'held-🔒',
          9,
          'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
          {
            body: 'é',
            bytes: 2,
            sha256: '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
          },
        ),
        other,
      ],
    ),
    expectedTask62PublicState(
      ['quota-window-last', 'quota-window-held', 'quota-window-rival', 'saved-other-project'],
      [
        expectedTask62Plan(
          'quota-window-held',
          'Quota window held',
          511,
          'held-🔒',
          9,
          'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
        ),
        other,
      ],
    ),
    expectedTask62PublicState(
      ['late-target', 'late-sentinel', 'saved-other-project'],
      [
        expectedTask62Plan(
          'late-sentinel',
          'Late sentinel',
          521,
          'held-🔒',
          9,
          'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
        ),
        other,
      ],
    ),
  ];
}

const savedPlanPersistedRefusalFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-persisted-refusal',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:persisted'),
  mutate(source: SqliteSource, control) {
    return withSavedPlans(
      source,
      replaceSavedPlanWrite(source.history.savedPlans, (write) => {
        return async <Refusal>(plan: SavedPlanWrite, check: SavedPlanCheck<Refusal>) => {
          if (plan.id !== 'quota-refused') return write(plan, check);
          const captured: { refusal?: Refusal } = {};
          const internal = await write(plan, async (holding, incomingBytes) => {
            const refusal = await check(holding, incomingBytes);
            if (refusal === null) throw new Error('quota-refusal callback did not refuse');
            captured.refusal = refusal;
            return null;
          });
          expect(internal).toEqual({ outcome: 'written' });
          expect(await source.history.savedPlans.readOf('quota-refused')).toEqual(
            expectedTask62Plan(
              'quota-refused',
              'Quota refused',
              502,
              'incoming-🧭',
              13,
              '20f308b7c45b89eaecd7daa6b17c214d4c303638748d2cd9298171474709a985',
              {
                body: 'dates-📅',
                bytes: 10,
                sha256: '634793e74e7980a5cab8220e0cfd6c9fc916b78ab1af8a77f165a3be7bd319f0',
              },
            ),
          );
          await assertTask62FaultState(source, [
            expectedTask62Plan(
              'quota-refused',
              'Quota refused',
              502,
              'incoming-🧭',
              13,
              '20f308b7c45b89eaecd7daa6b17c214d4c303638748d2cd9298171474709a985',
              {
                body: 'dates-📅',
                bytes: 10,
                sha256: '634793e74e7980a5cab8220e0cfd6c9fc916b78ab1af8a77f165a3be7bd319f0',
              },
            ),
            expectedTask62Plan(
              'quota-held',
              'Quota held',
              501,
              'held-🔒',
              9,
              'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
              {
                body: 'é',
                bytes: 2,
                sha256: '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
              },
            ),
            task62OtherPlan(),
          ]);
          if (captured.refusal === undefined)
            throw new Error('quota-refusal callback did not refuse');
          // Proof: persisting through the production transaction while returning the real
          // refusal failed the shared full-state assertion with the complete extra plan.
          control.reach('saved-plan:quota-refusal:persisted');
          return { outcome: 'refused', refusal: captured.refusal };
        };
      }),
    );
  },
});

const savedPlanStaleQuotaFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-stale-quota',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:stale-check'),
  mutate(source: SqliteSource, control) {
    const quotaRivalOwner: { settlement?: Promise<unknown> } = {};
    return {
      ...withSavedPlans(
        source,
        replaceSavedPlanWrite(source.history.savedPlans, (write) => {
          return async <Refusal>(plan: SavedPlanWrite, check: SavedPlanCheck<Refusal>) => {
            if (plan.id !== 'quota-window-last') return write(plan, check);
            const refusal = await check({ plans: 1, bytes: 9 }, 9);
            if (refusal !== null) return { outcome: 'refused', refusal };
            const rival = quotaRivalOwner.settlement;
            if (rival === undefined)
              throw new Error('quota rival was not issued by the real callback');
            await rival;
            const outcome = await write(plan, () => Promise.resolve<Refusal | null>(null));
            expect(outcome).toEqual({ outcome: 'written' });
            expect(await source.history.savedPlans.readOf('quota-window-rival')).toEqual(
              expectedTask62Plan(
                'quota-window-rival',
                'Quota window rival',
                513,
                'rival-🚫',
                10,
                'a2587844f6a3f32d7fa53ae64c1109cf97b7dfa12912a794afca9d56ad317b70',
              ),
            );
            expect(await source.history.savedPlans.readOf('quota-window-last')).toEqual(
              expectedTask62Plan(
                'quota-window-last',
                'Quota window last',
                512,
                'last-🧩',
                9,
                'cb1554f2d98617e8cfbc265940ca894fffb31324d8e9846b70d684e34ef41515',
              ),
            );
            await assertTask62FaultState(source, [
              expectedTask62Plan(
                'quota-window-rival',
                'Quota window rival',
                513,
                'rival-🚫',
                10,
                'a2587844f6a3f32d7fa53ae64c1109cf97b7dfa12912a794afca9d56ad317b70',
              ),
              expectedTask62Plan(
                'quota-window-last',
                'Quota window last',
                512,
                'last-🧩',
                9,
                'cb1554f2d98617e8cfbc265940ca894fffb31324d8e9846b70d684e34ef41515',
              ),
              expectedTask62Plan(
                'quota-window-held',
                'Quota window held',
                511,
                'held-🔒',
                9,
                'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
              ),
              task62OtherPlan(),
            ]);
            // Proof: moving the callback before BEGIN IMMEDIATE let the second real connection
            // settle first; the shared case received written plus the complete rival.
            control.reach('saved-plan:quota-window:stale-check');
            return outcome;
          };
        }),
      ),
      quotaRivalOwner,
    };
  },
});

const savedPlanSplitWriteFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-split-write',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:split-transaction'),
  mutate(source: SqliteSource) {
    return source;
  },
});

const savedPlanMissingInputFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-missing-input',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:missing-input'),
  mutate(source: SqliteSource) {
    return observeTask62Write(source, sqliteMissingInputProbe, 'late-target', [
      'late-target',
      'late-sentinel',
      'saved-other-project',
    ]);
  },
});

const savedPlanRefusalNoMutationFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-mutation',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:no-mutation'),
  mutate(source: SqliteSource, control) {
    return withSavedPlans(
      source,
      replaceSavedPlanWrite(source.history.savedPlans, (write) => async (plan, check) => {
        const outcome = await write(plan, check);
        if (plan.id === 'quota-refused') control.reach('saved-plan:quota-refusal:no-mutation');
        return outcome;
      }),
    );
  },
});

const savedPlanWindowNoMutationFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-window-no-mutation',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:no-mutation'),
  mutate(source: SqliteSource, control) {
    return withSavedPlans(
      source,
      replaceSavedPlanWrite(source.history.savedPlans, (write) => async (plan, check) => {
        const outcome = await write(plan, check);
        if (plan.id === 'quota-window-last') control.reach('saved-plan:quota-window:no-mutation');
        return outcome;
      }),
    );
  },
});

const savedPlanLateNoMutationFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-late-no-mutation',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:no-mutation'),
  mutate(source: SqliteSource) {
    return source;
  },
});

function prematureTask62Source(source: SqliteSource, probe: SavedPlanPhaseProbe, targetId: string) {
  const owned = {
    ...source,
    async close() {
      probe.closeCalls += 1;
      await closeAfterSavedPlanSnapshot(source, task62ProbeIds(targetId), (state) => {
        probe.state = state;
      });
    },
  };
  return withSavedPlans(
    owned,
    replaceSavedPlanWrite(source.history.savedPlans, (write) => async (plan, check) => {
      if (plan.id !== targetId) return write(plan, check);
      probe.attempts += 1;
      throw new Error(`injected failure before ${targetId} phase`);
    }),
  );
}

function task62ProbeIds(targetId: string): readonly string[] {
  if (targetId === 'quota-refused') return [targetId, 'quota-held', 'saved-other-project'];
  if (targetId === 'quota-window-last')
    return [targetId, 'quota-window-held', 'quota-window-rival', 'saved-other-project'];
  return [targetId, 'late-sentinel', 'saved-other-project'];
}

function observeTask62Write(
  source: SqliteSource,
  probe: SavedPlanPhaseProbe,
  targetId: string,
  ids: readonly string[],
): SqliteSource {
  const owned = {
    ...source,
    async close() {
      probe.closeCalls += 1;
      await closeAfterSavedPlanSnapshot(source, ids, (state) => {
        probe.state = state;
      });
    },
  };
  return withSavedPlans(
    owned,
    replaceSavedPlanWrite(source.history.savedPlans, (write) => (plan, check) => {
      if (plan.id !== targetId) return write(plan, check);
      probe.attempts += 1;
      return write(plan, async (holding, incomingBytes) => {
        probe.observations?.push({
          holding: { plans: holding.plans, bytes: holding.bytes },
          incomingBytes,
        });
        return check(holding, incomingBytes);
      }).catch((failure: unknown) => {
        probe.failure = failure;
        throw failure;
      });
    }),
  );
}

async function closeAfterSavedPlanSnapshot(
  source: SavedPlanSnapshotSource,
  ids: readonly string[],
  observe: (state: SavedPlanPublicState) => void,
): Promise<void> {
  let didObservationFail = false;
  let observationFailure: unknown;
  try {
    observe(await readSavedPlanPublicState(source, ids));
  } catch (failure) {
    didObservationFail = true;
    observationFailure = failure;
  }
  let didCloseFail = false;
  let closeFailure: unknown;
  try {
    await source.close();
  } catch (failure) {
    didCloseFail = true;
    closeFailure = failure;
  }
  // Proof: a rejected public read used to leave the real SQLite source connection open.
  if (didObservationFail && didCloseFail)
    throw new AggregateError(
      [observationFailure, closeFailure],
      'saved-plan observation and SQLite source close both failed',
      { cause: closeFailure },
    );
  if (didObservationFail) throw observationFailure;
  if (didCloseFail) throw closeFailure;
}

const savedPlanRefusalPrematureFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-premature',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:premature'),
  mutate(source: SqliteSource) {
    return prematureTask62Source(source, sqlitePrematureProbes[0], 'quota-refused');
  },
});
const savedPlanWindowPrematureFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-window-premature',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:premature'),
  mutate(source: SqliteSource) {
    return prematureTask62Source(source, sqlitePrematureProbes[1], 'quota-window-last');
  },
});
const savedPlanLatePrematureFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-late-premature',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:premature'),
  mutate(source: SqliteSource) {
    return prematureTask62Source(source, sqlitePrematureProbes[2], 'late-target');
  },
});
const sqlitePrematureProbes: SavedPlanPhaseProbe[] = Array.from({ length: 3 }, () => ({
  attempts: 0,
  closeCalls: 0,
  state: null,
}));
const sqliteMissingInputProbe: SavedPlanPhaseProbe = { attempts: 0, closeCalls: 0, state: null };

const savedPlanRefusalNoReachFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-reach',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:no-reach'),
  mutate(source: SqliteSource) {
    const muted = createFaultControl('saved-plan:quota-refusal:persisted');
    muted.arm();
    return savedPlanPersistedRefusalFault.mutate(source, muted);
  },
});
const savedPlanWindowNoReachFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-window-no-reach',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:no-reach'),
  mutate(source: SqliteSource) {
    const muted = createFaultControl('saved-plan:quota-window:stale-check');
    muted.arm();
    return savedPlanStaleQuotaFault.mutate(source, muted);
  },
});
const savedPlanLateNoReachFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-late-no-reach',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:no-reach'),
  mutate(source: SqliteSource) {
    return source;
  },
});

interface SavedPlanPhaseProbe {
  attempts: number;
  closeCalls: number;
  state: SavedPlanPublicState | null;
  boundary?: StoredSavedPlan | null;
  observations?: { readonly holding: SavedPlanHoldingRow; readonly incomingBytes: number }[];
  failure?: unknown;
}

interface SavedPlanPublicState {
  readonly reads: readonly (StoredSavedPlan | null)[];
  readonly lists: readonly (readonly SavedPlanRow[])[];
  readonly principals: readonly (SavedPlanPrincipals | null)[];
}

interface SavedPlanSnapshotSource {
  readonly history: {
    readonly savedPlans: Pick<SavedPlanStore, 'readOf' | 'listOf' | 'principalsOf'>;
  };
  close(): Promise<void>;
}

const TASK61_TOUCH_IDS = [
  'touch-target',
  'touch-null-creator',
  'touch-peer',
  'touch-other-project',
  'missing-touch-plan',
] as const;

async function readSavedPlanPublicState(
  source: SavedPlanSnapshotSource,
  ids: readonly string[],
): Promise<SavedPlanPublicState> {
  return {
    reads: await Promise.all(ids.map((id) => source.history.savedPlans.readOf(id))),
    lists: await Promise.all(
      DETERMINISTIC_SEED.projectIds.map((projectId) => source.history.savedPlans.listOf(projectId)),
    ),
    principals: await Promise.all(ids.map((id) => source.history.savedPlans.principalsOf(id))),
  };
}

function expectedTask61PartialBodiesState(): SavedPlanPublicState {
  const present = expectedTask61Present();
  return {
    reads: [{ ...present, bodies: { input: null, schedule: null } }, null],
    lists: [[present.header], []],
    principals: [
      {
        savedPlanId: 'saved-present',
        projectId: 'project-a',
        projectOwnerId: 'owner-a',
        createdById: 'owner-b',
      },
      null,
    ],
  };
}

function expectedTask61PartialCreatorState(): SavedPlanPublicState {
  const target = expectedTask61Touch(
    'touch-target',
    'project-a',
    'Touch target',
    'Corrupt display',
    'owner-a',
    401,
    1,
    'target',
    6,
    'hash-target',
  );
  return {
    reads: [target, null, null, null, null],
    lists: [[target.header], []],
    principals: [
      {
        savedPlanId: 'touch-target',
        projectId: 'project-a',
        projectOwnerId: 'owner-a',
        createdById: 'owner-a',
      },
      null,
      null,
      null,
      null,
    ],
  };
}

function expectedTask61CollateralState(): SavedPlanPublicState {
  const target = expectedTask61Touch(
    'touch-target',
    'project-a',
    'Renamed target',
    'External author',
    'owner-b',
    401,
    1,
    'target',
    6,
    'hash-target',
  );
  const nullable = expectedTask61Touch(
    'touch-null-creator',
    'project-a',
    'Null creator',
    'Deleted account display',
    null,
    402,
    2,
    'nullable',
    8,
    'hash-nullable',
  );
  const other = expectedTask61Touch(
    'touch-other-project',
    'project-b',
    'Other project sentinel',
    'Owner A cross-project',
    'owner-a',
    404,
    4,
    'sentinel',
    8,
    'hash-sentinel',
  );
  return {
    reads: [target, nullable, null, other, null],
    lists: [[nullable.header, target.header], [other.header]],
    principals: [
      {
        savedPlanId: 'touch-target',
        projectId: 'project-a',
        projectOwnerId: 'owner-a',
        createdById: 'owner-b',
      },
      {
        savedPlanId: 'touch-null-creator',
        projectId: 'project-a',
        projectOwnerId: 'owner-a',
        createdById: null,
      },
      null,
      {
        savedPlanId: 'touch-other-project',
        projectId: 'project-b',
        projectOwnerId: 'owner-b',
        createdById: 'owner-a',
      },
      null,
    ],
  };
}

function rejectSavedPlanBeforeWrite(
  source: SqliteSource,
  probe: SavedPlanPhaseProbe,
): SqliteSource {
  return withSavedPlans(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    replaceSavedPlanWrite(
      source.history.savedPlans,
      (write) =>
        async <Refusal>(
          plan: SavedPlanWrite,
          check: SavedPlanCheck<Refusal>,
        ): Promise<SavedPlanWriteOutcome<Refusal>> => {
          if (plan.id !== 'saved-present') return write(plan, check);
          probe.attempts += 1;
          probe.state = await readSavedPlanPublicState(source, ['saved-present', 'saved-absent']);
          throw new Error('injected saved-plan write failure before persisted state');
        },
    ),
  );
}

function weakenSavedPlanWrite(
  source: SqliteSource,
  probe: SavedPlanPhaseProbe,
  mode: 'bodies' | 'creator-display',
): SqliteSource {
  const owned = {
    ...source,
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
  return withSavedPlans(
    owned,
    replaceSavedPlanWrite(
      source.history.savedPlans,
      (write) =>
        async <Refusal>(plan: SavedPlanWrite, check: SavedPlanCheck<Refusal>) => {
          const outcome = await write(
            mode === 'creator-display' && plan.id === 'touch-target'
              ? { ...plan, createdBy: 'Corrupt display' }
              : plan,
            check,
          );
          if (
            outcome.outcome === 'written' &&
            ((mode === 'bodies' && plan.id === 'saved-present') ||
              (mode === 'creator-display' && plan.id === 'touch-target'))
          ) {
            probe.attempts += 1;
            if (mode === 'bodies')
              await runTask61Mutation(
                source,
                "DELETE FROM saved_plan_body WHERE saved_plan_id = 'saved-present'",
                2,
              );
            probe.state = await readSavedPlanPublicState(
              source,
              mode === 'bodies' ? ['saved-present', 'saved-absent'] : TASK61_TOUCH_IDS,
            );
          }
          return outcome;
        },
    ),
  );
}

function collateralSavedPlanTouch(
  source: SqliteSource,
  probe: SavedPlanPhaseProbe,
  method: 'renameTo' | 'deleteOf',
): SqliteSource {
  const owned = {
    ...source,
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
  const savedPlans =
    method === 'renameTo'
      ? replaceMethod(
          source.history.savedPlans,
          'renameTo',
          (renameTo) => async (savedPlanId, name) => {
            const outcome = await renameTo(savedPlanId, name);
            if (savedPlanId === 'missing-touch-plan') {
              probe.attempts += 1;
              expect(await source.history.savedPlans.deleteOf('touch-peer')).toBe('touched');
              probe.state = await readSavedPlanPublicState(source, TASK61_TOUCH_IDS);
            }
            return outcome;
          },
        )
      : replaceMethod(source.history.savedPlans, 'deleteOf', (deleteOf) => async (savedPlanId) => {
          const outcome = await deleteOf(savedPlanId);
          if (savedPlanId === 'missing-touch-plan') {
            probe.attempts += 1;
            expect(await source.history.savedPlans.deleteOf('touch-peer')).toBe('touched');
            probe.state = await readSavedPlanPublicState(source, TASK61_TOUCH_IDS);
          }
          return outcome;
        });
  return withSavedPlans(owned, savedPlans);
}

interface FaultContext {
  readonly registration: ReturnType<typeof existingStoreRegistrations>[number];
  assertionFailure: string | null;
  report: Awaited<ReturnType<typeof runCases>> | null;
}

interface SubtreePrewriteProbe {
  closeCalls: number;
  attempts: number;
  state: Awaited<ReturnType<typeof readSubtreePublicState>>[] | null;
}

interface SubtreeIncompleteProbe {
  closeCalls: number;
  attempts: number;
  state: Awaited<ReturnType<typeof readSubtreePublicState>> | null;
}

function rejectJournalBeforeAppend(
  source: SqliteSource,
  probe: {
    attempts: number;
    closeCalls: number;
    entries: JournalEntry[][] | null;
    history: PlanEvent[][] | null;
  },
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          if (entry.id !== 'atomic-late-target') return append(entry, event);
          probe.attempts += 1;
          probe.entries = await Promise.all([
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[0],
              DETERMINISTIC_SEED.ownerIds[0],
            ),
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[0],
              DETERMINISTIC_SEED.ownerIds[1],
            ),
            source.stores.journal.entriesFor(
              DETERMINISTIC_SEED.projectIds[1],
              DETERMINISTIC_SEED.ownerIds[1],
            ),
          ]);
          probe.history = await Promise.all(
            DETERMINISTIC_SEED.projectIds.map((projectId) =>
              source.stores.planEvents.listFor(projectId, {}),
            ),
          );
          throw new Error('injected journal-history-insert failure before target append');
        };
      }),
    },
  );
}

function skipActorBRedo(
  source: SqliteSource,
  probe: { attempts: number; closeCalls: number },
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'flip', (flip) => {
        return async (id, undone, preconditions) => {
          if (id !== 'redo-b') return flip(id, undone, preconditions);
          probe.attempts += 1;
        };
      }),
    },
  );
}

function omitCopiedProgress(source: SqliteSource, probe: SubtreeIncompleteProbe): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', (insertSubtree) => {
        return async (copy, stamp) => {
          probe.attempts += 1;
          await insertSubtree({ ...copy, progress: [] }, stamp);
          probe.state = await readSubtreePublicState(
            readersOf(source),
            DETERMINISTIC_SEED.projectIds[0],
          );
        };
      }),
    },
  );
}

function rejectSubtreeBeforeWrite(
  source: SqliteSource,
  probe: SubtreePrewriteProbe,
  message: string,
): SqliteSource {
  const reject = async (_copy: SubtreeCopy, _stamp: WriteStamp): Promise<void> => {
    probe.attempts += 1;
    probe.state = await Promise.all(
      DETERMINISTIC_SEED.projectIds.map((projectId) =>
        readSubtreePublicState(readersOf(source), projectId),
      ),
    );
    throw new Error(message);
  };
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', () => reject),
    },
  );
}

function observeSubtreeWrites(
  source: SqliteSource,
  probe: { attempts: number; closeCalls: number },
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      subtrees: replaceMethod(source.stores.subtrees, 'insertSubtree', (insertSubtree) => {
        return (copy, stamp) => {
          probe.attempts += 1;
          return insertSubtree(copy, stamp);
        };
      }),
    },
  );
}

async function proveFault(
  fault: Fault<SqliteSource>,
  openBase: OpenSource = openSqliteSource,
  decorate: (source: SqliteSource) => SqliteSource = (source) => source,
  prepare: (source: SqliteSource) => Promise<void> = () => Promise.resolve(),
  observeDirectory: (directory: string) => void = () => undefined,
  observeLateBoundary: (stored: StoredSavedPlan | undefined) => void = () => undefined,
): Promise<FaultProof> {
  return recordFaultProof(fault, {
    assertion: `${fault.caseId} reports passed`,
    async setup(run: FaultRun<SqliteSource>) {
      const lateControl =
        fault.caseId === 'subtrees.insertSubtree:late-failure'
          ? sqliteLateWriteControl('subtree-final-satellite')
          : fault.caseId === 'journal.append:history-atomic' &&
              run.control.phase !== 'journal.append:history-atomic:outside-transaction'
            ? sqliteLateWriteControl('journal-history-insert')
            : fault.caseId === 'savedPlans.write:late-body-failure'
              ? sqliteLateWriteControl('saved-plan-schedule-body')
              : null;
      const selectedBase: OpenSource =
        lateControl === null
          ? openBase
          : lateControl.phase === 'subtree-final-satellite'
            ? (options) =>
                openSqliteSourceWithNonAtomicSubtreeFault(options, lateControl, () => {
                  run.control.reach(run.control.phase);
                })
            : lateControl.phase === 'saved-plan-schedule-body' &&
                run.control.phase === 'saved-plan:late-body:missing-input'
              ? (options) =>
                  openSqliteSourceWithMissingSavedPlanInput(
                    options,
                    lateControl,
                    () => {
                      run.control.reach(run.control.phase);
                    },
                    (stored) => {
                      sqliteMissingInputProbe.boundary = stored;
                    },
                  )
              : lateControl.phase === 'saved-plan-schedule-body' &&
                  (run.control.phase === 'saved-plan:late-body:split-transaction' ||
                    run.control.phase === 'saved-plan:late-body:no-reach')
                ? (options) =>
                    openSqliteSourceWithNonAtomicSavedPlanFault(
                      options,
                      lateControl,
                      () => {
                        if (run.control.phase !== 'saved-plan:late-body:no-reach')
                          run.control.reach(run.control.phase);
                      },
                      undefined,
                      observeLateBoundary,
                    )
                : (options) =>
                    openSqliteSourceWithFault(options, lateControl, () => {
                      run.control.reach(run.control.phase);
                    });
      const openSource = brokenSource(
        (options: OpenSqliteSourceOptions) => decorate(selectedBase(options)),
        run,
      );
      const { source, directory } = await seedSqliteSource(
        openSource,
        fault.caseId.startsWith('progress.')
          ? seedProgressStep
          : fault.caseId.startsWith('dependencies.')
            ? seedDependencyWorkItems
            : fault.caseId.startsWith('subtrees.')
              ? seedSubtreeRecords
              : fault.caseId.startsWith('savedPlanCapture.')
                ? async (seeded) => seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED)
                : undefined,
      );
      observeDirectory(directory);
      try {
        await prepare(source);
      } catch (failure) {
        return throwAfterCleanup(failure, source, directory);
      }
      let wasOpened = false;
      const takeFixture = <Family extends ExistingFamily>(
        family: Family,
        caseId: CaseId,
      ): Promise<CaseFixture<TransactionalStores[Family]>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        if (family === 'journal')
          return Promise.resolve({
            ...sqliteFixture(source, directory, family, caseId),
            scenario: {
              kind: 'late-write',
              point: 'journal-history-insert',
              arm:
                lateControl?.phase === 'journal-history-insert'
                  ? () => {
                      lateControl.arm();
                    }
                  : () => undefined,
              reached:
                lateControl?.phase === 'journal-history-insert'
                  ? () => lateControl.reached()
                  : () => run.control.reached(),
              evidence: () => lateControl?.observedSavedPlan() ?? {},
            },
          });
        if (family !== 'subtrees')
          return Promise.resolve(sqliteFixture(source, directory, family, caseId));
        return Promise.resolve({
          ...sqliteFixture(source, directory, family, caseId),
          scenario:
            lateControl === null
              ? { kind: 'ordinary' }
              : {
                  kind: 'late-write',
                  point: 'subtree-final-satellite',
                  arm: () => {
                    lateControl.arm();
                  },
                  reached: () => lateControl.reached(),
                  evidence: () => lateControl.observedSavedPlan(),
                },
        });
      };
      const takeSavedPlanFixture = (caseId: CaseId): Promise<CaseFixture<SavedPlanStore>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        return Promise.resolve({
          fixtureId: `sqlite:${caseId}`,
          port: source.history.savedPlans,
          journalAppender: source.stores.journal,
          seed: DETERMINISTIC_SEED,
          readers: readersOf(source),
          scenario:
            caseId === 'savedPlans.write:quota-window'
              ? {
                  kind: 'competing-history-write',
                  rivalWriter: replaceSavedPlanWrite(source.history.savedPlans, (write) => {
                    return (plan, check) => {
                      const settlement = write(plan, check);
                      const task62Source: Task62SqliteSource = source;
                      if (task62Source.quotaRivalOwner !== undefined)
                        task62Source.quotaRivalOwner.settlement = settlement;
                      return settlement;
                    };
                  }),
                  expectedRival: 'snapshot_busy',
                }
              : caseId === 'savedPlans.write:late-body-failure' && lateControl !== null
                ? {
                    kind: 'late-write',
                    point: 'saved-plan-schedule-body',
                    arm: () => {
                      lateControl.arm();
                    },
                    reached: () => lateControl.reached(),
                    evidence: () => lateControl.observedSavedPlan(),
                  }
                : { kind: 'ordinary' },
          close: () => closeSqliteResources(source, directory),
        });
      };
      const takeSavedPlanCaptureFixture = (
        caseId: CaseId,
      ): Promise<CaseFixture<SavedPlanCaptureStore>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        return Promise.resolve({
          fixtureId: `sqlite:${caseId}`,
          port: source.history.savedPlanCapture,
          journalAppender: source.stores.journal,
          seed: DETERMINISTIC_SEED,
          readers: readersOf(source),
          scenario: { kind: 'ordinary' },
          close: () => closeSqliteResources(source, directory),
        });
      };
      const registrations = existingStoreRegistrations({
        projects: (caseId) => takeFixture('projects', caseId),
        users: (caseId) => takeFixture('users', caseId),
        capacity: (caseId) => takeFixture('capacity', caseId),
        priorityBands: (caseId) => takeFixture('priorityBands', caseId),
        calendarMarkers: (caseId) => takeFixture('calendarMarkers', caseId),
        workItems: (caseId) => takeFixture('workItems', caseId),
        steps: (caseId) => takeFixture('steps', caseId),
        estimates: (caseId) => takeFixture('estimates', caseId),
        actuals: (caseId) => takeFixture('actuals', caseId),
        measures: (caseId) => takeFixture('measures', caseId),
        progress: (caseId) => takeFixture('progress', caseId),
        dependencies: (caseId) => takeFixture('dependencies', caseId),
        directory: (caseId) => takeFixture('directory', caseId),
        eventLog: (caseId) => takeFixture('eventLog', caseId),
        planEvents: (caseId) => takeFixture('planEvents', caseId),
        subtrees: (caseId) => takeFixture('subtrees', caseId),
        journal: (caseId) => takeFixture('journal', caseId),
        savedPlans: takeSavedPlanFixture,
        savedPlanCapture: takeSavedPlanCaptureFixture,
      });
      const registration = registrations.find(({ caseId }) => caseId === fault.caseId);
      if (registration === undefined) {
        return throwAfterCleanup(
          new Error(`missing existing registration for ${fault.caseId}`),
          source,
          directory,
        );
      }
      return { registration, assertionFailure: null, report: null };
    },
    async exercise(context: FaultContext) {
      context.report = await runCases([context.registration], {
        focus: [fault.caseId],
      });
      const execution = context.report.cases[0];
      if (execution.status === 'failed' && execution.assertionPhase !== 'assertion') {
        throw new Error(execution.failure);
      }
      if (execution.status !== 'failed' && execution.status !== 'passed') {
        throw new Error(`${fault.caseId} finished ${execution.status} without an assertion`);
      }
      context.assertionFailure = execution.status === 'failed' ? execution.failure : null;
    },
    assert(context: FaultContext) {
      if (context.assertionFailure !== null) throw new Error(context.assertionFailure);
      expect(context.report?.cases[0]?.status).toBe('passed');
      return Promise.resolve();
    },
  });
}

async function proveCoherentCaptureFault(
  fault: Fault<SqliteSource>,
  decorate: (source: SqliteSource) => SqliteSource = (source) => source,
  observeDirectory: (directory: string) => void = () => undefined,
  changeDirectory: (
    source: SqliteSource,
  ) => Promise<CaptureDirectoryChange> = changeSqliteCaptureDirectory,
): Promise<FaultProof> {
  return recordFaultProof(fault, {
    assertion: `${fault.caseId} reports passed`,
    async setup(run) {
      let enter: () => void = () => undefined;
      let release: () => void = () => undefined;
      let didEnter = false;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { source, directory } = await seedSqliteSource(
        brokenSource(
          (options) =>
            decorate(
              openSqliteSourceWithCaptureReadSeam(options, {
                async afterFirstRead({ projectId, project }) {
                  if (projectId !== 'project-a' || didEnter) return;
                  if (project.id !== projectId || project.name !== 'Captured project A')
                    throw new Error('coherent SQLite barrier received wrong first-read evidence');
                  didEnter = true;
                  enter();
                  await released;
                },
              }),
            ),
          run,
        ),
        async (seeded) => seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED),
      );
      observeDirectory(directory);
      let wasOpened = false;
      const registrations = existingStoreRegistrations({
        ...openers,
        savedPlanCapture: (caseId) => {
          if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
          wasOpened = true;
          return Promise.resolve({
            fixtureId: `sqlite:${caseId}`,
            port: source.history.savedPlanCapture,
            journalAppender: source.stores.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: {
              kind: 'capture-interleave',
              firstRead: { entered, release },
              changeDirectory: () => changeDirectory(source),
            },
            close: async () => {
              release();
              await closeSqliteResources(source, directory);
            },
          });
        },
      });
      const registration = registrations.find(({ caseId }) => caseId === fault.caseId);
      if (registration === undefined) throw new Error(`missing registration for ${fault.caseId}`);
      return { registration, assertionFailure: null, report: null };
    },
    async exercise(context: FaultContext) {
      context.report = await runCases([context.registration], { focus: [fault.caseId] });
      const execution = context.report.cases[0];
      if (execution.status === 'failed' && execution.assertionPhase !== 'assertion')
        throw new Error(execution.failure);
      context.assertionFailure = execution.status === 'failed' ? execution.failure : null;
    },
    assert(context: FaultContext) {
      if (context.assertionFailure !== null) throw new Error(context.assertionFailure);
      expect(context.report?.cases[0]?.status).toBe('passed');
      return Promise.resolve();
    },
  });
}

interface DirectoryPrewriteProbe {
  attempts: number;
  closeCalls: number;
  teams: TeamWithServices[] | null;
}

function openDirectoryPrewriteFailureSource(
  options: OpenSqliteSourceOptions,
  probe: DirectoryPrewriteProbe,
): SqliteSource {
  const source = openSqliteSource(options);
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      directory: replaceMethod(source.stores.directory, 'patchTeam', (patchTeam) => {
        return async (teamId, patch, stamp) => {
          if (patch.name === 'Directory escaped' && patch.serviceIds === undefined) {
            probe.attempts += 1;
            probe.teams = (await source.stores.directory.listTeams())
              .map((team) => ({ ...team, serviceIds: team.serviceIds.toSorted() }))
              .toSorted((left, right) => left.id.localeCompare(right.id));
            throw new Error('injected failure before early directory rename');
          }
          return patchTeam(teamId, patch, stamp);
        };
      }),
    },
  );
}

interface Task52FlipWindowProbe {
  attempts: number;
  closeCalls: number;
  state: Awaited<ReturnType<typeof readTask52FlipState>> | null;
}

function omitTask52Flip(source: SqliteSource, probe: Task52FlipWindowProbe): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'flip', (flip) => {
        return async (id, undone, preconditions) => {
          if (id !== 'flip-target') return flip(id, undone, preconditions);
          probe.attempts += 1;
          probe.state = await readTask52FlipState(source);
        };
      }),
    },
  );
}

interface Task52PruneWindowProbe {
  attempts: number;
  closeCalls: number;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function omitTask52Prune(source: SqliteSource, probe: Task52PruneWindowProbe): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      planEvents: replaceMethod(source.stores.planEvents, 'pruneOlderThan', () => async () => {
        probe.attempts += 1;
        probe.state = await readTask52HistoryState(source);
        return 0;
      }),
    },
  );
}

interface Task52HistorySetupProbe {
  attempts: number;
  closeCalls: number;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function suppressTask52ProjectBAppends(
  source: SqliteSource,
  probe: Task52HistorySetupProbe,
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          if (entry.projectId !== 'project-b') return append(entry, event);
          probe.attempts += 1;
          if (entry.id === 'journal-b-101-wide') {
            probe.state = await readTask52HistoryState(source);
          }
        };
      }),
    },
  );
}

function discardTask52JournalsAfterAppend(
  source: SqliteSource,
  probe: Task52HistorySetupProbe,
): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'append', (append) => {
        return async (entry, event) => {
          await append(entry, event);
          if (entry.id !== 'journal-b-101-wide') return;
          probe.attempts += 1;
          for (const journalId of [
            'journal-a-99',
            'journal-a-100-z',
            'journal-a-100-a',
            'journal-a-100-m',
            'journal-a-101-wide',
            'journal-b-99',
            'journal-b-100',
            'journal-b-101-wide',
          ]) {
            await source.stores.journal.discard(journalId);
          }
          probe.state = await readTask52HistoryState(source);
        };
      }),
    },
  );
}

function omitTask52RestampEffect(source: SqliteSource, probe: Task52FlipWindowProbe): SqliteSource {
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      journal: replaceMethod(source.stores.journal, 'flip', (flip) => {
        return async (id, undone, preconditions) => {
          if (id !== 'flip-target' || undone) return flip(id, undone, preconditions);
          probe.attempts += 1;
          probe.state = await readTask52FlipState(source);
        };
      }),
    },
  );
}

interface Task52ListWindowProbe {
  attempts: number;
  closeCalls: number;
  returned: PlanEvent[] | null;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function partiallyFilterTask52LeakedRead(
  source: SqliteSource,
  probe: Task52ListWindowProbe,
): SqliteSource {
  let projectAFullReads = 0;
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    },
    {
      planEvents: replaceMethod(source.stores.planEvents, 'listFor', (listFor) => {
        return async (projectId, filter) => {
          if (
            projectId !== 'project-a' ||
            filter.workItemId !== undefined ||
            filter.kinds !== undefined
          ) {
            return listFor(projectId, filter);
          }
          projectAFullReads += 1;
          if (projectAFullReads !== 3) return listFor(projectId, filter);
          probe.attempts += 1;
          probe.returned = await listFor(projectId, { kinds: ['estimate', 'freeze'] });
          probe.state = await readTask52HistoryState(source);
          return probe.returned;
        };
      }),
    },
  );
}

const namedFaultVariants = [
  savedPlanUtf8LengthFault,
  savedPlanHeaderOnlyFault,
  savedPlanAlteredBodyFault,
  savedPlanAlteredHashFault,
  savedPlanAffectedRowFault({ attempts: 0, closeCalls: 0, changes: null, state: null }),
  savedPlanPrincipalFault,
  savedPlanUnknownRenameFault,
  savedPlanUnknownDeleteFault,
  addFault,
  seedFailureFault,
  cleanupFailureFault,
  priorityFirstRungFault,
  priorityProjectScopeFault,
  markerProjectScopeFault,
  markerLiteralDateFault,
  frozenAcquireFault,
  frozenClearFault,
  actualRemovePairFault,
  actualRemoveFirstCallFault,
  measureSetPairIdentityFault,
  measureSetRecordedAtFault,
  measureMoveOneMetricFault,
  measureMoveRecordedAtFault,
  dependencyIdFault,
  dependencyInputMutationFault,
  directoryAssignmentsOfSubsetFault,
  directoryAssignmentScopeFault,
  dependencyOutgoingOnlyFault,
  dependencyIncompleteSetFault,
  journalRetainedPreconditionsFault,
  journalRestampFlipsFault,
  journalIndependentHistoryFault,
  journalLateOutsideFault,
  journalCollateralActorFault,
  journalReplacementCorruptionFault,
  journalBroadRedoFault,
  journalHistoryPruneFault,
  subtreeDependencyBackingFault,
  subtreeRemovedMeasureFault,
  savedPlanPersistedRefusalFault,
  savedPlanStaleQuotaFault,
  savedPlanSplitWriteFault,
  savedPlanMissingInputFault,
  savedPlanRefusalNoMutationFault,
  savedPlanWindowNoMutationFault,
  savedPlanLateNoMutationFault,
  savedPlanRefusalPrematureFault,
  savedPlanWindowPrematureFault,
  savedPlanLatePrematureFault,
  savedPlanRefusalNoReachFault,
  savedPlanWindowNoReachFault,
  savedPlanLateNoReachFault,
] as const;

describe('SQLite existing source conformance', () => {
  it('registers every named sqlite mutation exactly once', () => {
    // Proof: duplicating the first real fault throws a coverage mismatch even
    // though every shared conformance case remains registered.
    expect(() => {
      assertFaultVariantCoverage('sqlite', [namedFaultVariants[0], ...namedFaultVariants]);
    }).toThrow('sqlite fault variant coverage mismatch');
    assertFaultVariantCoverage('sqlite', namedFaultVariants);
  });

  it('runs every Task 5.2 journal and plan-event case through the real SQLite source', async () => {
    const caseIds = [
      'planEvents.listFor:filters-order',
      'planEvents.pruneOlderThan:strict-cutoff',
      'journal.flip:preconditions',
    ] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });
    const failure = report.cases.find(({ status }) => status === 'failed');
    if (failure?.status === 'failed') throw new Error(failure.failure);
    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects retained flip preconditions, restamp direction, ignored item filters and inclusive pruning in SQLite', async () => {
    const proofs = await Promise.all([
      proveFault(journalRetainedPreconditionsFault),
      proveFault(journalRestampFlipsFault),
      proveFault(planEventsIgnoreItemFilterFault),
      proveFault(planEventsInclusivePruneFault),
    ]);
    // Proof: reversing each adapter fault at its production method produced
    // `Expected - 4 / Received + 4`, with four `assertion-passed` outcomes.
    expect(proofs.map(({ kind }) => kind)).toEqual([
      'observed',
      'observed',
      'observed',
      'observed',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain(`"work-a-one": 21`);
    expect(failures[0]).toContain(`"work-a-one": 11`);
    expect(failures[1]).toContain(`-         "undone": true`);
    expect(failures[1]).toContain(`+         "undone": false`);
    expect(failures[1]).toContain(`"redoable": true`);
    expect(failures[1]).toContain(`"redoable": false`);
    expect(failures[2]).toContain(`"history-a-101-wide"`);
    expect(failures[2]).toContain(`"history-a-100-a"`);
    expect(failures[3]).toContain(`"deletedCount": 2`);
    expect(failures[3]).toContain(`"deletedCount": 6`);
    expect(failures[3]).toContain(`"history-a-100-z"`);
    expect(failures[3]).toContain(`"history-a-100-m"`);
    expect(failures[3]).toContain(`"history-a-100-a"`);
    expect(failures[3]).toContain(`"history-b-100"`);
  });

  it('refuses Task 5.2 SQLite faults before complete public mutations', async () => {
    const flipProbe: Task52FlipWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const pruneProbe: Task52PruneWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const [flipProof, pruneProof] = await Promise.all([
      proveFault(journalRetainedPreconditionsFault, openSqliteSource, (source) =>
        omitTask52Flip(source, flipProbe),
      ),
      proveFault(planEventsInclusivePruneFault, openSqliteSource, (source) =>
        omitTask52Prune(source, pruneProbe),
      ),
    ]);
    // Proof: reaching either phase without its verified complete mutation changed
    // this list away from the two required `phase-failed` outcomes.
    expect([flipProof.kind, pruneProof.kind]).toEqual(['phase-failed', 'phase-failed']);
    expect(flipProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: {
        entries: [
          [
            task52JournalEntry('flip-target', false, 11, 10),
            task52JournalEntry('flip-peer', false, 12, 11),
          ],
          [task52JournalEntry('flip-other-project', false)],
        ],
        states: [
          { undoable: true, redoable: false },
          { undoable: true, redoable: false },
        ],
        history: task52FlipHistory(),
      },
    });
    expect(pruneProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: {
        projectAEvents: task52PlanEvents()[0],
        projectBEvents: task52PlanEvents()[1],
        journals: task52HistoryJournals(),
      },
    });
  });

  it('refuses incomplete Task 5.2 SQLite history setup before the item-filter fault reaches', async () => {
    const missingProjectProbe: Task52HistorySetupProbe = {
      attempts: 0,
      closeCalls: 0,
      state: null,
    };
    const missingJournalProbe: Task52HistorySetupProbe = {
      attempts: 0,
      closeCalls: 0,
      state: null,
    };
    const [missingProjectProof, missingJournalProof] = await Promise.all([
      proveFault(planEventsIgnoreItemFilterFault, openSqliteSource, (source) =>
        suppressTask52ProjectBAppends(source, missingProjectProbe),
      ),
      proveFault(planEventsIgnoreItemFilterFault, openSqliteSource, (source) =>
        discardTask52JournalsAfterAppend(source, missingJournalProbe),
      ),
    ]);
    // Proof: removing both complete setup guards changed these exact outcomes
    // from two `phase-failed` values to two `observed` values.
    expect([missingProjectProof.kind, missingJournalProof.kind]).toEqual([
      'phase-failed',
      'phase-failed',
    ]);
    expect(missingProjectProbe).toEqual({
      attempts: 3,
      closeCalls: 1,
      state: {
        projectAEvents: task52PlanEvents()[0],
        projectBEvents: [],
        journals: [task52HistoryJournals()[0], []],
      },
    });
    expect(missingJournalProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: {
        projectAEvents: task52PlanEvents()[0],
        projectBEvents: task52PlanEvents()[1],
        journals: [[], []],
      },
    });
  });

  it('refuses partial Task 5.2 SQLite restamp and filtered-read effects before fault reach', async () => {
    const restampProbe: Task52FlipWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const listProbe: Task52ListWindowProbe = {
      attempts: 0,
      closeCalls: 0,
      returned: null,
      state: null,
    };
    const [restampProof, listProof] = await Promise.all([
      proveFault(journalRestampFlipsFault, openSqliteSource, (source) =>
        omitTask52RestampEffect(source, restampProbe),
      ),
      proveFault(planEventsIgnoreItemFilterFault, openSqliteSource, (source) =>
        partiallyFilterTask52LeakedRead(source, listProbe),
      ),
    ]);
    // Proof: removing the restamp and list complete-effect guards changed both
    // outcomes from `phase-failed` to `observed`.
    expect([restampProof.kind, listProof.kind]).toEqual(['phase-failed', 'phase-failed']);
    expect(restampProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: {
        entries: [
          [
            task52JournalEntry('flip-target', true, 21, 11),
            task52JournalEntry('flip-peer', false, 12, 11),
          ],
          [task52JournalEntry('flip-other-project', false)],
        ],
        states: [
          { undoable: true, redoable: true },
          { undoable: true, redoable: false },
        ],
        history: task52FlipHistory(),
      },
    });
    expect(listProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      returned: [task52PlanEvents()[0][0], task52PlanEvents()[0][4]],
      state: {
        projectAEvents: task52PlanEvents()[0],
        projectBEvents: task52PlanEvents()[1],
        journals: task52HistoryJournals(),
      },
    });
  });

  it('runs every Task 5.1 journal case through the real SQLite source', async () => {
    const caseIds = ['journal.append:history-atomic', 'journal.append:account-redo-depth'] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });
    const failure = report.cases.find(({ status }) => status === 'failed');
    if (failure?.status === 'failed') throw new Error(failure.failure);
    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects independent history, broad redo clearing and history pruning in SQLite', async () => {
    const proofs = await Promise.all([
      proveFault(
        journalIndependentHistoryFault,
        openSqliteSource,
        (source) => source,
        prepareJournalIndependentHistory,
      ),
      proveFault(journalLateOutsideFault),
      proveFault(journalBroadRedoFault),
      proveFault(journalHistoryPruneFault),
    ]);
    // Proof: removing only the four production-path phase bridges changed this
    // exact list to four `phase-failed` outcomes (`Expected - 4 / Received + 4`).
    expect(proofs.map(({ kind }) => kind)).toEqual([
      'observed',
      'observed',
      'observed',
      'observed',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: the independently routed target history leaves this complete event
    // absent from project A after its real journal entry commits.
    expect(failures[0]).toContain(`-       "createdAt": 201,
-       "id": "event-atomic-target",
-       "kind": "rename",
-       "label": "Rename atomic-target",
-       "projectId": "project-a",`);
    // Proof: throwing outside the transaction leaves this complete entry committed.
    expect(failures[1]).toContain(`+       "id": "atomic-late-target",
+       "inverse": {`);
    // Proof: clearing both actors' redo removes B's complete retained entry.
    expect(failures[2]).toContain(`-       "id": "redo-b",
-       "inverse": {`);
    // Proof: pruning history with the journal removes the complete oldest event.
    expect(failures[3]).toContain(`-     "id": "event-redo-a"`);
  });

  it('owns the first independent-history TEMP CREATE failure', async () => {
    let closeCalls = 0;
    let directory = '';
    let retainedSource: SqliteSource | undefined;
    const proof = await proveFault(
      journalIndependentHistoryFault,
      openSqliteSource,
      (source) => {
        retainedSource = source;
        return {
          ...source,
          async close() {
            closeCalls += 1;
            await source.close();
          },
        };
      },
      rejectJournalIndependentHistoryCreate,
      (openedDirectory) => {
        directory = openedDirectory;
      },
    );

    expect(proof.kind).toBe('setup-failed');
    if (proof.kind !== 'setup-failed') throw new Error('expected failed TEMP setup proof');
    expect(proof.failure).toContain(
      'Failed query: CREATE TEMP TABLE conformance_independent_journal_history AS SELECT * FROM conformance_missing_plan_event WHERE 0',
    );
    // Proof: moving this first CREATE back into fault mutation before fixture
    // ownership failed here with expected closeCalls 1 and received 0.
    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });
    const sourceAfterFailure = retainedSource;
    if (sourceAfterFailure === undefined) throw new Error('expected retained SQLite source probe');
    expect(() => sourceAfterFailure.db.all(sql`SELECT 42 AS stillOpen`)).toThrow();
  });

  it('preserves first independent-history TEMP CREATE and cleanup failures', async () => {
    let closeCalls = 0;
    let directory = '';
    const proof = await proveFault(
      journalIndependentHistoryFault,
      openSqliteSource,
      (source) => ({
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
          throw new Error('injected independent-history setup cleanup failure');
        },
      }),
      rejectJournalIndependentHistoryCreate,
      (openedDirectory) => {
        directory = openedDirectory;
      },
    );

    expect(proof.kind).toBe('setup-failed');
    if (proof.kind !== 'setup-failed') throw new Error('expected combined TEMP setup failure');
    expect(proof.failure).toContain(
      'Failed query: CREATE TEMP TABLE conformance_independent_journal_history AS SELECT * FROM conformance_missing_plan_event WHERE 0',
    );
    // Proof: running this first CREATE in fault mutation before fixture ownership
    // omitted the injected cleanup failure because close was never called.
    expect(proof.failure).toContain('injected independent-history setup cleanup failure');
    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });
  });

  it('leaves successful independent-history TEMP setup to one teardown close', async () => {
    const probe = { closeCalls: 0, closeCallsDuringPrepare: -1 };
    const proof = await proveFault(
      journalIndependentHistoryFault,
      openSqliteSource,
      (source) => ({
        ...source,
        async close() {
          probe.closeCalls += 1;
          await source.close();
        },
      }),
      async (source) => {
        await prepareJournalIndependentHistory(source);
        probe.closeCallsDuringPrepare = probe.closeCalls;
      },
    );

    expect(proof.kind).toBe('observed');
    // Proof: closing successful setup early changed the proof to `phase-failed`
    // and produced one close during prepare and two total closes.
    expect(probe).toEqual({ closeCalls: 1, closeCallsDuringPrepare: 0 });
  });

  it('refuses to certify a pre-write SQLite journal failure', async () => {
    const probe: JournalIncompleteProbe = {
      attempts: 0,
      closeCalls: 0,
      entries: null,
      history: null,
    };
    const proof = await proveFault(journalLateOutsideFault, openSqliteSource, (source) =>
      rejectJournalBeforeAppend(source, probe),
    );
    // Proof: reaching before the real target append changed this to observed.
    expect(proof.kind).toBe('phase-failed');
    const [projectA, projectB] = DETERMINISTIC_SEED.projectIds;
    const [actorA, actorB] = DETERMINISTIC_SEED.ownerIds;
    expect(probe).toEqual({
      attempts: 1,
      closeCalls: 1,
      entries: [
        [
          expectedAtomicEntry('atomic-sentinel-a', projectA, actorA, 1, 101),
          expectedAtomicEntry('atomic-target', projectA, actorA, 2, 201),
        ],
        [expectedAtomicEntry('atomic-sentinel-b', projectA, actorB, 1, 102)],
        [expectedAtomicEntry('atomic-other-project', projectB, actorB, 1, 103)],
      ],
      history: [
        [
          expectedAtomicEvent('atomic-target', projectA, actorA, 201),
          expectedAtomicEvent('atomic-sentinel-b', projectA, actorB, 102),
          expectedAtomicEvent('atomic-sentinel-a', projectA, actorA, 101),
        ],
        [expectedAtomicEvent('atomic-other-project', projectB, actorB, 103)],
      ],
    });
  });

  it('refuses to observe a reached SQLite late write with incomplete public history', async () => {
    const probe: JournalIncompleteProbe = {
      attempts: 0,
      closeCalls: 0,
      entries: null,
      history: null,
    };
    const proof = await proveFault(journalLateOutsideFault, openSqliteSource, (source) =>
      commitJournalWithoutLateHistory(source, probe),
    );
    const [projectA, projectB] = DETERMINISTIC_SEED.projectIds;
    const [actorA, actorB] = DETERMINISTIC_SEED.ownerIds;
    // Proof: removing only the outside-transaction complete history prerequisite
    // changed this result to `observed` after the incomplete source committed its rows.
    expect(proof.kind).toBe('phase-failed');
    expect(probe).toEqual({
      attempts: 1,
      closeCalls: 1,
      entries: [
        [
          expectedAtomicEntry('atomic-sentinel-a', projectA, actorA, 1, 101),
          expectedAtomicEntry('atomic-target', projectA, actorA, 2, 201),
          expectedAtomicEntry('atomic-late-target', projectA, actorA, 3, 202),
        ],
        [expectedAtomicEntry('atomic-sentinel-b', projectA, actorB, 1, 102)],
        [expectedAtomicEntry('atomic-other-project', projectB, actorB, 1, 103)],
      ],
      history: [
        [
          expectedAtomicEvent('atomic-target', projectA, actorA, 201),
          expectedAtomicEvent('atomic-sentinel-b', projectA, actorB, 102),
          expectedAtomicEvent('atomic-sentinel-a', projectA, actorA, 101),
        ],
        [expectedAtomicEvent('atomic-other-project', projectB, actorB, 103)],
      ],
    });
  });

  it('detects collateral actor deletion, replacement corruption and missing redo setup', async () => {
    const collateral = await proveFault(journalCollateralActorFault);
    const replacement = await proveFault(journalReplacementCorruptionFault);
    const probe = { attempts: 0, closeCalls: 0 };
    const missingRedo = await proveFault(journalBroadRedoFault, openSqliteSource, (source) =>
      skipActorBRedo(source, probe),
    );
    expect([collateral.kind, replacement.kind, missingRedo.kind]).toEqual([
      'observed',
      'observed',
      'phase-failed',
    ]);
    expect(probe).toEqual({ attempts: 1, closeCalls: 1 });
    expect(
      collateral.kind === 'observed' ? Bun.stripANSI(collateral.observedFailure) : '',
    ).toContain(`-       "id": "atomic-sentinel-b",`);
    expect(
      replacement.kind === 'observed' ? Bun.stripANSI(replacement.observedFailure) : '',
    ).toContain(`+         "broken": "replacement inverse",`);
  });

  it('runs every subtree case through the real SQLite source', async () => {
    const caseIds = [
      'subtrees.insertSubtree:complete-copy',
      'subtrees.insertSubtree:late-failure',
    ] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });
    const failure = report.cases.find(({ status }) => status === 'failed');
    if (failure?.status === 'failed') throw new Error(failure.failure);
    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects complete-copy dependency and metric-key faults through SQLite state', async () => {
    const proofs = await Promise.all([
      proveFault(subtreeDependencyBackingFault),
      proveFault(subtreeRemovedMeasureFault),
    ]);
    // Proof: independently disabling isolation changed the first proof to
    // `assertion-passed`; disabling pair-wide deletion changed the second.
    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed']);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: isolated persistence reaches only after exact prerequisite state,
    // then fails on this signed complete public edge.
    expect(failures[0]).toContain(`-       "id": "subtree-copy-dependency",
-       "predecessorId": "subtree-copy-root",
-       "projectId": "project-a",
-       "successorId": "subtree-copy-child",
-     },
-     {`);
    // Proof: pair-wide deletion reaches only after exact corrupted state, then
    // loses this signed complete unrequested triple-key survivor.
    expect(failures[1]).toContain(`-     {
-       "metric": "token_actual",
-       "recordedAt": 132,
-       "stepId": "step-a-dev",
-       "value": 102,
-       "workItemId": "work-a-two",
-     },`);
  });

  it('classifies subtree pre-write failures before their real SQLite proof phases', async () => {
    const dependencyProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const measureProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const rollbackProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const [dependency, measure, rollback] = await Promise.all([
      proveFault(subtreeDependencyBackingFault, openSqliteSource, (source) =>
        rejectSubtreeBeforeWrite(
          source,
          dependencyProbe,
          'subtree-copy-dependency pre-write rejection',
        ),
      ),
      proveFault(subtreeRemovedMeasureFault, openSqliteSource, (source) =>
        rejectSubtreeBeforeWrite(
          source,
          measureProbe,
          'token_actual value 102 recordedAt 132 pre-write rejection',
        ),
      ),
      proveFault(subtreeRollbackFault, openSqliteSource, (source) =>
        rejectSubtreeBeforeWrite(
          source,
          rollbackProbe,
          'subtree-copy-root subtree-final-satellite pre-write rejection',
        ),
      ),
    ]);

    // Proof: reaching in the outer decorators classified both ID-bearing
    // pre-write errors as observed shared failures instead of phase failures.
    expect([dependency.kind, measure.kind, rollback.kind]).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    expect([dependencyProbe.attempts, measureProbe.attempts, rollbackProbe.attempts]).toEqual([
      1, 1, 1,
    ]);
    expect([dependencyProbe.closeCalls, measureProbe.closeCalls, rollbackProbe.closeCalls]).toEqual(
      [1, 1, 1],
    );
    for (const probe of [dependencyProbe, measureProbe, rollbackProbe]) {
      if (probe.state === null) throw new Error('subtree pre-write state was not captured');
      assertSeedState(probe.state[0], DETERMINISTIC_SEED, 0);
      assertSeedState(probe.state[1], DETERMINISTIC_SEED, 1);
    }
    if (!('phase' in dependency) || !('phase' in measure) || !('phase' in rollback))
      throw new Error('subtree pre-write proof did not report a phase');
    expect([dependency.phase, measure.phase, rollback.phase]).toEqual([
      'subtrees.insertSubtree:complete-copy:dependencies',
      'subtrees.insertSubtree:complete-copy:removed-measure',
      'subtrees.insertSubtree:late-failure:no-transaction',
    ]);
  });

  it('refuses successful incomplete complete-copy prerequisites in SQLite', async () => {
    const dependencyProbe: SubtreeIncompleteProbe = { attempts: 0, closeCalls: 0, state: null };
    const measureProbe: SubtreeIncompleteProbe = { attempts: 0, closeCalls: 0, state: null };
    const [dependency, measure] = await Promise.all([
      proveFault(subtreeDependencyBackingFault, openSqliteSource, (source) =>
        omitCopiedProgress(source, dependencyProbe),
      ),
      proveFault(subtreeRemovedMeasureFault, openSqliteSource, (source) =>
        omitCopiedProgress(source, measureProbe),
      ),
    ]);

    // Proof: deleting only the two owning assertCompleteStateAlternative calls
    // changed both real successful-incomplete runs from phase-failed to observed.
    expect([dependency.kind, measure.kind]).toEqual(['phase-failed', 'phase-failed']);
    if (dependency.kind !== 'phase-failed' || measure.kind !== 'phase-failed') {
      throw new Error('successful incomplete SQLite insert reached a proof phase');
    }
    expect([dependency.failure, measure.failure]).toEqual([
      'fault did not reach subtrees.insertSubtree:complete-copy:dependencies',
      'fault did not reach subtrees.insertSubtree:complete-copy:removed-measure',
    ]);
    expect([dependencyProbe.attempts, measureProbe.attempts]).toEqual([1, 1]);
    expect([dependencyProbe.closeCalls, measureProbe.closeCalls]).toEqual([1, 1]);
    if (dependencyProbe.state === null || measureProbe.state === null) {
      throw new Error('successful incomplete SQLite insertion was not publicly observed');
    }
    const missingProgress = ['subtree-copy-root\u0000step-a-dev'];
    assertCompleteStateAlternative(dependencyProbe.state, DETERMINISTIC_SEED, [
      {
        dependencyIds: ['subtree-copy-dependency'],
        progressKeys: missingProgress,
      },
    ]);
    assertCompleteStateAlternative(measureProbe.state, DETERMINISTIC_SEED, [
      {
        measureKeys: [
          'work-a-two\u0000step-a-dev\u0000token_actual',
          'work-a-two\u0000step-a-dev\u0000hours_actual',
          'work-a-one\u0000step-a-qa\u0000token_estimate',
        ],
        progressKeys: missingProgress,
      },
    ]);
  });

  it('refuses a SQLite late proof whose populated estimate prerequisite is missing', async () => {
    const probe = { attempts: 0, closeCalls: 0 };
    const proof = await proveFault(
      subtreeRollbackFault,
      openSqliteSource,
      (source) => observeSubtreeWrites(source, probe),
      async (source) => {
        for (const estimate of subtreeSeedRecords(DETERMINISTIC_SEED).estimates) {
          await source.stores.estimates.remove(
            estimate.workItemId,
            estimate.stepId,
            DETERMINISTIC_SEED.stamps[0],
          );
        }
      },
    );

    // Proof: snapshotting without assertSeedState returned observed;
    // the repaired case refuses the proof before any subtree write can reach.
    expect(proof.kind).toBe('phase-failed');
    if (proof.kind !== 'phase-failed') throw new Error(`expected phase failure, got ${proof.kind}`);
    expect(proof.failure).toBe(
      'fault did not reach subtrees.insertSubtree:late-failure:no-transaction',
    );
    expect(probe).toEqual({ attempts: 0, closeCalls: 1 });
  });

  it('reinjects a terminal subtree failure without the SQLite transaction', async () => {
    const proof = await proveFault(subtreeRollbackFault);
    // Proof: restoring the repository transaction returned `assertion-passed` here.
    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error(`expected observed proof, got ${proof.kind}`);
    // Proof: the actual final-write callback reaches this proof only after
    // earlier SQL writes, exposing this full signed public root record.
    expect(Bun.stripANSI(proof.observedFailure)).toContain(`+         "deadline": "2026-09-30",
+         "externalRefs": [],
+         "factEnd": null,
+         "factStart": null,
+         "frozenNumber": "030",
+         "id": "subtree-copy-root",
+         "maxParallel": 2,
+         "name": "Copied root",
+         "notes": "all fields travel",
+         "parentId": null,
+         "position": 20,
+         "priority": 2,
+         "projectId": "project-a",
+         "revision": 0,
+         "serviceId": "service-a",
+         "serviceIds": [],
+         "serviceTeamId": "team-a",
+         "startNoEarlierThan": "2026-09-15",
+         "startNoEarlierThanReason": "contract start",
+         "tagIds": [],
+         "teamIds": [
+           "team-a",
+           "team-b",
+         ],
+         "typeIds": [],`);
  });
  it('runs every work-item case through the real SQLite source', async () => {
    const caseIds = [
      'workItems.insert:respace',
      'workItems.patch:refusal-atomic',
      'workItems.move:parent-position',
      'workItems.remove:promotion',
      'workItems.setFrozenNumbers:clear',
    ] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });

    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('failed SQLite setup closes its source and removes its temporary directory', async () => {
    let closeCalls = 0;
    let directory = '';
    let setupFailure: unknown;
    try {
      await seedSqliteSource((options) => {
        directory = dirname(options.dbPath);
        const source = openSqliteSource(options);
        return {
          ...source,
          stores: {
            ...source.stores,
            users: replaceMethod(
              source.stores.users,
              'create',
              () => () => Promise.reject(new Error('injected seed failure')),
            ),
          },
          async close() {
            closeCalls += 1;
            await source.close();
          },
        };
      });
    } catch (failure) {
      setupFailure = failure;
    }

    expect(setupFailure).toBeInstanceOf(Error);
    expect((setupFailure as Error).message).toBe('injected seed failure');
    // Proof: before setup owned cleanup, the actual source was never closed and
    // its `wbs-sqlite-conformance-*` directory still existed (0 / true).
    expect(closeCalls).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });

  it('failed SQLite setup preserves its original and cleanup failures', async () => {
    let directory = '';
    let combinedFailure: unknown;
    try {
      await seedSqliteSource((options) => {
        directory = dirname(options.dbPath);
        const source = openSqliteSource(options);
        return {
          ...source,
          stores: {
            ...source.stores,
            users: replaceMethod(
              source.stores.users,
              'create',
              () => () => Promise.reject(new Error('injected original setup failure')),
            ),
          },
          async close() {
            await source.close();
            throw new Error('injected setup cleanup failure');
          },
        };
      });
    } catch (failure) {
      combinedFailure = failure;
    }

    // Proof: replacing the aggregate with the cleanup error alone failed on
    // `Expected: true · Received: false`, losing the original setup failure.
    expect(combinedFailure instanceof AggregateError).toBe(true);
    if (!(combinedFailure instanceof AggregateError)) {
      throw new Error('setup and cleanup failures were not aggregated');
    }
    expect(combinedFailure.errors).toEqual([
      expect.objectContaining({ message: 'injected original setup failure' }),
      expect.objectContaining({ message: 'injected setup cleanup failure' }),
    ]);
    expect(existsSync(directory)).toBe(false);
  });

  it('a progress-only case seed failure closes its source and removes its directory', async () => {
    let closeCalls = 0;
    let directory = '';
    let rawSource: SqliteSource | undefined;
    let setupFailure: unknown;
    try {
      await openSqliteCase('progress', 'progress.set:replace', (options) => {
        directory = dirname(options.dbPath);
        const source = openSqliteSource(options);
        rawSource = source;
        return withStores(
          {
            ...source,
            async close() {
              closeCalls += 1;
              await source.close();
            },
          },
          {
            steps: replaceMethod(
              source.stores.steps,
              'add',
              (add) => (step, stamp) =>
                step.id === PROGRESS_SENTINEL_STEP_ID
                  ? Promise.reject(new Error('injected progress case seed failure'))
                  : add(step, stamp),
            ),
          },
        );
      });
    } catch (failure) {
      setupFailure = failure;
    }

    try {
      expect(setupFailure).toBeInstanceOf(Error);
      expect((setupFailure as Error).message).toBe('injected progress case seed failure');
      // Proof: with the progress seed outside the setup owner, this failed with
      // expected `{ closeCalls: 1, directoryExists: false }` and received
      // `{ closeCalls: 0, directoryExists: true }`.
      expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
        closeCalls: 1,
        directoryExists: false,
      });
    } finally {
      if (existsSync(directory)) {
        await rawSource?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('a progress-only proof seed failure closes its source and removes its directory', async () => {
    let closeCalls = 0;
    let directory = '';
    let rawSource: SqliteSource | undefined;
    const proof = await proveFault(progressReplaceFault, (options) => {
      directory = dirname(options.dbPath);
      const source = openSqliteSource(options);
      rawSource = source;
      return withStores(
        {
          ...source,
          async close() {
            closeCalls += 1;
            await source.close();
          },
        },
        {
          steps: replaceMethod(
            source.stores.steps,
            'add',
            (add) => (step, stamp) =>
              step.id === PROGRESS_SENTINEL_STEP_ID
                ? Promise.reject(new Error('injected progress proof seed failure'))
                : add(step, stamp),
          ),
        },
      );
    });

    try {
      expect(proof).toEqual({
        kind: 'setup-failed',
        faultId: 'break:progress.set:replace',
        caseId: 'progress.set:replace',
        failure: 'injected progress proof seed failure',
      });
      // Proof: with the proof's progress seed outside the setup owner, this
      // failed with expected `{ closeCalls: 1, directoryExists: false }` and
      // received `{ closeCalls: 0, directoryExists: true }`.
      expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
        closeCalls: 1,
        directoryExists: false,
      });
    } finally {
      if (existsSync(directory)) {
        await rawSource?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('a progress-only seed retains its original and cleanup failures', async () => {
    let closeCalls = 0;
    let directory = '';
    let rawSource: SqliteSource | undefined;
    let combinedFailure: unknown;
    try {
      await openSqliteCase('progress', 'progress.set:replace', (options) => {
        directory = dirname(options.dbPath);
        const source = openSqliteSource(options);
        rawSource = source;
        return withStores(
          {
            ...source,
            async close() {
              closeCalls += 1;
              await source.close();
              throw new Error('injected progress seed cleanup failure');
            },
          },
          {
            steps: replaceMethod(
              source.stores.steps,
              'add',
              (add) => (step, stamp) =>
                step.id === PROGRESS_SENTINEL_STEP_ID
                  ? Promise.reject(new Error('injected progress original seed failure'))
                  : add(step, stamp),
            ),
          },
        );
      });
    } catch (failure) {
      combinedFailure = failure;
    }

    try {
      // Proof: bypassing the shared cleanup owner failed on
      // `Expected: true · Received: false`, leaving only the original failure.
      expect(combinedFailure instanceof AggregateError).toBe(true);
      if (!(combinedFailure instanceof AggregateError)) {
        throw new Error('progress seed and cleanup failures were not aggregated');
      }
      expect(combinedFailure.errors).toEqual([
        expect.objectContaining({ message: 'injected progress original seed failure' }),
        expect.objectContaining({ message: 'injected progress seed cleanup failure' }),
      ]);
      expect(closeCalls).toBe(1);
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (existsSync(directory)) {
        await rawSource?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('a successful progress-only seed leaves normal teardown owning one close', async () => {
    let closeCalls = 0;
    let directory = '';
    const fixture = await openSqliteCase('progress', 'progress.set:replace', (options) => {
      directory = dirname(options.dbPath);
      const source = openSqliteSource(options);
      return {
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      };
    });

    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 0,
      directoryExists: true,
    });
    await fixture.close();
    // Proof: calling the fixture's resource cleanup twice failed with expected
    // `closeCalls: 1` and received `closeCalls: 2`.
    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });
  });

  it('the execution report surfaces nested SQLite setup and cleanup failures', async () => {
    let closeCalls = 0;
    let directory = '';
    const report = await runCases(
      [
        {
          family: 'steps',
          caseId: 'steps.add',
          async openAndRun() {
            const fixture = await openSqliteCase('steps', 'steps.add', (options) => {
              directory = dirname(options.dbPath);
              const source = openSqliteSource(options);
              return {
                ...source,
                stores: {
                  ...source.stores,
                  users: replaceMethod(
                    source.stores.users,
                    'create',
                    () => () => Promise.reject(new Error('original report setup sentinel')),
                  ),
                },
                async close() {
                  closeCalls += 1;
                  await source.close();
                  throw new AggregateError(
                    [
                      new Error('report cleanup sentinel'),
                      new AggregateError(
                        [new Error('report nested cleanup sentinel')],
                        'nested report cleanup',
                      ),
                    ],
                    'report cleanup',
                  );
                },
              };
            });
            return {
              fixtureId: fixture.fixtureId,
              assert: () => Promise.resolve(),
              close: () => fixture.close(),
            };
          },
        },
      ],
      { focus: ['steps.add'] },
    );

    const execution = report.cases[0];
    expect(execution.status).toBe('failed');
    if (execution.status !== 'failed') throw new Error('expected failed report evidence');
    expect(execution.assertionPhase).toBe('setup');
    // Proof: flattening the real setup AggregateError to `.message` failed on
    // `Expected to contain: "original report setup sentinel"; Received:
    // "SQLite conformance setup and cleanup failed"`.
    expect(execution.failure).toBe(
      'SQLite conformance setup and cleanup failed: [original report setup sentinel; report cleanup: [report cleanup sentinel; nested report cleanup: [report nested cleanup sentinel]]]',
    );
    expect(closeCalls).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });

  it('the fault proof surfaces nested SQLite setup and cleanup failures', async () => {
    let closeCalls = 0;
    let directory = '';
    const proof = await proveFault(addFault, (options) => {
      directory = dirname(options.dbPath);
      const source = openSqliteSource(options);
      return {
        ...source,
        stores: {
          ...source.stores,
          users: replaceMethod(
            source.stores.users,
            'create',
            () => () => Promise.reject(new Error('original proof setup sentinel')),
          ),
        },
        async close() {
          closeCalls += 1;
          await source.close();
          throw new AggregateError(
            [
              new Error('proof cleanup sentinel'),
              new AggregateError(
                [new Error('proof nested cleanup sentinel')],
                'nested proof cleanup',
              ),
            ],
            'proof cleanup',
          );
        },
      };
    });

    expect(proof.kind).toBe('setup-failed');
    if (proof.kind !== 'setup-failed') throw new Error('expected failed proof setup');
    // Proof: flattening the proof AggregateError to `.message` failed on
    // `Expected to contain: "original proof setup sentinel"; Received:
    // "SQLite conformance setup and cleanup failed"`.
    expect(proof.failure).toBe(
      'SQLite conformance setup and cleanup failed: [original proof setup sentinel; proof cleanup: [proof cleanup sentinel; nested proof cleanup: [proof nested cleanup sentinel]]]',
    );
    expect(closeCalls).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });

  it('a seed failure cannot become an observed shared-case assertion', async () => {
    let reachedDuringSeed = false;
    const seedFault = createSeedFailureFault((reached) => {
      reachedDuringSeed = reached;
    });

    const proof = await proveFault(seedFault);

    // Proof: with setup deferred until after arm, this was `observed` and
    // reachedDuringSeed was true although the shared assertion never ran.
    expect(reachedDuringSeed).toBe(false);
    expect(proof).toEqual({
      kind: 'setup-failed',
      faultId: 'break:steps.add:seed-failure',
      caseId: 'steps.add',
      failure: 'injected seed failure after actual steps.add',
    });
  });

  it('a cleanup failure after fault reach is a phase failure, not assertion proof', async () => {
    let directory = '';
    const proof = await proveFault(cleanupFailureFault, (options) => {
      directory = dirname(options.dbPath);
      return openSqliteSource(options);
    });

    // Proof: rethrowing every failed execution from the proof assertion made
    // this `observed`; the corrected production path reports `phase-failed`
    // with both the Wiring assertion and injected cleanup failure retained.
    expect(proof.kind).toBe('phase-failed');
    if (proof.kind !== 'phase-failed') throw new Error('cleanup was accepted as proof');
    expect(proof.faultId).toBe('break:steps.add:cleanup-failure');
    expect(proof.caseId).toBe('steps.add');
    expect(proof.phase).toBe('steps.add');
    expect(Bun.stripANSI(proof.failure)).toContain('Expected to contain: "Wiring"');
    expect(proof.failure).toContain(
      'cleanup failed: injected cleanup failure after actual steps.add',
    );
    expect(existsSync(directory)).toBe(false);
  });

  it('SQLite terminal certification runs every exact offered case without gaps', async () => {
    const registrations = sourceConformanceRegistrations(declaration, sourceOpeners);
    const expected = expectedCasesFor(declaration.historyAdmission);
    const report = await runCases(registrations, { declaration });
    const expectedKeys = expected.map(({ family, caseId }) => `${family}:${caseId}`).toSorted();

    expect(report.kind).toBe('full');
    // Proof: the retired eight-character source literal failed this full Git
    // revision assertion before the certificate could print stale metadata.
    expect(declaration.revision).toMatch(/^[0-9a-f]{40}(?:-dirty)?$/);
    printCertification({ declaration, registrations, report });
    expect(registrations.map(({ family, caseId }) => `${family}:${caseId}`).toSorted()).toEqual(
      expectedKeys,
    );
    expect(report.cases.map(({ family, caseId }) => `${family}:${caseId}`).toSorted()).toEqual(
      expectedKeys,
    );
    expect(
      report.cases
        .map(({ caseId, status, executed }) => ({ caseId, status, executed }))
        .toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
    ).toEqual(
      expected
        .map(({ caseId }) => ({ caseId, status: 'passed' as const, executed: true }))
        .toSorted((left, right) => left.caseId.localeCompare(right.caseId)),
    );
  }, 15_000);

  it('Task 6.3 observes each saved-plan capture boundary fault and reversals', async () => {
    const faults: readonly Fault<SqliteSource>[] = [
      captureCompleteFault,
      captureMissingFault,
      captureDetachedFault,
    ];
    const closeCalls = faults.map(() => 0);
    const proofs = await Promise.all(
      faults.map((fault, index) =>
        proveFault(fault, openSqliteSource, (source) => ({
          ...source,
          async close() {
            closeCalls[index] += 1;
            await source.close();
          },
        })),
      ),
    );
    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed', 'observed']);
    expect(closeCalls).toEqual([1, 1, 1]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('capture-tag-only');
    expect(failures[0]).toContain('tag-a');
    expect(failures[1]).toContain('capture-project-missing');
    expect(failures[1]).toContain('missing: null');
    expect(failures[1]).toContain('projectB');
    expect(failures[2]).toContain('capture-tag-only');
    expect(failures[2]).toContain('projectB');
    expect(failures[2]).toContain('project-b');

    const neutralFaults: readonly Fault<SqliteSource>[] = [
      defineFault({
        ...captureCompleteFault,
        mutate: (source, control) => captureFaultSource(source, control, 'complete', false),
      }),
      defineFault({
        ...captureMissingFault,
        mutate: (source, control) => captureFaultSource(source, control, 'missing', false),
      }),
      defineFault({
        ...captureDetachedFault,
        mutate: (source, control) => captureFaultSource(source, control, 'detached', false),
      }),
    ];
    const neutralProofs = await Promise.all(neutralFaults.map((fault) => proveFault(fault)));
    // Proof: neutralizing only each mutation while retaining the complete real
    // read and named reach changes every observed negative to assertion-passed.
    expect(neutralProofs.map(({ kind }) => kind)).toEqual([
      'assertion-passed',
      'assertion-passed',
      'assertion-passed',
    ]);

    const noReachFaults: readonly Fault<SqliteSource>[] = [
      defineFault({
        id: captureCompleteFault.id,
        caseId: captureCompleteFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:complete:no-reach'),
        mutate(source: SqliteSource) {
          const muted = captureCompleteFault.createControl();
          muted.arm();
          return captureFaultSource(source, muted, 'complete');
        },
      }),
      defineFault({
        id: captureMissingFault.id,
        caseId: captureMissingFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:missing:no-reach'),
        mutate(source: SqliteSource) {
          const muted = captureMissingFault.createControl();
          muted.arm();
          return captureFaultSource(source, muted, 'missing');
        },
      }),
      defineFault({
        id: captureDetachedFault.id,
        caseId: captureDetachedFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:detached:no-reach'),
        mutate(source: SqliteSource) {
          const muted = captureDetachedFault.createControl();
          muted.arm();
          return captureFaultSource(source, muted, 'detached');
        },
      }),
    ];
    const noReachProofs = await Promise.all(noReachFaults.map((fault) => proveFault(fault)));
    // Proof: retaining each corruption while suppressing only its named reach
    // classifies all three as phase-failed instead of accepting the assertion.
    expect(noReachProofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);

    const suppressed = [
      { fault: captureCompleteFault, targetId: 'project-a', attempts: 0, closeCalls: 0 },
      {
        fault: captureMissingFault,
        targetId: 'capture-project-missing',
        attempts: 0,
        closeCalls: 0,
      },
      { fault: captureDetachedFault, targetId: 'project-a', attempts: 0, closeCalls: 0 },
    ];
    const suppressedProofs = await Promise.all(
      suppressed.map((probe) =>
        proveFault(probe.fault, openSqliteSource, (source) =>
          rejectCaptureRead(source, probe.targetId, probe),
        ),
      ),
    );
    // Proof: suppressing the real operation cannot certify a value-boundary
    // mutant; all three fail before reach and still close their source once.
    expect(suppressedProofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    expect(suppressed.map(({ attempts, closeCalls }) => ({ attempts, closeCalls }))).toEqual([
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
    ]);

    const preconditionFault = defineFault({
      ...captureCompleteFault,
      mutate(source: SqliteSource, control) {
        const incomplete = withSavedPlanCapture(source, {
          async readPlanInput(projectId) {
            const capture = await source.history.savedPlanCapture.readPlanInput(projectId);
            return projectId === 'project-a' && capture !== null
              ? { ...capture, tags: [] }
              : capture;
          },
        });
        return captureFaultSource(incomplete, control, 'complete');
      },
    });
    const preconditionProof = await proveFault(preconditionFault);
    // Proof: removing the expected directory before the complete mutant's
    // prerequisite check classifies the run as phase-failed without reach.
    expect(preconditionProof).toEqual({
      kind: 'phase-failed',
      faultId: captureCompleteFault.id,
      caseId: captureCompleteFault.caseId,
      phase: 'saved-plan-capture:complete:omit-tags',
      failure: 'fault did not reach saved-plan-capture:complete:omit-tags',
    });

    const wrongTargetFaults: readonly Fault<SqliteSource>[] = [
      {
        ...captureCompleteFault,
        mutate: (source, control) =>
          captureFaultSource(source, control, 'complete', true, 'project-never-read'),
      },
      {
        ...captureMissingFault,
        mutate: (source, control) =>
          captureFaultSource(source, control, 'missing', true, 'project-never-read'),
      },
      {
        ...captureDetachedFault,
        mutate: (source, control) =>
          captureFaultSource(source, control, 'detached', true, 'project-never-read'),
      },
    ];
    const wrongTargetCloseCalls = wrongTargetFaults.map(() => 0);
    const wrongTargetProofs = await Promise.all(
      wrongTargetFaults.map((fault, index) =>
        proveFault(fault, openSqliteSource, (source) => ({
          ...source,
          async close() {
            wrongTargetCloseCalls[index] += 1;
            await source.close();
          },
        })),
      ),
    );
    // Proof: targeting an unrelated project leaves the shared cases healthy,
    // so every fault remains unreached and each owned fixture closes once.
    expect(wrongTargetProofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    expect(wrongTargetCloseCalls).toEqual([1, 1, 1]);

    const cleanupFault = defineFault({
      ...captureCompleteFault,
      mutate(source: SqliteSource, control) {
        const corrupted = captureFaultSource(source, control, 'complete');
        return {
          ...corrupted,
          async close() {
            await corrupted.close();
            throw new Error('injected SQLite capture cleanup failure after assertion');
          },
        };
      },
    });
    const cleanupProof = await proveFault(cleanupFault);
    // Proof: a close rejection after the complete assertion fails preserves
    // both causes in operation-then-cleanup order and cannot count as observed.
    expect(cleanupProof.kind).toBe('phase-failed');
    if (cleanupProof.kind !== 'phase-failed') throw new Error('cleanup was accepted as proof');
    expect(Bun.stripANSI(cleanupProof.failure)).toContain('capture-tag-only');
    expect(cleanupProof.failure).toContain(
      'cleanup failed: injected SQLite capture cleanup failure after assertion',
    );
  });

  it('Task 6.5 settles independent SQLite history writes without waiting', async () => {
    const caseIds = [
      'history.batch:independent-commit',
      'history.batch:independent-rollback',
      'history.batch:busy-does-not-wait',
    ] as const;
    const report = await runCases(
      sourceConformanceRegistrations({ historyAdmission: 'immediate-busy' }, sourceOpeners),
      { focus: caseIds },
    );

    expect(
      report.cases.map(({ caseId, status, executed }) => ({ caseId, status, executed })),
    ).toEqual(caseIds.map((caseId) => ({ caseId, status: 'passed', executed: true })));
  });

  it('Task 6.5 rejects SQLite history routed through the held command coordinator', async () => {
    const registrations = sourceConformanceRegistrations(
      { historyAdmission: 'immediate-busy' },
      {
        ...openers,
        historyBatch: (caseId) => openSqliteHistoryBatchCase(caseId, true),
      },
    );
    const report = await runCases(registrations, {
      focus: ['history.batch:busy-does-not-wait'],
    });

    expect(report.cases[0]?.status).toBe('failed');
    if (report.cases[0]?.status !== 'failed') throw new Error('SQLite coordinator fault passed');
    // Proof: routing the exact separate-connection history attempt through the
    // held process coordinator produced `pending`, then release drained the write.
    expect(Bun.stripANSI(report.cases[0].failure)).toContain('pending');
    expect(Bun.stripANSI(report.cases[0].failure)).toContain('snapshot_busy');
  });

  it('Task 6.3 capture enrichment failures preserve setup and cleanup causes', async () => {
    let closeCalls = 0;
    let directory = '';
    let failure: unknown;
    try {
      await seedSqliteSource(
        (options) => {
          directory = dirname(options.dbPath);
          const source = openSqliteSource(options);
          return {
            ...source,
            async close() {
              closeCalls += 1;
              await source.close();
              throw new Error('injected SQLite capture cleanup failure');
            },
          };
        },
        async (source) => {
          const capacity = replaceMethod(source.stores.capacity, 'set', (set) => {
            return (projectId, teamId, size, stamp) =>
              projectId === 'project-a' && teamId === 'team-b'
                ? Promise.reject(new Error('injected capture capacity setup failure'))
                : set(projectId, teamId, size, stamp);
          });
          await seedSavedPlanCapture({ ...source.stores, capacity }, DETERMINISTIC_SEED);
        },
      );
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty('errors', [
      new Error('injected capture capacity setup failure'),
      new Error('injected SQLite capture cleanup failure'),
    ]);
    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });
  });

  it('Task 6.3 rejects non-null real missing captures before fault reach', async () => {
    let unknownReads = 0;
    let closeCalls = 0;
    let directory = '';
    let realMissing: PlanInputReads | null | undefined;
    let projectA: PlanInputReads | null = null;
    let projectB: PlanInputReads | null = null;
    const fault = defineFault({
      ...captureMissingFault,
      mutate(source: SqliteSource, control) {
        const invalid = withSavedPlanCapture(source, {
          async readPlanInput(projectId) {
            const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
            if (projectId !== 'capture-project-missing') return captured;
            unknownReads += 1;
            realMissing = captured;
            [projectA, projectB] = await Promise.all([
              source.history.savedPlanCapture.readPlanInput('project-a'),
              source.history.savedPlanCapture.readPlanInput('project-b'),
            ]);
            return emptyMissingCapture();
          },
        });
        return captureFaultSource(invalid, control, 'missing');
      },
    });
    const proof = await proveFault(
      fault,
      openSqliteSource,
      (source) => ({
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      }),
      () => Promise.resolve(),
      (ownedDirectory) => {
        directory = ownedDirectory;
      },
    );
    // Proof: removing the missing-null guard changed this source-specific
    // reversal from phase-failed to observed; the real unknown read was the
    // only unknown attempt and complete A/B state remained independently readable.
    expect(proof).toEqual({
      kind: 'phase-failed',
      faultId: captureMissingFault.id,
      caseId: captureMissingFault.caseId,
      phase: 'saved-plan-capture:missing:empty-capture',
      failure: 'fault did not reach saved-plan-capture:missing:empty-capture',
    });
    expect({
      unknownReads,
      realMissing,
      closeCalls,
      directoryExists: existsSync(directory),
    }).toEqual({
      unknownReads: 1,
      realMissing: null,
      closeCalls: 1,
      directoryExists: false,
    });
    expect(optionalCaptureMatchesOracle(projectA, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 proves the detached second-read prerequisite and ordinal', async () => {
    let targetReads = 0;
    let closeCalls = 0;
    let directory = '';
    let mutationObserved = false;
    let firstTags: readonly { readonly id: string; readonly name: string }[] | null = null;
    let firstCapture: PlanInputReads | null = null;
    let firstSnapshot: ReturnType<typeof observePlanInput> | null = null;
    let secondCapture: PlanInputReads | null = null;
    let projectB: PlanInputReads | null = null;
    const incompleteFault = defineFault({
      ...captureDetachedFault,
      mutate(source: SqliteSource, control) {
        const incomplete = withSavedPlanCapture(source, {
          async readPlanInput(projectId) {
            if (projectId !== 'project-a')
              return source.history.savedPlanCapture.readPlanInput(projectId);
            targetReads += 1;
            if (targetReads === 2) mutationObserved = firstTags?.length === 0;
            const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
            if (captured === null) return null;
            if (targetReads === 1) {
              firstTags = captured.tags;
              firstCapture = captured;
              firstSnapshot = observePlanInput(captured);
              return captured;
            }
            secondCapture = captured;
            projectB = await source.history.savedPlanCapture.readPlanInput('project-b');
            return { ...captured, tags: [] };
          },
        });
        return captureFaultSource(incomplete, control, 'detached');
      },
    });
    const incompleteProof = await proveFault(
      incompleteFault,
      openSqliteSource,
      (source) => ({
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      }),
      () => Promise.resolve(),
      (ownedDirectory) => {
        directory = ownedDirectory;
      },
    );
    // Proof: removing the pristine second-capture guard changed this reversal
    // from phase-failed to observed after two target calls and caller mutation.
    expect(incompleteProof).toMatchObject({
      kind: 'phase-failed',
      faultId: captureDetachedFault.id,
      caseId: captureDetachedFault.caseId,
      phase: 'saved-plan-capture:detached:shared-tags',
      failure: 'fault did not reach saved-plan-capture:detached:shared-tags',
    });
    expect({
      targetReads,
      mutationObserved,
      closeCalls,
      directoryExists: existsSync(directory),
    }).toEqual({ targetReads: 2, mutationObserved: true, closeCalls: 1, directoryExists: false });
    expect(captureObservationMatchesOracle(firstSnapshot, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(firstCapture, 0)).toBe(false);
    expect(optionalCaptureMatchesOracle(secondCapture, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 requires the second real detached read before fault reach', async () => {
    let targetReads = 0;
    let closeCalls = 0;
    let directory = '';
    let mutationObserved = false;
    let firstTags: readonly { readonly id: string; readonly name: string }[] | null = null;
    let firstCapture: PlanInputReads | null = null;
    let firstSnapshot: ReturnType<typeof observePlanInput> | null = null;
    let projectB: PlanInputReads | null = null;
    const refusalProof = await proveFault(
      captureDetachedFault,
      openSqliteSource,
      (source) =>
        withSavedPlanCapture(
          {
            ...source,
            async close() {
              closeCalls += 1;
              await source.close();
            },
          },
          {
            async readPlanInput(projectId) {
              if (projectId !== 'project-a')
                return source.history.savedPlanCapture.readPlanInput(projectId);
              targetReads += 1;
              if (targetReads === 1) {
                const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
                if (captured !== null) {
                  firstTags = captured.tags;
                  firstCapture = captured;
                  firstSnapshot = observePlanInput(captured);
                }
                return captured;
              }
              mutationObserved = firstTags?.length === 0;
              projectB = await source.history.savedPlanCapture.readPlanInput('project-b');
              throw new Error('injected second SQLite capture refusal');
            },
          },
        ),
      () => Promise.resolve(),
      (ownedDirectory) => {
        directory = ownedDirectory;
      },
    );
    // Proof: substituting a clone of the first capture for the second real call
    // made this proof observed with targetReads 1; refusal at ordinal two makes
    // the required operation phase-failed while preserving complete public state.
    expect(refusalProof).toMatchObject({
      kind: 'phase-failed',
      faultId: captureDetachedFault.id,
      caseId: captureDetachedFault.caseId,
      phase: 'saved-plan-capture:detached:shared-tags',
      failure: 'fault did not reach saved-plan-capture:detached:shared-tags',
    });
    expect({
      targetReads,
      mutationObserved,
      closeCalls,
      directoryExists: existsSync(directory),
    }).toEqual({ targetReads: 2, mutationObserved: true, closeCalls: 1, directoryExists: false });
    expect(captureObservationMatchesOracle(firstSnapshot, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(firstCapture, 0)).toBe(false);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 rejects an omitted capture-only directory before fault reach', async () => {
    let closeCalls = 0;
    let directoryPath = '';
    let failure: unknown;
    try {
      await seedSqliteSource(
        (options) => {
          directoryPath = dirname(options.dbPath);
          const source = openSqliteSource(options);
          return {
            ...source,
            async close() {
              closeCalls += 1;
              await source.close();
            },
          };
        },
        async (source) => {
          const directory = replaceMethod(source.stores.directory, 'addTag', (addTag) => {
            return (tag, stamp) =>
              tag.id === 'capture-tag-only' ? Promise.resolve(tag) : addTag(tag, stamp);
          });
          await seedSavedPlanCapture({ ...source.stores, directory }, DETERMINISTIC_SEED);
        },
      );
    } catch (cause) {
      failure = cause;
    }
    // Proof: omitting only the real capture-only tag write fails the complete
    // public seed snapshot, closes once, and removes the owned directory.
    expect(Bun.stripANSI(String(failure))).toContain('capture-tag-only');
    expect({ closeCalls, directoryExists: existsSync(directoryPath) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });
  });

  it('Task 6.4 observes outside-epoch directory tearing and its reversals', async () => {
    let closeCalls = 0;
    let directory = '';
    const proof = await proveCoherentCaptureFault(
      captureCoherentFault,
      (source) => ({
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      }),
      (ownedDirectory) => {
        directory = ownedDirectory;
      },
    );
    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error('coherent tearing was not observed');
    expect(proof.phase).toBe('saved-plan-capture:coherent:directory-outside-epoch');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('Tag after interleave');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('Tag 1');
    expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
      closeCalls: 1,
      directoryExists: false,
    });

    const neutral = defineFault({
      ...captureCoherentFault,
      mutate: (source: SqliteSource, control) => coherentCaptureFaultSource(source, control, false),
    });
    const neutralProof = await proveCoherentCaptureFault(neutral);
    // Proof: retaining the real held capture, committed writer, outside-epoch
    // public reads and exact reach while removing only the torn return passes.
    expect(neutralProof.kind).toBe('assertion-passed');

    const noReach = defineFault({
      id: captureCoherentFault.id,
      caseId: captureCoherentFault.caseId,
      createControl: () => createFaultControl('saved-plan-capture:coherent:no-reach'),
      mutate(source: SqliteSource) {
        const muted = captureCoherentFault.createControl();
        muted.arm();
        return coherentCaptureFaultSource(source, muted);
      },
    });
    const noReachProof = await proveCoherentCaptureFault(noReach);
    // Proof: retaining the torn public return while suppressing only the named
    // reach is phase-failed and cannot certify the shared assertion failure.
    expect(noReachProof.kind).toBe('phase-failed');

    const incomplete = defineFault({
      ...captureCoherentFault,
      mutate(source: SqliteSource, control) {
        const incompleteSource = withSavedPlanCapture(source, {
          async readPlanInput(projectId) {
            const captured = await source.history.savedPlanCapture.readPlanInput(projectId);
            return projectId === 'project-a' && captured !== null
              ? { ...captured, tags: [] }
              : captured;
          },
        });
        return coherentCaptureFaultSource(incompleteSource, control);
      },
    });
    const incompleteProof = await proveCoherentCaptureFault(incomplete);
    // Proof: weakening the complete before-state guard changed this prerequisite
    // mutant to observed; with the guard it remains phase-failed before reach.
    expect(incompleteProof.kind).toBe('phase-failed');

    let wrongTargetCloseCalls = 0;
    let wrongTargetDirectory = '';
    const wrongTarget = defineFault({
      ...captureCoherentFault,
      mutate: (source: SqliteSource, control) =>
        coherentCaptureFaultSource(source, control, true, 'project-b'),
    });
    const wrongTargetProof = await proveCoherentCaptureFault(
      wrongTarget,
      (source) => ({
        ...source,
        async close() {
          wrongTargetCloseCalls += 1;
          await source.close();
        },
      }),
      (ownedDirectory) => {
        wrongTargetDirectory = ownedDirectory;
      },
    );
    expect({
      kind: wrongTargetProof.kind,
      wrongTargetCloseCalls,
      directoryExists: existsSync(wrongTargetDirectory),
    }).toEqual({ kind: 'phase-failed', wrongTargetCloseCalls: 1, directoryExists: false });

    let writerFailureCloseCalls = 0;
    let writerFailureDirectory = '';
    const writerFailureProof = await proveCoherentCaptureFault(
      captureCoherentFault,
      (source) => ({
        ...source,
        async close() {
          writerFailureCloseCalls += 1;
          await source.close();
        },
      }),
      (ownedDirectory) => {
        writerFailureDirectory = ownedDirectory;
      },
      () => Promise.reject(new Error('injected coherent SQLite writer failure')),
    );
    // Proof: rejecting the writer while capture is held releases and drains the
    // real capture, closes once, removes the directory, and never counts as proof.
    expect({
      kind: writerFailureProof.kind,
      writerFailureCloseCalls,
      directoryExists: existsSync(writerFailureDirectory),
    }).toEqual({ kind: 'phase-failed', writerFailureCloseCalls: 1, directoryExists: false });
  });

  it('Task 6.4 capture rollback cannot revoke an independent committed SQLite writer', async () => {
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    let closeCalls = 0;
    let didEnter = false;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seeded = await seedSqliteSource(
      (options) =>
        openSqliteSourceWithCaptureReadSeam(options, {
          async afterFirstRead({ projectId, project }) {
            if (projectId !== 'project-a' || didEnter) return;
            if (project.id !== projectId || project.name !== 'Captured project A')
              throw new Error('SQLite rollback probe reached before the real first read');
            didEnter = true;
            enter();
            await released;
            throw new Error('injected SQLite capture failure after independent writer');
          },
        }),
      async (source) => seedSavedPlanCapture(source.stores, DETERMINISTIC_SEED),
    );
    const directory = seeded.directory;
    const source: SqliteSource = {
      ...seeded.source,
      async close() {
        closeCalls += 1;
        await Promise.resolve(seeded.source.close());
      },
    };
    try {
      const held = source.history.savedPlanCapture.readPlanInput('project-a');
      await entered;
      const change = await changeSqliteCaptureDirectory(source);
      release();
      let captureFailure: unknown;
      try {
        await held;
      } catch (cause) {
        captureFailure = cause;
      }
      expect((captureFailure as Error | undefined)?.message).toBe(
        'injected SQLite capture failure after independent writer',
      );
      const after = await source.history.savedPlanCapture.readPlanInput('project-a');
      expect(change.tag).toMatchObject({ ok: true });
      expect(change.person).toMatchObject({ ok: true });
      expect(after === null ? false : captureMatchesOracle(after, 0, 'after')).toBe(true);
    } finally {
      release();
      await closeSqliteResources(source, directory);
    }
    // Proof: giving capture the shared process handle makes its rollback restore
    // the complete before directory; the dedicated connection preserves the writer.
    expect({ didEnter, closeCalls, directoryExists: existsSync(directory) }).toEqual({
      didEnter: true,
      closeCalls: 1,
      directoryExists: false,
    });
  });

  it('Task 6.4 rejects capture on the shared SQLite writer connection', async () => {
    const { source, directory } = await seedSqliteSource(openSqliteSource, async (seeded) => {
      await seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED);
    });
    let borrowedCloseCalls = 0;
    let reached = false;
    let insideAfter = false;
    let outsideBefore: boolean;
    const borrowedCapture = new SavedPlanCaptureRepository(
      {
        openConnection: () => ({
          db: source.db,
          close() {
            borrowedCloseCalls += 1;
          },
        }),
      },
      {
        async afterFirstRead({ projectId, project }) {
          if (projectId !== 'project-a' || project.name !== 'Captured project A')
            throw new Error('shared SQLite owner reached before project A first read');
          const tagWrite = source.db
            .update(tagTable)
            .set({ name: 'Tag after interleave', updatedAt: 600, createdBy: 'owner-b' })
            .where(eq(tagTable.id, 'tag-a'))
            .run();
          const membershipDelete = source.db
            .delete(personTeamTable)
            .where(eq(personTeamTable.personId, 'capture-person-unassigned'))
            .run();
          const membershipWrite = source.db
            .insert(personTeamTable)
            .values({
              personId: 'capture-person-unassigned',
              serviceTeamId: 'team-a',
              createdAt: 600,
              createdBy: 'owner-b',
              updatedAt: 600,
            })
            .run();
          const [tags, people] = await Promise.all([
            source.stores.directory.listTags(),
            source.stores.directory.listPeople(),
          ]);
          insideAfter =
            tagWrite.changes === 1 &&
            membershipDelete.changes === 1 &&
            membershipWrite.changes === 1 &&
            tags.some(({ id, name }) => id === 'tag-a' && name === 'Tag after interleave') &&
            people.some(
              ({ id, teamIds }) =>
                id === 'capture-person-unassigned' &&
                teamIds.length === 1 &&
                teamIds[0] === 'team-a',
            );
          if (!insideAfter)
            throw new Error('shared SQLite owner did not establish complete after state');
          reached = true;
          throw new Error('injected shared SQLite capture rollback');
        },
      },
    );
    let failure: unknown;
    try {
      await borrowedCapture.readPlanInput('project-a');
    } catch (cause) {
      failure = cause;
    } finally {
      const [tags, people] = await Promise.all([
        source.stores.directory.listTags(),
        source.stores.directory.listPeople(),
      ]);
      outsideBefore =
        tags.some(({ id, name }) => id === 'tag-a' && name === 'Tag 1') &&
        people.some(
          ({ id, teamIds }) =>
            id === 'capture-person-unassigned' && teamIds.length === 1 && teamIds[0] === 'team-b',
        );
      await closeSqliteResources(source, directory);
    }
    expect((failure as Error | undefined)?.message).toBe('injected shared SQLite capture rollback');
    // Proof: restoring the dedicated capture connection changes this forbidden
    // owner reversal to after-state; the shared rollback revokes all three writes.
    expect({ reached, insideAfter, outsideBefore, borrowedCloseCalls }).toEqual({
      reached: true,
      insideAfter: true,
      outsideBefore: true,
      borrowedCloseCalls: 1,
    });
  });

  it('reinjects project step, scope, and reader-order faults', async () => {
    const faults = [createProjectStepsFault, updateProjectScopeFault, projectReaderOrderFault];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed', 'observed']);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('project-created-dev');
    expect(failures[1]).toContain('"name": "Renamed project"');
    expect(failures[2]).toContain('"Project 2"');
    expect(failures[2]).toContain('"Project 1"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      faults.map(({ caseId }) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects account uniqueness, read-shape, issuer, and verified-email faults', async () => {
    const faults = [
      createUniqueNameFault,
      findIdentityFault,
      issuerSubjectFault,
      verifiedConflictFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(
      Array.from({ length: faults.length }, () => 'observed'),
    );
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('"duplicate": {');
    expect(failures[1]).toContain('"passwordHash": null');
    expect(failures[2]).toContain('"otherStored": null');
    expect(failures[3]).toContain('"id": "oidc-conflict"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      faults.map(({ caseId }) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects capacity and priority-band configuration faults', async () => {
    const faults = [
      capacityProjectTeamFault,
      capacityClearFault,
      capacityMissingReferenceFault,
      priorityDefaultsFault,
      priorityFirstRungFault,
      priorityMissingProjectFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(
      Array.from({ length: faults.length }, () => 'observed'),
    );
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('"team-a" => 5');
    expect(failures[1]).toContain('"size": 0');
    expect(failures[2]).toContain('"missingProject"');
    expect(failures[2]).toContain('"ok": true');
    expect(failures[3]).toContain('"Critical"');
    expect(failures[3]).toContain('"projectA": []');
    expect(failures[4]).toContain('"label": "Soon"');
    expect(failures[5]).toContain('"ok": true');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      faults.map(({ caseId }) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects project-scope destruction inside the priority-band transaction', async () => {
    const proof = await proveFault(priorityProjectScopeFault);

    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error('project-scope destruction was not observed');
    // Proof: the trigger broadened the real transaction's A-row deletion to B;
    // this failed on `"label": "Now"` becoming `"label": "Critical"`.
    expect(Bun.stripANSI(proof.observedFailure)).toContain('"label": "Now"');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('"label": "Critical"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: [priorityProjectScopeFault.caseId],
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: priorityProjectScopeFault.caseId, status: 'passed' },
    ]);
  });

  it('reinjects marker order, project-scope, and literal-date faults', async () => {
    const faults = [markerOrderFault, markerProjectScopeFault, markerLiteralDateFault];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed', 'observed']);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('"marker-c"');
    expect(failures[1]).toContain('"name": "Mine now"');
    expect(failures[2]).toContain('"date": "2026-09-11"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: markerOrderFault.caseId, status: 'passed' },
      { caseId: markerProjectScopeFault.caseId, status: 'passed' },
    ]);
  });

  it('reinjects the existing add, rename, estimate, remove, range, and prune faults', async () => {
    const proofs = await Promise.all(
      [addFault, renameFault, estimateFault, removeFault, rangeFault, pruneFault].map((fault) =>
        proveFault(fault),
      ),
    );

    expect(proofs.map(({ kind }) => kind)).toEqual(Array.from({ length: 6 }, () => 'observed'));
    const observedFailures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    const expectedFragments = [
      'Expected to contain: "Wiring"',
      'Received: "faulted rename"',
      'Received: 3',
      '"work-a-two"',
      '+ []',
      'Received: 0',
    ];
    for (const [index, fragment] of expectedFragments.entries()) {
      expect(observedFailures[index]).toContain(fragment);
    }

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: [
        addFault.caseId,
        renameFault.caseId,
        estimateFault.caseId,
        removeFault.caseId,
        rangeFault.caseId,
        pruneFault.caseId,
      ],
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      [addFault, renameFault, estimateFault, removeFault, rangeFault, pruneFault].map(
        ({ caseId }) => ({ caseId, status: 'passed' }),
      ),
    );
  });

  it('reinjects the five work-item matrix faults in their named windows', async () => {
    const faults = [
      insertRespaceFault,
      patchRefusalAtomicFault,
      removePromotionFault,
      frozenAcquireFault,
      frozenClearFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'workItems.insert:respace',
      'workItems.patch:refusal-atomic',
      'workItems.remove:promotion',
      'workItems.setFrozenNumbers:clear:first-freeze',
      'workItems.setFrozenNumbers:clear',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: the five real SQLite mutations failed respectively with the tight
    // sibling still at position 11, `Escaped rename`, a settled refusal with the
    // parent retained, the first number received as null, and the retained
    // number received as null.
    expect(failures[0]).toContain('"position": 11');
    expect(failures[1]).toContain('"name": "Escaped rename"');
    expect(failures[2]).toContain('didRefuse: true');
    expect(failures[3]).toContain(`Expected to contain: [
  {
    id: "work-a-one",
    projectId: "project-a",
    parentId: null,
    position: 10,
    name: "Work 1",
    notes: "",
    frozenNumber: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    deadline: null,
    factStart: null,
    factEnd: null,
    priority: null,
    serviceTeamId: "team-a",
    serviceId: null,
    maxParallel: 1,
    revision: 2,
    teamIds: [ "team-a" ],
    tagIds: [ "tag-a" ],
    serviceIds: [ "service-a" ],
    typeIds: [ "type-a" ],`);
    expect(failures[4]).toContain('frozenNumber: null');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      Array.from(new Set(faults.map(({ caseId }) => caseId)), (caseId) => ({
        caseId,
        status: 'passed',
      })),
    );
  });

  it('reinjects estimate and actual ownership, pair, timestamp, and refusal faults', async () => {
    const faults = [
      estimateMoveOwnershipFault,
      actualReplaceRecordedAtFault,
      actualRemoveFirstCallFault,
      actualRemovePairFault,
      actualMoveOwnershipFault,
      actualUnknownStepFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'estimates.moveAll:ownership',
      'actuals.set:replace',
      'actuals.remove:pair:first-settlement',
      'actuals.remove:pair',
      'actuals.moveAll:ownership',
      'actuals.set:unknown_step',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: copying through the real estimate set path exposed both complete
    // source trios as additions beside the two unchanged destination trios.
    expect(failures[0]).toContain(`      "optimistic": 1,
      "pessimistic": 4,
      "realistic": 2,
      "stepId": "step-a-dev",
+     "workItemId": "work-a-one",
+   },
+   {
+     "optimistic": 3,
+     "pessimistic": 8,
+     "realistic": 5,
+     "stepId": "step-a-qa",
+     "workItemId": "work-a-one",
+   },
+   {
+     "optimistic": 1,
+     "pessimistic": 4,
+     "realistic": 2,
+     "stepId": "step-a-dev",
      "workItemId": "work-a-two",`);
    expect(failures[0]).toContain(`    {
      "optimistic": 3,
      "pessimistic": 8,
      "realistic": 5,
      "stepId": "step-a-qa",
      "workItemId": "work-a-two",
    },`);
    // Proof: retaining the first recording time produced the complete target
    // pair with days 13, expected timestamp 201 and received timestamp 101.
    expect(failures[1]).toContain(`    {
      "days": 13,
-     "recordedAt": 201,
+     "recordedAt": 101,
      "stepId": "step-a-dev",
      "workItemId": "work-a-one",
    },`);
    // Proof: suppressing the first removal exposed the complete targeted
    // work-a-one/dev row as an addition in the first settlement window.
    expect(failures[2]).toContain(`    {
+     "days": 2,
+     "recordedAt": 101,
+     "stepId": "step-a-dev",
+     "workItemId": "work-a-one",
+   },`);
    // Proof: broadening removal exposed the complete work-a-two/dev survivor,
    // days 5 at recordedAt 103, as absent from the received first settlement.
    expect(failures[3]).toContain(`-   {
-     "days": 5,
-     "recordedAt": 103,
-     "stepId": "step-a-dev",
-     "workItemId": "work-a-two",
-   },`);
    // Proof: copying through the real actual set path exposed both complete
    // source rows as additions beside the two unchanged destination rows.
    expect(failures[4]).toContain(`      "days": 2,
      "recordedAt": 101,
      "stepId": "step-a-dev",
+     "workItemId": "work-a-one",
+   },
+   {
+     "days": 3,
+     "recordedAt": 102,
+     "stepId": "step-a-qa",
+     "workItemId": "work-a-one",
+   },
+   {
+     "days": 2,
+     "recordedAt": 101,
+     "stepId": "step-a-dev",
      "workItemId": "work-a-two",`);
    expect(failures[4]).toContain(`    {
      "days": 3,
      "recordedAt": 102,
      "stepId": "step-a-qa",
      "workItemId": "work-a-two",
    },`);
    // Proof: accepting the missing step produced both received `written` and
    // the complete escaped work-a-one/no-such-step/days-13/recordedAt-201 row.
    expect(failures[5]).toContain(`-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "days": 13,
+       "recordedAt": 201,
+       "stepId": "no-such-step",
+       "workItemId": "work-a-one",
+     },`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      Array.from(new Set(faults.map(({ caseId }) => caseId)), (caseId) => ({
        caseId,
        status: 'passed',
      })),
    );
  });

  it('reinjects measure identity, timestamp, ownership, and refusal faults', async () => {
    const faults = [
      measureSetPairIdentityFault,
      measureSetRecordedAtFault,
      measureRemovePairIdentityFault,
      measureMoveOneMetricFault,
      measureMoveRecordedAtFault,
      measureUnknownStepFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'measures.set:metric-key',
      'measures.set:metric-key:recorded-at',
      'measures.remove:metric-key',
      'measures.moveAll:all-metrics',
      'measures.moveAll:all-metrics:recorded-at',
      'measures.set:unknown_step',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: omitting metric from set identity deleted the complete hours and
    // token-estimate survivors from the requested pair after its complete setup.
    expect(failures[0]).toContain(`    {
-     "metric": "hours_actual",
-     "recordedAt": 103,
-     "stepId": "step-a-dev",
-     "value": 12,
-     "workItemId": "work-a-one",
-   },`);
    expect(failures[0]).toContain(`-   {
-     "metric": "token_estimate",
-     "recordedAt": 101,
-     "stepId": "step-a-dev",
-     "value": 10,
      "workItemId": "work-a-one",
    },`);
    // Proof: retaining the first timestamp on token_actual value 21 produced
    // expected recordedAt 201 and received 102 on the complete triple key.
    expect(failures[1]).toContain(`    {
      "metric": "token_actual",
-     "recordedAt": 201,
+     "recordedAt": 102,
      "stepId": "step-a-dev",
      "value": 21,
      "workItemId": "work-a-one",
    },`);
    // Proof: omitting metric from remove identity deleted both complete
    // non-target metric survivors from the requested pair's first settlement.
    expect(failures[2]).toContain(`    {
-     "metric": "hours_actual",
-     "recordedAt": 103,
-     "stepId": "step-a-dev",
-     "value": 12,
-     "workItemId": "work-a-one",
-   },`);
    expect(failures[2]).toContain(`-   {
-     "metric": "token_estimate",
-     "recordedAt": 101,
-     "stepId": "step-a-dev",
-     "value": 10,
-     "workItemId": "work-a-one",
-   },`);
    // Proof: moving only token_estimate left the complete hours_actual and
    // token_actual rows received on work-a-one instead of expected work-a-two.
    expect(failures[3]).toContain(`    {
      "metric": "hours_actual",
      "recordedAt": 103,
      "stepId": "step-a-dev",
      "value": 12,
-     "workItemId": "work-a-two",
+     "workItemId": "work-a-one",
    },`);
    expect(failures[3]).toContain(`    {
      "metric": "token_actual",
      "recordedAt": 102,
      "stepId": "step-a-dev",
      "value": 11,
-     "workItemId": "work-a-two",
+     "workItemId": "work-a-one",
    },`);
    // Proof: losing the moved token_actual timestamp produced expected 102 and
    // received 999 on its complete destination triple and value.
    expect(failures[4]).toContain(`    {
      "metric": "token_actual",
-     "recordedAt": 102,
+     "recordedAt": 999,
      "stepId": "step-a-dev",
      "value": 11,
      "workItemId": "work-a-two",
    },`);
    // Proof: accepting the missing step produced received written and the
    // complete escaped token_estimate row in project A's settled public read.
    expect(failures[5]).toContain(`-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "metric": "token_estimate",
+       "recordedAt": 201,
+       "stepId": "no-such-step",
+       "value": 21,
+       "workItemId": "work-a-one",
+     },`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      Array.from(new Set(faults.map(({ caseId }) => caseId)), (caseId) => ({
        caseId,
        status: 'passed',
      })),
    );
  });

  it('reinjects progress replacement, absence, ownership, and refusal faults', async () => {
    const faults = [
      progressReplaceFault,
      progressNotStartedSurrogateFault,
      progressMoveOwnershipFault,
      progressUnknownStepFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'progress.set:replace',
      'progress.remove:absence',
      'progress.moveAll:ownership',
      'progress.set:unknown_step',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: retaining the first statement left the complete work-a-one/dev row
    // at in_progress@101 instead of replacing it with done@201.
    expect(failures[0]).toContain(`    {
-     "state": "done",
-     "statedAt": 201,
+     "state": "in_progress",
+     "statedAt": 101,
      "stepId": "step-a-dev",
      "workItemId": "work-a-one",
    },`);
    // Proof: storing the third state as a surrogate exposed the complete
    // not_started@201 row on the removed work-a-one/dev pair.
    expect(failures[1]).toContain(`    {
+     "state": "not_started",
+     "statedAt": 201,
+     "stepId": "step-a-dev",
+     "workItemId": "work-a-one",
+   },`);
    // Proof: copying both source statements exposed the complete done@101 and
    // in_progress@102 source rows beside their complete destination rows.
    expect(failures[2]).toContain(`      "state": "done",
      "statedAt": 101,
      "stepId": "step-a-dev",
+     "workItemId": "work-a-one",
+   },
+   {
+     "state": "in_progress",
+     "statedAt": 102,
+     "stepId": "step-a-qa",
+     "workItemId": "work-a-one",
+   },
+   {
+     "state": "done",
+     "statedAt": 101,
+     "stepId": "step-a-dev",
      "workItemId": "work-a-two",
    },`);
    expect(failures[2]).toContain(`    {
      "state": "in_progress",
      "statedAt": 102,
      "stepId": "step-a-qa",
      "workItemId": "work-a-two",
    },
    {
      "state": "done",
      "statedAt": 103,
      "stepId": "step-a-review",
      "workItemId": "work-a-two",
    },`);
    // Proof: accepting the missing step produced received written and the
    // complete escaped work-a-one/no-such-step/done@201 public row.
    expect(failures[3]).toContain(`-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "state": "done",
+       "statedAt": 201,
+       "stepId": "no-such-step",
+       "workItemId": "work-a-one",
+     },`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      Array.from(new Set(faults.map(({ caseId }) => caseId)), (caseId) => ({
        caseId,
        status: 'passed',
      })),
    );
  });

  it('reinjects dependency identity, pair, direction, and full-set faults', async () => {
    const faults = [
      dependencyIdFault,
      dependencyInputMutationFault,
      dependencyPairPredicateFault,
      dependencyOutgoingOnlyFault,
      dependencyIncompleteSetFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'dependencies.add:idempotent-pair:edge-id',
      'dependencies.add:idempotent-pair:input-id',
      'dependencies.remove:pair:successor-predicate',
      'dependencies.removeAllFor:touching-set:outgoing-only',
      'dependencies.removeAllFor:touching-set:first-only',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: ID-keyed deduplication retains the original source-owned edge and
    // adds this complete second-ID edge after verified inert setup.
    expect(failures[0]).toContain(`    {
+     "id": "dependency-idempotent-second-id",
+     "predecessorId": "work-a-one",
+     "projectId": "project-a",
+     "successorId": "work-a-two",
+   },
+   {`);
    // Proof: mutating the write argument in place exposes the complete
    // corrupted-ID edge without altering the independent expected record.
    expect(failures[1]).toContain(`    {
-     "id": "dependency-idempotent-original",
+     "id": "dependency-idempotent-mutated",
      "predecessorId": "work-a-one",
      "projectId": "project-a",
      "successorId": "work-a-two",
    },`);
    // Proof: omitting the successor predicate removes this complete expected
    // same-predecessor edge along with the selected pair.
    expect(failures[2]).toContain(`    {
-     "id": "dependency-remove-same-predecessor",
-     "predecessorId": "work-a-one",
-     "projectId": "project-a",
-     "successorId": "dependency-survivor-one",
-   },
-   {`);
    // Proof: removing outgoing edges only leaves this complete incoming edge
    // in the received project-A list.
    expect(failures[3]).toContain(`    {
+     "id": "dependency-remove-all-incoming",
+     "predecessorId": "dependency-survivor-one",
+     "projectId": "project-a",
+     "successorId": "work-a-one",
+   },
+   {`);
    // Proof: passing only the first doomed ID leaves this complete outgoing
    // edge for the second doomed row in the received project-A list.
    expect(failures[4]).toContain(`    {
+     "id": "dependency-remove-all-outgoing",
+     "predecessorId": "work-a-two",
+     "projectId": "project-a",
+     "successorId": "dependency-survivor-two",
+   },
+   {`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'dependencies.add:idempotent-pair', status: 'passed' },
      { caseId: 'dependencies.remove:pair', status: 'passed' },
      { caseId: 'dependencies.removeAllFor:touching-set', status: 'passed' },
    ]);
  });

  it('rejects a pre-write team fault before the atomicity phase', async () => {
    const probe: DirectoryPrewriteProbe = {
      attempts: 0,
      closeCalls: 0,
      teams: null,
    };
    const proof = await proveFault(directoryTeamAtomicityFault, (options) =>
      openDirectoryPrewriteFailureSource(options, probe),
    );

    // Proof: reaching before the name-only write returned `observed`; moving
    // reach after its complete public verification returns phase-failed.
    expect(proof).toEqual({
      kind: 'phase-failed',
      faultId: 'break:directory.patchTeam:atomic-refusal',
      caseId: 'directory.patchTeam:atomic-refusal',
      phase: 'directory.patchTeam:atomic-refusal:early-rename',
      failure: 'fault did not reach directory.patchTeam:atomic-refusal:early-rename',
    });
    expect(probe).toEqual({
      attempts: 1,
      closeCalls: 1,
      teams: [
        {
          id: 'team-a',
          name: 'Directory original',
          serviceIds: ['service-a'],
        },
        {
          id: 'team-b',
          name: 'Team 2',
          serviceIds: ['directory-service-sentinel'],
        },
      ],
    });
  });

  it('reinjects directory assignment scope and team atomicity faults', async () => {
    const faults = [
      directoryAssignmentsOfSubsetFault,
      directoryAssignmentScopeFault,
      directoryTeamAtomicityFault,
    ];
    const proofs = await Promise.all(faults.map((fault) => proveFault(fault)));

    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed', 'observed']);
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'directory.assign:scope-replace-clear:subset',
      'directory.assign:scope-replace-clear:pair-scope',
      'directory.patchTeam:atomic-refusal:early-rename',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    // Proof: ignoring the strict subset adds this complete project-B row.
    expect(failures[0]).toContain(`+     {
+       "personId": "person-b",
+       "stepId": "step-b-dev",
+       "workItemId": "work-b-one",
+     },`);
    // Proof: broad replacement removes this complete expected same-step
    // survivor from the coherent assignment snapshots.
    expect(failures[1]).toContain(`-         {
-           "personId": "person-a",
-           "stepId": "step-a-dev",
-           "workItemId": "work-a-two",
-         },`);
    // Proof: the early real rename preserves ownership but changes the
    // complete received target team name after the refusal settles.
    expect(failures[2]).toContain(`    {
      "id": "team-a",
-     "name": "Directory original",
+     "name": "Directory escaped",
      "serviceIds": [
        "service-a",
      ],
    },`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'directory.assign:scope-replace-clear', status: 'passed' },
      { caseId: 'directory.patchTeam:atomic-refusal', status: 'passed' },
    ]);
  });

  it('reinjects retained-maximum event sequence allocation', async () => {
    const proof = await proveFault(eventRetainedMaximumFault);

    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error('retained-maximum fault was not observed');
    expect(proof.phase).toBe('eventLog.pruneBeyond:empty-sequence:next-record');
    // Proof: deriving from retained MAX after prune-to-empty changes the next
    // returned complete record itself from sequence 2 to sequence 0.
    expect(Bun.stripANSI(proof.observedFailure)).toContain(`  {
    "createdAt": 201,
    "message": {
      "type": "empty-next",
    },
-   "seq": 2,
+   "seq": 0,
    "subscription": "project:project-a",
  }`);

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: [eventRetainedMaximumFault.caseId],
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'eventLog.pruneBeyond:empty-sequence', status: 'passed' },
    ]);
  });

  it('runs every Task 6.1 and 6.2 saved-plan case through the real SQLite source', async () => {
    const caseIds = [
      'savedPlans.write:bytes-and-bodies',
      'savedPlans.write:quota-refusal',
      'savedPlans.write:quota-window',
      'savedPlans.touch:principals-scope',
      'savedPlans.write:late-body-failure',
    ] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });
    const failure = report.cases.find(({ status }) => status === 'failed');
    if (failure?.status === 'failed') throw new Error(failure.failure);
    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects all seven Task 6.1 saved-plan faults through SQLite state', async () => {
    const faults = [
      savedPlanUtf8LengthFault,
      savedPlanHeaderOnlyFault,
      savedPlanAlteredBodyFault,
      savedPlanAlteredHashFault,
      savedPlanPrincipalFault,
      savedPlanUnknownRenameFault,
      savedPlanUnknownDeleteFault,
    ];
    const proofs = [];
    for (const fault of faults) proofs.push(await proveFault(fault));

    expect(proofs.map(({ kind }) => kind)).toEqual(faults.map(() => 'observed'));
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'saved-plan:utf8-length',
      'saved-plan:header-only',
      'saved-plan:body-bytes',
      'saved-plan:body-hash',
      'saved-plan:principals',
      'saved-plan:unknown-rename',
      'saved-plan:unknown-delete',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('-     "inputBytes": 6,');
    expect(failures[0]).toContain('+     "inputBytes": 4,');
    expect(failures[0]).toContain('-     "scheduleBytes": 2,');
    expect(failures[0]).toContain('+     "scheduleBytes": 1,');
    expect(failures[1]).toContain('-     "input": "A🔦B",');
    expect(failures[1]).toContain('+     "input": null,');
    expect(failures[1]).toContain('-     "schedule": "é",');
    expect(failures[1]).toContain('+     "schedule": null,');
    expect(failures[2]).toContain('-     "input": "A🔦B",');
    expect(failures[2]).toContain('+     "input": "A🔦C",');
    expect(failures[3]).toContain('-     "scheduleSha256": "schedule-hash-present",');
    expect(failures[3]).toContain('+     "scheduleSha256": "schedule-hash-altered",');
    expect(failures[4]).toContain('-     "createdById": "owner-b",');
    expect(failures[4]).toContain('+     "createdById": "owner-a",');
    expect(failures[5]).toContain('Expected: "no_such_plan"');
    expect(failures[5]).toContain('Received: "touched"');
    expect(failures[6]).toContain('Expected: "no_such_plan"');
    expect(failures[6]).toContain('Received: "touched"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'savedPlans.write:bytes-and-bodies', status: 'passed' },
      { caseId: 'savedPlans.touch:principals-scope', status: 'passed' },
    ]);
  });

  it('reinjects Task 6.2 saved-plan faults through SQLite transactions', async () => {
    const faults = [
      savedPlanPersistedRefusalFault,
      savedPlanStaleQuotaFault,
      savedPlanSplitWriteFault,
    ];
    const proofs = [];
    for (const fault of faults) proofs.push(await proveFault(fault));
    expect(proofs.map(({ kind }) => kind)).toEqual(['observed', 'observed', 'observed']);
    expect(proofs.map((proof) => (proof.kind === 'observed' ? proof.phase : null))).toEqual([
      'saved-plan:quota-refusal:persisted',
      'saved-plan:quota-window:stale-check',
      'saved-plan:late-body:split-transaction',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('+           "id": "quota-refused",');
    expect(failures[1]).toContain(`    "rivalOutcome": {
-     "outcome": "snapshot_busy",
+     "outcome": "written",
    },`);
    expect(failures[1]).toContain(`+       {
+         "bodies": {
+           "input": "rival-🚫",
+           "schedule": null,
+         },
+         "header": {
+           "createdAt": 513,
+           "createdBy": "Quota Writer",
+           "createdById": "owner-b",
+           "id": "quota-window-rival",
+           "inputBytes": 10,
+           "inputSchemaVersion": 11,
+           "inputSha256": "a2587844f6a3f32d7fa53ae64c1109cf97b7dfa12912a794afca9d56ad317b70",
+           "name": "Quota window rival",
+           "projectId": "project-a",
+           "scheduleAbsentReason": "pending",
+           "scheduleBytes": null,
+           "scheduleInputSha256": null,
+           "scheduleSchemaVersion": null,
+           "scheduleSha256": null,
+           "schedulerAlgorithmId": null,
+         },
+       },`);
    expect(failures[2]).toContain('+           "input": "late-input-🔧",');
    expect(failures[2]).toContain('+           "schedule": null,');
  });

  it('rejects canonical SQLite split reach for wrong target, content, or phase', async () => {
    const proofs = [];
    const probes: SavedPlanPhaseProbe[] = [];
    for (const corruption of ['wrong-target', 'altered-content', 'wrong-body-phase'] as const) {
      const probe: SavedPlanPhaseProbe = {
        attempts: 0,
        closeCalls: 0,
        state: null,
        boundary: null,
        observations: [],
      };
      probes.push(probe);
      proofs.push(
        await proveFault(
          savedPlanSplitWriteFault,
          openSqliteSource,
          (source) => {
            const owned = {
              ...source,
              async close() {
                probe.closeCalls += 1;
                await closeAfterSavedPlanSnapshot(
                  source,
                  ['late-target', 'wrong-late-target', 'late-sentinel', 'saved-other-project'],
                  (state) => {
                    probe.state = state;
                  },
                );
              },
            };
            return withSavedPlans(
              owned,
              replaceSavedPlanWrite(source.history.savedPlans, (write) => async (plan, check) => {
                if (plan.id !== 'late-target') return write(plan, check);
                probe.attempts += 1;
                if (corruption === 'wrong-target') Object.assign(plan, { id: 'wrong-late-target' });
                else if (corruption === 'altered-content') {
                  Object.assign(plan, {
                    name: 'ALTERED TARGET',
                    createdBy: 'ALTERED DISPLAY',
                  });
                  Object.assign(plan.input, { bytes: 'ALTERED BODY', sha256: 'ALTERED HASH' });
                } else
                  Object.assign(plan, { schedule: { present: false, absentReason: 'pending' } });
                try {
                  return await write(plan, async (holding, incomingBytes) => {
                    probe.observations?.push({
                      holding: { plans: holding.plans, bytes: holding.bytes },
                      incomingBytes,
                    });
                    return check(holding, incomingBytes);
                  });
                } catch (failure) {
                  probe.failure = failure;
                  throw failure;
                }
              }),
            );
          },
          () => Promise.resolve(),
          () => undefined,
          (stored) => {
            probe.boundary = stored ?? null;
          },
        ),
      );
    }

    expect(proofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    const sentinels = [
      expectedTask62Plan(
        'late-sentinel',
        'Late sentinel',
        521,
        'held-🔒',
        9,
        'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
      ),
      task62OtherPlan(),
    ];
    const canonical = expectedTask62Plan(
      'late-target',
      'Late target',
      522,
      'late-input-🔧',
      15,
      '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
      {
        body: 'late-schedule-📆',
        bytes: 18,
        sha256: '67f1fdbc1d60444b0f4a7e14af440a54c9be6cb9004c37a71db3a6c70745d160',
      },
    );
    expect(probes[0]).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: expectedTask62PublicState(
        ['late-target', 'wrong-late-target', 'late-sentinel', 'saved-other-project'],
        sentinels,
      ),
      boundary: {
        header: { ...canonical.header, id: 'wrong-late-target' },
        bodies: { input: canonical.bodies.input, schedule: null },
      },
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 33 }],
      failure: expect.objectContaining({
        message: 'saved-plan split target did not cross its transaction boundary',
      }),
    });
    const altered = {
      header: {
        ...canonical.header,
        name: 'ALTERED TARGET',
        createdBy: 'ALTERED DISPLAY',
        inputBytes: 12,
        inputSha256: 'ALTERED HASH',
      },
      bodies: { input: 'ALTERED BODY', schedule: null },
    };
    expect(probes[1]).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: expectedTask62PublicState(
        ['late-target', 'wrong-late-target', 'late-sentinel', 'saved-other-project'],
        [altered, ...sentinels],
      ),
      boundary: altered,
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 30 }],
      failure: expect.objectContaining({
        message: 'saved-plan split boundary does not match the canonical target',
      }),
    });
    const wrongPhase = expectedTask62Plan(
      'late-target',
      'Late target',
      522,
      'late-input-🔧',
      15,
      '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
    );
    expect(probes[2]).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: expectedTask62PublicState(
        ['late-target', 'wrong-late-target', 'late-sentinel', 'saved-other-project'],
        [wrongPhase, ...sentinels],
      ),
      boundary: null,
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 15 }],
    });
  });

  it('rejects missing real SQLite input persistence before the late boundary', async () => {
    Object.assign(sqliteMissingInputProbe, {
      attempts: 0,
      closeCalls: 0,
      state: null,
      boundary: null,
      observations: [],
      failure: null,
    });
    const proof = await proveFault(savedPlanMissingInputFault);
    expect(proof.kind).toBe('phase-failed');
    if (proof.kind !== 'phase-failed') throw new Error('missing-input late fault reached');
    expect(proof.failure).toContain('fault did not reach saved-plan:late-body:missing-input');
    const target = expectedTask62Plan(
      'late-target',
      'Late target',
      522,
      'late-input-🔧',
      15,
      '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
      {
        body: 'late-schedule-📆',
        bytes: 18,
        sha256: '67f1fdbc1d60444b0f4a7e14af440a54c9be6cb9004c37a71db3a6c70745d160',
      },
    );
    expect(sqliteMissingInputProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      boundary: { ...target, bodies: { input: null, schedule: null } },
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 33 }],
      failure: expect.objectContaining({
        message: 'saved-plan schedule boundary lacks complete header and input',
      }),
      state: expectedTask62PublicState(
        ['late-target', 'late-sentinel', 'saved-other-project'],
        [
          expectedTask62Plan(
            'late-sentinel',
            'Late sentinel',
            521,
            'held-🔒',
            9,
            'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
          ),
          task62OtherPlan(),
        ],
      ),
    });
  });

  it('closes and removes SQLite state after a snapshot read fails, preserving close failure', async () => {
    for (const closeFails of [false, true]) {
      const { source, directory } = await seedSqliteSource();
      const readFailure = new Error('injected saved-plan snapshot read failure');
      const closeFailure = new Error('injected SQLite close failure');
      let closeCalls = 0;
      const failing = withSavedPlans(
        {
          ...source,
          async close() {
            closeCalls += 1;
            await source.close();
            if (closeFails) throw closeFailure;
          },
        },
        replaceMethod(
          source.history.savedPlans,
          'readOf',
          (readOf) => (savedPlanId) =>
            savedPlanId === 'late-target' ? Promise.reject(readFailure) : readOf(savedPlanId),
        ),
      );
      let failure: unknown;
      try {
        await closeSqliteResources(
          {
            ...failing,
            close: () =>
              closeAfterSavedPlanSnapshot(
                failing,
                ['late-target', 'late-sentinel', 'saved-other-project'],
                () => undefined,
              ),
          },
          directory,
        );
      } catch (cause) {
        failure = cause;
      }

      // Proof: awaiting the rejected reader first left the real connection alive even
      // though directory cleanup still ran; both owners must run when each reports failure.
      expect({ closeCalls, directoryExists: existsSync(directory) }).toEqual({
        closeCalls: 1,
        directoryExists: false,
      });
      expect(() => source.db.all(sql.raw('select 1 as alive'))).toThrow();
      if (closeFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toHaveProperty('errors', [readFailure, closeFailure]);
        expect(failure).toHaveProperty('cause', closeFailure);
      } else expect(failure).toBe(readFailure);
    }
  });

  it('rejects Task 6.2 SQLite proofs when each mutation is removed', async () => {
    const proofs = [];
    for (const fault of [
      savedPlanRefusalNoMutationFault,
      savedPlanWindowNoMutationFault,
      savedPlanLateNoMutationFault,
    ]) {
      proofs.push(await proveFault(fault));
    }
    expect(proofs.map(({ kind }) => kind)).toEqual([
      'assertion-passed',
      'assertion-passed',
      'assertion-passed',
    ]);
  });

  it('rejects Task 6.2 SQLite failures before their named phases and closes once', async () => {
    sqlitePrematureProbes.forEach((probe) => {
      probe.attempts = 0;
      probe.closeCalls = 0;
      probe.state = null;
    });
    const proofs = [];
    for (const fault of [
      savedPlanRefusalPrematureFault,
      savedPlanWindowPrematureFault,
      savedPlanLatePrematureFault,
    ])
      proofs.push(await proveFault(fault));
    expect(proofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    expect(
      sqlitePrematureProbes.map(({ attempts, closeCalls }) => ({ attempts, closeCalls })),
    ).toEqual([
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
    ]);
    // Proof: replacing any target with a prewrite throw now records the complete
    // independently read A/B state and cannot masquerade as the intended phase.
    expect(sqlitePrematureProbes.map(({ state }) => state)).toEqual(
      expectedPrematureTask62States(),
    );
  });

  it('rejects Task 6.2 SQLite mutations when their proof reach is removed', async () => {
    const proofs = [];
    for (const fault of [
      savedPlanRefusalNoReachFault,
      savedPlanWindowNoReachFault,
      savedPlanLateNoReachFault,
    ])
      proofs.push(await proveFault(fault));
    expect(proofs.map(({ kind }) => kind)).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
  });

  it('snapshots SQLite quota callback values before an adapter can repair aliases', async () => {
    const { source, directory } = await seedSqliteSource();
    let closeCalls = 0;
    const port = replaceSavedPlanWrite(
      source.history.savedPlans,
      (write) => (plan, check) =>
        write(plan, async (holding, incomingBytes) => {
          if (plan.id !== 'quota-refused') return check(holding, incomingBytes);
          const aliased = { plans: holding.plans, bytes: -777 };
          const refusal = await check(aliased, incomingBytes);
          aliased.bytes = holding.bytes;
          return refusal;
        }),
    );
    const report = await runCases(
      existingStoreRegistrations({
        ...openers,
        savedPlans: (caseId) =>
          Promise.resolve({
            fixtureId: `sqlite:${caseId}`,
            port,
            journalAppender: source.stores.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: { kind: 'ordinary' },
            close: async () => {
              closeCalls += 1;
              await closeSqliteResources(source, directory);
            },
          }),
      }),
      { focus: ['savedPlans.write:quota-refusal'] },
    );
    const failure = report.cases[0];
    expect(failure.status).toBe('failed');
    if (failure.status !== 'failed') throw new Error('mutable holding probe unexpectedly passed');
    // Proof: the real SQLite callback received -777 and repaired its object afterward;
    // the shared snapshot retained -777 beside the complete settled state.
    expect(Bun.stripANSI(failure.failure)).toContain('+         "bytes": -777,');
    expect(closeCalls).toBe(1);
  });

  it('rejects an in-place late target mutation against the detached SQLite request', async () => {
    let closeCalls = 0;
    let targetAttempts = 0;
    let callbackCalls = 0;
    let mutationCalls = 0;
    let operationFailure: unknown;
    let boundary: StoredSavedPlan | undefined;
    let finalState: SavedPlanPublicState | undefined;
    const observations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
    const report = await runCases(
      existingStoreRegistrations({
        ...openers,
        savedPlans: async (caseId) => {
          const fixture = await openSqliteSavedPlanCase(caseId, (evidence) => {
            boundary = evidence.savedPlan;
          });
          const port = replaceSavedPlanWrite(fixture.port, (write) => async (plan, check) => {
            if (plan.id === 'late-target') targetAttempts += 1;
            try {
              return await write(plan, async (holding, incomingBytes) => {
                if (plan.id === 'late-target') {
                  callbackCalls += 1;
                  observations.push({
                    holding: { plans: holding.plans, bytes: holding.bytes },
                    incomingBytes,
                  });
                }
                const refusal = await check(holding, incomingBytes);
                if (plan.id === 'late-target') {
                  mutationCalls += 1;
                  Object.assign(plan, { name: 'CORRUPTED TARGET', createdBy: 'CORRUPTED DISPLAY' });
                  Object.assign(plan.input, { bytes: 'WRONG INPUT', sha256: 'WRONG HASH' });
                }
                return refusal;
              });
            } catch (failure) {
              if (plan.id === 'late-target') operationFailure = failure;
              throw failure;
            }
          });
          return {
            ...fixture,
            port,
            async close() {
              closeCalls += 1;
              await closeAfterSavedPlanSnapshot(
                {
                  history: { savedPlans: fixture.readers.savedPlans },
                  close: () => fixture.close(),
                },
                ['late-target', 'late-sentinel', 'saved-other-project'],
                (state) => {
                  finalState = state;
                },
              );
            },
          };
        },
      }),
      { focus: ['savedPlans.write:late-body-failure'] },
    );

    const execution = report.cases[0];
    expect(execution.status).toBe('failed');
    if (execution.status !== 'failed') throw new Error('mutated late SQLite request passed');
    // Proof: mutating the real request after its callback used to reach and certify the
    // corrupted rows; the detached boundary now refuses them and rolls the target back.
    expect(Bun.stripANSI(execution.failure)).toContain('+   "reached": false,');
    expect(operationFailure).toHaveProperty(
      'message',
      'saved-plan schedule boundary lacks complete header and input',
    );
    expect({ targetAttempts, callbackCalls, mutationCalls, observations }).toEqual({
      targetAttempts: 1,
      callbackCalls: 1,
      mutationCalls: 1,
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 33 }],
    });
    const target = expectedTask62Plan(
      'late-target',
      'Late target',
      522,
      'late-input-🔧',
      15,
      '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
      {
        body: 'late-schedule-📆',
        bytes: 18,
        sha256: '67f1fdbc1d60444b0f4a7e14af440a54c9be6cb9004c37a71db3a6c70745d160',
      },
    );
    expect(boundary).toEqual({
      header: {
        ...target.header,
        name: 'CORRUPTED TARGET',
        createdBy: 'CORRUPTED DISPLAY',
        inputSha256: 'WRONG HASH',
      },
      bodies: { input: 'WRONG INPUT', schedule: null },
    });
    expect(finalState).toEqual(
      expectedTask62PublicState(
        ['late-target', 'late-sentinel', 'saved-other-project'],
        [
          expectedTask62Plan(
            'late-sentinel',
            'Late sentinel',
            521,
            'held-🔒',
            9,
            'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355',
          ),
          task62OtherPlan(),
        ],
      ),
    );
    expect(closeCalls).toBe(1);
  });

  it('requires complete SQLite setup before a target can restore a deleted sentinel', async () => {
    const { source, directory } = await seedSqliteSource();
    let targetAttempts = 0;
    let closeCalls = 0;
    const base = source.history.savedPlans;
    const port = replaceSavedPlanWrite(base, (write) => async (plan, check) => {
      if (plan.id === 'quota-refused') {
        targetAttempts += 1;
        await base.write(
          {
            id: 'saved-other-project',
            projectId: 'project-b',
            name: 'Other project sentinel',
            createdBy: 'Quota Writer',
            createdById: 'owner-b',
            createdAt: 500,
            input: {
              schemaVersion: 11,
              bytes: 'é',
              sha256: '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
            },
            schedule: { present: false, absentReason: 'pending' },
          },
          () => Promise.resolve(null),
        );
      }
      const outcome = await write(plan, check);
      if (plan.id === 'quota-held')
        expect(await base.deleteOf('saved-other-project')).toBe('touched');
      return outcome;
    });
    const report = await runCases(
      existingStoreRegistrations({
        ...openers,
        savedPlans: (caseId) =>
          Promise.resolve({
            fixtureId: `sqlite:${caseId}`,
            port,
            journalAppender: source.stores.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: { kind: 'ordinary' },
            close: async () => {
              closeCalls += 1;
              await closeSqliteResources(source, directory);
            },
          }),
      }),
      { focus: ['savedPlans.write:quota-refusal'] },
    );
    expect(report.cases[0]?.status).toBe('failed');
    // Proof: real deletion of project B after A setup fails the complete prerequisite
    // before the target wrapper can restore it.
    expect(targetAttempts).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it('settles and reports both SQLite quota-window errors before close', async () => {
    const { source, directory } = await seedSqliteSource();
    let rivalSettled = false;
    let closeCalls = 0;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', observeUnhandled);
    const base = source.history.savedPlans;
    const primary = replaceSavedPlanWrite(
      base,
      (write) => (plan, check) =>
        plan.id !== 'quota-window-last'
          ? write(plan, check)
          : write(plan, async (holding, incomingBytes) => {
              await check(holding, incomingBytes);
              await Bun.sleep(10);
              throw new Error('SQLite quota primary failure');
            }),
    );
    const rival = replaceSavedPlanWrite(base, (write) => async (plan, check) => {
      await write(plan, check);
      rivalSettled = true;
      throw new Error('SQLite quota rival failure');
    });
    let report;
    try {
      report = await runCases(
        existingStoreRegistrations({
          ...openers,
          savedPlans: (caseId) =>
            Promise.resolve({
              fixtureId: `sqlite:${caseId}`,
              port: primary,
              journalAppender: source.stores.journal,
              seed: DETERMINISTIC_SEED,
              readers: readersOf(source),
              scenario: {
                kind: 'competing-history-write',
                rivalWriter: rival,
                expectedRival: 'snapshot_busy',
              },
              close: async () => {
                closeCalls += 1;
                if (!rivalSettled)
                  throw new Error('SQLite source closed before quota rival settled');
                await closeSqliteResources(source, directory);
              },
            }),
        }),
        { focus: ['savedPlans.write:quota-window'] },
      );
    } finally {
      process.off('unhandledRejection', observeUnhandled);
    }
    const failure = report.cases[0];
    expect(failure.status).toBe('failed');
    if (failure.status !== 'failed') throw new Error('dual quota failure unexpectedly passed');
    // Proof: throwing after the real transaction callback still awaited the immediate-busy
    // rival wrapper; removing rival settlement lost its cause and closed too early.
    expect(failure.failure).toContain('quota primary and rival both failed');
    expect(failure.failure).toContain('SQLite quota primary failure');
    expect(failure.failure).toContain('SQLite quota rival failure');
    expect({ rivalSettled, closeCalls }).toEqual({ rivalSettled: true, closeCalls: 1 });
    expect(unhandled).toEqual([]);
  });

  it('refuses prewrite and successful-incomplete SQLite saved-plan proofs', async () => {
    const prewriteProbe: SavedPlanPhaseProbe = { attempts: 0, closeCalls: 0, state: null };
    const probes = Array.from({ length: 5 }, (): SavedPlanPhaseProbe => ({
      attempts: 0,
      closeCalls: 0,
      state: null,
    }));
    const [
      prewrite,
      utf8Partial,
      headerNoop,
      principalPartial,
      renameCollateral,
      deleteCollateral,
    ] = await Promise.all([
      proveFault(savedPlanUtf8LengthFault, openSqliteSource, (source) =>
        rejectSavedPlanBeforeWrite(source, prewriteProbe),
      ),
      proveFault(savedPlanUtf8LengthFault, openSqliteSource, (source) =>
        weakenSavedPlanWrite(source, probes[0], 'bodies'),
      ),
      proveFault(savedPlanHeaderOnlyFault, openSqliteSource, (source) =>
        weakenSavedPlanWrite(source, probes[1], 'bodies'),
      ),
      proveFault(savedPlanPrincipalFault, openSqliteSource, (source) =>
        weakenSavedPlanWrite(source, probes[2], 'creator-display'),
      ),
      proveFault(savedPlanUnknownRenameFault, openSqliteSource, (source) =>
        collateralSavedPlanTouch(source, probes[3], 'renameTo'),
      ),
      proveFault(savedPlanUnknownDeleteFault, openSqliteSource, (source) =>
        collateralSavedPlanTouch(source, probes[4], 'deleteOf'),
      ),
    ]);

    // Proof: the historical unguarded preflight classified these five faults as
    // observed; the complete prerequisites now keep every lower-path run phase-failed.
    expect(
      [prewrite, utf8Partial, headerNoop, principalPartial, renameCollateral, deleteCollateral].map(
        ({ kind }) => kind,
      ),
    ).toEqual([
      'phase-failed',
      'phase-failed',
      'phase-failed',
      'phase-failed',
      'phase-failed',
      'phase-failed',
    ]);
    expect(
      [prewrite, utf8Partial, headerNoop, principalPartial, renameCollateral, deleteCollateral].map(
        (proof) =>
          proof.kind === 'phase-failed' ? { phase: proof.phase, failure: proof.failure } : null,
      ),
    ).toEqual([
      { phase: 'saved-plan:utf8-length', failure: 'fault did not reach saved-plan:utf8-length' },
      { phase: 'saved-plan:utf8-length', failure: 'fault did not reach saved-plan:utf8-length' },
      { phase: 'saved-plan:header-only', failure: 'fault did not reach saved-plan:header-only' },
      { phase: 'saved-plan:principals', failure: 'fault did not reach saved-plan:principals' },
      {
        phase: 'saved-plan:unknown-rename',
        failure: 'fault did not reach saved-plan:unknown-rename',
      },
      {
        phase: 'saved-plan:unknown-delete',
        failure: 'fault did not reach saved-plan:unknown-delete',
      },
    ]);
    expect(prewriteProbe).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: { reads: [null, null], lists: [[], []], principals: [null, null] },
    });
    // Proof: suppressing only the lower real writes left the body states null and
    // creator state empty; this equality failed with Expected - 166 / Received + 5.
    expect(probes).toEqual([
      { attempts: 1, closeCalls: 1, state: expectedTask61PartialBodiesState() },
      { attempts: 1, closeCalls: 1, state: expectedTask61PartialBodiesState() },
      { attempts: 1, closeCalls: 1, state: expectedTask61PartialCreatorState() },
      { attempts: 1, closeCalls: 1, state: expectedTask61CollateralState() },
      { attempts: 1, closeCalls: 1, state: expectedTask61CollateralState() },
    ]);
  });

  it('rejects a zero-row SQLite saved-plan mutation at its affected-row guard', async () => {
    const probe: SavedPlanAffectedRowProbe = {
      attempts: 0,
      closeCalls: 0,
      changes: null,
      state: null,
    };
    const proof = await proveFault(savedPlanAffectedRowFault(probe), openSqliteSource, (source) =>
      countSavedPlanClose(source, probe),
    );

    expect(proof.kind).toBe('phase-failed');
    if (proof.kind !== 'phase-failed') throw new Error(`expected phase failure, got ${proof.kind}`);
    expect(proof.failure).toBe('fault did not reach saved-plan:affected-row');
    const present = expectedTask61Present();
    expect(probe).toEqual({
      attempts: 1,
      closeCalls: 1,
      changes: 0,
      state: {
        reads: [present, null],
        lists: [[present.header], []],
        principals: [
          {
            savedPlanId: 'saved-present',
            projectId: 'project-a',
            projectOwnerId: 'owner-a',
            createdById: 'owner-b',
          },
          null,
        ],
      },
    });
  });
});
