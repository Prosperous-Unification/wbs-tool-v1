import { beforeEach, describe, expect, it } from 'bun:test';

import type { EstimateStore, Project, ProjectStore, WorkItemStore } from '../repository';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import type { ProjectEvent } from './broadcast';
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';

let projects: ProjectStore;
let workItems: WorkItemStore;
let estimates: EstimateStore;
let broadcast: RecordingBroadcaster;
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
  // Seeded with the role the estimates below name — the service refuses one
  // the project does not hold.
  await projects.create(project, [
    { id: 'role-dev', projectId: project.id, name: 'Dev', position: 10 },
  ]);
  projectId = project.id;
});

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

// `.at` rather than an index: indexing is typed as always present, and every
// assertion here is on a payload that might legitimately not exist.
const latest = () => broadcast.published.at(-1);

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

describe('what a project subscriber receives', () => {
  it('sends the whole tree when a work item is created', async () => {
    await add('Strip');

    expect(latest()?.projectId).toBe(projectId);
    expect(latest()?.event.type).toBe('tree_replaced');
  });

  it('sends the whole tree when a work item moves', async () => {
    const strip = await add('Strip');
    await add('Cable');
    broadcast.published.length = 0;

    await service.move(strip, OWNER, { parentId: null, afterId: null });

    expect(latest()?.event.type).toBe('tree_replaced');
  });

  it('sends a narrow patch when an estimate changes, with the ancestors it moved', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    const boxes = await add('Back boxes', sockets);
    broadcast.published.length = 0;

    await service.setEstimate(boxes, OWNER, 'role-dev', {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });

    const event = latest()?.event;
    expect(event?.type).toBe('work_items_changed');
    // The edited work item and the two above it, whose totals just changed —
    // and nothing else, which is the whole point of the narrow shape.
    expect(namesIn(event)).toEqual(['Back boxes', 'Sockets', 'Strip']);
  });

  it('sends a narrow patch when a name changes', async () => {
    const strip = await add('Strip');
    broadcast.published.length = 0;

    await service.patch(strip, OWNER, { name: 'Strip the old wiring' });

    expect(latest()?.event.type).toBe('work_items_changed');
    expect(namesIn(latest()?.event)).toEqual(['Strip the old wiring']);
  });

  it('sends the whole tree when the project is frozen', async () => {
    await add('Strip');
    broadcast.published.length = 0;

    await service.freeze(projectId, OWNER);

    expect(latest()?.event.type).toBe('tree_replaced');
  });

  it('says nothing when a mutation is refused', async () => {
    const strip = await add('Strip');
    await add('Sockets', strip);
    broadcast.published.length = 0;

    await service.remove(strip, OWNER, null);

    expect(broadcast.published).toEqual([]);
  });
});
