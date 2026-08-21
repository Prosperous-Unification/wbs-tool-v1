import type { ItemState } from '@wbs/domain';
import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  ActualStore,
  CommandJournalStore,
  EstimateStore,
  MeasureStore,
  Project,
  ProjectStore,
  RoleProgressStore,
  StoredProgress,
  WorkItemStore,
} from '../repository';
import { inMemoryActuals } from '../testing/actual-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryMeasures } from '../testing/measure-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryProgress } from '../testing/progress-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { inMemorySubtrees } from '../testing/subtree-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import type { Days } from './roll-up';
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';
const OTHER = 'somebody-else';
const DEV = 'role-dev';
const QA = 'role-qa';

let projects: ProjectStore;
let workItems: WorkItemStore;
let estimates: EstimateStore;
let actuals: ActualStore;
let measures: MeasureStore;
let progress: RoleProgressStore;
let journal: CommandJournalStore & { events: { kind: string; roleId: string | null }[] };
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  projects = inMemoryProjects();
  const directory = inMemoryDirectory();
  workItems = inMemoryWorkItems(directory);
  estimates = inMemoryEstimates(workItems);
  actuals = inMemoryActuals(workItems);
  measures = inMemoryMeasures(workItems);
  progress = inMemoryProgress(workItems);
  const dependencies = inMemoryDependencies();
  const store = inMemoryCommandJournal();
  const recorded: { kind: string; roleId: string | null }[] = [];
  // The journal with the history rows it is handed kept where a test can read
  // them, exactly as `actual.test.ts` does it: H1 writes the plan's event from
  // inside `append`, so this is the seam a statement has to arrive through if it
  // is to be in the history for free.
  journal = {
    ...store,
    events: recorded,
    async append(entry, event) {
      recorded.push({ kind: event.kind, roleId: event.roleId });
      await store.append(entry, event);
    },
  };
  service = new WorkItemService({
    workItems,
    projects,
    estimates,
    actuals,
    measures,
    progress,
    dependencies,
    directory,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    subtrees: inMemorySubtrees({
      workItems,
      estimates,
      actuals,
      measures,
      progress,
      dependencies,
      directory,
    }),
    journal,
    broadcast: recordingBroadcaster(),
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: 'Rewire the shed',
    ownerId: OWNER,
    restricted: true,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  };
  await projects.create(project, [
    { id: DEV, projectId: project.id, name: 'Dev', position: 10 },
    { id: QA, projectId: project.id, name: 'QA', position: 20 },
  ]);
  projectId = project.id;
});

const days = (optimistic: number, realistic: number, pessimistic: number): Days => ({
  optimistic,
  realistic,
  pessimistic,
});

/**
 * The stored rows without their stamps, for the cases that assert *where* a row
 * is rather than when it was said. `statedAt` is the wall clock, so a case
 * naming it would be asserting against `Date.now()`.
 */
function stored(
  rows: readonly StoredProgress[],
): { workItemId: string; roleId: string; state: string }[] {
  return rows.map(({ workItemId, roleId, state }) => ({ workItemId, roleId, state }));
}

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

/**
 * The per-role states by work item name, as the payload carries them.
 *
 * A Map rather than a Record for `estimate.test.ts`' reason: indexing a Record
 * is typed as always present, and every assertion here turns on the difference
 * between a role that is absent and one that has said something.
 */
async function shown(): Promise<Map<string, Record<string, string>>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return new Map(tree.workItems.map((w) => [w.name, w.progress]));
}

/** The derived item state by work item name — the field nothing stores. */
async function states(): Promise<Map<string, ItemState>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return new Map(tree.workItems.map((w) => [w.name, w.state]));
}

