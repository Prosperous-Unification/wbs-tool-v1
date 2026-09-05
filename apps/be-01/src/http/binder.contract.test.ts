import { describe, expect, it } from 'bun:test';

import type { AuthenticatedUser, AuthService } from '../service/auth.service';
import { callerGuard } from './caller';
import { bindElysia } from './elysia/bind';
import { COMPARE_QUERY } from './elysia/query-schemas';
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
 * refusal produced by a `documentation.query` schema. Every clause below is a
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

function routes(auth: AuthService): Route[] {
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
     * `documentation.query` schema in this app that *refuses*, plus the
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
      documentation: { query: COMPARE_QUERY },
    },
    /**
     * `/probe/sides` with the guard the real compare route actually carries.
     *
     * The unguarded probe above cannot see the property below it, and that is a
     * structural blind spot rather than a missing case: a `documentation.query`
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
      documentation: { query: COMPARE_QUERY },
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
  const app = bind(routes(auth));
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
   * The second divergence this branch found, and the decision about it: a query
   * schema's refusal agrees on **status** and is not asserted to agree on body.
   *
   * `COMPARE_QUERY` declares `left` and `right` required, and only `bindElysia`
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
   * {@link COMPARE_QUERY} carries the long form of that argument.
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
   * **What is deliberately not asserted here, and why.** The unauthenticated
   * case of the same route is a real divergence — Elysia answers **422** because
   * its `documentation.query` hook validates before the handler runs, and the
   * in-process binder answers **401** because the route module puts the guard
   * outermost. Measured at this head against the fixture above. It is not
   * written as a clause because chunk 8 settled that a contract recording two
   * different answers is a record of a bug rather than a contract, and it is not
   * written as a passing clause because no honest fix fits in a patch: making
   * the two properties `t.Optional` so only the handler refuses was **measured**
   * to flip the document's `"required": true` to `false` on both parameters, and
   * `detail.parameters` was measured in chunk 12 to be replaced wholesale. The
   * fix is route-level auth metadata both binders honour before validation —
   * Elysia's `onRequest` runs ahead of its validator, `beforeHandle` does not.
   * The task log carries the sizing.
   *
   * The fixture is landed ahead of that fix on purpose: `/probe/sides` is
   * unguarded, and an unguarded probe has no race between a schema refusal and a
   * guard, which is structurally why this suite could not see the divergence
   * until a human reviewer read the route module.
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
   * also carries a `documentation.query` had two orderings, because only a
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
 * `documentation: { query: COMPARE_QUERY }` from `/probe/sides` leaves every
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
describe('the elysia binder hands documentation.query to the framework', () => {
  it('answers a bad query with elysia’s validation report, not the handler’s', async () => {
    const app = bindElysia(routes(stubAuth({})));
    const res = await app.handle(new Request('http://localhost/probe/sides?left=only-one'));

    expect(res.status).toBe(422);
    // `on: 'query'` as well as the type: a body validation report would also say
    // `validation`, and the hook under test is the query one.
    expect(await res.json()).toMatchObject({ type: 'validation', on: 'query' });
  });
});
