import {
  LONGEST_BAND_LABEL,
  PRIORITY_BAND_COUNT,
  type PriorityBand,
  priorityLadderProblem,
} from '@wbs/domain';
import { Elysia } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import { handParsedBody } from '../openapi/hand-parsed-body';
import type { AuthService } from '../service/auth.service';
import type { PriorityBandService } from '../service/priority-band.service';

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
    .put(
      '/:id/priority-bands',
      async ({ params, body, headers, set }) => {
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
      },
      {
        detail: {
          summary: 'Name this project’s priority numbers — the whole ladder, in one request',
          description: `Exactly five bands, and the count is not configurable. Contiguity is a fact about
five rows **together**, so a route that took one rung would pass through states in
which the ladder is not one, with somebody else's screen drawing it. One request,
one transaction, one valid ladder either side.

A project that has never written a ladder reads the source's own five —
\`1 Critical/10\`, \`21 High/30\`, \`41 Medium/50\`, \`61 Low/70\`, \`81 Lowest/90\` — so a
pre-migration and a post-migration project answer the same. There is no read
route: the ladder rides in \`GET /api/projects/{id}/work-items\`.

Body refusals, all 400: \`expected_object\`, \`bands_required\`,
\`bands_must_be_an_array\`, \`bands_must_number_5\`, \`bands_must_be_objects\`,
\`band_label_must_be_1_to_40_characters\`, \`band_labels_must_differ\`,
\`band_start_must_be_a_whole_number_from_1\`, \`first_band_must_start_at_1\`,
\`bands_must_start_in_increasing_order\`,
\`band_default_must_be_a_whole_number_from_1\`,
\`band_default_must_be_inside_its_own_band\`.`,
          requestBody: handParsedBody(
            'The five rungs this project’s priority numbers are read through, lowest number first.',
            {
              type: 'object',
              required: ['bands'],
              properties: {
                bands: {
                  type: 'array',
                  minItems: 5,
                  maxItems: 5,
                  description:
                    'Five bands in increasing order of `startsAt`. The first must start at 1; each later one must start above the one below it; the top band ends nowhere.',
                  items: {
                    type: 'object',
                    required: ['startsAt', 'label', 'defaultValue'],
                    properties: {
                      startsAt: {
                        type: 'integer',
                        minimum: 1,
                        description: 'The lowest priority number this band holds.',
                      },
                      label: {
                        type: 'string',
                        description:
                          '1 to 40 characters, trimmed, and no two bands may read the same ignoring case.',
                      },
                      defaultValue: {
                        type: 'integer',
                        minimum: 1,
                        description:
                          'The number a row gets when somebody picks this band by name. It must fall inside the band — at or above its own `startsAt`, and below the next band’s.',
                      },
                    },
                  },
                },
              },
            },
          ),
        },
      },
    );
}
