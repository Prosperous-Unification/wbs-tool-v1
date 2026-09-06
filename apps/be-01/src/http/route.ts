/**
 * The route shape every controller in this app is written against, and the one
 * type file that names no HTTP framework.
 *
 * A route is `{ method, path, handler }` and a handler is a plain async
 * function from a {@link RouteRequest} to a {@link RouteResponse}. Nothing here
 * imports the HTTP framework, and neither does anything under `controller/` —
 * `eslint.config.js` restricts both the package and every module under
 * `http/elysia/` there, which is the enforcement this comment used to claim and
 * the repository did not have. The whole point of the shape is that a second
 * binder over the same route list needs no framework at all, which is what
 * `http/binder.contract.test.ts` runs.
 *
 * What deliberately is **not** here: body validation, and any notion of a
 * plugin. Ten routes in this app parse their bodies by hand because Elysia
 * strips unknown properties before a guard can refuse them
 * (`http/body-doc.ts` says why at length), so a validation hook in
 * the route type would advertise a seam those routes cannot take. A route that
 * wants a schema declares it in {@link Route.documentation}, which is carried
 * to whichever binder can publish it and ignored by the ones that cannot.
 */
export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

/**
 * One request, already decomposed into the four things handlers actually read.
 *
 * `headers` keys are lowercased by every binder, because that is the only
 * spelling a handler can rely on across frameworks: HTTP/2 requires lowercase
 * on the wire, Elysia hands them over lowercased, and a handler that reached
 * for `Authorization` would work under one binder and silently fail under
 * another.
 *
 * `body` is the decoded value or `undefined`, never a stream: the two batch
 * routes parse it themselves and the rest read fields off it. A body that is
 * not valid JSON never reaches a handler — the binder answers 400 first, which
 * is the one refusal the route list does not own.
 */
export interface RouteRequest {
  /**
   * The method of the **route** this request was dispatched to, which is what a
   * handler branching on a verb it was registered under wants. A HEAD answered
   * by a path's GET reads `GET` here under every binder — see {@link
   * RouteRequest.receivedMethod} for the other half.
   */
  method: HttpMethod;
  /**
   * The verb the request actually **arrived** with. Equal to {@link
   * RouteRequest.method} for everything except a HEAD answered by this path's
   * GET, where it is `'HEAD'`.
   *
   * Two fields rather than one, and the split is a finding rather than a
   * preference. HEAD resolves to the GET route (RFC 9110 §9.3.2) and the route
   * it belongs to is the fact almost every handler wants, so `method` stays the
   * registered verb; but the OIDC callback rebuilds a provider `Request` and
   * mints session cookies, and answering that from a HEAD spends a single-use
   * login transaction on a request that cannot carry the answer back. Before
   * the framework-free route shape it read the raw `request.method` and could
   * tell; with only `method` it cannot, which is TASK-269's second half.
   *
   * Widening {@link HttpMethod} to include `'HEAD'` was the other option and is
   * worse: no route in this app declares HEAD, so the union would grow a member
   * every route table, `switch` and registration has to consider in order to
   * describe a verb none of them can be registered under.
   *
   * `binder.contract.test.ts` pins that both binders agree on both fields; a
   * binder that set only one would let a route read a verb under Elysia it
   * cannot read anywhere else, which is the whole class the second binder
   * exists to catch.
   */
  receivedMethod: HttpMethod | 'HEAD';
  /** The pathname as matched, without query string. */
  path: string;
  /**
   * Path parameters by name, from the `:name` segments of {@link Route.path}.
   *
   * A segment whose percent encoding no decoder accepts arrives as `null` under
   * every binder, against this type — Elysia declares path parameters as
   * strings and puts `null` there, and a binder that disagreed would let a
   * route reach a record the shipped server cannot. `decodeSegment` carries the
   * measurement and the widening that would make the type honest.
   */
  params: Record<string, string>;
  /**
   * Query parameters. A repeated key keeps its **last** value, as Elysia does.
   *
   * Last, and therefore **not** what `new URL(url).searchParams.get(k)` answers
   * — that is the first. The two spellings sat side by side on this branch and
   * the OIDC callback changed which value it read when it moved onto this
   * shape (TASK-269). A route that cares whether a key repeated at all cannot
   * learn it from this record and reads {@link RouteRequest.url} instead; the
   * callback is the one route in this app that does.
   */
  query: Record<string, string>;
  /** Request headers, keys lowercased. */
  headers: Record<string, string | undefined>;
  body: unknown;
  /**
   * The raw URL, read by exactly one handler: the OIDC callback, which needs
   * the origin the request arrived on to rebuild the provider's `Request`, and
   * the query string *as sent* to see whether a key repeated — {@link
   * RouteRequest.query} cannot answer the second question at all.
   *
   * The earlier wording here named a second reader, the cookie-origin check.
   * It was wrong (Sol's Minor 2 on TASK-262, `queue/reviews/t262-r13-sol-44463938.md`):
   * `hasInvalidCookieOrigin` takes the framework's own `Request`, compares the
   * `origin` **header** against the configured app origin, and parses no URL.
   */
  url: string;
}

