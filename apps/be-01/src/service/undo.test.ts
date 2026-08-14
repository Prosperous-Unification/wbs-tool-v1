import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { JournalEntry, Role, WorkItem } from '../repository';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { commandJournal } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { personAdded } from '../testing/directory-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { ProjectService } from './project.service';
import { type UndoOutcome, WorkItemService } from './work-item.service';

/**
 * Conditional undo, end to end, **against real SQLite**.
 *
 * It has to be. The whole mechanism rests on `work_item.revision`, which is
 * `revision + 1` inside the statement that makes the change — the in-memory
 * stores in `src/testing/` deliberately model no revisions at all, so a
 * staleness assertion against them would read 0 forever and pass no matter
 * what this file did. `revision.test.ts` makes the same call for the same
 * reason.
 *
 * The **refusals** carry more weight here than the successes. An undo that
 * restores is a convenience; an undo that quietly overwrites somebody's newer
 * edit is the failure two reviewers independently refused to ship, and every
 * `stale_undo` case below is one of the ways that was going to happen.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let path: string;
let workItems: WorkItemService;
let projects: ProjectService;
let workItemStore: WorkItemRepository;
let estimateStore: EstimateRepository;
let dependencyStore: DependencyRepository;
let directoryStore: DirectoryRepository;
let journalStore: CommandJournalRepository;
let projectId: string;
let ownerId: string;
let strangerId: string;
let roles: Role[];

/** The first role every project starts with, which the estimate cases write to. */
const dev = (): string => {
  const found = roles.at(0);
  if (found === undefined) throw new Error('the project was created without its starting roles');
  return found.id;
};

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };
const OTHER_DAYS = { optimistic: 4, realistic: 5, pessimistic: 6 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-undo-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);

  const projectStore = new ProjectRepository(db);
  workItemStore = new WorkItemRepository(db);
  estimateStore = new EstimateRepository(db);
  dependencyStore = new DependencyRepository(db);
  directoryStore = new DirectoryRepository(db);
  journalStore = new CommandJournalRepository(db);

  const users = new UserRepository(db);
  ownerId = crypto.randomUUID();
  await users.create({ id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 });
  // Somebody else on the same plan. The project is not restricted, so they may
  // edit it — which is the only reason any of the staleness cases below exist.
  strangerId = crypto.randomUUID();
  await users.create({ id: strangerId, username: 'stranger', passwordHash: 'x', createdAt: 2 });

  projects = new ProjectService({ projects: projectStore });
  workItems = new WorkItemService({
    workItems: workItemStore,
    projects: projectStore,
    estimates: estimateStore,
    directory: directoryStore,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    dependencies: dependencyStore,
    subtrees: new SubtreeRepository(db),
    journal: journalStore,
    broadcast: recordingBroadcaster(),
  });

  const created = await projects.create('Rewire the shed', ownerId);
  projectId = created.project.id;
  roles = created.roles;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function root(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await workItems.create(projectId, ownerId, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`);
  return outcome.result.id;
}

/** `afterId` is which sibling it lands after; null means first, as the API means it. */
async function child(
  parentId: string,
  name: string,
  afterId: string | null = null,
): Promise<string> {
  const outcome = await workItems.create(projectId, ownerId, { parentId, afterId, name });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`);
  return outcome.result.id;
}

/** Every row of the project, so a test can say what the tree looks like now. */
const rows = (): Promise<WorkItem[]> => workItemStore.listByProject(projectId);

const found = async (id: string): Promise<WorkItem | null> => workItemStore.findById(id);

