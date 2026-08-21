import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ActualRepository } from '../repository/actual';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleRepository } from '../repository/role';
import { RoleMeasureRepository } from '../repository/role-measure';
import { RoleProgressRepository } from '../repository/role-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { CapacityService } from '../service/capacity.service';
import { DirectoryService } from '../service/directory.service';
import { ProjectService } from '../service/project.service';
import { RoleService } from '../service/role.service';
import { WorkItemService } from '../service/work-item.service';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';

const TEST_JWT_KEY = 'k'.repeat(32);
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/**
 * `PUT /api/projects/:id/teams/:teamId/capacity`, over **real SQLite**.
 *
 * Real for `directory.controller.test.ts`'s reason: every status asserted here is
 * decided by rows — the 404 by a project or a team the database does not hold,
 * the stored number by the primary key on the pair — and a fixture answering them
 * would be a second implementation of the rules under test. The retired
 * `PATCH /api/teams/:id/size` had its tests in that file; this route inherited
 * its whole job, and these are those tests recast per project plus the three
 * claims that are new.
 */
describe('PUT /api/projects/:id/teams/:teamId/capacity', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;
  let capacityStore: CapacityRepository;
  let directoryStore: DirectoryRepository;
  let projectStore: ProjectRepository;
  let broadcast: RecordingBroadcaster;
  let token: string;
  let ownerId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-capacity-http-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);

    projectStore = new ProjectRepository(db);
    directoryStore = new DirectoryRepository(db);
    capacityStore = new CapacityRepository(db);
    const workItems = new WorkItemRepository(db);
    broadcast = recordingBroadcaster();
    const auth = new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY });

    app = buildApp({
      auth,
      projects: new ProjectService({ projects: projectStore }),
      directory: new DirectoryService({ directory: directoryStore, broadcast }),
      capacity: new CapacityService({
        projects: projectStore,
        capacity: capacityStore,
        broadcast,
      }),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      roles: new RoleService({
        projects: projectStore,
        roles: new RoleRepository(db),
        broadcast,
      }),
      workItems: new WorkItemService({
        workItems,
        projects: projectStore,
        estimates: new EstimateRepository(db),
        actuals: new ActualRepository(db),
        measures: new RoleMeasureRepository(db),
        progress: new RoleProgressRepository(db),
        dependencies: new DependencyRepository(db),
        directory: directoryStore,
        capacity: capacityStore,
        priorityBands: inMemoryPriorityBands(),
        subtrees: new SubtreeRepository(db),
        journal: new CommandJournalRepository(db),
        broadcast,
      }),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: 'x'.repeat(32),
      migrationsApplied: true,
    });

    const registered = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse' }),
      }),
    );
    const body = (await registered.json()) as { token: string };
    token = body.token;
    const who = await auth.authenticate(token);
    if (who === null) throw new Error('the fixture token names no account');
    ownerId = who.id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(
    projectId: string,
    teamId: string,
    body: unknown,
    withToken = true,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}/teams/${teamId}/capacity`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(withToken ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  /** A project of `ownerId`'s, and a team, both real rows. */
  async function plan(name = 'Rewire the shed'): Promise<string> {
    const created = await new ProjectService({ projects: projectStore }).create(name, ownerId);
    return created.project.id;
  }

  async function team(name: string): Promise<string> {
    const added = await directoryStore.addTeam({ id: crypto.randomUUID(), name });
    return added.id;
  }

  it('states how many of a team are at work at once on this plan, and clears it', async () => {
    const projectId = await plan();
    const platform = await team('Platform');

    expect(await call(projectId, platform, { size: 4 })).toEqual({
      status: 200,
      body: { capacities: [{ serviceTeamId: platform, size: 4 }] },
    });
    expect(await capacityStore.slotsFor(projectId)).toEqual(new Map([[platform, 4]]));

    // Cleared is **unstated**, which constrains no schedule — not a team of one,
    // which serialises every item it labels. And unstated is the absence of a
    // row, so the answer is an empty list rather than a `null` beside the id.
    expect(await call(projectId, platform, { size: null })).toEqual({
      status: 200,
      body: { capacities: [] },
    });
    expect(await capacityStore.slotsFor(projectId)).toEqual(new Map());
  });

  it('leaves the team’s retired global number alone, because nothing reads it', async () => {
    // The half of D1 that is checkable from outside: writing a capacity does not
    // write `service_team.size`, so a rollback to the release before this one
    // finds the number the seeding put there rather than one this release
    // invented. The column is retired, not repurposed.
    const projectId = await plan();
    const platform = await team('Platform');

    await call(projectId, platform, { size: 4 });

    expect(await directoryStore.listTeams()).toEqual([
      { id: platform, name: 'Platform', serviceIds: [] },
    ]);
  });

  it('refuses a capacity that is not a whole number of 1 or more', async () => {
    // The floor is the load-bearing half: a pool of 0 slots clamps every width
    // to 0, the engine divides effort by that width, and the plan comes back with
    // every date `Infinity` and nothing on screen to say why.
    //
    // Proof: the integer guard deleted from `capacityOf`, and this failed on the
    // first value — `[200, "0"]` where `[400, "0"]` was owed, a pool of no slots
    // taken and written. Watched 2026-08-13.
    const projectId = await plan();
    const platform = await team('Platform');
    await call(projectId, platform, { size: 4 });

    for (const bad of [0, -1, 1.5, '3', true, 1e20]) {
      const refused = await call(projectId, platform, { size: bad });
      // The value rides into the assertion so a failure names which of them got
      // through rather than reporting the same mismatch six times.
      expect([refused.status, String(bad)]).toEqual([400, String(bad)]);
    }

    // A body naming no size at all is a request that says nothing, and this route
    // writes exactly one field — absent cannot mean "leave it".
    expect(await call(projectId, platform, {})).toEqual({
      status: 400,
      body: { error: 'size_required' },
    });

    expect(await capacityStore.slotsFor(projectId)).toEqual(new Map([[platform, 4]]));
  });

  it('refuses a capacity above what a plan can mean', async () => {
    // Injected apart from the guard above, because neither probe can see the
    // other's line: `1e20` is refused by `Number.isSafeInteger` whether or not a
    // ceiling exists, and `1001` passes the integer guard cleanly. A range check
    // probed only with a non-finite value is the vacuous check this repo has
    // shipped before (`T1 column-widths-drag`).
    //
    // Proof: the `> MOST_PEOPLE_AT_ONCE` comparison deleted with the integer
    // guard left in place, and this failed on `status: 400` becoming `200` with
    // the pair coming back `size: 1001`. Watched 2026-08-13.
    const projectId = await plan();
    const platform = await team('Platform');

    expect(await call(projectId, platform, { size: 1001 })).toEqual({
      status: 400,
      body: { error: 'size_must_be_at_most_1000' },
    });
    expect(await call(projectId, platform, { size: 1000 })).toMatchObject({ status: 200 });
  });

  it('answers 404 for a project or a team that is not there, and 401 with no token', async () => {
    const projectId = await plan();
    const platform = await team('Platform');

    expect(await call(crypto.randomUUID(), platform, { size: 2 })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await call(projectId, crypto.randomUUID(), { size: 2 })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect((await call(projectId, platform, { size: 2 }, false)).status).toBe(401);

    expect(await capacityStore.slotsFor(projectId)).toEqual(new Map());
  });

  it('refuses an account that may read the project but not write it', async () => {
    // Gated by project write access, unlike everything in `directoryController`:
    // the directory is global and open to every account, and this number moves one
    // project's dates. 403 rather than 404, `projectController`'s own split —
    // pretending the project is absent would contradict the next GET.
    const projectId = await plan();
    const platform = await team('Platform');
    await new ProjectService({ projects: projectStore }).update(projectId, ownerId, {
      restricted: true,
    });
    const registered = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'stranger', password: 'correct-horse' }),
      }),
    );
    const { token: theirs } = (await registered.json()) as { token: string };

    const res = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}/teams/${platform}/capacity`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${theirs}` },
        body: JSON.stringify({ size: 2 }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await capacityStore.slotsFor(projectId)).toEqual(new Map());
  });

  it('tells the project it names and no other, even one sharing the team', async () => {
    // The whole of the change from C2's fan-out. C2's size write announced to
    // every project the team labelled, because the number moved dates in all of
    // them; the set of plans a capacity write moves is now one, so the fan-out is
    // one — and a second plan sharing the team must not be told to reread for a
    // number that is not its own.
    //
    // Proof: the publish widened to `directory.usageOfTeam(teamId)`'s projects —
    // C2's own fan-out, put back — and this failed on
    // `[shed, roof] to equal [shed]`, the untouched plan told to reread. Watched
    // 2026-08-13.
    const shed = await plan('Rewire the shed');
    const roof = await plan('Reroof the barn');
    const platform = await team('Platform');
    await capacityStore.set(roof, platform, 9);
    broadcast.published.length = 0;

    await call(shed, platform, { size: 2 });

    expect(broadcast.published).toEqual([{ projectId: shed, event: { type: 'capacity_changed' } }]);
    // And the plan that was not told still holds its own number, untouched.
    expect(await capacityStore.slotsFor(roof)).toEqual(new Map([[platform, 9]]));
  });

  it('puts a capacity floor on the wire, which fe-01 has been able to draw since C3', async () => {
    // End to end, and the successor of C2's landmine test. Two HTTP requests —
    // state the capacity, label the work — are all it takes to make be-01 emit
    // `boundBy: 'capacity'`, and since C3 (#57) fe-01's `floorWordsOf` has an arm
    // for it. The landmine that test recorded is spent; what is worth keeping is
    // the shape of the proof, now pointed at the route that replaced the one it
    // used.
    const projectId = await plan();
    const platform = await team('Platform');
    expect((await call(projectId, platform, { size: 1 })).status).toBe(200);

    const send = (path: string, init?: RequestInit) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        }),
      );
    const rolesRes = await send(`/api/projects/${projectId}`);
    // `readonly` and indexed through `.at`, so the absence a fresh project could
    // have is a state the type carries rather than one the cast asserts away — a
    // project with no phases has no estimate to write and this test would
    // otherwise fail three lines later on an empty string in the URL.
    const { roles } = (await rolesRes.json()) as { roles: readonly { id: string }[] };
    const devId = roles.at(0)?.id;
    if (devId === undefined) throw new Error('the fixture project has no roles');

    for (const name of ['Strip', 'Sand']) {
      const created = await send(`/api/projects/${projectId}/work-items`, {
        method: 'POST',
        body: JSON.stringify({ parentId: null, afterId: null, name }),
      });
      const { id } = (await created.json()) as { id: string };
      await send(`/api/work-items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ serviceTeamId: platform }),
      });
      await send(`/api/work-items/${id}/estimates/${devId}`, {
        method: 'PUT',
        body: JSON.stringify({ optimistic: 2, realistic: 2, pessimistic: 2 }),
      });
    }

    const tree = await send(`/api/projects/${projectId}/work-items`);
    const body = (await tree.json()) as {
      waitingForCapacity: number;
      slices: { boundBy: string }[];
      teamCapacities: { serviceTeamId: string; size: number }[];
    };

    expect(body.slices.map((one) => one.boundBy)).toContain('capacity');
    expect(body.waitingForCapacity).toBe(1);
    // And the number the bars came out of rides in the same payload, so a client
    // never renders a capacity from one moment beside dates from another.
    expect(body.teamCapacities).toEqual([{ serviceTeamId: platform, size: 1 }]);
  });
});
