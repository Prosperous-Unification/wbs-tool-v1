import { automaticColor } from '@wbs/domain';
import { expect, spyOn, test } from 'bun:test';

import { EMPTY } from '../http/endpoint';
import { CalendarMarkerService } from '../service/calendar-marker.service';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCalendarMarkers } from '../testing/calendar-marker-fixture';
import { inMemoryProjects, projectRow } from '../testing/project-fixture';
import { calendarMarkerRoutes } from './calendar-marker.routes';

const markerId = '10000000-0000-4000-8000-000000000001';
const principal = { id: 'owner', username: 'owner', scopes: ['read', 'write'] as const };
const input = {
  params: { id: 'project', markerId },
  query: undefined,
  principal,
  request: {
    method: 'POST',
    url: new URL('https://example.com/api/projects/project/calendar-markers'),
    headers: new Headers(),
  },
};
async function fixture() {
  const projects = inMemoryProjects();
  await projects.create(projectRow({ id: 'project' }), [], { at: 1, by: 'owner' });
  const store = inMemoryCalendarMarkers();
  const broadcast = recordingBroadcaster();
  const service = new CalendarMarkerService({ projects, markers: store, broadcast });
  return { projects, store, broadcast, endpoints: calendarMarkerRoutes(service) };
}

test('direct marker bindings preserve IDs, resolve automatic color and publish only marker refresh', async () => {
  const {
    store,
    broadcast,
    endpoints: [list, create, patch, remove],
  } = await fixture();
  const created = await create.handle({
    ...input,
    body: { markerId, date: '2026-09-01', name: 'Launch' },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('marker fixture create refused');
  expect(created.status).toBe(201);
  expect(created.body.marker.id).toBe(markerId);
  expect(created.body.marker.color).toBe(automaticColor(markerId));
  expect((await store.listFor('project'))[0]?.color).toBeNull();
  expect((await list.handle({ ...input, body: undefined })).ok).toBe(true);
  expect((await patch.handle({ ...input, body: { name: 'Release' } })).ok).toBe(true);
  expect(await remove.handle({ ...input, body: undefined })).toEqual({
    ok: true,
    status: 204,
    body: EMPTY,
  });
  expect(broadcast.published.map((entry) => entry.event)).toEqual(
    Array.from({ length: 3 }, () => ({ type: 'calendar_markers_changed' })),
  );
});

test('direct missing projects never blame a marker and marker misses do', async () => {
  const {
    endpoints: [, create, patch, remove],
  } = await fixture();
  const missing = { ...input, params: { id: 'missing', markerId } };
  expect(
    await create.handle({ ...missing, body: { markerId, date: '2026-09-01', name: 'Name' } }),
  ).toEqual({ ok: false, status: 404, body: { error: 'not_found' } });
  expect(await patch.handle({ ...missing, body: { name: 'Name' } })).toEqual({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  });
  expect(await remove.handle({ ...missing, body: undefined })).toEqual({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  });
  expect(await patch.handle({ ...input, body: { name: 'Name' } })).toEqual({
    ok: false,
    status: 404,
    body: { error: 'not_found', field: 'markerId' },
  });
});

// Proof: inserting announce before the service store call added a refresh to the expected empty publication list.
test('a refused store write neither publishes nor becomes a successful marker response', async () => {
  const {
    store,
    broadcast,
    endpoints: [, create],
  } = await fixture();
  const refusal = spyOn(store, 'create').mockResolvedValueOnce({ ok: false, reason: 'taken' });
  try {
    expect(
      await create.handle({ ...input, body: { markerId, date: '2026-09-01', name: 'Name' } }),
    ).toEqual({ ok: false, status: 409, body: { error: 'taken', field: 'markerId' } });
    expect(broadcast.published).toEqual([]);
  } finally {
    refusal.mockRestore();
  }
  const failure = new Error('marker store unavailable');
  const outage = spyOn(store, 'create').mockRejectedValueOnce(failure);
  try {
    expect(
      await create
        .handle({ ...input, body: { markerId, date: '2026-09-01', name: 'Name' } })
        .catch((cause: unknown) => cause),
    ).toBe(failure);
    expect(broadcast.published).toEqual([]);
  } finally {
    outage.mockRestore();
  }
});