const namesByPosition = async (parentId: string | null): Promise<string[]> =>
  (await rows())
    .filter((row) => row.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((row) => row.name);

const edges = async (): Promise<[string, string][]> =>
  (await dependencyStore.listByProject(projectId)).map((edge) => [
    edge.predecessorId,
    edge.successorId,
  ]);

/** Undo, failing the test loudly rather than letting a refusal read as a pass. */
async function undone(): Promise<UndoOutcome> {
  return workItems.undo(projectId, ownerId);
}

function expectDone(outcome: UndoOutcome): string {
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason} — ${outcome.detail ?? ''}`);
  return outcome.result.done;
}

function expectStale(outcome: UndoOutcome): string {
  if (outcome.ok) throw new Error(`expected a refusal, got: ${outcome.result.done}`);
  expect(outcome.reason).toBe('stale_undo');
  if (outcome.detail === null) throw new Error('a stale refusal said nothing about why');
  return outcome.detail;
}

/** The entry an undo would reach next for `userId`, or null. */
async function nextUndoable(userId = ownerId): Promise<JournalEntry | null> {
  const stack = await journalStore.entriesFor(projectId, userId);
  return [...stack].reverse().find((each) => !each.undone) ?? null;
}

describe('undoing each kind of change', () => {
  it('puts a renamed work item back, and says what it undid', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out the lot' });

    const outcome = await undone();

    expect(expectDone(outcome)).toBe('rename “Strip out the lot”');
    expect((await found(strip))?.name).toBe('Strip');
  });

  it('reverses only the fields the patch named', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { notes: 'first note' });
    // A second change, to a different field, by somebody else. Undoing the
    // note must not quietly put the old name back with it.
    await workItems.patch(strip, ownerId, { notes: 'second note' });
    await workItems.patch(strip, ownerId, { name: 'Strip out' });

    expect(expectDone(await undone())).toBe('rename “Strip out”');

    const after = await found(strip);
    expect(after?.name).toBe('Strip');
    expect(after?.notes).toBe('second note');
  });

  it('puts a replaced priority back, and leaves a priority a rename did not name', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { priority: 5 });
    await workItems.patch(strip, ownerId, { priority: 1 });

    expectDone(await undone());
    expect((await found(strip))?.priority).toBe(5);

    // And the other direction of the same rule: a rename undone must not carry
    // a priority somebody else set in between back with it.
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    await workItems.patch(strip, ownerId, { priority: 2 });
    expectDone(await undone());
    expect((await found(strip))?.priority).toBe(5);
    expectDone(await undone());
    const after = await found(strip);
    expect(after?.name).toBe('Strip');
    expect(after?.priority).toBe(5);
  });

  it('takes a first priority away again, rather than leaving a 1 behind', async () => {
    // Unranked is a state of its own, so undoing the first priority a work item
    // ever had has to put `null` back — not the smallest number, which would
    // be the tool inventing an opinion nobody wrote.
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { priority: 1 });

    expectDone(await undone());

    expect((await found(strip))?.priority).toBeNull();
  });

  it('puts a replaced parallelism back, and leaves one a rename did not name', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { maxParallel: 3 });
    await workItems.patch(strip, ownerId, { maxParallel: 5 });

    expectDone(await undone());
    expect((await found(strip))?.maxParallel).toBe(3);

    // The other direction of the same rule: a rename undone must not carry a
    // parallelism somebody else set in between back with it.
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    await workItems.patch(strip, ownerId, { maxParallel: 2 });
    expectDone(await undone());
    expect((await found(strip))?.maxParallel).toBe(3);
    expectDone(await undone());
    const after = await found(strip);
    expect(after?.name).toBe('Strip');
    expect(after?.maxParallel).toBe(3);
  });

  it('takes a first parallelism away again, rather than leaving a 3 behind', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { maxParallel: 3 });

    expectDone(await undone());

    // 1, not null: one at a time and *unset* are the same fact, which is why
    // the column is `NOT NULL DEFAULT 1` and why this is the only state before
    // the first write there is to go back to.
    expect((await found(strip))?.maxParallel).toBe(1);
  });

  it('puts a reset to one at a time back to the number it replaced', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { maxParallel: 4 });
    await workItems.patch(strip, ownerId, { maxParallel: null });
    expect((await found(strip))?.maxParallel).toBe(1);

    expectDone(await undone());

    expect((await found(strip))?.maxParallel).toBe(4);
  });

  it('refuses to undo a parallelism onto a row somebody else has since edited', async () => {
    // The precondition rule, on the new field: an undo that quietly overwrote a
    // stranger's newer edit is the failure this whole mechanism exists to
    // refuse, and a field added to `WorkItemPatch` without its revision being
    // checked would be a hole in it.
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { maxParallel: 3 });
    await workItems.patch(strip, strangerId, { name: 'Strip out' });

    expectStale(await undone());

    const after = await found(strip);
    expect(after?.maxParallel).toBe(3);
    expect(after?.name).toBe('Strip out');
  });

  it('puts a replaced estimate back exactly', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.setEstimate(strip, ownerId, dev(), OTHER_DAYS);

    expect(expectDone(await undone())).toBe('estimate “Strip”');

    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: strip, roleId: dev(), ...DAYS },
    ]);
  });

  it('takes a first estimate away again, rather than leaving a zero behind', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);

    expect(expectDone(await undone())).toBe('estimate “Strip”');

    expect(await estimateStore.listByProject(projectId)).toEqual([]);
  });

  it('puts a cleared estimate back', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.clearEstimate(strip, ownerId, dev());

    expect(expectDone(await undone())).toBe('clear the estimate on “Strip”');

    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: strip, roleId: dev(), ...DAYS },
    ]);
  });

  it('records nothing for a clear that had nothing to clear', async () => {
    const strip = await root('Strip');

    await workItems.clearEstimate(strip, ownerId, dev());

    // Nothing was put back, so there is nothing to put back — an entry here
    // would be a press of the key that visibly does nothing.
    expect((await allEntries()).map((each) => each.kind)).toEqual(['create']);
    expect(strip).not.toBe('');
  });

  it('puts an assignee back, and takes an added one away', async () => {
    const strip = await root('Strip');
    const alice = await person('Alice');
    const bob = await person('Bob');
    await workItems.assign(strip, ownerId, dev(), alice);
    await workItems.assign(strip, ownerId, dev(), bob);

    expect(expectDone(await undone())).toBe('assign “Strip”');
    expect(await directoryStore.assignmentsOf([strip])).toEqual([
      { workItemId: strip, roleId: dev(), personId: alice },
    ]);

    expect(expectDone(await undone())).toBe('assign “Strip”');
    expect(await directoryStore.assignmentsOf([strip])).toEqual([]);
  });

  it('puts a cleared assignee back', async () => {
    const strip = await root('Strip');
    const alice = await person('Alice');
    await workItems.assign(strip, ownerId, dev(), alice);
    await workItems.assign(strip, ownerId, dev(), null);

    expect(expectDone(await undone())).toBe('clear who does “Strip”');

    expect(await directoryStore.assignmentsOf([strip])).toEqual([
      { workItemId: strip, roleId: dev(), personId: alice },
    ]);
  });

  it('removes a dependency it added, and adds back one it removed', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);

    expect(expectDone(await undone())).toBe('make “Cable” wait for “Strip”');
    expect(await edges()).toEqual([]);

    await workItems.addDependency(cable, ownerId, strip);
    await workItems.removeDependency(cable, ownerId, strip);

    expect(expectDone(await undone())).toBe('stop “Cable” waiting for “Strip”');
    expect(await edges()).toEqual([[strip, cable]]);
  });

  it('puts a moved row back under the parent and after the sibling it had', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    const test = await root('Test', cable);

    await workItems.move(test, ownerId, { parentId: strip, afterId: null });
    expect(await namesByPosition(strip)).toEqual(['Test']);

    expect(expectDone(await undone())).toBe('move “Test”');

    expect(await namesByPosition(null)).toEqual(['Strip', 'Cable', 'Test']);
    expect((await found(test))?.parentId).toBeNull();
  });

  it('deletes a work item it created, when nothing has been built on it', async () => {
    const strip = await root('Strip');

    expect(expectDone(await undone())).toBe('add “Strip”');

    expect(await found(strip)).toBeNull();
  });

  it('hands the estimates back up when it undoes the first child that took them', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    const sockets = await child(strip, 'Sockets');
    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: sockets, roleId: dev(), ...DAYS },
    ]);

    expect(expectDone(await undone())).toBe('add “Sockets”');

    expect(await found(sockets)).toBeNull();
    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: strip, roleId: dev(), ...DAYS },
    ]);
  });

  it('refuses to undo a create that somebody has since built under', async () => {
    const strip = await root('Strip');
    const outcome = await workItems.create(projectId, strangerId, {
      parentId: strip,
      afterId: null,
      name: 'Sockets',
    });
    expect(outcome.ok).toBe(true);

    // The child moved `strip`'s revision through the estimate handoff, so this
    // is refused twice over. The subtree guard is what catches the case where
    // it does not — a second child, which writes a row of its own and touches
    // nothing on the parent.
    expectStale(await undone());
    expect(await found(strip)).not.toBeNull();
  });

  it('refuses to undo a create once a second child sits under it, which no revision would say', async () => {
    const strip = await root('Strip');
    await child(strip, 'Sockets');
    // Two more creates land on this account's own stack, so walk past them.
    const revisionBefore = (await found(strip))?.revision;
    await workItems.create(projectId, strangerId, {
      parentId: strip,
      afterId: null,
      name: 'Switches',
    });
    // The second child changed nothing about `strip` itself — this is the case
    // the subtree guard exists for.
    expect((await found(strip))?.revision).toBe(revisionBefore ?? -1);

    // Undo the two creates this account made under it, newest first.
    expect(expectDone(await undone())).toBe('add “Sockets”');
    expectStale(await undone());
    expect(await found(strip)).not.toBeNull();
  });

  it('restores a deleted branch whole: rows, estimates, assignees and its own edges', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    const switches = await child(strip, 'Switches', sockets);
    const alice = await person('Alice');
    await workItems.setEstimate(sockets, ownerId, dev(), DAYS);
    await workItems.assign(switches, ownerId, dev(), alice);
    await workItems.addDependency(switches, ownerId, sockets);

    expect((await workItems.remove(strip, ownerId, 'cascade')).ok).toBe(true);
    expect(await rows()).toEqual([]);

    expect(expectDone(await undone())).toBe('delete “Strip”');

    expect(await namesByPosition(null)).toEqual(['Strip']);
    expect(await namesByPosition(strip)).toEqual(['Sockets', 'Switches']);
    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: sockets, roleId: dev(), ...DAYS },
    ]);
    expect(await directoryStore.assignmentsOf([switches])).toEqual([
      { workItemId: switches, roleId: dev(), personId: alice },
    ]);
    expect(await edges()).toEqual([[sockets, switches]]);
  });

  it('takes back the estimates a deletion handed up to the parent', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    await workItems.setEstimate(sockets, ownerId, dev(), DAYS);

    expect((await workItems.remove(sockets, ownerId, null)).ok).toBe(true);
    // The parent has no children left, so it took the figures back.
    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: strip, roleId: dev(), ...DAYS },
    ]);

    expect(expectDone(await undone())).toBe('delete “Sockets”');

    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: sockets, roleId: dev(), ...DAYS },
    ]);
  });

  it('puts a promoted deletion back, with its children under it again', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    const switches = await child(strip, 'Switches', sockets);
    const cable = await root('Cable', strip);

    expect((await workItems.remove(strip, ownerId, 'promote')).ok).toBe(true);
    expect(await namesByPosition(null)).toEqual(['Sockets', 'Switches', 'Cable']);

    expect(expectDone(await undone())).toBe('delete “Strip”');

    expect(await namesByPosition(null)).toEqual(['Strip', 'Cable']);
    expect(await namesByPosition(strip)).toEqual(['Sockets', 'Switches']);
    expect((await found(sockets))?.parentId).toBe(strip);
    expect((await found(switches))?.parentId).toBe(strip);
    expect((await found(cable))?.parentId).toBeNull();
  });

  it('unfreezes what a freeze pinned, and only that', async () => {
    const strip = await root('Strip');
    await workItems.unfreeze(strip, ownerId);
    expect((await workItems.freeze(projectId, ownerId)).ok).toBe(true);
    expect((await found(strip))?.frozenNumber).toBe('010');

    expect(expectDone(await undone())).toBe('freeze the numbers');

    expect((await found(strip))?.frozenNumber).toBeNull();
  });

  it('puts a frozen number back when the unfreeze is undone', async () => {
    const strip = await root('Strip');
    await workItems.freeze(projectId, ownerId);
    await workItems.unfreeze(strip, ownerId);
    expect((await found(strip))?.frozenNumber).toBeNull();

    expect(expectDone(await undone())).toBe('unfreeze “Strip”');

    expect((await found(strip))?.frozenNumber).toBe('010');
  });

  it('removes a duplicated branch, copy and all', async () => {
    const strip = await root('Strip');
    await child(strip, 'Sockets');
    const copy = await workItems.duplicate(strip, ownerId);
    if (!copy.ok) throw new Error('duplicate refused');
    expect(await namesByPosition(null)).toEqual(['Strip', 'Strip (copy)']);

    expect(expectDone(await undone())).toBe('duplicate “Strip”');

    expect(await namesByPosition(null)).toEqual(['Strip']);
    expect(await found(copy.result.id)).toBeNull();
  });
});

describe('a replay never resurrects a directory row that has gone', () => {
  it('refuses a redo whose person has since been removed, and writes nothing', async () => {
    // The redo re-applies an assignment through the same guarded store the
    // forward write used. `assignment.person_id` is a foreign key, so a replay
    // routed around that path is a 500 on a key somebody pressed to be safe.
    const strip = await root('Strip');
    const alice = await person('Alice');
    await workItems.assign(strip, ownerId, dev(), alice);
    expect(expectDone(await undone())).toBe('assign “Strip”');
    await directoryStore.removePerson(alice, true);

    const outcome = await workItems.redo(projectId, ownerId);

    if (outcome.ok) throw new Error(`expected a refusal, got: ${outcome.result.done}`);
    expect(outcome.reason).toBe('stale_undo');
    expect(outcome.detail).toBe('that person is no longer in the directory.');
    expect(await directoryStore.assignmentsOf([strip])).toEqual([]);
  });

  it('refuses an undo that would put back a label whose team has gone', async () => {
    const strip = await root('Strip');
    const platform = await directoryStore.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    await workItems.patch(strip, ownerId, { serviceTeamId: platform.id });
    await workItems.patch(strip, ownerId, { serviceTeamId: null });
    await directoryStore.removeTeam(platform.id, true);

    // `work_item.service_team_id` has no foreign key, so the undo would not
    // fail — it would quietly write the dead id back and leave it there.
    const outcome = await undone();

    if (outcome.ok) throw new Error(`expected a refusal, got: ${outcome.result.done}`);
    expect(outcome.detail).toBe('that service team is no longer in the directory.');
    expect((await found(strip))?.serviceTeamId).toBeNull();
  });
});

describe('an undo refuses when what it touched has moved', () => {
  it('refuses a rename somebody else has renamed over, and leaves their name alone', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Mine' });
    await workItems.patch(strip, strangerId, { name: 'Theirs' });

    const detail = expectStale(await undone());

    expect(detail).toContain('Theirs');
    // A whole sentence, because the client puts it straight after a colon and
    // shows it. `has changed since` on its own reached a reader's screen.
    expect(detail).toContain('has changed since then.');
    expect((await found(strip))?.name).toBe('Theirs');
  });

  it('throws the refused entry away rather than jamming the stack behind it', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Mine' });
    await workItems.patch(strip, strangerId, { name: 'Theirs' });

    expectStale(await undone());

    // The entry below it is the create, and it is now reachable. A stack that
    // kept the stale entry would refuse this too, forever.
    const second = await undone();
    expect(second.ok).toBe(false);
    // The create's own precondition has moved as well — the stranger's rename
    // bumped the same row — so this refuses too, on its own merits, and the
    // stack empties rather than stopping.
    expect(await nextUndoable()).toBeNull();
  });

  it('refuses an estimate somebody else has re-estimated', async () => {
    const strip = await root('Strip');
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.setEstimate(strip, strangerId, dev(), OTHER_DAYS);

    expectStale(await undone());

    expect(await estimateStore.listByProject(projectId)).toEqual([
      { workItemId: strip, roleId: dev(), ...OTHER_DAYS },
    ]);
  });

  it('refuses an assignment somebody else has reassigned', async () => {
    const strip = await root('Strip');
    const alice = await person('Alice');
    const bob = await person('Bob');
    await workItems.assign(strip, ownerId, dev(), alice);
    await workItems.assign(strip, strangerId, dev(), bob);

    expectStale(await undone());

    expect(await directoryStore.assignmentsOf([strip])).toEqual([
      { workItemId: strip, roleId: dev(), personId: bob },
    ]);
  });

  it('refuses a dependency undo once one of its ends has been written to', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);
    // The **predecessor**, which the reader undoing might never have looked at.
    // An edge is a satellite of both ends, so both are preconditions.
    await workItems.patch(strip, strangerId, { name: 'Strip out' });

    expectStale(await undone());

    expect(await edges()).toEqual([[strip, cable]]);
  });

  it('refuses a move once the moved row has been edited', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.move(cable, ownerId, { parentId: strip, afterId: null });
    await workItems.patch(cable, strangerId, { name: 'Cable in' });

    expectStale(await undone());

    expect((await found(cable))?.parentId).toBe(strip);
  });

  it('refuses a move whose old neighbour has been deleted, rather than throwing', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    const test = await root('Test', cable);
    await workItems.move(test, ownerId, { parentId: strip, afterId: null });
    // `cable` is what `test` used to sit after. Nothing about `test` moved, so
    // the revisions all still hold — the placement is what cannot be honoured.
    expect((await workItems.remove(cable, strangerId, null)).ok).toBe(true);

    const detail = expectStale(await undone());

    // Ended, not left dangling: this is read out at the tail of the client's
    // own sentence — `That could not be undone: …` — and it stopped mid-phrase
    // on a reader's screen on 2026-08-09.
    expect(detail).toContain('deleted since then.');
    expect(detail.endsWith('.')).toBe(true);
    expect((await found(test))?.parentId).toBe(strip);
  });

  it('refuses to undo a delete when the branch has been recreated at its ids', async () => {
    const strip = await root('Strip');
    expect((await workItems.remove(strip, ownerId, null)).ok).toBe(true);
    // Nothing recreates an id in this product, so this is arranged by hand: it
    // is the state the refusal exists for, and the alternative to refusing is
    // writing over a row somebody else is using.
    await workItemStore.insert(
      {
        id: strip,
        projectId,
        parentId: null,
        position: 10,
        name: 'Something else entirely',
        notes: '',
        frozenNumber: null,
        priority: null,
        startNoEarlierThan: null,
        serviceTeamId: null,
        maxParallel: 1,
        revision: 0,
      },
      [],
    );

    const detail = expectStale(await undone());

    expect(detail).toContain('already exists');
    expect((await found(strip))?.name).toBe('Something else entirely');
  });

  it('refuses to undo a duplicate once somebody has typed into the copy', async () => {
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    expect(sockets).not.toBe('');
    const copy = await workItems.duplicate(strip, ownerId);
    if (!copy.ok) throw new Error('duplicate refused');
    const copiedChild = (await rows()).find((row) => row.parentId === copy.result.id);
    if (copiedChild === undefined) throw new Error('the copy has no child');
    await workItems.patch(copiedChild.id, strangerId, { name: 'Sockets, revised' });

    expectStale(await undone());

    expect(await namesByPosition(null)).toEqual(['Strip', 'Strip (copy)']);
  });

  it('refuses to undo a freeze once one of the rows it pinned has been unfrozen', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    expect((await workItems.freeze(projectId, ownerId)).ok).toBe(true);
    await workItems.unfreeze(cable, strangerId);

    expectStale(await undone());

    expect((await found(strip))?.frozenNumber).toBe('010');
  });

  /**
   * The chain, walked all the way down one row.
   *
   * Each undo is itself a write and moves the revision the entry below
   * recorded, so without the re-stamping in `rebase` only the first press of
   * the key would ever work — every one after it would refuse against a number
   * this account's own undo had walked past.
   */
  it('walks back through an account’s own consecutive edits to one row', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Second' });
    await workItems.patch(strip, ownerId, { name: 'Third' });

    expect(expectDone(await undone())).toBe('rename “Third”');
    expect((await found(strip))?.name).toBe('Second');

    expect(expectDone(await undone())).toBe('rename “Second”');
    expect((await found(strip))?.name).toBe('Strip');

    expect(expectDone(await undone())).toBe('add “Strip”');
    expect(await found(strip)).toBeNull();
  });

  /**
   * And it stops exactly where somebody else wrote.
   *
   * This is the other half of the same rule: the chain is carried forward only
   * where the revision a neighbour expects is the one the applied command
   * started from. A stranger's edit between two of this account's own breaks
   * that equality, and the entry below the break refuses instead of quietly
   * putting a name back over theirs.
   */
  it('stops at the point somebody else wrote, rather than reaching past it', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Mine' });
    await workItems.patch(strip, strangerId, { name: 'Theirs' });
    await workItems.patch(strip, ownerId, { name: 'Mine again' });

    expect(expectDone(await undone())).toBe('rename “Mine again”');
    expect((await found(strip))?.name).toBe('Theirs');

    expectStale(await undone());
    expect((await found(strip))?.name).toBe('Theirs');
  });
});

describe('redo', () => {
  it('re-applies what was undone', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out' });

    expect(expectDone(await undone())).toBe('rename “Strip out”');
    expect((await found(strip))?.name).toBe('Strip');

    expect(expectDone(await workItems.redo(projectId, ownerId))).toBe('rename “Strip out”');
    expect((await found(strip))?.name).toBe('Strip out');
  });

  it('re-applies a priority, and a first one that was undone to nothing', async () => {
    // Undo was watched on both directions of `priority`; redo was not. There is
    // no priority-specific line in the redo path to delete — `record` journals
    // the forward patch whole and `walkStack` re-applies it through the same
    // store — so what this covers is the **round trip**: the command is
    // persisted and read back before it is re-applied, and this is the only
    // assertion that a `priority` survives that. The second half is the one
    // worth having: redoing the *first* priority a work item ever had puts a
    // number back over a `null`, which is the asymmetric case.
    //
    // Proof: `revertTo`'s `priority` line deleted, this failed at its own undo
    // on `Expected: 5, Received: 1`, alongside the two undo tests above.
    // Watched, 2026-08-11.
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { priority: 5 });
    await workItems.patch(strip, ownerId, { priority: 1 });

    expectDone(await undone());
    expect((await found(strip))?.priority).toBe(5);
    expectDone(await workItems.redo(projectId, ownerId));
    expect((await found(strip))?.priority).toBe(1);

    const fresh = await root('Fresh');
    await workItems.patch(fresh, ownerId, { priority: 3 });

    expectDone(await undone());
    expect((await found(fresh))?.priority).toBeNull();
    expectDone(await workItems.redo(projectId, ownerId));
    expect((await found(fresh))?.priority).toBe(3);
  });

  it('walks back up the stack in the order the undoing happened', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Second' });
    await workItems.patch(strip, ownerId, { name: 'Third' });

    expect(expectDone(await undone())).toBe('rename “Third”');
    expect(expectDone(await workItems.redo(projectId, ownerId))).toBe('rename “Third”');
    expect((await found(strip))?.name).toBe('Third');
  });

  it('has nothing to redo until something has been undone', async () => {
    await root('Strip');

    const outcome = await workItems.redo(projectId, ownerId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('nothing_to_undo');
  });

  it('loses the redo branch the moment the account edits forward again', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    expect(expectDone(await undone())).toBe('rename “Strip out”');
    expect((await journalStore.stateOf(projectId, ownerId)).redoable).toBe(true);

    await workItems.patch(strip, ownerId, { notes: 'a different thing entirely' });

    expect((await journalStore.stateOf(projectId, ownerId)).redoable).toBe(false);
    const outcome = await workItems.redo(projectId, ownerId);
    expect(outcome.ok).toBe(false);
    expect((await found(strip))?.name).toBe('Strip');
  });

  it('refuses a redo whose row somebody else has changed since the undo', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { name: 'Strip out' });
    expect(expectDone(await undone())).toBe('rename “Strip out”');

    await workItems.patch(strip, strangerId, { name: 'Theirs' });

    expectStale(await workItems.redo(projectId, ownerId));
    expect((await found(strip))?.name).toBe('Theirs');
  });
});

describe('the stack itself', () => {
  it('is per account: one reader’s undo never reaches another’s change', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, strangerId, { name: 'Theirs' });

    // The owner's newest entry is still their own create, not the rename that
    // landed after it.
    expect((await nextUndoable())?.kind).toBe('create');
    expect((await nextUndoable(strangerId))?.kind).toBe('patch');
  });

  it('says so plainly when there is nothing left to undo', async () => {
    const outcome = await undone();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('nothing_to_undo');
    expect(outcome.detail).toBeNull();
  });

  it('keeps the last fifty commands and drops what falls off the bottom', async () => {
    const strip = await root('Strip');
    // 55 renames plus the create is 56 entries written; 50 survive, so the
    // oldest six — the create and the first five renames — are gone.
    for (let i = 0; i < 55; i += 1) {
      await workItems.patch(strip, ownerId, { name: `Name ${String(i)}` });
    }

    expect((await nextUndoable())?.seq).toBe(56);
    // Reading the oldest surviving entry through the store's own ordering: the
    // stack is exactly fifty deep, so the lowest seq still there is 7.
    const all = await allEntries();
    expect(all).toHaveLength(50);
    expect(Math.min(...all.map((each) => each.seq))).toBe(7);
    expect(all.some((each) => each.kind === 'create')).toBe(false);
  });

  it('numbers each account’s stack on its own', async () => {
    const strip = await root('Strip');
    await workItems.patch(strip, strangerId, { name: 'Theirs' });

    expect((await nextUndoable())?.seq).toBe(1);
    expect((await nextUndoable(strangerId))?.seq).toBe(1);
  });
});

describe('restoring the edges that left the branch', () => {
  it('puts an outside dependency back with the branch', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);

    expect((await workItems.remove(strip, ownerId, null)).ok).toBe(true);
    expect(await edges()).toEqual([]);

    const outcome = await undone();
    expect(expectDone(outcome)).toBe('delete “Strip”');
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result.detail).toBeNull();
    expect(await edges()).toEqual([[strip, cable]]);
  });

  /**
   * The partial restore, said out loud.
   *
   * The far end of the edge has gone while the branch was away, so the edge
   * cannot come back — but the branch can, and it is the branch somebody asked
   * for. This is why the far end is not a precondition: making it one would
   * turn a missing neighbour into a refusal to restore any of the work.
   */
  it('restores the branch without an edge whose other end has gone, and says so', async () => {
    const strip = await root('Strip');
    const cable = await root('Cable', strip);
    await workItems.addDependency(cable, ownerId, strip);

    expect((await workItems.remove(strip, ownerId, null)).ok).toBe(true);
    // Somebody else takes the far end away entirely.
    expect((await workItems.remove(cable, strangerId, null)).ok).toBe(true);

    const outcome = await undone();
    expect(expectDone(outcome)).toBe('delete “Strip”');
    if (!outcome.ok) throw new Error('unreachable');
    expect(await namesByPosition(null)).toEqual(['Strip']);
    expect(await edges()).toEqual([]);
    expect(outcome.result.detail).toContain('without 1 dependency');
  });
});

describe('who may undo', () => {
  it('answers not_found for a project that is not there', async () => {
    const outcome = await workItems.undo(crypto.randomUUID(), ownerId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('not_found');
  });

  it('refuses a stranger on a restricted project, undo being a write', async () => {
    const strip = await root('Strip');
    expect(strip).not.toBe('');
    await projects.update(projectId, ownerId, { restricted: true });

    const outcome = await workItems.undo(projectId, strangerId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('forbidden');
  });
});

/**
 * Every journal row for the owner, read straight out of the table.
 *
 * The store hands out one end of the stack at a time on purpose, so walking it
 * through the store would mean flipping entries — which is a write, and would
 * be the test corrupting the thing it is measuring.
 */
async function allEntries(): Promise<{ seq: number; kind: string }[]> {
  const db = openDrizzle(path);
  const read = await db.select().from(commandJournal);
  return read
    .filter((row) => row.userId === ownerId)
    .map((row) => ({ seq: row.seq, kind: row.kind }));
}

/** A person in the global directory, for the assignment cases. */
async function person(name: string): Promise<string> {
  const added = await personAdded(directoryStore.addPerson({ id: crypto.randomUUID(), name }, []));
  return added.id;
}
