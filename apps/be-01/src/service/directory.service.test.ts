import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DirectoryStore, Person, Role, WorkItem } from '../repository';
import { CapacityRepository } from '../repository/capacity';
import { openDrizzle } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleRepository } from '../repository/role';
import { teamService } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { DirectoryService } from './directory.service';
import { ProjectService } from './project.service';

/**
 * The directory service, against real SQLite.
 *
 * Real stores for the same reason `role.service.test.ts` uses them: every
 * refusal here is decided by rows — the unique index behind a `taken`, the
 * assignments behind an `in_use`, the missing team row behind an
 * `unknown_team` — and an in-memory store answering them would be a second
 * implementation of the rules under test.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: ReturnType<typeof openDrizzle>;
let directory: DirectoryService;
let store: DirectoryRepository;
/** Where a pool size is stated since `capacity-per-project`: per project, not per team. */
let capacity: CapacityRepository;
let projects: ProjectRepository;
let workItems: WorkItemRepository;
let roleStore: RoleRepository;
let broadcast: RecordingBroadcaster;
let projectId: string;
let ownerId: string;
let devId: string;
let qaId: string;

const newItem = (id: string, position: number, name: string, inProject = projectId): WorkItem => ({
  id,
  projectId: inProject,
  parentId: null,
  position,
  name,
  notes: '',
  frozenNumber: null,
  priority: null,
  startNoEarlierThan: null,
  serviceTeamId: null,
  serviceId: null,
  maxParallel: 1,
  revision: 0,
});

const roleNamed = async (name: string, inProject = projectId): Promise<Role> => {
  const found = (await roleStore.listByProject(inProject)).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no role called ${name}`);
  return found;
};

/** The person a create made, or a throw — a fixture whose setup was refused is not a result. */
const added = async (name: string, teamIds: readonly string[]): Promise<Person> => {
  const outcome = await directory.addPerson(name, teamIds);
  if (!outcome.ok) throw new Error(`the fixture person was refused: ${outcome.reason}`);
  return outcome.result;
};

/** A second project with one work item, so a team can be held in two at once. */
async function roofProject(): Promise<{ projectOf: string; workItemOf: string }> {
  const created = await new ProjectService({ projects }).create('Roof', ownerId);
  const workItemOf = crypto.randomUUID();
  await workItems.insert(newItem(workItemOf, 10, 'Shingle', created.project.id), []);
  return { projectOf: created.project.id, workItemOf };
}

/** The person by that name, or a throw, for the same reason. */
const personNamed = async (name: string): Promise<string> => {
  const found = (await store.listPeople()).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no person called ${name}`);
  return found.id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-directory-service-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);

  projects = new ProjectRepository(db);
  store = new DirectoryRepository(db);
  capacity = new CapacityRepository(db);
  workItems = new WorkItemRepository(db);
  roleStore = new RoleRepository(db);
  broadcast = recordingBroadcaster();
  directory = new DirectoryService({ directory: store, broadcast });

  ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });

  const created = await new ProjectService({ projects }).create('Rollout', ownerId);
  projectId = created.project.id;
  devId = (await roleNamed('Dev')).id;
  qaId = (await roleNamed('QA')).id;

  await workItems.insert(newItem('design', 10, 'Design'), []);
  await workItems.insert(newItem('build', 20, 'Build'), []);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DirectoryService.patchTeam', () => {
  it('renames a team, trimming what it is given', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');

    const outcome = await directory.patchTeam(platform.id, { name: '  Payments  ' });

    // An id and a name, and nothing else on the row: a team carries no size
    // since `capacity-per-project`, and this is where a rename answering with
    // the retired column would show up.
    expect(outcome).toEqual({
      ok: true,
      result: { id: platform.id, name: 'Payments', serviceIds: [] },
    });
    expect(await store.listTeams()).toEqual([
      { id: platform.id, name: 'Payments', serviceIds: [] },
    ]);
  });

  it('refuses a name of whitespace alone, and writes nothing', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');

    expect(await directory.patchTeam(platform.id, { name: '   ' })).toEqual({
      ok: false,
      reason: 'name_required',
    });
    expect(await store.listTeams()).toEqual([
      { id: platform.id, name: 'Platform', serviceIds: [] },
    ]);
  });

  it('refuses a name another team holds, naming the survivor', async () => {
    await directory.addTeam('Platform');
    const payments = await directory.addTeam('Payments');
    if (payments === null) throw new Error('the fixture team was refused');

    // The survivor is `Platform` — the row that already holds the name keeps
    // it, and the refusal says so rather than leaving the caller to guess which
    // of the two names is now which.
    expect(await directory.patchTeam(payments.id, { name: 'Platform' })).toEqual({
      ok: false,
      reason: 'taken',
      name: 'Platform',
    });
    expect((await store.listTeams()).map((each) => each.name)).toEqual(['Payments', 'Platform']);
  });

  it('renaming a team to the name it already holds is not a collision', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');

    expect(await directory.patchTeam(platform.id, { name: 'Platform' })).toEqual({
      ok: true,
      result: { id: platform.id, name: 'Platform', serviceIds: [] },
    });
  });

  it('refuses a team that is not there', async () => {
    expect(await directory.patchTeam(crypto.randomUUID(), { name: 'Payments' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses a patch naming neither a name nor services', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');

    // `patchPerson`'s rule and its reason: nothing sends one deliberately, so a
    // 200 here would hide a client bug rather than report it.
    expect(await directory.patchTeam(platform.id, {})).toEqual({
      ok: false,
      reason: 'nothing_to_change',
    });
  });

  it('one team owns several services, and each service reads as owned by it', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const payments = await directory.addService('Payments');
    const auth = await directory.addService('Auth');
    if (payments === null || auth === null) throw new Error('a fixture service was refused');

    const outcome = await directory.patchTeam(platform.id, {
      serviceIds: [payments.id, auth.id],
    });

    expect(outcome).toEqual({
      ok: true,
      result: {
        id: platform.id,
        name: 'Platform',
        serviceIds: [auth.id, payments.id].sort(),
      },
    });
    // The other direction of the same fact, which is what the spec's "each
    // service reads as owned by that team" asks for: the map is one table and
    // both readings come out of it.
    expect(await store.listTeams()).toEqual([
      { id: platform.id, name: 'Platform', serviceIds: [auth.id, payments.id].sort() },
    ]);
  });

  it('refuses a service the directory does not hold, and writes neither half', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const payments = await directory.addService('Payments');
    if (payments === null) throw new Error('the fixture service was refused');

    expect(
      await directory.patchTeam(platform.id, {
        name: 'Renamed',
        serviceIds: [payments.id, crypto.randomUUID()],
      }),
    ).toEqual({ ok: false, reason: 'unknown_service' });

    // Neither half: the rename is gone with the map edit that was refused. The
    // validation runs before the update **inside the same transaction**, which
    // is the only thing that makes this true — returning from a drizzle
    // transaction callback commits it.
    expect(await store.listTeams()).toEqual([
      { id: platform.id, name: 'Platform', serviceIds: [] },
    ]);
  });

  it('editing the ownership map announces nothing, where a rename announces', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const payments = await directory.addService('Payments');
    if (payments === null) throw new Error('the fixture service was refused');
    // The team is on a row of a real project, so there is something to announce
    // to — without this the silence below would be silence about nothing.
    await workItems.patch('design', { serviceTeamId: platform.id });
    broadcast.published.length = 0;

    await directory.patchTeam(platform.id, { serviceIds: [payments.id] });
    // The map labels no work item, is not inherited and the scheduler never
    // reads it, so every open plan is still correct — an event would send them
    // all to reread a tree that is exactly as it was. Half of task 4.5's claim,
    // asserted where the decision lives; the other half is the schedule itself.
    expect(broadcast.published).toEqual([]);

    // The control, so this is not a test that events never fire: the same
    // method with a name on it does announce.
    await directory.patchTeam(platform.id, { name: 'Platform Team' });
    expect(broadcast.published).toEqual([{ projectId, event: { type: 'directory_changed' } }]);
  });
});

