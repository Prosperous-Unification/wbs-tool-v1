import { projectRow } from '@wbs/store-memory/project-fixture';
import { expect, mock, test } from 'bun:test';

import type { SavedPlanWrite } from '../ports/saved-plan-store';
import type { AuthenticatedUser } from '../service/auth.service';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { EMPTY } from './endpoint';
import { savedPlanRoutes } from './saved-plan.routes';
const principal: AuthenticatedUser = { id: 'actor', username: 'Ada', scopes: ['read', 'write'] };
const record: SavedPlanWrite = {
  id: 's',
  projectId: 'p',
  name: 'Saved',
  createdBy: 'Ada',
  createdById: 'actor',
  createdAt: 1,
  input: { schemaVersion: 1, bytes: '{ "historic": true }', sha256: 'digest' },
  schedule: { present: false, absentReason: 'future_reason' },
};
const direct = {
  params: { id: 'p' },
  body: {},
  query: undefined,
  principal,
  request: {
    method: 'POST',
    url: new URL('http://localhost/api/projects/p/saved-plans'),
    headers: new Headers(),
  },
};

function fixture() {
  const announcements = recordingBroadcaster();
  const projectRead = mock(() =>
    Promise.resolve({
      project: projectRow({ id: 'p' }),
      steps: [],
    }),
  );
  const save = mock(() => Promise.resolve({ outcome: 'saved' as const, record }));
  const list = mock(() => Promise.resolve([]));
  const read = mock(() => Promise.resolve({ outcome: 'read' as const, plan: record }));
  const compare = mock(() =>
    Promise.resolve({
      outcome: 'compared',
      diff: { input: [], schedule: [] },
    } as const),
  );
  const rename = mock(() => Promise.resolve({ outcome: 'touched' as const, projectId: 'p' }));
  const remove = mock(() => Promise.resolve({ outcome: 'touched' as const, projectId: 'p' }));
  const plans = { save, list, read, compare, rename, delete: remove };
  const projects = { read: projectRead };
  const endpoints = savedPlanRoutes(plans as never, projects as never, announcements);
  return { endpoints, save, list, read, compare, rename, remove, projectRead, announcements };
}

test('direct save and touch bindings pass the admitted actor and announce committed success', async () => {
  const f = fixture();
  expect(await f.endpoints[0].handle(direct)).toEqual({
    ok: true,
    status: 201,
    body: { savedPlan: record },
  });
  expect(f.save).toHaveBeenCalledWith({
    projectId: 'p',
    name: undefined,
    createdBy: 'Ada',
    createdById: 'actor',
  });
  expect(
    await f.endpoints[4].handle({ ...direct, params: { id: 's' }, body: { name: '  ' } }),
  ).toEqual({ ok: true, status: 200, body: { savedPlanId: 's', name: '  ' } });
  expect(f.rename).toHaveBeenCalledWith('s', 'actor', '  ');
  expect(await f.endpoints[5].handle({ ...direct, params: { id: 's' }, body: undefined })).toEqual({
    ok: true,
    status: 204,
    body: EMPTY,
  });
  expect(f.remove).toHaveBeenCalledWith('s', 'actor');
  expect(f.announcements.published).toEqual(
    Array.from({ length: 3 }, () => ({ projectId: 'p', event: { type: 'saved_plans_changed' } })),
  );
});

test('direct unknown service errors preserve error identity', async () => {
  const f = fixture();
  const failure = new Error('direct unavailable');
  f.read.mockRejectedValueOnce(failure);
  expect(
    await f.endpoints[3].handle({ ...direct, body: undefined }).catch((cause: unknown) => cause),
  ).toBe(failure);
});
