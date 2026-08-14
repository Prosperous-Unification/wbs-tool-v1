import type { PriorityBand } from '@wbs/domain';

import type { PriorityBandStore, ProjectStore } from '../repository';
import type { Broadcaster } from './broadcast';
import { canEdit } from './project.service';

export interface PriorityBandServiceOptions {
  projects: ProjectStore;
  bands: PriorityBandStore;
  broadcast: Broadcaster;
}

/** Why a ladder write did not happen. */
export type PriorityBandRefusal = 'not_found' | 'forbidden';

export type PriorityBandOutcome =
  | { ok: true; result: PriorityBand[] }
  | { ok: false; reason: PriorityBandRefusal };

/**
 * What one project calls its priority numbers.
 *
 * `CapacityService`'s shape, and the two things it shares with it are the two
 * that matter: the fact is a **project's**, so the write is gated by
 * {@link canEdit} rather than being open to every authenticated account the way
 * the global directory is; and the announcement goes to the project named and to
 * no other.
 *
 * Where it differs is what the write moves. A capacity moves one plan's dates; a
 * ladder moves **nothing** — it renames what that plan's existing numbers are
 * called. The event is still published, because every face draws the labels and a
 * plan open on a second screen would otherwise keep painting `High` over a rung
 * that now says `Blocker`.
 *
 * **Not journalled, and therefore not undoable**, joining `estimateMethod`,
 * `startDate` and a team's capacity: it is a project fact, and there is no work
 * item whose revision an undo entry could hang on.
 */
export class PriorityBandService {
  constructor(private readonly opts: PriorityBandServiceOptions) {}

  listFor(projectId: string): Promise<PriorityBand[]> {
    return this.opts.bands.listFor(projectId);
  }

  /**
   * Replaces this project's ladder, and tells the project it named.
   *
   * The ladder is validated at the controller, which is the only place a set of
   * bands can enter — `priorityLadderProblem` in `libs/domain` is the one guard
   * and there is one caller of it.
   *
   * Answers the project's whole ladder rather than an acknowledgement, so a
   * client redraws from one response: the trimmed labels the store wrote are what
   * comes back, not the untrimmed ones a box sent.
   */
  async set(
    projectId: string,
    actorId: string,
    bands: readonly PriorityBand[],
  ): Promise<PriorityBandOutcome> {
    const project = await this.opts.projects.findById(projectId);
    if (project === null) return { ok: false, reason: 'not_found' };
    if (!canEdit(project, actorId)) return { ok: false, reason: 'forbidden' };
    const written = await this.opts.bands.replace(projectId, bands);
    // The store read the project inside its own transaction, so this is the
    // project having gone between the read above and that write. `not_found`
    // either way.
    if (!written.ok) return { ok: false, reason: 'not_found' };
    await this.opts.broadcast.publish(projectId, { type: 'priority_bands_changed' });
    return { ok: true, result: await this.opts.bands.listFor(projectId) };
  }
}
