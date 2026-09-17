import { defineEndpointShape, planDocumentRequest, responseSchema } from '@wbs/contracts';
import { classifyPlanDocument, prepareImport } from '@wbs/core';
import { planDocumentFixture } from '@wbs/core/testing/plan-document-fixture';
import { countingUnitOfWork } from '@wbs/core/testing/writes-fixture';
import { type } from 'arktype';
import { expect, test } from 'bun:test';

import { bind, EMPTY, type IdentityResolver, type RequestFailure } from '../endpoint';
import { mountEndpoints } from './mount';

const boundary = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/import',
  operationId: 'testPlanDocumentBoundary',
  policies: [],
  body: planDocumentRequest,
  bodyMedia: ['application/json'],
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [
    {
      status: 400,
      // Section 4 publishes the import endpoint. This local production-adapter
      // harness observes the classifier path through the established tolerant
      // response boundary without claiming that route ahead of that slice.
      schema: responseSchema(type({ error: "'invalid_body' | 'unsupported_version'" })),
    },
  ],
  document: { summary: 'Exercise the import document boundary before persistence exists.' },
});

const unusedIdentity: IdentityResolver = () => {
  throw new Error('the boundary has no identity policy');
};

async function refused(input: unknown) {
  const classified = await classifyPlanDocument(input);
  if (classified.ok) throw new Error('a rejected request passed its own classifier');
  return {
    ok: false,
    status: 400,
    body: { error: classified.code, path: classified.path },
  } as const;
}

function mounted(
  uow = countingUnitOfWork(),
  scheduler: Parameters<typeof prepareImport>[1] = { supports: () => true },
) {
  return mountEndpoints(
    [
      bind(
        boundary,
        async ({ body }) => {
          const classified = await classifyPlanDocument(body);
          if (!classified.ok)
            return {
              ok: false,
              status: 400,
              body: { error: classified.code, path: classified.path },
            };
          const prepared = prepareImport(classified.value, scheduler);
          if (!prepared.ok)
            return {
              ok: false,
              status: 400,
              // Section 4 owns the public import-refusal envelopes. This staged
              // mount keeps its declared transport code and exposes the pure
              // preparation discriminant only to this test harness.
              body: {
                error: 'invalid_body' as const,
                importError: prepared.code,
                path: prepared.path,
                detail: prepared.detail,
              },
            };
          return uow.run(() =>
            Promise.resolve({ commit: true, value: { ok: true, status: 204, body: EMPTY } }),
          );
        },
        {
          classifyRequestFailure: (failure: RequestFailure) => refused(failure.rejected),
        },
      ),
    ],
    { appOrigin: 'https://app.example', resolveIdentity: unusedIdentity },
  );
}

async function postPlan(app: ReturnType<typeof mounted>, supplied: unknown) {
  return app.handle(
    new Request('https://backend.example/api/projects/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(supplied),
    }),
  );
}

type PlanFixture = ReturnType<typeof planDocumentFixture>;

function rowOf(supplied: PlanFixture) {
  const row = supplied.workItems.at(0);
  if (row === undefined) throw new Error('fixture lacks a row');
  return row;
}

function documentBody() {
  const row = {
    id: 'row-1',
    parentId: null,
    position: 10,
    name: 'Ship',
    notes: '',
    frozenNumber: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    deadline: null,
    factStart: null,
    factEnd: null,
    priority: 3,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    teamIds: [],
    tagIds: [],
    serviceIds: [],
    typeIds: [],
    externalRefs: [],
    estimates: {},
    actuals: {},
    progress: {},
    measures: {},
    dependsOn: [],
    assignees: {},
  };
  return {
    document: { format: 'wbs-plan', version: 1, exportedAt: '2026-09-13T12:30:00.000Z' },
    settings: {
      name: 'Plan',
      restricted: false,
      estimateMethod: 'pert',
      depReach: 'whole-item',
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'ceil',
      startDate: null,
      solutionRef: null,
      optimizationEnabled: false,
      scheduleEngine: 'fast',
      scheduleObjective: 'pri',
    },
    capacity: [],
    priorityBands: [],
    calendarMarkers: [],
    directory: {
      teams: [],
      people: [],
      tags: [],
      services: [],
      types: [],
      externalSystems: [],
    },
    workItems: Array.from({ length: 4 }, () => structuredClone(row)),
    steps: [],
    derivedFutureField: 'deleted',
  };
}

