import { expect, spyOn, test } from 'bun:test';

import { workItemRoutes } from '../../controller/work-item.routes';
import { PlanCommandRunner } from '../../service/plan-commands';
import { inMemoryServices } from '../../testing/harness';
import { projectRow } from '../../testing/project-fixture';
import { batchServices, testWrites } from '../../testing/writes-fixture';
import { mountEndpoints } from './mount';

function fixture(readOnly = false) {
  const plan = inMemoryServices();
  const writes = testWrites(undefined, batchServices(plan));
  const runner = new PlanCommandRunner({
    batchServices: writes.batch,
    publicServices: batchServices(plan),
    uow: writes.uow,
    announcements: writes.announcements,
  });
  const endpoints = workItemRoutes(plan.service, runner);
  const app = mountEndpoints(endpoints, {
    appOrigin: 'http://localhost',
    resolveIdentity: async (requirement) =>
      await Promise.resolve(
        readOnly && requirement === 'write-scope'
          ? { ok: false, status: 403, body: { error: 'insufficient_scope' } }
          : {
              ok: true,
              principal: {
                id: 'owner',
                username: 'owner',
                scopes: readOnly ? ['read'] : ['read', 'write'],
              },
            },
      ),
  });
  const call = (body: unknown, path = '/api/projects/p/commands') =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  return { runner, plan, endpoints, call, app };
}

test('mounted command classification preserves derived numbering and legacy semantic order before structural errors', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  for (const [commands, expected] of [
    [
      [{ kind: 'patchWorkItem', patch: { number: '010' } }],
      { error: 'number_is_derived', at: 0, kind: 'patchWorkItem' },
    ],
    [
      [
        { kind: 'setActual', stepId: 's', days: -1 },
        { kind: 'createTag', name: 2 },
      ],
      { error: 'invalid_actual', at: 0, kind: 'setActual' },
    ],
    [
      [
        { kind: 'freezeProject', extra: true },
        { kind: 'setActual', stepId: 's', days: -1 },
      ],
      { error: 'invalid_actual', at: 1, kind: 'setActual' },
    ],
  ] as const) {
    const response = await f.call({ commands });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expected);
  }
  expect(run).not.toHaveBeenCalled();
});

test('mounted semantic classification preserves eager common and branch field precedence', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  const cases = [
    [
      { kind: 'createWorkItem', priority: 0, parentRef: 7 },
      { error: 'priority_must_be_a_whole_number_from_1', at: 0, kind: 'createWorkItem' },
    ],
    [
      { kind: 'createWorkItem', name: 7, parentRef: 7 },
      { error: 'name_must_be_text', at: 0, kind: 'createWorkItem' },
    ],
    [
      { kind: 'patchWorkItem', workItemId: 7, patch: null },
      { error: 'workItemId_must_be_an_id', at: 0, kind: 'patchWorkItem' },
    ],
    [
      { kind: 'moveWorkItem', parentRef: 7, afterId: 7 },
      { error: 'afterId_must_be_id_or_null', at: 0, kind: 'moveWorkItem' },
    ],
    [
      { kind: 'freezeProject', workItemId: 7 },
      { error: 'workItemId_must_be_an_id', at: 0, kind: 'freezeProject' },
    ],
  ] as const;
  const outcomes = [];
  for (const [command] of cases) {
    const response = await f.call({ commands: [command] });
    const body: unknown = await response.json();
    outcomes.push({ status: response.status, body });
  }
  // Proof: without eager common validation and the old create/move field order, this received
  // parentRef_must_be_an_id twice, expected_object, parentRef_must_be_an_id and bare invalid_body.
  expect(outcomes).toEqual(cases.map(([, body]) => ({ status: 400, body })));
  expect(run).not.toHaveBeenCalled();
});

test('mounted command results erase internal kind after validating producer-specific requirements', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  run.mockResolvedValueOnce({
    ok: true,
    results: [{ index: 0, kind: 'createTeam', id: 't', entity: { id: 't', name: 'Team' } }],
    undoable: false,
    redoable: false,
  });
  const accepted = await f.call({ commands: [] });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({
    results: [{ index: 0, id: 't', entity: { id: 't', name: 'Team' } }],
    undoable: false,
    redoable: false,
  });
  for (const result of [
    { index: 0, kind: 'patchTeam', entity: { id: 't', name: 'Team' } },
    { index: 0, kind: 'patchPerson', entity: { id: 'p', name: 'Person', kind: 'person' } },
    {
      index: 0,
      kind: 'createPerson',
      id: 'p',
      entity: { id: 'p', name: 'Person', kind: 'invented' },
    },
    { index: 0, kind: 'createPerson', id: 'p', entity: { id: 'p', name: 'Person' } },
    { index: 0, kind: 'createTeam', id: 't', entity: { id: 't', name: 'Team', serviceIds: false } },
    { index: 0, kind: 'createTeam', id: 't', entity: { id: 't', name: 'Team', kind: 'invented' } },
  ]) {
    run.mockResolvedValueOnce({
      ok: true,
      results: [result],
      undoable: false,
      redoable: false,
    } as never);
    expect((await f.call({ commands: [] })).status).toBe(500);
  }
});