describe('stating where the work has got to', () => {
  it('stores a role’s state on a leaf and shows it beside the figures', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setActual(strip, OWNER, DEV, 8);

    await service.setProgress(strip, OWNER, DEV, 'done');

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 'done' });
    // What the whole change buys, in one assertion: the 8 against the 5 is now
    // readable. Before this row existed the same payload could not tell "took 8
    // days, finished" from "8 days so far".
    expect((await states()).get('Strip')).toBe('done');
    expect((await service.tree(projectId))?.workItems.at(0)?.actuals).toEqual({ [DEV]: 8 });
  });

  it('is not started while nobody has said anything, with no row anywhere', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setActual(strip, OWNER, DEV, 8);

    // An estimate and a recorded day are not statements about where the work
    // has got to. Absence is the third state and it is spelled by the absence of
    // a row — never by a stored `not_started`.
    expect((await shown()).get('Strip')).toEqual({});
    expect((await states()).get('Strip')).toBe('not_started');
    expect(await progress.listByProject(projectId)).toEqual([]);
  });

  it('is in progress when one role is done and another has said nothing', async () => {
    // The disagreement case, and the one the whole design turns on. Dev has
    // finished and QA has an estimate and no statement: that is an unfinished
    // work item, and reading it as done would let a plan report finished work
    // nobody has tested.
    //
    // Proof: `workedRolesOf`'s estimates and actuals dropped, so the fold sees
    // only the stated roles, and this fails with `done` where `in_progress` is
    // owed; watched 2026-08-18.
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setEstimate(strip, OWNER, QA, days(1, 1, 1));

    await service.setProgress(strip, OWNER, DEV, 'done');

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 'done' });
    expect((await states()).get('Strip')).toBe('in_progress');
  });

  it('is done only when every role with work on the row says so', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setEstimate(strip, OWNER, QA, days(1, 1, 1));
    await service.setProgress(strip, OWNER, DEV, 'done');

    await service.setProgress(strip, OWNER, QA, 'done');

    expect((await states()).get('Strip')).toBe('done');
  });

  it('counts a role that only has a recorded day as work still to be spoken about', async () => {
    // The other half of the candidate set: a role nobody estimated but somebody
    // recorded days against is work on this row, so its silence keeps the item
    // in progress.
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, QA, 2);

    await service.setProgress(strip, OWNER, DEV, 'done');

    expect((await states()).get('Strip')).toBe('in_progress');
  });

  it('refuses to state a work item that has children', async () => {
    // A parent's reading is folded from its descendants', so a stored state
    // there would be a row every reader ignores. The same refusal
    // `setEstimate` and `setActual` make against the same shape of row.
    const strip = await add('Strip');
    await add('Sand', strip);

    const outcome = await service.setProgress(strip, OWNER, DEV, 'done');

    expect(outcome).toEqual({ ok: false, reason: 'rolled_up' });
    expect(await progress.listByProject(projectId)).toEqual([]);
  });

  it('refuses a role this project does not hold, and writes nothing', async () => {
    const strip = await add('Strip');

    const outcome = await service.setProgress(strip, OWNER, 'role-design', 'done');

    expect(outcome).toEqual({ ok: false, reason: 'unknown_role' });
    expect(await progress.listByProject(projectId)).toEqual([]);
  });

  it('refuses a work item that is not there, and a plan the actor cannot edit', async () => {
    const strip = await add('Strip');

    expect(await service.setProgress(crypto.randomUUID(), OWNER, DEV, 'done')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await service.setProgress(strip, OTHER, DEV, 'done')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await progress.listByProject(projectId)).toEqual([]);
  });

  it('folds a parent from its children, and a mixed branch reads as in progress', async () => {
    const branch = await add('Branch');
    const first = await add('Strip', branch);
    const second = await add('Sand', branch);
    await service.setEstimate(second, OWNER, DEV, days(1, 1, 1));
    await service.setProgress(first, OWNER, DEV, 'done');

    // One child finished, the other estimated and silent: the branch is under
    // way, and the per-role fold says the same because `agree` sees the second
    // child's `not_started`.
    expect((await states()).get('Branch')).toBe('in_progress');
    expect((await shown()).get('Branch')).toEqual({ [DEV]: 'in_progress' });

    await service.setProgress(second, OWNER, DEV, 'done');

    // Both finished: the branch is finished, and the roll-up says so per role.
    expect((await states()).get('Branch')).toBe('done');
    expect((await shown()).get('Branch')).toEqual({ [DEV]: 'done' });
  });

  it('a branch is not done while one of its rows has never been spoken about', async () => {
    // The empty sibling: no estimate, no recorded day, nothing said. It holds no
    // role, so the **per-role** fold cannot see it — `{dev: done}` is all it
    // answers — and reading the branch off that map would report finished work
    // over a row nobody has touched. The item state is folded over the children
    // instead, and silence keeps the branch in progress.
    //
    // Both fields are asserted together because the pair looks inconsistent and
    // is not: Dev has finished everywhere Dev has work, and the branch has not.
    const branch = await add('Branch');
    const first = await add('Strip', branch);
    await add('Sand', branch);
    await service.setProgress(first, OWNER, DEV, 'done');

    expect((await shown()).get('Branch')).toEqual({ [DEV]: 'done' });
    expect((await states()).get('Branch')).toBe('in_progress');
    expect((await states()).get('Sand')).toBe('not_started');
  });

  it('takes a statement back, and clearing what nobody said is not an error', async () => {
    const strip = await add('Strip');
    await service.setProgress(strip, OWNER, DEV, 'in_progress');

    expect(await service.clearProgress(strip, OWNER, DEV)).toEqual({ ok: true, result: null });
    // Back to the absence of a row, which is "nobody has said" — not "the work
    // was undone", and not a stored `not_started`.
    expect(await progress.listByProject(projectId)).toEqual([]);
    expect((await states()).get('Strip')).toBe('not_started');

    expect(await service.clearProgress(strip, OWNER, DEV)).toEqual({ ok: true, result: null });
    expect(await service.clearProgress(crypto.randomUUID(), OWNER, DEV)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('journals the write as a command, which is what puts it in the plan’s history', async () => {
    const strip = await add('Strip');

    await service.setProgress(strip, OWNER, DEV, 'done');
    await service.clearProgress(strip, OWNER, DEV);

    // The kinds H1's log filters on, arriving through the seam that already
    // exists rather than through a second write path.
    expect(journal.events.map((each) => each.kind)).toEqual([
      'create',
      'progress',
      'clear_progress',
    ]);
    expect(journal.events.at(1)).toEqual({ kind: 'progress', roleId: DEV });
    expect(journal.events.at(2)).toEqual({ kind: 'clear_progress', roleId: DEV });
  });

  it('records nothing at all for clearing a statement that was never made', async () => {
    const strip = await add('Strip');

    await service.clearProgress(strip, OWNER, DEV);

    // Nothing changed, so there is nothing to undo and nothing for the history
    // to carry. The same skip `clearEstimate` and `clearActual` make.
    //
    // Proof: the `before !== null` skip removed from `clearProgress`, and this
    // fails with `+ "clear_progress"` — a history row and an undo entry for a
    // command that did nothing; watched 2026-08-18.
    expect(journal.events.map((each) => each.kind)).toEqual(['create']);
  });

  it('undoes a first statement back to absence, not to not-started-as-a-row', async () => {
    const strip = await add('Strip');
    await service.setProgress(strip, OWNER, DEV, 'done');

    const undone = await service.undo(projectId, OWNER);

    expect(undone.ok).toBe(true);
    // The inverse of a first statement is `clear_progress`. A `set_progress`
    // carrying a third value would be the one thing this table must never hold.
    //
    // Proof: the inverse written as a `set_progress` of `in_progress`, and this
    // fails with `+ { "role-dev": "in_progress" }` where an absence is owed — an
    // undo leaving the plan asserting work is under way that nobody started;
    // watched 2026-08-18.
    expect(await progress.listByProject(projectId)).toEqual([]);
    expect((await states()).get('Strip')).toBe('not_started');
  });

  it('undoes a correction back to the state it replaced, and redoes it again', async () => {
    const strip = await add('Strip');
    await service.setProgress(strip, OWNER, DEV, 'in_progress');
    await service.setProgress(strip, OWNER, DEV, 'done');

    await service.undo(projectId, OWNER);
    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, state: 'in_progress' },
    ]);

    await service.redo(projectId, OWNER);
    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, state: 'done' },
    ]);
  });

  it('undoes a clear by saying it again', async () => {
    const strip = await add('Strip');
    await service.setProgress(strip, OWNER, DEV, 'done');
    await service.clearProgress(strip, OWNER, DEV);

    await service.undo(projectId, OWNER);

    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, state: 'done' },
    ]);
  });
});

