import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  ActualStore,
  CommandJournalStore,
  EstimateStore,
  MeasureStore,
  Project,
  ProjectStore,
  RoleProgressStore,
  StoredMeasure,
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
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';
const OTHER = 'somebody-else';
const DEV = 'role-dev';
const QA = 'role-qa';
const GONE = 'role-that-was-removed';

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
  // The same seam `actual.test.ts` reads the history through: H1 writes the
  // plan's event from inside `append`, so a measure that arrives through
  // `record` is in the history for free and a second write path is what this
  // watches for.
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

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

/**
 * The stored rows without their stamps.
 *
 * `recordedAt` is the wall clock, so a case naming it would be asserting
 * against `Date.now()` — `actual.test.ts`'s reading, and the reason the roll-up
 * reads the stamp rather than these cases.
 */
function stored(
  rows: readonly StoredMeasure[],
): { workItemId: string; roleId: string; metric: string; value: number }[] {
  return rows.map(({ workItemId, roleId, metric, value }) => ({
    workItemId,
    roleId,
    metric,
    value,
  }));
}

describe('recording the figures that are not days', () => {
  it('stores a figure against a leaf, in the metric it was given', async () => {
    const strip = await add('Strip');

    const written = await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);

    expect(written.ok).toBe(true);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_estimate', value: 12_000 },
    ]);
  });

  it('keeps the three metrics of one pair as three rows, each absent on its own', async () => {
    // D1's whole claim, and the one thing three tables would have given for
    // free. A pair holding an estimate and no hours has said one thing and not
    // the other; if `set` keyed on the pair alone, the second write would
    // silently replace the first and this reads as one row.
    const strip = await add('Strip');

    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_estimate', value: 12_000 },
      { workItemId: strip, roleId: DEV, metric: 'token_actual', value: 15_400 },
    ]);
  });

  it('clears one metric and leaves that pair’s others alone', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);
    await service.setMeasure(strip, OWNER, DEV, 'hours_actual', 3);

    await service.clearMeasure(strip, OWNER, DEV, 'token_estimate');

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'hours_actual', value: 3 },
    ]);
  });

  it('keeps a recorded zero, which is an agent saying the work cost nothing', async () => {
    const strip = await add('Strip');

    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 0);

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_actual', value: 0 },
    ]);
  });

  it('refuses a metric this release does not keep, as unknown_metric, and writes nothing', async () => {
    // The one refusal the actual pair does not have. 404 and not 400: the path
    // names a unit, and this release keeps no such unit — see `WorkItemRefusal`.
    const strip = await add('Strip');

    // Passed as the plain string it is at the route: since 4.3 the signature
    // says `string` too, so this case no longer needs a cast to say what
    // arrives — it is what arrives.
    const refused = await service.setMeasure(strip, OWNER, DEV, 'tokens_estimate', 12_000);

    expect(refused).toEqual({ ok: false, reason: 'unknown_metric' });
    expect(await measures.listByProject(projectId)).toEqual([]);
    expect(journal.events.map((each) => each.kind)).toEqual(['create']);
  });

  it('refuses a clear in a metric this release does not keep, rather than treating it as a clear of nothing', async () => {
    // Idempotence is about a row that is not there, not about a unit that does
    // not exist: the caller believes in a metric this release has never kept,
    // and answering "done" would confirm it.
    const strip = await add('Strip');

    const refused = await service.clearMeasure(strip, OWNER, DEV, 'hours');

    expect(refused).toEqual({ ok: false, reason: 'unknown_metric' });
  });

  it('refuses a figure on a work item that has children', async () => {
    const strip = await add('Strip');
    await add('Pull the old cable', strip);

    const refused = await service.setMeasure(strip, OWNER, DEV, 'token_actual', 900);

    expect(refused).toEqual({ ok: false, reason: 'rolled_up' });
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('refuses a role this project does not hold, and writes nothing', async () => {
    const strip = await add('Strip');

    const refused = await service.setMeasure(strip, OWNER, GONE, 'token_estimate', 12_000);

    expect(refused).toEqual({ ok: false, reason: 'unknown_role' });
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('refuses a work item that is not there, and a plan the actor cannot edit', async () => {
    const strip = await add('Strip');

    expect(await service.setMeasure(crypto.randomUUID(), OWNER, DEV, 'token_actual', 1)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await service.setMeasure(strip, OTHER, DEV, 'token_actual', 1)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('takes a figure back off, and a clear of nothing is not an error', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, QA, 'hours_actual', 6);

    expect((await service.clearMeasure(strip, OWNER, QA, 'hours_actual')).ok).toBe(true);
    expect((await service.clearMeasure(strip, OWNER, QA, 'hours_actual')).ok).toBe(true);
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('journals both writes as commands, which is what puts them in the plan’s history', async () => {
    const strip = await add('Strip');

    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.clearMeasure(strip, OWNER, DEV, 'token_actual');

    expect(journal.events.map((each) => each.kind)).toEqual(['create', 'measure', 'clear_measure']);
    // The role travels on the event, which is what "how did this figure move"
    // filters on.
    expect(journal.events.at(1)?.roleId).toBe(DEV);
    expect(journal.events.at(2)?.roleId).toBe(DEV);
  });

  it('records nothing at all for clearing a metric that was never recorded', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);

    await service.clearMeasure(strip, OWNER, DEV, 'hours_actual');

    expect(journal.events.map((each) => each.kind)).toEqual(['create', 'measure']);
  });

  it('undoes a first recording back to absence, not to zero', async () => {
    // **F7.** The inverse of a first recording is `clear_measure`; a
    // `set_measure 0` would leave the plan asserting the work cost no tokens,
    // which nobody said. The one case that separates the two.
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);

    const undone = await service.undo(projectId, OWNER);

    expect(undone.ok).toBe(true);
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('undoes a first recording of one metric without touching the pair’s others', async () => {
    // F7's other half: an inverse that dropped the metric would clear whichever
    // row the store found first, and with one metric stored the case above
    // cannot tell the difference.
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);

    await service.undo(projectId, OWNER);

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_estimate', value: 12_000 },
    ]);
  });

  it('undoes a correction back to the figure it replaced, and redoes it again', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_950);

    await service.undo(projectId, OWNER);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_actual', value: 15_400 },
    ]);

    await service.redo(projectId, OWNER);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_actual', value: 15_950 },
    ]);
  });

  it('undoes a clear by putting the figure back in its own metric', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'hours_actual', 6);
    await service.clearMeasure(strip, OWNER, DEV, 'hours_actual');

    await service.undo(projectId, OWNER);

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'hours_actual', value: 6 },
    ]);
  });
});

