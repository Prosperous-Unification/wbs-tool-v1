import { type Clock, clockOf } from '@wbs/core';

import type { CapacityStore, ProjectStore, TeamCapacity } from '../repository';
import type { Broadcaster } from './broadcast';
import { canEdit } from './project.service';

export interface CapacityServiceOptions {
  projects: ProjectStore;
  capacity: CapacityStore;
  broadcast: Broadcaster;
  /** The instant every write is dated from and the ids it mints — see {@link Clock}. */
  clock?: Clock;
}

/** Why a capacity write did not happen. */
export type CapacityRefusal = 'not_found' | 'forbidden';

export type CapacityOutcome =
  { ok: true; value: TeamCapacity[] } | { ok: false; reason: CapacityRefusal };

/**
 * How many of each team a project may have at work at once.
 *
 * A service of its own rather than four methods on {@link DirectoryService},
 * because the fact is a **project's** and not the directory's. That is not
 * bookkeeping: the directory's writes are open to every authenticated account —
 * Dany, 2026-08-06, "the list is global for all projects, anyone can add one" —
 * and this one is not (see {@link CapacityService.set}).
 */
export class CapacityService {
  private readonly clock: Clock;

  constructor(private readonly opts: CapacityServiceOptions) {
    this.clock = opts.clock ?? clockOf();
  }

  listFor(projectId: string): Promise<TeamCapacity[]> {
    return this.opts.capacity.listFor(projectId);
  }

  /**
   * Sets this project's capacity for one team, or clears it to unstated on
   * `null`.
   *
   * **Gated by {@link canEdit}**, unlike C2's `resizeTeam` was. The two are not
   * inconsistent: C2 wrote a row in the global directory, which every account may
   * edit, and this writes a number that moves one project's dates — which is
   * exactly the class of write `ProjectService.update` and every work-item
   * mutation gate. A restricted project's plan would otherwise be re-scheduled by
   * anybody who could read it.
   *
   * **Announced to the project it names and to no other**, which is the whole of
   * the change from C2. C2's size write fanned out to every project the team
   * labelled, and its JSDoc argued the fan-out was a stronger claim on a size
   * than on a rename because "a size moves every date in the plan". Both halves
   * still hold; the set of plans a capacity write moves is now one.
   *
   * The event is `capacity_changed` rather than `directory_changed` — the name
   * being true is the only thing that decides it, because fe-01 reads every
   * project event as "read again" and never inspects the type. See
   * {@link ProjectEvent} and `capacity-per-project`'s design.md D6.
   *
   * **Not journalled, and therefore not undoable.** Not for C2's reason — the
   * directory not being journalled — but for `estimateMethod`'s and
   * `startDate`'s: those are project facts with no undo either, and a capacity
   * touches no work item whose revision an undo entry could be pinned to.
   *
   * The number is validated at the controller, which is the only place a value
   * that is not a whole number of 1 to `MOST_PEOPLE_AT_ONCE` can enter. A 0 here
   * would be a pool of no slots and a plan of `Infinity` dates.
   *
   * Answers the project's **whole** list rather than the one pair written, so a
   * client redraws from one response instead of merging a patch into a list it
   * read earlier — the shape the payload carries it in.
   */
  async set(
    projectId: string,
    actorId: string,
    serviceTeamId: string,
    size: number | null,
  ): Promise<CapacityOutcome> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const stamp = this.clock.stampFor(actorId);
    const written = await this.opts.capacity.set(projectId, serviceTeamId, size, stamp);
    // The store read both ids inside its own transaction, so this is the team
    // having gone between the two reads above and that write — or an id nothing
    // ever held. Either way it is `not_found`, and the project's own absence was
    // already answered above.
    if (!written.ok) return { ok: false, reason: 'not_found' };
    await this.opts.broadcast.publish(projectId, { type: 'capacity_changed' });
    return { ok: true, value: await this.opts.capacity.listFor(projectId) };
  }
}