describe('DirectoryService.patchPerson', () => {
  /** `Kat`, in `Platform`, assigned to `Dev` on `design`. */
  async function katInPlatform(): Promise<{ katId: string; platformId: string }> {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const kat = await added('Kat', [platform.id]);
    await store.assign('design', devId, kat.id);
    return { katId: kat.id, platformId: platform.id };
  }

  it('renames a person, and every assignment still holds them', async () => {
    const { katId, platformId } = await katInPlatform();

    const outcome = await directory.patchPerson(katId, { name: '  Katrin  ' });

    expect(outcome).toEqual({
      ok: true,
      result: { id: katId, name: 'Katrin', kind: 'person', teamIds: [platformId] },
    });
    expect(await store.assignmentsOf(['design'])).toEqual([
      { workItemId: 'design', roleId: devId, personId: katId },
    ]);
  });

  it('refuses a name another person holds, naming the survivor', async () => {
    const { katId } = await katInPlatform();
    const strip = await added('Strip', []);

    expect(await directory.patchPerson(strip.id, { name: 'Kat' })).toEqual({
      ok: false,
      reason: 'taken',
      name: 'Kat',
    });
    expect((await store.listPeople()).map((each) => each.name)).toEqual(['Kat', 'Strip']);
    expect(await personNamed('Kat')).toBe(katId);
  });

  it('replaces memberships in full', async () => {
    const { katId } = await katInPlatform();
    const payments = await directory.addTeam('Payments');
    const support = await directory.addTeam('Support');
    if (payments === null || support === null) throw new Error('a fixture team was refused');

    const outcome = await directory.patchPerson(katId, {
      teamIds: [payments.id, support.id],
    });

    if (!outcome.ok) throw new Error(`the patch was refused: ${outcome.reason}`);
    expect([...outcome.result.teamIds].sort()).toEqual([payments.id, support.id].sort());
    // In full: `Platform` is gone rather than kept alongside the two named.
    const stored = (await store.listPeople()).find((each) => each.id === katId);
    expect([...(stored?.teamIds ?? [])].sort()).toEqual([payments.id, support.id].sort());
  });

  it('collapses the same team named twice into one membership', async () => {
    const { katId } = await katInPlatform();
    const payments = await directory.addTeam('Payments');
    if (payments === null) throw new Error('the fixture team was refused');

    const outcome = await directory.patchPerson(katId, {
      teamIds: [payments.id, payments.id],
    });

    expect(outcome).toEqual({
      ok: true,
      result: { id: katId, name: 'Kat', kind: 'person', teamIds: [payments.id] },
    });
  });

  it('leaves a person a free agent when the list is empty', async () => {
    const { katId } = await katInPlatform();

    expect(await directory.patchPerson(katId, { teamIds: [] })).toEqual({
      ok: true,
      result: { id: katId, name: 'Kat', kind: 'person', teamIds: [] },
    });
  });

  it('refuses the whole patch for a team that is not there, rename included', async () => {
    // The one that decides the shape of the write: the validation has to run
    // before the name is written, **inside** the same transaction. A rename
    // that survived a refused patch would be the half-applied state the spec
    // says is not observable.
    const { katId, platformId } = await katInPlatform();

    const outcome = await directory.patchPerson(katId, {
      name: 'Katrin',
      teamIds: [crypto.randomUUID()],
    });

    expect(outcome).toEqual({ ok: false, reason: 'unknown_team' });
    expect(await store.listPeople()).toEqual([
      { id: katId, name: 'Kat', kind: 'person', teamIds: [platformId] },
    ]);
  });

  it('refuses a patch naming neither a name, memberships, nor a kind', async () => {
    const { katId } = await katInPlatform();

    expect(await directory.patchPerson(katId, {})).toEqual({
      ok: false,
      reason: 'nothing_to_change',
    });
  });

  it('marks a person an agent and back, leaving their memberships alone', async () => {
    const { katId, platformId } = await katInPlatform();

    expect(await directory.patchPerson(katId, { kind: 'agent' })).toEqual({
      ok: true,
      result: { id: katId, name: 'Kat', kind: 'agent', teamIds: [platformId] },
    });
    // A kind alone is a whole patch: it is not `nothing_to_change`, and the
    // memberships it did not name survive it.
    expect(await directory.patchPerson(katId, { kind: 'person' })).toEqual({
      ok: true,
      result: { id: katId, name: 'Kat', kind: 'person', teamIds: [platformId] },
    });
  });

  it('refuses a kind outside the set before anything is written', async () => {
    const { katId, platformId } = await katInPlatform();

    expect(await directory.patchPerson(katId, { name: 'Katrin', kind: 'robot' })).toEqual({
      ok: false,
      reason: 'invalid_kind',
    });
    // The rename rode along and must not have landed — the check is above the
    // store call, so no transaction was opened at all.
    expect(await store.listPeople()).toEqual([
      { id: katId, name: 'Kat', kind: 'person', teamIds: [platformId] },
    ]);
  });

  it('refuses a name of whitespace alone, and a person that is not there', async () => {
    const { katId, platformId } = await katInPlatform();

    expect(await directory.patchPerson(katId, { name: '   ' })).toEqual({
      ok: false,
      reason: 'name_required',
    });
    expect(await directory.patchPerson(crypto.randomUUID(), { name: 'Katrin' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await store.listPeople()).toEqual([
      { id: katId, name: 'Kat', kind: 'person', teamIds: [platformId] },
    ]);
  });
});

describe('directory events', () => {
  it('tells every project an assignment reaches into that a person was renamed', async () => {
    const roof = await roofProject();
    const kat = await added('Kat', []);
    const unreferenced = await added('Nobody', []);
    await store.assign('design', devId, kat.id);
    await store.assign(roof.workItemOf, (await roleNamed('Dev', roof.projectOf)).id, kat.id);
    broadcast.published.length = 0;

    await directory.patchPerson(kat.id, { name: 'Katrin' });

    expect([...broadcast.published].sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual(
      [
        { projectId: projectId, event: { type: 'directory_changed' } },
        { projectId: roof.projectOf, event: { type: 'directory_changed' } },
      ].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    );

    broadcast.published.length = 0;
    await directory.patchPerson(unreferenced.id, { name: 'Still nobody' });

    // No project references them, so there is nothing anywhere to reread.
    expect(broadcast.published).toEqual([]);
  });

  it('says nothing when a person becomes an agent, even one three plans assign', async () => {
    // The membership rule applied to `kind`, and for the same reason rather
    // than a weaker one: no row in a plan's tree draws it. It reaches the
    // directory payload and the directory card, and both read the directory.
    // The day a badge appears beside an assignee in a tree, this test is the
    // one that has to change first.
    const roof = await roofProject();
    const kat = await added('Kat', []);
    await store.assign('design', devId, kat.id);
    await store.assign(roof.workItemOf, (await roleNamed('Dev', roof.projectOf)).id, kat.id);
    broadcast.published.length = 0;

    await directory.patchPerson(kat.id, { kind: 'agent' });

    expect(broadcast.published).toEqual([]);

    // And a rename in the same patch still announces — the silence belongs to
    // the field, not to the request.
    await directory.patchPerson(kat.id, { name: 'Katrin', kind: 'person' });
    expect(broadcast.published.map((each) => each.projectId).sort()).toEqual(
      [projectId, roof.projectOf].sort(),
    );
  });

  it('tells the projects a removed team was labelled in, and nobody else', async () => {
    const platform = await directory.addTeam('Platform');
    const unused = await directory.addTeam('Unused');
    if (platform === null || unused === null) throw new Error('a fixture team was refused');
    await workItems.patch('design', { serviceTeamId: platform.id });
    broadcast.published.length = 0;

    await directory.patchTeam(platform.id, { name: 'Payments' });
    expect(broadcast.published).toEqual([{ projectId, event: { type: 'directory_changed' } }]);

    broadcast.published.length = 0;
    await directory.removeTeam(platform.id, true);
    expect(broadcast.published).toEqual([{ projectId, event: { type: 'directory_changed' } }]);

    broadcast.published.length = 0;
    await directory.patchTeam(unused.id, { name: 'Still unused' });
    await directory.removeTeam(unused.id, false);
    expect(broadcast.published).toEqual([]);
  });

  it('records the event after the write, never before it', async () => {
    // The sequence-consistency rule, asserted where it is decided rather than
    // reasoned about: a reader that acts on the event — a client rereading the
    // project, the replay log recording it — must never see the directory as it
    // was before the change. Reading the directory from inside `publish` is the
    // only moment that can tell the two orders apart.
    //
    // It is not a nested-transaction test. `bun:sqlite` transactions are
    // synchronous, so an `await` inside one cannot be written to fail; what
    // post-commit timing actually buys is that nothing a listener reads is
    // uncommitted, and `publish` is the boundary that can say so.
    const namesAtPublish: string[][] = [];
    const watching = new DirectoryService({
      directory: store,
      broadcast: {
        async publish() {
          namesAtPublish.push((await store.listPeople()).map((each) => each.name));
        },
        latestSeq: () => Promise.resolve(-1),
      },
    });
    const kat = await added('Kat', []);
    await store.assign('design', devId, kat.id);

    await watching.patchPerson(kat.id, { name: 'Katrin' });
    await watching.removePerson(kat.id, true);

    expect(namesAtPublish[0]).toEqual(['Katrin']);
    // Removed, not merely renamed: the second publish reads a directory the
    // deletion has already committed to.
    expect(namesAtPublish[1]).toEqual([]);
  });
});

/**
 * The real store with some methods wrapped, so a test can put somebody else's
 * write in the gap between two of the service's calls.
 *
 * Written out rather than spread from the repository: `DirectoryRepository`'s
 * methods live on its prototype, and `{ ...store }` copies its connection and
 * none of them.
 */
function storeWith(overrides: Partial<DirectoryStore>): DirectoryStore {
  return {
    listTeams: () => store.listTeams(),
    addTeam: (team) => store.addTeam(team),
    patchTeam: (teamId, patch) => store.patchTeam(teamId, patch),
    listPeople: () => store.listPeople(),
    addPerson: (toAdd, teamIds) => store.addPerson(toAdd, teamIds),
    patchPerson: (personId, patch) => store.patchPerson(personId, patch),
    usageOfPerson: (personId) => store.usageOfPerson(personId),
    usageOfTeam: (teamId) => store.usageOfTeam(teamId),
    removePerson: (personId, cascade) => store.removePerson(personId, cascade),
    removeTeam: (teamId, cascade) => store.removeTeam(teamId, cascade),
    assignmentsOf: (ids) => store.assignmentsOf(ids),
    assign: (workItemId, roleId, personId) => store.assign(workItemId, roleId, personId),
    ...overrides,
  };
}

describe('the directory usage a removal is refused with', () => {
  it('names the project, the number and the work item an assignment holds', async () => {
    const kat = await added('Kat', []);
    await store.assign('design', devId, kat.id);

    const outcome = await directory.removePerson(kat.id, false);

    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      usage: {
        projects: [
          {
            id: projectId,
            name: 'Rollout',
            workItems: [
              {
                id: 'design',
                number: '010',
                name: 'Design',
                effects: [
                  { kind: 'assignment_dropped', role: { id: devId, name: 'Dev' } },
                  // The sole assignment going takes the assumption with it, and
                  // `null` is `unassigned` said in the payload rather than left
                  // to be inferred from an absence.
                  { kind: 'assumed_assignee_changed', assumedNow: 'Kat', assumedAfter: null },
                ],
              },
            ],
          },
        ],
        members: [],
      },
    });
    expect(await personNamed('Kat')).toBe(kat.id);
  });

  it('names the person who becomes assumed when one of two assignments goes', async () => {
    const kat = await added('Kat', []);
    const ada = await added('Ada', []);
    // Two assignments, so nobody is assumed to be doing every phase now; one
    // left, so `Ada` becomes assumed. That is a move, and it is named.
    await store.assign('design', devId, kat.id);
    await store.assign('design', qaId, ada.id);

    const outcome = await directory.removePerson(kat.id, false);

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    expect(outcome.usage.projects[0]?.workItems[0]?.effects).toEqual([
      { kind: 'assignment_dropped', role: { id: devId, name: 'Dev' } },
      { kind: 'assumed_assignee_changed', assumedNow: null, assumedAfter: 'Ada' },
    ]);
  });

  it('names both projects a team is labelled in', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const roof = await roofProject();
    await workItems.patch('design', { serviceTeamId: platform.id });
    await workItems.patch(roof.workItemOf, { serviceTeamId: platform.id });

    const outcome = await directory.removeTeam(platform.id, false);

    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      usage: {
        // By name, and `Rollout` sorts before `Roof` — the third letter
        // decides. Sorted at all so that the same impact reads the same way
        // twice; a confirmation that reorders itself reads as a different
        // answer.
        projects: [
          {
            id: projectId,
            name: 'Rollout',
            workItems: [
              { id: 'design', number: '010', name: 'Design', effects: [{ kind: 'label_nulled' }] },
            ],
          },
          {
            id: roof.projectOf,
            name: 'Roof',
            workItems: [
              {
                id: roof.workItemOf,
                // `010`, not `020`: each project is numbered as its own tree.
                number: '010',
                name: 'Shingle',
                effects: [{ kind: 'label_nulled' }],
              },
            ],
          },
        ],
        members: [],
      },
    });
  });

  it('names the capacity a sized team takes with it, inherited rows included', async () => {
    // Removing a sized team does more than null a label: it takes a **pool**
    // away, so every slice that drew slots from it stops queueing and every
    // date in the labelled subtree moves. The rows that inherit the label carry
    // nothing to null and would otherwise not appear in this confirmation at
    // all — somebody would agree to "one row loses its label" and watch twenty
    // rows move.
    const team = await directory.addTeam('Platform');
    if (team === null) throw new Error('the fixture team was refused');
    await workItems.insert({ ...newItem('api', 10, 'API'), parentId: 'design' }, []);
    await workItems.patch('design', { serviceTeamId: team.id });
    // Stated **for this project** since `capacity-per-project`: the number the
    // confirmation prints is the number the plan the row is in was bounded by.
    await capacity.set(projectId, team.id, 2);

    const outcome = await directory.removeTeam(team.id, false);

    if (outcome.ok) throw new Error('expected the removal to be refused');
    if (outcome.reason !== 'in_use') throw new Error(`refused for ${outcome.reason}`);
    expect(outcome.usage.projects).toEqual([
      {
        id: projectId,
        name: 'Rollout',
        workItems: [
          {
            id: 'design',
            number: '010',
            name: 'Design',
            // Both effects, and in this order: the label goes, and the pool
            // goes with it. `fromId` is the row's own id here because the label
            // is its own.
            effects: [
              { kind: 'label_nulled' },
              { kind: 'capacity_released', size: 2, fromId: 'design' },
            ],
          },
          {
            id: 'api',
            number: '010.1',
            name: 'API',
            // The inherited row: no label of its own to null, and its dates
            // move exactly as its parent's do. `fromId` names where the label
            // it loses came from, which is what the confirmation has to say.
            effects: [{ kind: 'capacity_released', size: 2, fromId: 'design' }],
          },
        ],
      },
    ]);
  });

  it('names each project’s own capacity, and says nothing where a project stated none', async () => {
    // The multi-project case, which is the whole of what `capacity-per-project`
    // changed about this confirmation: the same team is stated at four on one
    // plan and unstated on the next, so the number printed beside a row has to
    // be that row's project's. One number for the confirmation would name a
    // bound half the rows it printed on were never under.
    //
    // The two-project fixture this needs is the one `tells both projects the
    // team labels work in, and not a third` used before that test went with
    // `resizeTeam`; nothing on the usage side replaced it, and the single-project
    // fixtures the other three capacity tests use cannot tell the two answers
    // apart.
    //
    // Proof: `directoryUsageOfTeam`'s per-project lookup replaced by "any project
    // stated something" (`[...rows.capacityOf.values()].at(0)`), which is the
    // fault R5 row 9 names and which left **693 pass, 0 fail** before this test
    // existed. The same injection is now **695 pass, 1 fail**, and the one is
    // this: `Roof`'s `Shingle` row carries a second effect,
    // `{ kind: 'capacity_released', size: 4, fromId: <its own id> }`, naming a
    // pool for a plan that stated none — `Rollout`'s four, printed on somebody
    // else's rows. Watched 2026-08-13.
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const roof = await roofProject();
    await workItems.patch('design', { serviceTeamId: platform.id });
    await workItems.patch(roof.workItemOf, { serviceTeamId: platform.id });
    // Stated on `Rollout` and deliberately nowhere else.
    await capacity.set(projectId, platform.id, 4);

    const outcome = await directory.removeTeam(platform.id, false);

    if (outcome.ok) throw new Error('expected the removal to be refused');
    if (outcome.reason !== 'in_use') throw new Error(`refused for ${outcome.reason}`);
    expect(outcome.usage.projects).toEqual([
      {
        id: projectId,
        name: 'Rollout',
        workItems: [
          {
            id: 'design',
            number: '010',
            name: 'Design',
            effects: [
              { kind: 'label_nulled' },
              { kind: 'capacity_released', size: 4, fromId: 'design' },
            ],
          },
        ],
      },
      {
        id: roof.projectOf,
        name: 'Roof',
        workItems: [
          {
            id: roof.workItemOf,
            number: '010',
            name: 'Shingle',
            // The label goes and nothing else does: this plan never stated how
            // many of the team it had, so no pool leaves with the team and no
            // date here moves.
            effects: [{ kind: 'label_nulled' }],
          },
        ],
      },
    ]);
  });

  it('says nothing about capacity when the team was never sized', async () => {
    // The negative half, and the reason the size is read off the team row
    // rather than guessed from the work items: an unsized team bounds nothing,
    // so its removal moves no date and there is no effect to name. Without this
    // the capacity effect would be unconditional and would claim a plan moved
    // when it did not.
    const team = await directory.addTeam('Platform');
    if (team === null) throw new Error('the fixture team was refused');
    await workItems.insert({ ...newItem('api', 10, 'API'), parentId: 'design' }, []);
    await workItems.patch('design', { serviceTeamId: team.id });

    const outcome = await directory.removeTeam(team.id, false);

    if (outcome.ok) throw new Error('expected the removal to be refused');
    if (outcome.reason !== 'in_use') throw new Error(`refused for ${outcome.reason}`);
    expect(outcome.usage.projects.flatMap((each) => each.workItems)).toEqual([
      { id: 'design', number: '010', name: 'Design', effects: [{ kind: 'label_nulled' }] },
    ]);
  });

  it('recounts the capacity effect when a size lands between two refusals', async () => {
    // The usage is read inside the transaction that refuses, every time, rather
    // than answered from anything the first call worked out. A size written
    // between the two is exactly the change a caller who confirmed against the
    // first answer would never have been shown.
    const team = await directory.addTeam('Platform');
    if (team === null) throw new Error('the fixture team was refused');
    await workItems.patch('design', { serviceTeamId: team.id });

    const first = await directory.removeTeam(team.id, false);
    if (first.ok || first.reason !== 'in_use') throw new Error('expected an in-use refusal');
    expect(first.usage.projects[0]?.workItems[0]?.effects).toEqual([{ kind: 'label_nulled' }]);

    await capacity.set(projectId, team.id, 3);

    const second = await directory.removeTeam(team.id, false);
    if (second.ok || second.reason !== 'in_use') throw new Error('expected an in-use refusal');
    expect(second.usage.projects[0]?.workItems[0]?.effects).toEqual([
      { kind: 'label_nulled' },
      { kind: 'capacity_released', size: 3, fromId: 'design' },
    ]);
  });

  it('refuses a team nothing but memberships points at, naming the people', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const kat = await added('Kat', [platform.id]);
    const ada = await added('Ada', [platform.id]);

    const outcome = await directory.removeTeam(platform.id, false);

    // A confirmation showing an empty impact list while two memberships were
    // about to be dropped is a confirmation of nothing.
    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      usage: {
        projects: [],
        members: [
          { id: ada.id, name: 'Ada' },
          { id: kat.id, name: 'Kat' },
        ],
      },
    });
    expect((await store.listTeams()).map((each) => each.name)).toEqual(['Platform']);
  });

  it('removes a person on the second, explicit call, and moves what lost a row', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const kat = await added('Kat', []);
    await directory.patchPerson(kat.id, { teamIds: [platform.id] });
    await store.assign('design', devId, kat.id);
    const before = (await workItems.findById('design'))?.revision;

    expect(await directory.removePerson(kat.id, false)).toMatchObject({ reason: 'in_use' });
    expect(await directory.removePerson(kat.id, true)).toEqual({ ok: true });

    expect(await store.listPeople()).toEqual([]);
    expect(await store.assignmentsOf(['design'])).toEqual([]);
    // The revision moved so that a journal entry holding the old one refuses as
    // stale rather than undoing against a directory that has changed.
    expect((await workItems.findById('design'))?.revision).toBe((before ?? 0) + 1);
  });

  it('refuses a removal when an assignment lands after the count', async () => {
    // The gap the confirmation opens, from the other side. The service counts
    // first as a fast path, and somebody assigns the doomed person in the
    // moment between that count and the delete. An unconfirmed request must
    // still refuse: it was never consent to take anything, and what it would
    // take is an assignment nobody has been shown.
    const kat = await added('Kat', []);
    const service = new DirectoryService({
      broadcast,
      directory: storeWith({
        async usageOfPerson(watched) {
          const counted = await store.usageOfPerson(watched);
          await store.assign('design', devId, kat.id);
          return counted;
        },
      }),
    });

    const outcome = await service.removePerson(kat.id, false);

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    // Named, not merely refused: the whole point of the second call is that the
    // person confirming has seen what it takes.
    expect(outcome.usage.projects[0]?.workItems[0]?.effects).toContainEqual({
      kind: 'assignment_dropped',
      role: { id: devId, name: 'Dev' },
    });
    expect(await personNamed('Kat')).toBe(kat.id);
    expect(await store.assignmentsOf(['design'])).toHaveLength(1);
  });

  it('takes a late assignment with it when the call is confirmed', async () => {
    // The same interleave, with `cascade`. This is not the fault above: the
    // caller has already agreed to take what points at this person, and an
    // assignment landing a moment later is exactly what that agreement covers.
    const kat = await added('Kat', []);
    const service = new DirectoryService({
      broadcast,
      directory: storeWith({
        async removePerson(watched, cascade) {
          await store.assign('design', devId, kat.id);
          return store.removePerson(watched, cascade);
        },
      }),
    });

    expect(await service.removePerson(kat.id, true)).toEqual({ ok: true });
    expect(await store.assignmentsOf(['design'])).toEqual([]);
    expect(await store.listPeople()).toEqual([]);
  });

  it('refuses the loser of two removals of one person', async () => {
    const kat = await added('Kat', []);
    await store.removePerson(kat.id, true);

    expect(await directory.removePerson(kat.id, true)).toEqual({ ok: false, reason: 'not_found' });
  });

  it("a cascade nulls every label and moves those work items' revisions", async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const roof = await roofProject();
    // A member as well as two labels, so the cascade has both kinds to take.
    await added('Kat', [platform.id]);
    await workItems.patch('design', { serviceTeamId: platform.id });
    await workItems.patch(roof.workItemOf, { serviceTeamId: platform.id });
    const before = (await workItems.findById('design'))?.revision ?? 0;

    expect(await directory.removeTeam(platform.id, false)).toMatchObject({ reason: 'in_use' });
    expect(await directory.removeTeam(platform.id, true)).toEqual({ ok: true });

    expect(await store.listTeams()).toEqual([]);
    // `work_item.service_team_id` has no foreign key, so nothing but this
    // transaction would ever have cleaned these up: a dangling id is what the
    // database would happily have left behind.
    expect((await workItems.findById('design'))?.serviceTeamId).toBeNull();
    expect((await workItems.findById(roof.workItemOf))?.serviceTeamId).toBeNull();
    expect((await workItems.findById('design'))?.revision).toBe(before + 1);
    expect((await store.listPeople()).at(0)?.teamIds).toEqual([]);
  });

  it('refuses a team removal when a membership or a label lands after the count', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const kat = await added('Kat', []);

    const labelled = new DirectoryService({
      broadcast,
      directory: storeWith({
        async usageOfTeam(watched) {
          const counted = await store.usageOfTeam(watched);
          await workItems.patch('design', { serviceTeamId: platform.id });
          return counted;
        },
      }),
    });
    const label = await labelled.removeTeam(platform.id, false);

    if (label.ok || label.reason !== 'in_use') throw new Error('the label removal was not refused');
    expect(label.usage.projects[0]?.workItems[0]).toMatchObject({
      id: 'design',
      effects: [{ kind: 'label_nulled' }],
    });
    expect((await workItems.findById('design'))?.serviceTeamId).toBe(platform.id);

    await workItems.patch('design', { serviceTeamId: null });
    const joined = new DirectoryService({
      broadcast,
      directory: storeWith({
        async usageOfTeam(watched) {
          const counted = await store.usageOfTeam(watched);
          await store.patchPerson(kat.id, { teamIds: [platform.id] });
          return counted;
        },
      }),
    });
    const member = await joined.removeTeam(platform.id, false);

    if (member.ok || member.reason !== 'in_use') {
      throw new Error('the membership removal was not refused');
    }
    expect(member.usage.members).toEqual([{ id: kat.id, name: 'Kat' }]);
    expect((await store.listTeams()).map((each) => each.name)).toEqual(['Platform']);
  });

  it('removes a team nothing points at, and refuses the loser of two removals', async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');

    expect(await directory.removeTeam(platform.id, false)).toEqual({ ok: true });
    expect(await directory.removeTeam(platform.id, true)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it("does not count a person's own memberships against them", async () => {
    const platform = await directory.addTeam('Platform');
    if (platform === null) throw new Error('the fixture team was refused');
    const kat = await added('Kat', [platform.id]);

    // Her membership names nobody else and goes with her, so it forces no
    // confirmation — the person is removed on the first call.
    expect(await directory.removePerson(kat.id, false)).toEqual({ ok: true });
    expect(await store.listPeople()).toEqual([]);
  });
});