describe('the figures that are not days, read back through the tree', () => {
  /** One work item's `measures`, by the name a case names it with. */
  async function measuresOn(name: string): Promise<Record<string, Record<string, number>>> {
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('no tree');
    const row = tree.workItems.find((each) => each.name === name);
    if (row === undefined) throw new Error(`no work item called ${name}`);
    return row.measures;
  }

  it('answers a leaf’s own figures, metric first and then role', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(strip, OWNER, QA, 'token_actual', 2_100);
    await service.setMeasure(strip, OWNER, DEV, 'hours_actual', 3);

    expect(await measuresOn('Strip')).toEqual({
      token_actual: { [DEV]: 15_400, [QA]: 2_100 },
      hours_actual: { [DEV]: 3 },
    });
  });

  it('leaves out a metric nobody recorded rather than carrying it empty', async () => {
    // The absence rule one level up from `estimates` and `actuals`, and the
    // reason the object is built by striking metrics rather than by mapping all
    // three. `hours_actual: {}` on this row would say somebody looked at the
    // hours and found none, which nobody did.
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);

    expect(await measuresOn('Strip')).toEqual({ token_estimate: { [DEV]: 12_000 } });
  });

  it('answers an empty object for a row nobody has recorded anything against', async () => {
    await add('Strip');

    expect(await measuresOn('Strip')).toEqual({});
  });

  it('sums a parent’s descendants per metric and per role, and no further', async () => {
    // Two children holding two units between them. The parent's tokens are the
    // sum of the tokens and its hours the sum of the hours — never one number
    // made of both, which is what a fold that ignored the metric would answer.
    const rewire = await add('Rewire');
    const strip = await add('Strip', rewire);
    const pull = await add('Pull cable', rewire);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(pull, OWNER, DEV, 'token_actual', 8_600);
    await service.setMeasure(pull, OWNER, DEV, 'hours_actual', 4);
    await service.setMeasure(pull, OWNER, QA, 'hours_actual', 1);

    expect(await measuresOn('Rewire')).toEqual({
      token_actual: { [DEV]: 24_000 },
      hours_actual: { [DEV]: 4, [QA]: 1 },
    });
  });

  it('reports a branch whose rows hold nothing as holding nothing', async () => {
    // A parent of two silent children, beside the case above: absence folds up
    // as absence, so an empty branch is `{}` and not three empty metrics or a
    // set of zeroes.
    const rewire = await add('Rewire');
    await add('Strip', rewire);
    await add('Pull cable', rewire);

    expect(await measuresOn('Rewire')).toEqual({});
  });

  it('keeps a recorded zero in the sum, because somebody said the work cost nothing', async () => {
    const rewire = await add('Rewire');
    const strip = await add('Strip', rewire);
    const pull = await add('Pull cable', rewire);
    await service.setMeasure(strip, OWNER, DEV, 'hours_actual', 0);
    await service.setMeasure(pull, OWNER, QA, 'hours_actual', 2);

    // `DEV` is a key holding 0 — a statement — where an unrecorded role is no
    // key at all. `toEqual` would pass on a dropped zero if this only read the
    // value, so the presence is asserted on its own.
    const measured = await measuresOn('Rewire');
    expect(Object.hasOwn(measured, 'hours_actual')).toBe(true);
    expect(Object.hasOwn(measured.hours_actual, DEV)).toBe(true);
    expect(measured).toEqual({ hours_actual: { [DEV]: 0, [QA]: 2 } });
  });

  it('stops reporting a metric once its last figure on the row is cleared', async () => {
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(strip, OWNER, DEV, 'hours_actual', 3);

    await service.clearMeasure(strip, OWNER, DEV, 'hours_actual');

    expect(await measuresOn('Strip')).toEqual({ token_actual: { [DEV]: 15_400 } });
  });
});

