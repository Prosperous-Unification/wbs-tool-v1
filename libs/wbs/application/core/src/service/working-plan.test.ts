import { openMemorySource } from '@wbs/store-memory';
import { describe, expect, it } from 'bun:test';

import { servicesOver } from '../compose';
import type { PlanTransactionalStores } from '../ports/stores';
import { testClock } from '../testing/clock-fixture';
import { fastScheduler } from '../testing/scheduler-fixture';
import { workItemRow } from '../testing/work-item-fixture';
import type { Broadcaster } from './broadcast';
import { PlanCommandRunner } from './plan-commands';
import { createWorkingPlan } from './working-plan';

const OWNER = 'working-plan-owner';
const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 } as const;

function silentBroadcaster(): Broadcaster {
  return {
    publish: () => Promise.resolve(),
    latestSeq: () => Promise.resolve(-1),
  };
}

describe('the admitted working batch baseline', () => {
  it('preserves the four mutation sequences through a working collection', async () => {
    const source = openMemorySource();
    const admitted: PlanTransactionalStores[] = [];
    const direct = silentBroadcaster();
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock: testClock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, direct);
    const runner = new PlanCommandRunner({
      uow: source.uow,
      announcements: direct,
      publicServices: publicGraph,
      batchServices(scope, broadcast) {
        admitted.push(scope.stores);
        return compose(scope.stores, broadcast);
      },
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const createdProject = await publicGraph.projects.create('Working baseline', OWNER);
      const projectId = createdProject.project.id;
      const stepId = createdProject.steps[0].id;
      await source.stores.steps.add(
        { id: stepId, projectId, name: createdProject.steps[0].name },
        { at: 1, by: OWNER },
      );

      const createdAndEstimated = await runner.run(projectId, OWNER, [
        {
          kind: 'createWorkItem',
          ref: 'estimated',
          parentId: null,
          afterId: null,
          name: 'Estimated',
        },
        { kind: 'setEstimate', workItemRef: 'estimated', stepId, days: DAYS },
      ]);
      expect(createdAndEstimated.ok).toBe(true);
      const estimatedId = createdAndEstimated.ok ? createdAndEstimated.results[0]?.id : undefined;
      if (estimatedId === undefined) throw new Error('create→estimate returned no work-item id');
      expect(await source.stores.estimates.listByProject(projectId)).toEqual([
        { workItemId: estimatedId, stepId, ...DAYS },
      ]);

      const handedDown = await runner.run(projectId, OWNER, [
        {
          kind: 'createWorkItem',
          ref: 'parent',
          parentId: null,
          afterId: null,
          name: 'Parent',
        },
        { kind: 'setEstimate', workItemRef: 'parent', stepId, days: DAYS },
        {
          kind: 'createWorkItem',
          ref: 'child',
          parentRef: 'parent',
          parentId: null,
          afterId: null,
          name: 'Child',
        },
      ]);
      expect(handedDown.ok).toBe(true);
      const parentId = handedDown.ok ? handedDown.results[0]?.id : undefined;
      const childId = handedDown.ok ? handedDown.results[2]?.id : undefined;
      if (parentId === undefined || childId === undefined) {
        throw new Error('estimate→child returned no parent or child id');
      }
      expect(await source.stores.estimates.listByProject(projectId)).toContainEqual({
        workItemId: childId,
        stepId,
        ...DAYS,
      });
      expect(
        (await source.stores.estimates.listByProject(projectId)).some(
          ({ workItemId }) => workItemId === parentId,
        ),
      ).toBe(false);

      const dependencyDelete = await runner.run(projectId, OWNER, [
        {
          kind: 'createWorkItem',
          ref: 'predecessor',
          parentId: null,
          afterId: null,
          name: 'Predecessor',
        },
        {
          kind: 'createWorkItem',
          ref: 'survivor',
          parentId: null,
          afterId: null,
          name: 'Survivor',
        },
        {
          kind: 'addDependency',
          workItemRef: 'survivor',
          predecessorRef: 'predecessor',
        },
        { kind: 'deleteWorkItem', workItemRef: 'predecessor', strategy: 'cascade' },
      ]);
      expect(dependencyDelete.ok).toBe(true);
      const survivorId = dependencyDelete.ok ? dependencyDelete.results[1]?.id : undefined;
      if (survivorId === undefined) throw new Error('dependency→delete returned no survivor id');
      expect(await source.stores.dependencies.listByProject(projectId)).toEqual([]);
      expect(await source.stores.workItems.listByIds(projectId, [survivorId])).toMatchObject([
        { id: survivorId, name: 'Survivor' },
      ]);

      const labelled = await runner.run(projectId, OWNER, [
        { kind: 'createTeam', ref: 'team', name: 'Cascade team' },
        {
          kind: 'createWorkItem',
          ref: 'labelled',
          parentId: null,
          afterId: null,
          name: 'Before cascade',
        },
      ]);
      if (!labelled.ok) throw new Error('directory setup batch refused');
      const teamId = labelled.results[0]?.id;
      const labelledId = labelled.results[1]?.id;
      if (teamId === undefined || labelledId === undefined) {
        throw new Error('directory setup returned no team or work-item id');
      }
      const labelledRow = await publicGraph.workItems.patch(labelledId, OWNER, {
        teamIds: [teamId],
      });
      expect(labelledRow.ok).toBe(true);
      const cascadePatch = await runner.run(projectId, OWNER, [
        { kind: 'deleteTeam', teamId, cascade: true },
        { kind: 'patchWorkItem', workItemId: labelledId, patch: { name: 'After cascade' } },
      ]);
      expect(cascadePatch.ok).toBe(true);
      expect(await source.stores.workItems.listByIds(projectId, [labelledId])).toMatchObject([
        { id: labelledId, name: 'After cascade' },
      ]);

      // Proof: composing over process stores made this identity assertion fail:
      // every batch must consume the Scope supplied by UnitOfWork.run.
      expect(admitted).toHaveLength(5);
      expect(admitted.every((stores) => stores !== source.stores)).toBe(true);
      expect(new Set(admitted).size).toBe(admitted.length);
    } finally {
      await source.close();
    }
  });

  it('throws after its batch closes', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
      servicesOver(stores, { clock: testClock, broadcast, scheduler: fastScheduler });
    const publicGraph = compose(source.stores, direct);
    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Working lifecycle', OWNER)).project.id;
      let retainedRead:
        (() => ReturnType<PlanTransactionalStores['workItems']['listByProject']>) | undefined;
      const runner = new PlanCommandRunner({
        uow: source.uow,
        announcements: direct,
        publicServices: publicGraph,
        batchServices(scope, broadcast) {
          retainedRead = () => scope.stores.workItems.listByProject(projectId);
          return compose(scope.stores, broadcast);
        },
      });

      const outcome = await runner.run(projectId, OWNER, [
        {
          kind: 'createWorkItem',
          parentId: null,
          afterId: null,
          name: 'Closed with batch',
        },
      ]);
      expect(outcome.ok).toBe(true);
      if (retainedRead === undefined) throw new Error('batch did not expose its admitted read');

      // Proof: without the WorkingPlan close guard this resolved with the
      // committed row, permitting a stale batch-owned read after settlement.
      expect(retainedRead()).rejects.toThrow(/working plan.*closed/i);
    } finally {
      await source.close();
    }
  });

  it('loads on first demand and detaches every retained answer', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Lazy retained plan', OWNER)).project.id;
      const created = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Before first demand',
      });
      if (!created.ok) throw new Error('working-plan seed creation refused');
      const renamed = await publicGraph.workItems.patch(created.value.id, OWNER, {
        name: 'Loaded name',
      });
      if (!renamed.ok) throw new Error('working-plan seed rename refused');

      const stored = await source.stores.workItems.listByProject(projectId);
      const labelled = stored.map((row) => ({
        ...row,
        teamIds: ['team-before'],
        tagIds: ['tag-before'],
        serviceIds: ['service-before'],
        typeIds: ['type-before'],
        externalRefs: [
          {
            id: 'ref-before',
            systemId: 'system-before',
            url: 'https://before.example/ref',
            name: 'Before reference',
          },
        ],
      }));
      const stores: PlanTransactionalStores = {
        ...source.stores,
        workItems: {
          ...source.stores.workItems,
          listByProject: () => Promise.resolve(labelled),
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);

      const first = await workingPlan.stores.workItems.listByProject(projectId);
      expect(first).toMatchObject([
        {
          id: created.value.id,
          name: 'Loaded name',
          teamIds: ['team-before'],
          tagIds: ['tag-before'],
          serviceIds: ['service-before'],
          typeIds: ['type-before'],
          externalRefs: [{ url: 'https://before.example/ref' }],
        },
      ]);
      const borrowed = first[0];
      borrowed.name = 'Borrower mutation';
      // These casts deliberately model a caller violating the readonly type at runtime.
      (borrowed.teamIds as string[]).push('team-borrowed');
      (borrowed.tagIds as string[]).push('tag-borrowed');
      (borrowed.serviceIds as string[]).push('service-borrowed');
      (borrowed.typeIds as string[]).push('type-borrowed');
      borrowed.externalRefs[0].url = 'https://borrowed.example/ref';
      await source.stores.workItems.remove([created.value.id], [], { at: 2, by: OWNER });

      expect(await workingPlan.stores.workItems.listByProject(projectId)).toEqual(labelled);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });
});

