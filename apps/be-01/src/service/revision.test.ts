import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Role, WorkItem } from '../repository';
import { ActualRepository } from '../repository/actual';
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
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { personAdded } from '../testing/directory-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { ProjectService } from './project.service';
import { RoleService } from './role.service';
import { WorkItemService } from './work-item.service';

/**
 * The revision battery: every mutation the API offers, and exactly which
 * revisions it moves.
 *
 * **Against real SQLite, and only there.** The bump is `revision = revision + 1`
 * inside the statement that makes the change, so a Map-backed fixture asserting
 * it would be asserting a second implementation of the rule — the in-memory
 * stores in `src/testing/` deliberately model no revisions at all, for the same
 * reason `subtree-fixture.ts` refuses to claim atomicity it cannot have.
 *
 * The **not-moving** assertions carry as much weight as the moving ones. A
 * counter that goes up on everything is a counter nobody can put a precondition
 * on: opening a project, respacing a sibling, or copying a branch would each
 * defeat a write that had nothing to do with them.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let path: string;
let workItems: WorkItemService;
let projects: ProjectService;
let roleService: RoleService;
let projectStore: ProjectRepository;
let workItemStore: WorkItemRepository;
let estimateStore: EstimateRepository;
let actualStore: ActualRepository;
let measureStore: RoleMeasureRepository;
let progressStore: RoleProgressRepository;
let projectId: string;
let ownerId: string;
let roles: Role[];

/** The first role every project starts with, which the estimate cases write to. */
const dev = (): string => {
  const found = roles.at(0);
  if (found === undefined) throw new Error('the project was created without its starting roles');
  return found.id;
};

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-revision-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);

  projectStore = new ProjectRepository(db);
  workItemStore = new WorkItemRepository(db);
  estimateStore = new EstimateRepository(db);
  actualStore = new ActualRepository(db);
  measureStore = new RoleMeasureRepository(db);
  progressStore = new RoleProgressRepository(db);
  const dependencies = new DependencyRepository(db);
  const directory = new DirectoryRepository(db);

  ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });

  projects = new ProjectService({ projects: projectStore });
  roleService = new RoleService({
    projects: projectStore,
    roles: new RoleRepository(db),
    broadcast: recordingBroadcaster(),
  });
  workItems = new WorkItemService({
    workItems: workItemStore,
    projects: projectStore,
    estimates: estimateStore,
    actuals: actualStore,
    measures: measureStore,
    progress: progressStore,
    directory,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    dependencies,
    subtrees: new SubtreeRepository(db),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });

  const created = await projects.create('Rewire the shed', ownerId);
  projectId = created.project.id;
  roles = created.roles;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The stored revision of one work item. Throws rather than defaulting: an absent row is a bug in the test. */
async function revisionOf(id: string): Promise<number> {
  const found = await workItemStore.findById(id);
  if (found === null) throw new Error(`no work item ${id}`);
  return found.revision;
}

async function projectRevision(): Promise<number> {
  const found = await projectStore.findById(projectId);
  if (found === null) throw new Error(`no project ${projectId}`);
  return found.revision;
}

/** Creates a root work item and answers its id, failing loudly on a refusal. */
async function root(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await workItems.create(projectId, ownerId, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`);
  return outcome.result.id;
}

async function child(parentId: string, name: string): Promise<string> {
  const outcome = await workItems.create(projectId, ownerId, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`);
  return outcome.result.id;
}