describe('the figures that are not days, through the structural commands', () => {
  /** One work item's `measures`, found by name. Section 6's cases read the tree. */
  async function measuresOn(name: string): Promise<Record<string, Record<string, number>>> {
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('no tree');
    const row = tree.workItems.find((each) => each.name === name);
    if (row === undefined) throw new Error(`no work item called ${name}`);
    return row.measures;
  }

  it('hands every metric down when a leaf gains its first child, and back up on undo', async () => {
    // The hand-down argument, in the units this change adds. A parent's figures
    // are the sum of its children's, so a token fact left on a row that has just
    // gained a child is stored, unreadable, and back on screen the day the child
    // is deleted — invisible rather than zero, exactly as an actual would be.
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(strip, OWNER, QA, 'hours_actual', 3);

    const sockets = await add('Sockets', strip);

    // All three metrics moved, not the one a single-metric loop would have
    // caught: `moveAll` takes no metric because a leaf stops holding figures in
    // every unit at once.
    expect(stored(await measures.listByProject(projectId)).map((each) => each.workItemId)).toEqual([
      sockets,
      sockets,
      sockets,
    ]);
    // The parent still reports all three — as sums now rather than as its own
    // rows, which is what makes the move invisible to whoever recorded them.
    expect(await measuresOn('Strip')).toEqual({
      token_estimate: { [DEV]: 12_000 },
      token_actual: { [DEV]: 15_400 },
      hours_actual: { [QA]: 3 },
    });

    await service.undo(projectId, OWNER);

    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: DEV, metric: 'token_estimate', value: 12_000 },
      { workItemId: strip, roleId: DEV, metric: 'token_actual', value: 15_400 },
      { workItemId: strip, roleId: QA, metric: 'hours_actual', value: 3 },
    ]);
  });

  it('hands the branch’s figures up in every metric when its last child is deleted', async () => {
    // The mirror, and the reason it cannot be skipped: `role_measure.work_item_id`
    // cascades, so without the hand-up the tokens are gone the moment the last
    // child goes — while the estimate beside them survives on the parent.
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await service.setMeasure(sockets, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(sockets, OWNER, DEV, 'hours_actual', 3);

    await service.remove(sockets, OWNER, 'cascade');

    expect(await measuresOn('Strip')).toEqual({
      token_actual: { [DEV]: 15_400 },
      hours_actual: { [DEV]: 3 },
    });
  });

  it('hands up a metric the branch holds and stays silent about one it does not', async () => {
    // Absence is per metric, and the hand-up is where a fold over all three
    // could quietly stop honouring that: a loop that wrote a row for every
    // metric in `MEASURE_METRICS` would put a 0 on the parent for the two
    // nobody recorded, and 0 is a statement somebody made.
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await service.setMeasure(sockets, OWNER, DEV, 'hours_actual', 4);

    await service.remove(sockets, OWNER, 'cascade');

    expect(await measuresOn('Strip')).toEqual({ hours_actual: { [DEV]: 4 } });
  });

  it('copies the token plan into a duplicate and leaves both records behind', async () => {
    // The one structural rule in this repo that runs *through* a table rather
    // than around it. `token_estimate` describes work, so it copies as the days
    // estimate does; a copy planned in days and not in tokens is half-planned
    // and the reader can see the gap. The two facts are records of what one
    // particular piece of work cost, and copying them would tell the plan that
    // 15,400 tokens nobody has spent were already spent.
    const strip = await add('Strip');
    await service.setMeasure(strip, OWNER, DEV, 'token_estimate', 12_000);
    await service.setMeasure(strip, OWNER, DEV, 'token_actual', 15_400);
    await service.setMeasure(strip, OWNER, QA, 'hours_actual', 3);

    const copied = await service.duplicate(strip, OWNER);
    expect(copied.ok).toBe(true);

    const tree = await service.tree(projectId);
    const copy = tree?.workItems.find(
      (each) => each.name !== 'Strip' && each.name.includes('Strip'),
    );
    expect(copy?.measures).toEqual({ token_estimate: { [DEV]: 12_000 } });
  });

  // **The restore is not tested here, deliberately** — `actual.test.ts`'s
  // reading, and it applies unchanged. The in-memory store cannot model
  // `role_measure.work_item_id`'s cascade: a deleted work item's rows sit in the
  // array untouched and reappear the moment the row comes back, so a case
  // written here passes with the restore's `measures` replaced by `[]`. It lives
  // in `undo.test.ts`, against real SQLite.
});