test('mounted malformed priority names workItems[3].priority', async () => {
  const supplied = documentBody();
  Reflect.set(supplied.workItems[3] ?? {}, 'priority', 'high');
  const response = await mounted().handle(
    new Request('https://backend.example/api/projects/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(supplied),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'invalid_body',
    path: 'workItems[3].priority',
  });
});

test('mounted unknown version precedes version-specific validation', async () => {
  const supplied = documentBody();
  Reflect.set(supplied.document, 'version', 2);
  Reflect.set(supplied.workItems[3] ?? {}, 'priority', 'high');
  const response = await mounted().handle(
    new Request('https://backend.example/api/projects/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(supplied),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'unsupported_version',
    path: 'document.version',
  });
});

const preparationFaults: readonly (readonly [
  string,
  (supplied: PlanFixture) => void,
  string,
  string,
])[] = [
  [
    'duplicate row id',
    (supplied) => {
      supplied.workItems.push(structuredClone(rowOf(supplied)));
    },
    'invalid_body',
    'workItems[1].id',
  ],
  [
    'duplicate normalized tag name',
    (supplied) => {
      supplied.directory.tags.push({ id: 'tag-2', name: 'Release' });
    },
    'invalid_body',
    'directory.tags[1].name',
  ],
  [
    'invalid date',
    (supplied) => {
      rowOf(supplied).deadline = '2026-02-31';
    },
    'invalid_body',
    'workItems[0].deadline',
  ],
  [
    'deadline before project start',
    (supplied) => {
      rowOf(supplied).deadline = '2026-09-13';
    },
    'deadline_before_project_start',
    'workItems[0].deadline',
  ],
  [
    'invalid priority',
    (supplied) => {
      rowOf(supplied).priority = 0;
    },
    'invalid_body',
    'workItems[0].priority',
  ],
  [
    'invalid band',
    (supplied) => {
      const band = supplied.priorityBands.at(1);
      if (band === undefined) throw new Error('fixture lacks a second band');
      band.startsAt = 1;
    },
    'invalid_body',
    'priorityBands[1].startsAt',
  ],
  [
    'invalid capacity',
    (supplied) => {
      const capacity = supplied.capacity.at(0);
      if (capacity === undefined) throw new Error('fixture lacks capacity');
      capacity.size = 0;
    },
    'invalid_body',
    'capacity[0].size',
  ],
  [
    'unknown step',
    (supplied) => {
      rowOf(supplied).actuals = { missing: 1 };
    },
    'unknown_ref',
    'workItems[0].actuals.missing',
  ],
  [
    'invalid leaf value',
    (supplied) => {
      rowOf(supplied).actuals = { 'step-1': -1 };
    },
    'invalid_body',
    'workItems[0].actuals.step-1',
  ],
  [
    'unknown system',
    (supplied) => {
      const reference = rowOf(supplied).externalRefs.at(0);
      if (reference === undefined) throw new Error('fixture lacks an external ref');
      reference.systemId = 'missing';
    },
    'unknown_ref',
    'workItems[0].externalRefs[0].systemId',
  ],
  [
    'unknown person',
    (supplied) => {
      rowOf(supplied).assignees['step-1'] = 'missing';
    },
    'unknown_ref',
    'workItems[0].assignees.step-1',
  ],
  [
    'unknown dependency',
    (supplied) => {
      rowOf(supplied).dependsOn = ['missing'];
    },
    'unknown_ref',
    'workItems[0].dependsOn[0]',
  ],
  [
    'hierarchy cycle',
    (supplied) => {
      const row = rowOf(supplied);
      row.parentId = row.id;
    },
    'cycle',
    'workItems[0].parentId',
  ],
];

test.each(preparationFaults)(
  'mounted preparation refuses %s without opening a unit of work',
  async (_name, fault, error, path) => {
    const supplied = planDocumentFixture();
    fault(supplied);
    const uow = countingUnitOfWork();
    const response = await postPlan(mounted(uow), supplied);
    expect(uow.calls).toEqual([]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_body',
      importError: error,
      path,
    });
  },
);

test('mounted enabled unavailable optimizer creates nothing', async () => {
  const supplied = planDocumentFixture();
  supplied.settings.optimizationEnabled = true;
  supplied.settings.scheduleEngine = 'optimized';
  const uow = countingUnitOfWork();
  const response = await postPlan(
    mounted(uow, { supports: (engine) => engine === 'fast' }),
    supplied,
  );
  expect(uow.calls).toEqual([]);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'invalid_body',
    importError: 'engine_unavailable',
    path: 'settings.scheduleEngine',
  });
});
