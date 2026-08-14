import { beforeEach, describe, expect, it } from 'bun:test';

import type { EstimateStore, Project, ProjectStore, WorkItemStore } from '../repository';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import type { ProjectEvent } from './broadcast';
import type { Days } from './roll-up';
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';
const DEV = 'role-dev';
const QA = 'role-qa';

let projects: ProjectStore;
let workItems: WorkItemStore;
let estimates: EstimateStore;
let broadcast: ReturnType<typeof recordingBroadcaster>;
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  projects = inMemoryProjects();
  workItems = inMemoryWorkItems();
  estimates = inMemoryEstimates(workItems);
  broadcast = recordingBroadcaster();
  service = new WorkItemService({
    workItems,
    projects,
    estimates,
    dependencies: inMemoryDependencies(),
    directory: inMemoryDirectory(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    journal: inMemoryCommandJournal(),
    broadcast,
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
  // The two roles these cases estimate against. A project that held neither
  // would refuse every write here, as production's foreign key does.
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

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

/**
 * Estimates by work item name. A Map rather than a Record because indexing a
 * Record is typed as always present, and every assertion below turns on the
 * difference between a role that is absent and one that is zero.
 */
async function shown(): Promise<Map<string, Record<string, Days>>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return new Map(tree.workItems.map((w) => [w.name, w.estimates]));
}

/**
 * The names an event carries, or a loud failure when it carries none.
 *
 * `ProjectEvent` also covers the role events, which carry a role rather than
 * work items, so reading `workItems` off the union needs a narrowing — and a
 * test that quietly read nothing would assert against an empty list.
 */
function namesIn(event: ProjectEvent | undefined): string[] {
  if (event === undefined) throw new Error('nothing was published');
  if (event.type !== 'work_items_changed' && event.type !== 'tree_replaced') {
    throw new Error(`a ${event.type} event carries no work items`);
  }
  return event.workItems.map((each) => each.name);
}

describe('setting estimates', () => {
  it('stores an estimate against a leaf and shows it in the tree', async () => {
    const strip = await add('Strip');

    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));

    expect((await shown()).get('Strip')?.[DEV]).toEqual(days(1, 2, 3));
  });

  it('refuses an estimate on a work item that has children', async () => {
    // Its figures are the sum of what is below it. A stored estimate here would
    // either be ignored or double-counted, and neither is visible to whoever
    // typed it.
    const strip = await add('Strip');
    await add('Sockets', strip);

    const outcome = await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));

    expect(outcome).toEqual({ ok: false, reason: 'rolled_up' });
  });

  it('marks a parent as rolled up and a leaf as not', async () => {
    const strip = await add('Strip');
    await add('Sockets', strip);

    const tree = await service.tree(projectId);
    const byName = new Map(tree?.workItems.map((w) => [w.name, w.rolledUp]));
    expect(byName.get('Strip')).toBe(true);
    expect(byName.get('Sockets')).toBe(false);
  });
});

describe('estimates follow the first and last child', () => {
  it('hands the estimate down when a first child arrives', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));

    await add('Sockets', strip);

    const tree = await shown();
    // The child now holds it, and the parent still reports the same total —
    // which is what makes the move safe to do without asking.
    expect(tree.get('Sockets')?.[DEV]).toEqual(days(1, 2, 3));
    expect(tree.get('Strip')?.[DEV]).toEqual(days(1, 2, 3));
  });

  it('takes the estimate back when the last child goes', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    const sockets = await add('Sockets', strip);

    await service.remove(sockets, OWNER, 'cascade');

    expect((await shown()).get('Strip')?.[DEV]).toEqual(days(1, 2, 3));
  });

  it('leaves the estimate alone when a second child arrives', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await add('Sockets', strip);

    await add('Switches', strip);

    const tree = await shown();
    expect(tree.get('Sockets')?.[DEV]).toEqual(days(1, 2, 3));
    expect(tree.get('Switches')?.[DEV]).toBeUndefined();
  });
});

describe('roll-up through the tree', () => {
  it('sums two children into their parent, per role', async () => {
    const strip = await add('Strip');
    const one = await add('Sockets', strip);
    const two = await add('Switches', strip);
    await service.setEstimate(one, OWNER, DEV, days(1, 2, 3));
    await service.setEstimate(two, OWNER, DEV, days(2, 3, 4));
    await service.setEstimate(one, OWNER, QA, days(0.5, 0.5, 1));

    const tree = await shown();

    expect(tree.get('Strip')?.[DEV]).toEqual(days(3, 5, 7));
    expect(tree.get('Strip')?.[QA]).toEqual(days(0.5, 0.5, 1));
  });

  it('omits a role no descendant estimated', async () => {
    const strip = await add('Strip');
    const one = await add('Sockets', strip);
    await service.setEstimate(one, OWNER, DEV, days(1, 2, 3));

    expect((await shown()).get('Strip')?.[QA]).toBeUndefined();
  });
});

describe('clearing estimates', () => {
  it('takes the trio away and leaves the other role alone', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await service.setEstimate(strip, OWNER, QA, days(4, 5, 6));

    const outcome = await service.clearEstimate(strip, OWNER, DEV);

    expect(outcome).toEqual({ ok: true, result: null });
    expect((await shown()).get('Strip')).toEqual({ [QA]: days(4, 5, 6) });
  });

  it('is a success when there was nothing to clear', async () => {
    // The state asked for is the state left. Two browsers emptying the same
    // three boxes must not turn the second one into an error on screen.
    const strip = await add('Strip');

    expect(await service.clearEstimate(strip, OWNER, DEV)).toEqual({ ok: true, result: null });
  });

  it('refuses a stranger on a restricted project, and clears nothing', async () => {
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, DEV, days(1, 2, 3));
    await projects.update(projectId, { restricted: true });

    const outcome = await service.clearEstimate(strip, 'not-the-owner', DEV);

    expect(outcome).toEqual({ ok: false, reason: 'forbidden' });
    expect((await shown()).get('Strip')?.[DEV]).toEqual(days(1, 2, 3));
  });

  it('refuses a work item that is not there', async () => {
    expect(await service.clearEstimate(crypto.randomUUID(), OWNER, DEV)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('tells the project’s subscribers, with the ancestors whose totals moved', async () => {
    // The same narrow announce `setEstimate` sends. Without it a peer's table
    // keeps showing a figure be-01 no longer holds until something else
    // happens to refresh it.
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await service.setEstimate(sockets, OWNER, DEV, days(1, 2, 3));
    broadcast.published.length = 0;

    await service.clearEstimate(sockets, OWNER, DEV);

    const last = broadcast.published.at(-1);
    expect(last?.projectId).toBe(projectId);
    expect(last?.event.type).toBe('work_items_changed');
    expect(namesIn(last?.event)).toEqual(['Sockets', 'Strip']);
  });
});
