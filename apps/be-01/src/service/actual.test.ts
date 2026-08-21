import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  ActualStore,
  CommandJournalStore,
  EstimateStore,
  MeasureStore,
  Project,
  ProjectStore,
  RoleProgressStore,
  StoredActual,
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
  // The journal, with the history rows it is handed kept where a test can read
  // them. H1 writes the plan's event from inside `append`, so this is the seam
  // an actual has to arrive through if it is to be in the history for free.
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
 * is rather than when it was typed. `recordedAt` is the wall clock, so a case
 * naming it would be asserting against `Date.now()`.
 */
function stored(
  rows: readonly StoredActual[],
): { workItemId: string; roleId: string; days: number }[] {
  return rows.map(({ workItemId, roleId, days }) => ({ workItemId, roleId, days }));
}

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

/**
 * Recorded days by work item name, as the payload carries them.
 *
 * A Map rather than a Record for the reason `estimate.test.ts` gives: indexing
 * a Record is typed as always present, and every assertion here turns on the
 * difference between a role that is absent and one that is zero.
 */
async function shown(): Promise<Map<string, Record<string, number>>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return new Map(tree.workItems.map((w) => [w.name, w.actuals]));
}

describe('recording actual days', () => {
  it('stores the days against a leaf and shows them beside the estimate', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));

    await service.setActual(strip, OWNER, DEV, 8);

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 8 });
    // The estimate is untouched: the two are separate facts about one pair, and
    // recording what happened must never rewrite what was expected — which is
    // the evidence R5's snapshots exist to preserve.
    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.name === 'Strip')?.estimates[DEV]).toEqual(days(1, 2, 3));
  });

  it('leaves a role nobody has recorded absent rather than zero', async () => {
    // The rule this table is built on. `{QA: 0}` and `{}` render identically in
    // a spreadsheet and mean opposite things: "QA spent no days on it" against
    // "nobody has said what QA spent", and only the second is true here.
    const strip = await add('Strip');

    await service.setActual(strip, OWNER, DEV, 8);

    const shownFor = (await shown()).get('Strip');
    expect(shownFor).toEqual({ [DEV]: 8 });
    expect(QA in (shownFor ?? {})).toBe(false);
  });

  it('keeps a recorded zero, which is a person saying the work took no days', async () => {
    const strip = await add('Strip');

    await service.setActual(strip, OWNER, DEV, 0);

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 0 });
  });

  it('refuses to record days on a work item that has children', async () => {
    // Its figures are the sum of what is below it, so a stored number here
    // would be ignored or double-counted — the refusal `setEstimate` makes, for
    // the same reason and with the same reason word.
    const strip = await add('Strip');
    await add('Sockets', strip);

    const outcome = await service.setActual(strip, OWNER, DEV, 4);

    expect(outcome).toEqual({ ok: false, reason: 'rolled_up' });
    expect((await shown()).get('Strip')).toEqual({});
  });

  it('refuses a role this project does not hold, and writes nothing', async () => {
    const strip = await add('Strip');

    const outcome = await service.setActual(strip, OWNER, 'role-design', 4);

    expect(outcome).toEqual({ ok: false, reason: 'unknown_role' });
    expect((await shown()).get('Strip')).toEqual({});
  });

  it('refuses a work item that is not there, and a plan the actor cannot edit', async () => {
    const strip = await add('Strip');

    expect(await service.setActual('nope', OWNER, DEV, 4)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await service.setActual(strip, OTHER, DEV, 4)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await service.clearActual(strip, OTHER, DEV)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('sums a parent’s recorded days from its descendants, and reports nothing where nothing was recorded', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    const switches = await add('Switches', strip);
    await add('Sand');

    await service.setActual(sockets, OWNER, DEV, 2);
    await service.setActual(switches, OWNER, DEV, 3);
    await service.setActual(switches, OWNER, QA, 1);

    const all = await shown();
    expect(all.get('Strip')).toEqual({ [DEV]: 5, [QA]: 1 });
    // A branch nobody has recorded anything under is empty, not zero.
    expect(all.get('Sand')).toEqual({});
  });

  it('takes the days back off, and a clear of nothing is not an error', async () => {
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, DEV, 8);

    expect(await service.clearActual(strip, OWNER, DEV)).toEqual({ ok: true, result: null });
    expect(await service.clearActual(strip, OWNER, DEV)).toEqual({ ok: true, result: null });

    // Back to absence, which is the state the request asked for — never a zero.
    expect((await shown()).get('Strip')).toEqual({});
  });

  it('journals the write as a command, which is what puts it in the plan’s history', async () => {
    // The ordering the brief calls non-negotiable: H2 goes through the seam H1
    // built rather than around it, so an actual is undoable and recorded for
    // free. A separate write path would have to build both again.
    const strip = await add('Strip');

    await service.setActual(strip, OWNER, DEV, 8);
    await service.clearActual(strip, OWNER, DEV);

    expect(journal.events.map((each) => each.kind)).toEqual(['create', 'actual', 'clear_actual']);
    // The role travels on the event, which is what "how did this figure move"
    // filters on.
    expect(journal.events.at(1)?.roleId).toBe(DEV);
    expect(journal.events.at(2)?.roleId).toBe(DEV);
  });

  it('records nothing at all for clearing days that were never recorded', async () => {
    // A command that changed nothing is not one to reverse, and a plan must not
    // gain a history row every time somebody empties an empty box — the skip
    // `clearEstimate` makes, asserted here so the two cannot drift.
    const strip = await add('Strip');

    await service.clearActual(strip, OWNER, DEV);

    expect(journal.events.map((each) => each.kind)).toEqual(['create']);
  });

  it('undoes a first recording back to absence, not to zero', async () => {
    // The single most important undo in this change. The inverse of the first
    // recording is `clear_actual`, and a `set_actual` with 0 would leave the
    // plan asserting that the work took no days — which nobody said.
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, DEV, 8);

    const undone = await service.undo(projectId, OWNER);

    expect(undone.ok).toBe(true);
    expect((await shown()).get('Strip')).toEqual({});
  });

  it('undoes a correction back to the figure it replaced, and redoes it again', async () => {
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, DEV, 8);
    await service.setActual(strip, OWNER, DEV, 13);

    await service.undo(projectId, OWNER);
    expect((await shown()).get('Strip')).toEqual({ [DEV]: 8 });

    await service.redo(projectId, OWNER);
    expect((await shown()).get('Strip')).toEqual({ [DEV]: 13 });
  });

  it('undoes a clear by putting the figure back', async () => {
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, DEV, 8);
    await service.clearActual(strip, OWNER, DEV);

    await service.undo(projectId, OWNER);

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 8 });
  });
});

