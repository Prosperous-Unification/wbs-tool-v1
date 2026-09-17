import type { IsoDate } from '@wbs/domain';

/**
 * One dated, named overlay on a project's Gantt axis.
 *
 * **Not a work item and not an SVG marker**, which is the confusion the ADR
 * (`docs/adr/0017-refuse-a-calendar-marker-on-an-undated-plan.md`) exists to
 * refuse: it holds an absolute project date, it schedules nothing, and no
 * scheduler input reads it.
 *
 * `color` is `null` for **automatic**, meaning `automaticColor(id)` decides the
 * fill at read time and the row stores no opinion. A stored default would be a
 * second spelling of the same state and would freeze the palette at the instant
 * the marker was made, so a later palette change would leave old markers behind.
 */
export interface CalendarMarker {
  /** A v4 UUID the composer issues, not the server — design.md §6.1. */
  id: string;
  projectId: string;
  /** An `IsoDate`. No instant, ever — see {@link CalendarMarkerStore.create}. */
  date: IsoDate;
  name: string;
  /** `null` means automatic. */
  color: string | null;
  createdAt: number;
}

/**
 * What a marker write decided.
 *
 * `not_found` covers **both** "no such project" and "no such marker of this
 * project", and the merge is the spec's: a marker of another project answers
 * `not_found` rather than `forbidden`, because the caller may not learn it
 * exists (spec.md, the refusal table).
 *
 * `taken` is a create against an id that is already stored. Separate from
 * `not_found` because it is the one refusal whose row is left **untouched and
 * still readable** — the caller retries with a new id rather than concluding
 * anything is missing.
 */
export type CalendarMarkerWritten =
  { ok: true; marker: CalendarMarker } | { ok: false; reason: 'not_found' | 'taken' };

/**
 * A project's calendar markers.
 *
 * A store of its own for {@link PriorityBandStore}'s reason: this is a
 * project's own list, gated by the project's write permission, and it bumps no
 * work-item revision because it changes no work item.
 *
 * **Nothing in here validates a marker.** The shape rules — `IsoDate`, UUID v4,
 * hex triple, `MARKER_NAME_MAX`, the 3:1 contrast bar — are the controller's,
 * and a second copy in the store would be a rule free to disagree with the one
 * a client is answered against. `PriorityBandRepository.replace` states the
 * same rule for `priorityLadderProblem`.
 */
export interface CalendarMarkerStore {
  /**
   * This project's markers, totally ordered by `(date, createdAt, id)`.
   *
   * The third key is not decoration: `(date, createdAt)` ties for two markers
   * created inside the same millisecond, and a tie leaves the order free to
   * change between two reads of unchanged data (spec.md).
   */
  listFor(projectId: string): Promise<CalendarMarker[]>;
  /**
   * Stores one marker, or refuses.
   *
   * The `id` and the `createdAt` both arrive from the caller — the id because
   * the composer needs it before it can preview the colour, the instant because
   * the repository layer has no clock of its own ({@link WriteStamp}).
   *
   * `date` is stored as **the exact text given**. No `Date` is constructed
   * anywhere on the way in, because constructing one is the only way a clicked
   * day can turn into its UTC neighbour.
   */
  create(marker: CalendarMarker): Promise<CalendarMarkerWritten>;
  /** Renames one marker of this project, leaving its date and colour alone. */
  rename(projectId: string, id: string, name: string): Promise<CalendarMarkerWritten>;
  /** Sets one marker's fill, or clears it back to automatic on `null`. */
  recolor(projectId: string, id: string, color: string | null): Promise<CalendarMarkerWritten>;
  /** Removes one marker of this project. */
  remove(projectId: string, id: string): Promise<CalendarMarkerWritten>;
}
