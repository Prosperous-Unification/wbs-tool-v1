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
      const verb = request.method.toUpperCase();
      // HEAD is answered by the path's GET, which is what Elysia does and what
      // RFC 9110 §9.3.2 requires; no route in this app declares HEAD, so the
      // mapping is unambiguous. The handler is told `GET` because that is the
      // route it belongs to and it is what the Elysia binder passes — a handler
      // branching on a method it was never registered under would be a
      // difference between the binders rather than a shared contract.
      const method = (verb === 'HEAD' ? 'GET' : verb) as HttpMethod;

      for (const route of routes) {
        const params = matchPath(route.path, url.pathname);
        if (params === null || route.method !== method) continue;

        // Before `decodeBody`, mirroring the Elysia binder's `transform`, which
        // is emitted above the validator block. The two are **not** in the same
        // position relative to the body: Elysia's `parse` runs before any
        // `transform`, so a malformed body there answers 400 and no preflight
        // runs. That difference is dormant — every route declaring a preflight
        // today is a GET, where `decodeBody` returns `undefined` without
        // reading anything — and it is written here rather than left to be
        // rediscovered, because a body-taking route that declares one would
        // answer 401 here and 400 under Elysia. The shipped app answers 401
        // first for those (`app.ts:170-187` with `requiresWriteScope`), which
        // is an app-level property this fixture does not reproduce.
        const req: RouteRequest = {
          method,
          path: url.pathname,
          params,
          // Last value wins on a repeated key, and unlike the form body below
          // that really is what Elysia does — measured, because the obvious
          // reading of its source says otherwise. `parse-query.mjs` has a line
          // that arrays a repeated key unconditionally, but that is
          // `parseQuery`, allocated as the **body** parser
          // (`compose.mjs:978`). The query is built by `parseQueryFromURL`,
          // whose arraying branch is gated on a per-key map the composer
          // derives from `ArrayQuery` schema metadata (`compose.mjs:320-328`);
          // no route here declares an array-typed query parameter, so the map
          // is never passed and its plain `result[key] = value` runs. A route
          // that declared one would move Elysia and not this line — which is
          // why `binder.contract.test.ts` pins the agreement rather than
          // trusting this paragraph.
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(request.headers),
          body: undefined,
          url: request.url,
        };

        if (route.preflight !== undefined) {
          const refusal = await route.preflight(req);
          if (refusal !== null) return toResponse(refusal);
        }

        try {
          req.body = await decodeBody(request);
        } catch {
          return toResponse(respond(400, { error: 'invalid_body' }));
        }
        const answer = toResponse(await route.handler(req));
        return verb === 'HEAD' ? await withoutBody(answer) : answer;
      }
      // One pass, and one answer: an unknown path and a known path reached with
      // the wrong verb are both 404. See the note on this function.
      return toResponse(respond(404, { error: 'not_found' }));
    },
  };
}

/**
 * The GET's answer with its body withheld and its length kept.
 *
 * `content-length` is set rather than dropped because that number is the reason
 * a client sends HEAD at all — sizing a download without fetching it. Elysia
 * answers `content-length: 17` for the 17-byte `{"hello":"world"}` and this
 * reproduces it; the status, the content type and every header the route set
 * carry over untouched.
 */
async function withoutBody(res: Response): Promise<Response> {
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set('content-length', String(body.byteLength));
  return new Response(null, { status: res.status, headers });
}

