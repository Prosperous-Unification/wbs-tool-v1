import {
  assertCompleteStateAlternative,
  assertFaultVariantCoverage,
  assertSeedState,
  brokenSource,
  type Capabilities,
  type CaptureDirectoryChange,
  type CaseFixture,
  type CaseId,
  completeSubtreeCopy,
  createFaultControl,
  defineFault,
  DEPENDENCY_SURVIVOR_IDS,
  DETERMINISTIC_SEED,
  type ExecutionReport,
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
  CommandJournalStore,
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
  StoredProgress,
  StoredSavedPlan,
  SubtreeCopy,
  SubtreeStore,
  TeamWithServices,
  TransactionalStores,
  User,
  WriteStamp,
} from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { inMemoryDependencies } from '../dependency-fixture';
import type { MemoryLateWriteEvidence } from '../late-write-seam';
import { projectRow } from '../project-fixture';
import {
  openMemorySourceFixture,
  openMemorySourceWithCaptureReadSeam,
  openMemorySourceWithLateWriteSeam,
} from '../source';
import {
  type MemoryLateWriteControl,
  memoryLateWriteControl,
  type MemoryLateWritePoint,
} from './faults';

type ExistingFamily = Exclude<keyof ExistingStoreOpeners, 'savedPlans' | 'savedPlanCapture'>;
type MemorySource = ReturnType<typeof openMemorySourceFixture>['source'] & {
  captureWithStagedDirectoryRollback: ReturnType<
    typeof openMemorySourceFixture
  >['captureWithStagedDirectoryRollback'];
  deriveNextEventSeqFromRetained(subscription: string): void;
  independentJournalHistoryFor(): Promise<PlanEvent[]>;
  routeJournalEventToIndependent(eventId: string): PlanEvent;
  storeDependencyById(dependency: StoredDependency): void;
  insertSubtree(copy: SubtreeCopy, stamp: WriteStamp): Promise<void>;
  journal: CommandJournalStore;
  setSavedPlanByteCounts(savedPlanId: string, inputBytes: number, scheduleBytes: number): void;
  removeSavedPlanBodies(savedPlanId: string): void;
  replaceSavedPlanInputBody(savedPlanId: string, bytes: string): void;
  replaceSavedPlanScheduleHash(savedPlanId: string, sha256: string): void;
  writeSavedPlanSplit: ReturnType<typeof openMemorySourceFixture>['writeSavedPlanSplit'];
  writeSavedPlanThroughCommandCoordinator: ReturnType<
    typeof openMemorySourceFixture
  >['writeSavedPlanThroughCommandCoordinator'];
  claimSavedPlanWriteWithoutState: ReturnType<
    typeof openMemorySourceFixture
  >['claimSavedPlanWriteWithoutState'];
  activateCommandHistoryStage: ReturnType<
    typeof openMemorySourceFixture
  >['activateCommandHistoryStage'];
  discardCommandHistoryStage: ReturnType<
    typeof openMemorySourceFixture
  >['discardCommandHistoryStage'];
  commandStagedSavedPlans: ReturnType<typeof openMemorySourceFixture>['commandStagedSavedPlans'];
  quotaRivalOwner?: { settlement?: Promise<unknown> };
};
type OpenSource = () => MemorySource;
type SavedPlanCheck<Refusal> = (
  holding: SavedPlanHoldingRow,
  incomingBytes: number,
) => Promise<Refusal | null>;

function openConformanceMemorySource(): MemorySource {
  return conformanceMemorySource(openMemorySourceFixture());
}

function conformanceMemorySource(
  fixture: ReturnType<typeof openMemorySourceFixture>,
): MemorySource {
  const source = {
    ...fixture.source,
    captureWithStagedDirectoryRollback: (
      ...args: Parameters<typeof fixture.captureWithStagedDirectoryRollback>
    ) => fixture.captureWithStagedDirectoryRollback(...args),
    writeSavedPlanThroughCommandCoordinator: <Refusal>(
      plan: SavedPlanWrite,
      check: SavedPlanCheck<Refusal>,
    ) => fixture.writeSavedPlanThroughCommandCoordinator(plan, check),
    claimSavedPlanWriteWithoutState: <Refusal>(
      plan: SavedPlanWrite,
      check: SavedPlanCheck<Refusal>,
    ) => fixture.claimSavedPlanWriteWithoutState(plan, check),
    activateCommandHistoryStage: () => {
      fixture.activateCommandHistoryStage();
    },
    discardCommandHistoryStage: () => {
      fixture.discardCommandHistoryStage();
    },
    commandStagedSavedPlans: fixture.commandStagedSavedPlans,
    deriveNextEventSeqFromRetained: (subscription: string) => {
      fixture.deriveNextEventSeqFromRetained(subscription);
    },
    independentJournalHistoryFor: () => fixture.independentJournalHistoryFor(),
    routeJournalEventToIndependent: (eventId: string) =>
      fixture.routeJournalEventToIndependent(eventId),
    storeDependencyById: (dependency: StoredDependency) => {
      fixture.storeDependencyById(dependency);
    },
    insertSubtree: (copy: SubtreeCopy, stamp: WriteStamp) =>
      fixture.source.uow.run(async ({ stores }) => {
        await stores.subtrees.insertSubtree(copy, stamp);
        return { commit: true, value: undefined };
      }),
    setSavedPlanByteCounts(savedPlanId: string, inputBytes: number, scheduleBytes: number) {
      fixture.setSavedPlanByteCounts(savedPlanId, inputBytes, scheduleBytes);
    },
    removeSavedPlanBodies(savedPlanId: string) {
      fixture.removeSavedPlanBodies(savedPlanId);
    },
    replaceSavedPlanInputBody(savedPlanId: string, bytes: string) {
      fixture.replaceSavedPlanInputBody(savedPlanId, bytes);
    },
    replaceSavedPlanScheduleHash(savedPlanId: string, sha256: string) {
      fixture.replaceSavedPlanScheduleHash(savedPlanId, sha256);
    },
    writeSavedPlanSplit: <Refusal>(
      plan: SavedPlanWrite,
      check: SavedPlanCheck<Refusal>,
      includeInput: boolean,
      observeBoundary?: (stored: StoredSavedPlan) => void,
    ) => fixture.writeSavedPlanSplit(plan, check, includeInput, observeBoundary),
  };
  return { ...source, journal: transactionalJournal(source as MemorySource) };
}

function readersOf(source: MemorySource): SourceReaders {
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

async function throwAfterMemoryCleanup(failure: unknown, source: MemorySource): Promise<never> {
  try {
    await source.close();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      'memory source setup and cleanup both failed',
      { cause: cleanupFailure },
    );
  }
  throw failure;
}

async function seedMemorySource(
  openSource: OpenSource = openConformanceMemorySource,
  finishSeed?: (source: MemorySource) => Promise<void>,
): Promise<MemorySource> {
  const source = openSource();
  try {
    const { stores } = source;
    const seed = DETERMINISTIC_SEED;
    for (const [index, ownerId] of seed.ownerIds.entries()) {
      const stamp = seed.stamps[index] ?? seed.stamps[0];
      await stores.users.create(
        {
          id: ownerId,
          username: `owner-${String(index + 1)}`,
          passwordHash: 'x',
          createdAt: stamp.at,
        },
        stamp,
      );
      const projectId = seed.projectIds[index] ?? seed.projectIds[0];
      const stepIds = seed.stepIds[index] ?? seed.stepIds[0];
      const starting = stepIds.map((id, stepIndex) => ({
        id,
        projectId,
        name: stepIndex === 0 ? 'Dev' : 'QA',
        position: (stepIndex + 1) * 10,
      }));
      await stores.projects.create(
        projectRow({
          id: projectId,
          ownerId,
          name: `Project ${String(index + 1)}`,
          createdAt: stamp.at,
        }),
        starting,
        stamp,
      );
      for (const step of starting) await stores.steps.add(step, stamp);
      const workItemIds = seed.workItemIds[index] ?? seed.workItemIds[0];
      for (const [rowIndex, id] of workItemIds.entries()) {
        await stores.workItems.insert(
          workItemRow({ id, projectId, name: `Work ${String(rowIndex + 1)}` }),
          [],
          stamp,
        );
      }
    }
    for (const [index, teamId] of seed.teamIds.entries()) {
      await stores.directory.addTeam(
        { id: teamId, name: `Team ${String(index + 1)}` },
        seed.stamps[0],
      );
    }
    await stores.directory.addTag({ id: seed.tagIds[0], name: 'Tag 1' }, seed.stamps[0]);
    await stores.directory.addService(
      { id: seed.serviceIds[0], name: 'Service 1' },
      seed.stamps[0],
    );
    await stores.directory.addWorkItemType({ id: seed.typeIds[0], name: 'Type 1' }, seed.stamps[0]);
    for (const [index, personId] of seed.personIds.entries()) {
      await stores.directory.addPerson(
        { id: personId, name: `Person ${String(index + 1)}` },
        [seed.teamIds[index] ?? seed.teamIds[0]],
        seed.stamps[0],
      );
    }
    await verifyMemorySeed(source);
    await finishSeed?.(source);
    return source;
  } catch (failure) {
    return await throwAfterMemoryCleanup(failure, source);
  }
}

