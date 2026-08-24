import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { AuthService } from '../service/auth.service';
import { ProjectService } from '../service/project.service';
import { WorkItemService } from '../service/work-item.service';
import { inMemoryActuals } from '../testing/actual-fixture';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory, testDirectoryService } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryMeasures } from '../testing/measure-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { inMemoryProgress } from '../testing/progress-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';

function buildWorkItemService(projectStore: ReturnType<typeof inMemoryProjects>) {
  const workItemStore = inMemoryWorkItems();
  return new WorkItemService({
    workItems: workItemStore,
    projects: projectStore,
    estimates: inMemoryEstimates(workItemStore),
    actuals: inMemoryActuals(workItemStore),
    measures: inMemoryMeasures(workItemStore),
    progress: inMemoryProgress(workItemStore),
    dependencies: inMemoryDependencies(),
    directory: inMemoryDirectory(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });
}

function buildHarness(options: { writeOnly?: boolean } = {}) {
  // One user store behind both: the list resolves each project's owner name
  // through it, exactly as the query joins `users`. Two stores would leave
  // every registered account unknown to the listing and throw on the first
  // project, which is what production does for an owner that is not there.
  const users = inMemoryUsers();
  const auth = options.writeOnly
    ? new AuthService({
        users,
        identities: users,
        jwtKey: TEST_JWT_KEY,
        localIdentity: { id: 'write-only', username: 'write-only', scopes: ['write'] },
      })
    : testAuthService(users);
  const projectStore = inMemoryProjects(users);
  // A monotonic clock rather than `Date.now`: two projects created in one
  // millisecond tie on `createdAt`, and an order test built on a tie proves
  // nothing about the ordering — it reports whichever way the sort happened to
  // land. Production ties too; this only removes the tie from the test.
  let tick = 0;
  const projects = new ProjectService({
    projects: projectStore,
    now: () => {
      tick += 1;
      return tick;
    },
  });
  const app = buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth,
    projects,
    workItems: buildWorkItemService(projectStore),
    roles: testRoleService(projectStore),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    migrationsApplied: true,
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
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }),
    );
  }

  return { app, register, send };
}

const created = (name: string) => ({ method: 'POST', body: JSON.stringify({ name }) });

/**
 * Which of `wanted` the object does not carry — `[]` when it carries them all.
 *
 * Containment, deliberately, and never an exact key set: fe-01's types name
 * what it **reads** of a wire that carries more, and a route asserted equal to
 * a key list would be a claim about a wire this change does not build — one
 * that also goes red the first time an unrelated field is added to a project.
 * `Object.hasOwn` rather than a truthiness test, because `startDate: null` and
 * `lastOpenedAt: null` are values these routes really send.
 */
const missingFrom = (carried: object, wanted: readonly string[]): string[] =>
  wanted.filter((field) => !Object.hasOwn(carried, field));

/** Every column a project row has, which is what create and read both answer with. */
const PROJECT_FIELDS = [
  'id',
  'name',
  'ownerId',
  'restricted',
  'estimateMethod',
  'startDate',
  'solutionRef',
  'revision',
  'createdAt',
] as const;

