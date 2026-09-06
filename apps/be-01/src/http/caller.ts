import { userFromHeaders } from '../middleware/authenticated';
import type { AuthenticatedUser, AuthService } from '../service/auth.service';
import {
  respond,
  type RouteHandler,
  type RoutePreflight,
  type RouteRequest,
  type RouteResponse,
} from './route';

/**
 * What a route requires of whoever called it.
 *
 * `signed-in` is every route that answers about this deployment's own data: any
 * authenticated account may read and write it, and the account is carried for
 * the record rather than for permission (project-level write access is the
 * project service's question, not this one's).
 *
 * `read-scope` is the two routes an **integration token** reaches —
 * `GET /api/projects/:id/export` and `GET /plans/by-solution/:slug`. Both hand a
 * whole plan to a machine caller, and a token minted for one integration must
 * not be usable to bulk-read plans unless it was granted `read`. Nothing else
 * asks, and that is deliberate rather than an oversight: the browser session
 * carries every scope, so requiring `read` elsewhere would refuse nobody while
 * suggesting the check meant something. The write scope is asked for once, in
 * `app.ts`'s `onRequest`, before a body is parsed.
 */
export type CallerRequirement = 'read-scope' | 'signed-in';

/** A handler that has already been given a non-null account. */
export type AuthenticatedHandler = (
  req: RouteRequest,
  user: AuthenticatedUser,
) => Promise<RouteResponse>;

/**
 * The one place a request's identity is resolved and a caller is refused.
 *
 * Twenty-three handlers opened with the same five lines — resolve, compare
 * against `null`, set 401, return `{ error: 'unauthenticated' }` — and two of
 * them then repeated a scope check. Five lines copied twenty-three times is a
 * guard nobody can see the shape of: one handler quietly answering a 403 where
 * the others answer 401, or forgetting the block altogether, reads exactly like
 * the rest.
 *
 * This was an Elysia macro until the route modules stopped importing Elysia.
 * The macro existed to keep the framework's inference of `params`, `query` and
 * `body` across a wrapper, and a plain higher-order function loses nothing now
 * that those three are fields on {@link RouteRequest} rather than inferred
 * context. What it gains is the reason the split was worth making: the refusal
 * is the same object under every binder, so `binder.contract.test.ts` asserts
 * one 401 and covers both.
 *
 * The wrapped handler is handed the account **already narrowed to non-null**,
 * so it cannot forget the case: there is no `null` in the type to forget.
 */
export interface CallerGuard {
  (requires: CallerRequirement, handler: AuthenticatedHandler): RouteHandler;
  /**
   * The same refusal, as a {@link RoutePreflight} a route declares so a binder
   * answers it before validating anything — see {@link RoutePreflight} for why
   * that ordering needed a seat at all.
   *
   * A member of the guard rather than a free function, and returning `null`
   * where the guard would have called the handler, so the two share one
   * **refusal implementation** — there is no second copy of "401
   * `unauthenticated`, then 403 `insufficient_scope`" that could drift.
   *
   * They do not share one `userFromHeaders` call, and that is worth saying
   * plainly rather than letting "one implementation" imply it: a route that
   * declares this and keeps its guard authenticates **twice** on an admitted
   * request, once here and once when the handler rechecks. That is the price of
   * the guard staying — the check the caller cannot skip is still the handler's
   * — and it is the same double-check every write already pays through
   * `app.ts`'s `onRequest`.
   */
  preflight(requires: CallerRequirement): RoutePreflight;
}

export function callerGuard(auth: AuthService): CallerGuard {
  const refuse = async (
    req: RouteRequest,
    requires: CallerRequirement,
  ): Promise<AuthenticatedUser | RouteResponse> => {
    const user = await userFromHeaders(auth, req.headers);
    if (user === null) return respond(401, { error: 'unauthenticated' });
    if (requires === 'read-scope' && !user.scopes.includes('read')) {
      return respond(403, { error: 'insufficient_scope' });
    }
    return user;
  };
  const isRefusal = (outcome: AuthenticatedUser | RouteResponse): outcome is RouteResponse =>
    'status' in outcome;

  const guard: CallerGuard = (requires, handler) => async (req) => {
    const outcome = await refuse(req, requires);
    return isRefusal(outcome) ? outcome : handler(req, outcome);
  };
  guard.preflight = (requires) => async (req) => {
    const outcome = await refuse(req, requires);
    return isRefusal(outcome) ? outcome : null;
  };
  return guard;
}
