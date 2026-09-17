import { planDocumentResponse, validateSchema, type WorkItemTree } from '@wbs/contracts';
import { expect, test } from 'bun:test';

import type { CalendarMarker, DirectoryStore, Project } from '../index';
import { classifyPlanDocument, PlanDocumentService } from './plan-document';

const PROJECT: Project = {
  id: 'project-1',
  name: 'Release plan',
  ownerId: 'owner-1',
  restricted: true,
  estimateMethod: 'realistic',
  depReach: 'anchor-slice',
  pertWeights: { optimistic: 2, realistic: 5, pessimistic: 2 },
  estimateRounding: 'round',
  startDate: '2026-09-14',
  solutionRef: { slug: 'release-plan', url: 'https://example.test/release-plan' },
  revision: 7,
  createdAt: 1_000,
  optimizationEnabled: true,
  scheduleEngine: 'optimized',
  scheduleObjective: 'time',
};

const TREE: WorkItemTree = {
  workItems: [
    {
      id: 'row-1',
      projectId: PROJECT.id,
      parentId: null,
      position: 10,
      name: 'Ship',
      notes: 'Keep the deadline',
      frozenNumber: '1',
      startNoEarlierThan: '2026-09-14',
      startNoEarlierThanReason: 'Release window',
      deadline: '2026-09-18',
      factStart: null,
      factEnd: null,
      priority: 2,
      serviceTeamId: 'team-direct',
      serviceId: 'service-direct',
      maxParallel: 2,
      revision: 3,
      teamIds: [],
      tagIds: ['tag-used'],
      serviceIds: [],
      typeIds: ['type-used'],
      externalRefs: [
        {
          id: 'ref-1',
          systemId: 'system-used',
          url: 'https://example.test/issues/1',
          name: 'ISSUE-1',
        },
      ],
      number: '1',
      estimates: { 'step-1': { optimistic: 1, realistic: 2, pessimistic: 3 } },
      rolledUp: false,
      actuals: { 'step-1': 1 },
      progress: { 'step-1': 'in_progress' },
      status: 'in_progress',
      measures: { hours: { 'step-1': 4 } },
      dependsOn: [],
      finalDays: { 'step-1': 2 },
      finalTotal: 2,
      schedule: {
        duration: 2,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 2,
        latestStart: 0,
        latestFinish: 2,
        float: 0,
        critical: true,
      },
      dates: { startsOn: '2026-09-14', endsOn: '2026-09-15' },
      assignees: { 'step-1': 'person-used' },
      doesEveryStep: null,
    },
  ],
  seq: 19,
  scheduleError: null,
  waitingForPerson: 0,
  waitingForCapacity: 1,
  slices: [
    {
      id: 'slice-1',
      workItemId: 'row-1',
      stepId: 'step-1',
      personId: 'person-used',
      duration: 2,
      estimated: true,
      earliestStart: 0,
      earliestFinish: 2,
      latestStart: 0,
      latestFinish: 2,
      float: 0,
      critical: true,
      boundBy: 'capacity',
      resourcePredecessorId: null,
      capacityPredecessorIds: [],
      capacityTeamId: 'team-membership',
      width: 1,
      effort: 2,
      lateBy: null,
    },
  ],
  steps: [{ id: 'step-1', projectId: PROJECT.id, name: 'Build', position: 10 }],
  assignedPeople: [{ id: 'person-used', name: 'Kat' }],
  teamCapacities: [{ serviceTeamId: 'team-capacity', size: 4 }],
  priorityBands: [
    { startsAt: 1, defaultValue: 1, label: 'Urgent' },
    { startsAt: 2, defaultValue: 2, label: 'High' },
    { startsAt: 3, defaultValue: 3, label: 'Medium' },
    { startsAt: 4, defaultValue: 4, label: 'Low' },
    { startsAt: 5, defaultValue: 5, label: 'Someday' },
  ],
  estimateMethod: PROJECT.estimateMethod,
  pertWeights: PROJECT.pertWeights,
  estimateRounding: PROJECT.estimateRounding,
  depReach: PROJECT.depReach,
  startDate: PROJECT.startDate,
  projectRevision: PROJECT.revision,
  optimization: {
    enabled: true,
    engine: 'optimized',
    objective: 'time',
    inputHash: 'input-hash',
    generation: 4,
    contractVersion: '7+test',
    budgetMs: 60_000,
    displayed: 'time',
    variants: {
      pri: { state: 'ready', proof: 'proven' },
      time: { state: 'ready', proof: 'proven' },
    },
    finishDays: { fast: 5, pri: 4, time: 3 },
    sameOrderAsFast: { pri: false, time: false },
  },
};

