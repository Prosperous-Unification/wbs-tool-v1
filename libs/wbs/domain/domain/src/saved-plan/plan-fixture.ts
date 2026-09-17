import type { PlanInputRows } from './canonical-plan-input';

/**
 * The one plan fixture the saved-plan suites share.
 *
 * Lived inside `canonical-plan-input.test.ts` until the diff needed it too.
 * It is here rather than copied because both suites derive their field set
 * **from this value**: a field added to the capture and to the fixture is then
 * covered by the canonicaliser's tests and by the diff-completeness property at
 * once, whereas two copies drift and the second one silently stops covering
 * anything new.
 */

/**
 * A plan whose every collection holds at least two rows, deliberately supplied
 * out of order. One row each would let a canonicaliser that sorts nothing pass
 * every assertion below.
 */
export const planFixtureRows: PlanInputRows = {
  project: {
    id: 'p1',
    name: 'Rewire the shed',
    restricted: false,
    ownerId: 'u1',
    solutionSlug: 'shed',
    solutionUrl: null,
    estimateMethod: 'pert',
    depReach: 'whole-item',
    estimateRounding: 'ceil',
    startDate: '2026-09-07',
    pertWeightOptimistic: 1,
    pertWeightRealistic: 4,
    pertWeightPessimistic: 1,
  },
  workItems: [
    {
      id: 'w2',
      parentId: 'w1',
      position: 20,
      name: 'Pull cable',
      notes: '',
      typeIds: ['t-spike', 't-task'],
      tagIds: ['tag-b', 'tag-a'],
      externalRefs: [
        { externalSystemId: 'jira', url: 'https://jira/SHED-2', position: 20 },
        { externalSystemId: 'gh', url: 'https://gh/17', position: 10 },
      ],
      priority: 30,
      maxParallel: 1,
      frozenNumber: null,
      serviceTeamId: 'team-1',
      serviceId: null,
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
    },
    {
      id: 'w1',
      parentId: null,
      position: 10,
      name: 'Electrics',
      notes: 'consented',
      typeIds: [],
      tagIds: ['tag-a'],
      externalRefs: [],
      priority: 10,
      maxParallel: 2,
      frozenNumber: '1',
      serviceTeamId: null,
      serviceId: 'svc-1',
      startNoEarlierThan: '2026-09-14',
      startNoEarlierThanReason: 'inspection booked',
    },
  ],
  steps: [
    { id: 's2', name: 'Test', position: 20 },
    { id: 's1', name: 'Build', position: 10 },
  ],
  stepValues: [
    {
      workItemId: 'w2',
      stepId: 's1',
      optimistic: 1,
      realistic: 2,
      pessimistic: 5,
      derived: 2.5,
      actual: null,
      progress: 'in_progress',
    },
    {
      workItemId: 'w1',
      stepId: 's2',
      optimistic: null,
      realistic: null,
      pessimistic: null,
      derived: null,
      actual: 3,
      progress: 'done',
    },
  ],
  measures: [
    // Same item, same metric, two steps — the pair `stepId` was dropped from.
    { workItemId: 'w2', stepId: 's2', metric: 'tokens', value: 300 },
    { workItemId: 'w2', stepId: 's1', metric: 'tokens', value: 1200 },
    { workItemId: 'w2', stepId: 's1', metric: 'hours', value: 8 },
  ],
  dependencies: [
    { predecessorId: 'w2', successorId: 'w1' },
    { predecessorId: 'w1', successorId: 'w2' },
  ],
  assignments: [
    { workItemId: 'w2', stepId: 's2', personId: 'per-1' },
    { workItemId: 'w2', stepId: 's1', personId: 'per-2' },
    { workItemId: 'w1', stepId: 's1', personId: 'per-1' },
  ],
  people: [
    { id: 'per-2', name: 'Bo' },
    { id: 'per-1', name: 'Ada' },
  ],
  teams: [
    { id: 'team-2', name: 'Second fix' },
    { id: 'team-1', name: 'First fix' },
  ],
  services: [
    { id: 'svc-2', name: 'Testing' },
    { id: 'svc-1', name: 'Wiring' },
  ],
  personTeams: [
    { personId: 'per-2', teamId: 'team-2' },
    { personId: 'per-1', teamId: 'team-1' },
  ],
  teamServices: [
    { teamId: 'team-2', serviceId: 'svc-2' },
    { teamId: 'team-1', serviceId: 'svc-1' },
  ],
  workItemTeams: [
    { workItemId: 'w2', teamId: 'team-2' },
    { workItemId: 'w1', teamId: 'team-1' },
  ],
  workItemServices: [
    { workItemId: 'w2', serviceId: 'svc-2' },
    { workItemId: 'w1', serviceId: 'svc-1' },
  ],
  priorityBands: [
    { startsAt: 21, label: 'High', defaultValue: 30 },
    { startsAt: 1, label: 'Critical', defaultValue: 10 },
  ],
  capacity: [
    { teamId: 'team-2', people: 1 },
    { teamId: 'team-1', people: 3 },
  ],
  tags: [
    { id: 'tag-b', name: 'risky' },
    { id: 'tag-a', name: 'agreed' },
  ],
  workItemTypes: [
    { id: 't-epic', name: 'Epic' },
    { id: 't-task', name: 'Task' },
    // `w2` states this one too, and the registry's contract is every type id the
    // captured items use — a fixture that omits it contradicts its own field doc.
    { id: 't-spike', name: 'Spike' },
  ],
  externalSystems: [
    { id: 'jira', name: 'Jira' },
    { id: 'gh', name: 'GitHub' },
  ],
};

/** Every collection reversed — same plan, opposite arrival order. */
export function reversed(values: PlanInputRows): PlanInputRows {
  return {
    ...values,
    workItems: [...values.workItems].reverse().map((row) => ({
      ...row,
      typeIds: [...row.typeIds].reverse(),
      tagIds: [...row.tagIds].reverse(),
      externalRefs: [...row.externalRefs].reverse(),
    })),
    steps: [...values.steps].reverse(),
    stepValues: [...values.stepValues].reverse(),
    measures: [...values.measures].reverse(),
    dependencies: [...values.dependencies].reverse(),
    assignments: [...values.assignments].reverse(),
    people: [...values.people].reverse(),
    teams: [...values.teams].reverse(),
    services: [...values.services].reverse(),
    personTeams: [...values.personTeams].reverse(),
    teamServices: [...values.teamServices].reverse(),
    workItemTeams: [...values.workItemTeams].reverse(),
    workItemServices: [...values.workItemServices].reverse(),
    priorityBands: [...values.priorityBands].reverse(),
    capacity: [...values.capacity].reverse(),
    tags: [...values.tags].reverse(),
    workItemTypes: [...values.workItemTypes].reverse(),
    externalSystems: [...values.externalSystems].reverse(),
  };
}
