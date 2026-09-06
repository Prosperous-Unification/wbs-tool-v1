import type { IsoDate } from '@wbs/domain';

import type { CalendarMarker, CalendarMarkerStore, ProjectStore } from '../repository';
import type { Broadcaster } from './broadcast';
import { type Clock, clockOf } from './clock';
import { canEdit } from './project.service';

export interface CalendarMarkerServiceOptions {
  projects: ProjectStore;
  markers: CalendarMarkerStore;
  /** The instant every marker is dated from and the ids it mints — see {@link Clock}. */
  clock?: Clock;
  /**
   * Where `calendar_markers_changed` goes. Optional, because the controller
   * suites that only assert an HTTP answer have no collaborator to announce to;
   * a service built without one announces nothing and refuses nothing.
   */
  broadcast?: Broadcaster;
}

/**
 * Why a marker could not be listed, stored or changed. All four are states.
 *
 * `not_found` covers **both** "no such project" and "no such marker of this
 * project", and it stays one reason on the wire: a caller who could tell the
 * two apart by the reason would learn that a marker it may not see exists
 * (spec.md, "a marker of another project answers `not_found` rather than
 * `forbidden`"). Which of the two it was is carried beside the reason instead,
 * as {@link CalendarMarkerSubject}.
 */
export type CalendarMarkerRefusal = 'not_found' | 'forbidden' | 'taken';

/**
 * What a refusal is **about** — the project the request addressed, or the
 * marker inside it.
 *
 * This is not a second reason and never reaches a client as one. It exists so a
 * route can answer the spec's `field` honestly: the refusal table blames
 * `markerId` for a marker that is absent or another project's, and the routes
 * used to blame it for an **absent project** too, naming a value that had
 * nothing to do with the refusal (TASK-279 AC #7). Only the service knows
 * which check failed — `gate` reads the project, the store reads the marker
 * inside its own transaction — so only the service can say.
 *
 * It leaks nothing the reason did not already: an existing project the caller
 * may not write answers `forbidden` and an absent one answers `not_found`, so
 * project existence is already distinguishable from outside. Marker existence
 * is not, and stays that way — `about` never reaches the wire, and the routes
 * turn it into a `field` only for a request that named a marker id itself. A
 * create that let this service mint one can still be refused `about: 'marker'`
 * (the minted id collided), and the route blames nothing for it, because the
 * two questions are separate and both are asked.
 */
export type CalendarMarkerSubject = 'project' | 'marker';

export interface CalendarMarkerRefused {
  ok: false;
  reason: CalendarMarkerRefusal;
  about: CalendarMarkerSubject;
}

export type CalendarMarkerOutcome = { ok: true; value: CalendarMarker } | CalendarMarkerRefused;

export type CalendarMarkerListOutcome =
  | { ok: true; value: CalendarMarker[] }
  | CalendarMarkerRefused;

/** What a create carries that is not the project or the actor. */
export interface NewCalendarMarker {
  /** The composer's v4 UUID, or absent for one this service mints (task 4.4). */
  id?: string;
  date: IsoDate;
  name: string;
  /** `null` or absent both mean automatic. */
  color?: string | null;
}

/**
 * A project's calendar markers: listing them, and the four writes.
 *
 * **Not journalled and it bumps no revision**, like the priority ladder: a
 * marker is an annotation on the axis and changes no work item, so an undo
 * entry taken while one was added is not stale because of it. Slice 5 is where
 * that becomes an assertion rather than a claim.
 *
 * **Nothing here validates a marker's shape.** The `IsoDate`, the UUID v4, the
 * hex triple, `MARKER_NAME_MAX` and the 3:1 contrast bar are the controller's
 * (tasks 4.3, 4.5, 4.6a) — `CalendarMarkerStore`'s own doc states the rule for
 * the layer below, and a third copy in the middle would be a third rule free to
 * disagree with the one a client is answered against.
 *
 * Reading is not gated on write permission and that is deliberate: the project
 * routes already let a non-owner **read** a restricted project, and a marker is
 * part of what the axis draws. `canEdit` gates the four writes only.
 */