describe('removing a tag: what it names, and what it cannot move', () => {
  /** A tag in the global directory, or a throw — a refused fixture is not a result. */
  const tagged = async (name: string) => {
    const made = await directory.addTag(name);
    if (made === null) throw new Error(`the fixture tag ${name} was refused`);
    return made;
  };

  it('removes a tag nothing carries on the first press', async () => {
    // One clause fewer than a team's refusal: there are no members to count,
    // because nobody belongs to a tag. So an unused tag goes without a
    // confirmation, where an unused team with people in it does not.
    const regulatory = await tagged('regulatory');

    expect(await directory.removeTag(regulatory.id, false)).toEqual({ ok: true });
    expect(await store.listTags()).toEqual([]);
  });

  it('refuses an unconfirmed removal, naming the rows that would be unlabelled', async () => {
    const regulatory = await tagged('regulatory');
    await workItems.patch('design', { tagIds: [regulatory.id] });

    const outcome = await directory.removeTag(regulatory.id, false);

    // `label_removed` and **nothing beside it**. This assertion is the model
    // rule written as a payload: no `capacity_released` arm, no size, and no
    // second effect of any kind. A tag with a pool would have to change this
    // test to ship.
    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      usage: {
        projects: [
          {
            id: projectId,
            name: 'Rollout',
            workItems: [
              { id: 'design', number: '010', name: 'Design', effects: [{ kind: 'label_removed' }] },
            ],
          },
        ],
        members: [],
      },
    });
    expect(await store.listTags()).toEqual([{ id: regulatory.id, name: 'regulatory' }]);
  });

  it('names a row that carries the tag among others, whichever member it is', async () => {
    // The `teamIds.at(0)` fault, one dimension over: a work item carrying two
    // tags loses one label per removal, and a reader of the first member would
    // report nothing at all for the second of them.
    const regulatory = await tagged('regulatory');
    const techDebt = await tagged('tech-debt');
    await workItems.patch('design', { tagIds: [regulatory.id, techDebt.id] });

    const outcome = await directory.removeTag(techDebt.id, false);

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    expect(outcome.usage.projects[0]?.workItems[0]?.effects).toEqual([{ kind: 'label_removed' }]);
  });

  it('does not name a row that only inherits the tag, because nothing of its moves', async () => {
    // **The one place this deliberately differs from a team removal.** A team's
    // usage names rows carrying no label of their own, because an inherited pool
    // moves their dates and a confirmation listing one row while twenty move
    // would be a confirmation of nothing. Losing an inherited *tag* moves
    // nothing: the row stops being findable under that facet and every date it
    // has stays where it was. So the confirmation names the row that carries the
    // label, and no others.
    const regulatory = await tagged('regulatory');
    await workItems.insert({ ...newItem('cladding', 30, 'Cladding'), parentId: 'design' }, []);
    await workItems.patch('design', { tagIds: [regulatory.id] });

    const outcome = await directory.removeTag(regulatory.id, false);

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    expect(outcome.usage.projects[0]?.workItems.map((each) => each.id)).toEqual(['design']);
  });

  it('takes the labelling with the tag on ?cascade=1, and moves every row’s revision', async () => {
    // The cascade does the deleting — `work_item_tag.tag_id` carries it — but a
    // cascade moves no revision, so the removal bumps the rows itself. Without
    // that a journal entry holding the old number would undo against a plan
    // whose labelling had changed under it, which is the stale-undo failure this
    // repo has already shipped once for people.
    const regulatory = await tagged('regulatory');
    await workItems.patch('design', { tagIds: [regulatory.id] });
    const before = (await workItems.listByProject(projectId)).find((row) => row.id === 'design');

    expect(await directory.removeTag(regulatory.id, true)).toEqual({ ok: true });

    const after = (await workItems.listByProject(projectId)).find((row) => row.id === 'design');
    expect(after?.tagIds).toEqual([]);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(await store.listTags()).toEqual([]);
  });

  it('refuses a rename onto a name another tag holds, and writes nothing', async () => {
    await tagged('regulatory');
    const techDebt = await tagged('tech-debt');

    const outcome = await directory.renameTag(techDebt.id, 'regulatory');

    expect(outcome).toEqual({ ok: false, reason: 'taken', name: 'regulatory' });
    expect((await store.listTags()).map((each) => each.name)).toEqual(['regulatory', 'tech-debt']);
  });

  it('adds a tag idempotently by name, trimming what it is given', async () => {
    const first = await tagged('regulatory');
    const again = await tagged('  regulatory  ');

    // The row that is there, not a second one: two people typing `regulatory`
    // at the same moment both pass a check-then-insert, and the unique index is
    // what stops the second.
    expect(again).toEqual(first);
    expect(await store.listTags()).toEqual([{ id: first.id, name: 'regulatory' }]);
  });
});

