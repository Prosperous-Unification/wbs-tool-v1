import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore, WorkItemStore } from '../repository';
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
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import type { Days } from './roll-up';
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';
const DEV = 'role-dev';

let projects: ProjectStore;
let workItems: WorkItemStore;
let journal: ReturnType<typeof inMemoryCommandJournal>;
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  projects = inMemoryProjects();
  workItems = inMemoryWorkItems();
  journal = inMemoryCommandJournal();
  service = new WorkItemService({
    workItems,
    projects,
    estimates: inMemoryEstimates(workItems),
    actuals: inMemoryActuals(workItems),
    measures: inMemoryMeasures(workItems),
    progress: inMemoryProgress(workItems),
    dependencies: inMemoryDependencies(),
    directory: inMemoryDirectory(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    journal,
    broadcast: recordingBroadcaster(),
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: 'Rewire the shed',
    ownerId: OWNER,
    restricted: false,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  };
  await projects.create(project, [{ id: DEV, projectId: project.id, name: 'Dev', position: 10 }]);
  projectId = project.id;
});

const days = (optimistic: number, realistic: number, pessimistic: number): Days => ({
  optimistic,
  realistic,
  pessimistic,
});

async function add(name: string): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId: null, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

/**
 * What `WorkItemService.record` writes to the plan's history.
 *
 * The seam is one call and every journalled command goes through it, so these
 * cases are about the *derivation*: which row an event names, which role, and
 * that the before and after are the two commands the journal already held. What
 * the store does with the pair is `repository/command-journal.test.ts`.
 */
describe('the plan’s history, as commands are recorded', () => {
  it('records the estimate that was set, with the trio it replaced', async () => {
    // The whole of R5's sentence: "so that later I can examine the history of
    // estimates changes". The before is the compensating command, which for an
    // estimate over an estimate carries the trio that was stored.
    //
    // Proof: the fixture's `events.push(event)` struck — the same shape as
    // `record` not passing the second argument at all — and **five of this file's
    // seven cases** went red: `Expected length: 2 / Received length: 0` here, and
    // `Expected: "<uuid>" / Received: undefined` on the two that name a row. The
    // plan's whole history absent while every undo key still worked. 2 pass, 5
    // fail; watched 2026-08-17.
    const id = await add('Strip the roof');
    await service.setEstimate(id, OWNER, DEV, days(1, 2, 3));
    await service.setEstimate(id, OWNER, DEV, days(2, 4, 8));

    const estimates = journal.events.filter((each) => each.kind === 'estimate');
    expect(estimates).toHaveLength(2);
    expect(estimates.at(0)?.before).toEqual({ do: 'clear_estimate', workItemId: id, roleId: DEV });
    expect(estimates.at(1)?.before).toEqual({
      do: 'set_estimate',
      workItemId: id,
      roleId: DEV,
      days: days(1, 2, 3),
    });
    expect(estimates.at(1)?.after).toEqual({
      do: 'set_estimate',
      workItemId: id,
      roleId: DEV,
      days: days(2, 4, 8),
    });
  });

  it('names the work item and the role an estimate was aimed at', async () => {
    // What `?workItemId=` and `?kind=` filter on. Derived from the forward command
    // rather than from `touched`, which for a dependency is two rows and for a
    // freeze is the whole plan.
    const id = await add('Strip the roof');
    await service.setEstimate(id, OWNER, DEV, days(1, 2, 3));

    const recorded = journal.events.at(-1);
    expect(recorded?.workItemId).toBe(id);
    expect(recorded?.roleId).toBe(DEV);
    expect(recorded?.projectId).toBe(projectId);
    expect(recorded?.userId).toBe(OWNER);
    expect(recorded?.label).toBe('estimate “Strip the roof”');
  });

  it('records the clearing of an estimate, and nothing when there was none to clear', async () => {
    // `clearEstimate` is idempotent and skips the journal when nothing was stored
    // — `if (before !== null)`. The history follows it exactly, because a clear
    // that changed nothing is not a change.
    const id = await add('Strip the roof');
    await service.clearEstimate(id, OWNER, DEV);
    expect(journal.events.filter((each) => each.kind === 'clear_estimate')).toHaveLength(0);

    await service.setEstimate(id, OWNER, DEV, days(1, 2, 3));
    await service.clearEstimate(id, OWNER, DEV);

    const cleared = journal.events.filter((each) => each.kind === 'clear_estimate');
    expect(cleared).toHaveLength(1);
    // The trio that was taken away, which is what makes the event readable at all
    // — the estimate itself is gone from the plan.
    expect(cleared.at(0)?.before).toEqual({
      do: 'set_estimate',
      workItemId: id,
      roleId: DEV,
      days: days(1, 2, 3),
    });
  });

  it('records every journalled kind, not only the estimate ones', async () => {
    // The seam is `record`, so a kind reaches the history by being journalled and
    // by nothing else. This is what makes H2's actuals free — and what makes a
    // future write path that skips `record` a hole in two records at once.
    const first = await add('Strip the roof');
    const second = await add('Fit the felt');
    await service.patch(first, OWNER, { name: 'Strip the old roof' });
    await service.addDependency(second, OWNER, first);
    await service.remove(second, OWNER, 'cascade');

    expect(journal.events.map((each) => each.kind)).toEqual([
      'create',
      'create',
      'patch',
      'add_dependency',
      'delete',
    ]);
  });

  it('names the successor for a dependency, and no row at all for a freeze', async () => {
    // A dependency touches two work items and is aimed at the one the request
    // named. A freeze is aimed at the plan: naming one of its rows would make a
    // project-wide act read as that row's own history.
    const first = await add('Strip the roof');
    const second = await add('Fit the felt');
    await service.addDependency(second, OWNER, first);
    await service.freeze(projectId, OWNER);

    const dependency = journal.events.find((each) => each.kind === 'add_dependency');
    expect(dependency?.workItemId).toBe(second);
    expect(dependency?.roleId).toBeNull();

    const frozen = journal.events.find((each) => each.kind === 'freeze');
    expect(frozen?.workItemId).toBeNull();
  });

  it('dates the event at the same instant as the undo entry it was written with', async () => {
    // One act, one moment. Two `now()` calls would let the history and the stack
    // disagree about when a command ran, and the history is ordered by this column.
    const id = await add('Strip the roof');
    await service.setEstimate(id, OWNER, DEV, days(1, 2, 3));

    for (const [n, event] of journal.events.entries()) {
      expect(event.createdAt).toBe(journal.entries[n]?.createdAt ?? -1);
    }
  });

  it('gives the event an id of its own, not the undo entry’s', async () => {
    // Two rows in two tables with two primary keys. Sharing one would tie the
    // history to a stack row that is pruned after fifty commands.
    const id = await add('Strip the roof');
    await service.setEstimate(id, OWNER, DEV, days(1, 2, 3));

    const ids = new Set([
      ...journal.events.map((each) => each.id),
      ...journal.entries.map((each) => each.id),
    ]);
    expect(ids.size).toBe(journal.events.length + journal.entries.length);
  });
});