describe('what a create starts at', () => {
  it('starts a project and a work item at 0', async () => {
    const strip = await root('Strip');

    expect(await projectRevision()).toBe(0);
    expect(await revisionOf(strip)).toBe(0);
  });

  it('creates a work item without moving the project or its siblings', async () => {
    const strip = await root('Strip');

    const cable = await root('Cable', strip);

    expect(await revisionOf(strip)).toBe(0);
    expect(await revisionOf(cable)).toBe(0);
    expect(await projectRevision()).toBe(0);
  });

  /**
   * A first child is 1, not 0, and that is the honest reading: the estimate
   * handoff is a second write, and the child genuinely holds figures it did not
   * hold a statement earlier. The parent moves for the same reason — it no
   * longer holds them.
   */
  it('hands the estimate down to a first child, moving both', async () => {
    const strip = await root('Strip');
    const outcome = await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    expect(outcome.ok).toBe(true);
    const before = await revisionOf(strip);

    const sockets = await child(strip, 'Sockets');

    expect(await revisionOf(sockets)).toBe(1);
    expect(await revisionOf(strip)).toBe(before + 1);
  });
});

describe('what a work item write moves', () => {
  it('moves the item it patched and no other', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);

    const outcome = await workItems.patch(strip, ownerId, { name: 'Strip out' });

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(strip)).toBe(1);
    expect(await revisionOf(cable)).toBe(0);
  });

  it('counts every patch, so three edits read as three', async () => {
    const strip = await root('Strip');

    await workItems.patch(strip, ownerId, { name: 'One' });
    await workItems.patch(strip, ownerId, { notes: 'Two' });
    await workItems.patch(strip, ownerId, { serviceTeamId: null });

    expect(await revisionOf(strip)).toBe(3);
  });

  it('moves the work item that moved', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);

    const outcome = await workItems.move(cable, ownerId, { parentId: strip, afterId: null });

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(cable)).toBe(1);
  });

  /**
   * The rule the whole design rests on: a respaced sibling keeps its revision.
   *
   * Its `position` changed and so, quite possibly, did the number a reader sees
   * for it — but position is storage detail and the number is derived from the
   * whole tree. A revision that followed the derived number would move on every
   * row of the project for one insertion, and a precondition on it would then
   * only ever pass for whoever wrote last.
   *
   * Asserted at the repository, because that is the layer that is handed the
   * respacing: reaching a respace through the service needs a sibling group with
   * no gaps left in it, which proves nothing extra.
   */
  it('leaves a respaced sibling where it was', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    const survey = await root('Survey', cable);

    await workItemStore.move(survey, null, 15, [
      { id: strip, position: 10 },
      { id: cable, position: 30 },
    ]);

    expect(await revisionOf(survey)).toBe(1);
    expect(await revisionOf(strip)).toBe(0);
    expect(await revisionOf(cable)).toBe(0);
  });

  it('leaves the siblings an insertion respaced where they were', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);

    const inserted: WorkItem = {
      id: crypto.randomUUID(),
      projectId,
      parentId: null,
      position: 20,
      name: 'Survey',
      notes: '',
      frozenNumber: null,
      priority: null,
      startNoEarlierThan: null,
      serviceTeamId: null,
      serviceId: null,
      maxParallel: 1,
      revision: 0,
    };
    await workItemStore.insert(inserted, [
      { id: strip, position: 10 },
      { id: cable, position: 30 },
    ]);

    expect(await revisionOf(inserted.id)).toBe(0);
    expect(await revisionOf(strip)).toBe(0);
    expect(await revisionOf(cable)).toBe(0);
  });

  it('moves the children a deletion promoted', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    const cable = await root('Cable', strip);
    const before = await revisionOf(sockets);

    const outcome = await workItems.remove(strip, ownerId, 'promote');

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(sockets)).toBe(before + 1);
    // The former sibling was respaced into the promoted group and nothing else.
    expect(await revisionOf(cable)).toBe(0);
  });
});

describe('what a freeze moves', () => {
  it('moves the rows it wrote a number onto, and leaves the ones already frozen', async () => {
    const strip = await root('Strip');
    await workItems.freeze(projectId, ownerId);
    const cable = await root('Cable', strip);

    const outcome = await workItems.freeze(projectId, ownerId);

    expect(outcome.ok).toBe(true);
    // Frozen once. The second freeze writes only what was still deriving, which
    // is what lets a project be frozen, planned into, and frozen again.
    expect(await revisionOf(strip)).toBe(1);
    expect(await revisionOf(cable)).toBe(1);
  });

  it('moves a work item returned to deriving', async () => {
    const strip = await root('Strip');
    await workItems.freeze(projectId, ownerId);

    const outcome = await workItems.unfreeze(strip, ownerId);

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(strip)).toBe(2);
  });
});