test('mounted runtime refusals retain status, command context and code-specific detail', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  for (const [reason, detail, status] of [
    ['taken', { name: 'Existing' }, 409],
    ['in_use', { usage: { projects: [], members: [{ id: 'p', name: 'Person' }] } }, 409],
    ['deadline_before_project_start', { workItemId: 'w', projectDayZero: '2026-09-07' }, 422],
  ] as const) {
    run.mockResolvedValueOnce({ ok: false, reason, detail, at: 2, kind: 'patchWorkItem' } as never);
    const response = await f.call({ commands: [] });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: reason,
      at: 2,
      kind: 'patchWorkItem',
      ...detail,
    });
  }
  for (const refusal of [
    { reason: 'taken', detail: {} },
    { reason: 'in_use', detail: { usage: { projects: [] } } },
    { reason: 'deadline_before_project_start', detail: { workItemId: 'w' } },
    { reason: 'invented_failure' },
  ]) {
    run.mockResolvedValueOnce({ ok: false, ...refusal, at: 0, kind: 'patchWorkItem' } as never);
    expect((await f.call({ commands: [] })).status).toBe(500);
  }
});

test('mounted command admission rejects structural extras and unknown kind before any transaction', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  for (const command of [
    { kind: 'patchWorkItem', patch: { extra: true } },
    {
      kind: 'setEstimate',
      stepId: 's',
      days: { optimistic: 1, realistic: 2, pessimistic: 3, extra: true },
    },
    {
      kind: 'patchWorkItem',
      patch: { externalRefs: [{ systemId: 'x', url: 'https://example.com', extra: true }] },
    },
    { kind: 'freezeProject', extra: true },
    { kind: 'addDependency', workItemId: 'w', predecesorId: 'w' },
  ]) {
    const response = await f.call({ commands: [command] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
  }
  const unknown = await f.call({ commands: [{ kind: 'invented' }] });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({ error: 'unknown_kind', at: 0 });
  expect(run).not.toHaveBeenCalled();
});

test('mounted parsing preserves priority absence and null while defaulting assignee absence', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  run.mockResolvedValueOnce({
    ok: true,
    results: [],
    undoable: false,
    redoable: false,
  });

  const response = await f.call({
    commands: [
      { kind: 'createWorkItem' },
      { kind: 'createWorkItem', priority: null },
      { kind: 'setAssignee', stepId: 's' },
      { kind: 'setAssignee', stepId: 's', personId: null },
    ],
  });

  expect(response.status).toBe(200);
  // Proof: defaulting an absent create priority to null in the production parser failed this
  // assertion with the first received create command gaining `"priority": null`.
  expect(run).toHaveBeenCalledWith('p', 'owner', [
    { kind: 'createWorkItem', parentId: null, afterId: null },
    { kind: 'createWorkItem', parentId: null, afterId: null, priority: null },
    { kind: 'setAssignee', stepId: 's', personId: null },
    { kind: 'setAssignee', stepId: 's', personId: null },
  ]);
});

test('mounted create without priority uses the project middle-band default', async () => {
  const f = fixture();
  await f.plan.stores.projects.create(projectRow({ id: 'p', ownerId: 'owner' }), [], {
    at: 1,
    by: 'owner',
  });
  await f.plan.stores.priorityBands.replace(
    'p',
    [
      { startsAt: 1, defaultValue: 3, label: 'Now' },
      { startsAt: 6, defaultValue: 8, label: 'Soon' },
      { startsAt: 20, defaultValue: 47, label: 'Ordinary' },
      { startsAt: 60, defaultValue: 70, label: 'Later' },
      { startsAt: 90, defaultValue: 99, label: 'Eventually' },
    ],
    { at: 2, by: 'owner' },
  );

  const response = await f.call({ commands: [{ kind: 'createWorkItem', name: 'Unstated' }] });

  expect(response.status).toBe(200);
  const rows = await f.plan.stores.workItems.listByProject('p');
  expect(rows).toHaveLength(1);
  // Proof: defaulting the normalizer's absent priority to null failed here with Received: null.
  expect(rows[0]?.priority).toBe(47);
});