async function verifyMemorySeed(source: MemorySource): Promise<void> {
  const seed = DETERMINISTIC_SEED;
  for (const [index, projectId] of seed.projectIds.entries()) {
    expect(await source.stores.projects.findById(projectId)).toMatchObject({
      id: projectId,
      ownerId: seed.ownerIds[index],
      name: `Project ${String(index + 1)}`,
    });
    expect((await source.stores.workItems.listByProject(projectId)).map(({ id }) => id)).toEqual([
      ...seed.workItemIds[index],
    ]);
  }
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

function memoryFixture<Family extends ExistingFamily>(
  source: MemorySource,
  family: Family,
  caseId: CaseId,
): CaseFixture<TransactionalStores[Family]> {
  return {
    fixtureId: `memory:${caseId}`,
    port: source.stores[family],
    journalAppender: source.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario: { kind: 'ordinary' },
    close: () => source.close(),
  };
}

async function openMemoryCase<Family extends ExistingFamily>(
  family: Family,
  caseId: CaseId,
  openSource: OpenSource = openConformanceMemorySource,
): Promise<CaseFixture<TransactionalStores[Family]>> {
  const lateControl =
    family === 'subtrees' && caseId === 'subtrees.insertSubtree:late-failure'
      ? memoryLateWriteControl('subtree-final-satellite')
      : family === 'journal' && caseId === 'journal.append:history-atomic'
        ? memoryLateWriteControl('journal-history-insert')
        : null;
  const selectedOpen = lateControl === null ? openSource : () => memoryLateSource(lateControl);
  const source = await seedMemorySource(selectedOpen, async (seeded) => {
    if (family === 'progress') await seedProgressStep(seeded);
    if (family === 'dependencies') await seedDependencyWorkItems(seeded);
    if (family === 'subtrees') await seedSubtreeRecords(seeded);
  });
  if (family === 'subtrees') {
    return {
      fixtureId: `memory:${caseId}`,
      port: transactionalSubtrees(source),
      journalAppender: source.journal,
      seed: DETERMINISTIC_SEED,
      readers: readersOf(source),
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
      close: () => source.close(),
    } as unknown as CaseFixture<TransactionalStores[Family]>;
  }
  if (family === 'journal') {
    return {
      fixtureId: `memory:${caseId}`,
      port: source.journal,
      journalAppender: source.journal,
      seed: DETERMINISTIC_SEED,
      readers: readersOf(source),
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
      close: () => source.close(),
    } as unknown as CaseFixture<TransactionalStores[Family]>;
  }
  return memoryFixture(source, family, caseId);
}

async function openMemorySavedPlanCase(
  caseId: CaseId,
  observeBoundary: (evidence: MemoryLateWriteEvidence) => void = () => undefined,
): Promise<CaseFixture<SavedPlanStore>> {
  const lateControl =
    caseId === 'savedPlans.write:late-body-failure'
      ? memoryLateWriteControl('saved-plan-schedule-body')
      : null;
  const source = await seedMemorySource(
    lateControl === null
      ? openConformanceMemorySource
      : () => memoryLateSource(lateControl, undefined, observeBoundary),
  );
  return {
    fixtureId: `memory:${caseId}`,
    port: source.history.savedPlans,
    journalAppender: source.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario:
      caseId === 'savedPlans.write:quota-window'
        ? {
            kind: 'competing-history-write',
            rivalWriter: source.history.savedPlans,
            expectedRival: 'quota-refused',
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
    close: () => source.close(),
  };
}

async function openMemorySavedPlanCaptureCase(
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
  const openSource =
    caseId === 'savedPlanCapture.readPlanInput:coherent-interleave'
      ? () =>
          conformanceMemorySource(
            openMemorySourceWithCaptureReadSeam({
              async afterFirstRead({ projectId, project }) {
                if (projectId !== 'project-a' || didEnter) return;
                if (project.id !== 'project-a' || project.name !== 'Captured project A')
                  throw new Error('memory capture first-read evidence is not project A');
                didEnter = true;
                enter();
                await released;
              },
            }),
          )
      : openConformanceMemorySource;
  const source = await seedMemorySource(openSource, async (seeded) => {
    await seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED);
  });
  return {
    fixtureId: `memory:${caseId}`,
    port: source.history.savedPlanCapture,
    journalAppender: source.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario:
      caseId === 'savedPlanCapture.readPlanInput:coherent-interleave'
        ? {
            kind: 'capture-interleave',
            firstRead: { entered, release },
            changeDirectory: () => changeMemoryCaptureDirectory(source),
          }
        : { kind: 'ordinary' },
    close: async () => {
      release();
      await source.close();
    },
  };
}

async function openMemoryHistoryBatchCase(
  caseId: CaseId,
  fault?:
    | 'command-coordinator'
    | 'claimed-write-without-state'
    | 'staged-owner'
    | 'staged-owner-wrong-body',
  lifecycle?: {
    readonly rejectAt?: 'update' | 'readback' | 'settlement';
    readonly rejectCleanup?: boolean;
    readonly onClose?: () => void;
    readonly onStagedLoss?: (id: string, stored: StoredSavedPlan | null) => void;
    readonly stageProof?: { reach(phase: 'complete-staged-write'): boolean };
  },
): Promise<HistoryBatchFixture> {
  const source = await seedMemorySource();
  const base = source.history.savedPlans;
  let stagedOutcome: SavedPlanWriteOutcome<unknown> | undefined;
  const port: SavedPlanStore =
    fault === undefined
      ? base
      : fault === 'staged-owner' || fault === 'staged-owner-wrong-body'
        ? {
            ...base,
            write: async (plan, check) => {
              const outcome = await source.commandStagedSavedPlans.write(
                fault === 'staged-owner-wrong-body'
                  ? { ...plan, input: { ...plan.input, bytes: 'wrong-stage-body' } }
                  : plan,
                check,
              );
              stagedOutcome = outcome;
              return outcome;
            },
          }
        : {
            ...base,
            write: <Refusal>(plan: SavedPlanWrite, check: SavedPlanCheck<Refusal>) =>
              fault === 'command-coordinator'
                ? source.writeSavedPlanThroughCommandCoordinator(plan, check)
                : source.claimSavedPlanWriteWithoutState(plan, check),
          };
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
  let batchFailureObserved = false;
  return {
    fixtureId: `memory:${caseId}`,
    port,
    journalAppender: source.journal,
    seed: DETERMINISTIC_SEED,
    readers: readersOf(source),
    scenario: {
      kind: 'batch-settlement',
      async begin() {
        if (batch !== undefined) throw new Error('memory history batch began twice');
        batch = source.uow.run(async ({ stores }) => {
          const projectId = DETERMINISTIC_SEED.projectIds[0];
          const stamp = { at: 700, by: DETERMINISTIC_SEED.ownerIds[0] };
          const updated = await (lifecycle?.rejectAt === 'update'
            ? Promise.reject(new Error('injected memory history update failure'))
            : stores.projects.update(projectId, { name: `Held ${caseId}` }, stamp));
          const observed = await (lifecycle?.rejectAt === 'readback'
            ? Promise.reject(new Error('injected memory history readback failure'))
            : stores.projects.findById(projectId));
          if (updated === null || observed?.name !== `Held ${caseId}`)
            throw new Error('memory history batch did not complete its in-scope update');
          if (fault === 'staged-owner' || fault === 'staged-owner-wrong-body')
            source.activateCommandHistoryStage();
          enter();
          const decision = await released;
          if (fault === 'staged-owner' || fault === 'staged-owner-wrong-body') {
            const staged = await source.commandStagedSavedPlans.readOf(
              'history-interleaved-rollback',
            );
            expect(staged).toEqual({
              header: {
                id: 'history-interleaved-rollback',
                projectId,
                name: 'Interleaved before rollback',
                createdBy: 'History Writer',
                createdById: DETERMINISTIC_SEED.ownerIds[1],
                createdAt: 732,
                inputSchemaVersion: 21,
                inputBytes: 20,
                inputSha256: 'history-hash-interleaved-rollback',
                scheduleSchemaVersion: null,
                scheduleBytes: null,
                scheduleSha256: null,
                scheduleInputSha256: null,
                schedulerAlgorithmId: null,
                scheduleAbsentReason: 'batch-survival',
              },
              bodies: { input: 'interleaved-rollback', schedule: null },
            });
            expect(stagedOutcome).toEqual({ outcome: 'written' });
            if (lifecycle?.stageProof !== undefined) {
              if (!lifecycle.stageProof.reach('complete-staged-write'))
                throw new Error('memory staged-history fault reached outside its named phase');
            }
            source.discardCommandHistoryStage();
          }
          if (lifecycle?.rejectAt === 'settlement')
            throw new Error('injected memory history settlement failure');
          return { commit: decision === 'commit', value: undefined };
        });
        try {
          await Promise.race([
            entered,
            batch.then(() => {
              throw new Error('memory history batch settled before admission');
            }),
          ]);
        } catch (failure) {
          batchFailureObserved = true;
          throw failure;
        }
      },
      entered,
      async settle(decision) {
        if (batch === undefined) throw new Error('memory history batch settled before begin');
        if (settled) throw new Error('memory history batch settled twice');
        settled = true;
        release(decision);
        try {
          await batch;
          if (fault === 'staged-owner' || fault === 'staged-owner-wrong-body') {
            const id = 'history-interleaved-rollback';
            lifecycle?.onStagedLoss?.(id, await base.readOf(id));
          }
        } catch (failure) {
          batchFailureObserved = true;
          throw failure;
        }
      },
    },
    close: async () => {
      let operationFailure: unknown;
      if (batch !== undefined && !settled) {
        settled = true;
        release('rollback');
        try {
          await batch;
        } catch (failure) {
          if (!batchFailureObserved) operationFailure = failure;
        }
      }
      source.discardCommandHistoryStage();
      try {
        lifecycle?.onClose?.();
        await source.close();
        if (lifecycle?.rejectCleanup === true)
          throw new Error('injected memory history cleanup failure');
      } catch (cleanupFailure) {
        if (operationFailure !== undefined)
          throw new AggregateError(
            [operationFailure, cleanupFailure],
            'memory history operation and cleanup both failed',
            { cause: cleanupFailure },
          );
        throw cleanupFailure;
      }
      if (operationFailure !== undefined)
        throw operationFailure instanceof Error
          ? operationFailure
          : new Error('memory history batch cleanup observed a non-Error failure', {
              cause: operationFailure,
            });
    },
  };
}

async function changeMemoryCaptureDirectory(source: MemorySource): Promise<CaptureDirectoryChange> {
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

async function seedProgressStep(source: MemorySource): Promise<void> {
  await source.stores.steps.add(
    {
      id: PROGRESS_SENTINEL_STEP_ID,
      projectId: DETERMINISTIC_SEED.projectIds[0],
      name: 'Review',
    },
    DETERMINISTIC_SEED.stamps[0],
  );
}

async function seedDependencyWorkItems(source: MemorySource): Promise<void> {
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

async function seedSubtreeRecords(source: MemorySource): Promise<void> {
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

function transactionalSubtrees(source: MemorySource): SubtreeStore {
  return {
    insertSubtree: (copy, stamp) => source.insertSubtree(copy, stamp),
  };
}

function transactionalJournal(source: MemorySource): CommandJournalStore {
  const commit = (write: (journal: CommandJournalStore) => Promise<void>) =>
    source.uow.run(async ({ stores }) => {
      await write(stores.journal);
      return { commit: true, value: undefined };
    });
  return {
    append: (entry, event) => commit((journal) => journal.append(entry, event)),
    entriesFor: (projectId, userId) => source.stores.journal.entriesFor(projectId, userId),
    flip: (id, undone, preconditions) =>
      commit((journal) => journal.flip(id, undone, preconditions)),
    restamp: (id, preconditions) => commit((journal) => journal.restamp(id, preconditions)),
    discard: (id) => commit((journal) => journal.discard(id)),
    stateOf: (projectId, userId) => source.stores.journal.stateOf(projectId, userId),
  };
}

function memoryLateSource(
  control: MemoryLateWriteControl<MemoryLateWritePoint>,
  reachProof?: () => void,
  observeBoundary: (evidence: MemoryLateWriteEvidence) => void = () => undefined,
): MemorySource {
  const fixture = openMemorySourceWithLateWriteSeam({
    isActive: (phase) => control.isArmed() && phase === control.phase,
    observeBoundary: (_phase, evidence) => {
      observeBoundary(evidence);
    },
    reach(phase, evidence) {
      if (control.reachStagedWrite(phase, evidence)) {
        reachProof?.();
        throw new Error(`injected memory fault at ${phase}`);
      }
    },
  });
  return conformanceMemorySource(fixture);
}

const openers: ExistingStoreOpeners = {
  projects: (caseId) => openMemoryCase('projects', caseId),
  users: (caseId) => openMemoryCase('users', caseId),
  capacity: (caseId) => openMemoryCase('capacity', caseId),
  priorityBands: (caseId) => openMemoryCase('priorityBands', caseId),
  calendarMarkers: (caseId) => openMemoryCase('calendarMarkers', caseId),
  workItems: (caseId) => openMemoryCase('workItems', caseId),
  steps: (caseId) => openMemoryCase('steps', caseId),
  estimates: (caseId) => openMemoryCase('estimates', caseId),
  actuals: (caseId) => openMemoryCase('actuals', caseId),
  measures: (caseId) => openMemoryCase('measures', caseId),
  progress: (caseId) => openMemoryCase('progress', caseId),
  dependencies: (caseId) => openMemoryCase('dependencies', caseId),
  directory: (caseId) => openMemoryCase('directory', caseId),
  eventLog: (caseId) => openMemoryCase('eventLog', caseId),
  planEvents: (caseId) => openMemoryCase('planEvents', caseId),
  subtrees: (caseId) => openMemoryCase('subtrees', caseId),
  journal: (caseId) => openMemoryCase('journal', caseId),
  savedPlans: (caseId) => openMemorySavedPlanCase(caseId),
  savedPlanCapture: (caseId) => openMemorySavedPlanCaptureCase(caseId),
};

const sourceOpeners = { ...openers, historyBatch: openMemoryHistoryBatchCase };

const unknownStepGap = {
  caseId: 'estimates.set:unknown_step' as const,
  reason: 'the memory estimate fixture does not validate step references',
  evidence: {
    sourceRevision: '3161e5fc',
    assertion: 'estimate set returns unknown_step for an absent step',
    observedFailure: 'Expected: "unknown_step"\nReceived: "written"',
  },
};

const actualUnknownStepGap = {
  caseId: 'actuals.set:unknown_step' as const,
  reason: 'the memory actual fixture does not validate step references',
  evidence: {
    sourceRevision: '686ea2bb',
    assertion: 'actual set refuses an absent step without changing either project',
    observedFailure: `-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "days": 13,
+       "recordedAt": 201,
+       "stepId": "no-such-step",
+       "workItemId": "work-a-one",
+     },`,
  },
};

const measureUnknownStepGap = {
  caseId: 'measures.set:unknown_step' as const,
  reason: 'the memory measure fixture does not validate step references',
  evidence: {
    sourceRevision: '00a1a609',
    assertion: 'measure set refuses an absent step without changing either project',
    observedFailure: `-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "metric": "token_estimate",
+       "recordedAt": 201,
+       "stepId": "no-such-step",
+       "value": 21,
+       "workItemId": "work-a-one",
+     },`,
  },
};

const progressUnknownStepGap = {
  caseId: 'progress.set:unknown_step' as const,
  reason: 'the memory progress fixture does not validate step references',
  evidence: {
    sourceRevision: 'dca55563',
    assertion: 'progress set refuses an absent step without changing either project',
    observedFailure: `-   "outcome": "unknown_step",
+   "outcome": "written",
    "projectA": [
+     {
+       "state": "done",
+       "statedAt": 201,
+       "stepId": "no-such-step",
+       "workItemId": "work-a-one",
+     },`,
  },
};

const capacityMissingReferenceGap = {
  caseId: 'capacity.set:missing-reference' as const,
  reason: 'the memory capacity fixture does not hold project or team reference sets',
  evidence: {
    sourceRevision: '52f961b5',
    assertion: 'capacity set refuses missing project and team references',
    observedFailure: 'Expected  - 6\n+ Received  + 14',
  },
};

const priorityMissingProjectGap = {
  caseId: 'priorityBands.replace:missing-project' as const,
  reason: 'the memory priority-band fixture does not hold a project reference set',
  evidence: {
    sourceRevision: '52f961b5',
    assertion: 'priority-band replacement refuses a missing project',
    observedFailure: 'Expected  - 16\n+ Received  + 15',
  },
};

const knownGaps = [
  unknownStepGap,
  actualUnknownStepGap,
  measureUnknownStepGap,
  progressUnknownStepGap,
  capacityMissingReferenceGap,
  priorityMissingProjectGap,
];

const declaration: SourceDeclaration = {
  name: 'memory',
  revision: sourceRevision(),
  historyAdmission: 'independent-write',
  capabilities: {
    projects: { kind: 'offered', gaps: [], open: openers.projects },
    users: { kind: 'offered', gaps: [], open: openers.users },
    capacity: {
      kind: 'offered',
      gaps: [capacityMissingReferenceGap],
      open: openers.capacity,
    },
    priorityBands: {
      kind: 'offered',
      gaps: [priorityMissingProjectGap],
      open: openers.priorityBands,
    },
    calendarMarkers: { kind: 'offered', gaps: [], open: openers.calendarMarkers },
    workItems: { kind: 'offered', gaps: [], open: openers.workItems },
    steps: { kind: 'offered', gaps: [], open: openers.steps },
    estimates: { kind: 'offered', gaps: [unknownStepGap], open: openers.estimates },
    actuals: { kind: 'offered', gaps: [actualUnknownStepGap], open: openers.actuals },
    measures: { kind: 'offered', gaps: [measureUnknownStepGap], open: openers.measures },
    progress: { kind: 'offered', gaps: [progressUnknownStepGap], open: openers.progress },
    dependencies: { kind: 'offered', gaps: [], open: openers.dependencies },
    directory: { kind: 'offered', gaps: [], open: openers.directory },
    eventLog: { kind: 'offered', gaps: [], open: openers.eventLog },
    planEvents: { kind: 'offered', gaps: [], open: openers.planEvents },
    subtrees: { kind: 'offered', gaps: [], open: openers.subtrees },
    journal: { kind: 'offered', gaps: [], open: openers.journal },
    savedPlans: { kind: 'offered', gaps: [], open: openers.savedPlans },
    savedPlanCapture: { kind: 'offered', gaps: [], open: openers.savedPlanCapture },
  } as unknown as Capabilities,
};

function withStores(source: MemorySource, stores: Partial<TransactionalStores>): MemorySource {
  return { ...source, stores: { ...source.stores, ...stores } };
}

function withSavedPlans(source: MemorySource, savedPlans: SavedPlanStore): MemorySource {
  return { ...source, history: { ...source.history, savedPlans } };
}

function withSavedPlanCapture(
  source: MemorySource,
  savedPlanCapture: SavedPlanCaptureStore,
): MemorySource {
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
  source: MemorySource,
  control: ReturnType<typeof createFaultControl>,
  mode: 'complete' | 'missing' | 'detached',
  mutateResult = true,
  targetId = mode === 'missing' ? 'capture-project-missing' : 'project-a',
): MemorySource {
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
  source: MemorySource,
  targetId: string,
  probe: { attempts: number; closeCalls: number },
): MemorySource {
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
  mutate: (source: MemorySource, control) => captureFaultSource(source, control, 'complete'),
});

const captureMissingFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:missing-project',
  caseId: 'savedPlanCapture.readPlanInput:missing-project',
  createControl: () => createFaultControl('saved-plan-capture:missing:empty-capture'),
  mutate: (source: MemorySource, control) => captureFaultSource(source, control, 'missing'),
});

const captureDetachedFault = defineFault({
  id: 'break:savedPlanCapture.readPlanInput:detached',
  caseId: 'savedPlanCapture.readPlanInput:detached',
  createControl: () => createFaultControl('saved-plan-capture:detached:shared-tags'),
  mutate: (source: MemorySource, control) => captureFaultSource(source, control, 'detached'),
});

function coherentCaptureFaultSource(
  source: MemorySource,
  control: ReturnType<typeof createFaultControl>,
  mutateResult = true,
  targetId = 'project-a',
): MemorySource {
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
  mutate: (source: MemorySource, control) => coherentCaptureFaultSource(source, control),
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return withStores(source, {
      capacity: replaceMethod(source.stores.capacity, 'set', (set) => {
        return (projectId, teamId, size, stamp) =>
          set(
            projectId,
            teamId,
            size === null && control.reach('capacity.set:clear') ? 0 : size,
            stamp,
          );
      }),
    });
  },
});

