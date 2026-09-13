import { inMemoryProjects, projectRow } from '@wbs/store-memory/project-fixture';
import { inMemorySteps, stepRow } from '@wbs/store-memory/step-fixture';
import { expect, spyOn, test } from 'bun:test';

import { StepService } from '../service/step.service';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { testClock } from '../testing/clock-fixture';
import { EMPTY } from './endpoint';
import { stepRoutes } from './step.routes';

const principal = { id: 'owner', username: 'owner', scopes: ['read', 'write'] as const };
const request = {
  method: 'POST',
  url: new URL('https://app.example/steps'),
  headers: new Headers(),
};

async function fixture(restricted = false) {
  const projects = inMemoryProjects();
  await projects.create(projectRow({ id: 'project', restricted }), [], { at: 1, by: principal.id });
  const stored = inMemorySteps([
    stepRow({ id: 'step', projectId: 'project', name: 'Design' }),
    stepRow({ id: 'other', projectId: 'project', name: 'QA', position: 20 }),
    stepRow({ id: 'foreign', projectId: 'elsewhere', name: 'Foreign' }),
  ]);
  const addWrite = spyOn(stored, 'add');
  const broadcast = recordingBroadcaster();
  const service = new StepService({ clock: testClock, projects, steps: stored, broadcast });
  return { projects, stored, addWrite, broadcast, service, endpoints: stepRoutes(service) };
}

test('typed step bindings preserve the service value, actor and trimmed name', async () => {
  const {
    endpoints: [add, rename],
    stored,
    addWrite,
    broadcast,
  } = await fixture();
  const added = await add.handle({
    params: { id: 'project' },
    query: undefined,
    body: { name: '  Build  ' },
    principal,
    request,
  });
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error('add fixture refused');
  expect(added.status).toBe(200);
  expect(added.body.step.name).toBe('Build');
  expect(await stored.findById(added.body.step.id)).toEqual(added.body.step);
  expect(addWrite).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: 'Build' }),
    expect.objectContaining({ by: 'owner' }),
  );
  const renamed = await rename.handle({
    params: { id: 'project', stepId: 'step' },
    query: undefined,
    body: { name: '  Review  ' },
    principal,
    request,
  });
  expect(renamed).toEqual({
    ok: true,
    status: 200,
    body: { step: { id: 'step', projectId: 'project', name: 'Review', position: 10 } },
  });
  expect(broadcast.published.map((entry) => entry.event.type)).toEqual([
    'step_added',
    'step_renamed',
  ]);
});

test('typed name bindings preserve every modeled service refusal without a status fallback', async () => {
  const {
    endpoints: [add, rename],
  } = await fixture(true);
  for (const [id, name, actor, status, error] of [
    ['project', ' ', principal, 422, 'name_required'],
    ['missing', 'New', principal, 404, 'not_found'],
    ['project', 'New', { ...principal, id: 'stranger' }, 403, 'forbidden'],
    ['project', 'QA', principal, 409, 'taken'],
  ] as const) {
    const addReply: unknown = await add.handle({
      params: { id },
      query: undefined,
      body: { name },
      principal: actor,
      request,
    });
    expect(addReply).toEqual({ ok: false, status, body: { error } });
    const renameReply: unknown = await rename.handle({
      params: { id, stepId: 'step' },
      query: undefined,
      body: { name },
      principal: actor,
      request,
    });
    expect(renameReply).toEqual({ ok: false, status, body: { error } });
  }
  expect(
    await rename.handle({
      params: { id: 'project', stepId: 'foreign' },
      query: undefined,
      body: { name: 'New' },
      principal,
      request,
    }),
  ).toEqual({ ok: false, status: 404, body: { error: 'not_found' } });
});

test('typed removal carries every usage field and only literal true confirms cascade', async () => {
  const { projects, stored, broadcast } = await fixture();
  const service = new StepService({
    clock: testClock,
    projects,
    broadcast,
    steps: {
      ...stored,
      usageOf: () =>
        Promise.resolve({
          estimates: 1,
          actuals: 2,
          progress: 3,
          measures: 4,
          assignments: [{ workItemId: 'work', stepId: 'step', personId: 'ada' }],
          workItemIds: ['work'],
        }),
    },
  });
  const remove = stepRoutes(service)[2];
  for (const cascade of [undefined, '1', 'TRUE', 'false']) {
    const removeReply: unknown = await remove.handle({
      params: { id: 'project', stepId: 'step' },
      query: { cascade },
      body: undefined,
      principal,
      request,
    });
    expect(removeReply).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'in_use',
        inUse: {
          estimates: 1,
          actuals: 2,
          progress: 3,
          measures: 4,
          assignments: 1,
          assumedAssignees: [{ workItemId: 'work', assumedNow: 'ada', assumedAfter: null }],
        },
      },
    });
    expect(await stored.findById('step')).not.toBeNull();
  }
  expect(
    await remove.handle({
      params: { id: 'project', stepId: 'step' },
      query: { cascade: 'true' },
      body: undefined,
      principal,
      request,
    }),
  ).toEqual({ ok: true, status: 204, body: EMPTY });
  expect(await stored.findById('step')).toBeNull();
  expect(broadcast.published.map((entry) => entry.event.type)).toEqual(['step_removed']);
});

test('typed removal preserves project refusals and unknown repository failures reject', async () => {
  const {
    endpoints: [add, , remove],
    projects,
  } = await fixture(true);
  for (const [id, actor, status, error] of [
    ['missing', principal, 404, 'not_found'],
    ['project', { ...principal, id: 'stranger' }, 403, 'forbidden'],
  ] as const) {
    const removeReply: unknown = await remove.handle({
      params: { id, stepId: 'step' },
      query: {},
      body: undefined,
      principal: actor,
      request,
    });
    expect(removeReply).toEqual({ ok: false, status, body: { error } });
  }
  const outage = new Error('project store unavailable');
  const lookup = spyOn(projects, 'findById').mockRejectedValue(outage);
  try {
    const added = await add
      .handle({
        params: { id: 'project' },
        query: undefined,
        body: { name: 'Valid' },
        principal,
        request,
      })
      .catch((cause: unknown) => cause);
    expect(added).toBe(outage);
    const removed = await remove
      .handle({
        params: { id: 'project', stepId: 'step' },
        query: {},
        body: undefined,
        principal,
        request,
      })
      .catch((cause: unknown) => cause);
    expect(removed).toBe(outage);
  } finally {
    lookup.mockRestore();
  }
});
