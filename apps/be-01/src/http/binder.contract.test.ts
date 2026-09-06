import { describe, expect, it } from 'bun:test';

import type { AuthenticatedUser, AuthService } from '../service/auth.service';
import { callerGuard } from './caller';
import { bindElysia } from './elysia/bind';
import { bindInProcess } from './in-process/bind';
import { noContent, ok, respond, type Route, text } from './route';

/**
 * The proof obligation for Task 1 of the be-01 hexagonal refactor: one set of
 * assertions, run against **two** binders over the same route list — Elysia,
 * and a binder that uses no HTTP framework at all.
 *
 * A route module that had quietly kept a framework dependency — reading a
 * context field Elysia happens to provide, relying on Elysia's body parsing to
 * coerce something, answering through a mechanism only a plugin supplies —
 * passes under `bindElysia` and fails here. That is the whole reason the second
 * binder exists; it is a test fixture with a `Response` in it, not a server.
 *
 * What this suite does **not** claim: that the two binders agree on everything.
 * They deliberately differ where the framework owns the answer — Elysia's own
 * 404 body, its malformed-JSON refusal, plugin-level headers, and the body of a
 * refusal produced by a `documentation.querySchema` schema. Every clause below is a
 * property a *route module* is entitled to rely on, which is exactly the set a
 * second HTTP framework would have to reproduce.
 */

type Binder = (routes: readonly Route[]) => { handle: (request: Request) => Promise<Response> };

const BINDERS: readonly [name: string, bind: Binder][] = [
  ['elysia', (routes) => bindElysia(routes)],
  ['in-process', (routes) => bindInProcess(routes)],
];

const ALICE: AuthenticatedUser = {
  id: 'user-1',
  username: 'alice',
  scopes: ['read', 'write'],
};

const NO_SCOPES: AuthenticatedUser = { id: 'user-2', username: 'bob', scopes: [] };

/**
 * The store behind `/probe/find/:slug`. One key is ordinary; the other is the
 * three characters `%ZZ`, which is a legal solution slug and not legal percent
 * encoding — the pair TASK-270 item 2 measured the two binders apart on.
 */
const FINDABLE: ReadonlySet<string> = new Set(['ok', '%ZZ']);

/**
 * The smallest thing that satisfies the guard's one call. A real `AuthService`
 * would drag a database in and prove nothing extra: what is under test is the
 * route layer's behaviour given an answer, not how the answer is reached.
 */
function stubAuth(byToken: Record<string, AuthenticatedUser>): AuthService {
  return {
    authenticate: (token: string | null) =>
      Promise.resolve(token === null ? null : (byToken[token] ?? null)),
  } as unknown as AuthService;
}

