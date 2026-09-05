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
import { StepRepository } from '../repository/step';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { DirectoryService } from '../service/directory.service';
import { ProjectService } from '../service/project.service';
import { StepService } from '../service/step.service';
import { WorkItemService } from '../service/work-item.service';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { testCalendarMarkerService } from '../testing/calendar-marker-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testWrites } from '../testing/writes-fixture';

/**
 * The directory commands, over real SQLite.
 *
 * Real for the same reason `step.controller.test.ts` is: every status asserted
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
let stepStore: StepRepository;
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
  stepStore = new StepRepository(db);

  app = buildApp({
    savedPlans: testSavedPlanService(),
    directory: new DirectoryService({ directory: store, broadcast: recordingBroadcaster() }),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
    projects: new ProjectService({ projects, broadcast: recordingBroadcaster() }),
    steps: new StepService({ projects, steps: stepStore, broadcast: recordingBroadcaster() }),
    workItems: new WorkItemService({
      workItems,
      projects,
      estimates: new EstimateRepository(db),
      actuals: new ActualRepository(db),
      measures: new StepMeasureRepository(db),
      progress: new StepProgressRepository(db),
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
    writes: testWrites(),
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
  // null.
  if (res.status === 204) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

/** One directory batch of a single command, answered as its status and parsed body. */
function command(step: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return call('POST', '/api/directory/commands', { commands: [step] });
}

/** One plan batch of a single command, on the project it names. */
function planCommand(
  projectId: string,
  step: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return call('POST', `/api/projects/${projectId}/commands`, { commands: [step] });
}

/** The id a single create answered with; throws on anything but an applied batch. */
function createdId(answer: { status: number; body: unknown }): string {
  if (answer.status !== 200) {
    throw new Error(`the create was refused: ${JSON.stringify(answer)}`);
  }
  const { results } = answer.body as { results: { id?: string }[] };
  const only = results.at(0);
  if (only?.id === undefined) throw new Error(`the create minted no id: ${JSON.stringify(answer)}`);
  return only.id;
}

/** A person by name and teams, through the command that creates them. */
async function addPerson(name: string, teamIds: readonly string[]): Promise<string> {
  return createdId(await command({ kind: 'createPerson', name, teamIds }));
}

/** A team by name, through the command that creates them. */
async function addTeam(name: string): Promise<string> {
  return createdId(await command({ kind: 'createTeam', name }));
}

/** {@link addTeam}'s shape for the third dimension — the ownership map needs both. */
async function addService(name: string): Promise<string> {
  return createdId(await command({ kind: 'createService', name }));
}

/** What an applied single-command patch answers: its one result, carrying the entry as patched. */
const applied = (entity: unknown) => ({ status: 200, body: { results: [{ index: 0, entity }] } });

/** What an applied single-command removal answers: its one result, and nothing beside the index. */
const removed = { status: 200, body: { results: [{ index: 0 }] } };

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

