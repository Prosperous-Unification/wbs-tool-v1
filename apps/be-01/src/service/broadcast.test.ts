import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore } from '../repository';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import { DeferringBroadcaster, type ProjectEvent } from './broadcast';
import type { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';

let projects: ProjectStore;
let broadcast: RecordingBroadcaster;
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects } = harness.stores);
  broadcast = harness.broadcast;
  service = harness.service;
  const project: Project = projectRow({
    id: crypto.randomUUID(),
    ownerId: OWNER,
  });
  // Seeded with the step the estimates below name — the service refuses one
  // the project does not hold.
  await projects.create(
    project,
    [{ id: 'step-dev', projectId: project.id, name: 'Dev', position: 10 }],
    { at: 1, by: OWNER },
  );
  projectId = project.id;
});

async function add(name: string, parentId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

// `.at` rather than an index: indexing is typed as always present, and every
// assertion here is on a payload that might legitimately not exist.
const latest = () => broadcast.published.at(-1);

/**
 * The names an event carries, or a loud failure when it carries none.
 *
 * `ProjectEvent` also covers the step events, which carry a step rather than
 * work items, so reading `workItems` off the union needs a narrowing — and a
 * test that quietly read nothing would assert against an empty list.
 */
function namesIn(event: ProjectEvent | undefined): string[] {
  if (event === undefined) throw new Error('nothing was published');
  if (event.type !== 'tree_replaced') {
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

  // A cell edit used to send the edited row and its ancestors. It cannot any
  // more: every write arrives in a batch, the batch announces once after it
  // commits, and there is no single row to name. What these two hold is that a
  // figure edit and a name edit each still reach subscribers, carrying the
  // whole plan and therefore the ancestors whose totals moved with it.
  it('sends the whole tree when an estimate changes, ancestors included', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    const boxes = await add('Back boxes', sockets);
    broadcast.published.length = 0;

    await service.setEstimate(boxes, OWNER, 'step-dev', {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });

    const event = latest()?.event;
    expect(event?.type).toBe('tree_replaced');
    expect(namesIn(event)).toEqual(['Strip', 'Sockets', 'Back boxes']);
  });

  it('sends the whole tree when a name changes', async () => {
    const strip = await add('Strip');
    broadcast.published.length = 0;

    await service.patch(strip, OWNER, { name: 'Strip the old wiring' });

    expect(latest()?.event.type).toBe('tree_replaced');
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

/**
 * The nested-hold guard, which R5 requires a negative test for because
 * TASK-256 changed what it inspects.
 *
 * It used to read instance state, so it caught two *concurrent* batches and
 * that is the failure it was written for — `plan-commands.ts`'s `Proof:`
 * comment names one, watched 2026-09-02. Making the queue per-caller retired
 * that symptom: concurrent batches now get a store each and never meet here.
 * What is left is the case the guard is actually still needed for, and it is a
 * different one — a hold opened *inside* another hold's own context, which
 * `AsyncLocalStorage` would answer by shadowing the parent's store. The parent
 * would then commit having been told nothing about what the child announced,
 * which is the same silent drop this whole task is about, one level in.
 *
 * So the guard's reachable path narrowed and its test had to follow. Without
 * one, deleting the two lines leaves the suite green.
 */
describe('DeferringBroadcaster refuses a nested hold', () => {
  it('throws rather than shadowing the outer hold, and the outer queue survives', async () => {
    const inner = recordingBroadcaster();
    const broadcaster = new DeferringBroadcaster(inner);

    let nested: unknown;
    const { pending } = await broadcaster.hold(async () => {
      await broadcaster.publish('p-1', { type: 'directory_changed' });
      nested = await broadcaster
        .hold(() => Promise.resolve(undefined))
        .then(() => undefined)
        .catch((error: unknown) => error);
    });

    expect(nested).toBeInstanceOf(Error);
    expect((nested as Error).message).toBe('a batch is already holding announcements');
    // The outer batch still owns everything it queued: a shadowing store would
    // have handed it an empty one and sent nothing.
    expect(pending).toEqual([{ projectId: 'p-1', event: { type: 'directory_changed' } }]);
    // And nothing escaped to the inner broadcaster while the hold was open.
    expect(inner.published).toEqual([]);
  });
});