test('mounted command policies precede body parsing and bodyless undo refuses bytes', async () => {
  const f = fixture();
  const response = await f.app.handle(
    new Request('http://localhost/api/projects/p/commands', {
      method: 'POST',
      headers: {
        cookie: '__Host-wbs_access=x',
        origin: 'https://elsewhere.example',
        'content-type': 'application/json',
      },
      body: '{',
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'invalid_origin' });
  const undo = spyOn(f.runner, 'undo');
  expect((await f.call({}, '/api/projects/p/undo')).status).toBe(400);
  expect(undo).not.toHaveBeenCalled();
});

test('mounted batches parse all commands before the cap and retain directory project_required', async () => {
  const f = fixture();
  const commands = Array.from({ length: 201 }, () => ({ kind: 'freezeProject' }));
  const capped = await f.call({ commands });
  expect(capped.status).toBe(400);
  expect(await capped.json()).toEqual({
    error: 'too_many_commands',
    at: 200,
    kind: 'freezeProject',
  });
  const invalid = await f.call({
    commands: [...commands.slice(0, -1), { kind: 'setActual', stepId: 's', days: -1 }],
  });
  expect(invalid.status).toBe(400);
  // Proof: moving the cap ahead of semantic parsing at the mounted handler failed here with
  // `error: "too_many_commands"` instead of `error: "invalid_actual"` at index 200.
  expect(await invalid.json()).toEqual({ error: 'invalid_actual', at: 200, kind: 'setActual' });
  const directory = await f.call(
    { commands: [{ kind: 'freezeProject' }] },
    '/api/directory/commands',
  );
  expect(directory.status).toBe(400);
  expect(await directory.json()).toEqual({
    error: 'project_required',
    at: 0,
    kind: 'freezeProject',
  });
});

test('mounted tree validates core fields, deadline and slice lateness while preserving account undo flags', async () => {
  const f = fixture();
  await f.plan.stores.projects.create(projectRow({ id: 'p', ownerId: 'owner' }), [], {
    at: 1,
    by: 'owner',
  });
  const created = await f.plan.service.create('p', 'owner', {
    parentId: null,
    afterId: null,
    name: 'Work',
  });
  if (!created.ok) throw new Error('Tree fixture create refused');
  const tree = await f.plan.service.tree('p');
  if (tree === null) throw new Error('Tree fixture missing');
  const row = tree.workItems.at(0);
  if (row === undefined) throw new Error('Tree fixture row missing');
  const slice = {
    ...row.schedule,
    id: 'slice',
    workItemId: row.id,
    stepId: null,
    personId: null,
    boundBy: 'projectStart' as const,
    resourcePredecessorId: null,
    capacityPredecessorIds: [],
    capacityTeamId: null,
    width: 1,
    effort: 1,
    lateBy: null,
  };
  const read = spyOn(f.plan.service, 'tree');
  const path = 'http://localhost/api/projects/p/work-items';
  read.mockResolvedValueOnce({ ...tree, slices: [slice] });
  const accepted = await f.app.handle(new Request(path));
  expect(accepted.status).toBe(200);
  const body: unknown = await accepted.json();
  expect(body).toMatchObject({
    projectRevision: tree.projectRevision,
    undoable: true,
    redoable: false,
    workItems: [{ deadline: null }],
    slices: [{ lateBy: null }],
  });
  const { projectRevision, ...missing } = tree;
  for (const malformed of [
    missing,
    { ...tree, workItems: [{ ...row, deadline: false }] },
    { ...tree, slices: [{ ...slice, lateBy: 'late' }] },
  ]) {
    read.mockResolvedValueOnce(malformed as never);
    expect((await f.app.handle(new Request(path))).status).toBe(500);
  }
});

test('mounted write scope precedes parsing and undeclared query fields remain refused', async () => {
  const f = fixture(true);
  const refused = await f.app.handle(
    new Request('http://localhost/api/projects/p/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  );
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: 'insufficient_scope' });
  const query = await f.app.handle(
    new Request('http://localhost/api/projects/p/work-items?extra=1'),
  );
  expect(query.status).toBe(400);
  expect(await query.json()).toEqual({ error: 'invalid_query' });
});

test('mounted parser refusals reject malformed known context instead of matching a tolerant bare alternative', async () => {
  const f = fixture();
  const reply = spyOn(f.endpoints[1], 'handle');
  for (const body of [
    { error: 'expected_object', at: 'zero' },
    { error: 'unknown_kind', at: 0, kind: 23 },
    { error: 'number_is_derived', kind: 'patchWorkItem' },
  ]) {
    reply.mockResolvedValueOnce({ ok: false, status: 400, body } as never);
    expect((await f.call({ commands: [] })).status).toBe(500);
  }
});

test('mounted create and duplicate results require their minted top-level ids', async () => {
  const f = fixture();
  const run = spyOn(f.runner, 'run');
  for (const produced of [
    { kind: 'createWorkItem' },
    { kind: 'duplicateWorkItem' },
    { kind: 'createTeam', entity: { id: 't', name: 'Team' } },
    { kind: 'createPerson', entity: { id: 'p', name: 'Person', kind: 'person' } },
    { kind: 'createTag', entity: { id: 't', name: 'Tag' } },
    { kind: 'createService', entity: { id: 's', name: 'Service' } },
    { kind: 'createWorkItemType', entity: { id: 't', name: 'Type' } },
  ]) {
    run.mockResolvedValueOnce({
      ok: true,
      results: [{ index: 0, ...produced }],
      undoable: false,
      redoable: false,
    } as never);
    expect((await f.call({ commands: [] })).status).toBe(500);
  }
});
