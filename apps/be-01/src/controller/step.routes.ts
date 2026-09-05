import { callerGuard } from '../http/caller';
import { handParsedBody } from '../http/elysia/hand-parsed-body';
import { isFieldBag, noContent, ok, respond, type Route, type RouteResponse } from '../http/route';
import type { AuthService } from '../service/auth.service';
import type { RemoveStepOutcome, StepRefusal, StepService } from '../service/step.service';
import { statusForRefusal } from './refusal-status';

/**
 * `taken` is 409 and a blank name is 422, the same split the rest of the API
 * makes: a duplicate name is a well-formed request that conflicts with the
 * project as it stands, and a name of spaces is the request itself being wrong.
 */
const statusFor = (reason: StepRefusal): number => statusForRefusal(reason, 422);

/**
 * The `{ name: string }` body both writes take, checked by hand.
 *
 * Elysia checked this with `t.Object({ name: t.String() })` and answered its own
 * 422 before the handler ran. A route module cannot declare a validator to a
 * framework it does not import, and this is the shape that check has to take
 * instead — which is no loss: the app already hand-parses every body carrying
 * real domain input, for the reason `http/elysia/hand-parsed-body.ts` states at
 * length. 422 rather than 400 keeps the answer the one clients already branch
 * on, and it is the same status Elysia's schema refusal produced.
 */
function nameFrom(body: unknown): { name: string } | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const name = body['name'];
  if (typeof name !== 'string') return respond(422, { error: 'invalid_body' });
  return { name };
}

/**
 * What the document says about the two step writes, now that the handler checks
 * the body instead of the framework.
 *
 * These two routes declared `t.Object({ name: t.String() })` to Elysia, which
 * both validated the body and put a `requestBody` in the committed document.
 * The route shape carries no validator, so the check moved into
 * {@link nameFrom} — and this is the mechanism the rest of the API already uses
 * to document a body it parses itself, caveat and all. The document therefore
 * changes*, and the change is the honest direction: it now says the schema is
 * documentation rather than implying a framework refuses against it.
 */
const NAMED_BODY = handParsedBody('The step’s name.', {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
});

const isRefusal = (parsed: { name: string } | RouteResponse): parsed is RouteResponse =>
  'status' in parsed;

/**
 * A project's steps.
 *
 * Its own route module rather than more routes on the project's, because these
 * write across a project's estimates and assignments, and the project routes
 * write the project's own columns. The prefix is the same because the resource
 * is — a step belongs to one project and is addressed through it.
 *
 * Reading the steps stays on `GET /api/projects/:id`, which already answers
 * with them. A second list route would be a second read of one fact, and
 * clients would drift over which one is current.
 */
export function stepRoutes(auth: AuthService, steps: StepService): Route[] {
  const guard = callerGuard(auth);
  return [
    {
      method: 'POST',
      path: '/api/projects/:id/steps',
      handler: guard('signed-in', async ({ params, body }, user) => {
        const parsed = nameFrom(body);
        if (isRefusal(parsed)) return parsed;
        const outcome = await steps.add(params['id'], user.id, parsed.name);
        return outcome.ok
          ? ok({ step: outcome.value })
          : respond(statusFor(outcome.reason), { error: outcome.reason });
      }),
      documentation: { detail: { requestBody: NAMED_BODY } },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:id/steps/:stepId',
      handler: guard('signed-in', async ({ params, body }, user) => {
        const parsed = nameFrom(body);
        if (isRefusal(parsed)) return parsed;
        const outcome = await steps.rename(params['id'], params['stepId'], user.id, parsed.name);
        return outcome.ok
          ? ok({ step: outcome.value })
          : respond(statusFor(outcome.reason), { error: outcome.reason });
      }),
      documentation: { detail: { requestBody: NAMED_BODY } },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:id/steps/:stepId',
      handler: guard('signed-in', async ({ params, query }, user) => {
        // `?cascade=true` and nothing else. A query string is where the strategy
        // for deleting a work item lives, and the flag is the second, explicit
        // call rather than a body on a DELETE.
        const outcome: RemoveStepOutcome = await steps.remove(
          params['id'],
          params['stepId'],
          user.id,
          query['cascade'] === 'true',
        );
        if (!outcome.ok) {
          if (outcome.reason === 'in_use') {
            // 409, not 400: the request is well formed and would have worked
            // against a project where nothing pointed at this step. The counts
            // ride along because the next request is the same one with the flag,
            // and the person confirming has to know what they are agreeing to.
            return respond(409, { error: outcome.reason, inUse: outcome.inUse });
          }
          return respond(statusForRefusal(outcome.reason, 404), { error: outcome.reason });
        }
        return noContent();
      }),
    },
  ];
}