const MARKERS: CalendarMarker[] = [
  {
    id: 'marker-1',
    projectId: PROJECT.id,
    date: '2026-09-17',
    name: 'Launch',
    color: null,
    createdAt: 1_200,
  },
];

function directory(): Pick<
  DirectoryStore,
  | 'listTeams'
  | 'listPeople'
  | 'listTags'
  | 'listServices'
  | 'listWorkItemTypes'
  | 'listExternalSystems'
> {
  return {
    listTeams: () =>
      Promise.resolve([
        { id: 'team-capacity', name: 'Capacity only', serviceIds: [] },
        { id: 'team-direct', name: 'Direct label', serviceIds: [] },
        { id: 'team-membership', name: 'Billing', serviceIds: ['service-owned'] },
        { id: 'team-unused', name: 'Unrelated team', serviceIds: [] },
      ]),
    listPeople: () =>
      Promise.resolve([
        { id: 'person-used', name: 'Kat', kind: 'agent', teamIds: ['team-membership'] },
        { id: 'person-unused', name: 'Nobody', kind: 'person', teamIds: [] },
      ]),
    listTags: () =>
      Promise.resolve([
        { id: 'tag-used', name: 'Release' },
        { id: 'tag-unused', name: 'Unrelated' },
      ]),
    listServices: () =>
      Promise.resolve([
        { id: 'service-direct', name: 'Delivery' },
        { id: 'service-owned', name: 'Billing API' },
        { id: 'service-unused', name: 'Unrelated service' },
      ]),
    listWorkItemTypes: () =>
      Promise.resolve([
        { id: 'type-used', name: 'Milestone' },
        { id: 'type-unused', name: 'Unrelated type' },
      ]),
    listExternalSystems: () =>
      Promise.resolve([
        { id: 'system-used', name: 'Tracker' },
        { id: 'system-unused', name: 'Unrelated tracker' },
      ]),
  };
}

function service(directorySource = directory()) {
  return new PlanDocumentService({
    directory: directorySource,
    markers: { list: () => Promise.resolve({ ok: true, value: MARKERS }) },
    clock: { now: () => Date.parse('2026-09-13T12:30:00.000Z') },
  });
}

test('preserves the existing JSON export fields', async () => {
  const exported = await service().export(PROJECT, TREE);
  const { document, settings, capacity, calendarMarkers, directory: names, ...existing } = exported;
  expect(existing).toEqual({ project: PROJECT, ...TREE });
  expect(existing.workItems[0]?.deadline).toBe('2026-09-18');
  expect(existing.optimization).toEqual(TREE.optimization);
  expect({ document, settings, capacity, calendarMarkers, names }).toBeDefined();
});