describe('targeted working-plan refreshes', () => {
  it('reloads every loaded collection and keeps unloaded collections lazy after a global write', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });
    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Global reload barrier', OWNER)).project
        .id;
      const row = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Retained before directory write',
      });
      if (!row.ok) throw new Error('global reload fixture row creation refused');
      const reads = {
        workItems: 0,
        estimates: 0,
        actuals: 0,
        progress: 0,
        measures: 0,
        dependencies: 0,
      };
      const stores: PlanTransactionalStores = {
        ...source.stores,
        workItems: {
          ...source.stores.workItems,
          listByProject: (id) => {
            reads.workItems += 1;
            return source.stores.workItems.listByProject(id);
          },
        },
        estimates: {
          ...source.stores.estimates,
          listByProject: (id) => {
            reads.estimates += 1;
            return source.stores.estimates.listByProject(id);
          },
        },
        actuals: {
          ...source.stores.actuals,
          listByProject: (id) => {
            reads.actuals += 1;
            return source.stores.actuals.listByProject(id);
          },
        },
        progress: {
          ...source.stores.progress,
          listByProject: (id) => {
            reads.progress += 1;
            return source.stores.progress.listByProject(id);
          },
        },
        measures: {
          ...source.stores.measures,
          listByProject: (id) => {
            reads.measures += 1;
            return source.stores.measures.listByProject(id);
          },
        },
        dependencies: {
          ...source.stores.dependencies,
          listByProject: (id) => {
            reads.dependencies += 1;
            return source.stores.dependencies.listByProject(id);
          },
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);
      const borrowed = await workingPlan.stores.workItems.listByProject(projectId);
      await Promise.all([
        workingPlan.stores.estimates.listByProject(projectId),
        workingPlan.stores.actuals.listByProject(projectId),
        workingPlan.stores.progress.listByProject(projectId),
        workingPlan.stores.measures.listByProject(projectId),
      ]);

      await workingPlan.stores.directory.addTag(
        { id: 'reload-tag', name: 'Reload tag' },
        { at: 2, by: OWNER },
      );

      // Proof: omitting any loaded collection from the global barrier left its
      // count at one, while eagerly reloading dependencies changed zero to one.
      expect(reads).toEqual({
        workItems: 2,
        estimates: 2,
        actuals: 2,
        progress: 2,
        measures: 2,
        dependencies: 0,
      });
      expect(borrowed).toMatchObject([
        { id: row.value.id, name: 'Retained before directory write' },
      ]);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('preserves the admitted work-item order when one row refreshes', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Ordered targeted rows', OWNER)).project
        .id;
      for (const [position, id] of ['z', 'a', 'b', 'c'].entries()) {
        await source.stores.workItems.insert(
          workItemRow({ id, projectId, position: (position + 1) * 10, name: `Row ${id}` }),
          [],
          { at: 2, by: OWNER },
        );
      }
      const workingPlan = createWorkingPlan({ stores: source.stores }, projectId);
      await workingPlan.stores.workItems.listByProject(projectId);
      expect(
        await workingPlan.stores.workItems.patch('b', { name: 'Patched B' }, { at: 3, by: OWNER }),
      ).toMatchObject({ ok: true });

      // Proof: the grouping refresh sorted the retained rows a,b,c,z instead
      // of preserving the admitted source's z,a,b,c order.
      expect(await workingPlan.stores.workItems.listByProject(projectId)).toEqual(
        await source.stores.workItems.listByProject(projectId),
      );
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('preserves unrelated dependency interleaving when incident edges refresh', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Ordered incident edges', OWNER)).project
        .id;
      for (const [position, id] of ['z', 'a', 'b', 'c'].entries()) {
        await source.stores.workItems.insert(
          workItemRow({ id, projectId, position: (position + 1) * 10, name: `Row ${id}` }),
          [],
          { at: 2, by: OWNER },
        );
      }
      for (const edge of [
        { id: 'e1', projectId, predecessorId: 'z', successorId: 'a' },
        { id: 'e2', projectId, predecessorId: 'b', successorId: 'c' },
        { id: 'e3', projectId, predecessorId: 'a', successorId: 'c' },
      ]) {
        await source.stores.dependencies.add(edge, { at: 2, by: OWNER });
      }
      const workingPlan = createWorkingPlan({ stores: source.stores }, projectId);
      await workingPlan.stores.workItems.listByProject(projectId);
      await workingPlan.stores.dependencies.listByProject(projectId);
      expect(
        await workingPlan.stores.workItems.patch('a', { name: 'Patched A' }, { at: 3, by: OWNER }),
      ).toMatchObject({ ok: true });

      // Proof: splicing all incident replacements at e1 produced e1,e3,e2,
      // moving the unrelated e2 out of its authoritative interleaving.
      expect(await workingPlan.stores.dependencies.listByProject(projectId)).toEqual(
        await source.stores.dependencies.listByProject(projectId),
      );
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('keeps a newly added edge in authoritative order and returned edges detached', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Ordered dependency writes', OWNER))
        .project.id;
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        await source.stores.workItems.insert(workItemRow({ id, projectId }), [], {
          at: 2,
          by: OWNER,
        });
      }
      for (const edge of [
        { id: 'edge-a-b', projectId, predecessorId: 'a', successorId: 'b' },
        { id: 'edge-c-d', projectId, predecessorId: 'c', successorId: 'd' },
      ]) {
        await source.stores.dependencies.add(edge, { at: 2, by: OWNER });
      }

      const workingPlan = createWorkingPlan({ stores: source.stores }, projectId);
      const borrowed = await workingPlan.stores.dependencies.listByProject(projectId);
      const first = borrowed.at(0);
      if (first === undefined) throw new Error('dependency fixture returned no first edge');
      first.successorId = 'e';

      await workingPlan.stores.dependencies.add(
        { id: 'edge-a-e', projectId, predecessorId: 'a', successorId: 'e' },
        { at: 3, by: OWNER },
      );

      // Proof: inserting a new incident replacement beside the last retained
      // incident edge moved edge-c-d behind edge-a-e instead of keeping the
      // memory adapter's authoritative append order.
      expect(await workingPlan.stores.dependencies.listByProject(projectId)).toEqual(
        await source.stores.dependencies.listByProject(projectId),
      );
      expect(
        (await workingPlan.stores.dependencies.listByProject(projectId)).map(({ id }) => id),
      ).toEqual(['edge-a-b', 'edge-c-d', 'edge-a-e']);

      await workingPlan.stores.dependencies.remove('a', 'b', { at: 4, by: OWNER });
      // Proof: delegating remove without refreshing both endpoints left
      // edge-a-b in this retained answer after the source deleted it.
      expect(await workingPlan.stores.dependencies.listByProject(projectId)).toEqual(
        await source.stores.dependencies.listByProject(projectId),
      );

      await workingPlan.stores.dependencies.removeAllFor(['a'], { at: 5, by: OWNER });
      // Proof: delegating removeAllFor without refreshing its captured
      // surviving endpoints left edge-a-e in the retained answer.
      expect(await workingPlan.stores.dependencies.listByProject(projectId)).toEqual(
        await source.stores.dependencies.listByProject(projectId),
      );
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('refreshes every restore-related collection and preserves borrowed before-images', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const createdProject = await publicGraph.projects.create('Retained subtree restore', OWNER);
      const projectId = createdProject.project.id;
      const stepId = createdProject.steps[0].id;
      await source.stores.steps.add({ id: stepId, projectId, name: 'Build' }, { at: 2, by: OWNER });
      for (const row of [
        workItemRow({ id: 'prior-parent', projectId, position: 10, name: 'Prior parent' }),
        workItemRow({ id: 'other-values', projectId, position: 20, name: 'Other values' }),
        workItemRow({ id: 'respaced', projectId, position: 30, name: 'Respaced' }),
        workItemRow({ id: 'old-parent', projectId, position: 40, name: 'Old parent' }),
        workItemRow({
          id: 'reparented',
          projectId,
          parentId: 'old-parent',
          position: 10,
          name: 'Reparented',
        }),
      ]) {
        await source.stores.workItems.insert(row, [], { at: 2, by: OWNER });
      }
      await source.stores.estimates.set(
        { workItemId: 'prior-parent', stepId, optimistic: 1, realistic: 2, pessimistic: 3 },
        { at: 2, by: OWNER },
      );
      await source.stores.actuals.set(
        { workItemId: 'other-values', stepId, days: 2, recordedAt: 2 },
        { at: 2, by: OWNER },
      );
      await source.stores.progress.set(
        { workItemId: 'other-values', stepId, state: 'done', statedAt: 2 },
        { at: 2, by: OWNER },
      );
      await source.stores.measures.set(
        {
          workItemId: 'other-values',
          stepId,
          metric: 'token_estimate',
          value: 5,
          recordedAt: 2,
        },
        { at: 2, by: OWNER },
      );

      const workingPlan = createWorkingPlan({ stores: source.stores }, projectId);
      const borrowed = await Promise.all([
        workingPlan.stores.workItems.listByProject(projectId),
        workingPlan.stores.estimates.listByProject(projectId),
        workingPlan.stores.actuals.listByProject(projectId),
        workingPlan.stores.progress.listByProject(projectId),
        workingPlan.stores.measures.listByProject(projectId),
        workingPlan.stores.dependencies.listByProject(projectId),
      ]);
      const before = structuredClone(borrowed);

      await workingPlan.stores.subtrees.insertSubtree(
        {
          rows: [
            workItemRow({ id: 'new-root', projectId, position: 15, name: 'Restored root' }),
            workItemRow({
              id: 'new-child',
              projectId,
              parentId: 'new-root',
              position: 10,
              name: 'Restored child',
            }),
          ],
          respaced: [{ id: 'respaced', position: 40 }],
          reparented: [{ id: 'reparented', parentId: 'new-root', position: 20 }],
          estimates: [
            { workItemId: 'new-child', stepId, optimistic: 3, realistic: 4, pessimistic: 5 },
          ],
          actuals: [{ workItemId: 'new-child', stepId, days: 4, recordedAt: 3 }],
          progress: [{ workItemId: 'new-child', stepId, state: 'in_progress', statedAt: 3 }],
          measures: [
            {
              workItemId: 'new-child',
              stepId,
              metric: 'token_estimate',
              value: 8,
              recordedAt: 3,
            },
          ],
          assignments: [],
          dependencies: [
            {
              id: 'restored-edge',
              projectId,
              predecessorId: 'new-child',
              successorId: 'reparented',
            },
          ],
          removedEstimates: [{ workItemId: 'prior-parent', stepId }],
          removedActuals: [{ workItemId: 'other-values', stepId }],
          removedProgress: [{ workItemId: 'other-values', stepId }],
          removedMeasures: [{ workItemId: 'other-values', stepId, metric: 'token_estimate' }],
        },
        { at: 3, by: OWNER },
      );

      const retained = await Promise.all([
        workingPlan.stores.workItems.listByProject(projectId),
        workingPlan.stores.estimates.listByProject(projectId),
        workingPlan.stores.actuals.listByProject(projectId),
        workingPlan.stores.progress.listByProject(projectId),
        workingPlan.stores.measures.listByProject(projectId),
        workingPlan.stores.dependencies.listByProject(projectId),
      ]);
      const authoritative = await Promise.all([
        source.stores.workItems.listByProject(projectId),
        source.stores.estimates.listByProject(projectId),
        source.stores.actuals.listByProject(projectId),
        source.stores.progress.listByProject(projectId),
        source.stores.measures.listByProject(projectId),
        source.stores.dependencies.listByProject(projectId),
      ]);
      // Proof: omitting removedEstimates from the subtree refresh left this
      // prior parent carrying its old estimate immediately after insertion.
      expect(retained[1].some(({ workItemId }) => workItemId === 'prior-parent')).toBe(false);
      expect(retained).toEqual(authoritative);
      // Proof: mutating retained answers during refresh changed arrays already
      // borrowed as undo before-images instead of replacing cache entries.
      expect(borrowed).toEqual(before);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('refreshes a labelled row and rejects an unrequested satellite row', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const createdProject = await publicGraph.projects.create('Targeted label refresh', OWNER);
      const projectId = createdProject.project.id;
      const created = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Labelled row',
      });
      if (!created.ok) throw new Error('targeted label fixture creation refused');
      const firstTag = await publicGraph.directory.addTag(OWNER, 'First targeted tag');
      const secondTag = await publicGraph.directory.addTag(OWNER, 'Second targeted tag');
      if (firstTag === null || secondTag === null) {
        throw new Error('targeted label fixture tag creation refused');
      }
      const seeded = await source.stores.workItems.patch(
        created.value.id,
        { tagIds: [firstTag.id] },
        { at: 2, by: OWNER },
      );
      if (!seeded.ok) throw new Error('targeted label fixture seeding refused');
      const workingPlan = createWorkingPlan({ stores: source.stores }, projectId);
      await workingPlan.stores.workItems.listByProject(projectId);

      const patched = await workingPlan.stores.workItems.patch(
        created.value.id,
        { tagIds: [secondTag.id] },
        { at: 3, by: OWNER },
      );
      expect(patched.ok).toBe(true);
      expect(
        await workingPlan.stores.workItems.listByIds(projectId, [created.value.id]),
      ).toMatchObject([{ id: created.value.id, tagIds: [secondTag.id] }]);
      workingPlan.close();

      const sibling = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Unrequested estimate owner',
      });
      if (!sibling.ok) throw new Error('targeted estimate fixture creation refused');
      await source.stores.estimates.set(
        { workItemId: sibling.value.id, stepId: createdProject.steps[0].id, ...DAYS },
        { at: 4, by: OWNER },
      );
      const estimateStores: PlanTransactionalStores = {
        ...source.stores,
        estimates: {
          ...source.stores.estimates,
          // Inject the production fault: the targeted query ignores its IDs.
          listByWorkItems: (requestedProjectId) =>
            source.stores.estimates.listByProject(requestedProjectId),
        },
      };
      const estimatePlan = createWorkingPlan({ stores: estimateStores }, projectId);
      await estimatePlan.stores.estimates.listByProject(projectId);
      // Proof: without the shared satellite identity check, this resolved and
      // retained the sibling's estimate under a refresh for another row.
      expect(
        estimatePlan.stores.workItems.patch(
          created.value.id,
          { name: 'Trigger estimate refresh' },
          { at: 5, by: OWNER },
        ),
      ).rejects.toThrow(/targeted estimate.*unrequested work item/i);
      estimatePlan.close();
    } finally {
      await source.close();
    }
  });

  it('rejects dependencies outside the requested incident project set', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Targeted edge refusal', OWNER)).project
        .id;
      const target = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Refresh target',
      });
      const predecessor = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Unrelated predecessor',
      });
      const successor = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Unrelated successor',
      });
      if (!target.ok || !predecessor.ok || !successor.ok) {
        throw new Error('targeted edge fixture creation refused');
      }
      await source.stores.dependencies.add(
        {
          id: 'unrelated-targeted-edge',
          projectId,
          predecessorId: predecessor.value.id,
          successorId: successor.value.id,
        },
        { at: 2, by: OWNER },
      );
      const stores: PlanTransactionalStores = {
        ...source.stores,
        dependencies: {
          ...source.stores.dependencies,
          // Inject the production fault: the targeted query lost its endpoint predicate.
          listByWorkItems: (requestedProjectId) =>
            source.stores.dependencies.listByProject(requestedProjectId),
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);
      await workingPlan.stores.dependencies.listByProject(projectId);

      // Proof: without validating the targeted edge set, this patch resolved and
      // retained an edge that touched neither refreshed endpoint.
      expect(
        workingPlan.stores.workItems.patch(
          target.value.id,
          { name: 'Trigger edge refresh' },
          { at: 3, by: OWNER },
        ),
      ).rejects.toThrow(/targeted dependency.*refreshed work item/i);
      workingPlan.close();

      const crossProjectStores: PlanTransactionalStores = {
        ...source.stores,
        dependencies: {
          ...source.stores.dependencies,
          // Inject the production fault: the targeted query returns another project.
          listByWorkItems: (_requestedProjectId, ids) =>
            Promise.resolve([
              {
                id: 'cross-project-targeted-edge',
                projectId: 'another-project',
                predecessorId: ids[0] ?? target.value.id,
                successorId: successor.value.id,
              },
            ]),
        },
      };
      const crossProjectPlan = createWorkingPlan({ stores: crossProjectStores }, projectId);
      await crossProjectPlan.stores.dependencies.listByProject(projectId);
      // Proof: without the edge project check, this resolved and retained the
      // other project's edge in this project's working collection.
      expect(
        crossProjectPlan.stores.workItems.patch(
          target.value.id,
          { name: 'Trigger cross-project edge refresh' },
          { at: 4, by: OWNER },
        ),
      ).rejects.toThrow(/targeted dependency.*outside project/i);
      crossProjectPlan.close();
    } finally {
      await source.close();
    }
  });

  it('hydrates only the affected identity after ordinary single-row patches', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Bounded row refresh', OWNER)).project
        .id;
      const retainedCount = 200;
      for (let index = 0; index < retainedCount; index += 1) {
        await source.stores.workItems.insert(
          workItemRow({
            id: `row-${String(index).padStart(3, '0')}`,
            projectId,
            position: index * 10,
          }),
          [],
          { at: 2, by: OWNER },
        );
      }
      const hydrationCardinality: { requested: number; returned: number }[] = [];
      let placementCalls = 0;
      const stores: PlanTransactionalStores = {
        ...source.stores,
        workItems: {
          ...source.stores.workItems,
          listByIds: async (requestedProjectId, ids) => {
            const rows = await source.stores.workItems.listByIds(requestedProjectId, ids);
            hydrationCardinality.push({ requested: ids.length, returned: rows.length });
            return rows;
          },
          listPlacements: (requestedProjectId, ids) => {
            placementCalls += 1;
            return source.stores.workItems.listPlacements(requestedProjectId, ids);
          },
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);
      expect(await workingPlan.stores.workItems.listByProject(projectId)).toHaveLength(
        retainedCount,
      );

      for (const [at, name] of ['First patch', 'Second patch', 'Third patch'].entries()) {
        expect(
          await workingPlan.stores.workItems.patch('row-117', { name }, { at: at + 3, by: OWNER }),
        ).toMatchObject({ ok: true });
      }
      // Proof: expanding this refresh to every retained identity requested and returned
      // 200 labelled rows here, masking faults in the affected-identity set.
      expect(hydrationCardinality).toEqual([
        { requested: 1, returned: 1 },
        { requested: 1, returned: 1 },
        { requested: 1, returned: 1 },
      ]);
      // Proof: calling the real placement reader for an empty new-ID set made
      // three ordinary patches cross this boundary three times.
      expect(placementCalls).toBe(0);
      expect(
        (await workingPlan.stores.workItems.listByProject(projectId)).find(
          ({ id }) => id === 'row-117',
        ),
      ).toMatchObject({ name: 'Third patch' });
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('rejects work items outside the requested project and identity set', async () => {
    const source = openMemorySource();
    const direct = silentBroadcaster();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: direct,
      scheduler: fastScheduler,
    });

    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectA = (await publicGraph.projects.create('Targeted project A', OWNER)).project.id;
      const projectB = (await publicGraph.projects.create('Targeted project B', OWNER)).project.id;
      const rowA = await publicGraph.workItems.create(projectA, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Project A row',
      });
      const rowB = await publicGraph.workItems.create(projectB, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Project B row',
      });
      if (!rowA.ok || !rowB.ok) throw new Error('targeted project fixture creation refused');
      const stores: PlanTransactionalStores = {
        ...source.stores,
        workItems: {
          ...source.stores.workItems,
          // Inject the production fault: the targeted query uses project B's constraint.
          listByIds: (_requestedProjectId, ids) => source.stores.workItems.listByIds(projectB, ids),
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectA);
      await workingPlan.stores.workItems.listByProject(projectA);

      // Proof: without the project check on refreshed rows, this resolved and
      // inserted project B's row into project A's retained collection.
      expect(
        workingPlan.stores.workItems.patch(
          rowB.value.id,
          { name: 'Cross-project targeted row' },
          { at: 2, by: OWNER },
        ),
      ).rejects.toThrow(/targeted work item.*outside project/i);
      expect(await workingPlan.stores.workItems.listByProject(projectA)).toMatchObject([
        { id: rowA.value.id, projectId: projectA },
      ]);
      workingPlan.close();

      const unrequestedStores: PlanTransactionalStores = {
        ...source.stores,
        workItems: {
          ...source.stores.workItems,
          // Inject the production fault: the targeted query returns a different ID.
          listByIds: async () =>
            (await source.stores.workItems.listByIds(projectB, [rowB.value.id])).map((row) => ({
              ...row,
              projectId: projectA,
            })),
        },
      };
      const unrequestedPlan = createWorkingPlan({ stores: unrequestedStores }, projectA);
      await unrequestedPlan.stores.workItems.listByProject(projectA);
      // Proof: without the requested-ID check, this resolved and inserted an
      // unrequested row into the retained collection.
      expect(
        unrequestedPlan.stores.workItems.patch(
          rowA.value.id,
          { name: 'Trigger unrequested targeted row' },
          { at: 3, by: OWNER },
        ),
      ).rejects.toThrow(/targeted work item.*not requested/i);
      unrequestedPlan.close();
    } finally {
      await source.close();
    }
  });
});

