import { importProject } from '@wbs/contracts';
import { expect, mock, test } from 'bun:test';

import { planDocumentFixture } from '../testing/plan-document-fixture';
import { importRoutes } from './import.routes';

const summary = {
  ok: true as const,
  projectId: 'project-new',
  rows: 2,
  created: {
    teams: ['Billing'],
    people: [],
    tags: ['Urgent'],
    services: [],
    types: [],
    externalSystems: [],
  },
  solutionRef: 'kept' as const,
};

test('binds the import shape and returns its complete created summary', async () => {
  const importPlan = mock(() => Promise.resolve(summary));
  const [endpoint] = importRoutes({ import: importPlan });
  expect(endpoint.shape).toBe(importProject);

  const response = await endpoint.handle({
    params: {},
    query: undefined,
    body: planDocumentFixture(),
    principal: { id: 'actor', username: 'actor', scopes: ['read', 'write'] },
    request: {
      url: new URL('https://app.test/api/projects/import'),
      method: 'POST',
      headers: new Headers(),
    },
  });

  expect(importPlan).toHaveBeenCalledWith(planDocumentFixture(), 'actor');
  expect(response).toEqual({
    ok: true,
    status: 201,
    body: {
      projectId: summary.projectId,
      rows: summary.rows,
      created: summary.created,
      solutionRef: summary.solutionRef,
    },
  });
});

test.each([
  [
    {
      ok: false as const,
      code: 'unknown_ref' as const,
      path: 'workItems[0].dependsOn[0]',
      detail: 'missing',
    },
    400,
  ],
  [
    {
      ok: false as const,
      code: 'engine_unavailable' as const,
      path: 'settings.scheduleEngine',
      detail: 'optimized',
    },
    409,
  ],
  [
    {
      ok: false as const,
      code: 'source_refused' as const,
      path: 'workItems[0]',
      detail: 'unknown_tag',
    },
    409,
  ],
] as const)('maps import refusal %# to its declared wire status', async (outcome, status) => {
  const [endpoint] = importRoutes({ import: () => Promise.resolve(outcome) });
  const response = await endpoint.handle({
    params: {},
    query: undefined,
    body: planDocumentFixture(),
    principal: { id: 'actor', username: 'actor', scopes: ['write'] },
    request: {
      url: new URL('https://app.test/api/projects/import'),
      method: 'POST',
      headers: new Headers(),
    },
  });
  expect(response.status).toBe(status);
  expect(response.body).toEqual({
    error: outcome.code,
    path: outcome.path,
    detail: outcome.detail,
  });
});
