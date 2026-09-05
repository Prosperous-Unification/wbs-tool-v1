/**
 * The route shape every controller in this app is written against, and the one
 * type file that names no HTTP framework.
 *
 * A route is `{ method, path, handler }` and a handler is a plain async
 * function from a {@link RouteRequest} to a {@link RouteResponse}. Nothing here
 * imports `elysia`, and the ESLint boundary in `.eslintrc` is what keeps that
 * true — the whole point of the shape is that a second binder over the same
 * route list needs no framework at all, which is what
 * `http/binder.contract.test.ts` runs.
 *
 * What deliberately is **not** here: body validation, and any notion of a
 * plugin. Ten routes in this app parse their bodies by hand because Elysia
 * strips unknown properties before a guard can refuse them
 * (`http/elysia/hand-parsed-body.ts` says why at length), so a validation hook in
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
  method: HttpMethod;
  /** The pathname as matched, without query string. */
  path: string;
  /** Path parameters by name, from the `:name` segments of {@link Route.path}. */
  params: Record<string, string>;
  /** Query parameters. A repeated key keeps its **last** value, as Elysia does. */
  query: Record<string, string>;
  /** Request headers, keys lowercased. */
  headers: Record<string, string | undefined>;
  body: unknown;
  /**
   * The raw URL, for the two places that need the origin rather than the path
   * (the OIDC redirect builder and the cookie-origin check).
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
   * Opaque per-route documentation, handed to a binder that can publish an
   * OpenAPI document and ignored by one that cannot. The values are typed
   * `unknown` on purpose: naming Elysia's `DocumentDecoration` here would put
   * the framework back into the framework-free file.
   *
   * `query` belongs here rather than in a validation hook, and the distinction
   * is the one `history.routes.ts` spells out: this app's query schemas refuse
   * nothing. They exist because Elysia derives a route's documented parameters
   * from the route plus this schema and **replaces** anything hand-written in
   * `detail`, so a query string described only in prose is a document that
   * omits half the contract. The parsing that gives a query meaning is in the
   * handler, where a binder cannot skip it.
   */
  documentation?: { detail?: unknown; query?: unknown };
}

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
      params[segment.slice(1)] = decodeURIComponent(given);
    } else if (segment !== given) {
      return null;
    }
  }
  return params;
}
