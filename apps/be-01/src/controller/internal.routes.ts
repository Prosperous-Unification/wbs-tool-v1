import {
  InternalForwardRequest,
  InternalResumeRequest,
  type InternalResumeResponse,
} from '@wbs/contracts';
import { parseOrThrow, ValidationError } from '@wbs/validation';

import { ok, respond, type Route, type RouteRequest, type RouteResponse } from '../http/route';

export interface InternalCallContext {
  clientId: string | null;
  connectionId: string | null;
  traceId: string;
}

export interface InternalDeps {
  secret: string;
  onForward: (
    message: unknown,
    ctx: InternalCallContext,
  ) => Promise<{ push_responses?: unknown[] }>;
  onResume: (
    resumePoints: Record<string, number>,
    ctx: InternalCallContext,
  ) => Promise<InternalResumeResponse>;
}

/**
 * gw-01's own surface, and the only routes in this app no account token opens.
 *
 * The shared secret in `x-internal-auth` is the whole check: these two routes
 * are reached by the gateway process and by nothing else, so there is no
 * account to resolve and {@link callerGuard} would have nothing to ask. That is
 * why they do not carry the guard every other route does — the difference is
 * deliberate, and a reader who expects the guard here should read this instead
 * of adding it.
 *
 * The check was `middleware/internal-auth.ts`, a file whose name claimed an
 * app-wide auth boundary while having exactly these two callers, and whose
 * refusal was a `Response` — the one object a route module may not build, since
 * choosing the wire format is the binder's decision. It is inlined below for
 * the same reason `smoke.routes.ts` inlined its validator: nothing should
 * advertise a seam the routes did not take.
 */
export function internalRoutes(deps: InternalDeps): Route[] {
  return [
    {
      method: 'POST',
      path: '/internal/forward',
      handler: async (req) => {
        const deny = requireInternalAuth(req, deps.secret);
        if (deny !== null) return deny;
        try {
          const parsed = parseOrThrow(InternalForwardRequest, req.body);
          const res = await deps.onForward(parsed.message, contextFrom(req, parsed.trace_id));
          return ok({ ack: true as const, push_responses: res.push_responses });
        } catch (err) {
          if (err instanceof ValidationError) return respond(400, { error: err.message });
          throw err;
        }
      },
    },
    {
      method: 'POST',
      path: '/internal/resume',
      handler: async (req) => {
        const deny = requireInternalAuth(req, deps.secret);
        if (deny !== null) return deny;
        try {
          const parsed = parseOrThrow(InternalResumeRequest, req.body);
          return ok(await deps.onResume(parsed.resume_points, contextFrom(req, parsed.trace_id)));
        } catch (err) {
          if (err instanceof ValidationError) return respond(400, { error: err.message });
          throw err;
        }
      },
    },
  ];
}

/**
 * The refusal, as a value rather than a `Response`.
 *
 * **It is not returned before the body is parsed, and this comment used to say
 * it was.** Both binders decode first and answer the parser's 400, so a caller
 * with no secret does learn that this surface reads JSON. Measured at
 * `2026-09-05`, with the well-formed request as the control that proves the
 * secret check itself works:
 *
 * ```
 * POST /internal/forward, no x-internal-auth      elysia   in-process
 *   body `{not json`                              400      400
 *   body `{}`                                     401      401
 * ```
 *
 * The two binders agree, so this is **not** the 401-before-422 divergence
 * `Route.preflight` closes — it is one ordering, wrong in the same way under
 * both, and it predates this branch: the check sat behind Elysia's parser in
 * `internal.controller.ts` too. `Route.preflight` cannot fix it either, because
 * Elysia parses before any route-local `transform` runs.
 *
 * Closing it means an app-level pre-parse check for `/internal/*`, beside the
 * one `requiresWriteScope` already performs for `/api/` writes
 * (`app.ts:170-193`) — a change to a shipped auth boundary, which is its own
 * task with its own gate rather than a line in this one. Written down here,
 * where the promise was made, instead of left as a comment that lies.
 */
function requireInternalAuth(req: RouteRequest, secret: string): RouteResponse | null {
  // Lowercased, because that is the one spelling every binder guarantees --
  // gw-01 sends `x-internal-auth` already lowercased and Elysia lowercases what
  // it hands over, but a handler reaching for `X-Internal-Auth` would have
  // worked under one binder and refused every call under another.
  return req.headers['x-internal-auth'] === secret ? null : respond(401, { error: 'unauthorized' });
}

function contextFrom(req: RouteRequest, traceId: string): InternalCallContext {
  // `?? null` rather than the raw value: an absent header is `undefined` on
  // RouteRequest and `null` from `Headers.get`, and the two mean the same thing
  // to every consumer of this context.
  return {
    clientId: req.headers['x-client-id'] ?? null,
    connectionId: req.headers['x-connection-id'] ?? null,
    traceId,
  };
}
