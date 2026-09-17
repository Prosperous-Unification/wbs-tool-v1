import type { ImportOutcome } from '@wbs/core';
import { planDocumentFixture } from '@wbs/core/testing/plan-document-fixture';
import { expect, mock, spyOn, test } from 'bun:test';

import { testApp } from '../testing/app-fixture';
import { testAuthService } from '../testing/auth-fixture';
import { testWrites } from '../testing/writes-fixture';

const summary = {
  ok: true as const,
  projectId: 'project-imported',
  rows: 2,
  created: {
    teams: ['Billing'],
    people: [],
    tags: ['Urgent'],
    services: [],
    types: [],
    externalSystems: [],
  },
  solutionRef: 'left-off' as const,
};

function request(body: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('authorization', 'Bearer token');
  requestHeaders.set('content-type', 'application/json');
  return new Request('http://localhost/api/projects/import', {
    method: 'POST',
    headers: requestHeaders,
    body,
  });
}

function mounted(
  scopes: readonly ('read' | 'write' | 'editor')[] = ['read', 'write'],
  outcome: ImportOutcome = summary,
) {
  const auth = testAuthService();
  spyOn(auth, 'authenticate').mockResolvedValue({ id: 'actor', username: 'actor', scopes });
  const imports = mock(() => Promise.resolve(outcome));
  const writes = testWrites();
  writes.imports = { import: imports };
  return { app: testApp({ auth, writes }), imports };
}

test('mounts the production import path and returns the typed 201 summary', async () => {
  const { app, imports } = mounted();
  const document = planDocumentFixture();
  const response = await app.handle(request(JSON.stringify(document)));

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    projectId: summary.projectId,
    rows: summary.rows,
    created: summary.created,
    solutionRef: summary.solutionRef,
  });
  expect(imports).toHaveBeenCalledWith(document, 'actor');
});

test('returns mounted document paths and admitted conflicts through declared refusals', async () => {
  const malformed = planDocumentFixture();
  Reflect.set(malformed.workItems[0] ?? {}, 'priority', 'high');
  const boundary = mounted();
  const invalid = await boundary.app.handle(request(JSON.stringify(malformed)));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({
    error: 'invalid_body',
    path: 'workItems[0].priority',
    detail: null,
  });
  expect(boundary.imports).not.toHaveBeenCalled();

  const conflict = mounted(['read', 'write'], {
    ok: false,
    code: 'engine_unavailable',
    path: 'settings.scheduleEngine',
    detail: 'optimized',
  });
  const refused = await conflict.app.handle(request(JSON.stringify(planDocumentFixture())));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: 'engine_unavailable',
    path: 'settings.scheduleEngine',
    detail: 'optimized',
  });
});

test('checks cookie origin and write scope before parsing the import document', async () => {
  const reader = mounted(['read']);
  const valid = await reader.app.handle(request(JSON.stringify(planDocumentFixture())));
  expect(valid.status).toBe(403);
  expect(await valid.json()).toEqual({ error: 'insufficient_scope' });
  const scoped = await reader.app.handle(request('{'));
  expect(scoped.status).toBe(403);
  expect(await scoped.json()).toEqual({ error: 'insufficient_scope' });
  expect(reader.imports).not.toHaveBeenCalled();

  const writer = mounted();
  const foreign = await writer.app.handle(
    request('{', { cookie: '__Host-wbs_session=session', origin: 'https://foreign.test' }),
  );
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({ error: 'invalid_origin' });
  expect(writer.imports).not.toHaveBeenCalled();
});
