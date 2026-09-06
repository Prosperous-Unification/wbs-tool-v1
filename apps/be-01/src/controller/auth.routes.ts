import { randomBytes } from 'node:crypto';

import {
  booleanFlagOf,
  browserBindingCookieName,
  browserBindingsIn,
  browserOidcClientFromEnv,
  classifyOidcFailure,
  consumeBrowserBinding,
  type HeldBrowserBinding,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
  isOidcCallbackRefused,
  MAX_BROWSER_BINDINGS,
  type OidcFailureKind,
  oidcIdentityFromClaims,
  oidcTokenVerifierFromEnv,
  type OidcTransactionStore,
  selectBrowserBindings,
  type TokenStore,
  type TokenVerifier,
} from '@wbs/auth';

import { checkedBody } from '../http/body-doc';
import {
  isFieldBag,
  ok,
  respond,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from '../http/route';
import { cookiesIn, cookieValue, userFromHeaders } from '../middleware/authenticated';
import { type AuthService, TOKEN_TTL_SECONDS } from '../service/auth.service';
import { LoginThrottle } from '../service/login-throttle';

/**
 * The one thing the OIDC callback says out loud, and the reason it is a field
 * rather than an import.
 *
 * This module names no framework, so it cannot reach `buildApp`'s decorated
 * logger and must be handed one; {@link buildApp} passes the app's own so
 * production needs no wiring at the call site, and a test can pass a recorder
 * and assert on it without a pino destination. Three levels and a
 * `(fields, message)` shape, which is the subset of `@wbs/observability`'s
 * `Logger` used here — a full `Logger` is assignable to it, and nothing in this
 * file can reach for a pino method the port does not name.
 *
 * **This exists because a refusal that tells nobody anything is not a fix.**
 * The first version of this change logged nothing at all and recorded that as a
 * decision; both terminal review seats called it, on an authorization server
 * whose sign-on policy can start refusing every login with a code and a reason
 * that reached neither a screen nor a log file (TASK-273 round 1, Important).
 */
export interface AuthRouteLog {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

export interface OidcRouteOptions {
  appOrigin: string;
  client: ReturnType<typeof browserOidcClientFromEnv>;
  groupPrefix: string;
  groupsClaim: string;
  /** Where a refused or failed callback is reported. See {@link AuthRouteLog}. */
  logger?: AuthRouteLog;
  mode: 'oidc';
  now?: () => number;
  passwordLoginEnabled?: boolean;
  passwordRegisterEnabled?: boolean;
  random?: () => string;
  redirectUri: string;
  tokens: TokenStore;
  transactions: OidcTransactionStore;
  verifier: TokenVerifier;
}

export function oidcRouteOptionsFromEnv(env: Record<string, string | undefined>): OidcRouteOptions {
  for (const key of [
    'AUTH_ISSUER_DISCOVERY_URL',
    'AUTH_CLIENT_ID',
    'AUTH_CLIENT_SECRET',
    'AUTH_REDIRECT_URI',
  ]) {
    if (env[key] === undefined || env[key] === '')
      throw new Error(`${key} is required in AUTH_MODE=oidc`);
  }
  const redirectUriValue = env['AUTH_REDIRECT_URI'];
  if (redirectUriValue === undefined)
    throw new Error('AUTH_REDIRECT_URI is required in AUTH_MODE=oidc');
  const redirectUri = new URL(redirectUriValue);
  if (
    redirectUri.pathname !== '/api/auth/okta/callback' ||
    redirectUri.search !== '' ||
    redirectUri.hash !== ''
  ) {
    throw new Error('AUTH_REDIRECT_URI must use the mounted /api/auth/okta/callback route');
  }
  const passwordLoginEnabled = booleanFlagOf(env, 'AUTH_PASSWORD_LOGIN', true);
  const passwordRegisterEnabled = booleanFlagOf(env, 'AUTH_PASSWORD_REGISTER', false);
  if (passwordRegisterEnabled && !passwordLoginEnabled) {
    throw new Error('AUTH_PASSWORD_REGISTER=true requires AUTH_PASSWORD_LOGIN=true');
  }
  return {
    appOrigin: redirectUri.origin,
    client: browserOidcClientFromEnv(env),
    groupPrefix: env['NODE_ENV'] === 'production' ? 'prod' : 'dev',
    groupsClaim: env['AUTH_GROUPS_CLAIM'] ?? 'wbs_groups',
    mode: 'oidc',
    passwordLoginEnabled,
    passwordRegisterEnabled,
    random: () => randomBytes(32).toString('base64url'),
    redirectUri: redirectUri.href,
    tokens: new InMemoryTokenStore(),
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
    verifier: oidcTokenVerifierFromEnv(env),
  };
}

/**
 * The register/login body, checked here rather than declared to a framework.
 *
 * **Types only, still.** Length and character rules stay in `AuthService`,
 * because two places refusing one mistake gives the front end two different
 * failures for it — that was true when Elysia answered 422 for a schema
 * violation and it is true now that this function does.
 *
 * **The status stays 422**, and it is not the only thing a client observes.
 * `credentials()` was `t.Object({ username: t.String(), password: t.String() })`,
 * so a missing or non-string field was a schema failure and Elysia's 422, and
 * answering 400 here would move a refusal the front end already distinguishes
 * from `{error:'invalid'}`. The **body** did change: Elysia's own validation
 * report became `{ error: 'invalid_body' }`, which is why
 * `apps/fe-01/src/components/wbs/wbs-table.tsx` maps that code. Keeping the
 * status is what let that be a one-line mapping rather than a new branch.
 *
 * **Unknown properties are dropped rather than refused**, as everywhere else on
 * this branch: Elysia stripped them before the handler saw the body, so this
 * reads the two keys it knows and passes nothing else on.
 *
 * The schema this replaced was built **per controller** rather than once per
 * module, because Elysia writes `additionalProperties` into the schema object it
 * is handed and a module-level one is shared mutable state across every app in
 * the process — it turned `main` red on 2026-09-03 through nothing but test file
 * ordering. A plain function has no such object, so the hazard is gone rather
 * than worked around; {@link CREDENTIALS_BODY} is inert documentation and is
 * never handed to a validator.
 */
function credentialsFrom(body: unknown): { username: string; password: string } | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return respond(422, { error: 'invalid_body' });
  }
  return { username, password };
}