function routes(auth: AuthService, writes: string[] = []): Route[] {
  const guard = callerGuard(auth);
  return [
    { method: 'GET', path: '/probe/plain', handler: () => Promise.resolve(ok({ hello: 'world' })) },
    {
      method: 'GET',
      path: '/probe/echo/:id',
      handler: ({ params, query }) =>
        Promise.resolve(ok({ id: params['id'], mode: query['mode'] ?? null })),
    },
    {
      method: 'POST',
      path: '/probe/body',
      handler: ({ body }) => Promise.resolve(ok({ received: body })),
    },
    /**
     * `GET /plans/by-solution/:slug` in miniature: an exact lookup keyed by
     * a path parameter, over a store that holds one ordinary key and one whose
     * name is a percent sequence no decoder accepts. The echo route above shows
     * what each binder *puts* in `params`; this one shows what that value can
     * reach, which is the part TASK-270 item 2 was about.
     */
    {
      method: 'GET',
      path: '/probe/find/:slug',
      handler: ({ params }) => Promise.resolve(ok({ found: FINDABLE.has(params['slug']) })),
    },
    /**
     * `POST /api/projects` in miniature: the same `typeof name !== 'string'`
     * refusal, and a recorder standing in for `ProjectService.create`.
     *
     * The recorder is the point. A content-type clause that asserts only the
     * status cannot tell a refusal apart from a write that happened and then
     * answered the same number, and it is the *call* that TASK-270 item 4 was
     * about: on `application/merge-patch+json` one binder created a project and
     * the other did not. Their statuses differed too, so a status clause would
     * have caught that particular pair — but only the recorder says which of
     * the two answers had already written.
     */
    {
      method: 'POST',
      path: '/probe/write',
      handler: ({ body }) => {
        const name = (body as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string')
          return Promise.resolve(respond(422, { error: 'invalid_body' }));
        writes.push(name);
        return Promise.resolve(ok({ created: name }));
      },
    },
    /**
     * `PATCH /api/projects/:id` in miniature, and the one refusal `/probe/write`
     * cannot express: `patchFrom` takes **any** field bag, so an *empty* object
     * is a legal patch that reaches `projects.update` while `undefined` is a 422
     * before it (`../controller/project.routes.ts`). A route that refuses both
     * cannot see a binder that turned "no body" into `{}`, which is what reading
     * `content-type` on a bodyless request did.
     */
    {
      method: 'PATCH',
      path: '/probe/patch-write',
      handler: ({ body }) => {
        if (typeof body !== 'object' || body === null)
          return Promise.resolve(respond(422, { error: 'invalid_body' }));
        writes.push('patched');
        return Promise.resolve(ok({ patched: true }));
      },
    },
    /**
     * `/probe/write`'s verb twin. A DELETE route that records, because the
     * mutation Elysia refuses before a handler and this binder used to run is a
     * DELETE: `decodeBody` treated every DELETE as bodyless while Elysia's own
     * condition excludes only GET and HEAD.
     */
    {
      method: 'DELETE',
      path: '/probe/delete-write',
      handler: () => {
        writes.push('deleted');
        return Promise.resolve(noContent());
      },
    },
    {
      method: 'DELETE',
      path: '/probe/gone/:id',
      handler: () => Promise.resolve(noContent()),
    },
    {
      method: 'GET',
      path: '/probe/refuse',
      handler: () => Promise.resolve(respond(409, { error: 'conflict' })),
    },
    {
      method: 'GET',
      path: '/probe/headers',
      handler: () =>
        Promise.resolve({ status: 200, body: { ok: true }, headers: { 'x-probe': 'set' } }),
    },
    {
      method: 'GET',
      path: '/probe/cookies',
      handler: () =>
        Promise.resolve({
          status: 302,
          body: null,
          headers: { location: '/' },
          cookies: [
            '__Host-probe_a=1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
            '__Host-probe_b=2; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
            '__Host-probe_c=3; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
          ],
        }),
    },
    {
      method: 'GET',
      path: '/probe/markdown',
      handler: () =>
        Promise.resolve(text(200, '# Title\n\n| a | b |\n', 'text/markdown; charset=utf-8')),
    },
    /**
     * The compare route's shape, reduced to what makes it interesting: the one
     * `documentation.querySchema` schema in this app that *refuses*, plus the
     * handler's own check of the same two parameters. The real schema is
     * imported rather than restated so this clause measures what the app ships.
     */
    {
      method: 'GET',
      path: '/probe/sides',
      handler: ({ query }) =>
        Promise.resolve(
          query['left'] && query['right']
            ? ok({ left: query['left'], right: query['right'] })
            : respond(422, { error: 'invalid_query' }),
        ),
      documentation: { querySchema: 'compare' },
    },
    /**
     * `/probe/sides` with the guard the real compare route actually carries.
     *
     * The unguarded probe above cannot see the property below it, and that is a
     * structural blind spot rather than a missing case: a `documentation.querySchema`
     * schema and an authentication guard are two refusals racing each other, and
     * a fixture with only one of them has no race to observe. Sol's review found
     * the real route's ordering because it read the route module; this fixture
     * exists so the suite finds it next time.
     */
    {
      method: 'GET',
      path: '/probe/guarded-sides',
      handler: guard('signed-in', ({ query }, user) =>
        Promise.resolve(
          query['left'] && query['right']
            ? ok({ id: user.id })
            : respond(422, { error: 'invalid_query' }),
        ),
      ),
      preflight: guard.preflight('signed-in'),
      documentation: { querySchema: 'compare' },
    },
    /**
     * `url` as the OIDC callback reads it: the query string *as sent*, which is
     * the only place a repeated key survives — `query` keeps one value per name
     * under both binders.
     */
    {
      method: 'GET',
      path: '/probe/raw-query',
      handler: (req) =>
        Promise.resolve(
          ok({
            all: new URL(req.url).searchParams.getAll('mode'),
            collapsed: req.query['mode'] ?? null,
          }),
        ),
    },
    /**
     * The two verbs a handler can see, reported through **headers** rather than
     * a body: the case that matters is a HEAD, and a HEAD has no body to read.
     */
    {
      method: 'GET',
      path: '/probe/verbs',
      handler: ({ method, receivedMethod }) =>
        Promise.resolve({
          status: 200,
          body: { method, receivedMethod },
          headers: { 'x-route-method': method, 'x-received-method': receivedMethod },
        }),
    },
    {
      method: 'GET',
      path: '/probe/guarded',
      handler: guard('signed-in', (_req, user) => Promise.resolve(ok({ id: user.id }))),
    },
    {
      method: 'GET',
      path: '/probe/scoped',
      handler: guard('read-scope', (_req, user) => Promise.resolve(ok({ id: user.id }))),
    },
  ];
}

describe.each(BINDERS)('route contract under the %s binder', (_name, bind) => {
  const auth = stubAuth({ 'alice-token': ALICE, 'scopeless-token': NO_SCOPES });
  const writes: string[] = [];
  const app = bind(routes(auth, writes));
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://localhost${path}`, { headers }));

  it('answers a plain route with its body and a 200', async () => {
    const res = await get('/probe/plain');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('gives the handler its path parameters and query', async () => {
    const res = await get('/probe/echo/abc-123?mode=full');
    expect(await res.json()).toEqual({ id: 'abc-123', mode: 'full' });
  });

  it('reports an absent query parameter as absent rather than as the string undefined', async () => {
    const res = await get('/probe/echo/abc-123');
    expect(await res.json()).toEqual({ id: 'abc-123', mode: null });
  });

  it('decodes a JSON body before the handler runs', async () => {
    const res = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Strip out' }),
      }),
    );
    expect(await res.json()).toEqual({ received: { name: 'Strip out' } });
  });

  /**
   * TASK-270 item 4, and the clause asserts the **service call** rather than
   * only the status, because the call is the difference that matters and the
   * status is the one a reader stops at.
   *
   * `decodeBody` dispatched on `contentType.includes('json')` until this chunk,
   * so every media type carrying the substring reached the JSON parser. The
   * statuses did not match — that is the point of asserting the call as well:
   * the two answers below differ in status *and* in whether a project was
   * created, and only one of those is visible to a clause that reads
   * `res.status`. Measured on h2puni at `39e53dda`, `POST /api/projects` with
   * `application/merge-patch+json` and `{"name":"Sand"}`:
   *
   * ```
   * content-type                   elysia                in-process
   * application/merge-patch+json   422, no service call  200, create("Sand")
   * application/not-json           422, no service call  200, create("Sand")
   * ```
   *
   * **What the framework actually dispatches on is one character**, and the
   * first draft of this clause got it wrong by reading the tidy five-name
   * `switch` at `elysia/dist/compose.mjs:500` — which is the path taken only
   * when a route registers a `parse` hook. No route in this app does, so a
   * request that reaches the parser at all takes the fast path at `:435-444`: a
   * `switch` on `contentType.charCodeAt(12)` alone, with a `default` that reads
   * character 0 and treats anything starting `t` as text. No `;` truncation, no
   * lower-casing. **Reaching it is two conditions:** `hasBody` excludes GET and
   * HEAD (`:257-258`) and the header is read only `if(c.request.body)`
   * (`:421-426`), so a POST carrying a body media type and no body never
   * dispatches — the clause below the write ones pins that.
   *
   * Which makes the accepted set stranger than any list of media types:
   * `application/json-patch+json` is **admitted** — character 12 is `j` — while
   * `application/merge-patch+json` is refused, on `m`. That pair is in the
   * clauses below deliberately: it is the one that would go unnoticed, and it is
   * the reason this is a reproduction rather than a tidy-up.
   */
  it.each([['application/merge-patch+json'], ['application/not-json'], ['APPLICATION/JSON']])(
    'reaches no service on a %s body, under either binder',
    async (contentType) => {
      writes.length = 0;
      const res = await app.handle(
        new Request('http://localhost/probe/write', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: JSON.stringify({ name: 'Sand' }),
        }),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
      expect(writes).toEqual([]);
    },
  );

  /**
   * The control the clause above needs: the media types that *are* accepted
   * still reach the service, so "no service call" is a property of the refused
   * set rather than of a route that stopped working. `; charset=utf-8` is here
   * because the fast path never truncates the header — it does not have to,
   * since it only ever reads character 12 — and `json-patch+json` because it is
   * the accepted one nobody would predict.
   */
  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['application/json-patch+json'],
  ])('reaches the service on a %s body, under either binder', async (contentType) => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/write', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: JSON.stringify({ name: 'Sand' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual(['Sand']);
  });

  /**
   * The `x` arm, and the counterexample that caught this chunk's first draft.
   *
   * `application/xml` has `x` at index 12, so the framework reads its body with
   * `parseQuery` and the route is served. Folding `x` and `r` into one
   * `formData()` call made this a 400 here — `Request.formData()` throws on that
   * media type — which is refusing what production serves, the same defect as
   * admitting what it refuses. Nothing in the app *sends* `application/xml`;
   * this is the shape of the dispatch being pinned, not a supported media type.
   */
  it('serves an x-dispatched body the framework parses, under either binder', async () => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/write', {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: 'name=Sand',
      }),
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual(['Sand']);
  });

  /**
   * The DELETE half of the same property, and the one with a real mutation
   * behind it: `DELETE /api/saved-plans/:id` calls `plans.delete` and
   * publishes.
   *
   * Elysia parses a DELETE body — its condition excludes only GET and HEAD — so
   * a malformed JSON body answers 400 from the parser, before the handler.
   * `decodeBody` treated every DELETE as bodyless, so the same request ran the
   * handler here and deleted. The refusal *bodies* differ and always have
   * (Elysia's parse error is its own); what both binders owe is the status and
   * the absence of the call.
   */
  it('refuses a malformed DELETE body before the handler, under either binder', async () => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/delete-write', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(res.status).toBe(400);
    expect(writes).toEqual([]);
  });

  /**
   * The control for the clause above: a DELETE that carries no body at all is
   * still served, so "read the body" did not become "require one".
   */
  it('still answers a bodiless DELETE, under either binder', async () => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/delete-write', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
    expect(writes).toEqual(['deleted']);
  });

  /**
   * Elysia's *other* precondition, and the one this chunk's first pass at
   * "reproduce the dispatch" left out: the header is read only
   * `if(c.request.body)` (`elysia/dist/compose.mjs:421-426`), so a body media
   * type on a request carrying no body is not a parse instruction.
   *
   * `application/xml` makes it visible because its `x` arm reads text: an empty
   * read through `URLSearchParams` is `{}`, not `undefined`, and an empty
   * object is a legal patch. The recorder is what separates the two — both
   * answers would otherwise be a status a reader could accept — and it is a real
   * `PATCH /api/projects/:id`, which under Elysia is a 422 with no call and
   * under a binder without this guard called `projects.update` with an empty
   * patch.
   */
  it('does not parse a body media type on a request with no body, under either binder', async () => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/patch-write', {
        method: 'PATCH',
        headers: { 'content-type': 'application/xml' },
      }),
    );
    expect(res.status).toBe(422);
    expect(writes).toEqual([]);
  });

  /**
   * The control the clause above needs: the same route with a real body still
   * patches, so "ignore a bodyless request" did not become "ignore the body".
   */
  it('still reads an x-dispatched body that is actually there, under either binder', async () => {
    writes.length = 0;
    const res = await app.handle(
      new Request('http://localhost/probe/patch-write', {
        method: 'PATCH',
        headers: { 'content-type': 'application/xml' },
        body: 'name=Sand',
      }),
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual(['patched']);
  });

  /**
   * A route module's body is the fields, not the encoding they arrived in —
   * and this app already accepts both forms in production, because Elysia
   * derived them from the TypeBox schemas the controllers used to declare.
   *
   * Measured before this clause was written: Elysia answered
   * `{"name":"Sand"}` for both media types and the in-process binder dropped
   * the body, so the request that creates a project under one binder was a 422
   * `invalid_body` under the other. Keeping the acceptance and asserting it
   * here is the behaviour-preserving direction — narrowing what the API takes
   * is a real change and belongs to whoever wants it. See `decodeBody`.
   *
   * A JSON body sent with no content type is deliberately **not** here: both
   * binders drop that one, so it is agreement rather than contract.
   */
  it.each([
    ['x-www-form-urlencoded', () => 'name=Sand', 'application/x-www-form-urlencoded'],
    [
      'multipart/form-data',
      () => {
        const form = new FormData();
        form.append('name', 'Sand');
        return form;
      },
      undefined,
    ],
  ])('reads a %s body as the fields it carries', async (_label, makeBody, contentType) => {
    const res = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
        body: makeBody(),
      }),
    );
    expect(await res.json()).toEqual({ received: { name: 'Sand' } });
  });

  /**
   * Sol's Important 2, and the probe moved the finding: it reported repeated
   * **query** keys and repeated **form** fields as one divergence and cited
   * `parse-query.mjs:129-130` for both. That function is real and that line
   * does array — but it is allocated as the **body** parser
   * (`compose.mjs:978`, `allocateIf('parseQuery,', hasBody)`). The query is
   * built by its sibling `parseQueryFromURL`, whose arraying branch is gated
   * on a per-key map the composer derives from `ArrayQuery` schema metadata
   * (`compose.mjs:320-328`); no route in this app declares an array-typed
   * query parameter, so the map is never passed and the last `else` — a plain
   * `result[key] = value` — is what runs. The clause below the form ones pins
   * that, so the agreement is measured rather than assumed the next time
   * somebody reads the same line.
   *
   * Measured on h2puni at `cf2c0307`, elysia 1.4.28, before the fix:
   *
   * ```
   * request                        elysia              in-process
   * ?tag=a&tag=b                   {"tag":"b"}         {"tag":"b"}
   * urlencoded  t=a&t=b&t=c        {"t":["a","b","c"]} {"t":"c"}
   * multipart   t=a, t=b           {"t":["a","b"]}     {"t":"b"}
   * ```
   *
   * Elysia wins the disagreement for the same reason it won the 405 and the
   * two form media types: the shipped app runs on Elysia, so its answer is the
   * behaviour a refactor claiming to change nothing has to keep.
   */
  it.each([
    ['x-www-form-urlencoded', () => 'tag=a&tag=b', 'application/x-www-form-urlencoded'],
    [
      'multipart/form-data',
      () => {
        const form = new FormData();
        form.append('tag', 'a');
        form.append('tag', 'b');
        return form;
      },
      undefined,
    ],
  ])('carries every value of a repeated %s field', async (_label, makeBody, contentType) => {
    const res = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
        body: makeBody(),
      }),
    );
    expect(await res.json()).toEqual({ received: { tag: ['a', 'b'] } });
  });

  /**
   * The control the clause above needs: a field given once stays the string a
   * handler compares against, rather than becoming a one-element array. Every
   * `typeof value !== 'string'` refusal in the controllers reads this.
   */
  it('leaves a form field given once as a bare value', async () => {
    const res = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'tag=a&name=Sand',
      }),
    );
    expect(await res.json()).toEqual({ received: { tag: 'a', name: 'Sand' } });
  });

  /**
   * TASK-270 item 1, and the row of its measured table that crossed the
   * service-call boundary rather than merely differing in shape.
   *
   * A multipart field whose single value opens with `{` or `[` is an **object**
   * by the time a handler sees it (`adapter/web-standard/index.mjs:52-64`), and
   * every `typeof value !== 'string'` refusal in the controllers reads that:
   * `POST /api/projects` with multipart `name={"a":1}` is a 422 with no service
   * call under Elysia, and was a 200 that called `projects.create` under a
   * binder that kept the bytes. That is the same defect class as item 4's, one
   * media type further in.
   *
   * The shape clause is here and the **call** clause is below it, on the
   * recorder, because those are two different claims and only the second one is
   * the defect.
   */
  it('parses a multipart field whose whole value is JSON into an object', async () => {
    const form = new FormData();
    form.append('tag', '{"a":1}');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { tag: { a: 1 } } });
  });

  /**
   * The clause above, taken to the boundary it is actually about: `/probe/write`
   * refuses a non-string `name` without recording, so a multipart `name` that is
   * an object is a 422 with an empty recorder, and the binder that kept the
   * bytes answered 200 and appended. The measured row said `projects.create`;
   * this is that row with a recorder standing in for the service.
   */
  it('refuses a multipart name that arrives as an object, without writing', async () => {
    writes.length = 0;
    const form = new FormData();
    form.append('name', '{"a":1}');
    const res = await app.handle(
      new Request('http://localhost/probe/write', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(422);
    expect(writes).toEqual([]);
  });

  /**
   * The control for both: the same route, the same media type, a `name` that is
   * a plain string — which still reaches the recorder, so "coerce JSON-looking
   * values" did not become "refuse multipart".
   */
  it('still writes a plain multipart name, under either binder', async () => {
    writes.length = 0;
    const form = new FormData();
    form.append('name', 'Sand');
    const res = await app.handle(
      new Request('http://localhost/probe/write', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(200);
    expect(writes).toEqual(['Sand']);
  });

  /**
   * The other opener. `charCodeAt(0) === 91` is in the framework's condition
   * beside `123` (`adapter/web-standard/index.mjs:57-58`), and a JSON array is
   * an object to `typeof`, so it survives the acceptance test — which makes a
   * lone `[1,2]` field an **array** in front of a handler, not a string.
   */
  it('parses a multipart field whose whole value is a JSON array', async () => {
    const form = new FormData();
    form.append('tag', '[1,2]');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { tag: [1, 2] } });
  });

  /**
   * The control the clause above needs, and the reason its coercion is a `try`
   * rather than a shape check (`adapter/web-standard/index.mjs:56-63`): a value
   * that opens with `{` and does not parse keeps its bytes and reaches the
   * handler, so a half-typed body is still the handler's 422 to give rather
   * than a parser's 400.
   */
  it('leaves a multipart value that opens with a brace but is not JSON as its bytes', async () => {
    const form = new FormData();
    form.append('tag', '{oops');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { tag: '{oops' } });
  });

  /**
   * A multipart key is a **path** when it carries a `.` or a `[`
   * (`adapter/web-standard/index.mjs:76-96`): `user.name` names a field inside
   * an object, not a flat field spelled with a dot. A route module reading
   * `body['user.name']` finds nothing under either binder, which is the whole
   * point of pinning it — the flat spelling is what an in-process binder
   * without this rule handed over.
   */
  it('builds a nested object from a multipart dotted key', async () => {
    const form = new FormData();
    form.append('user.name', 'Sand');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { user: { name: 'Sand' } } });
  });

  /**
   * The bracketed half of the same rule: `t[0]` and `t[1]` are indices into one
   * array, not two fields (`adapter/web-standard/index.mjs:76-96`). Note this
   * is a *different* array from the repeated-key one two clauses up — that one
   * is a key sent twice, this one is a key sent once per index — and both
   * binders have to reach the same shape down both routes.
   */
  it('builds an array from multipart bracketed keys', async () => {
    const form = new FormData();
    form.append('t[0]', 'a');
    form.append('t[1]', 'b');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { t: ['a', 'b'] } });
  });

  /**
   * The third rule, and the one with no visible parser in it: the multipart
   * body is accumulated onto a normally-parented object, so a field named
   * `__proto__` is skipped by the loop's own `if(c.body[key])` guard before it
   * is assigned (`adapter/web-standard/index.mjs:49`). The field is simply
   * not there, while its neighbour is — measured on h2puni as
   * `{"ok":"y"}` under Elysia against `{"__proto__":"x","ok":"y"}` under a
   * binder folding with `Object.fromEntries` onto a fresh object.
   *
   * `ok` is in the body to keep this a clause about one field disappearing
   * rather than about the request being refused.
   */
  it('drops a multipart field named __proto__ and keeps its neighbour', async () => {
    const form = new FormData();
    form.append('__proto__', 'x');
    form.append('ok', 'y');
    const res = await app.handle(
      new Request('http://localhost/probe/body', { method: 'POST', body: form }),
    );
    expect(await res.json()).toEqual({ received: { ok: 'y' } });
  });

  /**
   * The control that keeps the two form arms honest: none of the four rules
   * above is a *form* rule, they are all `multipart` rules. The same bytes sent
   * as `application/x-www-form-urlencoded` go through `parseQuery`, which has
   * no JSON coercion, no key paths and no prototype-shaped guard
   * (`parse-query.mjs:94-130`), so the value stays the string a handler
   * compares. Folding the two arms into one implementation is the exact mistake
   * item 4 made in the other direction, and this clause fails if it is made
   * again.
   */
  it('leaves a urlencoded value that looks like JSON as its string', async () => {
    const res = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'tag={"a":1}',
      }),
    );
    expect(await res.json()).toEqual({ received: { tag: '{"a":1}' } });
  });

  /** The query half of the same finding, which measured as agreement. */
  it('answers a repeated query key with its last value', async () => {
    const res = await get('/probe/echo/7?mode=first&mode=last');
    expect(await res.json()).toEqual({ id: '7', mode: 'last' });
  });

  /**
   * The clause the OIDC callback's duplicate refusal rests on (TASK-269): a
   * route that has to know whether a key repeated cannot learn it from `query`,
   * and `url` is the same raw string under both binders. Asserted rather than
   * assumed, because `query` collapsing to the **last** value and
   * `searchParams.get` answering the **first** is exactly the pair that changed
   * which `state` the callback read when it moved onto the route shape.
   */
  it('keeps every value of a repeated key in the raw url, whatever query collapsed to', async () => {
    const res = await get('/probe/raw-query?mode=first&mode=last');
    expect(await res.json()).toEqual({ all: ['first', 'last'], collapsed: 'last' });
  });

  /**
   * Sol's Important 4. A path whose only declared route is a GET answers HEAD
   * from that GET under Elysia and answered 404 here, which made a HEAD probe
   * — the cheapest liveness check a client has — disagree with the API it was
   * probing. Measured on h2puni at `806f8580`, elysia 1.4.28:
   *
   * ```
   * HEAD /probe/plain      elysia 200 cl=17 body=""   in-process 404
   * HEAD /probe/headers    elysia 200 x-probe=set     in-process 404
   * HEAD /probe/only-post  elysia 404                 in-process 404   agree
   * HEAD /probe/nope       elysia 404                 in-process 404   agree
   * OPTIONS /probe/plain   elysia 404                 in-process 404   agree
   * ```
   *
   * The last row is what bounds the fix: this is HEAD reaching GET, **not** a
   * general fallback from any verb to any other, so a HEAD with no GET beneath
   * it stays the 404 both binders already agreed on.
   */
  it('answers HEAD on a path declaring only a GET, with the GET’s status and headers', async () => {
    const res = await app.handle(new Request('http://localhost/probe/headers', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-probe')).toBe('set');
    expect(await res.text()).toBe('');
  });

  /**
   * The body is absent but its length is not: a client sizing a download off a
   * HEAD gets the number the GET would have sent. `{"hello":"world"}` is 17
   * bytes and Elysia answers exactly that.
   */
  it('gives a HEAD answer the content-length of the body it withheld', async () => {
    const res = await app.handle(new Request('http://localhost/probe/plain', { method: 'HEAD' }));
    expect(res.headers.get('content-length')).toBe('17');
    expect(await res.text()).toBe('');
  });

  /** The bound: HEAD is not a licence to reach any other verb. */
  it('does not answer HEAD on a path whose only route takes a body verb', async () => {
    const res = await app.handle(new Request('http://localhost/probe/body', { method: 'HEAD' }));
    expect(res.status).toBe(404);
  });

  /**
   * TASK-269. HEAD resolving to a path's GET is the shared contract above, and
   * it left a handler unable to tell the two apart: both binders passed the
   * verb the route was registered under and nothing carried the one that
   * actually arrived. The OIDC
   * callback had read the raw `request.method` before the framework-free route
   * shape, so a HEAD reached the provider as HEAD and afterwards as GET.
   *
   * The route's verb and the arrived verb are now two fields, and the clause
   * both binders owe is that they agree on both — a binder setting only one
   * would let a route module read a verb under Elysia it can read nowhere else.
   */
  it('tells a handler both the route’s verb and the one the request arrived with', async () => {
    const res = await get('/probe/verbs');
    expect(await res.json()).toEqual({ method: 'GET', receivedMethod: 'GET' });
  });

  it('reports a HEAD answered by a GET route as GET on the route and HEAD as received', async () => {
    const res = await app.handle(new Request('http://localhost/probe/verbs', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-route-method')).toBe('GET');
    expect(res.headers.get('x-received-method')).toBe('HEAD');
  });

  it('answers a 204 with no body at all', async () => {
    const res = await app.handle(
      new Request('http://localhost/probe/gone/7', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('carries a refusal status set by the handler', async () => {
    const res = await get('/probe/refuse');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict' });
  });

  it('carries response headers a handler asked for', async () => {
    const res = await get('/probe/headers');
    expect(res.headers.get('x-probe')).toBe('set');
  });

  /**
   * The clause the auth routes need, and the one a `Record<string, string>` of
   * headers cannot express: three cookies on one answer, each on its own line.
   *
   * `Set-Cookie` has no comma-joined form — RFC 6265 §3 — so a binder that
   * folded these would hand a client one malformed cookie where the route wrote
   * three, and the failure would be a session that silently does not exist
   * rather than an error anybody sees. The OIDC callback sets exactly this
   * shape: clear the transaction cookie, set the access cookie, set the session
   * cookie, and redirect. Asserting the count *and* the values is deliberate —
   * a fold produces one entry holding all three, so a count alone could be met
   * by three empty lines and the values alone by a single folded one.
   */
  it('puts every cookie on its own line, beside the headers and status of the same answer', async () => {
    const res = await get('/probe/cookies');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()).toEqual([
      '__Host-probe_a=1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      '__Host-probe_b=2; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
      '__Host-probe_c=3; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300',
    ]);
    expect(await res.text()).toBe('');
  });

  it('writes a non-JSON body unchanged, under the content type the route named', async () => {
    // The clause the export route needs, and the one Elysia would have hidden:
    // it returns a string return value as-is, so a route answering Markdown
    // works through `bindElysia` while every other binder hands back a
    // JSON-quoted, backslash-escaped document. Asserting the exact bytes here
    // is what makes `RouteResponse.serialised` a contract rather than a field.
    const res = await get('/probe/markdown');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toBe('# Title\n\n| a | b |\n');
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const res = await get('/probe/guarded');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('hands the resolved account to a guarded handler', async () => {
    const res = await get('/probe/guarded', { authorization: 'Bearer alice-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'user-1' });
  });

  it('reads the session cookie as well as the bearer header', async () => {
    const res = await get('/probe/guarded', { cookie: '__Host-wbs_access=alice-token' });
    expect(await res.json()).toEqual({ id: 'user-1' });
  });

  it('refuses a token without the read scope with 403 on a read-scope route', async () => {
    const res = await get('/probe/scoped', { authorization: 'Bearer scopeless-token' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope' });
  });

  it('admits a token carrying the read scope', async () => {
    const res = await get('/probe/scoped', { authorization: 'Bearer alice-token' });
    expect(res.status).toBe(200);
  });

  it('does not answer a path no route declares', async () => {
    const res = await get('/probe/nothing-here');
    expect(res.status).toBe(404);
  });

  /**
   * The trailing slash, which the two binders disagreed about until the clause
   * below was written.
   *
   * Probed rather than reasoned about: `SLASHPROBE elysia bare=200 slash=200`,
   * `SLASHPROBE in-process bare=200 slash=404`. Elysia normalises and
   * `matchPath` compared segment counts, so `/probe/plain/` was a hit under one
   * binder and a miss under the other — on **every** route migrated onto the
   * route shape, not on a route this branch introduced. `matchPath` normalises
   * now, and this is the clause that keeps both honest: it fails under either
   * binder that changes its mind.
   */
  it('answers a path with one trailing slash exactly as the bare spelling', async () => {
    const bare = await get('/probe/plain');
    const slashed = await get('/probe/plain/');
    expect(slashed.status).toBe(bare.status);
    expect(await slashed.json()).toEqual({ hello: 'world' });
  });

  /**
   * And the two things normalising a trailing slash must not also do: swallow an
   * empty path segment, or turn the root into the empty string.
   */
  it('still refuses a doubled slash where a parameter belongs', async () => {
    const res = await get('/probe/echo//');
    expect(res.status).toBe(404);
  });

  /**
   * Malformed percent encoding in a parameter segment, which the peer terminal
   * review found by reading and this clause settled by measuring.
   *
   * `decodeURIComponent` throws `URIError`, and `matchPath` is called outside
   * `bindInProcess`'s `try`, so `/probe/echo/%ZZ` **rejected the promise out of
   * `handle()`** — not a refusal, no answer at all. Elysia decodes with
   * `fast-decode-uri-component`, which returns `null` instead of throwing.
   *
   * Probed rather than reasoned about, and the reading decided the fix:
   * `elysia 200 {"id":null,"mode":null}`, `in-process URIError`. Elysia
   * **matches the route** and runs the handler, so making the in-process binder
   * 404 would have been a second divergence dressed as a fix.
   *
   * The first fix handed the segment over **raw** and asserted only the status,
   * on the argument that `'%ZZ'` and `null` both reach a repository lookup that
   * answers `not_found`. TASK-270 item 2 measured that argument false — see the
   * clause below — so the value is asserted too, and the two binders agree on it.
   *
   * The table is the whole probe, not one row of it, and that is the point of
   * its shape: a decoder special-casing `%ZZ` would satisfy a single malformed
   * case and still disagree with Elysia everywhere else, so the five undecodable
   * rows pin the failure and the four decodable ones pin that failing is not the
   * answer to everything. Measured on h2puni at `53d78020` before the fix: both
   * binders already produced the decoded value for `%20`, `a%2Fb`,
   * `%F0%9F%98%80` and a plain segment, and only the five malformed rows
   * differed. So `decodeURIComponent` throwing and Elysia's
   * `fast-decode-uri-component` returning `null` are the same accept set here.
   */
  it.each([
    ['a bare percent', '%', null],
    ['a stray pair of them', '%%', null],
    ['a truncated multi-byte sequence', '%E0%A4%A', null],
    ['an overlong encoding', '%C0%80', null],
    ['two characters that are not hex', '%ZZ', null],
    ['an encoded space', '%20', ' '],
    ['an encoded slash', 'a%2Fb', 'a/b'],
    ['an encoded astral character', '%F0%9F%98%80', '😀'],
    ['a segment needing no decoding', 'plain', 'plain'],
  ])('decodes %s the same way under either binder', async (_label, segment, expected) => {
    const res = await get(`/probe/echo/${segment}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: expected, mode: null });
  });

  /**
   * Why the clause above asserts the value, and the case that makes it bite.
   *
   * The raw-passthrough fix left the in-process binder able to reach a stored
   * record the production binder cannot. Elysia hands the handler `null`, which
   * matches no key; the raw `'%ZZ'` matches a record whose key is literally
   * those three characters. Nothing forbids one: a solution slug is any
   * non-empty string (`controller/project.routes.ts`), and
   * `GET /plans/by-solution/:slug` is an exact lookup
   * (`controller/solution.routes.ts`), so the second binder answered 200 with a
   * record where the shipped server answers 404.
   *
   * Measured on h2puni at `53d78020` before the fix, over the same two keys —
   * the probe's handler returned the stored value where this one returns only
   * whether it was found, so the shape below is the probe's and not this
   * fixture's:
   * `FIND elysia "%ZZ" -> 200 {"found":false}` and
   * `FIND in-process "%ZZ" -> 200 {"found":true,...}`. That is the divergence
   * the second binder exists to catch, found in the second binder itself.
   *
   * The clause bites in both directions: it fails if either binder starts
   * reaching the record, and the `'ok'` half fails if a binder stops reaching a
   * record it should — so "never find anything" cannot pass it.
   */
  it.each([
    ['an undecodable segment', '%ZZ', { found: false }],
    ['a decodable one', 'ok', { found: true }],
  ])('looks up %s the same way under either binder', async (_label, slug, expected) => {
    const res = await get(`/probe/find/${slug}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
  });

  /**
   * The second divergence this branch found, and the decision about it: a query
   * schema's refusal agrees on **status** and is not asserted to agree on body.
   *
   * The `compare` query schema declares `left` and `right` required, and only `bindElysia`
   * enforces it — under that binder the framework refuses before the handler
   * runs, under any other the handler's own check does. Both answer 422; the
   * bodies differ, because one is the framework's validation report and the
   * other is `{ error: 'invalid_query' }`. That is the same category as Elysia's
   * 404 body and its malformed-JSON refusal, which this suite already excludes:
   * the *status* is what a route module is entitled to, and it is what a second
   * framework would have to reproduce. Asserting the body here would either
   * pin one binder's private format as the contract or force the schema to stop
   * declaring the two parameters required — and the schema is what keeps them in
   * the published document, so weakening it would make the API description lie.
   * `COMPARE_QUERY` in `elysia/query-schemas.ts` carries the long form of that argument.
   *
   * The clause is still load-bearing in both directions: it fails if either
   * binder stops refusing, and it fails if either one refuses with a different
   * status than the other.
   */
  it('refuses an absent required query parameter with 422 under either binder', async () => {
    const res = await get('/probe/sides?left=only-one');
    expect(res.status).toBe(422);
  });

  it('lets a request satisfying the query schema through to the handler', async () => {
    const res = await get('/probe/sides?left=a&right=b');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: 'a', right: 'b' });
  });

  /**
   * A guarded route refuses a malformed query to a caller who **is** signed in,
   * under either binder. Both genuinely do this, so it is a contract.
   *
   * **This is also the negative control for the clause below it.** The
   * unauthenticated case of this same route used to be a real divergence —
   * Elysia answered **422**, because the query hook its `documentation.querySchema` resolves to validates
   * before the handler runs, and the in-process binder answered **401**, because
   * the route module puts the guard outermost. `Route.preflight` closed that,
   * and the clause asserting it is next.
   *
   * What makes the pair evidence rather than two green tests: this one sends the
   * identical malformed query **with** a valid token and still expects 422, so a
   * preflight that refused everything, or a binder that stopped running the
   * validator at all, fails here instead of passing both.
   *
   * Three patch-sized fixes were measured dead before the preflight seat was
   * found, and they are recorded so they are not retried: `t.Optional` on both
   * properties flips the document's `"required": true` to `false`;
   * `detail.parameters` is replaced wholesale by Elysia; and the emitter has no
   * `parameters` seam. `beforeHandle` runs after validation and cannot carry the
   * check either.
   *
   * The fixture landed ahead of the fix on purpose: `/probe/sides` is unguarded,
   * and an unguarded probe has no race between a schema refusal and a guard,
   * which is structurally why this suite could not see the divergence until a
   * human reviewer read the route module.
   */
  /**
   * A known path reached with the wrong verb is "no such route" under either
   * binder, and the status is asserted rather than the body — Elysia answers its
   * own `NOT_FOUND` string and the in-process binder answers
   * `{ error: 'not_found' }`, which is the excluded framework-owned category this
   * suite already names for Elysia's 404.
   *
   * The in-process binder answered **405** until the Gemini review measured it.
   * Whether a route list treats a wrong verb as a missing route is the route
   * list's property, so both binders owe the same status, and 404 is the one this
   * API ships. `bind.ts`'s note argues the direction.
   */
  it('answers a known path with the wrong verb as 404 under either binder', async () => {
    expect(
      (await app.handle(new Request('http://localhost/probe/plain', { method: 'POST' }))).status,
    ).toBe(404);
    expect((await get('/probe/nope')).status).toBe(404);
  });

  it('refuses a bad query on a guarded route to a signed-in caller', async () => {
    const res = await get('/probe/guarded-sides?left=only-one', {
      authorization: 'Bearer alice-token',
    });
    expect(res.status).toBe(422);
  });

  /**
   * The clause `Route.preflight` exists for, and the one divergence this suite
   * could not see until `/probe/guarded-sides` was added: a guarded route that
   * also carries a `documentation.querySchema` had two orderings, because only a
   * framework-derived validator can get in front of a handler guard. Elysia
   * answered 422 here and the in-process binder answered 401, so an
   * unauthenticated caller learned the shape of the query under one binder and
   * not the other.
   *
   * 401 is the answer both owe. It is what `main` gave, it is what `app.ts`
   * already answers before parsing a body for every write (`app.ts:170-187`),
   * and the alternative — writing the difference down as agreed-to-differ — is
   * the shape chunk 8 rejected for the trailing slash: a contract recording two
   * answers for one route list is a record of a bug.
   *
   * The signed-in clause immediately above is the negative control. It sends
   * the identical malformed query **with** a valid token and still expects 422,
   * so a preflight that refused everything, or a binder that stopped running
   * the validator at all, fails there rather than passing both.
   */
  it('answers 401 before 422 for an unauthenticated caller with a bad query', async () => {
    const res = await get('/probe/guarded-sides?left=only-one');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

/**
 * Not a contract clause, and outside the `describe.each` on purpose: this is a
 * wiring assertion about `bindElysia` alone.
 *
 * Chunk 12 settled the `invalid_query` divergence on status and left the bodies
 * unasserted, which was the right call about the *contract* and left a hole in
 * the *proof*. The Gemini review named it: deleting
 * `documentation: { querySchema: 'compare' }` from `/probe/sides` leaves every
 * clause green, because the handler's own check answers the identical 422.
 * Nothing in the suite fails if `register()` stops passing `hook` to Elysia, so
 * the OpenAPI document — which is generated from those hooks — could quietly
 * lose every query parameter with a green suite behind it. Chunk 12's
 * `minLength: 5` negative does not cover this: it proves the schema is enforced
 * when present and wrong, not that it is handed over **at all**.
 *
 * So assert the one thing only the wired path can produce. The body is Elysia's
 * own validation report, measured in chunk 12; the handler's refusal is
 * `{ error: 'invalid_query' }`. Asserting `type: 'validation'` distinguishes
 * them, and it is a claim about the binder rather than about the route list —
 * which is exactly why it does not belong in the shared suite.
 */
describe('the Elysia binder resolves documentation.querySchema for the framework', () => {
  it('answers a bad query with elysia’s validation report, not the handler’s', async () => {
    const app = bindElysia(routes(stubAuth({})));
    const res = await app.handle(new Request('http://localhost/probe/sides?left=only-one'));

    expect(res.status).toBe(422);
    // `on: 'query'` as well as the type: a body validation report would also say
    // `validation`, and the hook under test is the query one.
    expect(await res.json()).toMatchObject({ type: 'validation', on: 'query' });
  });
});
