import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { JournalEntry, LabelledWorkItem, Role, WorkItem } from '../repository';
import { ActualRepository } from '../repository/actual';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDatabase, openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { PlanEventRepository } from '../repository/plan-event';
import { ProjectRepository } from '../repository/project';
import { RoleProgressRepository } from '../repository/role-progress';
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
let actualStore: ActualRepository;
let progressStore: RoleProgressRepository;
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
  actualStore = new ActualRepository(db);
  progressStore = new RoleProgressRepository(db);
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
    actuals: actualStore,
    progress: progressStore,
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

/**
 * Every row of the project, so a test can say what the tree looks like now.
 *
 * Typed as the **labelled** row since task 10.2: `listByProject` has always
 * returned the label sets beside the columns, and the service cases below read
 * `serviceIds` off it because the join is where that fact now lives.
 */
const rows = (): Promise<LabelledWorkItem[]> => workItemStore.listByProject(projectId);

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

  it('undoes a reason written beside a date that was already there', async () => {
    // Words added to an existing floor, taken off again. The forward patch names
    // only the reason, so the journal has to hear a patch that names only the
    // reason — and its inverse must put `null` back rather than nothing, because
    // "nobody has explained this" is a state of its own.
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, { startNoEarlierThan: '2026-09-12' });
    await workItems.patch(strip, ownerId, {
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    expectDone(await undone());

    const after = await found(strip);
    expect(after?.startNoEarlierThanReason).toBeNull();
    // The floor is not what was undone and does not move.
    expect(after?.startNoEarlierThan).toBe('2026-09-12');
  });

  it('puts the words back with the date they explain', async () => {
    // The pair cleared in one request, undone in one press. The inverse names
    // **both** halves the forward named, which is also what keeps it legal: an
    // inverse that restored the date alone would be refused by the very rule
    // that made the forward patch send both.
    const strip = await root('Strip');
    await workItems.patch(strip, ownerId, {
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });
    await workItems.patch(strip, ownerId, {
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
    });

    expectDone(await undone());

    const after = await found(strip);
    expect(after?.startNoEarlierThan).toBe('2026-09-12');
    expect(after?.startNoEarlierThanReason).toBe('waiting on client sign-off');
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

  it('restores every day recorded in a deleted branch, against the real cascade', async () => {
    // Against real SQLite, and that is the point of putting this here rather
    // than beside the other actual cases: `actual.work_item_id` cascades, so the
    // rows are genuinely gone after the delete and can only come back from the
    // command. The in-memory store cannot model that — its rows survive the
    // deletion in an array and reappear with the row — and a case written there
    // passes with the restore's `actuals` replaced by `[]`. See verify.md F9a.
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    const switches = await child(strip, 'Switches', sockets);
    await workItems.setActual(sockets, ownerId, dev(), 8);
    await workItems.setActual(switches, ownerId, dev(), 3);

    expect((await workItems.remove(strip, ownerId, 'cascade')).ok).toBe(true);
    expect(await actualStore.listByProject(projectId)).toEqual([]);

    expect(expectDone(await undone())).toBe('delete “Strip”');

    // By work item rather than as a list, and the size asserted beside it.
    // `listByProject` orders by `work_item_id` — a **UUID** across a project —
    // so a two-row list assertion here is a coin toss on which name sorts
    // first: it passed five times on h2puni and on CI at `db3e121`, and failed
    // on the doc-only commit after it. See verify.md.
    const back = await actualStore.listByProject(projectId);
    const byItem = new Map(back.map((each) => [each.workItemId, each.days]));
    expect(byItem.get(sockets)).toBe(8);
    expect(byItem.get(switches)).toBe(3);
    expect(back).toHaveLength(2);
    expect(back.every((each) => each.roleId === dev())).toBe(true);
  });

  it('restores every statement made in a deleted branch, against the real cascade', async () => {
    // Against real SQLite, and that is the point of putting this here rather
    // than beside the other progress cases: `role_progress.work_item_id`
    // cascades, so the rows are genuinely gone after the delete and can only
    // come back from the command. The in-memory store cannot model that — its
    // rows survive the deletion in an array and reappear with the row — so a
    // case written there passes with the restore's `progress` replaced by `[]`.
    // That is `actual-days`' F9a, and the lesson is being applied rather than
    // rediscovered.
    //
    // Proof: the restore's `progress` replaced by `[]`, and this fails with an
    // empty list where two statements are owed — a branch that comes back from
    // an undo reading as work nobody has started; watched 2026-08-18.
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    const switches = await child(strip, 'Switches', sockets);
    await workItems.setProgress(sockets, ownerId, dev(), 'done');
    await workItems.setProgress(switches, ownerId, dev(), 'in_progress');

    expect((await workItems.remove(strip, ownerId, 'cascade')).ok).toBe(true);
    expect(await progressStore.listByProject(projectId)).toEqual([]);

    expect(expectDone(await undone())).toBe('delete “Strip”');

    // By work item rather than as a list, and the size asserted beside it, for
    // the reason the actual case above gives: `listByProject` orders by
    // `work_item_id`, a UUID across a project, so a two-row list assertion is a
    // coin toss on which name sorts first. That mistake cost a CI cycle on #79
    // and it is not being made twice.
    const back = await progressStore.listByProject(projectId);
    const byItem = new Map(back.map((each) => [each.workItemId, each.state]));
    expect(byItem.get(sockets)).toBe('done');
    expect(byItem.get(switches)).toBe('in_progress');
    expect(back).toHaveLength(2);
    expect(back.every((each) => each.roleId === dev())).toBe(true);
  });

  it('takes back the statement a deletion handed up to the parent', async () => {
    // The mirror of the recorded-days case below it. The parent has no children
    // left after the delete, so it took the branch's reading; undoing has to
    // take it off again, or the plan says the parent's own work is finished
    // while the leaf that was actually finished is back beside it.
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    await workItems.setProgress(sockets, ownerId, dev(), 'done');

    expect((await workItems.remove(sockets, ownerId, null)).ok).toBe(true);
    expect(
      (await progressStore.listByProject(projectId)).map(({ workItemId, state }) => ({
        workItemId,
        state,
      })),
    ).toEqual([{ workItemId: strip, state: 'done' }]);

    expect(expectDone(await undone())).toBe('delete “Sockets”');

    expect(
      (await progressStore.listByProject(projectId)).map(({ workItemId, state }) => ({
        workItemId,
        state,
      })),
    ).toEqual([{ workItemId: sockets, state: 'done' }]);
  });

  it('takes back the recorded days a deletion handed up to the parent', async () => {
    // The mirror of the estimate case below it. The parent has no children left
    // after the delete, so it took the branch's recorded days; undoing has to
    // take them off it again, or the same week is counted twice — once on the
    // restored leaf and once on a parent that is no longer one.
    const strip = await root('Strip');
    const sockets = await child(strip, 'Sockets');
    await workItems.setActual(sockets, ownerId, dev(), 5);

    expect((await workItems.remove(sockets, ownerId, null)).ok).toBe(true);
    expect(
      (await actualStore.listByProject(projectId)).map(({ workItemId, days }) => ({
        workItemId,
        days,
      })),
    ).toEqual([{ workItemId: strip, days: 5 }]);

    expect(expectDone(await undone())).toBe('delete “Sockets”');

    expect(
      (await actualStore.listByProject(projectId)).map(({ workItemId, days }) => ({
        workItemId,
        days,
      })),
    ).toEqual([{ workItemId: sockets, days: 5 }]);
  });

  it('hands the recorded days back up when it undoes the first child that took them', async () => {
    // The create moved them down, because a work item with children reports
    // sums and a row left on it would be unreadable. The undo deletes that
    // child — taking its rows with it, through the cascade — so the days can
    // only come back from the command's own `setActuals`.
    const strip = await root('Strip');
    await workItems.setActual(strip, ownerId, dev(), 6);

    const sockets = await child(strip, 'Sockets');
    expect(
      (await actualStore.listByProject(projectId)).map(({ workItemId, days }) => ({
        workItemId,
        days,
      })),
    ).toEqual([{ workItemId: sockets, days: 6 }]);

    expect(expectDone(await undone())).toBe('add “Sockets”');

    expect(
      (await actualStore.listByProject(projectId)).map(({ workItemId, days }) => ({
        workItemId,
        days,
      })),
    ).toEqual([{ workItemId: strip, days: 6 }]);
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
        serviceId: null,
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

describe('what an undo leaves in the plan’s history', () => {
  /** The project's history, read straight out of the table the route reads. */
  const history = () => new PlanEventRepository(openDrizzle(path)).listFor(projectId, {});

  it('records the command, and records nothing at all for undoing it', async () => {
    // The one thing a reader of the history will be surprised by, asserted rather
    // than only written down. Undo and redo flip a journal entry in place and
    // append nothing — deliberately, `schema.ts` argues why — so an estimate set
    // and then taken back leaves the event that set it and no event undoing it.
    // Every event is true about its own moment; the sequence is incomplete.
    //
    // Closing it means writing from the undo path as well, which is a second write
    // site and R5's H5 question rather than this change's. See
    // `openspec/changes/plan-history/design.md` D4 — if this case ever goes red
    // because somebody closed the gap, that is the change and not a regression.
    const id = await root('Strip the roof');
    const set = await workItems.setEstimate(id, ownerId, roles[0].id, DAYS);
    expect(set.ok).toBe(true);
    expect((await history()).map((each) => each.kind)).toEqual(['estimate', 'create']);

    const undone = await workItems.undo(projectId, ownerId);
    expect(undone.ok).toBe(true);

    // Two events still, and the estimate really is gone from the plan — so the
    // history says 1/2/3 was set while the plan says nothing is estimated.
    expect((await history()).map((each) => each.kind)).toEqual(['estimate', 'create']);
    expect(await estimateStore.listByProject(projectId)).toEqual([]);
  });

  it('keeps the event of a command whose journal entry a later write threw away', async () => {
    // The redo branch is deleted on every append, so the undone command leaves the
    // stack entirely the moment anything else is written. Its event stays, which is
    // the difference between the plan's history and one account's undo stack.
    const id = await root('Strip the roof');
    await workItems.setEstimate(id, ownerId, roles[0].id, DAYS);
    await workItems.undo(projectId, ownerId);
    await workItems.setEstimate(id, ownerId, roles[0].id, OTHER_DAYS);

    expect((await allEntries()).map((each) => each.kind)).toEqual(['create', 'estimate']);
    expect((await history()).map((each) => each.kind)).toEqual(['estimate', 'estimate', 'create']);
  });
});

describe('a tag set is undone whole, which a scalar habit would not do', () => {
  /** A tag in the global directory, or a throw — a refused fixture is not a result. */
  async function tagNamed(name: string): Promise<string> {
    const made = await directoryStore.addTag({ id: crypto.randomUUID(), name });
    return made.id;
  }

  /** The tags the plan read gives for one row, which is the only place they live. */
  async function tagsOn(id: string): Promise<readonly string[]> {
    const row = (await workItemStore.listByProject(projectId)).find((each) => each.id === id);
    if (row === undefined) throw new Error(`no work item ${id}`);
    return row.tagIds;
  }

  it('puts a replaced tag set back, whole', async () => {
    // **The seam this whole field is designed around.** The row carries two
    // tags, a patch replaces them with a third, and the undo has to restore
    // *both* — not the first, not the last, not one of them.
    //
    // A scalar before-value is the natural mistake and it fails silently: the
    // undo reports done, the row comes back carrying one label, and nothing
    // anywhere says a second one was lost.
    //
    // Proof: `revertTo`'s tag line written as `before.tagIds.slice(0, 1)` and
    // this failed on `expected [ "regulatory" ] to deeply equal [ "regulatory",
    // "tech-debt" ]` — a pressable undo that reports done and leaves the row
    // holding one of the two labels it had. Watched 2026-08-19.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');
    const techDebt = await tagNamed('tech-debt');
    const q3 = await tagNamed('q3-must-have');

    // Two tags on, then replaced by one. Sorted, because the store answers in
    // tag-id order and the ids are random.
    await workItems.patch(id, ownerId, { tagIds: [regulatory, techDebt] });
    const both = [...(await tagsOn(id))].sort();
    expect(both).toEqual([regulatory, techDebt].sort());

    await workItems.patch(id, ownerId, { tagIds: [q3] });
    expect(await tagsOn(id)).toEqual([q3]);

    expectDone(await undone());

    expect([...(await tagsOn(id))].sort()).toEqual([regulatory, techDebt].sort());
  });

  it('takes a first tag set off again, rather than leaving one behind', async () => {
    // The other direction, and the one an empty before-value has to be able to
    // express: the row had no tags, a patch put one on, and undoing it must
    // leave the row untagged. `[]` is a legal before-value and means exactly
    // this — which is why the inverse names the field with an empty set rather
    // than omitting it.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');

    await workItems.patch(id, ownerId, { tagIds: [regulatory] });
    expect(await tagsOn(id)).toEqual([regulatory]);

    expectDone(await undone());

    expect(await tagsOn(id)).toEqual([]);
  });

  it('redoes a tag change over real SQLite, cascade and all', async () => {
    // Over real SQLite rather than the in-memory store, deliberately: the store
    // cannot model a cascade, which is how a restore case passed under the very
    // fault it was written for in #79. Here the rows are real, the join is real,
    // and the delete-then-insert the patch performs is the thing under test.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');
    const techDebt = await tagNamed('tech-debt');

    await workItems.patch(id, ownerId, { tagIds: [regulatory] });
    await workItems.patch(id, ownerId, { tagIds: [techDebt] });

    expectDone(await undone());
    expect(await tagsOn(id)).toEqual([regulatory]);

    expectDone(await workItems.redo(projectId, ownerId));
    expect(await tagsOn(id)).toEqual([techDebt]);
  });

  it('leaves the tags alone for a patch that does not name them', async () => {
    // The rule every field here follows, and the one a delete-then-insert makes
    // easy to break: a rename must not empty the join.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');
    await workItems.patch(id, ownerId, { tagIds: [regulatory] });

    await workItems.patch(id, ownerId, { name: 'Strip the whole roof' });

    expect(await tagsOn(id)).toEqual([regulatory]);
  });

  it('refuses a tag the directory no longer holds, and writes nothing', async () => {
    // The out-of-date picker. Decided inside the write's own transaction, so a
    // tag removed between a client's read and its patch is a refusal that names
    // the tag rather than a raw constraint failure.
    //
    // **And the row is untouched**, which is the half worth asserting: the
    // refusal comes after the `UPDATE` in statement order, so a version that
    // returned without rolling back would leave the name written and the tags
    // not.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');
    await workItems.patch(id, ownerId, { tagIds: [regulatory] });

    const outcome = await workItems.patch(id, ownerId, {
      name: 'Strip the whole roof',
      tagIds: [regulatory, crypto.randomUUID()],
    });

    expect(outcome).toEqual({ ok: false, reason: 'unknown_tag' });
    expect(await tagsOn(id)).toEqual([regulatory]);
    expect((await found(id))?.name).toBe('Strip the roof');
  });

  it('writes one row for a tag named twice', async () => {
    // The primary key would refuse the pair, so a payload naming one tag twice
    // has to be deduplicated before it reaches the insert. Untidy rather than
    // wrong, which is why it is not a refusal.
    const id = await root('Strip the roof');
    const regulatory = await tagNamed('regulatory');

    const outcome = await workItems.patch(id, ownerId, {
      tagIds: [regulatory, regulatory],
    });

    expect(outcome.ok).toBe(true);
    expect(await tagsOn(id)).toEqual([regulatory]);
  });
});

describe('a service is undone as the set it became, the tag rule and no longer its inverse', () => {
  /**
   * A service in the global directory, written straight into SQLite because the
   * directory's own write path for services does not exist until section 4.
   *
   * The same shortcut `work-item.test.ts` takes, for the same reason: a write
   * path that has not been built yet cannot be the thing that sets up a test of
   * the one that has.
   */
  function serviceNamed(name: string): string {
    const id = crypto.randomUUID();
    const db = openDatabase(path);
    try {
      db.run('INSERT INTO service (id, name) VALUES (?, ?)', [id, name]);
    } finally {
      db.close();
    }
    return id;
  }

  /** Removing one, ditto — and the `ON DELETE SET NULL` beneath it is the point. */
  function removeService(id: string): void {
    const db = openDatabase(path);
    try {
      db.run('DELETE FROM service WHERE id = ?', [id]);
    } finally {
      db.close();
    }
  }

  /** The service set on a row, read back the way every face reads it. */
  const servicesOn = async (id: string): Promise<readonly string[]> =>
    (await rows()).find((row) => row.id === id)?.serviceIds ?? [];

  it('puts a replaced service back', async () => {
    // **The set half of D6 as amended**, and it was the scalar half until task
    // 10.2: the row carries one service, a patch replaces it with another, and
    // the undo restores what was there. One member here because this case
    // states one — the case that proves a *two*-member restore is task 10.3's,
    // and until it exists this file cannot tell a whole-set journal from a
    // first-member one.
    //
    // The reds this case carried for the scalar are gone with the column and
    // are recorded in the task log rather than rewritten as though they still
    // ran: the `[before.serviceId]` typecheck refusal and the `SQLite query
    // expected 2 values, received 1` throw were both properties of writing a
    // set into one placeholder, which no line does now.
    //
    // Still live, watched 2026-08-21: with `fieldsOf`'s service line deleted —
    // **3 fail** — this one failed at `expectDone` on `refused: stale_undo —
    // “Strip the roof” has changed since then`, the undo reaching past an
    // unjournalled write to an entry that write had already made stale. And
    // with the store's `patch.serviceIds === undefined` guard line deleted,
    // this failed along with three others — the patch taking the no-field
    // branch, answering `ok` with the row it found, and writing no join row.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    const billing = serviceNamed('Billing');
    await workItems.patch(id, ownerId, { serviceIds: [payments] });

    await workItems.patch(id, ownerId, { serviceIds: [billing] });
    expect(await servicesOn(id)).toEqual([billing]);

    expectDone(await undone());
    expect(await servicesOn(id)).toEqual([payments]);

    expectDone(await workItems.redo(projectId, ownerId));
    expect(await servicesOn(id)).toEqual([billing]);
  });

  it('puts a replaced service set back, whole', async () => {
    // **Task 10.3, and the only case in this file that can prove it.** Every
    // other service case above and below states one service, and a one-member
    // set restores identically through a whole-set journal and a first-member
    // one — so until this case existed, `revertTo`'s
    // `out.serviceIds = before.serviceIds` was a *shape* that arrived with
    // 10.2's type change rather than a rule anything held to.
    //
    // The row carries two services, a patch replaces them with a third, and the
    // undo has to restore *both*. The scalar habit is the natural mistake on a
    // field that was a nullable column until this morning, and it fails
    // silently: the undo reports done, the row comes back carrying one of its
    // two services, and nothing says the other went. That is the tags fault one
    // dimension over (`puts a replaced tag set back, whole`, 190 lines up) and
    // deliberately *not* the throw the column used to give — a set has a
    // scalar-shaped spelling that loses data quietly, which is D6's whole
    // argument.
    //
    // Proof: `revertTo`'s service line written as
    // `before.serviceIds.slice(0, 1)` and this case failed **alone** — 76 pass,
    // 1 fail over this file — at the line below, on a received set holding one
    // id where two were expected (`- Expected - 1 / + Received + 0`, a bare
    // missing element rather than a wrong one). The five one-service cases
    // beside it all stayed green, which is the whole of why this case had to
    // exist. Watched 2026-08-21.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    const billing = serviceNamed('Billing');
    const checkout = serviceNamed('Checkout');

    // Sorted on both sides, because the join is read in service-id order and
    // the ids are random — the assertion is about the set, not about the order.
    await workItems.patch(id, ownerId, { serviceIds: [payments, billing] });
    expect([...(await servicesOn(id))].sort()).toEqual([payments, billing].sort());

    await workItems.patch(id, ownerId, { serviceIds: [checkout] });
    expect(await servicesOn(id)).toEqual([checkout]);

    expectDone(await undone());
    expect([...(await servicesOn(id))].sort()).toEqual([payments, billing].sort());

    // Redo has to narrow it back to the one. A journal that restored a set on
    // the way back and a member on the way forward would pass the assertion
    // above and still be wrong in the direction nobody watches.
    expectDone(await workItems.redo(projectId, ownerId));
    expect(await servicesOn(id)).toEqual([checkout]);
  });

  it('takes a first service away again, rather than leaving it on', async () => {
    // `[]` is a legal before-value and it is the one an absent field would
    // lose: the inverse of labelling an unlabelled row is *taking the label
    // off*, and a `revertTo` that skipped the empty set would report a
    // successful undo over a row still carrying the service it just added.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    await workItems.patch(id, ownerId, { serviceIds: [payments] });

    expectDone(await undone());

    expect(await servicesOn(id)).toEqual([]);
  });

  it('leaves the service alone for a patch that does not name it', async () => {
    // Absent means absent, on this field as on every other: a rename must not
    // clear the label, and the undo of that rename must not either.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    await workItems.patch(id, ownerId, { serviceIds: [payments] });

    await workItems.patch(id, ownerId, { name: 'Strip the whole roof' });
    expect(await servicesOn(id)).toEqual([payments]);

    expectDone(await undone());
    expect(await servicesOn(id)).toEqual([payments]);
  });

  it('writes a service named on its own, rather than reporting a write it skipped', async () => {
    // The store's no-field branch: a patch naming only the service must not
    // take it. Its own red is on the guard line in `work-item.ts` — without
    // `patch.serviceIds` there, this answers `ok` with the row it found and no
    // join row is ever written.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');

    const outcome = await workItems.patch(id, ownerId, { serviceIds: [payments] });

    expect(outcome.ok).toBe(true);
    expect(await servicesOn(id)).toEqual([payments]);
  });

  it('refuses a service the directory no longer holds, and writes nothing', async () => {
    // The out-of-date picker, one dimension over from `unknown_tag`. Decided
    // inside the write's own transaction, so a service removed between a
    // client's read and its patch is a refusal naming the service rather than a
    // raw failure. The column used to catch this one itself; since task 10.2 the
    // join cascades instead and catches nothing, so this read is the whole of
    // the guarantee rather than a way of making an existing refusal readable.
    //
    // **And the row is untouched**, which is the half worth asserting: the
    // refusal is decided before the `UPDATE` runs, so a version that checked
    // afterwards would leave the name written and the service not.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    await workItems.patch(id, ownerId, { serviceIds: [payments] });

    const outcome = await workItems.patch(id, ownerId, {
      name: 'Strip the whole roof',
      serviceIds: [crypto.randomUUID()],
    });

    expect(outcome).toEqual({ ok: false, reason: 'unknown_service' });
    expect(await servicesOn(id)).toEqual([payments]);
    expect((await found(id))?.name).toBe('Strip the roof');
  });

  it('refuses an undo that would put back a label whose service has gone', async () => {
    // The replay guard, third dimension. `removeService` cascades to the
    // `work_item_service` rows carrying it, so by the time the undo runs the
    // before-value names a service that is not there. Putting it back is what the
    // store's in-transaction read refuses, and `apply` reports that refusal
    // rather than replaying around it.
    //
    // Over real SQLite because the deletion under test *is* the foreign key's
    // action: an in-memory store models no cascade, so this case would pass
    // there against a version that never nulled anything — #79's exact failure.
    const id = await root('Strip the roof');
    const payments = serviceNamed('Payments');
    const billing = serviceNamed('Billing');
    await workItems.patch(id, ownerId, { serviceIds: [payments] });
    await workItems.patch(id, ownerId, { serviceIds: [billing] });

    removeService(payments);

    const detail = expectStale(await undone());

    // The sentence names the service rather than the work item: three
    // dimensions can each be the one that went, and "the work item is no longer
    // there" would be a false sentence about a row still on screen.
    expect(detail).toBe('that service is no longer in the directory.');
    expect(await servicesOn(id)).toEqual([billing]);
  });
});

describe('a tag decides no date, asserted rather than claimed', () => {
  it('moves nothing in the plan when a tag is deleted with its labelling', async () => {
    // **The central claim of the whole change, and the only way to state it that
    // a reader can check.** A tag has no pool, no size and nothing the engine
    // reads, so a plan scheduled with a tag on it and the same plan after that
    // tag is deleted — cascade and all — must come out identical in every
    // schedule number and every date.
    //
    // Over real SQLite, because the deletion under test *is* the foreign key's
    // cascade: an in-memory store models no cascade at all, so this test would
    // pass there against a version that never removed the labelling.
    //
    // The plan is built so a scheduling input would be visible: a start date, a
    // dependency, and estimates on both sides of it. If a tag ever reached the
    // engine, the successor's dates are where it would show.
    await projects.update(projectId, ownerId, { startDate: '2026-09-01' });
    const strip = await root('Strip the roof');
    const cable = await root('Cable it', strip);
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.setEstimate(cable, ownerId, dev(), OTHER_DAYS);
    await workItems.addDependency(cable, ownerId, strip);

    const regulatory = await directoryStore.addTag({ id: crypto.randomUUID(), name: 'regulatory' });
    await workItems.patch(strip, ownerId, { tagIds: [regulatory.id] });

    const before = await workItems.tree(projectId);

    const removed = await directoryStore.removeTag(regulatory.id, true);
    expect(removed.ok).toBe(true);

    const after = await workItems.tree(projectId);

    // Non-vacuity first: the labelling really did go, so this is comparing two
    // plans that differ, rather than two reads of an unchanged one.
    expect(after?.workItems.map((row) => row.tagIds)).toEqual(
      before?.workItems.map(() => []) ?? [],
    );
    expect(before?.workItems.some((row) => row.tagIds.length > 0)).toBe(true);

    // And every number and every date is where it was.
    expect(
      after?.workItems.map((row) => ({ name: row.name, schedule: row.schedule, dates: row.dates })),
    ).toEqual(
      before?.workItems.map((row) => ({
        name: row.name,
        schedule: row.schedule,
        dates: row.dates,
      })),
    );
    expect(after?.slices).toEqual(before?.slices ?? []);
  });
});
