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

/** Legacy route-list guard retained until the task 5.2 policy audit deletes it. */
export interface CallerGuard {
  (requires: CallerRequirement, handler: AuthenticatedHandler): RouteHandler;
  /** The same refusal as a preflight, or null when the caller is admitted. */
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