describe('states through the structural commands', () => {
  it('hands a statement down when a leaf gains its first child, and back up on undo', async () => {
    const strip = await add('Strip');
    await service.setProgress(strip, OWNER, DEV, 'done');

    const child = await add('Sand', strip);

    // The row is the child's now. Left on the parent it would be invisible —
    // a parent's reading is folded — and back on screen the day the child is
    // deleted, claiming work is finished that the plan has moved on from.
    //
    // Proof: `progress.moveAll` struck from `create`, and this fails with the
    // child empty; watched 2026-08-18.
    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: child, roleId: DEV, state: 'done' },
    ]);
    expect((await states()).get('Strip')).toBe('done');

    await service.undo(projectId, OWNER);

    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, state: 'done' },
    ]);
  });

  it('hands the branch’s reading up when its last child is deleted', async () => {
    const branch = await add('Branch');
    const child = await add('Strip', branch);
    await service.setProgress(child, OWNER, DEV, 'done');

    await service.remove(child, OWNER, 'cascade');

    // Without this the statement is simply gone with the cascade while the
    // estimates beside it survive on the parent — the drift this change exists
    // not to have, in the tense that matters most: a finished branch reading as
    // work nobody has started.
    //
    // Proof: the hand-up loop struck from `remove`, and this fails with the
    // parent empty where `done` is owed; watched 2026-08-18.
    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: branch, roleId: DEV, state: 'done' },
    ]);
    expect((await states()).get('Branch')).toBe('done');
  });

  it('hands up what was said and nothing else, so the parent still reads as in progress', async () => {
    // The fold, not the rows — and only the part of the fold anybody stated. The
    // branch had Dev finished and QA estimated and silent, so `done` comes up
    // and QA's silence does **not** come up as a row: the absence of a row is
    // how silence is spelled, and writing `not_started` would be the second
    // spelling this table exists without.
    //
    // The reading survives the delete anyway, which is the claim that matters:
    // the QA estimate is handed up beside it, so the parent still holds work
    // nobody has spoken about and still reads as in progress.
    const branch = await add('Branch');
    const child = await add('Strip', branch);
    await service.setEstimate(child, OWNER, QA, days(1, 1, 1));
    await service.setProgress(child, OWNER, DEV, 'done');
    expect((await states()).get('Branch')).toBe('in_progress');

    await service.remove(child, OWNER, 'cascade');

    expect(stored(await progress.listByProject(projectId))).toEqual([
      { workItemId: branch, roleId: DEV, state: 'done' },
    ]);
    expect((await states()).get('Branch')).toBe('in_progress');
  });

  it('copies the estimate into a duplicate and leaves the statement behind', async () => {
    // A duplicate is work nobody has done. Copying a `done` would hand the plan
    // a branch that reports itself finished the moment it appears — the actual's
    // lie in a stronger tense.
    //
    // Proof: the duplicate's `progress` filled from the original's rows, and
    // this fails with `+ { "role-dev": "done" }` on a row nobody has worked on;
    // watched 2026-08-18.
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setProgress(strip, OWNER, DEV, 'done');

    const copied = await service.duplicate(strip, OWNER);
    if (!copied.ok) throw new Error('duplicate failed');

    const tree = await service.tree(projectId);
    const copy = tree?.workItems.find((row) => row.id === copied.result.id);
    expect(copy?.estimates).toEqual({ [DEV]: days(1, 2, 3) });
    expect(copy?.progress).toEqual({});
    expect(copy?.state).toBe('not_started');
  });
});