describe('patchTeam', () => {
  it('renames a team', async () => {
    const platform = await addTeam('Platform');

    const renamed = await command({
      kind: 'patchTeam',
      teamId: platform,
      patch: { name: 'Payments' },
    });

    expect(renamed).toEqual(applied({ id: platform, name: 'Payments', serviceIds: [] }));
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Payments', serviceIds: [] }]);
  });

  it('answers 409 taken with the surviving name', async () => {
    await addTeam('Platform');
    const payments = await addTeam('Payments');

    expect(
      await command({ kind: 'patchTeam', teamId: payments, patch: { name: 'Platform' } }),
    ).toEqual({
      status: 409,
      body: { error: 'taken', name: 'Platform', at: 0, kind: 'patchTeam' },
    });
  });

  it('answers 400 name_required for a name of spaces and 404 for a team that is gone', async () => {
    const platform = await addTeam('Platform');

    expect(await command({ kind: 'patchTeam', teamId: platform, patch: { name: '   ' } })).toEqual({
      status: 400,
      body: { error: 'name_required', at: 0, kind: 'patchTeam' },
    });
    expect(
      await command({
        kind: 'patchTeam',
        teamId: crypto.randomUUID(),
        patch: { name: 'Payments' },
      }),
    ).toEqual({
      status: 404,
      body: { error: 'not_found', at: 0, kind: 'patchTeam' },
    });
  });

  it('answers 401 to a request carrying no token', async () => {
    const platform = await addTeam('Platform');
    const res = await app.handle(
      new Request('http://localhost/api/directory/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [{ kind: 'patchTeam', teamId: platform, patch: { name: 'Payments' } }],
        }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });

  it('sets the services a team owns, and answers the team with them', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    const auth = await addService('Auth');

    const owned = await command({
      kind: 'patchTeam',
      teamId: platform,
      patch: { serviceIds: [payments, auth] },
    });

    expect(owned).toEqual(
      applied({ id: platform, name: 'Platform', serviceIds: [auth, payments].sort() }),
    );
    // Read back through the store rather than trusted from the answer: the
    // command could echo what it was sent and this is the assertion that says
    // the map is in the database.
    const teams = await store.listTeams();
    expect(teams).toEqual([
      { id: platform, name: 'Platform', serviceIds: [auth, payments].sort() },
    ]);
  });

  it('replaces the whole owned set, and an empty array clears it', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    const auth = await addService('Auth');
    await command({ kind: 'patchTeam', teamId: platform, patch: { serviceIds: [payments, auth] } });

    // Whole-set, not additive: naming one service leaves that one owned and
    // takes the other away. `PersonPatch.teamIds`' rule, one dimension over.
    const narrowed = await command({
      kind: 'patchTeam',
      teamId: platform,
      patch: { serviceIds: [auth] },
    });
    expect(narrowed).toEqual(applied({ id: platform, name: 'Platform', serviceIds: [auth] }));

    const cleared = await command({
      kind: 'patchTeam',
      teamId: platform,
      patch: { serviceIds: [] },
    });
    expect(cleared).toEqual(applied({ id: platform, name: 'Platform', serviceIds: [] }));
  });

  it('leaves the owned set alone when the patch does not name it', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');
    await command({ kind: 'patchTeam', teamId: platform, patch: { serviceIds: [payments] } });

    // Absent and empty are different requests, and only the layers below the
    // wire can tell them apart — a rename that quietly disowned everything is
    // the bug this asserts against.
    const renamed = await command({
      kind: 'patchTeam',
      teamId: platform,
      patch: { name: 'Platform Team' },
    });

    expect(renamed).toEqual(
      applied({ id: platform, name: 'Platform Team', serviceIds: [payments] }),
    );
  });

  it('answers 404 for a service the directory does not hold, rename included', async () => {
    const platform = await addTeam('Platform');
    const payments = await addService('Payments');

    // `unknown_service`'s status, on the directory's own command this time —
    // the work item patch answers the same 404 for the same sentence.
    expect(
      await command({
        kind: 'patchTeam',
        teamId: platform,
        patch: { name: 'Renamed', serviceIds: [payments, crypto.randomUUID()] },
      }),
    ).toEqual({ status: 404, body: { error: 'unknown_service', at: 0, kind: 'patchTeam' } });

    // The whole patch, not the half of it that could have worked: a refusal
    // that left the rename behind would be a state nothing can see and nobody
    // asked for.
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });

  it('answers 400 nothing_to_change to a patch naming neither a name nor services', async () => {
    const platform = await addTeam('Platform');

    // `patchPerson`'s rule: a no-op is almost certainly a client bug, and a
    // 200 would leave nothing on the wire to notice it by.
    expect(await command({ kind: 'patchTeam', teamId: platform, patch: {} })).toEqual({
      status: 400,
      body: { error: 'nothing_to_change', at: 0, kind: 'patchTeam' },
    });
  });
});