/**
 * One answer. `body` is a value, not a serialised string — the binder decides
 * how to put it on the wire, which is exactly the decision a route module must
 * not make.
 *
 * `null` is the body of a 204 and serialises to no body at all.
 */
export interface RouteResponse {
  status: number;
  body: unknown;
  /** Response headers, added as given. One value per name — see {@link RouteResponse.cookies}. */
  headers?: Record<string, string>;
  /**
   * Pre-serialised `Set-Cookie` values, one per entry, each added as its own
   * header line.
   *
   * A separate field rather than a `string[]` case in {@link
   * RouteResponse.headers}, because `Set-Cookie` is the only header in this app
   * that legitimately repeats and RFC 6265 §3 forbids folding several of them
   * into one comma-joined line — a client that received the folded form would
   * read one malformed cookie instead of three. Widening `headers` to
   * `string | string[]` would put that hazard on every header name and make
   * each binder decide, per header, whether repetition is meaningful; naming
   * the one that repeats keeps the decision in the route shape.
   *
   * Three routes need more than one: the OIDC callback clears the transaction
   * cookie while setting the access and session cookies, and `refresh`'s 401
   * and `logout` both clear two. Under Elysia those handlers returned a raw
   * `Response` and appended the headers themselves, which is exactly the
   * framework knowledge a route module must not hold.
   *
   * The values are already cookie syntax (`name=value; HttpOnly; …`). Nothing
   * here escapes or validates them: the route wrote the cookie, and a binder
   * that re-encoded it would change a credential.
   */
  cookies?: readonly string[];
  /**
   * The body is already on the wire's terms — a string the binder writes
   * unchanged instead of encoding as JSON. Set it through {@link text}.
   *
   * A flag rather than an inference from the content type, and rather than the
   * rule "a string body is already serialised". Both of those quietly change
   * what an existing response means: a route answering the JSON string `"ok"`
   * is a body of five characters including its quotes, and guessing from the
   * type would make that route's answer depend on a header somebody set for a
   * different reason. This is the route saying which of the two it meant.
   */
  serialised?: boolean;
}

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;

