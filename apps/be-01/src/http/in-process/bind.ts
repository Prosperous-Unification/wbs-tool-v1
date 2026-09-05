import { toResponse } from '../response';
import { type HttpMethod, matchPath, respond, type Route, type RouteRequest } from '../route';

/**
 * The second binder, and the reason Task 1 can *claim* framework independence
 * rather than assert it.
 *
 * It runs the same route list with no HTTP framework at all — no Elysia, no
 * server, no socket. It answers `Request` in and `Response` out because that is
 * the surface Elysia's own `app.handle()` presents, so
 * `binder.contract.test.ts` drives one set of assertions against both and a
 * route module that had quietly grown a framework dependency would fail here
 * rather than pass everywhere.
 *
 * It is **not** a production server and does not try to be. No `onRequest`
 * chain, no plugins, no OpenAPI document: those are app-level concerns that
 * `app.ts` still composes on Elysia, and the honest scope of this file is the
 * route list.
 *
 * **A known path reached with the wrong verb answers 404, not 405.** This binder
 * answered 405 until the Gemini review measured the disagreement it created:
 *
 * ```
 * POST /probe/plain   elysia 404 NOT_FOUND   in-process 405 {"error":"method_not_allowed"}
 * GET  /probe/nope    elysia 404 NOT_FOUND   in-process 404 {"error":"not_found"}
 * ```
 *
 * 405 is the better HTTP and that is not the question. Whether a route list
 * answers a wrong verb as "no such route" is a property of the route list, so
 * both binders owe the same status — the same reading chunk 8 applied to the
 * trailing slash, which it *closed* by normalising `matchPath` rather than
 * recording as a difference. The value is 404 because 404 is what this API
 * ships: `app.ts` runs on Elysia, Elysia answers 404, and a refactor whose whole
 * claim is that it changed no behaviour does not get to improve a status on the
 * way past. Moving the app to 405 is a real API change and belongs to whoever
 * wants it, with the clients told.
 */
export function bindInProcess(routes: readonly Route[]): {
  handle: (request: Request) => Promise<Response>;
} {
  return {
    handle: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const method = request.method.toUpperCase() as HttpMethod;

      for (const route of routes) {
        const params = matchPath(route.path, url.pathname);
        if (params === null || route.method !== method) continue;

        let body: unknown;
        try {
          body = await decodeBody(request);
        } catch {
          return toResponse(respond(400, { error: 'invalid_body' }));
        }

        const req: RouteRequest = {
          method,
          path: url.pathname,
          params,
          // Last value wins on a repeated key, which is what Elysia's own query
          // parser does; asserting the same rule here keeps a handler reading a
          // duplicated parameter from answering two different things.
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(request.headers),
          body,
          url: request.url,
        };
        return toResponse(await route.handler(req));
      }
      // One pass, and one answer: an unknown path and a known path reached with
      // the wrong verb are both 404. See the note on this function.
      return toResponse(respond(404, { error: 'not_found' }));
    },
  };
}

/**
 * `undefined` for a request that carries no body, the parsed value for JSON,
 * and a throw for JSON that will not parse — the binder turns that throw into
 * the 400 the framework would have answered.
 *
 * A non-JSON content type reads as no body rather than as text: every route in
 * this app takes JSON or nothing, so a handler receiving a string it never
 * expects would be a worse failure than a field it finds absent.
 */
async function decodeBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'DELETE') return undefined;
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return undefined;
  const raw = await request.text();
  if (raw === '') return undefined;
  return JSON.parse(raw);
}