const priorityDefaultsFault = defineFault({
  id: 'break:priorityBands.listFor:defaults',
  caseId: 'priorityBands.listFor:defaults',
  createControl: () => createFaultControl('priorityBands.listFor:defaults'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
          await replace(DETERMINISTIC_SEED.projectIds[1], DEFAULT_PRIORITY_BANDS, stamp);
          return replace(projectId, bands, stamp);
        };
      }),
    });
  },
});

const markerOrderFault = defineFault({
  id: 'break:calendarMarkers.listFor:total-order',
  caseId: 'calendarMarkers.listFor:total-order',
  createControl: () => createFaultControl('calendarMarkers.listFor:total-order'),
  mutate(source: MemorySource, control) {
    const insertion = new Map<string, number>();
    let next = 0;
    const calendarMarkers = replaceMethod(
      source.stores.calendarMarkers,
      'create',
      (create) => async (marker) => {
        const written = await create(marker);
        if (written.ok) {
          insertion.set(marker.id, next);
          next += 1;
        }
        return written;
      },
    );
    return withStores(source, {
      calendarMarkers: replaceMethod(calendarMarkers, 'listFor', (listFor) => {
        return async (projectId) => {
          const markers = await listFor(projectId);
          if (!control.reach('calendarMarkers.listFor:total-order')) return markers;
          return markers.toSorted(
            (left, right) =>
              left.date.localeCompare(right.date) ||
              left.createdAt - right.createdAt ||
              (insertion.get(left.id) ?? -1) - (insertion.get(right.id) ?? -1),
          );
        };
      }),
    });
  },
});

const markerProjectScopeFault = defineFault({
  id: 'break:calendarMarkers.write:project-scope:marker-project-scope',
  caseId: 'calendarMarkers.write:project-scope',
  createControl: () => createFaultControl('calendarMarkers.write:project-scope:project-predicate'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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

const createUniqueNameFault = defineFault({
  id: 'break:users.create:unique-name',
  caseId: 'users.create:unique-name',
  createControl: () => createFaultControl('users.create:unique-name'),
  mutate(source: MemorySource, control) {
    const accounts = new Map<string, User>();
    return withStores(source, {
      users: replaceMethod(source.stores.users, 'create', (create) => async (user, stamp) => {
        const existing = accounts.get(user.username);
        if (existing !== undefined && control.reach('users.create:unique-name')) {
          Object.assign(existing, user);
          return user;
        }
        const created = await create(user, stamp);
        if (created !== null) accounts.set(user.username, user);
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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

const insertRespaceFault = defineFault({
  id: 'break:workItems.insert:respace',
  caseId: 'workItems.insert:respace',
  createControl: () => createFaultControl('workItems.insert:respace'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return withStores(source, {
      actuals: replaceMethod(source.stores.actuals, 'set', (set) => {
        return (actual, stamp) => {
          if (actual.stepId === 'no-such-step') control.reach('actuals.set:unknown_step');
          return set(actual, stamp);
        };
      }),
    });
  },
});

const measureSetPairIdentityFault = defineFault({
  id: 'break:measures.set:metric-key:measure-set-pair-identity',
  caseId: 'measures.set:metric-key',
  createControl: () => createFaultControl('measures.set:metric-key'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return withStores(source, {
      measures: replaceMethod(source.stores.measures, 'set', (set) => {
        return (measure, stamp) => {
          if (measure.stepId === 'no-such-step') control.reach('measures.set:unknown_step');
          return set(measure, stamp);
        };
      }),
    });
  },
});

const progressReplaceFault = defineFault({
  id: 'break:progress.set:replace',
  caseId: 'progress.set:replace',
  createControl: () => createFaultControl('progress.set:replace'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return withStores(source, {
      progress: replaceMethod(source.stores.progress, 'remove', (remove) => {
        return async (workItemId, stepId, stamp) => {
          await remove(workItemId, stepId, stamp);
          if (!control.reach('progress.remove:absence')) return;
          // Test boundary: the fault must cross the precise port with the
          // invalid stored value that production types deliberately exclude.
          const surrogate = {
            workItemId,
            stepId,
            state: 'not_started',
            statedAt: 201,
          } as unknown as StoredProgress;
          await source.stores.progress.set(surrogate, stamp);
        };
      }),
    });
  },
});

const progressMoveOwnershipFault = defineFault({
  id: 'break:progress.moveAll:ownership',
  caseId: 'progress.moveAll:ownership',
  createControl: () => createFaultControl('progress.moveAll:ownership'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return withStores(source, {
      progress: replaceMethod(source.stores.progress, 'set', (set) => {
        return (progress, stamp) => {
          if (progress.stepId === 'no-such-step') control.reach('progress.set:unknown_step');
          return set(progress, stamp);
        };
      }),
    });
  },
});

const dependencyIdFault = defineFault({
  id: 'break:dependencies.add:idempotent-pair:dependency-id',
  caseId: 'dependencies.add:idempotent-pair',
  createControl: () => createFaultControl('dependencies.add:idempotent-pair:edge-id'),
  mutate(source: MemorySource, control) {
    let setupAdds = 0;
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
          source.storeDependencyById(dependency);
          const storedPair = (await source.stores.dependencies.listByProject(dependency.projectId))
            .filter(
              (edge) =>
                edge.predecessorId === dependency.predecessorId &&
                edge.successorId === dependency.successorId,
            )
            .toSorted((left, right) => left.id.localeCompare(right.id));
          // Proof: disabling the source-owned ID insert left only the complete
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
          source.deriveNextEventSeqFromRetained(subscription);
          const recorded = await recordEvent(subscription, message, createdAt);
          control.reach('eventLog.pruneBeyond:empty-sequence:next-record');
          const retained = await source.stores.eventLog.rangeSince(subscription, -1);
          const latest = await source.stores.eventLog.latestSeq(subscription);
          if (
            retained.length !== 1 ||
            retained[0]?.seq !== recorded.seq ||
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

async function readTask52FlipState(source: MemorySource) {
  return {
    entries: await Promise.all([
      source.journal.entriesFor('project-a', 'owner-a'),
      source.journal.entriesFor('project-b', 'owner-b'),
    ]),
    states: await Promise.all([
      source.journal.stateOf('project-a', 'owner-a'),
      source.journal.stateOf('project-b', 'owner-b'),
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
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'flip', (flip) => {
        return async (id, undone, preconditions) => {
          if (!control.isArmed() || id !== 'flip-target') return flip(id, undone, preconditions);
          // Proof: forwarding the supplied preconditions changed all four focused
          // memory fault outcomes from `observed` to `assertion-passed`.
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
    };
  },
});

const journalRestampFlipsFault = defineFault({
  id: 'break:journal.flip:preconditions:journal-restamp-flips',
  caseId: 'journal.flip:preconditions',
  createControl: () => createFaultControl('journal.flip:preconditions:restamp-flips'),
  mutate(source: MemorySource, control) {
    const flip = source.journal.flip.bind(source.journal);
    return {
      ...source,
      journal: replaceMethod(source.journal, 'restamp', (restamp) => {
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
    };
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
  return {
    id: `history-${projectId === 'project-a' ? 'a' : 'b'}-${id}`,
    projectId,
    userId,
    kind,
    label: `History history-${projectId === 'project-a' ? 'a' : 'b'}-${id}`,
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

async function readTask52HistoryState(source: MemorySource) {
  return {
    projectAEvents: await source.stores.planEvents.listFor('project-a', {}),
    projectBEvents: await source.stores.planEvents.listFor('project-b', {}),
    journals: await Promise.all([
      source.journal.entriesFor('project-a', 'owner-a'),
      source.journal.entriesFor('project-b', 'owner-b'),
    ]),
  };
}

const planEventsIgnoreItemFilterFault = defineFault({
  id: 'break:planEvents.listFor:filters-order',
  caseId: 'planEvents.listFor:filters-order',
  createControl: () => createFaultControl('planEvents.listFor:filters-order:ignore-item'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        // Proof: disabling only this adapter-owned route changed the permanent
        // four-fault result's first kind from `observed` to `assertion-passed`.
        if (!control.isArmed() || entry.id !== 'atomic-target') return append(entry, event);
        await append(entry, event);
        const moved = source.routeJournalEventToIndependent(event.id);
        expect(moved).toEqual(event);
        expect(await source.independentJournalHistoryFor()).toEqual([event]);
        expect(await source.journal.entriesFor(entry.projectId, entry.userId)).toContainEqual({
          ...entry,
          seq: 2,
          undone: false,
        });
        expect(await source.stores.planEvents.listFor(event.projectId, {})).not.toContainEqual(
          event,
        );
        control.reach('journal.append:history-atomic:independent-history');
      }),
    };
  },
});

const journalLateOutsideFault = defineFault({
  id: 'break:journal.append:history-atomic:journal-late-outside',
  caseId: 'journal.append:history-atomic',
  createControl: () => createFaultControl('journal.append:history-atomic:outside-owner'),
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        await append(entry, event);
        if (entry.id !== 'atomic-late-target') return;
        expect(await source.journal.entriesFor(entry.projectId, entry.userId)).toContainEqual({
          ...entry,
          seq: 3,
          undone: false,
        });
        expect(await source.stores.planEvents.listFor(event.projectId, {})).toContainEqual(event);
        control.reach('journal.append:history-atomic:outside-owner');
        throw new Error('injected memory journal-history-insert failure outside staged owner');
      }),
    };
  },
});

interface JournalIncompleteProbe {
  attempts: number;
  closeCalls: number;
  entries: JournalEntry[][] | null;
  history: PlanEvent[][] | null;
  independentHistory: PlanEvent[] | null;
}

function commitJournalWithoutLateHistory(
  source: MemorySource,
  probe: JournalIncompleteProbe,
): MemorySource {
  return {
    ...source,
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
    journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
      await append(entry, event);
      if (entry.id !== 'atomic-late-target') return;
      probe.attempts += 1;
      source.routeJournalEventToIndependent(event.id);
      probe.entries = await Promise.all([
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[0], DETERMINISTIC_SEED.ownerIds[0]),
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[0], DETERMINISTIC_SEED.ownerIds[1]),
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[1], DETERMINISTIC_SEED.ownerIds[1]),
      ]);
      probe.history = await Promise.all(
        DETERMINISTIC_SEED.projectIds.map((projectId) =>
          source.stores.planEvents.listFor(projectId, {}),
        ),
      );
      probe.independentHistory = await source.independentJournalHistoryFor();
    }),
  };
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
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        await append(entry, event);
        if (entry.id !== 'atomic-target') return;
        await source.journal.discard('atomic-sentinel-b');
        control.reach('journal.append:history-atomic:collateral-actor');
      }),
    };
  },
});

const journalReplacementCorruptionFault = defineFault({
  id: 'break:journal.append:account-redo-depth:journal-replacement-corruption',
  caseId: 'journal.append:account-redo-depth',
  createControl: () => createFaultControl('journal.append:account-redo-depth:replacement-record'),
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        if (entry.id !== 'redo-a-replacement') return append(entry, event);
        await append({ ...entry, inverse: { broken: 'replacement inverse' } }, event);
        control.reach('journal.append:account-redo-depth:replacement-record');
      }),
    };
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
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        await append(entry, event);
        if (entry.id !== 'redo-a-replacement') return;
        expect(
          await source.journal.entriesFor(
            DETERMINISTIC_SEED.projectIds[0],
            DETERMINISTIC_SEED.ownerIds[1],
          ),
        ).toEqual([expectedActorBRedo()]);
        await source.journal.discard('redo-b');
        control.reach('journal.append:account-redo-depth:all-redo');
      }),
    };
  },
});

const journalHistoryPruneFault = defineFault({
  id: 'break:journal.append:account-redo-depth:journal-history-prune',
  caseId: 'journal.append:account-redo-depth',
  createControl: () => createFaultControl('journal.append:account-redo-depth:history-prune'),
  mutate(source: MemorySource, control) {
    return {
      ...source,
      journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
        await append(entry, event);
        if (entry.id !== 'depth-50') return;
        await source.stores.planEvents.pruneOlderThan(350);
        control.reach('journal.append:account-redo-depth:history-prune');
      }),
    };
  },
});

const subtreeDependencyBackingFault = defineFault({
  id: 'break:subtrees.insertSubtree:complete-copy:subtree-dependency-backing',
  caseId: 'subtrees.insertSubtree:complete-copy',
  createControl: () => createFaultControl('subtrees.insertSubtree:complete-copy:dependencies'),
  mutate(source: MemorySource, control) {
    const isolated = inMemoryDependencies();
    return {
      ...source,
      async insertSubtree(copy, stamp) {
        if (!control.isArmed()) return source.insertSubtree(copy, stamp);
        await source.insertSubtree({ ...copy, dependencies: [] }, stamp);
        for (const dependency of copy.dependencies)
          await isolated.add(structuredClone(dependency), stamp);
        expect(await isolated.listByProject(DETERMINISTIC_SEED.projectIds[0])).toEqual([
          ...copy.dependencies,
        ]);
        // Proof: removing only this complete-state prerequisite changed the
        // successful-incomplete dependency proof from phase-failed to observed.
        assertCompleteStateAlternative(
          await readSubtreePublicState(readersOf(source), DETERMINISTIC_SEED.projectIds[0]),
          DETERMINISTIC_SEED,
          [{ dependencyIds: copy.dependencies.map(({ id }) => id) }, {}],
        );
        control.reach('subtrees.insertSubtree:complete-copy:dependencies');
      },
    };
  },
});

const subtreeRemovedMeasureFault = defineFault({
  id: 'break:subtrees.insertSubtree:complete-copy:subtree-removed-measure',
  caseId: 'subtrees.insertSubtree:complete-copy',
  createControl: () => createFaultControl('subtrees.insertSubtree:complete-copy:removed-measure'),
  mutate(source: MemorySource, control) {
    return {
      ...source,
      async insertSubtree(copy, stamp) {
        if (!control.isArmed()) return source.insertSubtree(copy, stamp);
        const metrics = ['token_estimate', 'token_actual', 'hours_actual'] as const;
        const pairWide = copy.removedMeasures.flatMap(({ workItemId, stepId }) =>
          metrics.map((metric) => ({
            workItemId,
            stepId,
            metric,
          })),
        );
        await source.insertSubtree({ ...copy, removedMeasures: pairWide }, stamp);
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
      },
    };
  },
});

