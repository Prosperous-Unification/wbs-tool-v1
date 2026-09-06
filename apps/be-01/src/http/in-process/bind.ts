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
      // mapping is unambiguous. `method` is the route's, because the route a
      // request belongs to is what almost every handler branches on — and the
      // arrived verb is not thrown away with it any more, it is carried beside
      // it as `receivedMethod`, which both binders set and
      // `binder.contract.test.ts` pins. The one handler that needs the
      // difference is the OIDC callback, which mints session cookies and will
      // not do it for a request that cannot carry them back (TASK-269).
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
          // The verb as it arrived, beside the route's own. The Elysia binder
          // reads it off `ctx.request`; here it is the one the dispatch above
          // already normalised away. See `RouteRequest.receivedMethod`.
          receivedMethod: verb === 'HEAD' ? 'HEAD' : method,
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
 * The framework's own body dispatch, reproduced — the switch below, and the two
 * conditions in front of it in `decodeBody`.
 *
 * **The header is only read when there is a body to read.** Elysia's literal is
 * `let contentType` then `if(c.request.body)contentType=…get('content-type')`
 * (`elysia/dist/compose.mjs:421-426`), so a request carrying a body media type
 * and **no body** never reaches the switch and the handler sees `undefined`.
 * That guard was missing here when this comment first claimed the dispatch was
 * reproduced, and the omission was service-visible: `PATCH /api/projects/:id`
 * with `content-type: application/xml` and no body took the `x` arm, read empty
 * text and became `{}`, and `patchFrom({})` accepts every absent field and
 * returns an empty patch where `patchFrom(undefined)` refuses 422 before the
 * service (`../../controller/project.routes.ts`). Elysia answered 422 with no
 * call; this binder called `projects.update`.
 *
 * **It is not a media-type comparison, and assuming it was is what produced the
 * first draft of this fix.** A route that registers no `parse` hook — which is
 * every route in this app — takes the fast path Elysia compiles at
 * `elysia/dist/compose.mjs:435-444`: a `switch` on **`contentType.charCodeAt(12)`
 * alone**, with a `default` that checks whether the header starts with `t`.
 * There is no `;` truncation on this path and no lower-casing. Character 12 is
 * the one after `application/`.
 *
 * Measured on h2puni rather than read off alone, because the
 * consequences are not what a reader expects:
 *
 * ```
 * content-type                   char 12   elysia hands the handler
 * application/json               j         {"name":"Sand"}
 * application/json; charset=…    j         {"name":"Sand"}   (no truncation needed)
 * application/json-patch+json    j         {"name":"Sand"}   ← accepted
 * application/merge-patch+json   m         undefined
 * application/not-json           n         undefined
 * APPLICATION/JSON               J         undefined         ← case-sensitive
 * text/plain                     (none)    "{\"name\":\"Sand\"}"
 * application/octet-stream       o         ArrayBuffer
 * ```
 *
 * The probe ran against the copy in bun's install cache, which is 1.4.30; this
 * repository locks **1.4.28** (`bun.lock`), and the dispatch above is the same
 * in the locked source — checked, because a measurement against a version the
 * repo does not run is not evidence about the repo.
 *
 * So `application/json-patch+json` is admitted and `application/merge-patch+json`
 * is refused, and the difference is one character in a position nothing about
 * either name makes special. Reproducing that exactly — rather than the tidier
 * five-name set it looks like from `compose.mjs:500`, which is the *other* path,
 * taken only when a route registers a parser — is the whole point of this
 * binder: one that accepted a different set would let the contract suite pass
 * requests production refuses, and refuse ones it serves.
 */
// `j`, at index 12 of `application/json…`.
const DISPATCH_JSON = 106;
// `x`, at index 12 of `application/x-www-form-urlencoded`.
const DISPATCH_URLENCODED = 120;
// `o`, at index 12 of `application/octet-stream`.
const DISPATCH_OCTET_STREAM = 111;
// `r`, at index 12 of `multipart/form-data`.
const DISPATCH_FORM_DATA = 114;
// `t`, at index 0 of `text/plain`, the one arm that reads character 0.
const DISPATCH_TEXT = 116;

