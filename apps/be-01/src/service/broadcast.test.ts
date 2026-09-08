import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore } from '../repository';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import {
  inMemoryCalendarMarkers,
  testCalendarMarkerService,
} from '../testing/calendar-marker-fixture';
import { inMemoryServices } from '../testing/harness';
import { inMemoryProjects, projectRow } from '../testing/project-fixture';
import { AnnouncementCollector, type ProjectEvent } from './broadcast';
import type { CalendarMarkerService } from './calendar-marker.service';
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
 * What the nested-hold guard was for, and what replaced it.
 *
 * The guard lived on `DeferringBroadcaster`, whose queue was an
 * `AsyncLocalStorage` store: a hold opened inside another hold's own context
 * shadowed its parent's, so the parent committed having been told nothing about
 * what the child announced. There is no such window now — a collector is an
 * object a graph was built over, and two batches are two objects — so the guard
 * is gone with the class rather than left standing over a case that cannot
 * happen.
 *
 * What is left to hold is what the collector actually promises: nothing leaves
 * until it is drained, the dedupe rule for content-free events, and the order.
 */
describe('a batch collects its own announcements', () => {
  it('sends nothing until it is drained, then everything in order', async () => {
    const inner = recordingBroadcaster();
    const collector = new AnnouncementCollector(inner);

    await collector.publish('p-1', { type: 'directory_changed' });
    await collector.publish('p-2', { type: 'saved_plans_changed' });
    // Proof: `publish` made to call `this.inner.publish` directly — the shape a
    // batch had before anything held its events — leaves this assertion reading
    // `expected [ Array(2) ] to equal []`, and the two events are gone from the
    // process before the transaction they describe has committed.
    expect(inner.published).toEqual([]);

    await collector.send();
    expect(inner.published).toEqual([
      { projectId: 'p-1', event: { type: 'directory_changed' } },
      { projectId: 'p-2', event: { type: 'saved_plans_changed' } },
    ]);
  });

  it('keeps one content-free event per project, and every event that carries something', async () => {
    const inner = recordingBroadcaster();
    const collector = new AnnouncementCollector(inner);

    await collector.publish('p-1', { type: 'directory_changed' });
    await collector.publish('p-1', { type: 'directory_changed' });
    await collector.publish('p-2', { type: 'directory_changed' });
    await collector.publish('p-1', { type: 'step_removed', stepId: 'a' });
    await collector.publish('p-1', { type: 'step_removed', stepId: 'b' });
    await collector.send();

    // A tag rename across forty projects is forty `directory_changed` and one
    // per project is all any of them says; two `step_removed` are two facts.
    expect(inner.published).toEqual([
      { projectId: 'p-1', event: { type: 'directory_changed' } },
      { projectId: 'p-2', event: { type: 'directory_changed' } },
      { projectId: 'p-1', event: { type: 'step_removed', stepId: 'a' } },
      { projectId: 'p-1', event: { type: 'step_removed', stepId: 'b' } },
    ]);
  });
});

/**
 * Slice 9.1. A marker is the one project-scoped object a collaborator can add
 * that moves no work item, so nothing this project already announces covers it:
 * `tree_replaced` is wrong (no row changed) and `directory_changed` is wrong
 * (the vocabulary is untouched). Without its own event the second client's axis
 * stays as it was until something unrelated forces a re-read.
 *
 * Content-free, for `saved_plans_changed`'s reason: a client reads a project's
 * markers as one list, so the only useful thing to say is "read again", and
 * carrying the row would announce a marker to every reader of the project
 * before the list route has decided what that reader may see.
 *
 * **Watched negative:** with the `await this.announce(projectId)` line deleted
 * from `CalendarMarkerService.remove` and nothing else changed, exactly the two
 * cases that reach a delete fail — `deleting one` on its single event and
 * `all four` on its fourth — while the refusal case stays green. Watched that
 * way on h2puni, 2026-09-06. The delete is called out on its own because it is
 * the write a client cannot recover from by re-reading something else: there is
 * nothing left on the axis to notice is missing.
 */
describe('a calendar marker write announces itself', () => {
  const ACTOR = 'owner-account';
  let markerProjects: ReturnType<typeof inMemoryProjects>;
  let recorder: RecordingBroadcaster;
  let markerService: CalendarMarkerService;
  let markerProjectId: string;

  beforeEach(async () => {
    markerProjects = inMemoryProjects();
    recorder = recordingBroadcaster();
    markerService = testCalendarMarkerService(
      markerProjects,
      inMemoryCalendarMarkers(),
      undefined,
      recorder,
    );
    const project = projectRow({ id: crypto.randomUUID(), ownerId: ACTOR });
    await markerProjects.create(project, [], { at: 1, by: ACTOR });
    markerProjectId = project.id;
  });

  /** The one event, so every case below states the whole payload it expects. */
  const CHANGED: ProjectEvent = { type: 'calendar_markers_changed' };

  async function makeMarker(): Promise<string> {
    const created = await markerService.create(markerProjectId, ACTOR, {
      date: '2026-08-24',
      name: 'Client demo',
    });
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    return created.value.id;
  }

  it('announces one content-free event per write, on all four', async () => {
    const id = await makeMarker();
    await markerService.rename(markerProjectId, id, ACTOR, 'Client demo, moved');
    await markerService.recolor(markerProjectId, id, ACTOR, '#3b82f6');
    await markerService.remove(markerProjectId, id, ACTOR);

    // Four writes, four announcements, in write order and each carrying
    // nothing: `toEqual` on the whole list is what makes "content-free" an
    // assertion rather than a claim about a field nobody reads.
    expect(recorder.published).toEqual([
      { projectId: markerProjectId, event: CHANGED },
      { projectId: markerProjectId, event: CHANGED },
      { projectId: markerProjectId, event: CHANGED },
      { projectId: markerProjectId, event: CHANGED },
    ]);
  });

  it('announces deleting one, which is the write a re-read cannot recover', async () => {
    const id = await makeMarker();
    recorder.published.length = 0;

    await markerService.remove(markerProjectId, id, ACTOR);

    expect(recorder.published).toEqual([{ projectId: markerProjectId, event: CHANGED }]);
  });

  it('announces nothing for a write it refused', async () => {
    // Both refusals the gate can give, because an event on either would tell
    // every reader of a project to go and read a list that did not change, on
    // nothing but somebody else's rejected attempt.
    //
    // `not-the-owner` needs a **restricted** project to be refused: `canEdit`
    // is `!restricted || ownerId === actorId`, so a stranger writing to an
    // ordinary project is allowed here and is not the negative this case wants.
    const restricted = projectRow({
      id: crypto.randomUUID(),
      ownerId: ACTOR,
      restricted: true,
    });
    await markerProjects.create(restricted, [], { at: 1, by: ACTOR });

    const absent = await markerService.create('no-such-project', ACTOR, {
      date: '2026-08-24',
      name: 'Client demo',
    });
    const stranger = await markerService.create(restricted.id, 'not-the-owner', {
      date: '2026-08-24',
      name: 'Client demo',
    });

    // `about: 'project'` on both: the project is the thing that was missing
    // or closed, and neither refusal is about the marker the body described
    // (TASK-279 AC #7).
    expect(absent).toEqual({ ok: false, reason: 'not_found', about: 'project' });
    expect(stranger).toEqual({ ok: false, reason: 'forbidden', about: 'project' });
    expect(recorder.published).toEqual([]);
  });
});