describe('actuals through the structural commands', () => {
  it('hands the recorded days down when a leaf gains its first child, and back up on undo', async () => {
    // Without the hand-down the row is invisible: a parent's figures are the
    // sum of its children's, so an actual left on a row that has just gained
    // one is stored, unreadable, and back on screen the day the child is
    // deleted. The estimates have moved this way since they were written; this
    // is the same move, and the undo is what makes it safe to do silently.
    const strip = await add('Strip');
    await service.setActual(strip, OWNER, DEV, 8);

    const sockets = await add('Sockets', strip);

    const moved = await shown();
    expect(moved.get('Sockets')).toEqual({ [DEV]: 8 });
    // The parent still reports 8 — as a sum now rather than as its own row,
    // which is what makes the move invisible to whoever typed it.
    expect(moved.get('Strip')).toEqual({ [DEV]: 8 });
    expect(stored(await actuals.listByProject(projectId))).toEqual([
      { workItemId: sockets, roleId: DEV, days: 8 },
    ]);

    await service.undo(projectId, OWNER);

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 8 });
    expect(stored(await actuals.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, days: 8 },
    ]);
  });

  it('hands the branch’s recorded days up when its last child is deleted', async () => {
    // The mirror of the rule above, and the reason it cannot be skipped: the
    // rows cascade with the work item, so without the hand-up the days are
    // simply gone the moment the last child goes — while the estimates beside
    // them survive on the parent.
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await service.setEstimate(sockets, OWNER, DEV, days(1, 2, 3));
    await service.setActual(sockets, OWNER, DEV, 5);

    await service.remove(sockets, OWNER, 'cascade');

    expect((await shown()).get('Strip')).toEqual({ [DEV]: 5 });
  });

  // **The restore is not tested here, deliberately.** The in-memory store cannot
  // model `actual.work_item_id`'s cascade — a deleted work item's rows sit in its
  // array untouched and reappear the moment the row is restored — so a case
  // written here passes with the restore's `actuals` replaced by `[]`. Watched
  // exactly that way (F9a in verify.md) and moved to `undo.test.ts`, which runs
  // against real SQLite.

  it('copies the estimate into a duplicate and leaves the recorded days behind', async () => {
    // A duplicate is work nobody has done. Copying the actuals would tell the
    // plan a fortnight was already spent on it, and the copy would appear with
    // a variance the moment H3 draws one.
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setActual(strip, OWNER, DEV, 8);

    const copied = await service.duplicate(strip, OWNER);
    expect(copied.ok).toBe(true);

    const tree = await service.tree(projectId);
    const copy = tree?.workItems.find((w) => w.name !== 'Strip' && w.name.includes('Strip'));
    expect(copy?.estimates[DEV]).toEqual(days(1, 2, 3));
    expect(copy?.actuals).toEqual({});
  });
});

describe('what recording days does not do', () => {
  it('moves no date: the plan schedules identically with and without an actual', async () => {
    // R6 is reporting only, and this is that claim as an assertion rather than
    // a sentence. The engine's input map is built from estimates in `slicesOf`;
    // nothing below it reads this table. The model has no completion state, so
    // it could not tell "took 8 days, finished" from "8 days so far" even if it
    // wanted to — see design.md D3.
    await projects.update(projectId, { startDate: '2026-09-01' });
    const strip = await add('Strip');
    const sand = await add('Sand');
    await service.setEstimate(strip, OWNER, DEV, days(2, 2, 2));
    await service.setEstimate(sand, OWNER, DEV, days(3, 3, 3));
    await service.addDependency(sand, OWNER, strip);

    const before = await service.tree(projectId);

    // Wildly over the estimate, on the predecessor, which is where a scheduling
    // actual would move every date downstream of it.
    await service.setActual(strip, OWNER, DEV, 40);

    const after = await service.tree(projectId);
    expect(
      after?.workItems.map((w) => ({ name: w.name, schedule: w.schedule, dates: w.dates })),
    ).toEqual(
      before?.workItems.map((w) => ({ name: w.name, schedule: w.schedule, dates: w.dates })),
    );
    expect(after?.slices).toEqual(before?.slices ?? []);
  });
});
