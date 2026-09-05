import type { IsoDate } from '@wbs/domain';

import type { CalendarMarker, CalendarMarkerStore, ProjectStore } from '../repository';
import { type Clock, clockOf } from './clock';
import { canEdit } from './project.service';

export interface CalendarMarkerServiceOptions {
  projects: ProjectStore;
  markers: CalendarMarkerStore;
  /** The instant every marker is dated from and the ids it mints — see {@link Clock}. */
  clock?: Clock;
}

/**
 * Why a marker could not be listed, stored or changed. All four are states.
 *
 * `not_found` covers **both** "no such project" and "no such marker of this
 * project" — the store merges them for the spec's reason, and merging them
 * again here keeps the service from being able to tell a caller that a marker
 * it may not see exists.
 */
export type CalendarMarkerRefusal = 'not_found' | 'forbidden' | 'taken';

export type CalendarMarkerOutcome =
  | { ok: true; value: CalendarMarker }
  | { ok: false; reason: CalendarMarkerRefusal };

export type CalendarMarkerListOutcome =
  | { ok: true; value: CalendarMarker[] }
  | { ok: false; reason: CalendarMarkerRefusal };

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
    if (project === null) return { ok: false, reason: 'not_found' };
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
    if (!written.ok) return { ok: false, reason: written.reason };
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
    if (!written.ok) return { ok: false, reason: written.reason };
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
    if (!written.ok) return { ok: false, reason: written.reason };
    return { ok: true, value: written.marker };
  }

  async remove(projectId: string, id: string, actorId: string): Promise<CalendarMarkerOutcome> {
    const gate = await this.gate(projectId, actorId);
    if (!gate.ok) return gate;

    const written = await this.opts.markers.remove(projectId, id);
    if (!written.ok) return { ok: false, reason: written.reason };
    return { ok: true, value: written.marker };
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
  ): Promise<{ ok: true } | { ok: false; reason: CalendarMarkerRefusal }> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    return { ok: true };
  }
}