describe('projects', () => {
  it('exports the project WBS and Gantt payload as JSON', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Export me'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Build the thing' }),
    });

    const res = await send(`/api/projects/${project.id}/export?format=json`, token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      project: { id: string; name: string };
      workItems: { name: string }[];
      slices: unknown[];
    };
    expect(body.project).toMatchObject({ id: project.id, name: 'Export me' });
    expect(body.workItems.map((item) => item.name)).toEqual(['Build the thing']);
    expect(Array.isArray(body.slices)).toBe(true);
  });

  it('exports a readable Markdown WBS and Gantt table', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Export me'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Build | ship' }),
    });

    const res = await send(`/api/projects/${project.id}/export?format=markdown`, token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const markdown = await res.text();
    expect(markdown).toContain(
      '# Export me\n\n| WBS | Work item | Start | Finish | Duration | Critical |\n',
    );
    expect(markdown).toContain('| 010 | Build \\| ship |');
  });

  it('refuses an unsupported export format', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Export me'));
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await send(`/api/projects/${project.id}/export?format=xml`, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_format' });
  });

  it('names an unknown project export as not found', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');

    const res = await send('/api/projects/missing/export?format=json', token);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('refuses project exports without read scope', async () => {
    const { send } = buildHarness({ writeOnly: true });

    const res = await send('/api/projects/anything/export?format=json', 'local-mode');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('resolves a project by its solution slug', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    const linked = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        solutionRef: { slug: 'shed-rewire', url: 'https://solutions.example/shed-rewire' },
      }),
    });

    const res = await send('/plans/by-solution/shed-rewire', token);

    expect(linked.status).toBe(200);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { id: string; solutionRef: unknown } };
    expect(body.project.id).toBe(project.id);
    expect(body.project.solutionRef).toEqual({
      slug: 'shed-rewire',
      url: 'https://solutions.example/shed-rewire',
    });
  });

  it('names an unknown solution slug as not found', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');

    const res = await send('/plans/by-solution/not-linked', token);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: 'not_found' }));
  });

  it('refuses a solution lookup without read scope', async () => {
    const { send } = buildHarness({ writeOnly: true });

    const res = await send('/plans/by-solution/not-linked', 'local-mode');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('creates a project owned by the caller, holding Dev and QA', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');

    const res = await send('/api/projects', token, created('Rewire the shed'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { name: string; ownerId: string; restricted: boolean };
      roles: { name: string }[];
    };
    expect(body.project.name).toBe('Rewire the shed');
    expect(body.project.restricted).toBe(false);
    expect(body.roles.map((r) => r.name)).toEqual(['Dev', 'QA']);
  });

  it('lists every project regardless of who owns it', async () => {
    const { register, send } = buildHarness();
    const mine = await register('owner');
    const theirs = await register('stranger');
    await send('/api/projects', mine, created('Mine'));
    await send('/api/projects', theirs, created('Theirs'));

    const res = await send('/api/projects', mine);

    const body = (await res.json()) as { projects: { name: string }[] };
    expect(body.projects.map((p) => p.name).sort()).toEqual(['Mine', 'Theirs']);
  });

  it('lists in the caller’s own order, opened first', async () => {
    const { register, send } = buildHarness();
    const mine = await register('owner');
    const stranger = await register('stranger');
    const first = await send('/api/projects', mine, created('First'));
    await send('/api/projects', mine, created('Second'));
    const { project } = (await first.json()) as { project: { id: string } };

    // Only one of the two accounts opens `First`; the other's order must not
    // move, or the join is attaching somebody else's history.
    expect(
      (await send(`/api/projects/${project.id}/opened`, mine, { method: 'POST' })).status,
    ).toBe(204);

    const mineBody = (await (await send('/api/projects', mine)).json()) as {
      projects: { name: string; lastOpenedAt: number | null }[];
    };
    expect(mineBody.projects.map((p) => p.name)).toEqual(['First', 'Second']);
    expect(mineBody.projects[0]?.lastOpenedAt).toBeGreaterThan(0);
    expect(mineBody.projects[1]?.lastOpenedAt).toBeNull();

    const theirBody = (await (await send('/api/projects', stranger)).json()) as {
      projects: { name: string }[];
    };
    expect(theirBody.projects.map((p) => p.name)).toEqual(['Second', 'First']);
  });

  it('lets a reader record opening a project it may not edit', async () => {
    const { register, send } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, created('Restricted'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await send(`/api/projects/${project.id}/opened`, stranger, { method: 'POST' });

    expect(res.status).toBe(204);
    const body = (await (await send('/api/projects', stranger)).json()) as {
      projects: { name: string; lastOpenedAt: number | null }[];
    };
    expect(body.projects[0]?.lastOpenedAt).toBeGreaterThan(0);
  });

  it('refuses to record an open of a project that is not there, and of nobody', async () => {
    const { app, register, send } = buildHarness();
    const token = await register('owner');

    const missing = await send(`/api/projects/${crypto.randomUUID()}/opened`, token, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);

    // Without the token at all: the route must not be an unauthenticated write.
    const anonymous = await app.handle(
      new Request(`http://localhost/api/projects/${crypto.randomUUID()}/opened`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(anonymous.status).toBe(401);
  });

  it('lets a non-owner read a restricted project', async () => {
    const { register, send } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, created('Restricted'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await send(`/api/projects/${project.id}`, stranger);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { name: string } };
    expect(body.project.name).toBe('Restricted');
  });

  // The check this proves is the whole of `restricted`. Without it the API
  // reads as if the flag works — the field round-trips, the UI shows a lock —
  // while any account can still write.
  it('refuses a non-owner editing a restricted project, and writes nothing', async () => {
    const { register, send } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, created('Restricted'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await send(`/api/projects/${project.id}`, stranger, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed by a stranger' }),
    });

    expect(res.status).toBe(403);
    const after = await send(`/api/projects/${project.id}`, stranger);
    const body = (await after.json()) as { project: { name: string } };
    expect(body.project.name).toBe('Restricted');
  });

  it('lets any account edit an unrestricted project', async () => {
    const { register, send } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, created('Open'));
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await send(`/api/projects/${project.id}`, stranger, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed by a stranger' }),
    });

    expect(res.status).toBe(200);
  });

  it('answers a create with the project it wrote and its starting roles', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');

    const res = await send('/api/projects', token, created('Rewire the shed'));

    const body = (await res.json()) as { project: object; roles: object[] };
    expect(missingFrom(body.project, PROJECT_FIELDS)).toEqual([]);
    expect(
      body.roles.every((r) => missingFrom(r, ['id', 'projectId', 'name', 'position']).length === 0),
    ).toBe(true);
    // The two absences, which are claims of their own: create has never had an
    // account's navigation history to report, and fe-01 typed its response as
    // the list's shape and so believed it did.
    expect(Object.hasOwn(body.project, 'lastOpenedAt')).toBe(false);
    expect(Object.hasOwn(body.project, 'ownerName')).toBe(false);
  });

  it('answers a list entry with the owner’s name beside everything it already sent', async () => {
    const { register, send } = buildHarness();
    const token = await register('kat');
    await send('/api/projects', token, created('Rewire the shed'));

    const res = await send('/api/projects', token);

    const body = (await res.json()) as { projects: { ownerName?: string }[] };
    // `.at` rather than `[0]`, so the emptiness is a state this has to answer
    // for: an assertion run against a list that came back with nothing in it
    // would pass every containment check it was given.
    const entry = body.projects.at(0);
    if (entry === undefined) throw new Error('the list came back empty');
    // The picker's six, and the four it has always carried that the picker
    // never shows — this change removes nothing from the wire.
    expect(missingFrom(entry, [...PROJECT_FIELDS, 'lastOpenedAt', 'ownerName'])).toEqual([]);
    expect(entry.ownerName).toBe('kat');
  });

  it('answers a read with what it carried before, and no owner name', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await send(`/api/projects/${project.id}`, token);

    const body = (await res.json()) as { project: object; roles: object[] };
    expect(missingFrom(body.project, PROJECT_FIELDS)).toEqual([]);
    expect(body.roles).toHaveLength(2);
    // The recorded non-goal, made breakable: the header reads its project out
    // of the list it already holds, so this route is not half-joined to match.
    expect(Object.hasOwn(body.project, 'ownerName')).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildHarness();
    const res = await app.handle(new Request('http://localhost/api/projects'));
    expect(res.status).toBe(401);
  });
});
