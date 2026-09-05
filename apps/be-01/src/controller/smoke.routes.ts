import { parseOrThrow, type, ValidationError } from '@wbs/validation';

import { ok, respond, type Route, type RouteResponse } from '../http/route';
import { SmokeService } from '../service/smoke.service';

const EchoBody = type({ text: 'string' });

/**
 * The one route in this app that validates its body through a schema.
 *
 * That is worth saying because it reads like the general mechanism and is not.
 * Every route carrying real domain input hand-parses instead, for the reason
 * `hand-parsed-body.ts` states: Elysia strips unknown properties before a guard
 * can refuse them, and a refusal has to be a code a client can branch on. This
 * route echoes a string for the deploy smoke, has no domain input to refuse, and
 * is the only place the simple form fits.
 *
 * The validator used to live in `middleware/validate.ts` with an `HttpError`
 * beside it, which read as the app's validation boundary while having exactly
 * this one caller. Both are inlined here so nothing advertises a seam the
 * routes did not take.
 *
 * A function rather than the module-level constant it was, because the service
 * was reached through Elysia's `.decorate('smoke', new SmokeService())` and a
 * decorator is a framework mechanism. A closure over one service instance is
 * the same lifetime with none of the framework: the instance is created when
 * the app builds its route list, exactly as `.decorate` created it when the
 * plugin was constructed.
 */
export function smokeRoutes(): Route[] {
  const smoke = new SmokeService();
  return [
    {
      method: 'POST',
      path: '/api/smoke/echo',
      // Not `async`: echoing a string awaits nothing, and an `async` handler
      // with no `await` in it is a promise of work that never happens.
      handler: (req) => Promise.resolve(echo(smoke, req.body)),
    },
  ];
}

function echo(smoke: SmokeService, body: unknown): RouteResponse {
  try {
    return ok({ echoed: smoke.echo(parseOrThrow(EchoBody, body).text) });
  } catch (e) {
    if (e instanceof ValidationError) return respond(400, { error: e.message });
    throw e;
  }
}