/**
 * A refusal the binder answers **before its derived validation** — `null` for
 * "carry on".
 *
 * **Not before the body parser, and the difference is not a detail.** Elysia's
 * order is `parse` then `transform`, so a malformed body answers 400 there and
 * this never runs at all. The in-process binder runs this
 * ahead of `decodeBody` because it has no earlier seat to use. Every route
 * declaring one today is a `GET`, where that difference cannot be observed;
 * a body-taking route that declared one would answer 401 under one binder and
 * 400 under the other, which is why `in-process/bind.ts` says so at the call
 * site. The route shape already treats a malformed body as the binder's own
 * refusal — see {@link RouteRequest.body}.
 *
 * The request it is handed carries no `body`, under **either** binder: Elysia
 * has parsed one by this point and the in-process binder has not, so passing
 * the parsed value where it exists would let one preflight observe two
 * different requests. Nothing this app declares reads it.
 *
 * Only `status` and `body` of the returned refusal reach the wire under
 * `bindElysia` — `status(…)` carries no headers and no `Set-Cookie`. Every
 * refusal `callerGuard` produces is `respond(…)`, which sets neither. A
 * preflight that needed a header would have to be answered somewhere else, and
 * this comment is the place that says so before somebody writes one.
 *
 * This is a check, not a declaration. It carries no service and names no
 * requirement the binder has to interpret: whatever produced it closed over
 * everything it needs, which is why neither binder's signature grows an
 * `AuthService` and why {@link Route} stays a data type.
 *
 * **It is an ordering hint and never a boundary.** A route that omits it is
 * refused exactly where it is refused without it — inside its own handler, by
 * the same guard. Forgetting one moves a 401 later; it cannot open a route.
 * That is the whole reason this field is optional and nothing else in the app
 * was deleted to make room for it: three earlier designs made the route list
 * the *authority* for auth, and each one then owed a proof that its table
 * covered every requirement the mechanisms it replaced had covered.
 *
 * What it exists for: a binder that derives a validator from
 * {@link Route.documentation}'s `querySchema` runs that validator before the handler,
 * so an unauthenticated caller sending a malformed query learned the shape of
 * the query before being told it may not ask — 422 under Elysia, 401 under the
 * in-process binder, for one route list. Only a framework-derived refusal can
 * get in front of a handler guard, so only routes carrying a query schema can
 * have the defect, which is the set `app.routes.test.ts` checks.
 */
export type RoutePreflight = (req: RouteRequest) => Promise<RouteResponse | null>;

export interface Route {
  method: HttpMethod;
  /**
   * The full path including any prefix. Prefixes are spelled out rather than
   * inherited from a group, because a route list is read to find out which
   * paths exist and a grouped prefix makes that a two-file question.
   */
  path: string;
  handler: RouteHandler;
  /**
   * See {@link RoutePreflight}. Declared on the **route** rather than attached
   * to the handler function, because six saved-plan handlers are wrapped —
   * `refusingUnknownBodyVersion(guard(…))` — and a marker hung on the guarded
   * function would be dropped by the wrapper silently, with every clause still
   * green.
   */
  preflight?: RoutePreflight;
  /**
   * Opaque per-route documentation, handed to a binder that can publish an
   * OpenAPI document and ignored by one that cannot. `detail` is typed
   * `unknown` on purpose: naming Elysia's `DocumentDecoration` here would put
   * the framework back into the framework-free file.
   *
   * `querySchema` is a **name**, not a schema, and that is the difference
   * acceptance criterion #1 turned on. A query schema in this app has to be
   * built with the framework's own `t` — a plain JSON Schema object in
   * Elysia's `query` hook failed six history route tests and the
   * committed-document diff, because its validator needs TypeBox's `Kind`
   * symbol — so a route module that held the value would import `elysia`
   * transitively and the controller directory would load the framework
   * whichever binder mounted it. Naming the schema instead leaves the dialect
   * on the binder's side of the seam: `http/elysia/query-schemas.ts` maps every
   * {@link QuerySchemaName} to the TypeBox object, and a binder that publishes
   * no document reads neither.
   *
   * The schema is named here rather than written into a validation hook because
   * of what these schemas are *for*: Elysia derives a route's documented
   * parameters from the route plus this schema and **replaces** anything
   * hand-written in `detail`, so a query string described only in prose is a
   * document that omits half the contract. Of the two, `history`'s refuses
   * nothing — every key is `t.Optional` and `history.routes.ts` spells out why
   * — while `compare`'s requires `left` and `right` as non-empty strings and a
   * binder that derives it answers 422, which is the whole reason
   * {@link Route.preflight} exists. The parsing that gives a query *meaning* is
   * in the handler either way, where a binder cannot skip it, and
   * `saved-plan.routes.ts` re-checks `compare`'s two by hand for binders that
   * read no schema at all.
   */
  documentation?: { detail?: unknown; querySchema?: QuerySchemaName };
}