/**
 * `undefined` for a request that carries no body, the parsed value for JSON,
 * and a throw for JSON that will not parse — the binder turns that throw into
 * the 400 the framework would have answered.
 *
 * **The dispatch is the framework's own, character for character, and this is a
 * closed defect rather than a style choice.** Until TASK-270 this function
 * dispatched on `contentType.includes('json')`, which admitted every media type
 * with `json` anywhere in it. Measured on h2puni at `39e53dda`:
 * `POST /api/projects` with `content-type: application/merge-patch+json` and
 * `{"name":"Sand"}` answered **422 with no service call** under `bindElysia`
 * and **200, calling `projects.create("Sand", "u")`** here — the second binder
 * admitting a route-visible write the production binder refuses. The arbitrary
 * `application/not-json` diverged the same way. The dispatch below closes
 * it, and the contract clause in `../binder.contract.test.ts` asserts the
 * service call itself rather than only the status, because two matching 422s
 * would otherwise hide exactly this.
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
 * **Closed since this note was written.** Those four operations lost their
 * media-type *declarations* in the emitted document when the controllers
 * stopped declaring TypeBox, and `checkedBody` and `tableRefusedBody` now emit
 * all three — JSON, form-urlencoded and multipart — for every body in that
 * class (`../body-doc.ts`). Ten operations are in it today, not four; the list
 * `openapi/openapi-document.test.ts` asserts them on is the count that moves.
 * Behaviour and document match. The committed
 * `apps/be-01/openapi.json` is the check that keeps them matching, diffed by
 * `openapi/openapi-document.test.ts`.
 */
async function decodeBody(request: Request): Promise<unknown> {
  // GET and HEAD only, which is the framework's own condition
  // (`compose.mjs:257-258`) and **not** what this line said until TASK-270:
  // DELETE was in it, and Elysia parses a DELETE body. A `DELETE` carrying
  // `content-type: application/json` and a body that will not parse answered
  // 400 there — before the handler — while this binder never read it and ran
  // the handler, so `DELETE /api/saved-plans/:id` deleted a plan the production
  // binder had already refused (`../../controller/saved-plan.routes.ts`).
  // Measured under both binders; pinned by the DELETE clause in
  // `../binder.contract.test.ts`.
  //
  // HEAD is named explicitly rather than left to fall through the checks below:
  // it reaches this function carrying its own verb, not the GET it was
  // dispatched to.
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }
  // The framework's other precondition, and the one this binder was missing:
  // Elysia reads `content-type` only `if(c.request.body)`
  // (`compose.mjs:421-426`). A body media type on a request with no body is
  // therefore not a parse instruction, and treating it as one turned an empty
  // read into `{}` — a value `patchFrom` accepts where it refuses `undefined`.
  if (request.body === null) return undefined;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType === '') return undefined;
  const dispatch = contentType.charCodeAt(12);
  if (dispatch === DISPATCH_JSON) {
    const raw = await request.text();
    if (raw === '') return undefined;
    return JSON.parse(raw);
  }
  if (dispatch === DISPATCH_OCTET_STREAM) {
    return request.arrayBuffer();
  }
  // `formData()` reads the multipart arm only, since the two split. A file part
  // stays a `File` rather than being coerced to its name — which is what Elysia
  // hands a handler too, so the `typeof value !== 'string'` refusals in the
  // controllers answer 422 for it under either binder instead of writing a
  // filename into a column.
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
  // **Two arms, not one, and the framework is why.** `x` is `parseQuery(await
  // request.text())` there and `r` is the `formData()` literal
  // (`adapter/web-standard/index.mjs:33-35` and `:41-60`), and folding them
  // into one `formData()` call was this chunk's own first draft — caught by
  // review and then measured: `content-type: application/xml` has `x` at index
  // 12, so Elysia reads `name=Sand` with `parseQuery` and `POST /api/projects`
  // answers 200, while `Request.formData()` on that media type **throws** and
  // this binder turned it into 400. Refusing what production serves is the same
  // defect as admitting what it refuses, in the other direction.
  if (dispatch === DISPATCH_URLENCODED) {
    return foldRepeats(new URLSearchParams(await request.text()));
  }
  if (dispatch === DISPATCH_FORM_DATA) {
    return foldRepeats(await request.formData());
  }
  // The framework's `default`, and the only arm that reads a character other
  // than the thirteenth: any header beginning `t` is read as text, so
  // `text/csv` and `text/html` are parsed here exactly as `text/plain` is.
  if (contentType.charCodeAt(0) === DISPATCH_TEXT) {
    return request.text();
  }
  return undefined;
}

/**
 * A key seen once keeps its bare value; a key seen again becomes the array of
 * every value. The rule both of Elysia's form parsers reach, down their two
 * different paths, and the one place it is written now that the two arms above
 * are separate.
 *
 * `Object.fromEntries` is kept over an assigning loop on purpose: it defines own
 * properties, so a field literally named `__proto__` lands as data rather than
 * reaching the prototype setter.
 */
function foldRepeats(entries: URLSearchParams | FormData): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set(entries.keys())].map((key) => {
      const values = entries.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}
