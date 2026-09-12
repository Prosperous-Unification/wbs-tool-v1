import { inMemoryCalendarMarkers } from '@wbs/store-memory/calendar-marker-fixture';
import { inMemoryProjects, projectRow } from '@wbs/store-memory/project-fixture';
import { testCalendarMarkerService } from '@wbs/store-memory/testing/service-fixtures';
import { describe, expect, it } from 'bun:test';

import type { CalendarMarker } from '../index';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import type {
  CalendarMarkerOutcome,
  CalendarMarkerRefusal,
  CalendarMarkerService,
} from './calendar-marker.service';

const PROJECT = 'proj-1';
const OWNER = 'owner';
const STRANGER = 'somebody-else';

const SEEDED: CalendarMarker = {
  id: 'marker-1',
  projectId: PROJECT,
  date: '2026-09-06',
  name: 'Launch',
  color: '#ff0000',
  createdAt: 1,
};

async function harness(restricted = false) {
  const projects = inMemoryProjects();
  await projects.create(projectRow({ id: PROJECT, ownerId: OWNER, restricted }), [], {
    at: 1,
    by: OWNER,
  });
  const broadcast = recordingBroadcaster();
  const service = testCalendarMarkerService(
    projects,
    inMemoryCalendarMarkers([SEEDED]),
    undefined,
    broadcast,
  );
  return { broadcast, service };
}

type Write = (
  service: CalendarMarkerService,
  projectId: string,
  actor: string,
) => Promise<CalendarMarkerOutcome>;

/**
 * The four writes twice over: once in the shape that succeeds against
 * {@link SEEDED}, once in the shape the **store** refuses after the project
 * gate has already passed.
 *
 * The second column is the half worth having. A gate refusal never reaches the
 * store, so a service that announced before the write would still look correct
 * against `forbidden` alone; only a write the gate let through and the store
 * turned down can tell the two orders apart.
 */
const WRITES: Record<
  string,
  { succeeds: Write; refusedByStore: Write; storeReason: CalendarMarkerRefusal }
> = {
  create: {
    succeeds: (service, projectId, actor) =>
      service.create(projectId, actor, { id: 'marker-2', date: '2026-09-07', name: 'Freeze' }),
    // The seeded marker's own id, which the store holds already.
    refusedByStore: (service, projectId, actor) =>
      service.create(projectId, actor, { id: SEEDED.id, date: '2026-09-07', name: 'Freeze' }),
    storeReason: 'taken',
  },
  rename: {
    succeeds: (service, projectId, actor) =>
      service.rename(projectId, SEEDED.id, actor, 'Deployed'),
    refusedByStore: (service, projectId, actor) =>
      service.rename(projectId, 'no-such-marker', actor, 'Deployed'),
    storeReason: 'not_found',
  },
  recolor: {
    succeeds: (service, projectId, actor) =>
      service.recolor(projectId, SEEDED.id, actor, '#00ff00'),
    refusedByStore: (service, projectId, actor) =>
      service.recolor(projectId, 'no-such-marker', actor, '#00ff00'),
    storeReason: 'not_found',
  },
  remove: {
    succeeds: (service, projectId, actor) => service.remove(projectId, SEEDED.id, actor),
    refusedByStore: (service, projectId, actor) =>
      service.remove(projectId, 'no-such-marker', actor),
    storeReason: 'not_found',
  },
};

/**
 * Annotated rather than inferred: an unannotated literal widens `type` to
 * `string`, which is not a `ProjectEvent` and which `toEqual` rejects against
 * the recorder's own element type.
 */
const ANNOUNCED: RecordingBroadcaster['published'] = [
  { projectId: PROJECT, event: { type: 'calendar_markers_changed' } },
];

/**
 * What each write announces, per write and per outcome.
 *
 * Asserted against `recordingBroadcaster`'s collected list rather than against
 * the private `announce`, because a spy would pass for a service publishing
 * into a broadcaster no other collaborator holds — which is exactly the shape
 * of the defect this file was written for (TASK-279): production built the
 * service without a broadcaster at all, and every existing marker suite stayed
 * green through it.
 */
describe('CalendarMarkerService announcements', () => {
  for (const [name, write] of Object.entries(WRITES)) {
    it(`publishes exactly one calendar_markers_changed for a successful ${name}`, async () => {
      const { broadcast, service } = await harness();
      expect((await write.succeeds(service, PROJECT, OWNER)).ok).toBe(true);
      expect(broadcast.published).toEqual(ANNOUNCED);
    });

    it(`announces nothing when ${name} names a project that does not exist`, async () => {
      const { broadcast, service } = await harness();
      expect(await write.succeeds(service, 'no-such-project', OWNER)).toEqual({
        ok: false,
        reason: 'not_found',
        about: 'project',
      });
      expect(broadcast.published).toEqual([]);
    });

    it(`announces nothing when ${name} is refused as forbidden`, async () => {
      const { broadcast, service } = await harness(true);
      expect(await write.succeeds(service, PROJECT, STRANGER)).toEqual({
        ok: false,
        reason: 'forbidden',
        about: 'project',
      });
      expect(broadcast.published).toEqual([]);
    });

    it(`announces nothing when the store refuses ${name} after the gate passed`, async () => {
      const { broadcast, service } = await harness();
      expect(await write.refusedByStore(service, PROJECT, OWNER)).toEqual({
        ok: false,
        reason: write.storeReason,
        about: 'marker',
      });
      expect(broadcast.published).toEqual([]);
    });
  }

  it('still answers a write when it was built with no broadcaster', async () => {
    // The reason the production defect was invisible, stated as a fact rather
    // than left implicit: `broadcast` is optional and `announce` calls it
    // through `?.`, so a service without one announces nothing and refuses
    // nothing. Nothing in this file — or in any marker suite — can catch the
    // missing argument; `services.db.test.ts` builds the real `buildServices`
    // and reads the event back, which is the only place that can.
    const projects = inMemoryProjects();
    await projects.create(projectRow({ id: PROJECT, ownerId: OWNER }), [], { at: 1, by: OWNER });
    const service = testCalendarMarkerService(projects, inMemoryCalendarMarkers([SEEDED]));

    expect((await service.rename(PROJECT, SEEDED.id, OWNER, 'Deployed')).ok).toBe(true);
  });
});