const subtreeRollbackFault = defineFault({
  id: 'break:subtrees.insertSubtree:late-failure',
  caseId: 'subtrees.insertSubtree:late-failure',
  createControl: () => createFaultControl('subtrees.insertSubtree:late-failure:unstaged'),
  mutate(source: MemorySource, control) {
    return {
      ...source,
      insertSubtree(copy, stamp) {
        if (!control.isArmed()) return source.insertSubtree(copy, stamp);
        return source.stores.subtrees.insertSubtree(copy, stamp);
      },
    };
  },
});

type SavedPlanWriteFaultId =
  | 'break:savedPlans.write:bytes-and-bodies:utf8-length'
  | 'break:savedPlans.write:bytes-and-bodies:header-only'
  | 'break:savedPlans.write:bytes-and-bodies:altered-body'
  | 'break:savedPlans.write:bytes-and-bodies:altered-hash';

function savedPlanWriteFault<const Id extends SavedPlanWriteFaultId>(
  id: Id,
  phase: string,
  corrupt: (source: MemorySource) => void,
  verify: (source: MemorySource) => Promise<void>,
) {
  return defineFault<MemorySource, Id, string, ReturnType<typeof createFaultControl<string>>>({
    id,
    // The closed local ID union maps every member to this one manifest case.
    caseId: 'savedPlans.write:bytes-and-bodies' as FaultCase<Id>,
    createControl: () => createFaultControl(phase),
    mutate(source: MemorySource, control) {
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
              corrupt(source);
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

async function assertCompleteTask61UnknownState(source: MemorySource) {
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

const savedPlanUtf8LengthFault = savedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:utf8-length',
  'saved-plan:utf8-length',
  (source) => {
    source.setSavedPlanByteCounts('saved-present', 4, 1);
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

const savedPlanHeaderOnlyFault = savedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:header-only',
  'saved-plan:header-only',
  (source) => {
    source.removeSavedPlanBodies('saved-present');
  },
  async (source) => {
    // Proof: deleting both adapter-owned body slots preserved the header and
    // failed the shared complete read with expected multibyte bodies versus null.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      bodies: { input: null, schedule: null },
    });
  },
);

const savedPlanAlteredBodyFault = savedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:altered-body',
  'saved-plan:body-bytes',
  (source) => {
    source.replaceSavedPlanInputBody('saved-present', 'A🔦C');
  },
  async (source) => {
    // Proof: changing only the persisted body reached this prerequisite and
    // failed the shared exact-body assertion with A🔦B expected and A🔦C received.
    const expected = expectedTask61Present();
    expect(await source.history.savedPlans.readOf('saved-present')).toEqual({
      ...expected,
      bodies: { input: 'A🔦C', schedule: 'é' },
    });
  },
);

const savedPlanAlteredHashFault = savedPlanWriteFault(
  'break:savedPlans.write:bytes-and-bodies:altered-hash',
  'saved-plan:body-hash',
  (source) => {
    source.replaceSavedPlanScheduleHash('saved-present', 'schedule-hash-altered');
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
  mutate(source: MemorySource, control) {
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
            // the production writer and principal reader exposed owner-a in both roles.
            expect(await source.history.savedPlans.principalsOf(plan.id)).toEqual({
              savedPlanId: 'touch-target',
              projectId: 'project-a',
              projectOwnerId: 'owner-a',
              createdById: 'owner-a',
            });
            expect(await source.history.savedPlans.readOf(plan.id)).toEqual(
              expectedTask61Touch(
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
            );
            control.reach('saved-plan:principals');
            return outcome;
          },
      ),
    );
  },
});

function savedPlanUnknownTouchFault(method: 'renameTo' | 'deleteOf', phase: string) {
  return defineFault({
    id:
      method === 'renameTo'
        ? 'break:savedPlans.touch:principals-scope:unknown-rename'
        : 'break:savedPlans.touch:principals-scope:unknown-delete',
    caseId: 'savedPlans.touch:principals-scope',
    createControl: () => createFaultControl(phase),
    mutate(source: MemorySource, control) {
      const savedPlans =
        method === 'renameTo'
          ? replaceMethod(
              source.history.savedPlans,
              'renameTo',
              (renameTo) => async (savedPlanId, name) => {
                const outcome = await renameTo(savedPlanId, name);
                if (savedPlanId !== 'missing-touch-plan') return outcome;
                // Proof: returning touched only after these production outcomes and
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
                // Proof: returning touched only after these production outcomes and
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

const savedPlanUnknownRenameFault = savedPlanUnknownTouchFault(
  'renameTo',
  'saved-plan:unknown-rename',
);
const savedPlanUnknownDeleteFault = savedPlanUnknownTouchFault(
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

async function assertTask62FaultState(source: MemorySource, plans: readonly StoredSavedPlan[]) {
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
  mutate(source: MemorySource, control) {
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
          // Proof: persisting through the production writer while returning the real refusal
          // failed the shared full-state assertion with the complete extra quota-refused plan.
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
  mutate(source: MemorySource, control) {
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
            // Proof: moving the callback before the real history owner admitted both writers;
            // the shared mechanism/state assertion received written plus the complete rival.
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
  createControl: () => createFaultControl('saved-plan:late-body:split-commit'),
  mutate(source: MemorySource, control) {
    return withSavedPlans(
      source,
      replaceSavedPlanWrite(source.history.savedPlans, (write) => {
        return (plan, check) =>
          plan.id === 'late-target'
            ? source.writeSavedPlanSplit(plan, check, true, (stored) => {
                // Proof: changing the split request before adapter entry used to mark
                // canonical reach from self-derived content and an unrelated assertion.
                const expected = expectedTask62Plan(
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
                expect(stored).toEqual({
                  ...expected,
                  bodies: { ...expected.bodies, schedule: null },
                });
                control.reach('saved-plan:late-body:split-commit');
              })
            : write(plan, check);
      }),
    );
  },
});

const savedPlanMissingInputFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-missing-input',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:missing-input'),
  mutate(source: MemorySource) {
    return observeTask62Write(
      withSavedPlans(
        source,
        replaceSavedPlanWrite(
          source.history.savedPlans,
          (write) => (plan, check) =>
            plan.id === 'late-target'
              ? source.writeSavedPlanSplit(plan, check, false, (stored) => {
                  memoryMissingInputProbe.boundary = stored;
                })
              : write(plan, check),
        ),
      ),
      memoryMissingInputProbe,
      'late-target',
      ['late-target', 'late-sentinel', 'saved-other-project'],
    );
  },
});

const savedPlanRefusalNoMutationFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-mutation',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:no-mutation'),
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource, control) {
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
  mutate(source: MemorySource) {
    return source;
  },
});

function prematureTask62Source(source: MemorySource, probe: SavedPlanPhaseProbe, targetId: string) {
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
  source: MemorySource,
  probe: SavedPlanPhaseProbe,
  targetId: string,
  ids: readonly string[],
): MemorySource {
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
  // Proof: a rejected public read used to bypass the fixture close entirely.
  if (didObservationFail && didCloseFail)
    throw new AggregateError(
      [observationFailure, closeFailure],
      'saved-plan observation and memory source close both failed',
      { cause: closeFailure },
    );
  if (didObservationFail) throw observationFailure;
  if (didCloseFail) throw closeFailure;
}

const savedPlanRefusalPrematureFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-premature',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:premature'),
  mutate(source: MemorySource) {
    return prematureTask62Source(source, memoryPrematureProbes[0], 'quota-refused');
  },
});
const savedPlanWindowPrematureFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-window-premature',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:premature'),
  mutate(source: MemorySource) {
    return prematureTask62Source(source, memoryPrematureProbes[1], 'quota-window-last');
  },
});
const savedPlanLatePrematureFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-late-premature',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:premature'),
  mutate(source: MemorySource) {
    return prematureTask62Source(source, memoryPrematureProbes[2], 'late-target');
  },
});
const memoryPrematureProbes: SavedPlanPhaseProbe[] = Array.from({ length: 3 }, () => ({
  attempts: 0,
  closeCalls: 0,
  state: null,
}));
const memoryMissingInputProbe: SavedPlanPhaseProbe = { attempts: 0, closeCalls: 0, state: null };