describe('createPerson into teams', () => {
  it('refuses the whole create when a teamId names a team that has been removed', async () => {
    const platform = await addTeam('Platform');
    await command({ kind: 'deleteTeam', teamId: platform });

    const created = await command({ kind: 'createPerson', name: 'Kat', teamIds: [platform] });

    expect(created).toEqual({
      status: 404,
      body: { error: 'unknown_team', at: 0, kind: 'createPerson' },
    });
    // Atomic: no half-made person, and no membership row pointing at a team
    // that is not there. `person_team.service_team_id` is a foreign key, so
    // without the validation this request is a raw constraint failure — a 500.
    expect(await store.listPeople()).toEqual([]);
  });

  it('answers a kind for a person nobody has patched, on the create and on the list', async () => {
    // The read half of `kind`: 4.4 proved a `patchPerson` can set it, and this
    // proves a client never has to patch to *see* one. Both the create's own
    // answer and the list, because the batch answers the row it wrote while
    // `GET` re-reads — a default that only appeared on one of them would send
    // a client's `?? 'person'` fallback back into the fe.
    const created = await command({ kind: 'createPerson', name: 'Kat', teamIds: [] });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      results: [{ index: 0, entity: { name: 'Kat', kind: 'person' } }],
    });

    const listed = await call('GET', '/api/people');

    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ people: [{ name: 'Kat', kind: 'person' }] });
  });
});

describe('deletePerson and deleteTeam', () => {
  /** A work item to point at the directory with, in a project this account owns. */
  async function planWithOneRow(): Promise<{
    projectOf: string;
    workItemOf: string;
    stepOf: string;
  }> {
    const { body } = await call('POST', '/api/projects', { name: 'Rollout' });
    const { project } = body as { project: { id: string } };
    const workItemOf = createdId(
      await planCommand(project.id, {
        kind: 'createWorkItem',
        parentId: null,
        afterId: null,
        name: 'Design',
      }),
    );
    const steps = await stepStore.listByProject(project.id);
    const dev = steps.find((each) => each.name === 'Dev');
    if (dev === undefined) throw new Error('the seeded project had no Dev step');
    return { projectOf: project.id, workItemOf, stepOf: dev.id };
  }

  it('answers 409 in_use carrying the usage, then 200 on the cascade', async () => {
    const kat = await addPerson('Kat', []);
    const { projectOf, workItemOf, stepOf } = await planWithOneRow();
    const assigned = await planCommand(projectOf, {
      kind: 'setAssignee',
      workItemId: workItemOf,
      stepId: stepOf,
      personId: kat,
    });
    expect(assigned.status).toBe(200);

    const refused = await command({ kind: 'deletePerson', personId: kat });

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'in_use',
      at: 0,
      kind: 'deletePerson',
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
                  { kind: 'assignment_dropped', step: { id: stepOf, name: 'Dev' } },
                  { kind: 'assumed_assignee_changed', assumedNow: 'Kat', assumedAfter: null },
                ],
              },
            ],
          },
        ],
        members: [],
      },
    });

    expect(await command({ kind: 'deletePerson', personId: kat, cascade: true })).toEqual(removed);
    expect(await store.listPeople()).toEqual([]);
  });

  it('removes an unused team on the first call, and 404s the second', async () => {
    const platform = await addTeam('Platform');

    expect(await command({ kind: 'deleteTeam', teamId: platform })).toEqual(removed);
    expect(await command({ kind: 'deleteTeam', teamId: platform })).toEqual({
      status: 404,
      body: { error: 'not_found', at: 0, kind: 'deleteTeam' },
    });
  });

  it('answers 409 in_use for a team held by memberships alone', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);

    expect(await command({ kind: 'deleteTeam', teamId: platform })).toEqual({
      status: 409,
      body: {
        error: 'in_use',
        at: 0,
        kind: 'deleteTeam',
        usage: { projects: [], members: [{ id: kat, name: 'Kat' }] },
      },
    });
  });

  it('answers 401 to a delete carrying no token', async () => {
    const platform = await addTeam('Platform');
    const res = await app.handle(
      new Request('http://localhost/api/directory/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: [{ kind: 'deleteTeam', teamId: platform }] }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await store.listTeams()).toEqual([{ id: platform, name: 'Platform', serviceIds: [] }]);
  });
});

