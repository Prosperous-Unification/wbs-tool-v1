import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleRepository } from '../repository/role';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { DirectoryService } from '../service/directory.service';
import { ProjectService } from '../service/project.service';
import { RoleService } from '../service/role.service';
import { WorkItemService } from '../service/work-item.service';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { personAdded } from '../testing/directory-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';

/**
 * The role routes, over real SQLite.
 *
 * Real for the same reason `undo.controller.test.ts` is: every status this file
 * asserts is decided by rows — the unique index behind a 409 `taken`, the
 * estimates behind a 409 `in_use` — and a fixture answering them would be a
 * second implementation of the rules under test.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let app: ReturnType<typeof buildApp>;
let roleStore: RoleRepository;
let estimates: EstimateRepository;
let directory: DirectoryRepository;
let workItems: WorkItemRepository;
let projects: ProjectRepository;

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-role-http-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);

  projects = new ProjectRepository(db);
  roleStore = new RoleRepository(db);
  estimates = new EstimateRepository(db);
  directory = new DirectoryRepository(db);
  workItems = new WorkItemRepository(db);

  app = buildApp({
    directory: new DirectoryService({ directory, broadcast: recordingBroadcaster() }),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
    projects: new ProjectService({ projects }),
    roles: new RoleService({ projects, roles: roleStore, broadcast: recordingBroadcaster() }),
    workItems: new WorkItemService({
      workItems,
      projects,
      estimates,
      dependencies: new DependencyRepository(db),
      directory,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      subtrees: new SubtreeRepository(db),
      journal: new CommandJournalRepository(db),
      broadcast: recordingBroadcaster(),
    }),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    migrationsApplied: true,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function register(username: string): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct-horse' }),
    }),
  );
  const body = (await res.json()) as { token: string };
  return body.token;
}

function send(
  path: string,
  token: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-wbs-token': token },
    }),
  );
}

async function newProject(token: string): Promise<{ id: string; devId: string; qaId: string }> {
  const res = await send('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Rewire the shed' }),
  });
  const body = (await res.json()) as {
    project: { id: string };
    roles: { id: string; name: string }[];
  };
  const dev = body.roles.find((each) => each.name === 'Dev');
  const qa = body.roles.find((each) => each.name === 'QA');
  if (dev === undefined || qa === undefined) throw new Error('a project without its seed roles');
  return { id: body.project.id, devId: dev.id, qaId: qa.id };
}

const addRole = (projectId: string, token: string, name: string): Promise<Response> =>
  send(`/api/projects/${projectId}/roles`, token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

describe('POST /api/projects/:id/roles', () => {
  it('adds a role and answers with it', async () => {
    const token = await register('owner');
    const project = await newProject(token);

    const res = await addRole(project.id, token, 'Design');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: { id: string; projectId: string; name: string } };
    expect(body.role.name).toBe('Design');
    expect(body.role.projectId).toBe(project.id);
    expect(await roleStore.findById(body.role.id)).toEqual(body.role);
    expect(await roleStore.listByProject(project.id)).toHaveLength(3);
  });

  it('answers 409 taken for a name the project already holds', async () => {
    const token = await register('owner');
    const project = await newProject(token);

    const res = await addRole(project.id, token, 'QA');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'taken' });
  });

  it('answers 422 for a name of spaces, 404 for a project that is not there, 401 unauthenticated', async () => {
    const token = await register('owner');
    const project = await newProject(token);

    expect((await addRole(project.id, token, '   ')).status).toBe(422);
    expect((await addRole(crypto.randomUUID(), token, 'Design')).status).toBe(404);
    expect((await addRole(project.id, 'not-a-token', 'Design')).status).toBe(401);
  });

  it('answers 403 on a restricted project the caller does not own', async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const project = await newProject(owner);
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await addRole(project.id, stranger, 'Design');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});

describe('PATCH /api/projects/:id/roles/:roleId', () => {
  it('renames a role', async () => {
    const token = await register('owner');
    const project = await newProject(token);

    const res = await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Review' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: { id: project.qaId, projectId: project.id, name: 'Review', position: 20 },
    });
  });

  it('answers 409 taken, and 404 for a role of another project', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    const other = await newProject(token);

    const taken = await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Dev' }),
    });
    expect(taken.status).toBe(409);

    const elsewhere = await send(`/api/projects/${project.id}/roles/${other.qaId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Review' }),
    });
    expect(elsewhere.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id/roles/:roleId', () => {
  const item = (projectId: string, id: string, position: number) => ({
    id,
    projectId,
    parentId: null,
    position,
    name: 'Strip',
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    serviceTeamId: null,
    maxParallel: 1,
    revision: 0,
  });

  it('removes a role nothing points at, answering 204', async () => {
    const token = await register('owner');
    const project = await newProject(token);

    const res = await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(await roleStore.findById(project.qaId)).toBeNull();
  });

  it('refuses with 409 and the counts, then removes on the cascade', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    await workItems.insert(item(project.id, 'strip', 10), []);
    await estimates.set({ workItemId: 'strip', roleId: project.qaId, ...DAYS });
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, []),
    );
    await directory.assign('strip', project.qaId, ada.id);

    const refused = await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, {
      method: 'DELETE',
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'in_use',
      inUse: {
        estimates: 1,
        assignments: 1,
        assumedAssignees: [{ workItemId: 'strip', assumedNow: ada.id, assumedAfter: null }],
      },
    });
    expect(await roleStore.findById(project.qaId)).not.toBeNull();

    const confirmed = await send(
      `/api/projects/${project.id}/roles/${project.qaId}?cascade=true`,
      token,
      { method: 'DELETE' },
    );

    expect(confirmed.status).toBe(204);
    expect(await roleStore.findById(project.qaId)).toBeNull();
    expect(await estimates.listByProject(project.id)).toEqual([]);
    // The project moved once for the removal, on top of the seed's zero.
    const after = await projects.findById(project.id);
    expect(after?.revision).toBe(1);
  });

  it('answers 404 for a role that is not there and 403 on a project the caller may not write to', async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const project = await newProject(owner);
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const missing = await send(
      `/api/projects/${project.id}/roles/${crypto.randomUUID()}?cascade=true`,
      owner,
      { method: 'DELETE' },
    );
    expect(missing.status).toBe(404);

    const theirs = await send(
      `/api/projects/${project.id}/roles/${project.qaId}?cascade=true`,
      stranger,
      { method: 'DELETE' },
    );
    expect(theirs.status).toBe(403);
    expect(await roleStore.findById(project.qaId)).not.toBeNull();
  });

  it('appends nothing to the account’s undo stack', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    const created = await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const strip = (await created.json()) as { id: string };
    await send(`/api/work-items/${strip.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip the paint' }),
    });

    await addRole(project.id, token, 'Design');
    await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, { method: 'DELETE' });

    // The role changes are not on the stack, so the key still reaches the
    // rename — as the project's start date behaves, and for the same reason:
    // there is no compensating command for a role that took estimates with it.
    const undone = await send(`/api/projects/${project.id}/undo`, token, { method: 'POST' });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { done: string }).done).toContain('rename');
  });

  it('leaves an undo whose role has gone refusing as stale, not writing', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    const created = await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const strip = (await created.json()) as { id: string };
    await send(`/api/work-items/${strip.id}/estimates/${project.qaId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });
    // Cleared, so the entry on top of the stack is one whose *inverse writes*:
    // undoing it puts the trio back. That is the entry that would reach for a
    // role that is not there.
    await send(`/api/work-items/${strip.id}/estimates/${project.qaId}`, token, {
      method: 'DELETE',
    });

    await send(`/api/projects/${project.id}/roles/${project.qaId}?cascade=true`, token, {
      method: 'DELETE',
    });

    // The removal moved the work item's revision, so the entry's precondition
    // no longer holds. Without that bump this undo would try to write a trio
    // for a role that is not there — a foreign key error, a 500, on a key
    // somebody pressed to be safe.
    const undone = await send(`/api/projects/${project.id}/undo`, token, { method: 'POST' });
    expect(undone.status).toBe(409);
    expect(await undone.json()).toMatchObject({ error: 'stale_undo' });
    expect(await estimates.listByProject(project.id)).toEqual([]);
  });

  it('refuses an estimate and an assignee for a role that has gone, rather than 500ing', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    const created = await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const strip = (await created.json()) as { id: string };
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, []),
    );
    await send(`/api/projects/${project.id}/roles/${project.qaId}`, token, { method: 'DELETE' });

    // A tab that was open when somebody else removed the phase. Both of these
    // used to reach the foreign key and answer 500 — the request is about a
    // role that is not in the project, which is the caller's world being out
    // of date rather than this process being broken.
    const estimated = await send(`/api/work-items/${strip.id}/estimates/${project.qaId}`, token, {
      method: 'PUT',
      body: JSON.stringify(DAYS),
    });
    expect(estimated.status).toBe(404);
    expect(await estimated.json()).toEqual({ error: 'unknown_role' });

    const assigned = await send(`/api/work-items/${strip.id}/assignees/${project.qaId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ personId: ada.id }),
    });
    expect(assigned.status).toBe(404);
    expect(await assigned.json()).toEqual({ error: 'unknown_role' });
  });

  it('takes estimates for a role added after the project was made', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    const added = await addRole(project.id, token, 'Design');
    const design = (await added.json()) as { role: { id: string } };
    const created = await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const strip = (await created.json()) as { id: string };

    const estimated = await send(`/api/work-items/${strip.id}/estimates/${design.role.id}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });

    expect(estimated.status).toBe(200);
    const tree = await send(`/api/projects/${project.id}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { estimates: Record<string, unknown> }[];
    };
    // `STARTING_ROLES` is the seed and not the set: the third role holds
    // estimates the tree reports beside the two the project was made with.
    expect(body.workItems[0]?.estimates).toHaveProperty(design.role.id);
  });

  it('takes the cascade only when it is asked for by name', async () => {
    const token = await register('owner');
    const project = await newProject(token);
    await workItems.insert(item(project.id, 'strip', 10), []);
    await estimates.set({ workItemId: 'strip', roleId: project.qaId, ...DAYS });

    // Anything other than `true` is not a confirmation. A truthy-looking value
    // taken as consent is how a role goes with its estimates on a request
    // nobody meant as the second one.
    const res = await send(`/api/projects/${project.id}/roles/${project.qaId}?cascade=1`, token, {
      method: 'DELETE',
    });

    expect(res.status).toBe(409);
    expect(await roleStore.findById(project.qaId)).not.toBeNull();
  });
});
