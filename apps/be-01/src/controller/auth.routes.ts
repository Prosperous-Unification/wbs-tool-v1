import { randomBytes } from 'node:crypto';

import {
  booleanFlagOf,
  browserOidcClientFromEnv,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
  oidcIdentityFromClaims,
  oidcTokenVerifierFromEnv,
  type OidcTransactionStore,
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

export interface OidcRouteOptions {
  appOrigin: string;
  client: ReturnType<typeof browserOidcClientFromEnv>;
  groupPrefix: string;
  groupsClaim: string;
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
        if (user === null) return respond(401, { error: 'invalid_token' });
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
      handler: async () => {
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
        return empty(302, [cookie('__Host-wbs_oidc', browserBinding, 300)], location.href);
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
        // is the half that matters. `InMemoryOidcTransactionStore.consume`
        // deletes the record before it checks the state, so reaching it with
        // the wrong value burns a login that was about to succeed; a duplicated
        // parameter now costs the caller nothing at all and the correct
        // callback still works.
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
        // Received ""` — the bodiless 400 with the cookie cleared, i.e. the
        // burn — when this reads `req.query['state']` instead; and `refuses a
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
        const binding = cookieOf(req, '__Host-wbs_oidc');
        if (!state || binding === null) return empty(400, [clear('__Host-wbs_oidc')]);
        const transaction = options.transactions.consume(binding, state);
        if (transaction === null) return empty(400, [clear('__Host-wbs_oidc')]);

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
        const tokenSet = await options.client.exchange(providerCallback, {
          nonce: transaction.nonce,
          state,
          verifier: transaction.verifier,
        });
        if (tokenSet.idTokenClaims === undefined) {
          return empty(401, [clear('__Host-wbs_oidc')]);
        }
        let identity;
        try {
          identity = oidcIdentityFromClaims(tokenSet.idTokenClaims, {
            groupPrefix: options.groupPrefix,
            groupsClaim: options.groupsClaim,
          });
        } catch {
          return empty(401, [clear('__Host-wbs_oidc')]);
        }
        const account = await auth.resolveOidcIdentity(identity);
        if (account === null) return empty(409, [clear('__Host-wbs_oidc')]);
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
            clear('__Host-wbs_oidc'),
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
function empty(status: number, cookies: string[], location?: string): RouteResponse {
  return {
    status,
    body: null,
    cookies,
    ...(location === undefined ? {} : { headers: { location } }),
  };
}