/**
 * The query schemas a route may name, spelled as a closed union so the mapping
 * cannot drift in either direction.
 *
 * A route naming a schema this app does not have fails to compile here; a
 * schema map missing one of these names fails to compile in
 * `http/elysia/query-schemas.ts`, which types itself
 * `Record<QuerySchemaName, TSchema>`. That is the whole reason the indirection
 * is a union rather than a bare `string`: replacing an import with a name is
 * only an improvement if the name is still checked.
 *
 * Two routes are documented this way — `GET /api/projects/{id}/history` and
 * `GET /api/projects/{id}/saved-plans/compare`. Every other query string in
 * this app is described in its handler's prose and parsed there.
 */
export type QuerySchemaName = 'compare' | 'history';

/**
 * True for a JSON value a handler may read named fields off — an object that is
 * neither `null` nor an **array**.
 *
 * This exists because `typeof [] === 'object'`, and every hand-written body
 * check on this branch was spelled `typeof body !== 'object' || body === null`.
 * That spelling is a hole: TypeBox's `t.Object(...)`, which these checks
 * replaced, refuses an array, and the hand-written version accepted one. It
 * reached a caller on `POST /api/projects/:id/saved-plans`, where a JSON `[]`
 * body stopped answering 422 and started **writing a timestamp-named plan** and
 * answering 201 — a body that names no field read as a body that omitted every
 * optional one.
 *
 * Two of the eight sites regressed; the other six answered 422 only because a
 * required field was missing from the array, which is luck rather than a rule.
 * So this is one named predicate rather than two patches: the hole is in the
 * spelling, and every site that reads fields off `RouteRequest.body` uses it.
 */
export function isFieldBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A 200 with a JSON body. */
export function ok(body: unknown): RouteResponse {
  return { status: 200, body };
}

/** Any status with a JSON body — the shape handlers use for refusals. */
export function respond(status: number, body: unknown): RouteResponse {
  return { status, body };
}

/**
 * An answer that is not JSON: a string the binder puts on the wire unchanged,
 * under the content type the route names.
 *
 * One route needs it — `GET /api/projects/:id/export?format=markdown`, which
 * hands back a Markdown table a human reads. Without this the route shape could
 * not express that answer at all, and the omission was **invisible under
 * Elysia**: Elysia returns a string return value as-is, so the route would have
 * kept working through `bindElysia` and answered a JSON-quoted, backslash-escaped
 * document through any other binder. That is exactly the class of framework
 * dependency the second binder exists to catch, and it is why this went in
 * before the route it is for.
 */
export function text(status: number, body: string, contentType: string): RouteResponse {
  return { status, body, headers: { 'content-type': contentType }, serialised: true };
}

/** A 204: no body, and the one response whose `body` must be `null`. */
export function noContent(): RouteResponse {
  return { status: 204, body: null };
}

/**
 * Path pattern to a matcher, shared by every binder that has to route by hand.
 *
 * Segment-wise rather than by regular expression, because the patterns in this
 * app are all `/literal/:param` and a regex would have to escape the literals
 * to stay safe against a path segment containing regex syntax.
 *
 * Returns the parameters on a match and `null` on a miss, so a caller cannot
 * confuse "matched with no parameters" with "did not match" — an empty object
 * is truthy and `null` is not.
 *
 * **A single trailing slash is ignored, because Elysia ignores it and a binder
 * contract is not a place to disagree about what a URL means.** Measured on
 * this branch: `SLASHPROBE elysia bare=200 slash=200`, `SLASHPROBE in-process
 * bare=200 slash=404`. Every route migrated onto the route shape had that
 * divergence — `/api/projects/` reached the app under Elysia, which is also why
 * the old `new Elysia({ prefix })` plus a `'/'` path answered the bare spelling
 * fe-01 has always sent. Normalising here rather than asserting the difference
 * is the choice that keeps one meaning per URL across binders; the alternative
 * would have been a contract case documenting that this app answers a different
 * set of URLs depending on which binder is mounted, which is not a contract.
 *
 * Exactly **one** trailing slash and only on the request, never on the pattern:
 * the patterns in this app carry none, `//` stays a miss, and `/` itself is left
 * alone so the root path does not normalise to the empty string.
 */
