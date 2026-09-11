import {
  testProjectService,
  testWorkItemService,
} from '@wbs/store-memory/testing/service-fixtures';
import { expect, spyOn, test } from 'bun:test';

import type { AuthenticatedUser } from '../service/auth.service';
import { EMPTY } from './endpoint';
import { projectRoutes } from './project.routes';

const principal: AuthenticatedUser = { id: 'owner', username: 'Owner', scopes: ['read', 'write'] };
const request = {
  method: 'POST',
  url: new URL('http://localhost/api/projects'),
  headers: new Headers(),
};

test('direct project bindings create, read, patch and record opening with admitted actor', async () => {
  const projects = testProjectService();
  const endpoints = projectRoutes(projects, testWorkItemService());
  const made = await endpoints[0].handle({
    params: {},
    query: undefined,
    body: { name: '' },
    principal,
    request,
  });
  if (!made.ok) throw new Error('create refused');
  expect(made.status).toBe(200);
  expect(made.body.project.ownerId).toBe('owner');
  expect(made.body.project.name).toBe('');
  expect(made.body.steps.map((step) => step.name)).toEqual(['Dev', 'QA']);
  const input = {
    params: { id: made.body.project.id },
    query: undefined,
    body: undefined,
    principal,
    request,
  };
  expect(await endpoints[4].handle(input)).toEqual({ ok: true, status: 200, body: made.body });
  expect(await endpoints[2].handle(input)).toEqual({ ok: true, status: 204, body: EMPTY });
  const patched = await endpoints[5].handle({ ...input, body: { name: 'Renamed' } });
  if (!patched.ok) throw new Error('patch refused');
  expect(patched.body.project.name).toBe('Renamed');
  expect(await endpoints[2].handle({ ...input, params: { id: 'missing' } })).toEqual({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  });
});

test('direct project and export failures propagate without conversion to not_found', async () => {
  const projects = testProjectService();
  const endpoints = projectRoutes(projects, testWorkItemService());
  const failure = new Error('project store unavailable');
  const read = spyOn(projects, 'read').mockRejectedValue(failure);
  try {
    const input = { params: { id: 'p' }, query: undefined, body: undefined, principal, request };
    expect(await endpoints[4].handle(input).catch((cause: unknown) => cause)).toBe(failure);
    expect(
      await endpoints[3]
        .handle({ ...input, query: { format: 'json' } })
        .catch((cause: unknown) => cause),
    ).toBe(failure);
  } finally {
    read.mockRestore();
  }
});