describe('removing a service: what it names, what it takes, and what it cannot move', () => {
  /** A service in the global directory, or a throw — a refused fixture is not a result. */
  const serviceNamed = async (name: string) => {
    const made = await directory.addService(name);
    if (made === null) throw new Error(`the fixture service ${name} was refused`);
    return made;
  };

  it('does not name a row that only inherits the service, because nothing of its moves', async () => {
    // The tag's rule, and since task 10.2 it *is* the tag's rule rather than a
    // stronger one: the removal deletes `work_item_service` rows, and the only
    // rows it touches are the rows that state the service. A leaf inheriting the
    // label keeps every date it has and holds no join row of its own, so there
    // is nothing to confirm.
    const payments = await serviceNamed('Payments');
    await workItems.insert({ ...newItem('cladding', 30, 'Cladding'), parentId: 'design' }, []);
    await workItems.patch('design', { serviceIds: [payments.id] });

    const outcome = await directory.removeService(payments.id, false);

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    expect(outcome.usage.projects[0]?.workItems.map((each) => each.id)).toEqual(['design']);
  });

  it('empties the set on ?cascade and moves every row’s revision', async () => {
    // The cascade on `work_item_service.service_id` does the clearing, but a
    // foreign key moves no revision — so the removal bumps the rows itself.
    // Without that a journal entry holding the old number would undo against a
    // row whose services had changed under it, which is the stale undo this repo
    // has already shipped once for people.
    //
    // "Empties" and not "nulls" since task 10.2, and the name of this case moved
    // with the mechanism: a set member is removed where a column was nulled, and
    // `directoryUsageOfService` reports `label_removed` for the same reason.
    const payments = await serviceNamed('Payments');
    await workItems.patch('design', { serviceIds: [payments.id] });
    const before = (await workItems.listByProject(projectId)).find((row) => row.id === 'design');

    expect(await directory.removeService(payments.id, true)).toEqual({ ok: true });

    const after = (await workItems.listByProject(projectId)).find((row) => row.id === 'design');
    expect(after?.serviceIds).toEqual([]);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(await store.listServices()).toEqual([]);
  });

  it('takes the ownership rows with it and never mentions them in the confirmation', async () => {
    // design.md D7, both halves. The `team_service` rows go — their foreign key
    // cascades — and they are **not** in the usage: an ownership claim about a
    // service that is being deleted is not an effect on any plan, and putting it
    // in the confirmation would ask somebody to weigh a fact that goes with its
    // own subject.
    //
    // The row is written straight to the table because the write path for it is
    // task 4.3; what is under test here is the removal, not the map's editor.
    const payments = await serviceNamed('Payments');
    const platform = await store.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    db.insert(teamService).values({ teamId: platform.id, serviceId: payments.id }).run();
    await workItems.patch('design', { serviceIds: [payments.id] });

    const refused = await directory.removeService(payments.id, false);

    if (refused.ok || refused.reason !== 'in_use') throw new Error('the removal was not refused');
    // One work item, one effect, and nothing about Platform anywhere in it.
    expect(refused.usage).toEqual({
      projects: [
        {
          id: projectId,
          name: 'Rollout',
          workItems: [
            // `label_removed`, task 10.5's word: the removal takes a
            // `work_item_service` row, and a member removed is not a column
            // nulled. Every other `label_nulled` in this file is the **team**
            // dimension's, whose column really is nulled — the two words are
            // told apart here rather than made to match.
            { id: 'design', number: '010', name: 'Design', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    });

    expect(await directory.removeService(payments.id, true)).toEqual({ ok: true });
    // The team survives its ownership claim; only the claim goes.
    expect(db.select().from(teamService).all()).toEqual([]);
    expect((await store.listTeams()).map((each) => each.name)).toEqual(['Platform']);
  });

  it('refuses a rename onto a name another service holds, and writes nothing', async () => {
    await serviceNamed('Payments');
    const auth = await serviceNamed('Auth');

    expect(await directory.renameService(auth.id, 'Payments')).toEqual({
      ok: false,
      reason: 'taken',
      name: 'Payments',
    });
    expect((await store.listServices()).map((each) => each.name)).toEqual(['Auth', 'Payments']);
  });

  it('tells every project holding a labelled row that its directory changed', async () => {
    // The rename's `projectIds` are read inside its own transaction, so what is
    // announced is the set of plans that named the service when it happened.
    // `capacity_changed` is never among them: no date moves.
    const payments = await serviceNamed('Payments');
    await workItems.patch('design', { serviceIds: [payments.id] });
    broadcast.published.length = 0;

    await directory.renameService(payments.id, 'Billing');

    expect(broadcast.published).toEqual([{ projectId, event: { type: 'directory_changed' } }]);
  });
});
