import type { CalendarMarker } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

const MARKER_DATE = '2026-09-10';
const TIED_AT = 1_700_000_000_000;

function marker(
  id: string,
  projectId: string,
  overrides: Partial<CalendarMarker> = {},
): CalendarMarker {
  return {
    id,
    projectId,
    date: MARKER_DATE,
    name: `Marker ${id}`,
    color: null,
    createdAt: TIED_AT,
    ...overrides,
  };
}

/** Shared marker cases for stable ordering, literal dates and project-scoped writes. */
export function calendarMarkerRegistrations(
  open: OpenCase<'calendarMarkers'>,
): readonly CaseRegistration[] {
  return [
    storeCase(
      'calendarMarkers',
      'calendarMarkers.listFor:total-order',
      open,
      async ({ port, readers, seed }) => {
        const projectsBefore = structuredClone(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        );
        expect(projectsBefore.map((project) => project?.id)).toEqual([...seed.projectIds]);

        const inserted = [
          marker('marker-c', seed.projectIds[0]),
          marker('marker-a', seed.projectIds[0]),
          marker('marker-b', seed.projectIds[0]),
        ];
        const writes = [];
        for (const made of inserted) writes.push(await port.create(made));
        expect(writes).toEqual(inserted.map((made) => ({ ok: true, marker: made })));
        expect(
          writes.map((write) =>
            write.ok
              ? { id: write.marker.id, date: write.marker.date, createdAt: write.marker.createdAt }
              : write,
          ),
        ).toEqual([
          { id: 'marker-c', date: MARKER_DATE, createdAt: TIED_AT },
          { id: 'marker-a', date: MARKER_DATE, createdAt: TIED_AT },
          { id: 'marker-b', date: MARKER_DATE, createdAt: TIED_AT },
        ]);

        // Proof: both sources' missing-id faults returned insertion order
        // c/a/b; the final public read failed with marker-c before marker-a.
        expect((await port.listFor(seed.projectIds[0])).map(({ id }) => id)).toEqual([
          'marker-a',
          'marker-b',
          'marker-c',
        ]);
        expect(await port.listFor(seed.projectIds[1])).toEqual([]);
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        ).toEqual(projectsBefore);
      },
    ),
    storeCase(
      'calendarMarkers',
      'calendarMarkers.write:project-scope',
      open,
      async ({ port, readers, seed }) => {
        const projectsBefore = structuredClone(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        );
        expect(projectsBefore.map((project) => project?.id)).toEqual([...seed.projectIds]);

        const projectMarker = marker('marker-owned-a', seed.projectIds[0], {
          name: 'Council inspection',
        });
        const otherMarker = marker('marker-owned-b', seed.projectIds[1], {
          name: 'Scaffolding up',
        });
        // Proof: both sources' literal-date faults mutated an independent input
        // clone in place to 2026-09-11; this settled answer still failed against
        // the untouched 2026-09-10 expectation (Expected -1 / Received +1).
        expect(await port.create(structuredClone(projectMarker))).toEqual({
          ok: true,
          marker: projectMarker,
        });
        expect(await port.create(structuredClone(otherMarker))).toEqual({
          ok: true,
          marker: otherMarker,
        });

        const renamed = { ...projectMarker, name: 'Council inspection, rescheduled' };
        expect(await port.rename(seed.projectIds[0], projectMarker.id, renamed.name)).toEqual({
          ok: true,
          marker: renamed,
        });
        const colored = { ...renamed, color: '#0386a5' };
        expect(await port.recolor(seed.projectIds[0], projectMarker.id, colored.color)).toEqual({
          ok: true,
          marker: colored,
        });
        expect(await port.recolor(seed.projectIds[0], projectMarker.id, null)).toEqual({
          ok: true,
          marker: renamed,
        });

        const wrongProject = {
          rename: await port.rename(seed.projectIds[1], projectMarker.id, 'Mine now'),
          recolor: await port.recolor(seed.projectIds[1], projectMarker.id, '#f70100'),
          remove: await port.remove(seed.projectIds[1], projectMarker.id),
          projectA: await port.listFor(seed.projectIds[0]),
          projectB: await port.listFor(seed.projectIds[1]),
        };
        // Proof: both sources' omitted-project faults routed B's rename through A;
        // this complete settled state received ok/Mine now instead of refusal/unchanged.
        expect(wrongProject).toEqual({
          rename: { ok: false, reason: 'not_found' },
          recolor: { ok: false, reason: 'not_found' },
          remove: { ok: false, reason: 'not_found' },
          projectA: [renamed],
          projectB: [otherMarker],
        });

        expect(await port.remove(seed.projectIds[0], projectMarker.id)).toEqual({
          ok: true,
          marker: renamed,
        });
        expect({
          projectA: await port.listFor(seed.projectIds[0]),
          projectB: await port.listFor(seed.projectIds[1]),
        }).toEqual({ projectA: [], projectB: [otherMarker] });
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        ).toEqual(projectsBefore);
      },
    ),
  ];
}