const isRefusal = (parsed: object): parsed is RouteResponse => 'status' in parsed;

/**
 * The documented body, through {@link checkedBody} and **not**
 * {@link handParsedBody} — whose shared sentence ends "a bad one answers 400",
 * which these two routes do not.
 *
 * This paragraph used to sit above a hand-rolled copy of the note, written out
 * here because avoiding the 400 claim was worth four duplicated lines. The
 * duplicate was the right call and the wrong shape: five *other* migrated bodies
 * reached for `handParsedBody` instead of copying it, and put the false sentence
 * into six published operations. `checkedBody` is this reasoning made reusable,
 * so this route is now the same call as its neighbours rather than the exception
 * that nobody generalised.
 */
const CREDENTIALS_BODY = checkedBody('The account name and password.', {
  type: 'object',
  required: ['username', 'password'],
  properties: { username: { type: 'string' }, password: { type: 'string' } },
});

/**
 * Registration and login return one session shape. OIDC mode keeps its JWT in
 * the HttpOnly cookie and returns an empty token field so page JavaScript never
 * receives the credential; local mode retains the bearer response for tools.
 *
 * `/api` is part of every path, not stripped by the edge: Caddy passes the
 * prefix through with `handle`, matching `smokeRoutes`. A bare `/auth` here
 * answers in unit tests and 404s behind the proxy.
 *
 * **This is the module that reaches past path, query and body**, and it is why
 * `RouteRequest` carries `url` and `RouteResponse` carries `cookies`. The OIDC
 * callback needs the request's own origin to rebuild the provider callback, and
 * three answers set more than one cookie. `hasInvalidCookieOrigin` stays out of
 * the route list on purpose: `onRequest` in `app.ts` calls it before routing, so
 * it guards paths no route here declares.
 */