test('JSON export is a versioned plan document and settings says what project says', async () => {
  const exported = await service().export(PROJECT, TREE);
  expect((await validateSchema(planDocumentResponse, exported)).issues).toBeUndefined();
  expect(exported.document).toEqual({
    format: 'wbs-plan',
    version: 1,
    exportedAt: '2026-09-13T12:30:00.000Z',
  });
  expect(exported.settings).toEqual({
    name: PROJECT.name,
    restricted: PROJECT.restricted,
    estimateMethod: PROJECT.estimateMethod,
    depReach: PROJECT.depReach,
    pertWeights: PROJECT.pertWeights,
    estimateRounding: PROJECT.estimateRounding,
    startDate: PROJECT.startDate,
    solutionRef: PROJECT.solutionRef,
    optimizationEnabled: PROJECT.optimizationEnabled,
    scheduleEngine: PROJECT.scheduleEngine,
    scheduleObjective: PROJECT.scheduleObjective,
  });
  expect(exported.capacity).toEqual([{ teamId: 'team-capacity', size: 4 }]);
  expect(exported.calendarMarkers).toEqual([
    { id: 'marker-1', date: '2026-09-17', name: 'Launch', color: null },
  ]);
});

test('capacity-only team is named and assigned agent keeps memberships and owned services', async () => {
  const exported = await service().export(PROJECT, TREE);
  expect(exported.directory.teams).toEqual([
    { id: 'team-capacity', name: 'Capacity only', serviceIds: [] },
    { id: 'team-direct', name: 'Direct label', serviceIds: [] },
    { id: 'team-membership', name: 'Billing', serviceIds: ['service-owned'] },
  ]);
  expect(exported.directory.people).toEqual([
    { id: 'person-used', name: 'Kat', kind: 'agent', teamIds: ['team-membership'] },
  ]);
  expect(exported.directory.services).toEqual([
    { id: 'service-direct', name: 'Delivery' },
    { id: 'service-owned', name: 'Billing API' },
  ]);
});

test('unreferenced tag is excluded', async () => {
  const exported = await service().export(PROJECT, TREE);
  expect(exported.directory.tags).toEqual([{ id: 'tag-used', name: 'Release' }]);
  expect(exported.directory.types).toEqual([{ id: 'type-used', name: 'Milestone' }]);
  expect(exported.directory.externalSystems).toEqual([{ id: 'system-used', name: 'Tracker' }]);
});

test('missing referenced entry throws', async () => {
  const missingTag = directory();
  missingTag.listTags = () => Promise.resolve([]);
  const cause = await service(missingTag)
    .export(PROJECT, TREE)
    .catch((caught: unknown) => caught);
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain('tag "tag-used"');
});

test('malformed priority names workItems[3].priority', async () => {
  const malformed = structuredClone(await service().export(PROJECT, TREE));
  const row = malformed.workItems[0];
  malformed.workItems = Array.from({ length: 4 }, () => structuredClone(row));
  Reflect.set(malformed.workItems[3] ?? {}, 'priority', 'high');
  expect(await classifyPlanDocument(malformed)).toEqual({
    ok: false,
    code: 'invalid_body',
    path: 'workItems[3].priority',
  });
});

test('unknown version precedes version-specific validation', async () => {
  const future = structuredClone(await service().export(PROJECT, TREE));
  Reflect.set(future.document, 'version', 2);
  const row = future.workItems[0];
  future.workItems = Array.from({ length: 4 }, () => structuredClone(row));
  Reflect.set(future.workItems[3] ?? {}, 'priority', 'high');
  expect(await classifyPlanDocument(future)).toEqual({
    ok: false,
    code: 'unsupported_version',
    path: 'document.version',
  });
});

test('archival validation projects derived fields away', async () => {
  const exported = await service().export(PROJECT, TREE);
  const classified = await classifyPlanDocument({ ...exported, audit: { importedBy: 'future' } });
  if (!classified.ok) throw new Error(`fixture document refused at ${classified.path}`);
  expect(classified.value).not.toHaveProperty('audit');
  expect(classified.value.workItems[0]).not.toHaveProperty('projectId');
  expect(classified.value.workItems[0]).not.toHaveProperty('number');
  expect(classified.value.workItems[0]).not.toHaveProperty('rolledUp');
  expect(classified.value.workItems[0]).not.toHaveProperty('schedule');
  expect(classified.value.steps[0]).not.toHaveProperty('projectId');
  expect(classified.value.workItems[0]?.estimates).toEqual(TREE.workItems[0]?.estimates);
});
