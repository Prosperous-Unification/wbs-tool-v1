import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { AuthService } from '../service/auth.service';
import { clockOf } from '../service/clock';
import { ProjectService } from '../service/project.service';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { testCalendarMarkerService } from '../testing/calendar-marker-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { inMemoryServices } from '../testing/harness';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWrites } from '../testing/writes-fixture';

function buildWorkItemService(projectStore: ReturnType<typeof inMemoryProjects>) {
  // The project store is this suite's own — the list route resolves each
  // project's owner name through it, so it has to be the one the harness above
  // seeded. Everything else the harness builds.
  return inMemoryServices({ projects: projectStore }).service;
}

function buildHarness(options: { writeOnly?: boolean; optimizerAvailable?: boolean } = {}) {
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
  // Returned below, so 3b.4's two event cases can read what a PATCH announced —
  // and, for the refused one, that it announced nothing.
  const broadcast = recordingBroadcaster();
  const projects = new ProjectService({
    projects: projectStore,
    broadcast,
    // Available unless a case says otherwise, because most of this suite is
    // about the settings *contract* and would otherwise be asserting the gate
    // by accident. The two cases that are about the gate pass `false`, and
    // `optimizer-availability.test.ts` is where the predicate and the reader are
    // held to being one argument.
    optimizerAvailable: () => options.optimizerAvailable ?? true,
    clock: clockOf({
      now: () => {
        tick += 1;
        return tick;
      },
    }),
  });
  const app = buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    auth,
    projects,
    workItems: buildWorkItemService(projectStore),
    savedPlans: testSavedPlanService(),
    steps: testStepService(projectStore),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    writes: testWrites(),
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

  return { app, register, send, broadcast };
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

/**
 * Every column a project row has, which is what create and read both answer with.
 *
 * The three optimizer settings are in this list rather than in a case of their
 * own, and that is the whole reason it is a list: `missingFrom` runs it against
 * create, list and read, so publishing a field at the repository layer and
 * forgetting it on one of the three routes is caught by whichever route forgot.
 * `project.db.test.ts` proves the settings reach the *payload*; nothing proved
 * they reach the **wire** until they were named here — the containment check
 * passes happily on a payload that never carried them.
 */
const PROJECT_FIELDS = [
  'id',
  'name',
  'ownerId',
  'restricted',
  'estimateMethod',
  'pertWeights',
  'estimateRounding',
  'startDate',
  'solutionRef',
  'revision',
  'createdAt',
  'optimizationEnabled',
  'scheduleEngine',
  'scheduleObjective',
] as const;

describe('projects', () => {
  it('exports the project WBS and Gantt payload as JSON', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Export me'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({ commands: [{ kind: 'createWorkItem', name: 'Build the thing' }] }),
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
    await send(`/api/projects/${project.id}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({ commands: [{ kind: 'createWorkItem', name: 'Build | ship' }] }),
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
      steps: { name: string }[];
    };
    expect(body.project.name).toBe('Rewire the shed');
    expect(body.project.restricted).toBe(false);
    expect(body.steps.map((r) => r.name)).toEqual(['Dev', 'QA']);
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

  it('sets the PERT weights and the rounding in one patch', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Weighed'));
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
        estimateRounding: 'floor',
      }),
    });

    expect(res.status).toBe(200);
    const read = await send(`/api/projects/${project.id}`, token);
    expect(((await read.json()) as { project: object }).project).toMatchObject({
      pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
      estimateRounding: 'floor',
    });
  });

  it('refuses weights that cannot average a triple, and keeps the ones it had', async () => {
    // Three zeroes: a triple that passes every `>= 0` check the route can
    // express and has no divisor at all, so every PERT figure in the plan would
    // be `NaN` — a blank cell that reports itself as estimated. It is the
    // service's refusal rather than the schema's, because there is no shape
    // rule that says "not all of them".
    //
    // Proof: with the `bad_pert_weights` check deleted from
    // `ProjectService.update`, this failed on `Expected: 422 / Received: 200` —
    // the triple stored, and the next read of that project throwing at the
    // boundary instead of answering. Watched 2026-08-30.
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Weighed'));
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: '{"pertWeights":{"optimistic":0,"realistic":0,"pessimistic":0}}',
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'bad_pert_weights' });

    const read = await send(`/api/projects/${project.id}`, token);
    expect(((await read.json()) as { project: object }).project).toMatchObject({
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    });
  });

  it('refuses a negative and an infinite weight at the route’s own schema', async () => {
    // Both are refused before the service sees them, and by two different halves
    // of one `t.Number({ minimum: 0 })`: below zero makes a step shrink as its
    // estimate grows, and `1e999` — the only non-finite number JSON can express,
    // written as text because `JSON.stringify` turns `Infinity` back into `null`
    // — is refused because TypeBox's number is a finite one. Measured here
    // rather than assumed: the same literal passes every hand-written `>= 0`,
    // which is what `T1 column-widths-drag` cost a day to.
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Weighed'));
    const { project } = (await create.json()) as { project: { id: string } };

    for (const body of [
      '{"pertWeights":{"optimistic":-1,"realistic":4,"pessimistic":1}}',
      '{"pertWeights":{"optimistic":1e999,"realistic":4,"pessimistic":1}}',
    ]) {
      const res = await send(`/api/projects/${project.id}`, token, { method: 'PATCH', body });

      expect(res.status).toBe(422);
    }

    const read = await send(`/api/projects/${project.id}`, token);
    expect(((await read.json()) as { project: object }).project).toMatchObject({
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    });
  });

  it('answers a create with the project it wrote and its starting steps', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');

    const res = await send('/api/projects', token, created('Rewire the shed'));

    const body = (await res.json()) as { project: object; steps: object[] };
    expect(missingFrom(body.project, PROJECT_FIELDS)).toEqual([]);
    expect(
      body.steps.every((r) => missingFrom(r, ['id', 'projectId', 'name', 'position']).length === 0),
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

    const body = (await res.json()) as { project: object; steps: object[] };
    expect(missingFrom(body.project, PROJECT_FIELDS)).toEqual([]);
    expect(body.steps).toHaveLength(2);
    // The recorded non-goal, made breakable: the header reads its project out
    // of the list it already holds, so this route is not half-joined to match.
    expect(Object.hasOwn(body.project, 'ownerName')).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const { app } = buildHarness();
    const res = await app.handle(new Request('http://localhost/api/projects'));
    expect(res.status).toBe(401);
  });

  // tasks.md 3b.4. The unmigrated-row case is `project-settings.db.test.ts`'s,
  // because it is a fact about the columns' own defaults and this suite's store
  // is in memory; what is proved here is the HTTP contract and the event.
  it('patches each optimizer setting on its own, and the change survives a read', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };

    // Three requests rather than one, which is the point of the case: the
    // settings are three columns so that a project switched off keeps the
    // engine and objective it was on, and one combined PATCH would prove only
    // that they can move together.
    for (const patch of [
      { optimizationEnabled: true },
      { scheduleEngine: 'optimized' },
      { scheduleObjective: 'time' },
    ]) {
      const res = await send(`/api/projects/${project.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
    }

    // Read back rather than trusting the PATCH's own answer: a route that
    // echoed its request would satisfy every assertion above this line.
    const after = await send(`/api/projects/${project.id}`, token);
    const body = (await after.json()) as {
      project: { optimizationEnabled: boolean; scheduleEngine: string; scheduleObjective: string };
    };
    expect(body.project).toMatchObject({
      optimizationEnabled: true,
      scheduleEngine: 'optimized',
      scheduleObjective: 'time',
    });
  });

  it('refuses an unknown engine and an unknown objective at the route’s own schema', async () => {
    const { register, send } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };

    for (const patch of [{ scheduleEngine: 'quantum' }, { scheduleObjective: 'cost' }]) {
      const res = await send(`/api/projects/${project.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // The database's `CHECK` would refuse these too, as a 500 on the write;
      // the union in `projectPatch` makes it the caller's own 422 instead.
      expect(res.status).toBe(422);
    }
  });

  it('emits exactly one project_settings_changed, carrying all three values', async () => {
    const { register, send, broadcast } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    // Whatever creating a project announced is not what this case is about.
    broadcast.published.length = 0;

    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ scheduleEngine: 'optimized' }),
    });

    expect(res.status).toBe(200);
    // One event, not one *of that type*: `toEqual` on the whole recording is
    // what makes "and no `schedule_optimized`" a real assertion — a second
    // announcement of any kind fails it. All three values ride along even
    // though one moved, so a settings panel repainting from the event cannot
    // hold one fresh field beside two stale ones.
    expect(broadcast.published).toEqual([
      {
        projectId: project.id,
        event: {
          type: 'project_settings_changed',
          optimizationEnabled: false,
          scheduleEngine: 'optimized',
          scheduleObjective: 'pri',
        },
      },
    ]);
  });

  it('announces nothing when a settings patch changes none of the three', async () => {
    const { register, send, broadcast } = buildHarness();
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    broadcast.published.length = 0;

    // The values the project already has — which is what a settings panel with
    // three controls sends every time one of the other two is touched.
    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: false, scheduleEngine: 'fast' }),
    });

    expect(res.status).toBe(200);
    expect(broadcast.published).toEqual([]);
  });

  // The Critical both review seats reached on PR 203, from opposite directions:
  // a settings PATCH that answers 200 to `optimized` in a process where no
  // optimized reader is wired leaves the project claiming a mode every plan read
  // will silently ignore. Three cases, because the gate has three ways to be
  // written wrong and two of them were.
  it('refuses switching the optimizer on when this deployment has none, on either key alone', async () => {
    const { register, send, broadcast } = buildHarness({ optimizerAvailable: false });
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    broadcast.published.length = 0;

    // Separately, and this is the case's whole point: guarding only
    // `scheduleEngine` leaves `optimizationEnabled: true` a way to report a
    // half-enabled optimizer that is not there.
    for (const patch of [{ optimizationEnabled: true }, { scheduleEngine: 'optimized' }]) {
      const res = await send(`/api/projects/${project.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // 409 and not 422: nothing about the request is wrong, and the same body
      // is accepted by the harness two cases up, which has an optimizer.
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'optimizer_unavailable' });
    }

    // Refused *before* the write, not after it: a gate that returned 409 having
    // already stored the column would pass every assertion above this line.
    expect(broadcast.published).toEqual([]);
    const after = await send(`/api/projects/${project.id}`, token);
    const body = (await after.json()) as {
      project: { optimizationEnabled: boolean; scheduleEngine: string };
    };
    expect(body.project).toMatchObject({ optimizationEnabled: false, scheduleEngine: 'fast' });
  });

  // The three cases the PR 203 peer seat named as missing negatives at
  // `b07becf0`: every case above moves ONE key, so all of them still pass if
  // `turnsTheOptimizerOn` is written as an XOR instead of an OR, and none of
  // them reaches a project that is ALREADY enabled — which is the only state in
  // which a resend or a disabling can be wrongly refused. Both halves are
  // reachable by a caller, so both get a watched negative.
  it('refuses switching the optimizer on with both keys in one patch, not just either alone', async () => {
    const { register, send, broadcast } = buildHarness({ optimizerAvailable: false });
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    broadcast.published.length = 0;

    // An XOR gate — "exactly one of these two keys turns it on" — answers 200
    // here while passing every either-key-alone case above it. That is the
    // whole reason this case exists separately from them.
    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true, scheduleEngine: 'optimized' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'optimizer_unavailable' });
    expect(broadcast.published).toEqual([]);
    const after = await send(`/api/projects/${project.id}`, token);
    const body = (await after.json()) as {
      project: { optimizationEnabled: boolean; scheduleEngine: string };
    };
    expect(body.project).toMatchObject({ optimizationEnabled: false, scheduleEngine: 'fast' });
  });

  it('still lets an already-enabled project resend and disable after the optimizer is gone', async () => {
    // `buildHarness` reads `options.optimizerAvailable` through a closure on
    // every call, so mutating it here is a deployment LOSING its optimizer
    // between two requests — a redeploy without the solver, on a project whose
    // row already says `true`/`optimized`. Rebuilding the harness could not
    // reach this state: the enabling PATCH would be refused by the new one.
    const options = { optimizerAvailable: true };
    const { register, send, broadcast } = buildHarness(options);
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };
    const enable = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true, scheduleEngine: 'optimized' }),
    });
    expect(enable.status).toBe(200);

    options.optimizerAvailable = false;
    broadcast.published.length = 0;

    // Resending what the row already holds is not an enabling, and a gate that
    // compares the PATCH against `false` instead of against the STORED row 409s
    // it — locking the settings panel of every project that was enabled before
    // the optimizer went away.
    const resend = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true, scheduleEngine: 'optimized' }),
    });
    expect(resend.status).toBe(200);

    // And the way OUT must stay open, one key at a time: refusing these is the
    // failure that strands a project in a mode its deployment cannot serve.
    const off = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: false }),
    });
    expect(off.status).toBe(200);

    // The row is now the legal intermediate `false`/`optimized`, and re-enabling
    // the flag FROM it is the case the peer seat found unwatched at `66177c79`.
    // It is what separates a gate that compares each key against its OWN stored
    // field from one whose two comparisons are crossed —
    // `optimizationEnabled === true && before.scheduleEngine !== 'optimized'`
    // reads this row as "already on" and answers 200, re-enabling an
    // unserviceable mode. Every other case in this file passes that crossed gate.
    const reEnable = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true }),
    });
    expect(reEnable.status).toBe(409);
    expect(await reEnable.json()).toEqual({ error: 'optimizer_unavailable' });

    const fast = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ scheduleEngine: 'fast' }),
    });
    expect(fast.status).toBe(200);

    // The OTHER legal intermediate row, `true`/`fast`, and the engine half of
    // the gate judged from it. The Gemini seat's state enumeration at
    // `df7b6528` found this row asserted NOWHERE under an absent optimizer, so
    // the mirror image of the crossed gate above —
    // `scheduleEngine === 'optimized' && !before.optimizationEnabled` — reads
    // it as "already on" and answers 200 to a request that puts an
    // optimizer-less deployment into the optimized engine. Reached the same
    // way: enable the flag ALONE while the optimizer is still there, since no
    // PATCH can reach `true`/`fast` once it is gone.
    options.optimizerAvailable = true;
    const flagOnly = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true }),
    });
    expect(flagOnly.status).toBe(200);
    options.optimizerAvailable = false;

    const engineFromFlagOn = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ scheduleEngine: 'optimized' }),
    });
    expect(engineFromFlagOn.status).toBe(409);
    expect(await engineFromFlagOn.json()).toEqual({ error: 'optimizer_unavailable' });

    const flagOff = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: false }),
    });
    expect(flagOff.status).toBe(200);

    const after = await send(`/api/projects/${project.id}`, token);
    const body = (await after.json()) as {
      project: { optimizationEnabled: boolean; scheduleEngine: string };
    };
    // Read back, not inferred from the statuses: a 200 that stored nothing
    // would pass every assertion above this line.
    expect(body.project).toMatchObject({ optimizationEnabled: false, scheduleEngine: 'fast' });
  });

  it('lets a settings panel resend the values a project already holds, optimizer or not', async () => {
    const { register, send } = buildHarness({ optimizerAvailable: false });
    const token = await register('owner');
    const create = await send('/api/projects', token, created('Rewire the shed'));
    const { project } = (await create.json()) as { project: { id: string } };

    // The three-control panel's every keystroke. A gate written as "refuse any
    // PATCH naming these keys" 409s this, and the optimizer has nothing to do
    // with it — the request turns nothing on.
    const res = await send(`/api/projects/${project.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        optimizationEnabled: false,
        scheduleEngine: 'fast',
        scheduleObjective: 'time',
      }),
    });

    expect(res.status).toBe(200);
    const after = await send(`/api/projects/${project.id}`, token);
    const body = (await after.json()) as { project: { scheduleObjective: string } };
    // And the unrelated third setting still landed, which is the difference
    // between refusing an enabling and refusing a request.
    expect(body.project.scheduleObjective).toBe('time');
  });

  it('refuses a read-only collaborator’s settings patch, and emits nothing', async () => {
    const { register, send, broadcast } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, created('Restricted'));
    const { project } = (await create.json()) as { project: { id: string } };
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });
    broadcast.published.length = 0;

    const res = await send(`/api/projects/${project.id}`, stranger, {
      method: 'PATCH',
      body: JSON.stringify({ optimizationEnabled: true }),
    });

    // The settings ride on the project's existing write authorization rather
    // than on a rule of their own — a reader may read every project and may
    // change nothing in a restricted one, this included.
    expect(res.status).toBe(403);
    expect(broadcast.published).toEqual([]);
    const after = await send(`/api/projects/${project.id}`, stranger);
    const body = (await after.json()) as { project: { optimizationEnabled: boolean } };
    expect(body.project.optimizationEnabled).toBe(false);
  });
});
