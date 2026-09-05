import { Elysia, status } from 'elysia';

import { toResponse } from '../response';
import type { HttpMethod, Route, RouteRequest } from '../route';

/**
 * Elysia's context, as far as this file reads it. Named once because
 * `routeRequestFrom` and the handler must decompose it identically — a
 * `transform` that lowercased headers differently from `handle` would refuse a
 * caller the handler would have admitted.
 */
interface ElysiaContext {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  request: Request;
}

/**
 * One request, decomposed the same way for the preflight and for the handler.
 *
 * `body` is the one field they differ on, and it is passed rather than read off
 * the context: a `transform` runs after Elysia's body parser, so `ctx.body` is
 * already populated there, while the in-process binder runs its preflight
 * before `decodeBody` and has nothing to give. Handing the parsed value over
 * where it happens to exist would let one preflight observe two different
 * requests, so both pass `undefined` — see `RoutePreflight` in `../route`.
 */
function routeRequestFrom(method: HttpMethod, ctx: ElysiaContext, body: unknown): RouteRequest {
  return {
    method,
    path: new URL(ctx.request.url).pathname,
    params: ctx.params,
    // Elysia types a query value as possibly undefined because a bare `?flag`
    // has none. Handlers compare against a string, so an absent value is
    // dropped rather than carried as `undefined` — `'cascade' in query` would
    // otherwise be true for a flag that was never given a value, which is the
    // opposite of what the DELETE route asks.
    query: Object.fromEntries(
      Object.entries(ctx.query).filter((entry): entry is [string, string] => {
        return entry[1] !== undefined;
      }),
    ),
    headers: ctx.headers,
    body,
    url: ctx.request.url,
  };
}

/**
 * The Elysia binder: a route list in, a mountable Elysia instance out.
 *
 * This file and `app.ts` are the only two places under `src/` that import
 * `elysia`, and that is the whole claim of the refactor — everything a
 * controller does is now expressed against `../route`, and swapping the
 * framework means writing a sibling of this file.
 *
 * Routes are registered through the **method-specific** calls rather than a
 * generic `.route()`, because `@elysiajs/openapi` builds its document from the
 * route table of the instance it is mounted on and the method-specific
 * registrations are the shape it has always read. The document is committed and
 * diffed by `openapi/openapi-document.test.ts`, so a route that stops appearing
 * here is a red rather than a silent omission.
 *
 * The instance is deliberately **unnamed and fresh per call**, matching the
 * controllers it replaces: the test suite builds many apps in one process, each
 * with its own `AuthService`, and a named plugin would be deduped and reused
 * across them with the first app's services closed over inside it.
 */
export function bindElysia(routes: readonly Route[]): Elysia {
  let app = new Elysia();
  for (const route of routes) {
    const handle = async (
      ctx: ElysiaContext & {
        set: { status?: number | string; headers: Record<string, string> };
      },
    ): Promise<unknown> => {
      const res = await route.handler(routeRequestFrom(route.method, ctx, ctx.body));
      // `set.headers` holds one value per name, so a response setting more than
      // one cookie cannot be expressed through it — and folding them into a
      // single comma-joined line is not the same header (RFC 6265 §3). For that
      // response the binder builds the answer itself and returns it, which
      // Elysia passes through unchanged; it is the path the OIDC handlers used
      // directly before they moved onto the route shape. `set.status` is left
      // alone on this branch so the `Response`'s own status is the only one.
      if (res.cookies !== undefined && res.cookies.length > 0) return toResponse(res);
      ctx.set.status = res.status;
      for (const [name, value] of Object.entries(res.headers ?? {})) {
        ctx.set.headers[name] = value;
      }
      return res.body;
    };

    // `detail` and `query` are the two hook keys `@elysiajs/openapi` reads, and
    // `transform` is the seat the route's own refusal takes — route-local, and
    // emitted *above* the validator block in Elysia's compiled handler
    // (`compose.mjs:524-544` vs `:546`), so it is the only per-route position
    // that can answer before a derived query schema does. A returned
    // `ElysiaCustomStatusResponse` short-circuits (`:541` → `mapResponse` at
    // `:362-365` emits a literal `return`); measured on h2puni with the control
    // that the same request without it answers 422.
    //
    // A route with neither documentation nor a preflight passes no hook at all,
    // so the generated document is byte-identical to the one the per-controller
    // registrations produced. `transform` is not a key `@elysiajs/openapi`
    // reads, so adding one does not move the document either — asserted by
    // `openapi/openapi-document.test.ts` rather than assumed.
    const preflight = route.preflight;
    const hook =
      preflight === undefined
        ? route.documentation
        : {
            ...route.documentation,
            transform: async (ctx: ElysiaContext) => {
              const refusal = await preflight(routeRequestFrom(route.method, ctx, undefined));
              // `undefined`, not the refusal, is how a `transform` says "carry
              // on": any other return value is treated as the hook's result.
              if (refusal === null) return undefined;
              // `status` carries the two fields a caller refusal has and
              // nothing else — a `RouteResponse`'s `headers` and `cookies` do
              // not survive this seat. Every refusal `callerGuard` produces is
              // `respond(…)`, which sets neither; `RoutePreflight` says
              // so where somebody writing a new one would read it.
              return status(refusal.status, refusal.body);
            },
          };
    app = register(app, route.method, route.path, handle, hook);
  }
  return app;
}

function register(
  app: Elysia,
  method: HttpMethod,
  path: string,
  handle: (ctx: never) => Promise<unknown>,
  // Widened past `Route['documentation']` for the `transform` above. Typed
  // structurally rather than as Elysia's own hook type for the same reason the
  // route shape does not name `DocumentDecoration`: the framework's types stop
  // at this file's boundary, and every value passed here is built two lines up.
  hook: (Route['documentation'] & { transform?: unknown }) | undefined,
): Elysia {
  /* eslint-disable @typescript-eslint/no-explicit-any,
                    @typescript-eslint/no-unsafe-assignment,
                    @typescript-eslint/no-unsafe-call,
                    @typescript-eslint/no-unsafe-member-access,
                    @typescript-eslint/no-unsafe-return
     -- the binder is the one place that erases the route-level types Elysia
     would otherwise infer. Its method-specific registrations are generic over
     the path string and the hook, so calling one through a `HttpMethod`
     variable has no type Elysia can narrow; every handler above this line is
     typed against RouteRequest/RouteResponse instead, which is the point. */
  const anyApp = app as any;
  switch (method) {
    case 'GET':
      return anyApp.get(path, handle, hook);
    case 'POST':
      return anyApp.post(path, handle, hook);
    case 'PUT':
      return anyApp.put(path, handle, hook);
    case 'PATCH':
      return anyApp.patch(path, handle, hook);
    case 'DELETE':
      return anyApp.delete(path, handle, hook);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any,
                   @typescript-eslint/no-unsafe-assignment,
                   @typescript-eslint/no-unsafe-call,
                   @typescript-eslint/no-unsafe-member-access,
                   @typescript-eslint/no-unsafe-return */
}
