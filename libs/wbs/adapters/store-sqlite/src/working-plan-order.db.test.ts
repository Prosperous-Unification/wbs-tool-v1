import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Broadcaster } from '@wbs/core';
import {
  clockOf,
  createWorkingPlan,
  type Decision,
  PlanCommandRunner,
  type PlanTransactionalStores,
  type Project,
  type Scope,
  servicesOver,
  type Step,
  type UnitOfWork,
  type WriteStamp,
} from '@wbs/core';
import { fastScheduler } from '@wbs/core/testing/scheduler-fixture';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { expect, it } from 'bun:test';

import { runMigrations } from './migrate';
import { openSqliteSource } from './source';

const MIGRATIONS = new URL('../../../../../apps/wbs/be-01/drizzle', import.meta.url).pathname;
const OWNER = 'working-plan-order-owner';
const PROJECT = 'working-plan-order-project';
const ROW = 'working-plan-order-row';
const STEPS = ['step-A', 'step-a'] as const;
const STAMP: WriteStamp = { at: 1, by: OWNER };

const silentBroadcaster: Broadcaster = {
  publish: () => Promise.resolve(),
  latestSeq: () => Promise.resolve(-1),
};

function captureAdmittedStores(uow: UnitOfWork): {
  readonly uow: UnitOfWork;
  readonly current: () => PlanTransactionalStores;
} {
  let admitted: PlanTransactionalStores | undefined;
  return {
    uow: {
      run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T> {
        return uow.run((scope) => {
          admitted = scope.stores;
          return act(scope);
        });
      },
    },
    current: () => {
      if (admitted === undefined) throw new Error('batch graph built before admission');
      return admitted;
    },
  };
}