describe('what stating progress does not do', () => {
  it('moves no date: the plan schedules identically with and without a state', async () => {
    // R6's whole product decision as an assertion. The engine's input map is
    // built from estimates in `slicesOf` and this table is not in it, so a role
    // marked done moves no bar and no successor.
    //
    // Proof: the engine wired to skip a finished role's slice — the obvious
    // reading of "done" and the one the next change has to argue for
    // deliberately — and this fails with every date downstream moved; watched
    // 2026-08-18. `service/schedule.ts` has an empty diff on this branch, and
    // this is the behavioural half of that claim.
    const first = await add('Strip');
    const second = await add('Sand');
    await service.setEstimate(first, OWNER, DEV, days(4, 5, 6));
    await service.setEstimate(second, OWNER, DEV, days(1, 2, 3));
    await service.addDependency(second, OWNER, first);
    const before = await service.tree(projectId);

    await service.setProgress(first, OWNER, DEV, 'done');
    await service.setActual(first, OWNER, DEV, 20);

    const after = await service.tree(projectId);
    const schedules = (
      tree: Awaited<ReturnType<WorkItemService['tree']>>,
    ): Record<string, unknown>[] =>
      (tree?.workItems ?? []).map((row) => ({ name: row.name, schedule: row.schedule }));
    expect(schedules(after)).toEqual(schedules(before));
  });
});
