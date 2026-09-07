import { expect, test } from 'bun:test';

import { responseSchema, validateSchema } from './schema-shape';
import { workItemTree } from './work-item-response';

test('tree boundary refuses missing core producer fields while allowing additive metadata', async () => {
  const schema = responseSchema(workItemTree);
  const tree = {
    workItems: [],
    seq: 1,
    scheduleError: null,
    waitingForPerson: 0,
    waitingForCapacity: 0,
    slices: [],
    steps: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'exact',
    depReach: 'whole-item',
    startDate: null,
    projectRevision: 1,
  };
  expect(
    (await validateSchema(schema, { ...tree, future: { extra: true } })).issues,
  ).toBeUndefined();
  const { projectRevision, ...missing } = tree;
  expect((await validateSchema(schema, missing)).issues).toBeDefined();
});

test('checks deadline and slice lateness while retaining additive nested response fields', async () => {
  const schema = responseSchema(workItemTree);
  const schedule = {
    duration: 1,
    estimated: true,
    earliestStart: 0,
    earliestFinish: 1,
    latestStart: 0,
    latestFinish: 1,
    float: 0,
    critical: true,
  };
  const row = {
    id: 'w',
    projectId: 'p',
    parentId: null,
    position: 1,
    name: 'Work',
    notes: '',
    frozenNumber: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    deadline: '2026-09-07',
    priority: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    revision: 0,
    teamIds: [],
    tagIds: [],
    serviceIds: [],
    typeIds: [],
    externalRefs: [{ id: 'ref', systemId: 'jira', url: 'https://example.test/issue/1' }],
    number: '010',
    estimates: { s: { optimistic: 1, realistic: 1, pessimistic: 1 } },
    rolledUp: false,
    actuals: { s: 1 },
    progress: { s: 'done' },
    state: 'done',
    measures: { hours_actual: { s: 8 } },
    dependsOn: [],
    finalDays: { s: 1 },
    finalTotal: 1,
    schedule,
    dates: null,
    assignees: { s: 'person' },
    doesEveryStep: 'person',
    future: true,
  };
  const slice = {
    ...schedule,
    id: 'slice',
    workItemId: 'w',
    stepId: 's',
    personId: 'person',
    boundBy: 'projectStart',
    resourcePredecessorId: null,
    capacityPredecessorIds: [],
    capacityTeamId: null,
    width: 1,
    effort: 1,
    lateBy: null,
  };
  const tree = {
    workItems: [row],
    seq: 1,
    scheduleError: null,
    waitingForPerson: 0,
    waitingForCapacity: 0,
    slices: [slice],
    steps: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'exact',
    depReach: 'whole-item',
    startDate: null,
    projectRevision: 1,
  };
  expect((await validateSchema(schema, tree)).issues).toBeUndefined();
  for (const altered of [
    { ...tree, workItems: [{ ...row, deadline: 3 }] },
    { ...tree, slices: [{ ...slice, lateBy: 'late' }] },
    { ...tree, workItems: [{ ...row, measures: { hours_actual: { s: '8' } } }] },
    {
      ...tree,
      workItems: [
        {
          ...row,
          externalRefs: [{ systemId: 'jira', url: 'https://example.test/issue/1' }],
        },
      ],
    },
    {
      ...tree,
      workItems: [
        {
          ...row,
          externalRefs: [{ id: 1, systemId: 'jira', url: 'https://example.test/issue/1' }],
        },
      ],
    },
  ])
    expect((await validateSchema(schema, altered)).issues).toBeDefined();
});

test('checks the optional optimization projection and every variant state', async () => {
  const schema = responseSchema(workItemTree);
  const tree = {
    workItems: [],
    seq: 1,
    scheduleError: null,
    waitingForPerson: 0,
    waitingForCapacity: 0,
    slices: [],
    steps: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'exact',
    depReach: 'whole-item',
    startDate: null,
    projectRevision: 1,
  };
  const optimization = {
    enabled: true,
    engine: 'optimized',
    objective: 'pri',
    inputHash: 'input',
    generation: 2,
    contractVersion: '7+test',
    budgetMs: 60_000,
    displayed: 'pri',
    variants: {
      pri: { state: 'ready' },
      time: {
        state: 'plan-infeasible',
        items: [{ ownerWorkItemId: 'owner', boundWorkItemId: 'bound', effectiveDeadlineOffset: 4 }],
      },
    },
    comparison: { deltaDays: -2, sameOrder: false },
  };

  expect((await validateSchema(schema, { ...tree, optimization })).issues).toBeUndefined();
  expect(
    (
      await validateSchema(schema, {
        ...tree,
        optimization: {
          ...optimization,
          variants: { ...optimization.variants, pri: { state: 'failed', reason: 'unknown' } },
        },
      })
    ).issues,
  ).toBeDefined();
});