const savedPlanRefusalNoReachFault = defineFault({
  id: 'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-reach',
  caseId: 'savedPlans.write:quota-refusal',
  createControl: () => createFaultControl('saved-plan:quota-refusal:no-reach'),
  mutate(source: MemorySource) {
    const muted = createFaultControl('saved-plan:quota-refusal:persisted');
    muted.arm();
    return savedPlanPersistedRefusalFault.mutate(source, muted);
  },
});
const savedPlanWindowNoReachFault = defineFault({
  id: 'break:savedPlans.write:quota-window:saved-plan-window-no-reach',
  caseId: 'savedPlans.write:quota-window',
  createControl: () => createFaultControl('saved-plan:quota-window:no-reach'),
  mutate(source: MemorySource) {
    const muted = createFaultControl('saved-plan:quota-window:stale-check');
    muted.arm();
    return savedPlanStaleQuotaFault.mutate(source, muted);
  },
});
const savedPlanLateNoReachFault = defineFault({
  id: 'break:savedPlans.write:late-body-failure:saved-plan-late-no-reach',
  caseId: 'savedPlans.write:late-body-failure',
  createControl: () => createFaultControl('saved-plan:late-body:no-reach'),
  mutate(source: MemorySource) {
    return savedPlanSplitWriteFault.mutate(
      source,
      createFaultControl('saved-plan:late-body:split-commit'),
    );
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
  source: MemorySource,
  probe: SavedPlanPhaseProbe,
): MemorySource {
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
  source: MemorySource,
  probe: SavedPlanPhaseProbe,
  mode: 'bodies' | 'creator-display',
): MemorySource {
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
            if (mode === 'bodies') source.removeSavedPlanBodies(plan.id);
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
  source: MemorySource,
  probe: SavedPlanPhaseProbe,
  method: 'renameTo' | 'deleteOf',
): MemorySource {
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
  report: ExecutionReport | null;
}

async function proveFault(
  fault: Fault<MemorySource>,
  openSource: OpenSource = openConformanceMemorySource,
  decorate: (source: MemorySource) => MemorySource = (source) => source,
  prepare: (source: MemorySource) => Promise<void> = () => Promise.resolve(),
): Promise<FaultProof> {
  return recordFaultProof(fault, {
    assertion: `${fault.caseId} reports passed`,
    async setup(run: FaultRun<MemorySource>) {
      const lateControl =
        fault.caseId === 'subtrees.insertSubtree:late-failure'
          ? memoryLateWriteControl('subtree-final-satellite')
          : fault.caseId === 'journal.append:history-atomic' &&
              run.control.phase !== 'journal.append:history-atomic:outside-owner'
            ? memoryLateWriteControl('journal-history-insert')
            : fault.caseId === 'savedPlans.write:late-body-failure'
              ? memoryLateWriteControl('saved-plan-schedule-body')
              : null;
      const baseOpen =
        lateControl === null
          ? openSource
          : () =>
              memoryLateSource(
                lateControl,
                run.control.phase === 'saved-plan:late-body:no-reach' ||
                  run.control.phase === 'saved-plan:late-body:split-commit'
                  ? undefined
                  : () => {
                      run.control.reach(run.control.phase);
                    },
              );
      const source = await seedMemorySource(
        brokenSource(() => decorate(baseOpen()), run),
        async (seeded) => {
          if (fault.caseId.startsWith('progress.')) await seedProgressStep(seeded);
          if (fault.caseId.startsWith('dependencies.')) await seedDependencyWorkItems(seeded);
          if (fault.caseId.startsWith('subtrees.')) await seedSubtreeRecords(seeded);
          if (fault.caseId.startsWith('savedPlanCapture.'))
            await seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED);
        },
      );
      try {
        await prepare(source);
      } catch (failure) {
        return throwAfterMemoryCleanup(failure, source);
      }
      let wasOpened = false;
      const takeFixture = <Family extends ExistingFamily>(
        family: Family,
        caseId: CaseId,
      ): Promise<CaseFixture<TransactionalStores[Family]>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        if (family === 'journal') {
          return Promise.resolve({
            fixtureId: `memory:${caseId}`,
            port: source.journal,
            journalAppender: source.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
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
            close: () => source.close(),
          } as unknown as CaseFixture<TransactionalStores[Family]>);
        }
        if (family !== 'subtrees') return Promise.resolve(memoryFixture(source, family, caseId));
        return Promise.resolve({
          fixtureId: `memory:${caseId}`,
          port: transactionalSubtrees(source),
          journalAppender: source.journal,
          seed: DETERMINISTIC_SEED,
          readers: readersOf(source),
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
          close: () => source.close(),
        } as unknown as CaseFixture<TransactionalStores[Family]>);
      };
      const takeSavedPlanFixture = (caseId: CaseId): Promise<CaseFixture<SavedPlanStore>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        return Promise.resolve({
          fixtureId: `memory:${caseId}`,
          port: source.history.savedPlans,
          journalAppender: source.journal,
          seed: DETERMINISTIC_SEED,
          readers: readersOf(source),
          scenario:
            caseId === 'savedPlans.write:quota-window'
              ? {
                  kind: 'competing-history-write',
                  rivalWriter: replaceSavedPlanWrite(source.history.savedPlans, (write) => {
                    return (plan, check) => {
                      const settlement = write(plan, check);
                      if (source.quotaRivalOwner !== undefined)
                        source.quotaRivalOwner.settlement = settlement;
                      return settlement;
                    };
                  }),
                  expectedRival: 'quota-refused',
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
          close: () => source.close(),
        });
      };
      const takeSavedPlanCaptureFixture = (
        caseId: CaseId,
      ): Promise<CaseFixture<SavedPlanCaptureStore>> => {
        if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
        wasOpened = true;
        return Promise.resolve({
          fixtureId: `memory:${caseId}`,
          port: source.history.savedPlanCapture,
          journalAppender: source.journal,
          seed: DETERMINISTIC_SEED,
          readers: readersOf(source),
          scenario: { kind: 'ordinary' },
          close: () => source.close(),
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
      if (registration === undefined) throw new Error(`missing registration for ${fault.caseId}`);
      return { registration, assertionFailure: null, report: null };
    },
    async exercise(context: FaultContext) {
      context.report = await runCases([context.registration], { focus: [fault.caseId] });
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
  fault: Fault<MemorySource>,
  decorate: (source: MemorySource) => MemorySource = (source) => source,
  changeDirectory: (
    source: MemorySource,
  ) => Promise<CaptureDirectoryChange> = changeMemoryCaptureDirectory,
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
      const source = await seedMemorySource(
        brokenSource(
          () =>
            decorate(
              conformanceMemorySource(
                openMemorySourceWithCaptureReadSeam({
                  async afterFirstRead({ projectId, project }) {
                    if (projectId !== 'project-a' || didEnter) return;
                    if (project.id !== projectId || project.name !== 'Captured project A')
                      throw new Error('coherent memory barrier received wrong first-read evidence');
                    didEnter = true;
                    enter();
                    await released;
                  },
                }),
              ),
            ),
          run,
        ),
        async (seeded) => seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED),
      );
      let wasOpened = false;
      const registrations = existingStoreRegistrations({
        ...openers,
        savedPlanCapture: (caseId) => {
          if (wasOpened) return Promise.reject(new Error(`${fault.caseId} fixture opened twice`));
          wasOpened = true;
          return Promise.resolve({
            fixtureId: `memory:${caseId}`,
            port: source.history.savedPlanCapture,
            journalAppender: source.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: {
              kind: 'capture-interleave',
              firstRead: { entered, release },
              changeDirectory: () => changeDirectory(source),
            },
            close: async () => {
              release();
              await source.close();
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

function failedCase(report: ExecutionReport, caseId: CaseId) {
  return report.cases.find((execution) => execution.caseId === caseId);
}

interface MemoryLifecycleProbe {
  closeCalls: number;
}

interface Task52FlipWindowProbe extends MemoryLifecycleProbe {
  attempts: number;
  state: Awaited<ReturnType<typeof readTask52FlipState>> | null;
}

function omitTask52Flip(source: MemorySource, probe: Task52FlipWindowProbe): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'flip', (flip) => async (id, undone, preconditions) => {
      if (id !== 'flip-target') return flip(id, undone, preconditions);
      probe.attempts += 1;
      probe.state = await readTask52FlipState(source);
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

interface Task52PruneWindowProbe extends MemoryLifecycleProbe {
  attempts: number;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function omitTask52Prune(source: MemorySource, probe: Task52PruneWindowProbe): MemorySource {
  const decorated = withStores(source, {
    planEvents: replaceMethod(source.stores.planEvents, 'pruneOlderThan', () => async () => {
      probe.attempts += 1;
      probe.state = await readTask52HistoryState(source);
      return 0;
    }),
  });
  return {
    ...decorated,
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

interface Task52HistorySetupProbe extends MemoryLifecycleProbe {
  attempts: number;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function suppressTask52ProjectBAppends(
  source: MemorySource,
  probe: Task52HistorySetupProbe,
): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
      if (entry.projectId !== 'project-b') return append(entry, event);
      probe.attempts += 1;
      if (entry.id === 'journal-b-101-wide') {
        probe.state = await readTask52HistoryState(source);
      }
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

function discardTask52JournalsAfterAppend(
  source: MemorySource,
  probe: Task52HistorySetupProbe,
): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
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
        await source.journal.discard(journalId);
      }
      probe.state = await readTask52HistoryState(source);
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

function omitTask52RestampEffect(source: MemorySource, probe: Task52FlipWindowProbe): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'flip', (flip) => {
      return async (id, undone, preconditions) => {
        if (id !== 'flip-target' || undone) {
          return flip(id, undone, preconditions);
        }
        probe.attempts += 1;
        probe.state = await readTask52FlipState(source);
      };
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

interface Task52ListWindowProbe extends MemoryLifecycleProbe {
  attempts: number;
  returned: PlanEvent[] | null;
  state: Awaited<ReturnType<typeof readTask52HistoryState>> | null;
}

function partiallyFilterTask52LeakedRead(
  source: MemorySource,
  probe: Task52ListWindowProbe,
): MemorySource {
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

interface JournalPrewriteProbe extends MemoryLifecycleProbe {
  attempts: number;
  entries: JournalEntry[][] | null;
  history: PlanEvent[][] | null;
}

function rejectJournalBeforeAppend(
  source: MemorySource,
  probe: JournalPrewriteProbe,
): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'append', (append) => async (entry, event) => {
      if (entry.id !== 'atomic-late-target') return append(entry, event);
      probe.attempts += 1;
      probe.entries = await Promise.all([
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[0], DETERMINISTIC_SEED.ownerIds[0]),
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[0], DETERMINISTIC_SEED.ownerIds[1]),
        source.journal.entriesFor(DETERMINISTIC_SEED.projectIds[1], DETERMINISTIC_SEED.ownerIds[1]),
      ]);
      probe.history = await Promise.all(
        DETERMINISTIC_SEED.projectIds.map((projectId) =>
          source.stores.planEvents.listFor(projectId, {}),
        ),
      );
      throw new Error('injected journal-history-insert failure before target append');
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

function skipActorBRedo(
  source: MemorySource,
  probe: MemoryLifecycleProbe & { attempts: number },
): MemorySource {
  return {
    ...source,
    journal: replaceMethod(source.journal, 'flip', (flip) => async (id, undone, preconditions) => {
      if (id !== 'redo-b') return flip(id, undone, preconditions);
      probe.attempts += 1;
    }),
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

interface SubtreePrewriteProbe extends MemoryLifecycleProbe {
  attempts: number;
  state: Awaited<ReturnType<typeof readSubtreePublicState>>[] | null;
}

interface SubtreeIncompleteProbe extends MemoryLifecycleProbe {
  attempts: number;
  state: Awaited<ReturnType<typeof readSubtreePublicState>> | null;
}

function omitCopiedProgress(source: MemorySource, probe: SubtreeIncompleteProbe): MemorySource {
  return {
    ...source,
    async insertSubtree(copy, stamp) {
      probe.attempts += 1;
      await source.insertSubtree({ ...copy, progress: [] }, stamp);
      probe.state = await readSubtreePublicState(
        readersOf(source),
        DETERMINISTIC_SEED.projectIds[0],
      );
    },
    async close() {
      probe.closeCalls += 1;
      await source.close();
    },
  };
}

function rejectSubtreeBeforeWrite(
  source: MemorySource,
  probe: SubtreePrewriteProbe,
  message: string,
): MemorySource {
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
      insertSubtree: reject,
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
  source: MemorySource,
  probe: MemoryLifecycleProbe & { attempts: number },
) {
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

interface DirectoryPrewriteProbe extends MemoryLifecycleProbe {
  attempts: number;
  teams: TeamWithServices[] | null;
}

function openDirectoryPrewriteFailureSource(probe: DirectoryPrewriteProbe): MemorySource {
  const source = openConformanceMemorySource();
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

function openDependencySeedFailureSource(
  probe: MemoryLifecycleProbe,
  cleanupFailure?: string,
): MemorySource {
  const source = openConformanceMemorySource();
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
        if (cleanupFailure !== undefined) throw new Error(cleanupFailure);
      },
    },
    {
      workItems: replaceMethod(source.stores.workItems, 'insert', (insert) => {
        return (workItem, children, stamp) => {
          if (workItem.id === DEPENDENCY_SURVIVOR_IDS[1]) {
            throw new Error('injected second dependency survivor seed failure');
          }
          return insert(workItem, children, stamp);
        };
      }),
    },
  );
}

function openProgressSeedFailureSource(
  probe: MemoryLifecycleProbe,
  cleanupFailure?: string,
): MemorySource {
  const source = openConformanceMemorySource();
  return withStores(
    {
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
        if (cleanupFailure !== undefined) throw new Error(cleanupFailure);
      },
    },
    {
      steps: replaceMethod(source.stores.steps, 'add', (add) => {
        return (step, stamp) => {
          if (step.id === PROGRESS_SENTINEL_STEP_ID) {
            throw new Error('injected progress companion seed failure');
          }
          return add(step, stamp);
        };
      }),
    },
  );
}

interface StagedHistoryMutation {
  readonly fault: 'staged-owner' | 'staged-owner-wrong-body';
  readonly stageProof?: { reach(phase: 'complete-staged-write'): boolean };
}

const historyStagedOwnerFault = defineFault({
  id: 'break:history.batch:interleaved-success-survives:staged-owner',
  caseId: 'history.batch:interleaved-success-survives',
  createControl: () => createFaultControl('complete-staged-write'),
  mutate: (mutation: StagedHistoryMutation, control) => ({ ...mutation, stageProof: control }),
});

async function proveStagedHistoryFault(
  fault: Fault<StagedHistoryMutation, 'complete-staged-write'>,
): Promise<FaultProof> {
  return recordFaultProof(fault, {
    assertion: 'rollback preserves the exact independently written history plan',
    setup(run) {
      const mutation = run.mutate({ fault: 'staged-owner' }, run.control);
      const loss: { id?: string; stored?: StoredSavedPlan | null } = {};
      const registrations = sourceConformanceRegistrations(declaration, {
        ...openers,
        historyBatch: (caseId) =>
          openMemoryHistoryBatchCase(caseId, mutation.fault, {
            stageProof: mutation.stageProof,
            onStagedLoss: (id, stored) => {
              loss.id = id;
              loss.stored = stored;
            },
          }),
      });
      return Promise.resolve({
        registration: registrations.find(({ caseId }) => caseId === run.caseId),
        report: null as ExecutionReport | null,
        loss,
        control: run.control,
      });
    },
    async exercise(context) {
      if (context.registration === undefined) throw new Error('missing staged-history case');
      context.report = await runCases([context.registration], {
        focus: ['history.batch:interleaved-success-survives'],
      });
      const execution = context.report.cases[0];
      if (!context.control.reached() && execution.status === 'failed')
        throw new Error(execution.failure);
    },
    assert(context) {
      if (context.report === null) throw new Error('staged history assertion ran before exercise');
      const execution = context.report.cases[0];
      if (execution.status !== 'failed')
        throw new Error('staged history disposal mutant did not fail conformance');
      if (execution.assertionPhase !== 'assertion')
        throw new Error(`staged history failed during ${execution.assertionPhase}`);
      const observedFailure = Bun.stripANSI(execution.failure);
      if (context.loss.id !== 'history-interleaved-rollback' || context.loss.stored !== null)
        throw new Error(
          `staged history exact loss was not observed: ${JSON.stringify(context.loss)}`,
        );
      if (
        !observedFailure.includes('history-interleaved-rollback') ||
        !observedFailure.includes('"attempted": null')
      )
        throw new Error(`staged history loss was not exact: ${observedFailure}`);
      throw new Error(execution.failure);
    },
  });
}

const namedFaultVariants = [
  historyStagedOwnerFault,
  savedPlanUtf8LengthFault,
  savedPlanHeaderOnlyFault,
  savedPlanAlteredBodyFault,
  savedPlanAlteredHashFault,
  savedPlanPrincipalFault,
  savedPlanUnknownRenameFault,
  savedPlanUnknownDeleteFault,
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

describe('memory existing source conformance', () => {
  it('registers every named memory mutation exactly once', () => {
    // Proof: removing the first real fault from the inventory throws a coverage
    // mismatch even though every shared conformance case remains registered.
    expect(() => {
      assertFaultVariantCoverage('memory', namedFaultVariants.slice(1));
    }).toThrow('memory fault variant coverage mismatch');
    assertFaultVariantCoverage('memory', namedFaultVariants);
  });

  it('runs every Task 5.2 journal and plan-event case through the staged memory source', async () => {
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

  it('reinjects retained flip preconditions, restamp direction, ignored item filters and inclusive pruning in memory', async () => {
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

  it('refuses Task 5.2 memory faults before complete public mutations', async () => {
    const flipProbe: Task52FlipWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const pruneProbe: Task52PruneWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const [flipProof, pruneProof] = await Promise.all([
      proveFault(journalRetainedPreconditionsFault, openConformanceMemorySource, (source) =>
        omitTask52Flip(source, flipProbe),
      ),
      proveFault(planEventsInclusivePruneFault, openConformanceMemorySource, (source) =>
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

  it('refuses incomplete Task 5.2 memory history setup before the item-filter fault reaches', async () => {
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
      proveFault(planEventsIgnoreItemFilterFault, openConformanceMemorySource, (source) =>
        suppressTask52ProjectBAppends(source, missingProjectProbe),
      ),
      proveFault(planEventsIgnoreItemFilterFault, openConformanceMemorySource, (source) =>
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

  it('refuses partial Task 5.2 memory restamp and filtered-read effects before fault reach', async () => {
    const restampProbe: Task52FlipWindowProbe = { attempts: 0, closeCalls: 0, state: null };
    const listProbe: Task52ListWindowProbe = {
      attempts: 0,
      closeCalls: 0,
      returned: null,
      state: null,
    };
    const [restampProof, listProof] = await Promise.all([
      proveFault(journalRestampFlipsFault, openConformanceMemorySource, (source) =>
        omitTask52RestampEffect(source, restampProbe),
      ),
      proveFault(planEventsIgnoreItemFilterFault, openConformanceMemorySource, (source) =>
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

  it('runs every Task 5.1 journal case through the staged memory source', async () => {
    const caseIds = ['journal.append:history-atomic', 'journal.append:account-redo-depth'] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });
    const failure = report.cases.find(({ status }) => status === 'failed');
    if (failure?.status === 'failed') throw new Error(failure.failure);
    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      caseIds.map((caseId) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects independent history, broad redo clearing and history pruning in memory', async () => {
    const proofs = await Promise.all([
      proveFault(journalIndependentHistoryFault),
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
    // Proof: throwing outside the staged owner leaves this complete entry committed.
    expect(failures[1]).toContain(`+       "id": "atomic-late-target",
+       "inverse": {`);
    // Proof: clearing both actors' redo removes B's complete retained entry.
    expect(failures[2]).toContain(`-       "id": "redo-b",
-       "inverse": {`);
    // Proof: pruning history with the journal removes the complete oldest event.
    expect(failures[3]).toContain(`-     "id": "event-redo-a"`);
  });

  it('refuses to certify a pre-write memory journal failure', async () => {
    const probe: JournalPrewriteProbe = {
      attempts: 0,
      closeCalls: 0,
      entries: null,
      history: null,
    };
    const proof = await proveFault(journalLateOutsideFault, openConformanceMemorySource, (source) =>
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

  it('refuses to observe a reached memory late write with incomplete public history', async () => {
    const probe: JournalIncompleteProbe = {
      attempts: 0,
      closeCalls: 0,
      entries: null,
      history: null,
      independentHistory: null,
    };
    const proof = await proveFault(journalLateOutsideFault, openConformanceMemorySource, (source) =>
      commitJournalWithoutLateHistory(source, probe),
    );
    const [projectA, projectB] = DETERMINISTIC_SEED.projectIds;
    const [actorA, actorB] = DETERMINISTIC_SEED.ownerIds;
    // Proof: removing only the outside-owner complete history prerequisite changed
    // this result to `observed` after the incomplete source committed its three rows.
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
      independentHistory: [expectedAtomicEvent('atomic-late-target', projectA, actorA, 202)],
    });
  });

  it('detects collateral actor deletion, replacement corruption and missing redo setup', async () => {
    const collateral = await proveFault(journalCollateralActorFault);
    const replacement = await proveFault(journalReplacementCorruptionFault);
    const probe = { attempts: 0, closeCalls: 0 };
    const missingRedo = await proveFault(
      journalBroadRedoFault,
      openConformanceMemorySource,
      (source) => skipActorBRedo(source, probe),
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

  it('runs every subtree case through the staged memory source', async () => {
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

  it('reinjects complete-copy dependency and metric-key faults through memory state', async () => {
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
    // Proof: the isolated dependency fault reaches only after exact prerequisite
    // state, then fails on this signed complete public edge.
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

  it('classifies subtree pre-write failures before their real proof phases', async () => {
    const dependencyProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const measureProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const rollbackProbe: SubtreePrewriteProbe = { attempts: 0, closeCalls: 0, state: null };
    const [dependency, measure, rollback] = await Promise.all([
      proveFault(subtreeDependencyBackingFault, openConformanceMemorySource, (source) =>
        rejectSubtreeBeforeWrite(
          source,
          dependencyProbe,
          'subtree-copy-dependency pre-write rejection',
        ),
      ),
      proveFault(subtreeRemovedMeasureFault, openConformanceMemorySource, (source) =>
        rejectSubtreeBeforeWrite(
          source,
          measureProbe,
          'token_actual value 102 recordedAt 132 pre-write rejection',
        ),
      ),
      proveFault(subtreeRollbackFault, openConformanceMemorySource, (source) =>
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
      'subtrees.insertSubtree:late-failure:unstaged',
    ]);
  });

  it('refuses successful incomplete complete-copy prerequisites in memory', async () => {
    const dependencyProbe: SubtreeIncompleteProbe = { attempts: 0, closeCalls: 0, state: null };
    const measureProbe: SubtreeIncompleteProbe = { attempts: 0, closeCalls: 0, state: null };
    const [dependency, measure] = await Promise.all([
      proveFault(subtreeDependencyBackingFault, openConformanceMemorySource, (source) =>
        omitCopiedProgress(source, dependencyProbe),
      ),
      proveFault(subtreeRemovedMeasureFault, openConformanceMemorySource, (source) =>
        omitCopiedProgress(source, measureProbe),
      ),
    ]);

    // Proof: deleting only the two owning assertCompleteStateAlternative calls
    // changed both real successful-incomplete runs from phase-failed to observed.
    expect([dependency.kind, measure.kind]).toEqual(['phase-failed', 'phase-failed']);
    if (dependency.kind !== 'phase-failed' || measure.kind !== 'phase-failed') {
      throw new Error('successful incomplete memory insert reached a proof phase');
    }
    expect([dependency.failure, measure.failure]).toEqual([
      'fault did not reach subtrees.insertSubtree:complete-copy:dependencies',
      'fault did not reach subtrees.insertSubtree:complete-copy:removed-measure',
    ]);
    expect([dependencyProbe.attempts, measureProbe.attempts]).toEqual([1, 1]);
    expect([dependencyProbe.closeCalls, measureProbe.closeCalls]).toEqual([1, 1]);
    if (dependencyProbe.state === null || measureProbe.state === null) {
      throw new Error('successful incomplete memory insertion was not publicly observed');
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

  it('refuses a late proof whose populated estimate prerequisite is missing', async () => {
    const probe = { attempts: 0, closeCalls: 0 };
    const proof = await proveFault(
      subtreeRollbackFault,
      openConformanceMemorySource,
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
    expect(proof.failure).toBe('fault did not reach subtrees.insertSubtree:late-failure:unstaged');
    expect(probe).toEqual({ attempts: 0, closeCalls: 1 });
  });

  it('rolls back a copied row when its explicit team set is refused', async () => {
    let closeCalls = 0;
    const source = await seedMemorySource(() => {
      const opened = openConformanceMemorySource();
      return {
        ...opened,
        async close() {
          closeCalls += 1;
          await opened.close();
        },
      };
    }, seedSubtreeRecords);
    try {
      const before = await Promise.all(
        DETERMINISTIC_SEED.projectIds.map((projectId) =>
          readSubtreePublicState(readersOf(source), projectId),
        ),
      );
      assertSeedState(before[0], DETERMINISTIC_SEED, 0);
      assertSeedState(before[1], DETERMINISTIC_SEED, 1);
      const copy = completeSubtreeCopy(DETERMINISTIC_SEED);
      const refused: SubtreeCopy = {
        ...copy,
        rows: copy.rows.map((row, index) =>
          index === 0 ? { ...row, teamIds: ['subtree-unknown-team'] } : structuredClone(row),
        ),
      };
      const write = source.insertSubtree(refused, DETERMINISTIC_SEED.stamps[1]);
      expect(write).rejects.toThrow('cannot restore team set for subtree-copy-root: unknown_team');
      await write.catch(() => undefined);
      // The guard-removal proof fails at the rejection above. These assertions
      // cover the guarded operation's complete rollback.
      expect(
        await Promise.all(
          DETERMINISTIC_SEED.projectIds.map((projectId) =>
            readSubtreePublicState(readersOf(source), projectId),
          ),
        ),
      ).toEqual(before);
      expect(closeCalls).toBe(0);
    } finally {
      await source.close();
    }
    expect(closeCalls).toBe(1);
  });

  it('reinjects an unstaged terminal subtree failure through committed memory state', async () => {
    const proof = await proveFault(subtreeRollbackFault);
    // Proof: restoring the staged insert returned `assertion-passed` here.
    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error(`expected observed proof, got ${proof.kind}`);
    // Proof: bypassing the staged MemoryState swap failed the complete public
    // snapshot with the escaped `subtree-copy-root` record after the terminal throw.
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
  it('closes once when ordinary progress companion seeding fails', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    let failure: unknown;
    try {
      await openMemoryCase('progress', 'progress.set:replace', () =>
        openProgressSeedFailureSource(probe),
      );
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toHaveProperty('message', 'injected progress companion seed failure');
    // Proof: the shared setup owner closes once when the final progress-only
    // seed rejects after the complete base seed has settled.
    expect(probe.closeCalls).toBe(1);
  });

  it('closes once when proof progress companion seeding fails', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    const proof = await proveFault(progressReplaceFault, () =>
      openProgressSeedFailureSource(probe),
    );

    expect(proof).toEqual({
      kind: 'setup-failed',
      faultId: 'break:progress.set:replace',
      caseId: 'progress.set:replace',
      failure: 'injected progress companion seed failure',
    });
    expect(probe.closeCalls).toBe(1);
  });

  it('preserves progress companion setup and cleanup failures', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    let failure: unknown;
    try {
      await openMemoryCase('progress', 'progress.set:replace', () =>
        openProgressSeedFailureSource(probe, 'injected progress cleanup failure'),
      );
    } catch (caught) {
      failure = caught;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty('message', 'memory source setup and cleanup both failed');
    expect((failure as AggregateError).errors.map((member) => String(member))).toEqual([
      'Error: injected progress companion seed failure',
      'Error: injected progress cleanup failure',
    ]);
    expect(probe.closeCalls).toBe(1);
  });

  it('leaves successful progress fixture cleanup to its single teardown', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    const source = openConformanceMemorySource();
    const fixture = await openMemoryCase('progress', 'progress.set:replace', () => ({
      ...source,
      async close() {
        probe.closeCalls += 1;
        await source.close();
      },
    }));
    expect(probe.closeCalls).toBe(0);
    await fixture.close();
    expect(probe.closeCalls).toBe(1);
  });

  it('closes once when ordinary dependency companion seeding fails', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    let failure: unknown;
    try {
      await openMemoryCase('dependencies', 'dependencies.add:idempotent-pair', () =>
        openDependencySeedFailureSource(probe),
      );
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toHaveProperty('message', 'injected second dependency survivor seed failure');
    // Proof: when dependency survivor seeding lived outside the setup owner,
    // this late failure left closeCalls at zero.
    expect(probe.closeCalls).toBe(1);
  });

  it('closes once when proof dependency companion seeding fails', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    const proof = await proveFault(dependencyPairPredicateFault, () =>
      openDependencySeedFailureSource(probe),
    );

    expect(proof).toEqual({
      kind: 'setup-failed',
      faultId: 'break:dependencies.remove:pair',
      caseId: 'dependencies.remove:pair',
      failure: 'injected second dependency survivor seed failure',
    });
    // Proof: the old proof setup seeded survivors after its cleanup owner and
    // reported setup-failed while leaving closeCalls at zero.
    expect(probe.closeCalls).toBe(1);
  });

  it('preserves both memory setup and cleanup failures', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    let failure: unknown;
    try {
      await openMemoryCase('dependencies', 'dependencies.add:idempotent-pair', () =>
        openDependencySeedFailureSource(probe, 'injected memory cleanup failure'),
      );
    } catch (caught) {
      failure = caught;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty('message', 'memory source setup and cleanup both failed');
    expect((failure as AggregateError).errors.map((member) => String(member))).toEqual([
      'Error: injected second dependency survivor seed failure',
      'Error: injected memory cleanup failure',
    ]);
    expect(probe.closeCalls).toBe(1);
  });

  it('does not close a successful memory fixture during setup', async () => {
    const probe: MemoryLifecycleProbe = { closeCalls: 0 };
    const source = openConformanceMemorySource();
    const fixture = await openMemoryCase(
      'dependencies',
      'dependencies.add:idempotent-pair',
      () => ({
        ...source,
        async close() {
          probe.closeCalls += 1;
          await source.close();
        },
      }),
    );
    expect(probe.closeCalls).toBe(0);
    await fixture.close();
    expect(probe.closeCalls).toBe(1);
  });

  it("memory's progress unknown-step gap names an observed refusal mismatch", async () => {
    const caseIds = [
      'progress.set:replace',
      'progress.remove:absence',
      'progress.moveAll:ownership',
      'progress.set:unknown_step',
    ] as const;
    const report = await runCases(existingStoreRegistrations(openers), { focus: caseIds });

    expect(report.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'progress.set:replace', status: 'passed' },
      { caseId: 'progress.remove:absence', status: 'passed' },
      { caseId: 'progress.moveAll:ownership', status: 'passed' },
      { caseId: 'progress.set:unknown_step', status: 'failed' },
    ]);
    const unknownStep = failedCase(report, 'progress.set:unknown_step');
    expect(unknownStep?.status).toBe('failed');
    if (unknownStep?.status !== 'failed') throw new Error('progress gap bypass did not fail');
    expect(unknownStep.assertionPhase).toBe('assertion');
    // Proof: before this exact gap was declared, the real unexcluded memory
    // case returned `written` and exposed the complete escaped done statement,
    // stated at 201, in project A's public list.
    expect(Bun.stripANSI(unknownStep.failure)).toContain(
      progressUnknownStepGap.evidence.observedFailure,
    );
  });

  it('runs every work-item case through the real memory source', async () => {
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

  it('names the observed configuration-reference refusal gaps', async () => {
    const report = await runCases(existingStoreRegistrations(openers), {
      focus: ['capacity.set:missing-reference', 'priorityBands.replace:missing-project'],
    });
    const capacity = failedCase(report, capacityMissingReferenceGap.caseId);
    const priorityBands = failedCase(report, priorityMissingProjectGap.caseId);

    expect(capacity?.status).toBe('failed');
    expect(priorityBands?.status).toBe('failed');
    if (capacity?.status !== 'failed' || priorityBands?.status !== 'failed') {
      throw new Error('configuration gap bypass did not fail');
    }
    expect(capacity.assertionPhase).toBe('assertion');
    expect(priorityBands.assertionPhase).toBe('assertion');
    // Proof: bypassing both declaration gaps through `openMemorySource` failed
    // with capacity's two true outcomes plus its two escaped rows
    // (`Expected - 6 / Received + 14`); priority returned true and exposed its
    // stored missing-project ladder (`Expected - 16 / Received + 15`).
    expect(Bun.stripANSI(capacity.failure)).toContain(
      capacityMissingReferenceGap.evidence.observedFailure,
    );
    expect(Bun.stripANSI(priorityBands.failure)).toContain(
      priorityMissingProjectGap.evidence.observedFailure,
    );
  });

  it('runs every offered existing case and reports the exact known gaps', async () => {
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
        .filter(({ status }) => status === 'passed')
        .map(({ caseId }) => caseId)
        .toSorted(),
    ).toEqual(
      expected
        .map(({ caseId }) => caseId)
        .filter((caseId) => !knownGaps.some((gap) => gap.caseId === caseId))
        .toSorted(),
    );
    expect(
      knownGaps.map((gap) => {
        const execution = failedCase(report, gap.caseId);
        return execution === undefined
          ? undefined
          : {
              family: execution.family,
              caseId: execution.caseId,
              status: execution.status,
              executed: execution.executed,
            };
      }),
    ).toEqual([
      {
        family: 'estimates',
        caseId: unknownStepGap.caseId,
        status: 'not-offered',
        executed: false,
      },
      {
        family: 'actuals',
        caseId: actualUnknownStepGap.caseId,
        status: 'not-offered',
        executed: false,
      },
      {
        family: 'measures',
        caseId: measureUnknownStepGap.caseId,
        status: 'not-offered',
        executed: false,
      },
      {
        family: 'progress',
        caseId: progressUnknownStepGap.caseId,
        status: 'not-offered',
        executed: false,
      },
      {
        family: 'capacity',
        caseId: capacityMissingReferenceGap.caseId,
        status: 'not-offered',
        executed: false,
      },
      {
        family: 'priorityBands',
        caseId: priorityMissingProjectGap.caseId,
        status: 'not-offered',
        executed: false,
      },
    ]);
  });

  it('Task 6.5 rejects history routed through the held command coordinator', async () => {
    const registrations = sourceConformanceRegistrations(declaration, {
      ...openers,
      historyBatch: (caseId) => openMemoryHistoryBatchCase(caseId, 'command-coordinator'),
    });
    const report = await runCases(registrations, {
      focus: ['history.batch:independent-commit'],
    });

    expect(report.cases[0]?.status).toBe('failed');
    if (report.cases[0]?.status !== 'failed') throw new Error('command coordinator fault passed');
    // Proof: routing the exact real history write through the held command owner
    // produced `pending`; cleanup released and drained it before this failure.
    expect(Bun.stripANSI(report.cases[0].failure)).toContain('pending');
  });

  it('Task 6.5 reads back a memory write that falsely reports success', async () => {
    const registrations = sourceConformanceRegistrations(declaration, {
      ...openers,
      historyBatch: (caseId) => openMemoryHistoryBatchCase(caseId, 'claimed-write-without-state'),
    });
    const report = await runCases(registrations, {
      focus: ['history.batch:interleaved-success-survives'],
    });

    expect(report.cases[0]?.status).toBe('failed');
    if (report.cases[0]?.status !== 'failed') throw new Error('suppressed memory write passed');
    // Proof: suppressing the real state replacement after the exact callback still
    // returned `written`; the exact-ID public read observed `null` after rollback.
    expect(Bun.stripANSI(report.cases[0].failure)).toContain('history-interleaved-rollback');
    expect(Bun.stripANSI(report.cases[0].failure)).toContain('null');
  });

  it('Task 6.5 rejects history stored in a rolled-back command stage', async () => {
    const proof = await proveStagedHistoryFault(historyStagedOwnerFault);
    if (proof.kind !== 'observed')
      throw new Error(`staged history proof: ${JSON.stringify(proof)}`);
    expect(proof.kind).toBe('observed');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('history-interleaved-rollback');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('"attempted": null');

    const wrongBodyFault = defineFault({
      ...historyStagedOwnerFault,
      mutate: (_mutation: StagedHistoryMutation, control) => ({
        fault: 'staged-owner-wrong-body' as const,
        stageProof: control,
      }),
    });
    const wrongBodyProof = await proveStagedHistoryFault(wrongBodyFault);
    // Proof: an exact-body prerequisite adversary is phase-failed before reach,
    // while the real disposal mutant reaches only after a complete `written` plan
    // and is observed through the exact post-settlement public-read loss above.
    expect(wrongBodyProof.kind).toBe('phase-failed');
    if (wrongBodyProof.kind !== 'phase-failed')
      throw new Error(`wrong staged body was ${wrongBodyProof.kind}`);
    expect(Bun.stripANSI(wrongBodyProof.failure)).toContain('wrong-stage-body');
  });

  it('Task 6.5 terminates failed memory batch admission and cleanup', async () => {
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', observeUnhandled);
    const observations: {
      rejectAt: 'update' | 'readback' | 'settlement';
      closeCalls: number;
      status: string | undefined;
      phase: string | undefined;
      failure: string;
    }[] = [];
    try {
      for (const rejectAt of ['update', 'readback', 'settlement'] as const) {
        let closeCalls = 0;
        const registrations = sourceConformanceRegistrations(declaration, {
          ...openers,
          historyBatch: (caseId) =>
            openMemoryHistoryBatchCase(caseId, undefined, {
              rejectAt,
              rejectCleanup: rejectAt === 'settlement',
              onClose: () => {
                closeCalls += 1;
              },
            }),
        });
        const terminal = await Promise.race([
          runCases(registrations, { focus: ['history.batch:independent-rollback'] }),
          new Promise<'timed-out'>((resolve) => {
            setTimeout(() => {
              resolve('timed-out');
            }, 250);
          }),
        ]);
        if (terminal === 'timed-out') throw new Error(`${rejectAt} admission did not terminate`);
        const execution = terminal.cases[0];
        observations.push({
          rejectAt,
          closeCalls,
          status: execution.status,
          phase: execution.status === 'failed' ? execution.assertionPhase : undefined,
          failure: execution.status === 'failed' ? execution.failure : '',
        });
      }
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', observeUnhandled);
    }
    // Proof: restoring either admission's unconditional `await entered` made its
    // bounded row time out; restoring cleanup's early throw skipped the close probe.
    expect(
      observations.map(({ rejectAt, closeCalls, status, phase }) => ({
        rejectAt,
        closeCalls,
        status,
        phase,
      })),
    ).toEqual([
      { rejectAt: 'update', closeCalls: 1, status: 'failed', phase: 'assertion' },
      { rejectAt: 'readback', closeCalls: 1, status: 'failed', phase: 'assertion' },
      { rejectAt: 'settlement', closeCalls: 1, status: 'failed', phase: 'cleanup' },
    ]);
    expect(observations[2]?.failure).toContain('injected memory history settlement failure');
    expect(observations[2]?.failure).toContain(
      'cleanup failed: injected memory history cleanup failure',
    );
    expect(unhandled).toEqual([]);
  });

  it('Task 6.3 observes each saved-plan capture boundary fault and reversals', async () => {
    const faults: readonly Fault<MemorySource>[] = [
      captureCompleteFault,
      captureMissingFault,
      captureDetachedFault,
    ];
    const closeCalls = faults.map(() => 0);
    const proofs = await Promise.all(
      faults.map((fault, index) =>
        proveFault(fault, openConformanceMemorySource, (source) => ({
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

    const neutralFaults: readonly Fault<MemorySource>[] = [
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

    const noReachFaults: readonly Fault<MemorySource>[] = [
      defineFault({
        id: captureCompleteFault.id,
        caseId: captureCompleteFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:complete:no-reach'),
        mutate(source: MemorySource) {
          const muted = captureCompleteFault.createControl();
          muted.arm();
          return captureFaultSource(source, muted, 'complete');
        },
      }),
      defineFault({
        id: captureMissingFault.id,
        caseId: captureMissingFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:missing:no-reach'),
        mutate(source: MemorySource) {
          const muted = captureMissingFault.createControl();
          muted.arm();
          return captureFaultSource(source, muted, 'missing');
        },
      }),
      defineFault({
        id: captureDetachedFault.id,
        caseId: captureDetachedFault.caseId,
        createControl: () => createFaultControl('saved-plan-capture:detached:no-reach'),
        mutate(source: MemorySource) {
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
        proveFault(probe.fault, openConformanceMemorySource, (source) =>
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
      mutate(source: MemorySource, control) {
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

    const wrongTargetFaults: readonly Fault<MemorySource>[] = [
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
        proveFault(fault, openConformanceMemorySource, (source) => ({
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
      mutate(source: MemorySource, control) {
        const corrupted = captureFaultSource(source, control, 'complete');
        return {
          ...corrupted,
          async close() {
            await corrupted.close();
            throw new Error('injected memory capture cleanup failure after assertion');
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
      'cleanup failed: injected memory capture cleanup failure after assertion',
    );
  });

  it('Task 6.3 capture enrichment failures remain cleanup-owned', async () => {
    let closeCalls = 0;
    const openCounted = () => {
      const source = openConformanceMemorySource();
      return {
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
          throw new Error('injected memory capture cleanup failure');
        },
      };
    };
    let failure: unknown;
    try {
      await seedMemorySource(openCounted, async (source) => {
        const capacity = replaceMethod(source.stores.capacity, 'set', (set) => {
          return (projectId, teamId, size, stamp) =>
            projectId === 'project-a' && teamId === 'team-b'
              ? Promise.reject(new Error('injected capture capacity setup failure'))
              : set(projectId, teamId, size, stamp);
        });
        await seedSavedPlanCapture({ ...source.stores, capacity }, DETERMINISTIC_SEED);
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty('errors', [
      new Error('injected capture capacity setup failure'),
      new Error('injected memory capture cleanup failure'),
    ]);
    expect(closeCalls).toBe(1);
  });

  it('Task 6.3 rejects non-null real missing captures before fault reach', async () => {
    let unknownReads = 0;
    let closeCalls = 0;
    let realMissing: PlanInputReads | null | undefined;
    let projectA: PlanInputReads | null = null;
    let projectB: PlanInputReads | null = null;
    const fault = defineFault({
      ...captureMissingFault,
      mutate(source: MemorySource, control) {
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
    const proof = await proveFault(fault, openConformanceMemorySource, (source) => ({
      ...source,
      async close() {
        closeCalls += 1;
        await source.close();
      },
    }));
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
    expect({ unknownReads, realMissing, closeCalls }).toEqual({
      unknownReads: 1,
      realMissing: null,
      closeCalls: 1,
    });
    expect(optionalCaptureMatchesOracle(projectA, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 proves the detached second-read prerequisite and ordinal', async () => {
    let targetReads = 0;
    let closeCalls = 0;
    let mutationObserved = false;
    let firstTags: readonly { readonly id: string; readonly name: string }[] | null = null;
    let firstCapture: PlanInputReads | null = null;
    let firstSnapshot: ReturnType<typeof observePlanInput> | null = null;
    let secondCapture: PlanInputReads | null = null;
    let projectB: PlanInputReads | null = null;
    const incompleteFault = defineFault({
      ...captureDetachedFault,
      mutate(source: MemorySource, control) {
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
      openConformanceMemorySource,
      (source) => ({
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      }),
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
    expect({ targetReads, mutationObserved, closeCalls }).toEqual({
      targetReads: 2,
      mutationObserved: true,
      closeCalls: 1,
    });
    expect(captureObservationMatchesOracle(firstSnapshot, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(firstCapture, 0)).toBe(false);
    expect(optionalCaptureMatchesOracle(secondCapture, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 requires the second real detached read before fault reach', async () => {
    let targetReads = 0;
    let closeCalls = 0;
    let mutationObserved = false;
    let firstTags: readonly { readonly id: string; readonly name: string }[] | null = null;
    let firstCapture: PlanInputReads | null = null;
    let firstSnapshot: ReturnType<typeof observePlanInput> | null = null;
    let projectB: PlanInputReads | null = null;
    const refusalProof = await proveFault(
      captureDetachedFault,
      openConformanceMemorySource,
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
              throw new Error('injected second memory capture refusal');
            },
          },
        ),
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
    expect({ targetReads, mutationObserved, closeCalls }).toEqual({
      targetReads: 2,
      mutationObserved: true,
      closeCalls: 1,
    });
    expect(captureObservationMatchesOracle(firstSnapshot, 0)).toBe(true);
    expect(optionalCaptureMatchesOracle(firstCapture, 0)).toBe(false);
    expect(optionalCaptureMatchesOracle(projectB, 1)).toBe(true);
  });

  it('Task 6.3 rejects an omitted capture-only directory before fault reach', async () => {
    let closeCalls = 0;
    const openCounted = () => {
      const source = openConformanceMemorySource();
      return {
        ...source,
        async close() {
          closeCalls += 1;
          await source.close();
        },
      };
    };
    let failure: unknown;
    try {
      await seedMemorySource(openCounted, async (source) => {
        const directory = replaceMethod(source.stores.directory, 'addTag', (addTag) => {
          return (tag, stamp) =>
            tag.id === 'capture-tag-only' ? Promise.resolve(tag) : addTag(tag, stamp);
        });
        await seedSavedPlanCapture({ ...source.stores, directory }, DETERMINISTIC_SEED);
      });
    } catch (cause) {
      failure = cause;
    }
    // Proof: omitting only the real capture-only tag write fails the complete
    // public seed snapshot and the source still closes exactly once.
    expect(Bun.stripANSI(String(failure))).toContain('capture-tag-only');
    expect(closeCalls).toBe(1);
  });

  it('Task 6.4 observes outside-epoch directory tearing and its reversals', async () => {
    let closeCalls = 0;
    const proof = await proveCoherentCaptureFault(captureCoherentFault, (source) => ({
      ...source,
      async close() {
        closeCalls += 1;
        await source.close();
      },
    }));
    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error('coherent tearing was not observed');
    expect(proof.phase).toBe('saved-plan-capture:coherent:directory-outside-epoch');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('Tag after interleave');
    expect(Bun.stripANSI(proof.observedFailure)).toContain('Tag 1');
    expect(closeCalls).toBe(1);

    const neutral = defineFault({
      ...captureCoherentFault,
      mutate: (source: MemorySource, control) => coherentCaptureFaultSource(source, control, false),
    });
    const neutralProof = await proveCoherentCaptureFault(neutral);
    // Proof: retaining the real held capture, committed writer, outside-epoch
    // public reads and exact reach while removing only the torn return passes.
    expect(neutralProof.kind).toBe('assertion-passed');

    const noReach = defineFault({
      id: captureCoherentFault.id,
      caseId: captureCoherentFault.caseId,
      createControl: () => createFaultControl('saved-plan-capture:coherent:no-reach'),
      mutate(source: MemorySource) {
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
      mutate(source: MemorySource, control) {
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
    const wrongTarget = defineFault({
      ...captureCoherentFault,
      mutate: (source: MemorySource, control) =>
        coherentCaptureFaultSource(source, control, true, 'project-b'),
    });
    const wrongTargetProof = await proveCoherentCaptureFault(wrongTarget, (source) => ({
      ...source,
      async close() {
        wrongTargetCloseCalls += 1;
        await source.close();
      },
    }));
    expect({ kind: wrongTargetProof.kind, wrongTargetCloseCalls }).toEqual({
      kind: 'phase-failed',
      wrongTargetCloseCalls: 1,
    });

    let writerFailureCloseCalls = 0;
    const writerFailureProof = await proveCoherentCaptureFault(
      captureCoherentFault,
      (source) => ({
        ...source,
        async close() {
          writerFailureCloseCalls += 1;
          await source.close();
        },
      }),
      () => Promise.reject(new Error('injected coherent memory writer failure')),
    );
    // Proof: rejecting the writer while capture is held releases and drains the
    // real capture, closes once, and never accepts a coherence assertion as proof.
    expect({ kind: writerFailureProof.kind, writerFailureCloseCalls }).toEqual({
      kind: 'phase-failed',
      writerFailureCloseCalls: 1,
    });
  });

  it('Task 6.4 capture failure cannot revoke an independent committed memory writer', async () => {
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
    const source = await seedMemorySource(
      () =>
        conformanceMemorySource(
          openMemorySourceWithCaptureReadSeam({
            async afterFirstRead({ projectId, project }) {
              if (projectId !== 'project-a' || didEnter) return;
              if (project.id !== projectId || project.name !== 'Captured project A')
                throw new Error('memory rollback probe reached before the real first read');
              didEnter = true;
              enter();
              await released;
              throw new Error('injected memory capture failure after independent writer');
            },
          }),
        ),
      async (seeded) => seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED),
    );
    const held = source.history.savedPlanCapture.readPlanInput('project-a');
    await entered;
    const change = await changeMemoryCaptureDirectory(source);
    release();
    let captureFailure: unknown;
    try {
      await held;
    } catch (cause) {
      captureFailure = cause;
    }
    expect((captureFailure as Error | undefined)?.message).toBe(
      'injected memory capture failure after independent writer',
    );
    const after = await source.history.savedPlanCapture.readPlanInput('project-a');
    expect(change.tag).toMatchObject({ ok: true });
    expect(change.person).toMatchObject({ ok: true });
    expect(after === null ? false : captureMatchesOracle(after, 0, 'after')).toBe(true);
    await Promise.resolve(source.close());
    closeCalls += 1;
    // Proof: coupling the writer to a rolled-back command stage restores the
    // complete before directory here; the committed writer survives capture failure.
    expect({ didEnter, closeCalls }).toEqual({ didEnter: true, closeCalls: 1 });
  });

  it('Task 6.4 rejects capture and writer work in one staged memory owner', async () => {
    const source = await seedMemorySource(openConformanceMemorySource, async (seeded) => {
      await seedSavedPlanCapture(seeded.stores, DETERMINISTIC_SEED);
    });
    let reached = false;
    let failure: unknown;
    try {
      await source.captureWithStagedDirectoryRollback(
        'project-a',
        { at: 600, by: 'owner-b' },
        ({ project, tag, person, tags, people }) => {
          reached =
            project.id === 'project-a' &&
            project.name === 'Captured project A' &&
            tag.ok &&
            tag.tag.name === 'Tag after interleave' &&
            person.ok &&
            person.person.teamIds.length === 1 &&
            person.person.teamIds[0] === 'team-a' &&
            tags.some(({ id, name }) => id === 'tag-a' && name === 'Tag after interleave') &&
            people.some(
              ({ id, teamIds }) =>
                id === 'capture-person-unassigned' &&
                teamIds.length === 1 &&
                teamIds[0] === 'team-a',
            );
          if (!reached) throw new Error('staged memory owner did not establish after state');
        },
      );
    } catch (cause) {
      failure = cause;
    }
    const afterRollback = await source.history.savedPlanCapture.readPlanInput('project-a');
    await source.close();
    expect((failure as Error | undefined)?.message).toBe('injected staged-owner capture rollback');
    // Proof: routing the same successful directory writes to committed state
    // changes this reversal to after-state; the forbidden stage restores before-state.
    expect({ reached, beforeRestored: optionalCaptureMatchesOracle(afterRollback, 0) }).toEqual({
      reached: true,
      beforeRestored: true,
    });
  });

  it("memory's unknown-step gap names an observed refusal mismatch", async () => {
    const report = await runCases(existingStoreRegistrations(openers), {
      focus: [unknownStepGap.caseId],
    });
    const execution = failedCase(report, unknownStepGap.caseId);

    expect(execution?.status).toBe('failed');
    if (execution?.status !== 'failed') throw new Error('unknown-step bypass did not fail');
    expect(execution.assertionPhase).toBe('assertion');
    const observedFailure = Bun.stripANSI(execution.failure);
    // Proof: bypassing the declaration gap ran this shared case through
    // `openMemorySource`; Bun failed on `Expected: "unknown_step" · Received: "written"`.
    expect(observedFailure).toContain(unknownStepGap.evidence.observedFailure);
  });

  it("memory's actual unknown-step gap names an observed refusal mismatch", async () => {
    const report = await runCases(existingStoreRegistrations(openers), {
      focus: ['actuals.set:unknown_step'],
    });
    const execution = failedCase(report, 'actuals.set:unknown_step');
    expect(execution?.status).toBe('failed');
    if (execution?.status !== 'failed') throw new Error('actual unknown-step bypass did not fail');
    expect(execution.assertionPhase).toBe('assertion');
    const observedFailure = Bun.stripANSI(execution.failure);
    // Proof: bypassing the actual gap through the real memory source produced
    // received `written` and the escaped work-a-one/no-such-step row with days
    // 13 at recordedAt 201 in project A's complete public list.
    expect(observedFailure).toContain(actualUnknownStepGap.evidence.observedFailure);
  });

  it("memory's measure unknown-step gap names an observed refusal mismatch", async () => {
    const report = await runCases(existingStoreRegistrations(openers), {
      focus: ['measures.set:unknown_step'],
    });
    const execution = failedCase(report, 'measures.set:unknown_step');
    expect(execution?.status).toBe('failed');
    if (execution?.status !== 'failed') throw new Error('measure unknown-step bypass did not fail');
    expect(execution.assertionPhase).toBe('assertion');
    const observedFailure = Bun.stripANSI(execution.failure);
    // Proof: bypassing the measure gap through the real memory source produced
    // received `written` and the escaped work-a-one/no-such-step token estimate,
    // value 21 at recordedAt 201, in project A's complete public list.
    expect(observedFailure).toContain(measureUnknownStepGap.evidence.observedFailure);
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

  it('reinjects capacity-key, clearing, default, and whole-ladder faults', async () => {
    const faults = [
      capacityProjectTeamFault,
      capacityClearFault,
      priorityDefaultsFault,
      priorityFirstRungFault,
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
    expect(failures[2]).toContain('"Critical"');
    expect(failures[2]).toContain('"projectA": []');
    expect(failures[3]).toContain('"label": "Soon"');

    const restored = await runCases(existingStoreRegistrations(openers), {
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual(
      faults.map(({ caseId }) => ({ caseId, status: 'passed' })),
    );
  });

  it('reinjects whole-ladder project-scope destruction', async () => {
    const proof = await proveFault(priorityProjectScopeFault);

    expect(proof.kind).toBe('observed');
    if (proof.kind !== 'observed') throw new Error('project-scope destruction was not observed');
    // Proof: resetting B through the staged source before replacing A failed
    // here on `"label": "Now"` becoming `"label": "Critical"`.
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
    // Proof: the five real memory mutations failed respectively with the tight
    // sibling still at position 11, `Escaped rename`, the child's old parent
    // `work-a-one`, the first number received as null, and the retained number
    // received as null.
    expect(failures[0]).toContain('"position": 11');
    expect(failures[1]).toContain('"name": "Escaped rename"');
    expect(failures[2]).toContain('parentId: "work-a-one"');
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
    revision: 0,
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
      declaration,
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'estimates.moveAll:ownership', status: 'passed' },
      { caseId: 'actuals.set:replace', status: 'passed' },
      { caseId: 'actuals.remove:pair', status: 'passed' },
      { caseId: 'actuals.moveAll:ownership', status: 'passed' },
      { caseId: 'actuals.set:unknown_step', status: 'not-offered' },
    ]);
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
      declaration,
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'measures.set:metric-key', status: 'passed' },
      { caseId: 'measures.remove:metric-key', status: 'passed' },
      { caseId: 'measures.moveAll:all-metrics', status: 'passed' },
      { caseId: 'measures.set:unknown_step', status: 'not-offered' },
    ]);
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
      declaration,
      focus: faults.map(({ caseId }) => caseId),
    });
    expect(restored.cases.map(({ caseId, status }) => ({ caseId, status }))).toEqual([
      { caseId: 'progress.set:replace', status: 'passed' },
      { caseId: 'progress.remove:absence', status: 'passed' },
      { caseId: 'progress.moveAll:ownership', status: 'passed' },
      { caseId: 'progress.set:unknown_step', status: 'not-offered' },
    ]);
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
    const proof = await proveFault(directoryTeamAtomicityFault, () =>
      openDirectoryPrewriteFailureSource(probe),
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

  it('runs every Task 6.1 and 6.2 saved-plan case through the staged memory source', async () => {
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

  it('reinjects all seven Task 6.1 saved-plan faults through memory state', async () => {
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

  it('reinjects Task 6.2 saved-plan faults through memory history ownership', async () => {
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
      'saved-plan:late-body:split-commit',
    ]);
    const failures = proofs.map((proof) =>
      proof.kind === 'observed' ? Bun.stripANSI(proof.observedFailure) : '',
    );
    expect(failures[0]).toContain('+           "id": "quota-refused",');
    expect(failures[1]).toContain(`    "rivalOutcome": {
-     "outcome": "refused",
-     "refusal": {
-       "allowed": 2,
-       "asked": 3,
-       "limit": "plan_count",
-     },
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

  it('rejects canonical memory split reach for wrong target, content, or phase', async () => {
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
        await proveFault(savedPlanSplitWriteFault, openConformanceMemorySource, (source) => {
          const writeSplit = source.writeSavedPlanSplit;
          return {
            ...source,
            writeSavedPlanSplit(plan, check, includeInput, observeBoundary) {
              probe.attempts += 1;
              if (corruption === 'wrong-target') Object.assign(plan, { id: 'wrong-late-target' });
              else if (corruption === 'altered-content') {
                Object.assign(plan, {
                  name: 'ALTERED TARGET',
                  createdBy: 'ALTERED DISPLAY',
                });
                Object.assign(plan.input, { bytes: 'ALTERED BODY', sha256: 'ALTERED HASH' });
              } else Object.assign(plan, { schedule: { present: false, absentReason: 'pending' } });
              return writeSplit(
                plan,
                async (holding, incomingBytes) => {
                  probe.observations?.push({
                    holding: { plans: holding.plans, bytes: holding.bytes },
                    incomingBytes,
                  });
                  return check(holding, incomingBytes);
                },
                includeInput,
                (stored) => {
                  probe.boundary = stored;
                  observeBoundary?.(stored);
                },
              ).catch((failure: unknown) => {
                probe.failure = failure;
                throw failure;
              });
            },
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
        }),
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
    expect(probes[0]).toEqual({
      attempts: 1,
      closeCalls: 1,
      state: expectedTask62PublicState(
        ['late-target', 'wrong-late-target', 'late-sentinel', 'saved-other-project'],
        sentinels,
      ),
      boundary: null,
      observations: [],
      failure: expect.objectContaining({ message: 'saved-plan split target must be late-target' }),
    });
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
      failure: expect.anything(),
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
      boundary: wrongPhase,
      observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 15 }],
      failure: expect.anything(),
    });
  });

  it('rejects missing real memory input persistence before the late boundary', async () => {
    Object.assign(memoryMissingInputProbe, {
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
    // Proof: omitting the real input slot stops before the adapter phase can reach.
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
    expect(memoryMissingInputProbe).toEqual({
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
          { ...target, bodies: { input: null, schedule: null } },
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

  it('closes after a saved-plan snapshot read fails and preserves a concurrent close failure', async () => {
    for (const closeFails of [false, true]) {
      const source = await seedMemorySource();
      const readFailure = new Error('injected saved-plan snapshot read failure');
      const closeFailure = new Error('injected memory close failure');
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
        await closeAfterSavedPlanSnapshot(
          failing,
          ['late-target', 'late-sentinel', 'saved-other-project'],
          () => undefined,
        );
      } catch (cause) {
        failure = cause;
      }

      // Proof: awaiting the failing read before cleanup left the owned source open.
      expect(closeCalls).toBe(1);
      if (closeFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toHaveProperty('errors', [readFailure, closeFailure]);
        expect(failure).toHaveProperty('cause', closeFailure);
      } else expect(failure).toBe(readFailure);
    }
  });

  it('rejects Task 6.2 memory proofs when each mutation is removed', async () => {
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

  it('rejects Task 6.2 memory failures before their named phases and closes once', async () => {
    memoryPrematureProbes.forEach((probe) => {
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
      memoryPrematureProbes.map(({ attempts, closeCalls }) => ({ attempts, closeCalls })),
    ).toEqual([
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
      { attempts: 1, closeCalls: 1 },
    ]);
    // Proof: replacing any target with a prewrite throw now records the complete
    // independently read A/B state and cannot masquerade as the intended phase.
    expect(memoryPrematureProbes.map(({ state }) => state)).toEqual(
      expectedPrematureTask62States(),
    );
  });

  it('rejects Task 6.2 memory mutations when their proof reach is removed', async () => {
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

  it('snapshots memory quota callback values before an adapter can repair aliases', async () => {
    const source = await seedMemorySource();
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
            fixtureId: `memory:${caseId}`,
            port,
            journalAppender: source.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: { kind: 'ordinary' },
            close: async () => {
              closeCalls += 1;
              await source.close();
            },
          }),
      }),
      { focus: ['savedPlans.write:quota-refusal'] },
    );
    const failure = report.cases[0];
    expect(failure.status).toBe('failed');
    if (failure.status !== 'failed') throw new Error('mutable holding probe unexpectedly passed');
    // Proof: the real callback received -777 and repaired the same object afterward;
    // the shared snapshot retained -777 and failed beside complete settled state.
    expect(Bun.stripANSI(failure.failure)).toContain('+         "bytes": -777,');
    expect(closeCalls).toBe(1);
  });

  it('rejects an in-place late target mutation against the detached memory request', async () => {
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
          const fixture = await openMemorySavedPlanCase(caseId, (evidence) => {
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
    if (execution.status !== 'failed') throw new Error('mutated late memory request passed');
    // Proof: mutating the real request after its callback used to reach and certify the
    // corrupted record; the detached boundary now refuses it and rolls the target back.
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
        inputBytes: 11,
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

  it('requires complete memory setup before a target can restore a deleted sentinel', async () => {
    const source = await seedMemorySource();
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
            fixtureId: `memory:${caseId}`,
            port,
            journalAppender: source.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: { kind: 'ordinary' },
            close: async () => {
              closeCalls += 1;
              await source.close();
            },
          }),
      }),
      { focus: ['savedPlans.write:quota-refusal'] },
    );
    expect(report.cases[0]?.status).toBe('failed');
    // Proof: deleting project B through the real port after A setup now fails the
    // complete prerequisite before the target wrapper can repair it.
    expect(targetAttempts).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it('settles and reports both memory quota-window errors before close', async () => {
    const source = await seedMemorySource();
    let rivalSettled = false;
    let closeCalls = 0;
    const base = source.history.savedPlans;
    const primary = replaceSavedPlanWrite(
      base,
      (write) => (plan, check) =>
        plan.id !== 'quota-window-last'
          ? write(plan, check)
          : write(plan, async (holding, incomingBytes) => {
              await check(holding, incomingBytes);
              throw new Error('memory quota primary failure');
            }),
    );
    const rival = replaceSavedPlanWrite(base, (write) => async (plan, check) => {
      await write(plan, check);
      rivalSettled = true;
      throw new Error('memory quota rival failure');
    });
    const report = await runCases(
      existingStoreRegistrations({
        ...openers,
        savedPlans: (caseId) =>
          Promise.resolve({
            fixtureId: `memory:${caseId}`,
            port: primary,
            journalAppender: source.journal,
            seed: DETERMINISTIC_SEED,
            readers: readersOf(source),
            scenario: {
              kind: 'competing-history-write',
              rivalWriter: rival,
              expectedRival: 'quota-refused',
            },
            close: async () => {
              closeCalls += 1;
              if (!rivalSettled) throw new Error('memory source closed before quota rival settled');
              await source.close();
            },
          }),
      }),
      { focus: ['savedPlans.write:quota-window'] },
    );
    const failure = report.cases[0];
    expect(failure.status).toBe('failed');
    if (failure.status !== 'failed') throw new Error('dual quota failure unexpectedly passed');
    // Proof: throwing after the real callback still awaited the queued real rival;
    // removing rival settlement lost this second cause and closed before settlement.
    expect(failure.failure).toContain('quota primary and rival both failed');
    expect(failure.failure).toContain('memory quota primary failure');
    expect(failure.failure).toContain('memory quota rival failure');
    expect({ rivalSettled, closeCalls }).toEqual({ rivalSettled: true, closeCalls: 1 });
  });

  it('refuses prewrite and successful-incomplete memory saved-plan proofs', async () => {
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
      proveFault(savedPlanUtf8LengthFault, openConformanceMemorySource, (source) =>
        rejectSavedPlanBeforeWrite(source, prewriteProbe),
      ),
      proveFault(savedPlanUtf8LengthFault, openConformanceMemorySource, (source) =>
        weakenSavedPlanWrite(source, probes[0], 'bodies'),
      ),
      proveFault(savedPlanHeaderOnlyFault, openConformanceMemorySource, (source) =>
        weakenSavedPlanWrite(source, probes[1], 'bodies'),
      ),
      proveFault(savedPlanPrincipalFault, openConformanceMemorySource, (source) =>
        weakenSavedPlanWrite(source, probes[2], 'creator-display'),
      ),
      proveFault(savedPlanUnknownRenameFault, openConformanceMemorySource, (source) =>
        collateralSavedPlanTouch(source, probes[3], 'renameTo'),
      ),
      proveFault(savedPlanUnknownDeleteFault, openConformanceMemorySource, (source) =>
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
});
