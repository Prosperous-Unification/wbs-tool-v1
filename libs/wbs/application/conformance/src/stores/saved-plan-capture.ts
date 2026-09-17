import type { PlanInputReads, SavedPlanCaptureStore, TransactionalStores } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import type { SeededPlan } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

type CaptureSeedStores = Pick<
  TransactionalStores,
  | 'projects'
  | 'workItems'
  | 'estimates'
  | 'actuals'
  | 'progress'
  | 'measures'
  | 'dependencies'
  | 'directory'
  | 'capacity'
  | 'priorityBands'
>;

export type CaptureRevisionPolicy = 'memory-unbumped' | 'sqlite-bumped';
export type CaptureDirectoryEpoch = 'before' | 'after';

const A_BANDS = [
  { startsAt: 1, label: 'A urgent', defaultValue: 2 },
  { startsAt: 11, label: 'A high', defaultValue: 12 },
  { startsAt: 21, label: 'A ordinary', defaultValue: 22 },
  { startsAt: 31, label: 'A low', defaultValue: 32 },
  { startsAt: 41, label: 'A someday', defaultValue: 42 },
] as const;

const B_BANDS = [
  { startsAt: 1, label: 'B urgent', defaultValue: 3 },
  { startsAt: 101, label: 'B high', defaultValue: 103 },
  { startsAt: 201, label: 'B ordinary', defaultValue: 203 },
  { startsAt: 301, label: 'B low', defaultValue: 303 },
  { startsAt: 401, label: 'B someday', defaultValue: 403 },
] as const;

const EXTERNAL_SYSTEMS = [
  { id: 'sys-confluence-page', name: 'confluence-page' },
  { id: 'sys-github-issue', name: 'github-issue' },
  { id: 'sys-github-pr', name: 'github-pr' },
  { id: 'sys-jira-issue', name: 'jira-issue' },
  { id: 'sys-slack-message', name: 'slack-message' },
] as const;

const byId = <Row extends { readonly id: string }>(left: Row, right: Row) =>
  left.id.localeCompare(right.id);
const byPair = <Row extends { readonly workItemId: string; readonly stepId: string }>(
  left: Row,
  right: Row,
) => left.workItemId.localeCompare(right.workItemId) || left.stepId.localeCompare(right.stepId);

/** Projects every declared capture field into a stable cross-source value. */
export function observePlanInput(reads: PlanInputReads) {
  return {
    project: {
      id: reads.project.id,
      name: reads.project.name,
      ownerId: reads.project.ownerId,
      restricted: reads.project.restricted,
      estimateMethod: reads.project.estimateMethod,
      depReach: reads.project.depReach,
      pertWeights: { ...reads.project.pertWeights },
      estimateRounding: reads.project.estimateRounding,
      startDate: reads.project.startDate,
      scheduleEngine: reads.project.scheduleEngine,
      scheduleObjective: reads.project.scheduleObjective,
      optimizationEnabled: reads.project.optimizationEnabled,
      solutionRef: reads.project.solutionRef === null ? null : { ...reads.project.solutionRef },
    },
    steps: reads.steps.map(({ id, name, position }) => ({ id, name, position })),
    workItems: reads.workItems
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        parentId: row.parentId,
        position: row.position,
        name: row.name,
        notes: row.notes,
        frozenNumber: row.frozenNumber,
        startNoEarlierThan: row.startNoEarlierThan,
        startNoEarlierThanReason: row.startNoEarlierThanReason,
        deadline: row.deadline,
        priority: row.priority,
        serviceTeamId: row.serviceTeamId,
        serviceId: row.serviceId,
        maxParallel: row.maxParallel,
        revision: row.revision,
        teamIds: [...row.teamIds].sort(),
        tagIds: [...row.tagIds].sort(),
        serviceIds: [...row.serviceIds].sort(),
        typeIds: [...row.typeIds].sort(),
        externalRefs: row.externalRefs
          .map(({ id, systemId, url }) => ({ id, systemId, url }))
          .sort(byId),
      }))
      .sort(byId),
    estimates: reads.estimates.map((row) => ({ ...row })).sort(byPair),
    actuals: reads.actuals.map((row) => ({ ...row })).sort(byPair),
    progress: reads.progress.map((row) => ({ ...row })).sort(byPair),
    measures: reads.measures
      .map((row) => ({ ...row }))
      .sort((left, right) => byPair(left, right) || left.metric.localeCompare(right.metric)),
    dependencies: reads.dependencies
      .map(({ predecessorId, successorId }) => ({ predecessorId, successorId }))
      .sort(
        (left, right) =>
          left.predecessorId.localeCompare(right.predecessorId) ||
          left.successorId.localeCompare(right.successorId),
      ),
    assignments: reads.assignments
      .map((row) => ({ ...row }))
      .sort((left, right) => byPair(left, right) || left.personId.localeCompare(right.personId)),
    capacity: [...reads.capacity.entries()].sort(([left], [right]) => left.localeCompare(right)),
    priorityBands: reads.priorityBands.map((row) => ({ ...row })),
    people: reads.people
      .map(({ id, name, teamIds }) => ({ id, name, teamIds: [...teamIds].sort() }))
      .sort(byId),
    teams: reads.teams
      .map(({ id, name, serviceIds }) => ({ id, name, serviceIds: [...serviceIds].sort() }))
      .sort(byId),
    services: reads.services.map(({ id, name }) => ({ id, name })).sort(byId),
    tags: reads.tags.map(({ id, name }) => ({ id, name })).sort(byId),
    workItemTypes: reads.workItemTypes.map(({ id, name }) => ({ id, name })).sort(byId),
    externalSystems: reads.externalSystems.map(({ id, name }) => ({ id, name })).sort(byId),
  };
}

