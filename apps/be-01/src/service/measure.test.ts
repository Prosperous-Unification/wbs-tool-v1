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