async function sqliteEstimateRunner(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-batch-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });
  await source.stores.users.create(
    { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
    STAMP,
  );
  await source.stores.projects.create(
    projectRow({ id: PROJECT, ownerId: OWNER, name }),
    [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
    STAMP,
  );
  await source.stores.workItems.insert(workItemRow({ id: ROW, projectId: PROJECT }), [], STAMP);
  await source.stores.estimates.set(
    { workItemId: ROW, stepId: 'step', optimistic: 1, realistic: 2, pessimistic: 3 },
    STAMP,
  );
  const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
  const publicGraph = servicesOver(source.stores, {
    clock,
    broadcast: silentBroadcaster,
    scheduler: fastScheduler,
  });
  const runner = new PlanCommandRunner({
    uow: source.uow,
    announcements: silentBroadcaster,
    publicServices: publicGraph,
    batchServices: (scope, broadcast) =>
      servicesOver(scope.stores, { clock, broadcast, scheduler: fastScheduler }),
  });
  return {
    source,
    publicGraph,
    runner,
    close: async () => {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('refuses then runs another SQLite batch without leaked values', async () => {
  const fixture = await sqliteEstimateRunner('SQLite refused working plan');

  try {
    expect(
      await fixture.runner.run(PROJECT, OWNER, [
        {
          kind: 'setEstimate',
          workItemId: ROW,
          stepId: 'step',
          days: { optimistic: 4, realistic: 5, pessimistic: 6 },
        },
        {
          kind: 'setEstimate',
          workItemId: 'missing-row',
          stepId: 'step',
          days: { optimistic: 7, realistic: 8, pessimistic: 9 },
        },
      ]),
    ).toMatchObject({ ok: false, at: 1, reason: 'not_found' });
    expect(await fixture.source.stores.estimates.listByWorkItems(PROJECT, [ROW])).toMatchObject([
      { optimistic: 1, realistic: 2, pessimistic: 3 },
    ]);

    expect(
      await fixture.runner.run(PROJECT, OWNER, [
        {
          kind: 'setEstimate',
          workItemId: ROW,
          stepId: 'step',
          days: { optimistic: 10, realistic: 11, pessimistic: 12 },
        },
      ]),
    ).toMatchObject({ ok: true });
    expect(await fixture.runner.undo(PROJECT, OWNER)).toMatchObject({ ok: true });
    expect(await fixture.source.stores.estimates.listByWorkItems(PROJECT, [ROW])).toMatchObject([
      { optimistic: 1, realistic: 2, pessimistic: 3 },
    ]);
  } finally {
    await fixture.close();
  }
});

it('uses an ordinary SQLite write between batches as the next before-image', async () => {
  const fixture = await sqliteEstimateRunner('SQLite intervening estimate');

  try {
    expect(
      await fixture.runner.run(PROJECT, OWNER, [
        {
          kind: 'setEstimate',
          workItemId: ROW,
          stepId: 'step',
          days: { optimistic: 4, realistic: 5, pessimistic: 6 },
        },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      (
        await fixture.publicGraph.workItems.setEstimate(ROW, OWNER, 'step', {
          optimistic: 7,
          realistic: 8,
          pessimistic: 9,
        })
      ).ok,
    ).toBe(true);
    expect(
      await fixture.runner.run(PROJECT, OWNER, [
        {
          kind: 'setEstimate',
          workItemId: ROW,
          stepId: 'step',
          days: { optimistic: 10, realistic: 11, pessimistic: 12 },
        },
      ]),
    ).toMatchObject({ ok: true });

    expect(await fixture.runner.undo(PROJECT, OWNER)).toMatchObject({ ok: true });
    // Proof: reusing the first SQLite batch's working graph restored stale
    // 4/5/6 values here instead of this intervening 7/8/9 write.
    expect(await fixture.source.stores.estimates.listByWorkItems(PROJECT, [ROW])).toMatchObject([
      { optimistic: 7, realistic: 8, pessimistic: 9 },
    ]);
  } finally {
    await fixture.close();
  }
});

it('keeps SQLite satellite order authoritative after a WorkingPlan patch refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-order-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    const project: Project = projectRow({ id: PROJECT, ownerId: OWNER });
    const steps: Step[] = STEPS.map((id) => ({
      id,
      projectId: PROJECT,
      name: id,
      position: 10,
    }));
    await source.stores.projects.create(project, steps, STAMP);
    await source.stores.workItems.insert(workItemRow({ id: ROW, projectId: PROJECT }), [], STAMP);

    for (const [index, stepId] of STEPS.entries()) {
      await source.stores.estimates.set(
        { workItemId: ROW, stepId, optimistic: index + 1, realistic: 2, pessimistic: 3 },
        STAMP,
      );
      await source.stores.actuals.set(
        { workItemId: ROW, stepId, days: index + 1, recordedAt: index + 1 },
        STAMP,
      );
      await source.stores.progress.set(
        { workItemId: ROW, stepId, state: 'in_progress', statedAt: index + 1 },
        STAMP,
      );
      await source.stores.measures.set(
        {
          workItemId: ROW,
          stepId,
          metric: 'token_estimate',
          value: index + 1,
          recordedAt: index + 1,
        },
        STAMP,
      );
    }

    const workingPlan = createWorkingPlan({ stores: source.stores }, PROJECT);
    await Promise.all([
      workingPlan.stores.workItems.listByProject(PROJECT),
      workingPlan.stores.estimates.listByProject(PROJECT),
      workingPlan.stores.actuals.listByProject(PROJECT),
      workingPlan.stores.progress.listByProject(PROJECT),
      workingPlan.stores.measures.listByProject(PROJECT),
    ]);
    expect(
      await workingPlan.stores.workItems.patch(ROW, { name: 'Patched' }, { at: 2, by: OWNER }),
    ).toMatchObject({ ok: true });

    const [estimates, actuals, progress, measures] = await Promise.all([
      source.stores.estimates.listByProject(PROJECT),
      source.stores.actuals.listByProject(PROJECT),
      source.stores.progress.listByProject(PROJECT),
      source.stores.measures.listByProject(PROJECT),
    ]);
    // Proof: the targeted SQLite readers' old localeCompare post-sort reversed
    // the retained step-A/step-a rows after this production WorkingPlan refresh.
    expect(await workingPlan.stores.estimates.listByProject(PROJECT)).toEqual(estimates);
    expect(await workingPlan.stores.actuals.listByProject(PROJECT)).toEqual(actuals);
    expect(await workingPlan.stores.progress.listByProject(PROJECT)).toEqual(progress);
    expect(await workingPlan.stores.measures.listByProject(PROJECT)).toEqual(measures);
    workingPlan.close();
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps SQLite dependency order authoritative after a WorkingPlan add', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-edge-order-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await source.stores.workItems.insert(workItemRow({ id, projectId: PROJECT }), [], STAMP);
    }
    for (const edge of [
      { id: 'edge-a-b', projectId: PROJECT, predecessorId: 'a', successorId: 'b' },
      { id: 'edge-c-d', projectId: PROJECT, predecessorId: 'c', successorId: 'd' },
    ]) {
      await source.stores.dependencies.add(edge, STAMP);
    }

    const workingPlan = createWorkingPlan({ stores: source.stores }, PROJECT);
    await workingPlan.stores.dependencies.listByProject(PROJECT);
    await workingPlan.stores.dependencies.add(
      { id: 'edge-a-e', projectId: PROJECT, predecessorId: 'a', successorId: 'e' },
      { at: 2, by: OWNER },
    );

    expect(await workingPlan.stores.dependencies.listByProject(PROJECT)).toEqual(
      await source.stores.dependencies.listByProject(PROJECT),
    );
    // Proof: inserting a new incident replacement beside edge-a-b moved the
    // unrelated edge-c-d behind it instead of retaining SQLite's source order.
    expect(
      (await workingPlan.stores.dependencies.listByProject(PROJECT)).map(({ id }) => id),
    ).toEqual(['edge-a-b', 'edge-c-d', 'edge-a-e']);
    workingPlan.close();
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('advances SQLite assignment and directory cascades before the next runner command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-directory-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    await source.stores.workItems.insert(
      workItemRow({ id: ROW, projectId: PROJECT, name: 'Before directory writes' }),
      [],
      STAMP,
    );
    const team = await source.stores.directory.addTeam(
      { id: 'removed-team', name: 'Removed team' },
      STAMP,
    );
    const labelled = await source.stores.workItems.patch(ROW, { teamIds: [team.id] }, STAMP);
    if (!labelled.ok) throw new Error('SQLite directory row labelling refused');

    const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, silentBroadcaster);
    const assignmentObservations: { retained: number | undefined; stored: number | undefined }[] =
      [];
    let borrowedBeforeRemoval: { revision: number; teamIds: readonly string[] } | undefined;
    let retainedAfterRemoval: { revision: number; teamIds: readonly string[] } | undefined;
    let storedAfterRemoval: { revision: number; teamIds: readonly string[] } | undefined;
    const admitted = captureAdmittedStores(source.uow);
    const runner = new PlanCommandRunner({
      uow: admitted.uow,
      announcements: silentBroadcaster,
      publicServices: publicGraph,
      batchServices(scope, broadcast) {
        const directoryStore = {
          ...scope.stores.directory,
          assign: async (
            ...parameters: Parameters<PlanTransactionalStores['directory']['assign']>
          ) => {
            const written = await scope.stores.directory.assign(...parameters);
            if (written.ok) {
              assignmentObservations.push({
                retained: (await scope.stores.workItems.listByIds(PROJECT, [parameters[0]])).at(0)
                  ?.revision,
                stored: (await admitted.current().workItems.listByIds(PROJECT, [parameters[0]])).at(
                  0,
                )?.revision,
              });
            }
            return written;
          },
          removeTeam: async (
            ...parameters: Parameters<PlanTransactionalStores['directory']['removeTeam']>
          ) => {
            borrowedBeforeRemoval = (await scope.stores.workItems.listByIds(PROJECT, [ROW])).at(0);
            const removed = await scope.stores.directory.removeTeam(...parameters);
            if (removed.ok) {
              retainedAfterRemoval = (await scope.stores.workItems.listByIds(PROJECT, [ROW])).at(0);
              storedAfterRemoval = (
                await admitted.current().workItems.listByIds(PROJECT, [ROW])
              ).at(0);
            }
            return removed;
          },
        };
        return compose({ ...scope.stores, directory: directoryStore }, broadcast);
      },
    });

    const createdAndAssigned = await runner.run(PROJECT, OWNER, [
      { kind: 'createPerson', ref: 'created-person', name: 'Created in batch', teamIds: [] },
      {
        kind: 'setAssignee',
        workItemId: ROW,
        stepId: 'step',
        personId: null,
        personRef: 'created-person',
      },
    ]);
    expect(createdAndAssigned).toMatchObject({ ok: true });
    const createdPersonId = createdAndAssigned.ok ? createdAndAssigned.results[0]?.id : undefined;
    if (createdPersonId === undefined) throw new Error('SQLite createPerson returned no id');

    const replacement = await source.stores.directory.addPerson(
      { id: 'replacement-person', name: 'Replacement' },
      [],
      STAMP,
    );
    if (!replacement.ok) throw new Error('SQLite replacement person creation refused');
    expect(
      await runner.run(PROJECT, OWNER, [
        {
          kind: 'setAssignee',
          workItemId: ROW,
          stepId: 'step',
          personId: replacement.person.id,
        },
        { kind: 'patchWorkItem', workItemId: ROW, patch: { name: 'After assignment' } },
      ]),
    ).toMatchObject({ ok: true });

    // Proof: omitting assign's target refresh left the second observation at
    // retained revision 2 while SQLite already held revision 3.
    expect(assignmentObservations).toEqual([
      { retained: 2, stored: 2 },
      { retained: 3, stored: 3 },
    ]);
    const assignmentEntry = (await source.stores.journal.entriesFor(PROJECT, OWNER)).at(-1);
    if (assignmentEntry === undefined) throw new Error('SQLite assignment batch wrote no journal');
    expect(assignmentEntry.preconditions).toEqual({ expected: { [ROW]: 4 }, from: { [ROW]: 2 } });
    expect(await runner.undo(PROJECT, OWNER)).toMatchObject({ ok: true });
    expect(await source.stores.directory.assignmentsFor(ROW)).toEqual([
      { workItemId: ROW, stepId: 'step', personId: createdPersonId },
    ]);
    expect(await source.stores.workItems.listByIds(PROJECT, [ROW])).toMatchObject([
      { id: ROW, name: 'Before directory writes', teamIds: [team.id] },
    ]);

    const beforeCascade = (await source.stores.workItems.listByIds(PROJECT, [ROW])).at(0);
    if (beforeCascade === undefined) throw new Error('SQLite cascade fixture row missing');
    expect(
      await runner.run(PROJECT, OWNER, [
        { kind: 'deleteTeam', teamId: team.id, cascade: true },
        { kind: 'patchWorkItem', workItemId: ROW, patch: { name: 'After cascade' } },
      ]),
    ).toMatchObject({ ok: true });

    // Proof: removing the successful-delete reload barrier left the retained
    // row labelled at the prior revision while SQLite had removed the label
    // and advanced exactly once before the second command.
    expect(retainedAfterRemoval).toEqual(storedAfterRemoval);
    expect(retainedAfterRemoval).toMatchObject({
      revision: beforeCascade.revision + 1,
      teamIds: [],
    });
    expect(borrowedBeforeRemoval).toMatchObject({
      revision: beforeCascade.revision,
      teamIds: [team.id],
    });
    expect(await source.stores.workItems.listByIds(PROJECT, [ROW])).toMatchObject([
      { id: ROW, name: 'After cascade', revision: beforeCascade.revision + 2, teamIds: [] },
    ]);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rolls back a successful directory write when its retained reload fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-directory-rollback-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    await source.stores.workItems.insert(
      workItemRow({ id: ROW, projectId: PROJECT, name: 'Before rollback' }),
      [],
      STAMP,
    );
    await source.stores.directory.addTeam({ id: 'rollback-team', name: 'Rollback team' }, STAMP);
    const labelled = await source.stores.workItems.patch(
      ROW,
      { teamIds: ['rollback-team'] },
      STAMP,
    );
    if (!labelled.ok) throw new Error('SQLite rollback row labelling refused');
    const before = (await source.stores.workItems.listByIds(PROJECT, [ROW])).at(0);
    if (before === undefined) throw new Error('SQLite rollback fixture row missing');

    const failingUow: UnitOfWork = {
      run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T> {
        return source.uow.run((scope) => {
          let fullReads = 0;
          const workItems = new Proxy(scope.stores.workItems, {
            get(target, key, receiver) {
              if (key === 'listByProject') {
                return (projectId: string) => {
                  fullReads += 1;
                  if (fullReads === 2) throw new Error('injected directory reload failure');
                  return target.listByProject(projectId);
                };
              }
              const member: unknown = Reflect.get(target, key, receiver);
              if (typeof member !== 'function') return member;
              return (...parameters: unknown[]): unknown =>
                Reflect.apply(member, target, parameters);
            },
          });
          return act({
            stores: {
              ...scope.stores,
              workItems,
            },
          });
        });
      },
    };
    const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, silentBroadcaster);
    const runner = new PlanCommandRunner({
      uow: failingUow,
      announcements: silentBroadcaster,
      publicServices: publicGraph,
      batchServices: (scope, broadcast) => compose(scope.stores, broadcast),
    });

    // Proof: catching this reload failure would commit both the preceding
    // rename and the directory cascade while leaving retained state stale.
    expect(
      runner.run(PROJECT, OWNER, [
        { kind: 'patchWorkItem', workItemId: ROW, patch: { name: 'Must roll back' } },
        { kind: 'deleteTeam', teamId: 'rollback-team', cascade: true },
      ]),
    ).rejects.toThrow('injected directory reload failure');
    expect(await source.stores.directory.listTeams()).toContainEqual({
      id: 'rollback-team',
      name: 'Rollback team',
      serviceIds: [],
    });
    expect(await source.stores.workItems.listByIds(PROJECT, [ROW])).toEqual([before]);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('places every new subtree row and value group in SQLite authoritative order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-subtree-order-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    for (const id of ['m-existing', 'z-existing']) {
      await source.stores.workItems.insert(workItemRow({ id, projectId: PROJECT }), [], STAMP);
    }
    await source.stores.estimates.set(
      {
        workItemId: 'z-existing',
        stepId: 'step',
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      },
      STAMP,
    );

    const workingPlan = createWorkingPlan({ stores: source.stores }, PROJECT);
    await Promise.all([
      workingPlan.stores.workItems.listByProject(PROJECT),
      workingPlan.stores.estimates.listByProject(PROJECT),
      workingPlan.stores.actuals.listByProject(PROJECT),
      workingPlan.stores.progress.listByProject(PROJECT),
      workingPlan.stores.measures.listByProject(PROJECT),
      workingPlan.stores.dependencies.listByProject(PROJECT),
    ]);
    await workingPlan.stores.subtrees.insertSubtree(
      {
        // Parent-first insertion deliberately opposes SQLite's BINARY id order.
        rows: [
          workItemRow({ id: 'b-new-root', projectId: PROJECT, name: 'New root' }),
          workItemRow({
            id: 'a-new-child',
            projectId: PROJECT,
            parentId: 'b-new-root',
            name: 'New child',
          }),
        ],
        respaced: [],
        reparented: [],
        estimates: [
          {
            workItemId: 'b-new-root',
            stepId: 'step',
            optimistic: 2,
            realistic: 3,
            pessimistic: 4,
          },
          {
            workItemId: 'a-new-child',
            stepId: 'step',
            optimistic: 3,
            realistic: 4,
            pessimistic: 5,
          },
        ],
        actuals: [
          { workItemId: 'b-new-root', stepId: 'step', days: 2, recordedAt: 2 },
          { workItemId: 'a-new-child', stepId: 'step', days: 3, recordedAt: 2 },
        ],
        progress: [
          { workItemId: 'b-new-root', stepId: 'step', state: 'in_progress', statedAt: 2 },
          { workItemId: 'a-new-child', stepId: 'step', state: 'done', statedAt: 2 },
        ],
        measures: [
          {
            workItemId: 'b-new-root',
            stepId: 'step',
            metric: 'token_estimate',
            value: 2,
            recordedAt: 2,
          },
          {
            workItemId: 'a-new-child',
            stepId: 'step',
            metric: 'token_estimate',
            value: 3,
            recordedAt: 2,
          },
        ],
        assignments: [],
        dependencies: [
          {
            id: 'new-edge',
            projectId: PROJECT,
            predecessorId: 'b-new-root',
            successorId: 'a-new-child',
          },
        ],
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [],
      },
      { at: 2, by: OWNER },
    );

    const retained = await Promise.all([
      workingPlan.stores.workItems.listByProject(PROJECT),
      workingPlan.stores.estimates.listByProject(PROJECT),
      workingPlan.stores.actuals.listByProject(PROJECT),
      workingPlan.stores.progress.listByProject(PROJECT),
      workingPlan.stores.measures.listByProject(PROJECT),
      workingPlan.stores.dependencies.listByProject(PROJECT),
    ]);
    const authoritative = await Promise.all([
      source.stores.workItems.listByProject(PROJECT),
      source.stores.estimates.listByProject(PROJECT),
      source.stores.actuals.listByProject(PROJECT),
      source.stores.progress.listByProject(PROJECT),
      source.stores.measures.listByProject(PROJECT),
      source.stores.dependencies.listByProject(PROJECT),
    ]);
    // Proof: bypassing adapter placements and applying insertedIds in copy
    // insertion order returned b-new-root before a-new-child instead of BINARY order.
    expect(retained).toEqual(authoritative);
    expect(retained[0].map(({ id }) => id)).toEqual([
      'a-new-child',
      'b-new-root',
      'm-existing',
      'z-existing',
    ]);
    expect([
      retained[1].map(({ workItemId }) => workItemId),
      retained[2].map(({ workItemId }) => workItemId),
      retained[3].map(({ workItemId }) => workItemId),
      retained[4].map(({ workItemId }) => workItemId),
    ]).toEqual([
      ['a-new-child', 'b-new-root', 'z-existing'],
      ['a-new-child', 'b-new-root'],
      ['a-new-child', 'b-new-root'],
      ['a-new-child', 'b-new-root'],
    ]);
    workingPlan.close();
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps SQLite work-item order authoritative immediately after a runner insert', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-insert-order-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    const project: Project = projectRow({ id: PROJECT, ownerId: OWNER });
    const steps: Step[] = [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }];
    await source.stores.projects.create(project, steps, STAMP);
    for (const id of ['z-existing', 'm-unaffected']) {
      await source.stores.workItems.insert(workItemRow({ id, projectId: PROJECT }), [], STAMP);
      for (const write of [
        source.stores.estimates.set(
          { workItemId: id, stepId: 'step', optimistic: 1, realistic: 2, pessimistic: 3 },
          STAMP,
        ),
        source.stores.actuals.set(
          { workItemId: id, stepId: 'step', days: 1, recordedAt: 1 },
          STAMP,
        ),
        source.stores.progress.set(
          { workItemId: id, stepId: 'step', state: 'done', statedAt: 1 },
          STAMP,
        ),
      ])
        await write;
      for (const metric of ['token_estimate', 'token_actual', 'hours_actual'] as const) {
        await source.stores.measures.set(
          { workItemId: id, stepId: 'step', metric, value: 1, recordedAt: 1 },
          STAMP,
        );
      }
    }

    const ids = ['a-inserted', 'journal', 'event'];
    const clock = clockOf({
      now: () => 2,
      newId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('runner minted an unexpected fourth id');
        return id;
      },
    });
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, silentBroadcaster);
    const admitted = captureAdmittedStores(source.uow);
    const runner = new PlanCommandRunner({
      uow: admitted.uow,
      announcements: silentBroadcaster,
      publicServices: publicGraph,
      batchServices(scope, broadcast) {
        const loadedValues = Promise.all([
          scope.stores.estimates.listByProject(PROJECT),
          scope.stores.actuals.listByProject(PROJECT),
          scope.stores.progress.listByProject(PROJECT),
          scope.stores.measures.listByProject(PROJECT),
        ]);
        const workItems = {
          ...scope.stores.workItems,
          insert: async (
            ...parameters: Parameters<PlanTransactionalStores['workItems']['insert']>
          ) => {
            await scope.stores.workItems.insert(...parameters);
            const retained = await scope.stores.workItems.listByProject(PROJECT);
            const authoritative = await admitted.current().workItems.listByProject(PROJECT);
            // Proof: before adapter-authoritative reordering, RetainedRows appended
            // a-inserted and this received z-existing,a-inserted from the working plan.
            expect(retained).toEqual(authoritative);
            expect(retained.map(({ id }) => id)).toEqual([
              'a-inserted',
              'm-unaffected',
              'z-existing',
            ]);
          },
        };
        const measures = {
          ...scope.stores.measures,
          moveAll: async (
            ...parameters: Parameters<PlanTransactionalStores['measures']['moveAll']>
          ) => {
            await loadedValues;
            await scope.stores.measures.moveAll(...parameters);
            const retained = await Promise.all([
              scope.stores.estimates.listByProject(PROJECT),
              scope.stores.actuals.listByProject(PROJECT),
              scope.stores.progress.listByProject(PROJECT),
              scope.stores.measures.listByProject(PROJECT),
            ]);
            const authoritative = await Promise.all([
              admitted.current().estimates.listByProject(PROJECT),
              admitted.current().actuals.listByProject(PROJECT),
              admitted.current().progress.listByProject(PROJECT),
              admitted.current().measures.listByProject(PROJECT),
            ]);
            // Proof: appending new value groups instead of applying their placement returned the
            // unaffected group before the moveAll destination in all four retained collections.
            expect(retained).toEqual(authoritative);
            expect(retained.map((rows) => rows.map(({ workItemId }) => workItemId))).toEqual([
              ['a-inserted', 'm-unaffected'],
              ['a-inserted', 'm-unaffected'],
              ['a-inserted', 'm-unaffected'],
              [
                'a-inserted',
                'a-inserted',
                'a-inserted',
                'm-unaffected',
                'm-unaffected',
                'm-unaffected',
              ],
            ]);
          },
        };
        return compose({ ...scope.stores, workItems, measures }, broadcast);
      },
    });

    expect(
      await runner.run(PROJECT, OWNER, [
        {
          kind: 'createWorkItem',
          parentId: 'z-existing',
          afterId: null,
          name: 'Inserted',
        },
      ]),
    ).toMatchObject({ ok: true });
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('refreshes a dependency survivor before the next runner command and preserves undo', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-dependency-survivor-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    for (const id of ['doomed', 'survivor']) {
      await source.stores.workItems.insert(
        workItemRow({ id, projectId: PROJECT, name: id, position: id === 'doomed' ? 10 : 20 }),
        [],
        STAMP,
      );
    }
    await source.stores.dependencies.add(
      {
        id: 'external-edge',
        projectId: PROJECT,
        predecessorId: 'doomed',
        successorId: 'survivor',
      },
      STAMP,
    );

    const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, silentBroadcaster);
    let retainedBeforeNext: number | undefined;
    let authoritativeBeforeNext: number | undefined;
    let observeDependencyRemoval = true;
    const admitted = captureAdmittedStores(source.uow);
    const runner = new PlanCommandRunner({
      uow: admitted.uow,
      announcements: silentBroadcaster,
      publicServices: publicGraph,
      batchServices(scope, broadcast) {
        if (!observeDependencyRemoval) return compose(scope.stores, broadcast);
        observeDependencyRemoval = false;
        const dependencies = {
          ...scope.stores.dependencies,
          removeAllFor: async (
            ...parameters: Parameters<PlanTransactionalStores['dependencies']['removeAllFor']>
          ) => {
            await scope.stores.dependencies.removeAllFor(...parameters);
            retainedBeforeNext = (await scope.stores.workItems.listByIds(PROJECT, ['survivor'])).at(
              0,
            )?.revision;
            authoritativeBeforeNext = (
              await admitted.current().workItems.listByIds(PROJECT, ['survivor'])
            ).at(0)?.revision;
          },
        };
        return compose({ ...scope.stores, dependencies }, broadcast);
      },
    });

    expect(
      await runner.run(PROJECT, OWNER, [
        { kind: 'deleteWorkItem', workItemId: 'doomed', strategy: 'cascade' },
        { kind: 'patchWorkItem', workItemId: 'survivor', patch: { name: 'Patched survivor' } },
      ]),
    ).toMatchObject({ ok: true });

    // Proof: omitting the captured survivor from removeAllFor's refresh left
    // retainedBeforeNext at 1 while the admitted SQLite row was revision 2.
    expect(retainedBeforeNext).toBe(2);
    expect(retainedBeforeNext).toBe(authoritativeBeforeNext);
    const entry = (await source.stores.journal.entriesFor(PROJECT, OWNER)).at(0);
    if (entry === undefined) throw new Error('dependency survivor batch wrote no journal entry');
    expect(entry.preconditions).toEqual({
      expected: { survivor: 3 },
      from: { survivor: 1 },
    });

    expect(await runner.undo(PROJECT, OWNER)).toMatchObject({ ok: true });
    expect(await source.stores.dependencies.listByProject(PROJECT)).toMatchObject([
      {
        projectId: PROJECT,
        predecessorId: 'doomed',
        successorId: 'survivor',
      },
    ]);
    expect(await source.stores.workItems.listByIds(PROJECT, ['doomed', 'survivor'])).toMatchObject([
      { id: 'doomed', name: 'doomed' },
      { id: 'survivor', name: 'survivor' },
    ]);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps every SQLite value group in source order after runner sets populate an earlier group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-value-order-'));
  const path = join(directory, 'source.db');
  runMigrations(path, MIGRATIONS);
  const source = openSqliteSource({ dbPath: path });

  try {
    await source.stores.users.create(
      { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
      STAMP,
    );
    await source.stores.projects.create(
      projectRow({ id: PROJECT, ownerId: OWNER }),
      [{ id: 'step', projectId: PROJECT, name: 'Step', position: 10 }],
      STAMP,
    );
    for (const id of ['z-existing', 'a-earlier']) {
      await source.stores.workItems.insert(workItemRow({ id, projectId: PROJECT }), [], STAMP);
    }
    await source.stores.estimates.set(
      { workItemId: 'z-existing', stepId: 'step', optimistic: 1, realistic: 2, pessimistic: 3 },
      STAMP,
    );
    await source.stores.actuals.set(
      { workItemId: 'z-existing', stepId: 'step', days: 1, recordedAt: 1 },
      STAMP,
    );
    await source.stores.progress.set(
      { workItemId: 'z-existing', stepId: 'step', state: 'done', statedAt: 1 },
      STAMP,
    );
    for (const metric of ['token_estimate', 'token_actual', 'hours_actual'] as const) {
      await source.stores.measures.set(
        { workItemId: 'z-existing', stepId: 'step', metric, value: 1, recordedAt: 1 },
        STAMP,
      );
    }

    const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, silentBroadcaster);
    let observations = 0;
    const admitted = captureAdmittedStores(source.uow);
    const runner = new PlanCommandRunner({
      uow: admitted.uow,
      announcements: silentBroadcaster,
      publicServices: publicGraph,
      batchServices(scope, broadcast) {
        const loaded = Promise.all([
          scope.stores.estimates.listByProject(PROJECT),
          scope.stores.actuals.listByProject(PROJECT),
          scope.stores.progress.listByProject(PROJECT),
          scope.stores.measures.listByProject(PROJECT),
        ]);
        const measures = {
          ...scope.stores.measures,
          set: async (...parameters: Parameters<PlanTransactionalStores['measures']['set']>) => {
            await loaded;
            const written = await scope.stores.measures.set(...parameters);
            if (parameters[0].metric === 'hours_actual') {
              const retained = await Promise.all([
                scope.stores.estimates.listByProject(PROJECT),
                scope.stores.actuals.listByProject(PROJECT),
                scope.stores.progress.listByProject(PROJECT),
                scope.stores.measures.listByProject(PROJECT),
              ]);
              const authoritative = await Promise.all([
                admitted.current().estimates.listByProject(PROJECT),
                admitted.current().actuals.listByProject(PROJECT),
                admitted.current().progress.listByProject(PROJECT),
                admitted.current().measures.listByProject(PROJECT),
              ]);
              expect(retained).toEqual(authoritative);
              expect(retained.map((rows) => rows.map(({ workItemId }) => workItemId))).toEqual([
                ['a-earlier', 'z-existing'],
                ['a-earlier', 'z-existing'],
                ['a-earlier', 'z-existing'],
                ['a-earlier', 'a-earlier', 'a-earlier', 'z-existing', 'z-existing', 'z-existing'],
              ]);
              observations += 1;
            }
            return written;
          },
        };
        return compose({ ...scope.stores, measures }, broadcast);
      },
    });

    expect(
      await runner.run(PROJECT, OWNER, [
        {
          kind: 'setEstimate',
          workItemId: 'a-earlier',
          stepId: 'step',
          days: { optimistic: 2, realistic: 3, pessimistic: 4 },
        },
        { kind: 'setActual', workItemId: 'a-earlier', stepId: 'step', days: 2 },
        { kind: 'setProgress', workItemId: 'a-earlier', stepId: 'step', state: 'in_progress' },
        ...(['token_estimate', 'token_actual', 'hours_actual'] as const).map((metric) => ({
          kind: 'setMeasure' as const,
          workItemId: 'a-earlier',
          stepId: 'step',
          metric,
          value: 2,
        })),
        { kind: 'clearEstimate', workItemId: 'a-earlier', stepId: 'step' },
        { kind: 'clearActual', workItemId: 'a-earlier', stepId: 'step' },
        { kind: 'clearProgress', workItemId: 'a-earlier', stepId: 'step' },
        ...(['token_estimate', 'token_actual', 'hours_actual'] as const).map((metric) => ({
          kind: 'clearMeasure' as const,
          workItemId: 'a-earlier',
          stepId: 'step',
          metric,
        })),
        {
          kind: 'setEstimate',
          workItemId: 'a-earlier',
          stepId: 'step',
          days: { optimistic: 3, realistic: 4, pessimistic: 5 },
        },
        { kind: 'setActual', workItemId: 'a-earlier', stepId: 'step', days: 3 },
        { kind: 'setProgress', workItemId: 'a-earlier', stepId: 'step', state: 'done' },
        ...(['token_estimate', 'token_actual', 'hours_actual'] as const).map((metric) => ({
          kind: 'setMeasure' as const,
          workItemId: 'a-earlier',
          stepId: 'step',
          metric,
          value: 3,
        })),
      ]),
    ).toMatchObject({ ok: true });
    expect(observations).toBe(2);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
