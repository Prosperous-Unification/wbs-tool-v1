import type { PlanDocumentRequest } from '@wbs/contracts';

/** A small, fully referenced version-1 document for import-boundary tests. */
export function planDocumentFixture(): PlanDocumentRequest {
  return {
    document: { format: 'wbs-plan', version: 1, exportedAt: '2026-09-13T12:30:00.000Z' },
    settings: {
      name: ' Portable plan ',
      restricted: false,
      estimateMethod: 'pert',
      depReach: 'whole-item',
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'ceil',
      startDate: '2026-09-14',
      solutionRef: null,
      optimizationEnabled: false,
      scheduleEngine: 'fast',
      scheduleObjective: 'pri',
    },
    capacity: [{ teamId: 'team-1', size: 2 }],
    priorityBands: [
      { startsAt: 1, defaultValue: 10, label: ' Critical ' },
      { startsAt: 21, defaultValue: 30, label: 'High' },
      { startsAt: 41, defaultValue: 50, label: 'Medium' },
      { startsAt: 61, defaultValue: 70, label: 'Low' },
      { startsAt: 81, defaultValue: 90, label: 'Lowest' },
    ],
    calendarMarkers: [{ id: 'marker-1', date: '2026-09-18', name: ' Launch ', color: null }],
    directory: {
      teams: [{ id: 'team-1', name: ' Billing ', serviceIds: ['service-1'] }],
      people: [{ id: 'person-1', name: ' Kat ', kind: 'agent', teamIds: ['team-1'] }],
      tags: [{ id: 'tag-1', name: ' Release ' }],
      services: [{ id: 'service-1', name: ' Billing API ' }],
      types: [{ id: 'type-1', name: ' Milestone ' }],
      externalSystems: [{ id: 'system-1', name: ' Tracker ' }],
    },
    workItems: [
      {
        id: 'row-1',
        parentId: null,
        position: 10,
        name: ' Ship ',
        notes: 'Keep the deadline',
        frozenNumber: null,
        startNoEarlierThan: '2026-09-14',
        startNoEarlierThanReason: 'Release window',
        deadline: '2026-09-18',
        factStart: null,
        factEnd: null,
        priority: 2,
        serviceTeamId: 'team-1',
        serviceId: 'service-1',
        maxParallel: 1,
        teamIds: ['team-1'],
        tagIds: ['tag-1'],
        serviceIds: ['service-1'],
        typeIds: ['type-1'],
        externalRefs: [
          {
            id: 'external-ref-1',
            systemId: 'system-1',
            url: 'https://example.test/issues/1',
            name: 'ISSUE-1',
          },
        ],
        estimates: { 'step-1': { optimistic: 1, realistic: 2, pessimistic: 3 } },
        actuals: { 'step-1': 1 },
        progress: { 'step-1': 'in_progress' },
        measures: { hours_actual: { 'step-1': 4 } },
        dependsOn: [],
        assignees: { 'step-1': 'person-1' },
      },
    ],
    steps: [
      { id: 'step-1', name: ' Build ', position: 10 },
      { id: 'step-2', name: 'QA', position: 20 },
    ],
  };
}
