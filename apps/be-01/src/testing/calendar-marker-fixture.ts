import type {
  CalendarMarker,
  CalendarMarkerStore,
  CalendarMarkerWritten,
  ProjectStore,
} from '../repository';
import { CalendarMarkerService } from '../service/calendar-marker.service';
import type { Clock } from '../service/clock';
import { inMemoryProjects } from './project-fixture';

/**
 * A {@link CalendarMarkerStore} backed by a Map, for the callers that need
 * `buildApp` to construct and never drive a marker route.
 *
 * It keeps the two guarantees a test could otherwise pass against by accident,
 * because a fixture laxer than production lets a test assert behaviour that
 * does not exist: every read and write is scoped by `projectId`, and `listFor`
 * is totally ordered by `(date, createdAt, id)` — the third key included,
 * because it is the one `CalendarMarkerRepository` exists to guarantee and a
 * fixture that dropped it would answer a tie in insertion order.
 *
 * What it deliberately does not keep is the project-existence check, for
 * `inMemoryPriorityBands`' reason: this Map holds no projects, so an answer
 * about an unknown id would be an answer to a question it cannot know.
 * `CalendarMarkerService` reads the project itself, and the store's own refusal
 * is asserted against real SQLite in
 * `repository/calendar-marker-repository.db.test.ts`.
 */
export function inMemoryCalendarMarkers(seed: readonly CalendarMarker[] = []): CalendarMarkerStore {
  const held = new Map<string, CalendarMarker>(seed.map((marker) => [marker.id, { ...marker }]));
  const one = (projectId: string, id: string): CalendarMarker | undefined => {
    const found = held.get(id);
    return found?.projectId === projectId ? found : undefined;
  };
  const touch = (
    projectId: string,
    id: string,
    patch: Partial<Pick<CalendarMarker, 'name' | 'color'>>,
  ): Promise<CalendarMarkerWritten> => {
    const found = one(projectId, id);
    if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
    const written = { ...found, ...patch };
    held.set(id, written);
    return Promise.resolve({ ok: true, marker: { ...written } });
  };
  return {
    listFor(projectId) {
      return Promise.resolve(
        [...held.values()]
          .filter((marker) => marker.projectId === projectId)
          // A copy, so a caller that mutated what it was handed would not be
          // editing the store from the read side.
          .map((marker) => ({ ...marker }))
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
          ),
      );
    },
    create(marker) {
      if (held.has(marker.id)) return Promise.resolve({ ok: false, reason: 'taken' });
      held.set(marker.id, { ...marker });
      return Promise.resolve({ ok: true, marker: { ...marker } });
    },
    rename(projectId, id, name) {
      return touch(projectId, id, { name });
    },
    recolor(projectId, id, color) {
      return touch(projectId, id, { color });
    },
    remove(projectId, id) {
      const found = one(projectId, id);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      held.delete(id);
      return Promise.resolve({ ok: true, marker: { ...found } });
    },
  };
}

/**
 * A CalendarMarkerService over the in-memory stores, for tests that only need
 * `buildApp` to construct.
 *
 * Required rather than optional in `AppOptions` for the reason every other
 * service there is: a process built without it answers 404 on every marker
 * route, which a client cannot tell from a project that has no markers — and
 * "none" is the answer for every project the day the table ships, so the
 * mistake would be invisible for a week.
 */
export function testCalendarMarkerService(
  projects: ProjectStore = inMemoryProjects(),
  markers: CalendarMarkerStore = inMemoryCalendarMarkers(),
  clock?: Clock,
): CalendarMarkerService {
  return new CalendarMarkerService({ projects, markers, clock });
}
