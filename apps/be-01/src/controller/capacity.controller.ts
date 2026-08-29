import { MOST_PEOPLE_AT_ONCE } from '@wbs/domain';
import { Elysia } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import { handParsedBody } from '../openapi/hand-parsed-body';
import type { AuthService } from '../service/auth.service';
import type { CapacityService } from '../service/capacity.service';

/**
 * A capacity the request got wrong, carried as the code a client branches on.
 *
 * The same shape `directoryController`'s `BadSize` had — this route inherited that
 * route's whole job when `capacity-per-project` retired the global size.
 */
export class BadCapacity extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * How many of one team this project may have at work at once, or `null` for
 * unstated.
 *
 * **Hand-parsed rather than declared through an Elysia schema**, which is
 * `workItemController`'s reasoning and the retired `PATCH /teams/:id/size`'s
 * before it: this field's refusals have to be named 400s a client can branch on —
 * `0`, `-1`, `1.5`, `'3'` and `1001` are each a different mistake and none of
 * them is "the body is not an object" — and Elysia strips unknown properties
 * before a handler runs, so a `size` checked after `{ body: … }` would never see
 * one it had not been told about.
 *
 * The floor of 1 is the load-bearing half and is a **correctness** bound rather
 * than a preference: a pool of 0 slots clamps every width to 0, the engine's
 * duration is `effort / width`, and a single mistyped 0 is a plan of `Infinity`
 * dates with nothing on screen to say why. The ceiling is
 * {@link MOST_PEOPLE_AT_ONCE}, whose argument lives on the constant.
 *
 * Absent and `null` are **not** the same request: this route writes one field, so
 * an absent `size` is a body that says nothing at all rather than a field left
 * alone. `null` is the clear to unstated, and unstated is not a team of one.
 *
 * Proof, both watched 2026-08-13 and injected separately because neither probe
 * can see the other's line. The integer guard deleted: `refuses a capacity that is
 * not a whole number of 1 or more` failed on the first value, `[200, "0"]` where
 * `[400, "0"]` was owed — a pool of no slots taken and written. The ceiling
 * deleted with the integer guard left in: `refuses a capacity above what a plan
 * can mean` failed with `status: 200` and the pair coming back `size: 1001`.
 */
export function capacityOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) throw new BadCapacity('expected_object');
  const raw = body as Record<string, unknown>;
  if (!('size' in raw)) throw new BadCapacity('size_required');
  const value = raw['size'];
  if (value === null) return null;
  // `Number.isSafeInteger` covers the fraction, the `NaN`, the infinity and the
  // value beyond what an integer column can hold in one question — which is why
  // the ceiling's own negative is `1001` and not `1e999`: `1e999` parses to
  // `Infinity`, `Number.isSafeInteger(Infinity)` is false, and a range check
  // probed only with `1e999` would be a check that cannot fail. That exact
  // vacuous check has shipped in this repo before (`T1 column-widths-drag`).
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BadCapacity('size_must_be_a_whole_number_from_1');
  }
  if (value > MOST_PEOPLE_AT_ONCE) {
    throw new BadCapacity(`size_must_be_at_most_${String(MOST_PEOPLE_AT_ONCE)}`);
  }
  return value;
}

/**
 * How many of each team a project may have at work at once.
 *
 * **`PUT`, not `PATCH`.** The body carries the whole of the fact — there is one
 * field — and the same request twice is the same state. A `PATCH` would invite an
 * absent `size` to mean "leave it alone", and there is nothing else in this
 * resource to leave.
 *
 * Gated by project write access, unlike everything in `directoryController`: the
 * directory is global and open to every account, and this number moves one
 * project's dates. `CapacityService.set` owns that check and this translates its
 * refusal into a status, so there is one copy of the rule.
 *
 * There is no read route. The capacities ride in the plan's own payload
 * (`GET /api/projects/:id/work-items`), because a client that renders them
 * renders them beside dates computed from them, and a second request is a second
 * moment — the argument `WorkItemService.tree` makes for the people and the roles
 * it already carries.
 */
export function capacityController(auth: AuthService, capacity: CapacityService) {
  return new Elysia({ prefix: '/api/projects' })
    .onError(({ error, set }) => {
      if (error instanceof BadCapacity) {
        set.status = 400;
        return { error: error.reason };
      }
      return undefined;
    })
    .put(
      '/:id/teams/:teamId/capacity',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await capacity.set(params.id, user.id, params.teamId, capacityOf(body));
        if (!outcome.ok) {
          // 403 rather than 404 for a project this account may read but not write,
          // which is `projectController`'s own split: pretending it is absent would
          // contradict the next GET.
          set.status = outcome.reason === 'forbidden' ? 403 : 404;
          return { error: outcome.reason };
        }
        return { capacities: outcome.result };
      },
      {
        detail: {
          summary: 'Say how many of one team this project may have at work at once',
          description: `\`PUT\`, and the body carries the whole of the fact: the same request twice is the
same state. **An absent \`size\` is refused rather than read as \`null\`** — a body
that says nothing is not a clear, and unstated is not a team of one.

There is no read route: the capacities ride in the plan's own payload,
\`GET /api/projects/{id}/work-items\`, beside the dates computed from them.

Body refusals, all 400: \`expected_object\`, \`size_required\`,
\`size_must_be_a_whole_number_from_1\`, \`size_must_be_at_most_1000\`. A project this
account may read but not write is \`forbidden\`, 403 — not 404, which would
contradict the next GET.`,
          requestBody: handParsedBody(
            'How many of this team may be at work at once on this plan.',
            {
              type: 'object',
              required: ['size'],
              properties: {
                size: {
                  type: 'integer',
                  nullable: true,
                  minimum: 1,
                  maximum: 1000,
                  description:
                    'People at once, 1 to 1000, or null for unstated. The floor is correctness rather than taste: a pool of 0 slots clamps every width to 0, duration is effort ÷ width, and the plan becomes `Infinity` dates with nothing on screen to say why.',
                },
              },
            },
          ),
        },
      },
    );
}