describe('patchPerson', () => {
  it('renames and re-teams a person in one request', async () => {
    const platform = await addTeam('Platform');
    const payments = await addTeam('Payments');
    const kat = await addPerson('Kat', [platform]);

    const patched = await command({
      kind: 'patchPerson',
      personId: kat,
      patch: { name: 'Katrin', teamIds: [payments] },
    });

    expect(patched).toEqual(
      applied({ id: kat, name: 'Katrin', kind: 'person', teamIds: [payments] }),
    );
  });

  it('answers 404 unknown_team for a dead team id, and writes nothing', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);

    expect(
      await command({
        kind: 'patchPerson',
        personId: kat,
        patch: { name: 'Katrin', teamIds: [crypto.randomUUID()] },
      }),
    ).toEqual({ status: 404, body: { error: 'unknown_team', at: 0, kind: 'patchPerson' } });
    expect(await store.listPeople()).toEqual([
      { id: kat, name: 'Kat', kind: 'person', teamIds: [platform] },
    ]);
  });

  it('answers 400 nothing_to_change to a patch that names nothing to change', async () => {
    const kat = await addPerson('Kat', []);

    expect(await command({ kind: 'patchPerson', personId: kat, patch: {} })).toEqual({
      status: 400,
      body: { error: 'nothing_to_change', at: 0, kind: 'patchPerson' },
    });
  });

  it('marks a person an agent, and marks them back', async () => {
    const kat = await addPerson('Kat', []);

    expect(await command({ kind: 'patchPerson', personId: kat, patch: { kind: 'agent' } })).toEqual(
      applied({ id: kat, name: 'Kat', kind: 'agent', teamIds: [] }),
    );
    // Patching it back is the whole undo — the directory journals nothing, and
    // `plan_event` is a plan's history, so it cannot hold this. tasks.md 4.4.
    expect(
      await command({ kind: 'patchPerson', personId: kat, patch: { kind: 'person' } }),
    ).toEqual(applied({ id: kat, name: 'Kat', kind: 'person', teamIds: [] }));
  });

  it('answers 400 invalid_kind for a kind outside the set, rename included', async () => {
    // The refusal is only reachable because the command parser takes the
    // patch's `kind` as any text: a union of the two kinds at the parser would
    // refuse first, with its own code, and `invalid_kind` would never be sent
    // by the API that exists to send it. The name beside it proves the check
    // runs before the write rather than after.
    const kat = await addPerson('Kat', []);

    expect(
      await command({
        kind: 'patchPerson',
        personId: kat,
        patch: { name: 'Katrin', kind: 'robot' },
      }),
    ).toEqual({
      status: 400,
      body: { error: 'invalid_kind', at: 0, kind: 'patchPerson' },
    });
    expect(await store.listPeople()).toEqual([
      { id: kat, name: 'Kat', kind: 'person', teamIds: [] },
    ]);
  });

  it('answers 409 taken with the surviving name', async () => {
    await addPerson('Kat', []);
    const strip = await addPerson('Strip', []);

    expect(await command({ kind: 'patchPerson', personId: strip, patch: { name: 'Kat' } })).toEqual(
      {
        status: 409,
        body: { error: 'taken', name: 'Kat', at: 0, kind: 'patchPerson' },
      },
    );
  });

  it('answers 401 to a request carrying no token', async () => {
    const platform = await addTeam('Platform');
    const kat = await addPerson('Kat', [platform]);
    const res = await app.handle(
      new Request('http://localhost/api/directory/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [{ kind: 'patchPerson', personId: kat, patch: { name: 'Katrin' } }],
        }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await store.listPeople()).toEqual([
      { id: kat, name: 'Kat', kind: 'person', teamIds: [platform] },
    ]);
  });
});