export function authRoutes(auth: AuthService, oidc?: OidcRouteOptions): Route[] {
  const passwordThrottle = new LoginThrottle({ now: oidc?.now });

  const passwordRoutes: Route[] = [
    {
      method: 'POST',
      path: '/api/auth/register',
      handler: async ({ body, headers }) => {
        // The body check comes first because Elysia's did: a schema hook runs
        // before the handler, so a malformed body was a 422 ahead of every
        // refusal below and moving it later would answer 403 or 404 to a
        // request that used to be told what was actually wrong with it.
        const credentials = credentialsFrom(body);
        if (isRefusal(credentials)) return credentials;
        if (oidc !== undefined && oidc.passwordRegisterEnabled !== true) {
          return respond(404, { error: 'not_found' });
        }
        if (oidc !== undefined && headers['origin'] !== oidc.appOrigin) {
          return respond(403, { error: 'invalid_origin' });
        }
        const clientIp = clientIpOf(headers);
        if (oidc !== undefined && clientIp === null) {
          return respond(400, { error: 'invalid_client' });
        }
        const throttleIp = clientIp ?? 'local-direct';
        if (!passwordThrottle.canAttempt(credentials.username, throttleIp)) {
          return respond(429, { error: 'rate_limited' });
        }
        // Registration is an expensive password hash even when it succeeds.
        // Count every attempt so rotating usernames cannot turn it into a CPU sink.
        passwordThrottle.recordFailure(credentials.username, throttleIp);
        const outcome = await auth.register(credentials.username, credentials.password);
        if (!outcome.ok) {
          // 409 for a taken name, 400 for a malformed one: the front end shows
          // different messages, and a single 400 for both made "that name is
          // gone" indistinguishable from "your password is too short".
          return respond(outcome.reason === 'taken' ? 409 : 400, { error: outcome.reason });
        }
        if (oidc !== undefined) {
          return {
            status: 200,
            body: { token: '', user: outcome.value.user },
            cookies: [cookie('__Host-wbs_access', outcome.value.token, TOKEN_TTL_SECONDS)],
          };
        }
        return ok(outcome.value);
      },
      documentation: { detail: { requestBody: CREDENTIALS_BODY } },
    },
    {
      method: 'POST',
      path: '/api/auth/login',
      handler: async ({ body, headers }) => {
        // First, for `/register`'s reason: Elysia's schema hook ran before the
        // handler and this refusal has to stay where a client already sees it.
        const credentials = credentialsFrom(body);
        if (isRefusal(credentials)) return credentials;
        if (oidc?.passwordLoginEnabled === false) return respond(404, { error: 'not_found' });
        if (oidc !== undefined && headers['origin'] !== oidc.appOrigin) {
          return respond(403, { error: 'invalid_origin' });
        }
        const clientIp = clientIpOf(headers);
        if (oidc !== undefined && clientIp === null) {
          return respond(400, { error: 'invalid_client' });
        }
        const throttleIp = clientIp ?? 'local-direct';
        if (!passwordThrottle.canAttempt(credentials.username, throttleIp)) {
          return respond(429, { error: 'invalid_credentials' });
        }
        const outcome = await auth.login(credentials.username, credentials.password);
        if (!outcome.ok) {
          passwordThrottle.recordFailure(credentials.username, throttleIp);
          return respond(401, { error: 'invalid_credentials' });
        }
        passwordThrottle.recordSuccess(credentials.username);
        if (oidc !== undefined) {
          return {
            status: 200,
            body: { token: '', user: outcome.value.user },
            cookies: [cookie('__Host-wbs_access', outcome.value.token, TOKEN_TTL_SECONDS)],
          };
        }
        return ok(outcome.value);
      },
      documentation: { detail: { requestBody: CREDENTIALS_BODY } },
    },
    {
      method: 'GET',
      path: '/api/auth/me',
      handler: async ({ headers }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          const presentedCredential =
            cookiesIn(headers['cookie']).has('__Host-wbs_access') ||
            headers['authorization'] !== undefined ||
            headers['x-wbs-token'] !== undefined;
          /*
           * No browser session is an ordinary signed-out state, not a failed
           * resource: Chromium reports every 401 fetch in its console. A
           * credential that was actually presented still fails closed.
           *
           * Proof: treating every null user as anonymous makes the forged,
           * altered, and retired-header cases in auth.integration.test.ts
           * return 200; restoring the blanket 401 makes its anonymous case
           * fail and reproduces TASK-299's two StrictMode console errors.
           */
          if (!presentedCredential) return ok({ user: null });
          return respond(401, { error: 'invalid_token' });
        }
        return ok({ user });
      },
    },
  ];

  if (oidc === undefined) return passwordRoutes;
  const options = oidc;
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(32).toString('base64url'));

  return [
    ...passwordRoutes,
    {
      method: 'GET',
      path: '/api/auth/login',
      handler: async (req) => {
        const browserBinding = random();
        const state = random();
        const nonce = random();
        const verifier = random();
        options.transactions.save({ browserBinding, nonce, state, verifier });
        const location = await options.client.authorizationUrl({
          nonce,
          redirectUri: options.redirectUri,
          state,
          verifier,
        });
        // **This login writes its own cookie name and never another login's**
        // (TASK-272). The route used to write one shared name, so a second
        // tab's login overwrote the first tab's cookie and the first tab's
        // callback came back holding a binding that was not its own — a login
        // lost to nothing but a second tab. `browserBindingCookieName` is
        // derived from the binding, so two logins cannot collide and neither
        // write depends on having read the other.
        //
        // **The bound is kept by clearing, on the way past.** Anything the
        // browser is holding that addresses nothing, plus the oldest of what is
        // left once this login has taken its slot, is cleared here;
        // `selectBrowserBindings` decides which, ordering by the store's
        // `expiresAt` rather than by anything the cookie says about itself.
        // Clearing a name is independent of every other name, so two logins
        // starting at once agree on what to evict and neither erases the other.
        //
        // Proof: dropping the evictions reddens `holds three concurrent logins
        // per browser and drops the oldest` at the fourth login — the oldest
        // name is still in the jar and `Set-Cookie` carries no `Max-Age=0` for
        // it. Writing this binding under the shared old name instead reddens
        // `lets the first tab finish a login a second tab started after it` at
        // the late callback, `Expected: 302 Received: 400`.
        const held = selectBrowserBindings(
          options.transactions,
          browserBindingsIn(cookiesOf(req)),
          now(),
        );
        const evicted = [
          ...held.surplus,
          ...held.offered.slice(0, Math.max(0, held.offered.length - (MAX_BROWSER_BINDINGS - 1))),
        ];
        return empty(302, [bindingCookie(browserBinding), ...clearsFor(evicted)], location.href);
      },
    },
    {
      method: 'GET',
      path: '/api/auth/okta/callback',
      handler: async (req) => {
        // **This route answers GET and only GET, and that is a decision.**
        // Elysia dispatches a HEAD to a path's GET and so does the in-process
        // binder (RFC 9110 §9.3.2), which is right for a route that reads
        // something. This one does not read: it consumes a single-use login
        // transaction, exchanges a one-time code and mints the session cookies.
        // Answering that from a HEAD spends the whole login on a request that
        // by definition carries no body back, and a link preview or an uptime
        // probe following the redirect URL would be enough to do it. So the
        // arrived verb is refused here rather than resolved away.
        //
        // **HEAD is the only verb this can be answering**, and the 405 says so
        // rather than widening the route: POST, PUT, PATCH and DELETE never
        // reach here at all, because the route is registered under GET alone
        // and both binders answer a wrong verb on a known path with 404 before
        // any handler (`in-process/bind.ts` says why that is 404 and not 405).
        // HEAD is the one verb dispatched *into* this handler, so it is the one
        // verb that can be refused from inside it. 405 with `Allow`, which RFC
        // 9110 §15.5.6 requires, because the caller asked a route that exists
        // for a verb it does not serve. It is refused in the handler rather
        // than in a `preflight` for one mechanical reason — a preflight's
        // refusal reaches the wire through Elysia's `status(…)`, which carries
        // no headers, so `Allow` would survive under one binder and not the
        // other. See `RoutePreflight`.
        //
        // Nothing is cleared and nothing is consumed: a refusal that cost the
        // caller their transaction would be the defect this route is being
        // fixed for, wearing a different status.
        //
        // Proof: `refuses a HEAD callback with 405 and Allow, before consuming
        // or exchanging` fails with `Expected: 405 Received: 302` when this
        // check is deleted — the probe completes the login and spends the
        // transaction.
        if (req.receivedMethod !== 'GET') {
          return { status: 405, body: { error: 'method_not_allowed' }, headers: { allow: 'GET' } };
        }

        // The query string as sent, because `req.query` cannot answer the
        // question this route has to ask first. A repeated key keeps its
        // **last** value there (`RouteRequest.query`), while
        // `searchParams.get()` — what this handler read before the route shape
        // — keeps the first, and a `state` sent twice therefore selected a
        // different string after the refactor than before it (TASK-269).
        //
        // **The answer is to refuse it, not to pick a value.** No authorization
        // server sends a response parameter twice; a callback that carries one
        // twice is parameter pollution, and the provider library refuses it a
        // moment later anyway. Read at this head, `oauth4webapi` 3.8.7 under
        // `openid-client` 6.8.7 pulls every response parameter through
        // `getURLSearchParameter` (`build/index.js:2042-2048`), which throws
        // `"<name>" parameter must be provided only once` on a second value.
        // Picking the first would therefore only move the failure from a 400
        // this route controls to a rejected promise out of `exchange` — after
        // the transaction is gone.
        //
        // **And it is refused before `consume`, with nothing cleared**, which
        // is the half that matters: a duplicated parameter costs the caller
        // nothing at all and the correct callback still works. It was written
        // when reaching `consume` with the wrong value destroyed the record on
        // arrival; TASK-276 has since made the store keep a mismatched record,
        // so this guard is no longer the only thing standing between a
        // pollution attempt and a burnt login. It stays because the reason it
        // gives is still its own — no authorization server sends a parameter
        // twice, and picking a value would only move the failure past this
        // route into `exchange`.
        //
        // **Any repeated key, not just `state`.** A doubled `code` is the same
        // fault one parameter over and it is strictly worse: the state matches,
        // `consume` succeeds and spends the transaction, and the throw out of
        // `exchange` is caught by nothing in this handler, so the caller gets a
        // framework 500 for a login that is now unrecoverable. `iss` loses the
        // same login one step earlier.
        //
        // The broad rule rather than the library's singleton set, and it is the
        // protocol's rule and not a house preference: RFC 6749 §3.1 says
        // request and response parameters MUST NOT be included more than once,
        // for every parameter and not for an enumerated few. Copying the set
        // `oauth4webapi` happens to read would put a dependency's internals in
        // a controller and be wrong the day it reads one more; this URL exists
        // for exactly one redirect from one authorization server, so a key it
        // sent twice is refused whichever key it is.
        //
        // Proof: `refuses a callback carrying two states without spending the
        // transaction` fails on `Expected "{"error":"duplicate_parameter"}"
        // Received ""` — the bodiless 400, which since TASK-276 is the state
        // mismatch's answer and no longer a burn — when this reads
        // `req.query['state']` instead; and `refuses a
        // callback carrying two codes with the transaction still unspent`
        // fails with `Expected: 400 Received: 302` when the rule is narrowed
        // back to `state` alone.
        const sent = new URL(req.url).searchParams;
        const seen = new Set<string>();
        for (const key of sent.keys()) {
          if (seen.has(key)) return respond(400, { error: 'duplicate_parameter' });
          seen.add(key);
        }
        const states = sent.getAll('state');

        // Truthiness, which is `saved-plan.routes.ts`'s idiom for the same
        // problem: an absent key is `undefined` here and an empty `?state=` is
        // `''`, and both answer the same 400. That is the same answer by a
        // shorter path than a length check: an empty state matches no saved
        // transaction, so `consume` returned `null` and the next line answered
        // the identical 400 with the identical cleared cookie. Nothing a caller
        // can observe moves.
        const state = states[0];
        // **Every answer on this route clears names and sets none** (TASK-272).
        // `settled` is the complete cookie list of every answer below, refusals
        // and success alike, and it holds exactly two kinds of name: what
        // `selectBrowserBindings` returned as surplus — records already gone or
        // expired, names that do not match their value, repeats, and the
        // over-the-bound entries the read side has already made unreachable —
        // and then the one this callback spent. Nothing in it is a login this
        // browser could still finish.
        //
        // A live, reachable login's cookie is never re-sent, which is what makes
        // a callback unable to erase a login started while it was in flight: a
        // name no answer mentions is left exactly as the login that wrote it
        // left it, `Max-Age` included.
        const held = selectBrowserBindings(
          options.transactions,
          browserBindingsIn(cookiesOf(req)),
          now(),
        );
        let settled = held.surplus;
        // **Two refusals where there was one, because a browser now holds more
        // than one login** (TASK-272). A browser offering no live binding has
        // no login to lose, so its dead names are cleared and the callback is
        // refused. A browser that *is* holding live bindings and sends a
        // callback with no state has proven nothing about any of them, and
        // clearing would destroy up to `MAX_BROWSER_BINDINGS` live logins on a
        // request anyone can cause: the binding cookies are `SameSite=Lax`, so
        // a hostile page can navigate a browser to this route with no query at
        // all. That is the TASK-276 denial with a shorter URL, and it is
        // refused the same way — the bodiless 400, nothing live cleared.
        //
        // Proof: clearing every held name here rather than only the dead ones
        // reddens `refuses a stateless callback without discarding the logins
        // in flight`, whose surviving cookie is derived from this answer, so
        // the honest callback that follows fails `Expected: 302 Received: 400`
        // rather than only the header assertion.
        if (held.offered.length === 0) return empty(400, clearsFor(settled));
        if (!state) return empty(400, clearsFor(settled));
        // Every binding the browser holds is offered and the store decides
        // which one this state proves; at most one record is consumed, and a
        // mismatch leaves both the record and the cookie alone
        // (`consumeBrowserBinding`). `remaining` is what the browser should
        // still be holding afterwards — the logins in other tabs — so whatever
        // is not in it has been spent and joins `settled`.
        const { remaining, transaction } = consumeBrowserBinding(
          options.transactions,
          held.offered.map((entry) => entry.binding),
          state,
        );
        const kept = new Set(remaining);
        settled = [...settled, ...held.offered.filter((entry) => !kept.has(entry.binding))];
        // **The mismatch is the one refusal here that leaves the binding
        // alone** (TASK-276). A state this browser cannot prove it owns is a
        // callback that is not this login — a hostile top-level navigation
        // carrying the `SameSite=Lax` cookie is exactly what it looks like —
        // and the store now keeps the record for the real callback still on its
        // way. Clearing the cookie would throw that login away anyway, from the
        // other end: the honest arrival would find no binding and take the 400
        // one line up. So the refusal costs the caller nothing, which is the
        // same shape the duplicated-parameter refusal above already takes.
        //
        // **Status and body do not move**, and that is deliberate: this stays
        // the bodiless 400 the other dead-transaction answers give, because a
        // caller who is told "your state was wrong" while the record survives
        // has been handed the retry signal the old ordering was destroying the
        // record to deny. The only observable difference is that no login this
        // browser could still finish is named: `settled` here is the surplus
        // this request arrived carrying — dead records, misnamed or repeated
        // cookies, and any live entry already past the bound and so unreachable
        // — which is usually empty.
        //
        // Proof: `refuses a forged error callback without burning the login it
        // interrupts` fails with `Received: "__Host-wbs_oidc_<digest>=;
        // HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"` against
        // `toBeNull()` when this clears the mismatched binding. That is the red
        // bun reports, because the header assertion throws first and ends the
        // case; delete that assertion as well and the honest callback fails
        // `Expected: 302 Received: 400`, which is what the case's derived jar
        // buys and what re-sending the cookie unconditionally did not. The loss
        // is observable where a browser would suffer it, not only in the header
        // causing it.
        if (transaction.outcome === 'state_mismatch') return empty(400, clearsFor(settled));
        if (transaction.outcome !== 'consumed') return empty(400, clearsFor(settled));

        // **An error callback is the authorization server saying this login is
        // over**, and it is the most ordinary thing a person can do: clicking
        // **Cancel** at the identity provider comes back as
        // `?error=access_denied&state=<state>` (RFC 6749 §4.1.2.1, and OIDC
        // Core §3.1.2.6 for `login_required` and its neighbours). That is a
        // well-formed callback — the state matches — so every check above
        // passes, and control used to reach `exchange`, where
        // `authorizationCodeGrant` throws `AuthorizationResponseError` for the
        // missing `code`. Nothing caught it, so a person who changed their mind
        // was shown a framework 500 (TASK-273).
        //
        // **After `consume`, not before, and the transaction is spent on
        // purpose.** No code will ever arrive for this state, so the record is
        // dead the moment the provider redirected; leaving it in the store
        // until its TTL keeps a live PKCE verifier and nonce for a login that
        // cannot finish. Reading `error` after the state check also means a
        // forged navigation to `?error=access_denied&state=<guess>` cannot reach
        // this line: only a state matching this browser's binding does.
        //
        // **The forged navigation this used to warn about is closed** —
        // TASK-276, and the note it replaces said what closing it would take.
        // `consume` no longer deletes the binding's record before it compares
        // the state (`libs/auth/src/oidc-store.ts`), so a hostile top-level
        // navigation to `?error=…&state=anything` carrying the `SameSite=Lax`
        // cookie now stops at the `state_mismatch` refusal above with the
        // record and the cookie both intact, and never reaches this branch at
        // all. What still reaches it is the callback whose state *matched*,
        // which is this browser's own login being ended by its own provider.
        //
        // **302 back to the app, where the other refusals here are bodiless
        // statuses.** This is the one refusal on this route a person chose, and
        // the thing they want is the sign-in card they started from; the 405
        // and the three bodiless 400s above — TASK-276 split the dead-record
        // one into a mismatch and the rest — and the 401s and 409 below, all describe a
        // callback that is broken rather than a decision, and a browser cannot
        // act on any of them.
        //
        // **The reason is a code from a fixed set and `error_description` is
        // never reflected.** Both strings arrive from the authorization server,
        // and they reach a person's screen only if something here decides they
        // may: a description is free text this app would be repeating on its
        // own origin. Any code outside {@link REPORTABLE_AUTH_ERRORS} collapses
        // to `provider_error`, so the provider cannot choose the string in this
        // URL either.
        //
        // **Both strings do reach the server log, and the split is the whole
        // point.** The reader is told a word this app chose; the operator is
        // told what the provider actually said, because an authorization server
        // that starts refusing every login with `okta_policy_evaluation_failure`
        // and a policy name in `error_description` is a deployment fault, and
        // with nothing written down it looks from the outside exactly like a
        // building full of people who all decided to click Cancel. The level is
        // the difference: the codes a **person** causes are `info`, and
        // everything the app will not repeat is `warn`, so a routine flood of
        // cancellations cannot bury the one line an operator is looking for.
        // (Round 1 of this change logged nothing at all and said so on purpose;
        // both terminal seats called it Important, and they were right.)
        //
        // **Presence, not truthiness.** `?error=` with nothing after it is a
        // malformed callback, and the earlier version let it fall through to
        // `exchange` — spending a real request on the provider to learn what
        // this line already knows, and reaching a refusal through an exception
        // handler rather than at the boundary. `has` refuses it here; the empty
        // string is outside the reportable set, so it leaves as
        // `provider_error` like any other code this app will not repeat. The
        // repeated-key guard above already ran, so there is exactly one value.
        //
        // Proof, and it is **not** the 500 — which is why no case here is named
        // after one. Deleting this block reddens six cases, and the first
        // symptom is the destination: `answers a cancelled login by returning
        // to the sign-in page without reaching the provider` reads `Expected:
        // "/?auth_error=access_denied" Received: "/"`. The fake provider client
        // in `oidc.integration.test.ts` resolves a token set for any query, so
        // without this block the handler *completes* the cancelled login rather
        // than failing it — which is a worse defect than the one being fixed
        // and is invisible against the real library. What this block
        // contributes to removing the 500 is that the provider is never reached
        // for an error callback at all, and the assertion carrying that is
        // `expect(f.calls.exchange).toHaveLength(0)`. The 500 itself belongs to
        // the real `authorizationCodeGrant`, and the case that reproduces a
        // throw is the `catch` below's.
        if (sent.has('error')) {
          const providerError = sent.get('error') ?? '';
          // A blank `?error=` names no reason, so there is nothing to report and
          // nothing to send the reader back with: it is a malformed callback and
          // takes the shape this route already gives one, the bodiless 400 with
          // the binding cleared. Answering `provider_error` instead would have
          // put words in the provider's mouth, and letting it fall through to
          // `exchange` — what the first version did — spent a real request on the
          // provider to learn what the empty value already said.
          if (providerError === '') {
            options.logger?.warn({}, 'oidc callback carried an empty error code');
            return empty(400, clearsFor(settled));
          }
          const reason = reasonOf(providerError);
          // **The code, never the description.** `error` is a protocol token
          // from a small vocabulary and is what tells an operator that a sign-on
          // policy started refusing everyone; `error_description` is free prose
          // the provider composes, has been observed carrying the name of the
          // person it refused, and is not needed to answer "why can nobody log
          // in". Its presence is recorded so a support thread quoting a message
          // this app never stored can be recognised as coming from the provider.
          const reported = {
            error: providerError,
            has_description: sent.has('error_description'),
            auth_error: reason,
          };
          if (reason === UNPUBLISHED_AUTH_ERROR) {
            options.logger?.warn(reported, 'oidc callback carried an error this app does not name');
          } else {
            options.logger?.info(reported, 'oidc callback was refused at the identity provider');
          }
          return empty(302, clearsFor(settled), `/?auth_error=${reason}`);
        }

        // The provider's client is handed a `Request` because that is its own
        // interface, not because a framework supplied one: it is built here from
        // the configured redirect URI and this request's query string. `req.url`
        // exists for exactly this and for the repeated-key count above.
        const callbackUrl = new URL(options.redirectUri);
        callbackUrl.search = new URL(req.url).search;
        const providerCallback = new Request(callbackUrl, {
          headers: headersOf(req),
          // The route's verb, and after the refusal above it is also the verb
          // the request arrived with — the two cannot differ by the time
          // control reaches here. Before the route shape this read the raw
          // `request.method`, so a HEAD callback reached the provider as HEAD;
          // that difference is closed by refusing HEAD, not by hiding it.
          method: req.method,
        });
        // **A callback with a matching state but no `code` is malformed, and it
        // is refused here rather than spent on the provider.** Without this the
        // request reaches `exchange`, the library rejects with
        // `OAUTH_INVALID_RESPONSE` — deliberately absent from the classifier's
        // table, because only the route knows whether a missing `code` is the
        // caller's fault or the provider's — and the mapping below reads that as
        // `defect` and answers 500. A caller who starts one legitimate login
        // holds a valid state and binding, so that caller could choose the
        // status and the alert bucket reserved for "this deployment is wrong".
        // A 400 is what the three other malformed-callback branches above
        // answer, and it keeps the defect rate something only this deployment
        // can move. (Peer pass 19, Important.)
        if ((sent.get('code') ?? '') === '') {
          options.logger?.info({}, 'oidc callback carried no code');
          return empty(400, clearsFor(settled));
        }
        // **The same boundary, widened: a parameter that belongs to a response
        // mode this app never asks for.** `authorizationUrl` sends
        // `response_type=code` and nothing else, so `response`, `id_token` and
        // `token` cannot arrive from a login this app started. They *can*
        // arrive from a caller who holds their own state and binding, and
        // `oauth4webapi`'s `validateAuthResponse` refuses them before any
        // provider request — as `OAUTH_INVALID_RESPONSE` or an unsupported
        // operation, neither of which the classifier tables, so both land in
        // `defect` and answer 500. Closing only the missing `code` left that
        // open; the answer is the same 400 the codeless case gets, because it
        // is the same fact: this callback is not one this app can complete.
        // (Peer pass 20, Important.)
        const impossible = OTHER_RESPONSE_MODE_PARAMS.filter((name) => sent.has(name));
        if (impossible.length > 0) {
          options.logger?.info(
            { oidc_callback_params: impossible },
            'oidc callback carried a parameter from a response mode this app does not use',
          );
          return empty(400, clearsFor(settled));
        }
        // **Every way out of `exchange` used to be the same answer**, and until
        // TASK-273 none of them was typed at all: the provider unreachable, a
        // `code` the provider will not honour, a nonce or `iss` the library
        // rejects, clock skew on the ID token — each was a rejected promise
        // that escaped to the framework as a 500 on a login the caller had
        // already lost. TASK-273 made that one bodiless 401 with the binding
        // cleared, and deliberately did not split the statuses, because telling
        // the cases apart meant reading the library's error subclasses inside a
        // controller — wrong the day the library adds one.
        //
        // **That objection is now answered rather than deferred.**
        // {@link classifyOidcFailure} reads the thrown value in `libs/auth` and
        // returns a union this project owns, so the only thing this route knows
        // about the library is that it throws. The route's whole share of the
        // judgment is one mapping, below, from a kind to a status.
        //
        // **The statuses follow the caller's move, not the evidence.** A
        // refusal is 401: this login did not complete and the next attempt
        // starts over. An outage is 503, not 502 — nothing was proxied, a
        // dependency is unavailable, and 503 is the status a `Retry-After`
        // could later be attached to. `indeterminate` is 503 as well, because
        // the person's move is identical to an outage's even though the alert
        // is not; the split that matters there is in the log line, not in the
        // status. A `defect` is a deliberate, classified 500 — the *distinct*
        // path AC #2 asks for, and not a return of what TASK-273 closed: that
        // defect was every failure arriving as an untyped 500 with nothing
        // written down, and this one is the single arm that means "this
        // deployment is wrong", carrying a reason slug to be found by.
        //
        // **The caught value goes to the log and nowhere near the answer.** An
        // expired token-endpoint certificate, a DNS failure and a `TypeError`
        // in the client all arrive here, and a bodiless status that discarded
        // the stack would turn every one of them into the same unexplained
        // login failure with no server-side trace at all. `err` is serialised
        // by `@wbs/observability`'s `errSerializer`, the same shape `app.ts`
        // logs a failed database probe with. It is still not forwarded: the
        // caller gets the status and nothing else, in every arm.
        //
        // **The level splits the same way the error-callback branch above
        // splits it, and for the same reason.** A refused code is something a
        // person caused, so it is `info`; a flood of them must not bury the one
        // line an operator is looking for. An outage and a defect are `error`.
        // `indeterminate` is `warn`: understood, but it names no party, and
        // paging an operator about a provider on evidence that does not accuse
        // the provider is exactly what {@link OidcFailureKind} keeps it apart to
        // avoid.
        //
        // Proof: `answers a failed exchange with a typed refusal rather than a
        // framework 500` fails with `Expected: 401 Received: 500` when this
        // `try` is removed; the per-arm status cases fail with the 401 this
        // block answered before the mapping existed.
        let tokenSet;
        try {
          tokenSet = await options.client.exchange(providerCallback, {
            nonce: transaction.nonce,
            state,
            verifier: transaction.verifier,
          });
        } catch (err) {
          // **The fifth callback this app could not have started, and the
          // only one that cannot be refused before `exchange` runs.** The other
          // four are decided from the query string alone; this one needs the
          // issuer identifier, which exists only after discovery resolves
          // inside the client's closure. So the adapter refuses it there and
          // rejects with a type this project owns, and the route gives it the
          // answer it already gives the other four: a bodiless 400 with the
          // binding cleared, logged at `info` because every input that reaches
          // it is wholly caller-authored.
          //
          // Before this branch the library refused the same callback as
          // `OAUTH_INVALID_RESPONSE`, which the classifier does not table, so
          // it landed in `defect` — the 500 and the `error`-level log a caller
          // holding their own state and binding could choose. (Peer pass 20.)
          //
          // It is read before {@link classifyOidcFailure} rather than tabled
          // inside it because the classifier's question is "whose move is this
          // failure": the exchange never happened here, so it has no answer to
          // give.
          if (isOidcCallbackRefused(err)) {
            options.logger?.info(
              { oidc_callback_refusal: err.reason },
              'oidc callback did not come from the configured issuer',
            );
            return empty(400, clearsFor(settled));
          }
          const failure = classifyOidcFailure(err);
          // Two flat fields, not a nested object: AC #3 asks for an outage to
          // be greppable without reading stack text, and
          // `oidc_failure_kind=unavailable` is greppable in a way that
          // `{"oidc":{"kind":…}}` is not. Both values are closed unions this
          // project writes, so no provider or library string can reach here.
          const classified = {
            err,
            oidc_failure_kind: failure.kind,
            oidc_failure_reason: failure.reason,
          };
          if (failure.kind === 'refused') {
            options.logger?.info(classified, 'oidc token exchange was refused');
          } else if (failure.kind === 'indeterminate') {
            options.logger?.warn(classified, 'oidc token exchange failed inconclusively');
          } else {
            options.logger?.error(classified, 'oidc token exchange failed');
          }
          return empty(STATUS_FOR_OIDC_FAILURE[failure.kind], clearsFor(settled));
        }
        if (tokenSet.idTokenClaims === undefined) {
          return empty(401, clearsFor(settled));
        }
        let identity;
        try {
          identity = oidcIdentityFromClaims(tokenSet.idTokenClaims, {
            groupPrefix: options.groupPrefix,
            groupsClaim: options.groupsClaim,
          });
        } catch {
          return empty(401, clearsFor(settled));
        }
        const account = await auth.resolveOidcIdentity(identity);
        if (account === null) return empty(409, clearsFor(settled));
        const correlation = random();
        if (tokenSet.refreshToken !== undefined) {
          options.tokens.save({
            expiresAt: now() + 30 * 86_400_000,
            refreshToken: tokenSet.refreshToken,
            sessionCorrelation: correlation,
          });
        }
        return empty(
          302,
          [
            ...clearsFor(settled),
            cookie('__Host-wbs_access', tokenSet.accessToken, tokenSet.expiresIn),
            cookie('__Host-wbs_session', correlation, 30 * 86_400),
          ],
          '/',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/auth/refresh',
      handler: async (req) => {
        const correlation = cookieOf(req, '__Host-wbs_session');
        const current = correlation === null ? null : options.tokens.read(correlation);
        if (correlation === null || current === null) return empty(401, clearSession());

        const next = await options.client.refresh(current.refreshToken);
        const refreshToken = next.refreshToken ?? current.refreshToken;
        const expiresAt = now() + 30 * 86_400_000;
        const rotated =
          refreshToken === current.refreshToken
            ? (options.tokens.save({ expiresAt, refreshToken, sessionCorrelation: correlation }),
              'rotated')
            : options.tokens.rotate({
                expiresAt,
                previousRefreshToken: current.refreshToken,
                refreshToken,
                sessionCorrelation: correlation,
              });
        if (rotated !== 'rotated') return empty(401, clearSession());
        return empty(204, [cookie('__Host-wbs_access', next.accessToken, next.expiresIn)]);
      },
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      handler: async (req) => {
        const correlation = cookieOf(req, '__Host-wbs_session');
        const record = correlation === null ? null : options.tokens.read(correlation);
        if (correlation !== null) options.tokens.delete(correlation);
        if (record !== null) await options.client.revoke(record.refreshToken);
        return empty(204, clearSession());
      },
    },
  ];
}

/**
 * The authorization-server error codes this app is willing to repeat back on
 * its own origin, and nothing else reaches the URL a person is left looking at.
 *
 * These six are the ones that describe something a **person** did or can do
 * again: they cancelled or declined consent (`access_denied`,
 * `consent_required`), the provider wants them to sign in or choose an account
 * or answer something interactively and could not do it silently
 * (`login_required`, `account_selection_required`, `interaction_required`), or
 * the provider is briefly down and the button is worth pressing again
 * (`temporarily_unavailable`).
 *
 * The remaining codes are the ones a reader cannot act on, and they are not one
 * kind: `invalid_request`, `unauthorized_client`, `unsupported_response_type`,
 * `invalid_scope` and the OIDC request-object family say **this deployment is
 * misconfigured**, while `server_error` says the **authorization server** hit an
 * unexpected condition of its own. Both are an operator's fact rather than a
 * reader's, so both collapse with everything unrecognised into `provider_error`
 * on screen — and both arrive under their real name in the log, which is where
 * that distinction is the one that matters.
 *
 * **An allowlist rather than a character rule**, because the whole point is
 * that the app decides what its own URL says. `error` is provider-supplied
 * free-ish text (RFC 6749 §4.1.2.1 permits most of US-ASCII in it), and a
 * regexp would still be forwarding a string chosen elsewhere.
 */
const REPORTABLE_AUTH_ERRORS: ReadonlySet<string> = new Set([
  'access_denied',
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'login_required',
  'temporarily_unavailable',
]);

/**
 * What the reader is told when the provider's code is not one this app names —
 * and the value the handler branches its log level on, which is why it is a
 * constant rather than a repeated string literal.
 */
const UNPUBLISHED_AUTH_ERROR = 'provider_error';

/** The provider's error code if this app publishes it, {@link UNPUBLISHED_AUTH_ERROR} otherwise. */
function reasonOf(code: string): string {
  return REPORTABLE_AUTH_ERRORS.has(code) ? code : UNPUBLISHED_AUTH_ERROR;
}

function clientIpOf(headers: Record<string, string | undefined>): string | null {
  // The single trusted Caddy edge appends the network peer. Any left-side
  // values may have been supplied by the client and cannot identify it.
  const forwarded = headers['x-forwarded-for']
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  return forwarded ?? null;
}

/** One cookie off the request, decoded — see {@link cookieValue}. */
function cookieOf(req: RouteRequest, name: string): string | null {
  return cookieValue(req.headers['cookie'], name);
}

/**
 * The request's headers as a `Headers`, for the one call that takes a `Request`.
 *
 * Binders lowercase header names, so this rebuilds the shape the OIDC client
 * expects from what a route module is given rather than from a framework object
 * it no longer holds.
 */
function headersOf(req: RouteRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function hasInvalidCookieOrigin(request: Request, appOrigin: string): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
    return false;
  const cookies = cookiesIn(request.headers.get('cookie') ?? undefined);
  return (
    (cookies.has('__Host-wbs_access') || cookies.has('__Host-wbs_session')) &&
    request.headers.get('origin') !== appOrigin
  );
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`;
}

function clear(name: string): string {
  return cookie(name, '', 0);
}

/**
 * How long a browser keeps an in-flight binding. Five minutes, matching the
 * transaction store's TTL (`oidcRouteOptionsFromEnv`), so the cookie and the
 * record it addresses die together; it is named rather than the literal `300`
 * the login route carried because the pairing is the point.
 */
const OIDC_BINDING_TTL_SECONDS = 300;

/**
 * The cookie one starting login leaves behind, under the name only it writes
 * (TASK-272).
 *
 * `Max-Age` is set here once and never extended, because no other answer on
 * these routes re-sends a live binding — see {@link clearsFor}. The store's
 * `expiresAt` is the authoritative deadline and matches this one, so a cookie
 * outliving its record presents a binding `consume` answers `expired`, and the
 * next request past it clears the name.
 */
function bindingCookie(binding: string): string {
  return cookie(browserBindingCookieName(binding), binding, OIDC_BINDING_TTL_SECONDS);
}

/**
 * The `Max-Age=0` headers that retire the logins these cookies were holding —
 * the whole cookie list of every OIDC answer that is not itself a new login
 * (TASK-272).
 *
 * **Clearing by name is what makes these writes independent.** The shape this
 * replaced kept every binding in one cookie's value, so an answer that wanted
 * to retire one login had to rewrite the list, and a login started while that
 * request was in flight was erased by the rewrite it never appeared in (peer
 * review, TASK-272 r1, Important). An answer that only names finished cookies
 * cannot say anything about a name it has not heard of.
 */
function clearsFor(held: readonly HeldBrowserBinding[]): string[] {
  return held.map((entry) => clear(entry.cookieName));
}

/** Every cookie on the request, undecoded — see {@link cookiesIn}. */
function cookiesOf(req: RouteRequest): Map<string, string> {
  return cookiesIn(req.headers['cookie']);
}

function clearSession(): string[] {
  return [clear('__Host-wbs_access'), clear('__Host-wbs_session')];
}

/**
 * An answer that is cookies and a status and nothing else — every OIDC route
 * ends in one.
 *
 * `body: null` rather than an empty object, so `toResponse` writes no body at
 * all: these were `new Response(null, …)` before the move and a `{}` would put
 * two bytes on the wire the browser did not have.
 */
/**
 * Authorization-response parameters that belong to a response mode this app
 * never requests. `authorizationUrl` sends `response_type=code`; anything
 * carrying `response`, `id_token` or `token` is a callback this app could not
 * have started, and is refused at the route rather than inside `exchange`.
 *
 * Kept here rather than in the classifier on purpose: only the route knows
 * which response mode it asked for, which is the same reason
 * `OAUTH_INVALID_RESPONSE` is deliberately absent from the classifier's table.
 */
const OTHER_RESPONSE_MODE_PARAMS = ['response', 'id_token', 'token'] as const;

/**
 * The route's entire share of the judgment TASK-277 moved into `libs/auth`: a
 * total map from an owned kind to a status. `Record<OidcFailureKind, …>` is the
 * point — adding a fifth kind to the union stops compiling here, so a new arm
 * cannot silently inherit whichever status happened to be the fallback.
 *
 * Why each one, in the caller's terms rather than the evidence's, is argued at
 * the `catch` that reads this.
 */
const STATUS_FOR_OIDC_FAILURE: Record<OidcFailureKind, number> = {
  defect: 500,
  indeterminate: 503,
  refused: 401,
  unavailable: 503,
};

function empty(status: number, cookies: string[], location?: string): RouteResponse {
  return {
    status,
    body: null,
    cookies,
    ...(location === undefined ? {} : { headers: { location } }),
  };
}