/**
 * One path segment, decoded — or `null` where it cannot be, which is what
 * Elysia puts there.
 *
 * `decodeURIComponent` **throws** `URIError` on malformed percent encoding, and
 * `matchPath` is called outside the in-process binder's `try`, so
 * `/probe/echo/%ZZ` rejected the promise out of `handle()` instead of answering
 * at all. Elysia does not: it decodes with `fast-decode-uri-component`, which
 * returns `null` rather than throwing, and **measured at this head both binders
 * match the route and Elysia answers 200 with the parameter as `null`.**
 *
 * So the fix is agreement on the answer, not a refusal: the route matches under
 * both binders, the handler runs under both, and a segment this app cannot
 * decode arrives as **the same value Elysia puts there** — `null`.
 *
 * The first fix handed it over raw instead, on the argument that `'%ZZ'` and
 * `null` both reach a repository lookup that answers `not_found`. TASK-270
 * item 2 measured that argument false. A solution slug is any non-empty string
 * (`controller/project.routes.ts`) and `GET /plans/by-solution/:slug` is an
 * exact lookup (`controller/solution.routes.ts`), so a stored slug spelled
 * `%ZZ` is reachable by the raw value and unreachable by Elysia's `null`: on
 * h2puni at `53d78020`, over a store holding that key, `elysia -> found:false`
 * and `in-process -> found:true`. A second binder that admits a record the
 * shipped server cannot see is the exact failure the second binder exists to
 * catch, so it is closed rather than described.
 *
 * `null` is a lie against the declared type, and it is **Elysia's own lie**:
 * that framework declares a path parameter as `string` too —
 * `Record<GetPathParameter<Path>, string>`, `elysia/dist/types.d.ts:342` at
 * 1.4.28 — and puts `null` there anyway. Reproducing it keeps one meaning per
 * URL across binders. The honest alternative — widening {@link
 * RouteRequest.params} to `Record<string, string | null>` — is deferred, not
 * rejected: it puts a case no client sends in front of 31 parameter reads on 27
 * lines of the seven controller modules. Measured at this head, deferring it
 * changes no answer any of them gives except one: `POST /projects/:id/commands`
 * hands `null` to `PlanCommandRunner`'s no-project sentinel, so a batch naming a
 * work item answers 400 `project_required` where the raw segment answered 404
 * `not_found`. Both refuse, both roll back, and neither is the wrong 200 the
 * divergence itself was. Whoever wants the compiler to enforce the case should
 * widen the type and keep these clauses, which assert values and not statuses.
 *
 * Same accept set, measured rather than assumed: across `%ZZ`, `%`, `%%`,
 * `%E0%A4%A`, `%C0%80`, `%20`, `%F0%9F%98%80`, `a%2Fb` and `ok`, this decoder
 * and Elysia's `fast-decode-uri-component` failed on the same five and produced
 * the same value for the same four. `binder.contract.test.ts` pins both the
 * parameter's value and what that value can reach.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = (
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  ).split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const given = actual[index] ?? '';
    if (segment.startsWith(':')) {
      // An empty segment is not a parameter value: `/api/projects//steps` must
      // 404 rather than resolve to a project whose id is the empty string,
      // which every repository would then look up and answer `not_found` to.
      if (given === '') return null;
      // The one cast in this file, and it is the framework's: `decodeSegment`
      // answers `null` for a segment no decoder accepts, exactly as Elysia
      // does, and Elysia declares the same `Record<string, string>` while doing
      // it. See `decodeSegment` for the measurement and for the widening that
      // would remove the cast.
      params[segment.slice(1)] = decodeSegment(given) as unknown as string;
    } else if (segment !== given) {
      return null;
    }
  }
  return params;
}
