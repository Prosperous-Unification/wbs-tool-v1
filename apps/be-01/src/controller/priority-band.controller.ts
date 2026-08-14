import {
  LONGEST_BAND_LABEL,
  type PriorityBand,
  PRIORITY_BAND_COUNT,
  priorityLadderProblem,
} from '@wbs/domain';
import { Elysia } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';
import type { PriorityBandService } from '../service/priority-band.service';

/** A ladder the request got wrong, carried as the code a client branches on. */
class BadLadder extends Error {
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
 * both numbers — but `typeof` is, because `true` and `'21'` are not numbers and
 * JSON lets them through to a comparison that would quietly succeed.
 *
 * Proof, watched 2026-08-14: the `typeof band.startsAt !== 'number'` arm struck,
 * and `refuses a band whose start is not a number` failed on `[200, "21"]` where
 * `[400, "21"]` was owed — a string start stored, and `'21' <= 1` is false so the
 * ladder check let it by.
 */
function ladderOf(body: unknown): PriorityBand[] {
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

/**
 * What one project calls its priority numbers.
 *
 * **`PUT`, and the body is the whole ladder.** Contiguity is a fact about five
 * rows together, so a route that took one rung would have to pass through states
 * in which the ladder is not one — a fourth band momentarily starting below the
 * third, with a reader on another screen drawing it. One request, one
 * transaction, one valid ladder either side of it.
 * `openspec/changes/priority-bands/design.md` D4.
 *
 * Gated by project write access, unlike everything in `directoryController`: the
 * directory is global and open to every account, and this is one project's
 * configuration. `PriorityBandService.set` owns that check and this translates
 * its refusal into a status, so there is one copy of the rule.
 *
 * There is no read route. The ladder rides in the plan's own payload
 * (`GET /api/projects/:id/work-items`), because every face draws priorities
 * through it and a second request is a second moment — the argument
 * `WorkItemService.tree` already makes for the roles, the people and the
 * capacities it carries.
 */
export function priorityBandController(auth: AuthService, bands: PriorityBandService) {
  return new Elysia({ prefix: '/api/projects' })
    .onError(({ error, set }) => {
      if (error instanceof BadLadder) {
        set.status = 400;
        return { error: error.reason };
      }
      return undefined;
    })
    .put('/:id/priority-bands', async ({ params, body, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const outcome = await bands.set(params.id, user.id, ladderOf(body));
      if (!outcome.ok) {
        // 403 rather than 404 for a project this account may read but not write,
        // which is `projectController`'s own split: pretending it is absent would
        // contradict the next GET.
        set.status = outcome.reason === 'forbidden' ? 403 : 404;
        return { error: outcome.reason };
      }
      return { bands: outcome.result };
    });
}