export class CalendarMarkerService {
  private readonly clock: Clock;

  constructor(private readonly opts: CalendarMarkerServiceOptions) {
    this.clock = opts.clock ?? clockOf();
  }

  async list(projectId: string): Promise<CalendarMarkerListOutcome> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found', about: 'project' };
    return { ok: true, value: await this.opts.markers.listFor(projectId) };
  }

  /**
   * Stores one marker.
   *
   * `createdAt` is this act's single reading of the clock ({@link Clock}), and
   * it is an ordering key rather than an audit stamp: `listFor` breaks a date
   * tie with it, which is why two markers written by one act must not read the
   * clock twice.
   */
  async create(
    projectId: string,
    actorId: string,
    marker: NewCalendarMarker,
  ): Promise<CalendarMarkerOutcome> {
    const gate = await this.gate(projectId, actorId);
    if (!gate.ok) return gate;

    const row: CalendarMarker = {
      id: marker.id ?? this.clock.newId(),
      projectId,
      date: marker.date,
      name: marker.name,
      color: marker.color ?? null,
      createdAt: this.clock.now(),
    };
    const written = await this.opts.markers.create(row);
    // **The one store call whose `not_found` is not about a marker.**
    // `CalendarMarkerRepository.create` reads the project first and refuses
    // `not_found` when nothing holds it, then reads the id and refuses `taken`
    // (`repository/calendar-marker.ts:94,103`); it never reads a marker to
    // decide the row is missing, because the row it is about does not exist
    // yet. The other three go through `one(tx, projectId, id)` after `gate`
    // already proved the project, so their `not_found` is the marker.
    if (!written.ok)
      return {
        ok: false,
        reason: written.reason,
        about: written.reason === 'taken' ? 'marker' : 'project',
      };
    await this.announce(projectId);
    return { ok: true, value: written.marker };
  }

  async rename(
    projectId: string,
    id: string,
    actorId: string,
    name: string,
  ): Promise<CalendarMarkerOutcome> {
    const gate = await this.gate(projectId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.markers.rename(projectId, id, name);
    if (!written.ok) return { ok: false, reason: written.reason, about: 'marker' };
    await this.announce(projectId);
    return { ok: true, value: written.marker };
  }

  async recolor(
    projectId: string,
    id: string,
    actorId: string,
    color: string | null,
  ): Promise<CalendarMarkerOutcome> {
    const gate = await this.gate(projectId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.markers.recolor(projectId, id, color);
    if (!written.ok) return { ok: false, reason: written.reason, about: 'marker' };
    await this.announce(projectId);
    return { ok: true, value: written.marker };
  }

  async remove(projectId: string, id: string, actorId: string): Promise<CalendarMarkerOutcome> {
    const gate = await this.gate(projectId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.markers.remove(projectId, id);
    if (!written.ok) return { ok: false, reason: written.reason, about: 'marker' };
    await this.announce(projectId);
    return { ok: true, value: written.marker };
  }

  /**
   * Announced **after** the store answered ok and never before it, and never on
   * a refusal: an event is a client's instruction to re-read, so one sent for a
   * write that did not happen makes every reader fetch the list it already has.
   */
  private async announce(projectId: string): Promise<void> {
    await this.opts.broadcast?.publish(projectId, { type: 'calendar_markers_changed' });
  }

  /**
   * The half every write shares: the project exists, and this actor may write
   * to it.
   *
   * The marker itself is **not** read here. Its existence is decided inside the
   * store's own transaction, where the read is the decision rather than a
   * report about it — `CalendarMarkerRepository.create`'s rule, and the one
   * that keeps a marker deleted between this check and the write from being
   * answered as though it were still there.
   */
  private async gate(
    projectId: string,
    actorId: string,
  ): Promise<{ ok: true } | CalendarMarkerRefused> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found', about: 'project' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden', about: 'project' };
    return { ok: true };
  }
}