describe('the service commands', () => {
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

    expect(await command({ kind: 'patchService', serviceId: payments, name: 'Billing' })).toEqual(
      applied({ id: payments, name: 'Billing' }),
    );
  });

  it('answers 409 taken with the surviving name, 400 for spaces, 404 for a dead id', async () => {
    const payments = await addService('Payments');
    const auth = await addService('Auth');

    // The surviving name, for `patchTeam`'s reason: the caller has to be able
    // to say which `Payments` is on screen now.
    expect(await command({ kind: 'patchService', serviceId: auth, name: 'Payments' })).toEqual({
      status: 409,
      body: { error: 'taken', name: 'Payments', at: 0, kind: 'patchService' },
    });
    expect(await command({ kind: 'patchService', serviceId: auth, name: '   ' })).toEqual({
      status: 400,
      body: { error: 'name_required', at: 0, kind: 'patchService' },
    });
    expect(
      await command({ kind: 'patchService', serviceId: crypto.randomUUID(), name: 'Billing' }),
    ).toEqual({ status: 404, body: { error: 'not_found', at: 0, kind: 'patchService' } });
    // A create of spaces is refused as `name_required`, the code the directory's
    // own refusals use: `addService` answers null for a blank name, and the
    // batch names the index rather than minting an unnamed row.
    expect(await command({ kind: 'createService', name: ' ' })).toEqual({
      status: 400,
      body: { error: 'name_required', at: 0, kind: 'createService' },
    });

    // Nothing above wrote: both rows are as they were created.
    expect(await store.listServices()).toEqual([
      { id: auth, name: 'Auth' },
      { id: payments, name: 'Payments' },
    ]);
  });

  it('answers 409 in_use naming the row that loses its label, then 200 on the cascade', async () => {
    const payments = await addService('Payments');
    const { body } = await call('POST', '/api/projects', { name: 'Rollout' });
    const { project } = body as { project: { id: string } };
    const workItemOf = createdId(
      await planCommand(project.id, {
        kind: 'createWorkItem',
        parentId: null,
        afterId: null,
        name: 'Design',
      }),
    );
    const labelled = await planCommand(project.id, {
      kind: 'patchWorkItem',
      workItemId: workItemOf,
      patch: { serviceIds: [payments] },
    });
    expect(labelled.status).toBe(200);

    const refused = await command({ kind: 'deleteService', serviceId: payments });

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
        at: 0,
        kind: 'deleteService',
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

    expect(await command({ kind: 'deleteService', serviceId: payments, cascade: true })).toEqual(
      removed,
    );
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

    expect(await command({ kind: 'deleteService', serviceId: payments })).toEqual(removed);
    expect(await command({ kind: 'deleteService', serviceId: payments })).toEqual({
      status: 404,
      body: { error: 'not_found', at: 0, kind: 'deleteService' },
    });
  });

  it('answers 401 to every service command carrying no token', async () => {
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
    const batch = (step: Record<string, unknown>) =>
      unauthenticated('POST', '/api/directory/commands', { commands: [step] });

    expect([
      await unauthenticated('GET', '/api/services'),
      await batch({ kind: 'createService', name: 'Auth' }),
      await batch({ kind: 'patchService', serviceId: payments, name: 'Billing' }),
      await batch({ kind: 'deleteService', serviceId: payments }),
    ]).toEqual([401, 401, 401, 401]);
    expect(await store.listServices()).toEqual([{ id: payments, name: 'Payments' }]);
  });
});

describe('the six directory reads', () => {
  /**
   * Every one of them refuses a request with no token.
   *
   * This gap was found by injecting the fault, not by reading: on 2026-09-02
   * `{ caller: 'signed-in' }` was taken off `GET /api/teams` and **all 30 cases
   * in this file passed**. Five of the six reads had no negative at all —
   * `GET /api/services` was covered only incidentally, by the service-command
   * case above — so the six identical 401 blocks they carried were a guard
   * nothing could see break.
   *
   * One case over all six rather than six cases, because what has to hold is
   * "no read in this controller answers an anonymous caller", and a per-route
   * test is a list somebody has to remember to extend.
   *
   * Proof: `{ caller: 'signed-in' }` removed from `/teams`, watched failing on
   * `expect(received).toEqual(expected) · - 401 · + 200` for that path;
   * `callerGuard` left registered and the option dropped from all six, watched
   * failing on all six. Observed 2026-09-02.
   */
  it('refuse a caller with no token', async () => {
    const paths = [
      '/api/teams',
      '/api/people',
      '/api/tags',
      '/api/services',
      '/api/work-item-types',
      '/api/external-systems',
    ];
    const statuses = await Promise.all(
      paths.map(async (path) => (await app.handle(new Request(`http://localhost${path}`))).status),
    );

    expect(Object.fromEntries(paths.map((path, at) => [path, statuses[at]]))).toEqual(
      Object.fromEntries(paths.map((path) => [path, 401])),
    );
  });
});
