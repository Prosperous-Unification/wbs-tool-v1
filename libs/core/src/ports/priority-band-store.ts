import type { PriorityBand } from '@wbs/domain';

import type { WriteStamp } from './write-stamp';

/**
 * What a ladder write decided. `not_found` is a project nothing holds, read
 * inside the write's own transaction rather than in front of it — the
 * {@link CapacityStore.set} rule, and for its reason: the read is the decision.
 */
export type PriorityBandsWritten = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * What one project calls its priority numbers.
 *
 * A store of its own rather than methods on {@link ProjectStore}, for
 * {@link CapacityStore}'s reason one fact along: this is a project's
 * configuration and not a field of the project row, its write is gated
 * differently from the directory's, and the project row's revision counts writes
 * to the row.
 *
 * **Nothing in here is read by the scheduler.** A ladder is the vocabulary
 * `work_item.priority` is read and written in; the ordering the leveller applies
 * is the integer's own. `openspec/changes/priority-bands/design.md` D1.
 */
export interface PriorityBandStore {
  /**
   * This project's five bands, in rank order.
   *
   * A project holding no rows answers {@link DEFAULT_PRIORITY_BANDS} rather than
   * an empty list, and the absence is therefore not a state any caller has to
   * render: every priority resolves to exactly one label on every plan, seeded
   * or not. design.md D2.
   */
  listFor(projectId: string): Promise<PriorityBand[]>;
  /**
   * Replaces this project's whole ladder, five bands at once.
   *
   * **The whole ladder, never one band.** Contiguity is a fact about the five
   * rows together — a first band at 1, strictly increasing starts, each default
   * inside its own band — and a per-band write would have to pass through states
   * where it does not hold, with a reader in another browser drawing one of them.
   * design.md D4.
   */
  replace(
    projectId: string,
    bands: readonly PriorityBand[],
    stamp: WriteStamp,
  ): Promise<PriorityBandsWritten>;
}
