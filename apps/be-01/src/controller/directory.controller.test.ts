import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ActualRepository } from '../repository/actual';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDatabase, openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleRepository } from '../repository/role';
import { RoleProgressRepository } from '../repository/role-progress';
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
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';

/**
 * The directory routes, over real SQLite.
 *
 * Real for the same reason `role.controller.test.ts` is: every status asserted
 * here is decided by rows — the unique index behind a 409 `taken`, the
 * assignments behind a 409 `in_use` — and a fixture answering them would be a
 * second implementation of the rules under test.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let app: ReturnType<typeof buildApp>;
/** The raw handle, for the one claim that is about a column rather than a row. */
let sqlite: ReturnType<typeof openDatabase>;
let store: DirectoryRepository;
let workItems: WorkItemRepository;
let projects: ProjectRepository;
let roleStore: RoleRepository;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-directory-http-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  sqlite = openDatabase(path);

  projects = new ProjectRepository(db);
  store = new DirectoryRepository(db);
  workItems = new WorkItemRepository(db);
  roleStore = new RoleRepository(db);

  app = buildApp({
    directory: new DirectoryService({ directory: store, broadcast: recordingBroadcaster() }),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
    projects: new ProjectService({ projects }),
    roles: new RoleService({ projects, roles: roleStore, broadcast: recordingBroadcaster() }),
    workItems: new WorkItemService({
      workItems,
      projects,
      estimates: new EstimateRepository(db),
      actuals: new ActualRepository(db),
      progress: new RoleProgressRepository(db),
      dependencies: new DependencyRepository(db),
      directory: store,
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
  token = await register('owner');
});

afterEach(() => {
  sqlite.close();
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
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('token' in body)) {
    throw new Error(`register did not answer with a token: ${JSON.stringify(body)}`);
  }
  const { token: issued } = body;
  if (typeof issued !== 'string') throw new Error('the token was not a string');
  return issued;
}

/** One authenticated request, answered as its status and its parsed body. */
async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  // 204 has no body to parse, and asking for one throws rather than answering
  // null — the delete routes are the ones that answer it.
  if (res.status === 204) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

/** A person by name and teams, through the route that creates them. */
async function addPerson(name: string, teamIds: readonly string[]): Promise<string> {
  const { body } = await call('POST', '/api/people', { name, teamIds });
  const { person } = body as { person: { id: string } };
  return person.id;
}

/** A team by name, through the route that creates them. */
async function addTeam(name: string): Promise<string> {
  const { body } = await call('POST', '/api/teams', { name });
  const { team } = body as { team: { id: string } };
  return team.id;
}

/** {@link addTeam}'s shape for the third dimension — the ownership map needs both. */
async function addService(name: string): Promise<string> {
  const { body } = await call('POST', '/api/services', { name });
  const { service } = body as { service: { id: string } };
  return service.id;
}

describe('GET /api/teams', () => {
  it('answers a team as an id and a name, and never the retired global size', async () => {
    // The one route the retired column could still reach the wire through, and
    // it reached it for as long as `listTeams` was a bare `select()`: drizzle
    // reads every column it knows about, so `service_team.size` travelled into
    // `/api/teams` without the string `serviceTeam.size` appearing anywhere for
    // `verify.md`'s grep to find. `capacity-per-project` D4 keeps the column in
    // the table for the release beside this one; **this release does not read
    // it**, and that claim is only checkable here.
    //
    // The number is written straight into the column first, so this is not
    // vacuous on a table whose sizes are all `NULL` — a `null` field would be
    // dropped by `toEqual` and the shape check below is what catches it either
    // way.
    //
    // Proof: `listTeams`'s projection replaced by the `select()` it used to be,
    // and this failed with `+ "size": 7,` added to the team the body carries —
    // the retired number on the wire, read by nobody and sent to everybody.
    // Three more assertions in this file went red with it, each of them a shape
    // this route answers. Watched 2026-08-13.
    const platform = await addTeam('Platform');
    sqlite.run('UPDATE service_team SET size = 7 WHERE id = ?', [platform]);

    const { status, body } = await call('GET', '/api/teams');

    expect(status).toBe(200);
    expect(body).toEqual({ teams: [{ id: platform, name: 'Platform', serviceIds: [] }] });
    // And by key, because a column added to this table later would arrive here
    // as `null` and `toEqual` says nothing about a field whose value is
    // `undefined` on the side it is compared with. `serviceIds` is on the list
    // deliberately — the ownership map ships whole on this row (D4) — and
    // `size` is still not.
    const teams = (body as { teams: Record<string, unknown>[] }).teams;
    expect(teams.map((each) => Object.keys(each).sort())).toEqual([['id', 'name', 'serviceIds']]);
  });
});

describe('PATCH /api/teams/:id', () => {
  it('renames a team', async () => {
    const platform = await addTeam('Platform');

    const renamed = await call('PATCH', `/api/teams/${platform}`, { name: 'Payments' });

    expect(renamed).toEqual({
      status: 200,
      body: { team: { id: platform, name: 'Payments', serviceIds: [] } },
    });
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Payments', serviceIds: [] }]);
  });

  it('answers 409 taken with the surviving name', async () => {
    await addTeam('Platform');
    const payments = await addTeam('Payments');

    expect(await call('PATCH', `/api/teams/${payments}`, { name: 'Platform' })).toEqual({
      status: 409,
      body: { error: 'taken', name: 'Platform' },
    });
  });

  it('answers 422 for a name of spaces and 404 for a team that is gone', async () => {
    const platform = await addTeam('Platform');

    expect(await call('PATCH', `/api/teams/${platform}`, { name: '   ' })).toEqual({
      status: 422,
      body: { error: 'name_required' },
    });
    expect(await call('PATCH', `/api/teams/${crypto.randomUUID()}`, { name: 'Payments' })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('answers 401 to a request carrying no token', async () => {
    const platform = await addTeam('Platform');
    const res = await app.handle(
      new Request(`http://localhost/api/teams/${platform}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Payments' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });

  it('sets the services a team owns, and answers the team with them', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    const auth = await addService('Auth');

    const owned = await call('PATCH', `/api/teams/${platform}`, {
      serviceIds: [payments, auth],
    });

    expect(owned).toEqual({
      status: 200,
      body: { team: { id: platform, name: 'Platform', serviceIds: [auth, payments].sort() } },
    });
    // Read back through the store rather than trusted from the answer: the
    // route could echo what it was sent and this is the assertion that says the
    // map is in the database.
    const teams = await store.listTeams();
    expect(teams).toEqual([
      { id: platform, name: 'Platform', serviceIds: [auth, payments].sort() },
    ]);
  });

  it('replaces the whole owned set, and an empty array clears it', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    const auth = await addService('Auth');
    await call('PATCH', `/api/teams/${platform}`, { serviceIds: [payments, auth] });

    // Whole-set, not additive: naming one service leaves that one owned and
    // takes the other away. `PersonPatch.teamIds`' rule, one dimension over.
    const narrowed = await call('PATCH', `/api/teams/${platform}`, { serviceIds: [auth] });
    expect(narrowed).toEqual({
      status: 200,
      body: { team: { id: platform, name: 'Platform', serviceIds: [auth] } },
    });

    const cleared = await call('PATCH', `/api/teams/${platform}`, { serviceIds: [] });
    expect(cleared).toEqual({
      status: 200,
      body: { team: { id: platform, name: 'Platform', serviceIds: [] } },
    });
  });

  it('leaves the owned set alone when the patch does not name it', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    await call('PATCH', `/api/teams/${platform}`, { serviceIds: [payments] });

    // Absent and empty are different requests, and only the layers below the
    // wire can tell them apart — a rename that quietly disowned everything is
    // the bug this asserts against.
    const renamed = await call('PATCH', `/api/teams/${platform}`, { name: 'Platform Team' });

    expect(renamed).toEqual({
      status: 200,
      body: { team: { id: platform, name: 'Platform Team', serviceIds: [payments] } },
    });
  });

  it('answers 404 for a service the directory does not hold, rename included', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');

    // `unknown_service`'s status, on the directory's own routes this time — the
    // work item patch answers the same 404 for the same sentence.
    expect(
      await call('PATCH', `/api/teams/${platform}`, {
        name: 'Renamed',
        serviceIds: [payments, crypto.randomUUID()],
      }),
    ).toEqual({ status: 404, body: { error: 'unknown_service' } });

    // The whole patch, not the half of it that could have worked: a refusal
    // that left the rename behind would be a state nothing can see and nobody
    // asked for.
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });

  it('answers 422 to a patch naming neither a name nor services', async () => {
    const platform = await addTeam('Platform');

    // `/people/:id`'s rule: a no-op is almost certainly a client bug, and a 200
    // would leave nothing on the wire to notice it by.
    expect(await call('PATCH', `/api/teams/${platform}`, {})).toEqual({
      status: 422,
      body: { error: 'nothing_to_change' },
    });
  });
});

describe('POST /api/people into teams', () => {
  it('refuses the whole create when a teamId names a team that has been removed', async () => {
    const platform = await addTeam('Platform');
    await call('DELETE', `/api/teams/${platform}`);

    const created = await call('POST', '/api/people', { name: 'Kat', teamIds: [platform] });

    expect(created).toEqual({ status: 404, body: { error: 'unknown_team' } });
    // Atomic: no half-made person, and no membership row pointing at a team
    // that is not there. `person_team.service_team_id` is a foreign key, so
    // without the validation this request is a raw constraint failure — a 500.
    expect(await store.listPeople()).toEqual([]);
  });
});

describe('DELETE /api/people/:id and /api/teams/:id', () => {
  /** A work item to point at the directory with, in a project this account owns. */
  async function planWithOneRow(): Promise<{
    projectOf: string;
    workItemOf: string;
    roleOf: string;
  }> {
    const { body } = await call('POST', '/api/projects', { name: 'Rollout' });
    const { project } = body as { project: { id: string } };
    const created = await call('POST', `/api/projects/${project.id}/work-items`, {
      parentId: null,
      afterId: null,
      name: 'Design',
    });
    const workItem = created.body as { id: string };
    const roles = await roleStore.listByProject(project.id);
    const dev = roles.find((each) => each.name === 'Dev');
    if (dev === undefined) throw new Error('the seeded project had no Dev role');
    return { projectOf: project.id, workItemOf: workItem.id, roleOf: dev.id };
  }

  it('answers 409 in_use carrying the usage, then 204 on the cascade', async () => {
    const kat = await addPerson('Kat', []);
    const { projectOf, workItemOf, roleOf } = await planWithOneRow();
    await call('PUT', `/api/work-items/${workItemOf}/assignees/${roleOf}`, { personId: kat });

    const refused = await call('DELETE', `/api/people/${kat}`);

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'in_use',
      usage: {
        projects: [
          {
            id: projectOf,
            name: 'Rollout',
            workItems: [
              {
                id: workItemOf,
                number: '010',
                name: 'Design',
                effects: [
                  { kind: 'assignment_dropped', role: { id: roleOf, name: 'Dev' } },
                  { kind: 'assumed_assignee_changed', assumedNow: 'Kat', assumedAfter: null },
                ],
              },
            ],
          },
        ],
        members: [],
      },
    });

    expect(await call('DELETE', `/api/people/${kat}?cascade=true`)).toEqual({
      status: 204,
      body: null,
    });
    expect(await store.listPeople()).toEqual([]);
  });

  it('removes an unused team on the first call, and 404s the second', async () => {
    const platform = await addTeam('Platform');

    expect(await call('DELETE', `/api/teams/${platform}`)).toEqual({ status: 204, body: null });
    expect(await call('DELETE', `/api/teams/${platform}`)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('answers 409 in_use for a team held by memberships alone', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);

    expect(await call('DELETE', `/api/teams/${platform}`)).toEqual({
      status: 409,
      body: { error: 'in_use', usage: { projects: [], members: [{ id: kat, name: 'Kat' }] } },
    });
  });

  it('answers 401 to a delete carrying no token', async () => {
    const platform = await addTeam('Platform');
    const res = await app.handle(
      new Request(`http://localhost/api/teams/${platform}`, { method: 'DELETE' }),
    );

    expect(res.status).toBe(401);
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });
});

describe('PATCH /api/people/:id', () => {
  it('renames and re-teams a person in one request', async () => {
    const platform = await addTeam('Platform');
    const payments = await addTeam('Payments');
    const kat = await addPerson('Kat', [platform]);

    const patched = await call('PATCH', `/api/people/${kat}`, {
      name: 'Katrin',
      teamIds: [payments],
    });

    expect(patched).toEqual({
      status: 200,
      body: { person: { id: kat, name: 'Katrin', teamIds: [payments] } },
    });
  });

  it('answers 404 unknown_team for a dead team id, and writes nothing', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);

    expect(
      await call('PATCH', `/api/people/${kat}`, {
        name: 'Katrin',
        teamIds: [crypto.randomUUID()],
      }),
    ).toEqual({ status: 404, body: { error: 'unknown_team' } });
    expect(await store.listPeople()).toEqual([{ id: kat, name: 'Kat', teamIds: [platform] }]);
  });

  it('answers 422 to a patch that names nothing to change', async () => {
    const kat = await addPerson('Kat', []);

    expect(await call('PATCH', `/api/people/${kat}`, {})).toEqual({
      status: 422,
      body: { error: 'nothing_to_change' },
    });
  });

  it('answers 409 taken with the surviving name', async () => {
    await addPerson('Kat', []);
    const strip = await addPerson('Strip', []);

    expect(await call('PATCH', `/api/people/${strip}`, { name: 'Kat' })).toEqual({
      status: 409,
      body: { error: 'taken', name: 'Kat' },
    });
  });

  it('answers 401 to a request carrying no token', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);
    const res = await app.handle(
      new Request(`http://localhost/api/people/${kat}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Katrin' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await store.listPeople()).toEqual([{ id: kat, name: 'Kat', teamIds: [platform] }]);
  });
});

describe('the service routes', () => {
  /** A service by name, through the route that creates them. */
  async function addService(name: string): Promise<string> {
    const { body } = await call('POST', '/api/services', { name });
    const { service } = body as { service: { id: string } };
    return service.id;
  }

  it('creates, lists by name, and renames', async () => {
    const payments = await addService('Payments');
    // Idempotent by name at the unique index, as the teams and the tags are:
    // two people typing `Payments` at once both pass a check-then-insert.
    expect(await addService('  Payments  ')).toBe(payments);
    const auth = await addService('Auth');

    // By name, not by insertion order — the picker reads them in this order.
    expect(await call('GET', '/api/services')).toEqual({
      status: 200,
      body: {
        services: [
          { id: auth, name: 'Auth' },
          { id: payments, name: 'Payments' },
        ],
      },
    });

    expect(await call('PATCH', `/api/services/${payments}`, { name: 'Billing' })).toEqual({
      status: 200,
      body: { service: { id: payments, name: 'Billing' } },
    });
  });

  it('answers 409 taken with the surviving name, 422 for spaces, 404 for a dead id', async () => {
    const payments = await addService('Payments');
    const auth = await addService('Auth');

    // The surviving name, for `/teams/:id`'s reason: the caller has to be able
    // to say which `Payments` is on screen now.
    expect(await call('PATCH', `/api/services/${auth}`, { name: 'Payments' })).toEqual({
      status: 409,
      body: { error: 'taken', name: 'Payments' },
    });
    expect(await call('PATCH', `/api/services/${auth}`, { name: '   ' })).toEqual({
      status: 422,
      body: { error: 'name_required' },
    });
    expect(
      await call('PATCH', `/api/services/${crypto.randomUUID()}`, { name: 'Billing' }),
    ).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await call('POST', '/api/services', { name: ' ' })).toEqual({
      status: 422,
      body: { error: 'name_required' },
    });

    // Nothing above wrote: both rows are as they were created.
    expect(await store.listServices()).toEqual([
      { id: auth, name: 'Auth' },
      { id: payments, name: 'Payments' },
    ]);
  });

  it('answers 409 in_use naming the row that loses its label, then 204 on the cascade', async () => {
    const payments = await addService('Payments');
    const { body } = await call('POST', '/api/projects', { name: 'Rollout' });
    const { project } = body as { project: { id: string } };
    const created = await call('POST', `/api/projects/${project.id}/work-items`, {
      parentId: null,
      afterId: null,
      name: 'Design',
    });
    const { id: workItemOf } = created.body as { id: string };
    await call('PATCH', `/api/work-items/${workItemOf}`, { serviceIds: [payments] });

    const refused = await call('DELETE', `/api/services/${payments}`);

    // `label_removed` and **nothing beside it**. This assertion is design.md D7
    // written as a payload: no `capacity_released`, no size, no second effect of
    // any kind, and no mention of the ownership rows a cascade would also take.
    //
    // `label_removed` and not `label_nulled` since task 10.2 (10.5): the store is
    // a join table, so a member goes rather than a column being nulled, and the
    // word a client branches on had to move with the mechanism.
    expect(refused).toEqual({
      status: 409,
      body: {
        error: 'in_use',
        usage: {
          projects: [
            {
              id: project.id,
              name: 'Rollout',
              workItems: [
                {
                  id: workItemOf,
                  number: '010',
                  name: 'Design',
                  effects: [{ kind: 'label_removed' }],
                },
              ],
            },
          ],
          members: [],
        },
      },
    });

    expect(await call('DELETE', `/api/services/${payments}?cascade=true`)).toEqual({
      status: 204,
      body: null,
    });
    expect(await store.listServices()).toEqual([]);

    // The work item is **still there**, unlabelled — `ON DELETE SET NULL`, seen
    // from the route. A cascade that had taken the row with the label would
    // have deleted somebody's plan to tidy a picker.
    const tree = await call('GET', `/api/projects/${project.id}/work-items`);
    const { workItems } = tree.body as { workItems: { id: string; serviceId: string | null }[] };
    expect(workItems).toMatchObject([{ id: workItemOf, serviceId: null }]);
  });

  it('removes an unused service on the first press, and 404s the second', async () => {
    // One clause fewer than a team's refusal and one fewer than a tag's: nobody
    // belongs to a service, and the teams that own it are not counted either.
    const payments = await addService('Payments');

    expect(await call('DELETE', `/api/services/${payments}`)).toEqual({ status: 204, body: null });
    expect(await call('DELETE', `/api/services/${payments}`)).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('answers 401 to every service route carrying no token', async () => {
    const payments = await addService('Payments');
    const unauthenticated = async (method: string, path: string, body?: unknown) =>
      (
        await app.handle(
          new Request(`http://localhost${path}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          }),
        )
      ).status;

    expect([
      await unauthenticated('GET', '/api/services'),
      await unauthenticated('POST', '/api/services', { name: 'Auth' }),
      await unauthenticated('PATCH', `/api/services/${payments}`, { name: 'Billing' }),
      await unauthenticated('DELETE', `/api/services/${payments}`),
    ]).toEqual([401, 401, 401, 401]);
    expect(await store.listServices()).toEqual([{ id: payments, name: 'Payments' }]);
  });
});
