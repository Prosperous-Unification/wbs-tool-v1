import type { TransactionalStores } from '@wbs/core';
import { SavedPlanService } from '@wbs/core';
import { fastScheduler } from '@wbs/core/testing/scheduler-fixture';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { describe, expect, it } from 'bun:test';

import { openMemorySource } from './source';

const stamp = { at: 1, by: 'owner' };
const STORE_BINDINGS = [
  'actuals',
  'calendarMarkers',
  'capacity',
  'dependencies',
  'directory',
  'estimates',
  'eventLog',
  'journal',
  'measures',
  'planEvents',
  'priorityBands',
  'progress',
  'projects',
  'steps',
  'subtrees',
  'users',
  'workItems',
] as const satisfies readonly (keyof TransactionalStores)[];

async function seededSource() {
  const source = openMemorySource();
  await source.stores.users.create(
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    stamp,
  );
  await source.stores.projects.create(
    {
      id: 'p1',
      name: 'Before',
      ownerId: 'owner',
      restricted: false,
      estimateMethod: 'pert',
      depReach: 'whole-item',
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'round',
      startDate: null,
      solutionRef: null,
      revision: 0,
      createdAt: 1,
      optimizationEnabled: false,
      scheduleEngine: 'fast',
      scheduleObjective: 'pri',
    },
    [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
    stamp,
  );
  return source;
}

function mutateReturned(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && mutateReturned(value[0]);
  if (value instanceof Map) {
    value.set('caller-mutation', 1);
    return true;
  }
  if (value === null || typeof value !== 'object') return false;
  for (const [key, member] of Object.entries(value)) {
    if (typeof member === 'string') {
      Reflect.set(value, key, `${member}:caller-mutation`);
      return true;
    }
    if (mutateReturned(member)) return true;
  }
  return false;
}

async function expectDetachedReads(stores: TransactionalStores): Promise<void> {
  expect(Object.keys(stores).sort()).toEqual([...STORE_BINDINGS]);
  const createdUser = await stores.users.create(
    { id: 'reader', username: 'reader', passwordHash: 'x', createdAt: 2 },
    stamp,
  );
  const workItem = workItemRow({ id: 'wi-1', projectId: 'p1', name: 'Stored work' });
  await stores.workItems.insert(workItem, [], stamp);
  const addedStep = await stores.steps.add(
    { id: 'step-memory', projectId: 'p1', name: 'Stored step' },
    stamp,
  );
  await stores.dependencies.add(
    { id: 'dep-1', projectId: 'p1', predecessorId: 'wi-1', successorId: 'wi-2' },
    stamp,
  );
  await stores.estimates.set(
    { workItemId: 'wi-1', stepId: 'step-memory', optimistic: 1, realistic: 2, pessimistic: 3 },
    stamp,
  );
  await stores.actuals.set(
    { workItemId: 'wi-1', stepId: 'step-memory', days: 2, recordedAt: 2 },
    stamp,
  );
  await stores.measures.set(
    {
      workItemId: 'wi-1',
      stepId: 'step-memory',
      metric: 'token_estimate',
      value: 5,
      recordedAt: 2,
    },
    stamp,
  );
  await stores.progress.set(
    { workItemId: 'wi-1', stepId: 'step-memory', state: 'done', statedAt: 2 },
    stamp,
  );
  const recorded = await stores.eventLog.recordEvent(
    'project:p1',
    { nested: { label: 'stored message' } },
    2,
  );
  const tag = await stores.directory.addTag({ id: 'tag-1', name: 'Stored tag' }, stamp);
  await stores.capacity.set('p1', 'team-1', 3, stamp);
  const markerWritten = await stores.calendarMarkers.create({
    id: '10000000-0000-4000-8000-000000000001',
    projectId: 'p1',
    date: '2026-09-10',
    name: 'Stored marker',
    color: null,
    createdAt: 2,
  });
  await stores.journal.append(
    {
      id: 'journal-1',
      projectId: 'p1',
      userId: 'owner',
      kind: 'rename',
      payload: { nested: { label: 'stored payload' } },
      inverse: { type: 'rename' },
      preconditions: { 'wi-1': 0 },
      createdAt: 2,
    },
    {
      id: 'plan-event-1',
      projectId: 'p1',
      userId: 'owner',
      kind: 'rename',
      label: 'Stored event',
      workItemId: 'wi-1',
      stepId: null,
      before: { name: 'Before' },
      after: { name: 'After' },
      createdAt: 2,
    },
  );
  const created = await stores.projects.create(
    {
      id: 'p2',
      name: 'Stored project',
      ownerId: 'owner',
      restricted: false,
      estimateMethod: 'pert',
      depReach: 'whole-item',
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'round',
      startDate: null,
      solutionRef: { slug: 'stored-slug', url: 'https://example.invalid/stored' },
      revision: 0,
      createdAt: 2,
    },
    [],
    stamp,
  );
  const updated = await stores.projects.update('p1', { name: 'Stored update' }, stamp);

  const cases: readonly {
    readonly name: string;
    readonly returned: unknown;
    readonly reread: () => Promise<unknown>;
    readonly mutate?: (value: unknown) => boolean;
  }[] = [
    {
      name: 'users',
      returned: createdUser,
      reread: () => stores.users.findById('reader'),
    },
    {
      name: 'step add',
      returned: addedStep.ok ? addedStep.step : addedStep,
      reread: () => stores.steps.findById('step-memory'),
    },
    {
      name: 'step list',
      returned: await stores.steps.listByProject('p1'),
      reread: () => stores.steps.listByProject('p1'),
    },
    {
      name: 'step find',
      returned: await stores.steps.findById('step-memory'),
      reread: () => stores.steps.findById('step-memory'),
    },
    {
      name: 'dependencies',
      returned: await stores.dependencies.listByProject('p1'),
      reread: () => stores.dependencies.listByProject('p1'),
    },
    {
      name: 'directory',
      returned: tag,
      reread: async () => (await stores.directory.listTags())[0],
    },
    {
      name: 'capacity map',
      returned: await stores.capacity.slotsFor('p1'),
      reread: () => stores.capacity.slotsFor('p1'),
    },
    {
      name: 'priority bands',
      returned: await stores.priorityBands.listFor('p1'),
      reread: () => stores.priorityBands.listFor('p1'),
    },
    {
      name: 'calendar markers',
      returned: markerWritten.ok ? markerWritten.marker : markerWritten,
      reread: async () => (await stores.calendarMarkers.listFor('p1'))[0],
    },
    {
      name: 'work item list',
      returned: await stores.workItems.listByProject('p1'),
      reread: () => stores.workItems.listByProject('p1'),
    },
    {
      name: 'work item find',
      returned: await stores.workItems.findById('wi-1'),
      reread: () => stores.workItems.findById('wi-1'),
    },
    {
      name: 'actuals',
      returned: await stores.actuals.listByProject('p1'),
      reread: () => stores.actuals.listByProject('p1'),
    },
    {
      name: 'estimates',
      returned: await stores.estimates.listByProject('p1'),
      reread: () => stores.estimates.listByProject('p1'),
    },
    {
      name: 'measures',
      returned: await stores.measures.listByProject('p1'),
      reread: () => stores.measures.listByProject('p1'),
    },
    {
      name: 'progress',
      returned: await stores.progress.listByProject('p1'),
      reread: () => stores.progress.listByProject('p1'),
    },
    {
      name: 'event record',
      returned: recorded,
      reread: async () => (await stores.eventLog.rangeSince('project:p1', -1))[0],
    },
    {
      name: 'event range',
      returned: await stores.eventLog.rangeSince('project:p1', -1),
      reread: () => stores.eventLog.rangeSince('project:p1', -1),
    },
    {
      name: 'plan events',
      returned: await stores.planEvents.listFor('p1', {}),
      reread: () => stores.planEvents.listFor('p1', {}),
      mutate(value) {
        if (!Array.isArray(value)) return false;
        value.push({ caller: 'mutation' });
        return true;
      },
    },
    {
      name: 'journal',
      returned: await stores.journal.entriesFor('p1', 'owner'),
      reread: () => stores.journal.entriesFor('p1', 'owner'),
    },
    { name: 'project create', returned: created, reread: () => stores.projects.findById('p2') },
    { name: 'project update', returned: updated, reread: () => stores.projects.findById('p1') },
    {
      name: 'project slug',
      returned: await stores.projects.findBySolutionSlug('stored-slug'),
      reread: () => stores.projects.findBySolutionSlug('stored-slug'),
    },
  ];

  for (const checked of cases) {
    const before = structuredClone(checked.returned);
    expect((checked.mutate ?? mutateReturned)(checked.returned), checked.name).toBeTrue();
    expect(checked.returned, checked.name).not.toEqual(before);
    // Proof: bypassing the catalog detacher made both boundary cases reread the
    // user id as `reader:caller-mutation` instead of `reader`.
    expect(await checked.reread(), checked.name).toEqual(before);
  }
}

describe('the staged memory source', () => {
  for (const commit of [true, false] as const) {
    it(`saves committed capture and independent history while a batch ${commit ? 'commits' : 'refuses'}`, async () => {
      const source = await seededSource();
      const service = new SavedPlanService({
        capture: source.history.savedPlanCapture,
        plans: source.history.savedPlans,
        digest: {
          sha256: (bytes) => Promise.resolve(`digest:${String(bytes.length)}`),
        },
        newId: () => (commit ? 'saved-commit' : 'saved-rollback'),
        now: () => 10,
        scheduler: fastScheduler,
      });
      let releaseBatch = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      let batchEntered = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        batchEntered = resolve;
      });
      const batch = source.uow.run(async (scope) => {
        await scope.stores.projects.update('p1', { name: 'Staged' }, stamp);
        batchEntered();
        await held;
        return { commit, value: undefined };
      });
      await entered;

      const save = service.save({
        projectId: 'p1',
        createdBy: 'owner',
        createdById: 'owner',
      });
      const settled = await Promise.race([
        save,
        new Promise<'timed-out'>((resolve) => {
          setTimeout(() => {
            resolve('timed-out');
          }, 50);
        }),
      ]);
      // A timed-out fault is released and awaited before the assertion reports
      // it, so a deliberately deadlocked save cannot leak into the next case.
      if (settled === 'timed-out') {
        releaseBatch();
        await batch;
        await save;
        // Proof: taking the command coordinator in capture failed here on
        // `Expected: not "timed-out"` after the pending save was drained.
        expect(settled).not.toBe('timed-out');
        return;
      }
      releaseBatch();
      await batch;
      expect(settled.outcome).toBe('saved');
      const savedId = commit ? 'saved-commit' : 'saved-rollback';
      const stored = await source.history.savedPlans.readOf(savedId);
      // Proof: replacing independent history with the committed staged state
      // made `stored?.bodies.input` undefined and `toContain` reject it as
      // neither an array nor a string.
      expect(stored?.bodies.input).toContain('Before');
      expect(stored?.bodies.input).not.toContain('Staged');
    });
  }

  it('serializes competing saved-plan quota checks independently of command batches', async () => {
    const source = await seededSource();
    let issued = 0;
    const service = new SavedPlanService({
      capture: source.history.savedPlanCapture,
      plans: source.history.savedPlans,
      digest: { sha256: (bytes) => Promise.resolve(`digest:${String(bytes.length)}`) },
      newId: () => `saved-${String((issued += 1))}`,
      now: () => 10,
      quota: {
        mostBytesPerBody: 1024 * 1024,
        mostPlansPerProject: 1,
        mostBytesPerProject: 1024 * 1024,
      },
      scheduler: fastScheduler,
    });

    const outcomes = await Promise.all([
      service.save({ projectId: 'p1', createdBy: 'owner', createdById: 'owner' }),
      service.save({ projectId: 'p1', createdBy: 'owner', createdById: 'owner' }),
    ]);

    // Proof: bypassing the history coordinator admitted both competing saves,
    // receiving `["saved", "saved"]` instead of `["refused", "saved"]`.
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(['refused', 'saved']);
    expect(await source.history.savedPlans.listOf('p1')).toHaveLength(1);
  });

  it('commits all mixed-store writes together', async () => {
    const source = await seededSource();
    const settled = Promise.race([
      source.uow.run(async (scope) => {
        await scope.stores.steps.add({ id: 'st-2', projectId: 'p1', name: 'QA' }, stamp);
        await scope.stores.directory.addTag({ id: 'tag-1', name: 'urgent' }, stamp);
        await scope.stores.projects.update('p1', { name: 'Committed' }, stamp);
        return { commit: true, value: 'applied' as const };
      }),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => {
          resolve('timed-out');
        }, 50);
      }),
    ]);
    // Proof: gating admitted stores made the batch remain `timed-out` here.
    expect(await settled).toBe('applied');
    expect((await source.stores.steps.listByProject('p1')).map((step) => step.name)).toContain(
      'QA',
    );
    expect((await source.stores.directory.listTags()).map((tag) => tag.name)).toContain('urgent');
    expect((await source.stores.projects.findById('p1'))?.name).toBe('Committed');
  });

  it('queues public writes behind a held batch', async () => {
    const source = await seededSource();
    let releaseBatch = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let batchEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      batchEntered = resolve;
    });
    const batch = source.uow.run(async () => {
      batchEntered();
      await held;
      return { commit: true, value: undefined };
    });
    await entered;
    const publicWrite = source.stores.projects.update('p1', { name: 'After batch' }, stamp);
    const first = await Promise.race([
      publicWrite.then(() => 'written' as const),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => {
          resolve('pending');
        }, 20);
      }),
    ]);
    expect(first).toBe('pending');
    releaseBatch();
    await batch;
    expect((await publicWrite)?.name).toBe('After batch');
  });

  it('discards refused state and gives the next batch a fresh scope', async () => {
    const source = await seededSource();
    let refusedStores: unknown;
    await source.uow.run(async (scope) => {
      refusedStores = scope.stores;
      await scope.stores.projects.update('p1', { name: 'Refused' }, stamp);
      await scope.stores.steps.add(
        { id: 'refused-step', projectId: 'p1', name: 'Refused only' },
        stamp,
      );
      return { commit: false, value: undefined };
    });
    expect((await source.stores.projects.findById('p1'))?.name).toBe('Before');

    let committedStores: unknown;
    await source.uow.run(async (scope) => {
      committedStores = scope.stores;
      await scope.stores.projects.update('p1', { name: 'Committed' }, stamp);
      return { commit: true, value: undefined };
    });
    // Proof: reusing the refused staged state made the final assertion receive
    // `["Refused only"]` where the row must be absent.
    expect(refusedStores).not.toBe(committedStores);
    expect((await source.stores.projects.findById('p1'))?.name).toBe('Committed');
    expect((await source.stores.steps.listByProject('p1')).map((step) => step.name)).not.toContain(
      'Refused only',
    );
  });

  for (const boundary of ['public', 'admitted'] as const) {
    it(`returns detached values from every ${boundary} storage shape`, async () => {
      const source = await seededSource();
      if (boundary === 'public') await expectDetachedReads(source.stores);
      else {
        await source.uow.run(async ({ stores }) => {
          await expectDetachedReads(stores);
          return { commit: false, value: undefined };
        });
      }
    });
  }

  it('binds subtree writes and public dependency reads to one table', async () => {
    const source = await seededSource();
    await source.uow.run(async (scope) => {
      await scope.stores.subtrees.insertSubtree(
        {
          rows: [],
          respaced: [],
          reparented: [],
          estimates: [],
          actuals: [],
          progress: [],
          measures: [],
          assignments: [],
          dependencies: [
            { id: 'dep-1', projectId: 'p1', predecessorId: 'wi-1', successorId: 'wi-2' },
          ],
          removedEstimates: [],
          removedActuals: [],
          removedProgress: [],
          removedMeasures: [],
        },
        stamp,
      );
      return { commit: true, value: undefined };
    });
    // Proof: constructing subtrees with a second dependency fixture left this list empty.
    expect(await source.stores.dependencies.listByProject('p1')).toEqual([
      { id: 'dep-1', projectId: 'p1', predecessorId: 'wi-1', successorId: 'wi-2' },
    ]);
  });
});