describe('working plan value failures', () => {
  it('does not advance a retained value after a modeled set refusal', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });
    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const createdProject = await publicGraph.projects.create('Refused value refresh', OWNER);
      const projectId = createdProject.project.id;
      const stepId = createdProject.steps[0].id;
      await source.stores.steps.add({ id: stepId, projectId, name: 'Build' }, { at: 2, by: OWNER });
      const leaf = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Leaf',
      });
      if (!leaf.ok) throw new Error('refused value leaf creation refused');
      await source.stores.estimates.set(
        { workItemId: leaf.value.id, stepId, ...DAYS },
        { at: 2, by: OWNER },
      );
      const stores: PlanTransactionalStores = {
        ...source.stores,
        estimates: {
          ...source.stores.estimates,
          set: () => Promise.resolve('unknown_step'),
          listByWorkItems: async (requestedProjectId, ids) =>
            (await source.stores.estimates.listByWorkItems(requestedProjectId, ids)).map(
              (estimate) => ({ ...estimate, optimistic: 99 }),
            ),
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);
      await workingPlan.stores.estimates.listByProject(projectId);

      expect(
        await workingPlan.stores.estimates.set(
          { workItemId: leaf.value.id, stepId, optimistic: 7, realistic: 8, pessimistic: 9 },
          { at: 3, by: OWNER },
        ),
      ).toBe('unknown_step');
      // Proof: refreshing after the modeled refusal replaced the retained optimistic day with
      // the targeted reader's injected 99 even though the source refused the write.
      expect(await workingPlan.stores.estimates.listByProject(projectId)).toEqual([
        { workItemId: leaf.value.id, stepId, ...DAYS },
      ]);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('does not advance a retained value before a throwing mutation succeeds', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });
    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const createdProject = await publicGraph.projects.create('Throwing value refresh', OWNER);
      const projectId = createdProject.project.id;
      const stepId = createdProject.steps[0].id;
      await source.stores.steps.add({ id: stepId, projectId, name: 'Build' }, { at: 2, by: OWNER });
      const leaf = await publicGraph.workItems.create(projectId, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Leaf',
      });
      if (!leaf.ok) throw new Error('throwing value leaf creation refused');
      await source.stores.actuals.set(
        { workItemId: leaf.value.id, stepId, days: 2, recordedAt: 2 },
        { at: 2, by: OWNER },
      );
      const stores: PlanTransactionalStores = {
        ...source.stores,
        actuals: {
          ...source.stores.actuals,
          remove: () => Promise.reject(new Error('injected actual removal failure')),
          listByWorkItems: async (requestedProjectId, ids) =>
            (await source.stores.actuals.listByWorkItems(requestedProjectId, ids)).map(
              (actual) => ({
                ...actual,
                days: 99,
              }),
            ),
        },
      };
      const workingPlan = createWorkingPlan({ stores }, projectId);
      await workingPlan.stores.actuals.listByProject(projectId);

      expect(
        workingPlan.stores.actuals.remove(leaf.value.id, stepId, { at: 3, by: OWNER }),
      ).rejects.toThrow('injected actual removal failure');
      // Proof: refreshing before the throwing source mutation changed the retained days to the
      // targeted reader's injected 99 despite the write never succeeding.
      expect(await workingPlan.stores.actuals.listByProject(projectId)).toEqual([
        { workItemId: leaf.value.id, stepId, days: 2, recordedAt: 2 },
      ]);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });

  it('does not advance retained edges before throwing dependency mutations succeed', async () => {
    const source = openMemorySource();
    const publicGraph = servicesOver(source.stores, {
      clock: testClock,
      broadcast: silentBroadcaster(),
      scheduler: fastScheduler,
    });
    try {
      await source.stores.users.create(
        { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
        { at: 1, by: OWNER },
      );
      const projectId = (await publicGraph.projects.create('Throwing dependency refresh', OWNER))
        .project.id;
      for (const id of ['a', 'b', 'c']) {
        await source.stores.workItems.insert(workItemRow({ id, projectId }), [], {
          at: 2,
          by: OWNER,
        });
      }
      const storedEdge = {
        id: 'stored-edge',
        projectId,
        predecessorId: 'a',
        successorId: 'b',
      };
      await source.stores.dependencies.add(storedEdge, { at: 2, by: OWNER });
      const dependencies: PlanTransactionalStores['dependencies'] = {
        ...source.stores.dependencies,
        listByWorkItems: async (requestedProjectId, ids) =>
          (await source.stores.dependencies.listByWorkItems(requestedProjectId, ids)).map(
            (edge) => ({ ...edge, id: 'invented-before-success' }),
          ),
        add: () => Promise.reject(new Error('injected dependency add failure')),
        remove: () => Promise.reject(new Error('injected dependency remove failure')),
        removeAllFor: () => Promise.reject(new Error('injected dependency removeAllFor failure')),
      };
      const workingPlan = createWorkingPlan(
        { stores: { ...source.stores, dependencies } },
        projectId,
      );
      await workingPlan.stores.workItems.listByProject(projectId);
      await workingPlan.stores.dependencies.listByProject(projectId);

      expect(
        workingPlan.stores.dependencies.add(
          { id: 'new-edge', projectId, predecessorId: 'b', successorId: 'c' },
          { at: 3, by: OWNER },
        ),
      ).rejects.toThrow('injected dependency add failure');
      expect(
        workingPlan.stores.dependencies.remove('a', 'b', { at: 3, by: OWNER }),
      ).rejects.toThrow('injected dependency remove failure');
      expect(
        workingPlan.stores.dependencies.removeAllFor(['a'], { at: 3, by: OWNER }),
      ).rejects.toThrow('injected dependency removeAllFor failure');

      // Proof: moving an edge refresh ahead of its source write replaced this
      // retained id with invented-before-success before the injected throw.
      expect(await workingPlan.stores.dependencies.listByProject(projectId)).toEqual([storedEdge]);
      workingPlan.close();
    } finally {
      await source.close();
    }
  });
});
