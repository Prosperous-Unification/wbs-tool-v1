import { afterEach, expect, spyOn, test } from 'bun:test';

import { EMPTY } from '../http/endpoint';
import type { SavedPlanWrite } from '../repository/saved-plan';
import type { AuthenticatedUser } from '../service/auth.service';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { projectRow, testProjectService } from '../testing/project-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { savedPlanRoutes } from './saved-plan.routes';
const restorations: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorations.splice(0)) restore();
});
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
  const plans = testSavedPlanService();
  const projects = testProjectService();
  const announcements = recordingBroadcaster();
  const projectRead = spyOn(projects, 'read').mockResolvedValue({
    project: projectRow({ id: 'p' }),
    steps: [],
  });
  const save = spyOn(plans, 'save').mockResolvedValue({ outcome: 'saved', record });
  const list = spyOn(plans, 'list').mockResolvedValue([]);
  const read = spyOn(plans, 'read').mockResolvedValue({ outcome: 'read', plan: record });
  const compare = spyOn(plans, 'compare').mockResolvedValue({
    outcome: 'compared',
    diff: { input: [], schedule: [] },
  });
  const rename = spyOn(plans, 'rename').mockResolvedValue({ outcome: 'touched', projectId: 'p' });
  const remove = spyOn(plans, 'delete').mockResolvedValue({ outcome: 'touched', projectId: 'p' });
  for (const spy of [projectRead, save, list, read, compare, rename, remove])
    restorations.push(() => {
      spy.mockRestore();
    });
  const endpoints = savedPlanRoutes(plans, projects, announcements);
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
