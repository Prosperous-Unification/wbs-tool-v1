import {
  LONGEST_BAND_LABEL,
  PRIORITY_BAND_COUNT,
  type PriorityBand,
  priorityLadderProblem,
} from '@wbs/domain';

/** A ladder the request got wrong, carried as the code a client branches on. */
export class BadLadder extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * The five bands a request is asking this project's ladder to become.
 *
 * **Hand-parsed rather than declared through an Elysia schema**, which is
 * `capacityController`'s reasoning and `workItemController`'s before it: the
 * refusals here have to be codes a client can branch on and print a sentence for
 * — a fourth band starting below the third is a different mistake from a
 * `Critical` that writes 30 — and Elysia strips unknown properties before a
 * handler runs.
 *
 * Two layers, and the split is deliberate. **This function checks that the JSON
 * is bands at all** — an array of five objects whose three fields have the right
 * types. {@link priorityLadderProblem} then checks that the five are a *ladder*,
 * and it does so in `libs/domain` beside {@link priorityBandRankOf}, whose
 * assumptions are exactly what it enforces. A copy of the ladder rule here would
 * be a copy free to drift from the resolution it guards.
 *
 * `Number.isSafeInteger` is not asked here — the ladder check asks it, once, for
 * both numbers.
 *
 * **The `typeof` arms are how the three fields are narrowed, and they are not the
 * refusal.** That is worth stating because the first version of this comment
 * claimed the opposite and offered a proof for it: with the `startsAt` arm struck
 * (and a cast put in its place so the file still compiled), the whole route suite
 * was **9 pass, 0 fail** — `Number.isSafeInteger('21')` and
 * `Number.isSafeInteger(true)` are both false, so {@link priorityLadderProblem}
 * refuses a string and a boolean start on its own. Watched 2026-08-14. What these
 * arms buy is a `PriorityBand` built without an unchecked cast, which is what
 * `AGENTS.md` bans; the refusal they produce is the same one the ladder check
 * would have produced a line later. R5 #7 is the proof that the ladder check
 * itself can fail.
 */
export function ladderOf(body: unknown): PriorityBand[] {
  if (typeof body !== 'object' || body === null) throw new BadLadder('expected_object');
  const raw = body as Record<string, unknown>;
  if (!('bands' in raw)) throw new BadLadder('bands_required');
  const given = raw['bands'];
  if (!Array.isArray(given)) throw new BadLadder('bands_must_be_an_array');
  if (given.length !== PRIORITY_BAND_COUNT) {
    throw new BadLadder(`bands_must_number_${String(PRIORITY_BAND_COUNT)}`);
  }
  const bands: PriorityBand[] = [];
  for (const each of given as unknown[]) {
    if (typeof each !== 'object' || each === null) throw new BadLadder('bands_must_be_objects');
    const band = each as Record<string, unknown>;
    if (typeof band['startsAt'] !== 'number') {
      throw new BadLadder('band_start_must_be_a_whole_number_from_1');
    }
    if (typeof band['defaultValue'] !== 'number') {
      throw new BadLadder('band_default_must_be_a_whole_number_from_1');
    }
    if (typeof band['label'] !== 'string') {
      throw new BadLadder(`band_label_must_be_1_to_${String(LONGEST_BAND_LABEL)}_characters`);
    }
    bands.push({
      startsAt: band['startsAt'],
      label: band['label'],
      defaultValue: band['defaultValue'],
    });
  }
  // The one guard on what a ladder is, and the one call to it. See
  // `libs/domain/src/priority-band.ts`.
  //
  // Proof: this call deleted, and `refuses a ladder whose first band does not
  // start at 1` failed on `status: 200` with the project's ladder coming back
  // starting at 5 — every priority from 1 to 4 resolving to a band that does not
  // hold it. Three more ladder cases went red with it. Watched 2026-08-14.
  const problem = priorityLadderProblem(bands);
  if (problem !== null) throw new BadLadder(problem);
  return bands;
}