describe('what an estimate moves', () => {
  it('moves the work item it is on and no other', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);

    await workItems.setEstimate(strip, ownerId, dev(), DAYS);

    expect(await revisionOf(strip)).toBe(1);
    expect(await revisionOf(cable)).toBe(0);
  });

  it('moves it again when the trio is cleared', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);

    await workItems.clearEstimate(strip, ownerId, dev());

    expect(await revisionOf(strip)).toBe(2);
  });

  /**
   * The counter is arithmetic in the database, not a number this process chose.
   *
   * Two `EstimateRepository`s on two connections to one file, neither of which
   * has read the row: each write leaves `revision + 1` behind, so the second
   * lands on what the first wrote rather than on what its own process last saw.
   *
   * **The honest limit.** `bun:sqlite` is synchronous and in-process, so two
   * writers cannot actually be raced here — this does not observe a lost update,
   * and no test in this repo does. What it observes is the property that makes a
   * lost update impossible: the new value is computed by SQLite from the row's
   * current contents. The fault that breaks it is the bump written as a value
   * this process worked out, which passes every single-write assertion above and
   * fails here; see `verify.md`.
   */
  it('leaves the counter at 2 after two writes through two connections', async () => {
    const strip = await root('Strip');
    const first = new EstimateRepository(openDrizzle(path));
    const second = new EstimateRepository(openDrizzle(path));

    await first.set({ workItemId: strip, roleId: dev(), ...DAYS });
    await second.set({
      workItemId: strip,
      roleId: dev(),
      optimistic: 2,
      realistic: 4,
      pessimistic: 6,
    });

    expect(await revisionOf(strip)).toBe(2);
  });

  it('takes the estimates back when the last child goes, moving the parent', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    await workItems.setEstimate(sockets, ownerId, dev(), DAYS);
    const before = await revisionOf(strip);

    const outcome = await workItems.remove(sockets, ownerId, 'cascade');

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(strip)).toBe(before + 1);
  });
});

describe('what an assignment moves', () => {
  it('moves the work item assigned, and no other', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    const person = await personAdded(
      new DirectoryRepository(openDrizzle(path)).addPerson(
        { id: crypto.randomUUID(), name: 'Ada' },
        [],
      ),
    );

    await workItems.assign(strip, ownerId, dev(), person.id);

    expect(await revisionOf(strip)).toBe(1);
    expect(await revisionOf(cable)).toBe(0);

    await workItems.assign(strip, ownerId, dev(), null);

    expect(await revisionOf(strip)).toBe(2);
    expect(await revisionOf(cable)).toBe(0);
  });
});

describe('what a dependency moves', () => {
  it('moves both endpoints and no third row', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    const survey = await root('Survey', cable);

    const outcome = await workItems.addDependency(cable, ownerId, strip);

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(strip)).toBe(1);
    expect(await revisionOf(cable)).toBe(1);
    expect(await revisionOf(survey)).toBe(0);
  });

  it('moves both endpoints again when the edge is removed', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);

    await workItems.removeDependency(cable, ownerId, strip);

    expect(await revisionOf(strip)).toBe(2);
    expect(await revisionOf(cable)).toBe(2);
  });

  /**
   * A deletion takes every edge touching the doomed rows with it, and the work
   * items at the *other* ends survive with one fewer dependency than they had.
   * They are the ones that read differently afterwards, so they are the ones
   * that move.
   */
  it('moves what still depended on a work item that was deleted', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);
    const before = await revisionOf(cable);

    const outcome = await workItems.remove(strip, ownerId, 'cascade');

    expect(outcome.ok).toBe(true);
    expect(await revisionOf(cable)).toBe(before + 1);
  });
});