/**
 * `undefined` for a request that carries no body, the parsed value for JSON,
 * and a throw for JSON that will not parse — the binder turns that throw into
 * the 400 the framework would have answered.
 *
 * **The two form media types are read, and that is a correction rather than a
 * feature.** The sentence that used to justify dropping them — "every route in
 * this app takes JSON or nothing" — was false. Measured against one route list
 * before the fix, 2026-09-05:
 *
 * ```
 * body                             elysia                  in-process
 * x-www-form-urlencoded            200 {"name":"Sand"}     200 (body dropped)
 * multipart/form-data              200 {"name":"Sand"}     200 (body dropped)
 * JSON bytes, no content-type      200 (body dropped)      200 (body dropped)
 * ```
 *
 * Elysia parses both; this function dropped them, so the same request that
 * creates a project under Elysia was a **422 `invalid_body`** here — the
 * handler's `isFieldBag` refusing the `undefined` it was handed.
 *
 * **Parsed rather than refused, by this branch's own rule.** `PATCH
 * /api/projects/{id}`, `POST /api/projects/{id}/saved-plans`, `PATCH
 * /api/saved-plans/{id}` and `POST /api/auth/login` declared those media types
 * on `main` — Elysia derived them from the TypeBox schemas — and the app still
 * accepts them. Refusing non-JSON under both binders was the other option and
 * is a real narrowing of the API: it belongs to whoever wants it, with the
 * clients told. Same argument, same words, as the 405 this binder gave up.
 *
 * The third row above is **not** a divergence and is deliberately left alone:
 * both binders drop a JSON body sent with no content type.
 *
 * **Closed since this note was written.** The four operations lost their
 * media-type *declarations* in the emitted document when the controllers
 * stopped declaring TypeBox, and `checkedBody` now emits all three — JSON,
 * form-urlencoded and multipart — for every body in that class
 * (`../body-doc.ts`). Behaviour and document match. The committed
 * `apps/be-01/openapi.json` is the check that keeps them matching, diffed by
 * `openapi/openapi-document.test.ts`.
 */
async function decodeBody(request: Request): Promise<unknown> {
  // HEAD is here for the same reason GET is, and explicitly rather than by
  // falling through the content-type checks below: it reaches this function
  // carrying its own verb, not the GET it was dispatched to.
  if (request.method === 'GET' || request.method === 'DELETE' || request.method === 'HEAD') {
    return undefined;
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    const raw = await request.text();
    if (raw === '') return undefined;
    return JSON.parse(raw);
  }
  // `formData()` reads both, and a file part stays a `File` rather than being
  // coerced to its name — which is what Elysia hands a handler too, so the
  // `typeof value !== 'string'` refusals in the controllers answer 422 for it
  // under either binder instead of writing a filename into a column.
  //
  // **A repeated field is every value, not the last one.** `Object.fromEntries`
  // over the entries collapses a duplicate key and Elysia does not, which was a
  // live disagreement on the four operations that accept these media types.
  // Measured on h2puni at `cf2c0307` before this loop replaced it:
  //
  // ```
  // body                     elysia                 in-process
  // t=a&t=b&t=c              {"t":["a","b","c"]}    {"t":"c"}
  // multipart t=a, t=b       {"t":["a","b"]}        {"t":"b"}
  // ```
  //
  // Elysia reaches the same answer down two different paths — `parseQuery` for
  // urlencoded, the adapter's `formData()` literal for multipart — and both
  // give a key seen once its bare value and a key seen again an array, which is
  // the rule reproduced here. `Object.fromEntries` is kept over an assigning
  // loop on purpose: it defines own properties, so a field literally named
  // `__proto__` lands as data rather than reaching the prototype setter.
  //
  // **Three multipart-only rules are NOT reproduced, and they are measured
  // rather than assumed.** Elysia's `formData()` literal also JSON-parses a
  // single value that opens with `{` or `[`, builds nested objects and arrays
  // out of dotted and bracketed key paths, and drops dangerous keys outright:
  //
  // ```
  // multipart body           elysia                 in-process
  // tag={"a":1}              {"tag":{"a":1}}        {"tag":"{\"a\":1}"}
  // t[0]=a, t[1]=b           {"t":["a","b"]}        {"t[0]":"a","t[1]":"b"}
  // __proto__=x, ok=y        {"ok":"y"}             {"__proto__":"x","ok":"y"}
  // ```
  //
  // Under urlencoded the first two agree with this binder and only the third
  // differs, because that path is `parseQuery` and has none of the machinery.
  // It is one interlocking feature — file folding into a parsed object hangs
  // off the same code — and reproducing a third of it faithfully is worse than
  // recording it, so it belongs to whoever wants it, like the 405 above.
  if (contentType.includes('form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    return Object.fromEntries(
      [...new Set(form.keys())].map((key) => {
        const values = form.getAll(key);
        return [key, values.length === 1 ? values[0] : values];
      }),
    );
  }
  return undefined;
}