function expectedWorkItem(
  projectId: string,
  id: string,
  name: string,
  revision: number,
  captured = false,
) {
  return {
    id,
    projectId,
    parentId: null,
    position: 10,
    name: captured ? 'Captured A' : name,
    notes: captured ? 'all capture fields' : '',
    frozenNumber: captured ? 'A-001' : null,
    startNoEarlierThan: captured ? '2026-10-02' : null,
    startNoEarlierThanReason: captured ? 'fixture floor' : null,
    deadline: captured ? '2026-10-20' : null,
    priority: captured ? 7 : null,
    serviceTeamId: captured ? 'team-a' : null,
    serviceId: null,
    maxParallel: captured ? 2 : 1,
    revision,
    teamIds: captured ? ['team-a'] : [],
    tagIds: captured ? ['tag-a'] : [],
    serviceIds: captured ? ['service-a'] : [],
    typeIds: captured ? ['type-a'] : [],
    externalRefs: [],
  };
}

/** Builds the complete expected capture without consulting an adapter read. */
export function savedPlanCaptureExpected(
  seed: SeededPlan,
  projectIndex: 0 | 1,
  revisionPolicy: CaptureRevisionPolicy,
  directoryEpoch: CaptureDirectoryEpoch = 'before',
): ReturnType<typeof observePlanInput> {
  const isA = projectIndex === 0;
  const projectId = seed.projectIds[projectIndex];
  const [firstWorkItemId, secondWorkItemId] = seed.workItemIds[projectIndex];
  const [firstStepId, secondStepId] = seed.stepIds[projectIndex];
  return {
    project: isA
      ? {
          id: projectId,
          name: 'Captured project A',
          ownerId: 'owner-a',
          restricted: true,
          estimateMethod: 'pessimistic',
          depReach: 'anchor-slice',
          pertWeights: { optimistic: 2, realistic: 5, pessimistic: 3 },
          estimateRounding: 'round',
          startDate: '2026-10-01',
          scheduleEngine: 'optimized',
          scheduleObjective: 'time',
          optimizationEnabled: true,
          solutionRef: { slug: 'capture-a', url: 'https://example.test/capture-a' },
        }
      : {
          id: projectId,
          name: 'Project 2',
          ownerId: 'owner-b',
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
    steps: [
      { id: firstStepId, name: 'Dev', position: 10 },
      { id: secondStepId, name: 'QA', position: 20 },
    ],
    workItems: [
      expectedWorkItem(
        projectId,
        firstWorkItemId,
        'Work 1',
        revisionPolicy === 'sqlite-bumped' ? (isA ? 6 : 4) : 0,
        isA,
      ),
      expectedWorkItem(
        projectId,
        secondWorkItemId,
        'Work 2',
        revisionPolicy === 'sqlite-bumped' ? 3 : 0,
      ),
    ],
    estimates: [
      {
        workItemId: firstWorkItemId,
        stepId: firstStepId,
        optimistic: isA ? 1 : 11,
        realistic: isA ? 2 : 12,
        pessimistic: isA ? 3 : 13,
      },
    ],
    actuals: [
      {
        workItemId: firstWorkItemId,
        stepId: secondStepId,
        days: isA ? 4 : 14,
        recordedAt: isA ? 301 : 401,
      },
    ],
    progress: [
      {
        workItemId: secondWorkItemId,
        stepId: firstStepId,
        state: isA ? ('done' as const) : ('in_progress' as const),
        statedAt: isA ? 302 : 402,
      },
    ],
    measures: [
      {
        workItemId: secondWorkItemId,
        stepId: secondStepId,
        metric: isA ? ('token_actual' as const) : ('hours_actual' as const),
        value: isA ? 500 : 15,
        recordedAt: isA ? 303 : 403,
      },
    ],
    dependencies: [
      {
        predecessorId: isA ? firstWorkItemId : secondWorkItemId,
        successorId: isA ? secondWorkItemId : firstWorkItemId,
      },
    ],
    assignments: [
      {
        workItemId: firstWorkItemId,
        stepId: firstStepId,
        personId: isA ? 'person-a' : 'person-b',
      },
    ],
    capacity: [[isA ? 'team-b' : 'team-a', isA ? 4 : 6]] as [string, number][],
    priorityBands: (isA ? A_BANDS : B_BANDS).map((row) => ({ ...row })),
    people: [
      {
        id: 'capture-person-unassigned',
        name: 'Unassigned member',
        teamIds: [directoryEpoch === 'before' ? 'team-b' : 'team-a'],
      },
      { id: 'person-a', name: 'Person 1', teamIds: ['team-a'] },
      { id: 'person-b', name: 'Person 2', teamIds: ['team-b'] },
    ],
    teams: [
      { id: 'team-a', name: 'Team 1', serviceIds: ['service-a'] },
      { id: 'team-b', name: 'Team 2', serviceIds: [] },
    ],
    services: [
      { id: 'capture-service-only', name: 'Capture-only service' },
      { id: 'service-a', name: 'Service 1' },
    ],
    tags: [
      { id: 'capture-tag-only', name: 'Capture-only tag' },
      { id: 'tag-a', name: directoryEpoch === 'before' ? 'Tag 1' : 'Tag after interleave' },
    ],
    workItemTypes: [
      { id: 'capture-type-only', name: 'Capture-only type' },
      { id: 'type-a', name: 'Type 1' },
    ],
    externalSystems: EXTERNAL_SYSTEMS.map((row) => ({ ...row })),
  };
}

async function expectWritten(outcome: Promise<string>) {
  expect(await outcome).toBe('written');
}

async function readSeededPlanInput(
  stores: CaptureSeedStores,
  projectId: string,
): Promise<PlanInputReads> {
  const [
    project,
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
    stores.projects.findById(projectId),
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
  if (project === null) throw new Error(`capture seed project ${projectId} is absent`);
  return {
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
  };
}

/** Adds every project-scoped fact and every capture-only directory witness. */
export async function seedSavedPlanCapture(stores: CaptureSeedStores, seed: SeededPlan) {
  const stamp = seed.stamps[0];
  expect(await stores.directory.patchTeam('team-a', { serviceIds: ['service-a'] }, stamp)).toEqual({
    ok: true,
    team: { id: 'team-a', name: 'Team 1', serviceIds: ['service-a'] },
    projectIds: [],
  });
  expect(
    await stores.directory.addTag({ id: 'capture-tag-only', name: 'Capture-only tag' }, stamp),
  ).toEqual({ id: 'capture-tag-only', name: 'Capture-only tag' });
  expect(
    await stores.directory.addService(
      { id: 'capture-service-only', name: 'Capture-only service' },
      stamp,
    ),
  ).toEqual({ id: 'capture-service-only', name: 'Capture-only service' });
  expect(
    await stores.directory.addWorkItemType(
      { id: 'capture-type-only', name: 'Capture-only type' },
      stamp,
    ),
  ).toEqual({ id: 'capture-type-only', name: 'Capture-only type' });
  expect(
    await stores.directory.addPerson(
      { id: 'capture-person-unassigned', name: 'Unassigned member', kind: 'person' },
      ['team-b'],
      stamp,
    ),
  ).toEqual({
    ok: true,
    person: { id: 'capture-person-unassigned', name: 'Unassigned member', kind: 'person' },
  });
  expect(
    await stores.workItems.patch(
      'work-a-one',
      {
        name: 'Captured A',
        notes: 'all capture fields',
        startNoEarlierThan: '2026-10-02',
        startNoEarlierThanReason: 'fixture floor',
        deadline: '2026-10-20',
        priority: 7,
        serviceTeamId: 'team-a',
        maxParallel: 2,
        teamIds: ['team-a'],
        tagIds: ['tag-a'],
        serviceIds: ['service-a'],
        typeIds: ['type-a'],
        externalRefs: [],
      },
      stamp,
    ),
  ).toMatchObject({ ok: true });
  await stores.workItems.setFrozenNumbers([{ id: 'work-a-one', frozenNumber: 'A-001' }], stamp);
  expect(await stores.directory.assign('work-a-one', 'step-a-dev', 'person-a', stamp)).toEqual({
    ok: true,
  });
  expect(await stores.directory.assign('work-b-one', 'step-b-dev', 'person-b', stamp)).toEqual({
    ok: true,
  });
  expect(await stores.capacity.set('project-a', 'team-b', 4, stamp)).toEqual({ ok: true });
  expect(await stores.capacity.set('project-b', 'team-a', 6, stamp)).toEqual({ ok: true });
  expect(
    await stores.projects.update(
      'project-a',
      {
        name: 'Captured project A',
        restricted: true,
        estimateMethod: 'pessimistic',
        depReach: 'anchor-slice',
        pertWeights: { optimistic: 2, realistic: 5, pessimistic: 3 },
        estimateRounding: 'round',
        startDate: '2026-10-01',
        solutionRef: { slug: 'capture-a', url: 'https://example.test/capture-a' },
        optimizationEnabled: true,
        scheduleEngine: 'optimized',
        scheduleObjective: 'time',
      },
      stamp,
    ),
  ).toMatchObject({ id: 'project-a', name: 'Captured project A' });
  await expectWritten(
    stores.estimates.set(
      {
        workItemId: 'work-a-one',
        stepId: 'step-a-dev',
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      },
      stamp,
    ),
  );
  await expectWritten(
    stores.estimates.set(
      {
        workItemId: 'work-b-one',
        stepId: 'step-b-dev',
        optimistic: 11,
        realistic: 12,
        pessimistic: 13,
      },
      stamp,
    ),
  );
  await expectWritten(
    stores.actuals.set(
      { workItemId: 'work-a-one', stepId: 'step-a-qa', days: 4, recordedAt: 301 },
      stamp,
    ),
  );
  await expectWritten(
    stores.actuals.set(
      { workItemId: 'work-b-one', stepId: 'step-b-qa', days: 14, recordedAt: 401 },
      stamp,
    ),
  );
  await expectWritten(
    stores.progress.set(
      { workItemId: 'work-a-two', stepId: 'step-a-dev', state: 'done', statedAt: 302 },
      stamp,
    ),
  );
  await expectWritten(
    stores.progress.set(
      { workItemId: 'work-b-two', stepId: 'step-b-dev', state: 'in_progress', statedAt: 402 },
      stamp,
    ),
  );
  await expectWritten(
    stores.measures.set(
      {
        workItemId: 'work-a-two',
        stepId: 'step-a-qa',
        metric: 'token_actual',
        value: 500,
        recordedAt: 303,
      },
      stamp,
    ),
  );
  await expectWritten(
    stores.measures.set(
      {
        workItemId: 'work-b-two',
        stepId: 'step-b-qa',
        metric: 'hours_actual',
        value: 15,
        recordedAt: 403,
      },
      stamp,
    ),
  );
  await stores.dependencies.add(
    {
      id: 'capture-dependency-a',
      projectId: 'project-a',
      predecessorId: 'work-a-one',
      successorId: 'work-a-two',
    },
    stamp,
  );
  await stores.dependencies.add(
    {
      id: 'capture-dependency-b',
      projectId: 'project-b',
      predecessorId: 'work-b-two',
      successorId: 'work-b-one',
    },
    stamp,
  );
  expect(await stores.priorityBands.replace('project-a', A_BANDS, stamp)).toEqual({ ok: true });
  expect(await stores.priorityBands.replace('project-b', B_BANDS, stamp)).toEqual({ ok: true });

  const [projectA, projectB, dependenciesA, dependenciesB] = await Promise.all([
    readSeededPlanInput(stores, seed.projectIds[0]),
    readSeededPlanInput(stores, seed.projectIds[1]),
    stores.dependencies.listByProject(seed.projectIds[0]),
    stores.dependencies.listByProject(seed.projectIds[1]),
  ]);
  const completeState = {
    projectA: observePlanInput(projectA),
    projectB: observePlanInput(projectB),
  };
  expect(
    (['memory-unbumped', 'sqlite-bumped'] as const).map((revisionPolicy) => ({
      projectA: savedPlanCaptureExpected(seed, 0, revisionPolicy),
      projectB: savedPlanCaptureExpected(seed, 1, revisionPolicy),
    })),
  ).toContainEqual(completeState);
  expect(dependenciesA).toEqual([
    {
      id: 'capture-dependency-a',
      projectId: 'project-a',
      predecessorId: 'work-a-one',
      successorId: 'work-a-two',
    },
  ]);
  expect(dependenciesB).toEqual([
    {
      id: 'capture-dependency-b',
      projectId: 'project-b',
      predecessorId: 'work-b-two',
      successorId: 'work-b-one',
    },
  ]);
}

function captureAlternatives(seed: SeededPlan, missing: PlanInputReads | null) {
  return (['memory-unbumped', 'sqlite-bumped'] as const).map((revisionPolicy) => ({
    missing,
    projectA: savedPlanCaptureExpected(seed, 0, revisionPolicy),
    projectB: savedPlanCaptureExpected(seed, 1, revisionPolicy),
  }));
}

async function readComplete(port: SavedPlanCaptureStore, projectId: string) {
  const captured = await port.readPlanInput(projectId);
  expect(captured).not.toBeNull();
  if (captured === null) throw new Error(`capture unexpectedly absent for ${projectId}`);
  return captured;
}

function clearArray(array: readonly unknown[]) {
  Reflect.apply(Array.prototype.splice, array, [0, array.length]);
}

/** Shared complete, missing-project, and detached capture cases. */
export function savedPlanCaptureRegistrations(
  open: OpenCase<'savedPlanCapture'>,
): readonly CaseRegistration[] {
  return [
    storeCase(
      'savedPlanCapture',
      'savedPlanCapture.readPlanInput:complete',
      open,
      async ({ port, seed }) => {
        const captured = observePlanInput(await readComplete(port, seed.projectIds[0]));
        expect([
          savedPlanCaptureExpected(seed, 0, 'memory-unbumped'),
          savedPlanCaptureExpected(seed, 0, 'sqlite-bumped'),
        ]).toContainEqual(captured);
      },
    ),
    storeCase(
      'savedPlanCapture',
      'savedPlanCapture.readPlanInput:coherent-interleave',
      open,
      async ({ port, seed, scenario }) => {
        if (scenario.kind !== 'capture-interleave')
          throw new Error('coherent capture requires its interleave scenario');
        const heldRead = port.readPlanInput(seed.projectIds[0]);
        await scenario.firstRead.entered;
        let change: Awaited<ReturnType<typeof scenario.changeDirectory>> | undefined;
        let changeFailure: unknown;
        try {
          change = await scenario.changeDirectory();
        } catch (cause) {
          changeFailure = cause;
        } finally {
          scenario.firstRead.release();
        }
        const heldSettlement = await Promise.allSettled([heldRead]);
        if (changeFailure !== undefined)
          throw changeFailure instanceof Error
            ? changeFailure
            : new Error('capture directory change failed', { cause: changeFailure });
        const held = heldSettlement[0];
        if (held.status === 'rejected')
          throw held.reason instanceof Error
            ? held.reason
            : new Error(`held capture rejected: ${String(held.reason)}`);
        if (change === undefined) throw new Error('capture directory change did not settle');
        const tag = change.tag;
        const person = change.person;
        if (!tag.ok) throw new Error(`capture tag change was refused: ${tag.reason}`);
        if (!person.ok) throw new Error(`capture person change was refused: ${person.reason}`);
        if (held.value === null) throw new Error('held capture unexpectedly absent');
        const next = await readComplete(port, seed.projectIds[0]);
        const observed = {
          change: { tag, person },
          held: observePlanInput(held.value),
          next: observePlanInput(next),
        };
        expect(
          (['memory-unbumped', 'sqlite-bumped'] as const).map((revisionPolicy) => ({
            change: {
              tag: {
                ok: true as const,
                tag: { id: 'tag-a', name: 'Tag after interleave' },
                projectIds: [seed.projectIds[0]] as readonly string[],
              },
              person: {
                ok: true as const,
                person: {
                  id: 'capture-person-unassigned',
                  name: 'Unassigned member',
                  kind: 'person',
                  teamIds: ['team-a'] as readonly string[],
                },
                projectIds: [] as readonly string[],
              },
            },
            held: savedPlanCaptureExpected(seed, 0, revisionPolicy, 'before'),
            next: savedPlanCaptureExpected(seed, 0, revisionPolicy, 'after'),
          })),
        ).toContainEqual(observed);
      },
    ),
    storeCase(
      'savedPlanCapture',
      'savedPlanCapture.readPlanInput:missing-project',
      open,
      async ({ port, seed }) => {
        const [missing, projectA, projectB] = await Promise.all([
          port.readPlanInput('capture-project-missing'),
          readComplete(port, seed.projectIds[0]),
          readComplete(port, seed.projectIds[1]),
        ]);
        expect(captureAlternatives(seed, null)).toContainEqual({
          missing,
          projectA: observePlanInput(projectA),
          projectB: observePlanInput(projectB),
        });
      },
    ),
    storeCase(
      'savedPlanCapture',
      'savedPlanCapture.readPlanInput:detached',
      open,
      async ({ port, seed }) => {
        const first = await readComplete(port, seed.projectIds[0]);
        expect(captureAlternatives(seed, null).map(({ projectA }) => projectA)).toContainEqual(
          observePlanInput(first),
        );
        const labelled = first.workItems.find(({ id }) => id === 'work-a-one');
        const unassigned = first.people.find(({ id }) => id === 'capture-person-unassigned');
        const team = first.teams.find(({ id }) => id === 'team-a');
        expect({ labelled, unassigned, team }).toMatchObject({
          labelled: { id: 'work-a-one' },
          unassigned: { id: 'capture-person-unassigned' },
          team: { id: 'team-a' },
        });
        if (labelled === undefined || unassigned === undefined || team === undefined)
          throw new Error('capture mutation witnesses are absent');
        for (const nested of [
          labelled.teamIds,
          labelled.tagIds,
          labelled.serviceIds,
          labelled.typeIds,
          unassigned.teamIds,
          team.serviceIds,
        ])
          clearArray(nested);
        for (const collection of [
          first.steps,
          first.workItems,
          first.estimates,
          first.actuals,
          first.progress,
          first.measures,
          first.dependencies,
          first.assignments,
          first.priorityBands,
          first.people,
          first.teams,
          first.services,
          first.tags,
          first.workItemTypes,
          first.externalSystems,
        ])
          clearArray(collection);
        const [projectA, projectB] = await Promise.all([
          readComplete(port, seed.projectIds[0]),
          readComplete(port, seed.projectIds[1]),
        ]);
        expect(captureAlternatives(seed, null)).toContainEqual({
          missing: null,
          projectA: observePlanInput(projectA),
          projectB: observePlanInput(projectB),
        });
      },
    ),
  ];
}