describe('what a duplicate does not move', () => {
  it('copies a branch at 0 and leaves the original where it was', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    await workItems.setEstimate(sockets, ownerId, dev(), DAYS);
    const stripBefore = await revisionOf(strip);
    const socketsBefore = await revisionOf(sockets);

    const outcome = await workItems.duplicate(strip, ownerId);

    if (!outcome.ok) throw new Error(`duplicate refused: ${outcome.reason}`);
    expect(await revisionOf(outcome.result.id)).toBe(0);
    // A copy does not change what it was copied from. This is the assertion
    // that keeps `duplicate` from defeating a precondition somebody else holds
    // on the original.
    expect(await revisionOf(strip)).toBe(stripBefore);
    expect(await revisionOf(sockets)).toBe(socketsBefore);
  });
});

describe('what a project write moves', () => {
  it('moves the project on each of its own fields', async () => {
    await projects.update(projectId, ownerId, { name: 'Rewire the shed, properly' });
    expect(await projectRevision()).toBe(1);

    await projects.update(projectId, ownerId, { restricted: true });
    expect(await projectRevision()).toBe(2);

    await projects.update(projectId, ownerId, { estimateMethod: 'pessimistic' });
    expect(await projectRevision()).toBe(3);

    await projects.update(projectId, ownerId, { startDate: '2026-08-10' });
    expect(await projectRevision()).toBe(4);
  });

  /**
   * Navigation history, not a change to the plan. If opening a project moved
   * it, a second tab would defeat every conditional write anybody made.
   */
  it('does not move the project when somebody opens it', async () => {
    const opened = await projects.open(projectId, ownerId);

    expect(opened).toBe(true);
    expect(await projectRevision()).toBe(0);
  });

  it('does not move the project when a work item under it changes', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);

    expect(await projectRevision()).toBe(0);
  });

  it('does not move a work item when the project it is in changes', async () => {
    const strip = await root('Strip');

    await projects.update(projectId, ownerId, { name: 'Renamed' });

    expect(await revisionOf(strip)).toBe(0);
  });
});

describe('what a role write moves', () => {
  it('moves the project on each role write, and no work item on an add or a rename', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    const estimated = await revisionOf(strip);

    const added = await roleService.add(projectId, ownerId, 'Design');
    if (!added.ok) throw new Error(`add refused: ${added.reason}`);
    expect(await projectRevision()).toBe(1);

    const renamed = await roleService.rename(projectId, added.result.id, ownerId, 'Drawing');
    if (!renamed.ok) throw new Error(`rename refused: ${renamed.reason}`);
    expect(await projectRevision()).toBe(2);

    // A role arriving or being renamed writes nothing of any work item's: no
    // stored field of theirs moved and no satellite of theirs was written, so a
    // precondition on a row somebody is editing must survive it.
    expect(await revisionOf(strip)).toBe(estimated);
  });

  it('moves the project and only the work items a removal emptied', async () => {
    const strip = await root('Strip');
    const sand = await root('Sand');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    const stripBefore = await revisionOf(strip);
    const sandBefore = await revisionOf(sand);
    const projectBefore = await projectRevision();

    const removed = await roleService.remove(projectId, dev(), ownerId, true);
    expect(removed).toEqual({ ok: true });

    expect(await projectRevision()).toBe(projectBefore + 1);
    expect(await revisionOf(strip)).toBe(stripBefore + 1);
    // Held nothing of that role's, so nobody's reading of it changed.
    expect(await revisionOf(sand)).toBe(sandBefore);
  });
});

describe('what a reader is told', () => {
  it('reports every work item’s revision and the project’s in one read', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    await projects.update(projectId, ownerId, { name: 'Renamed' });

    const tree = await workItems.tree(projectId);

    expect(tree?.projectRevision).toBe(1);
    expect(tree?.workItems.map((row) => [row.id, row.revision])).toEqual([[strip, 1]]);
  });
});
