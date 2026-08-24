import { randomBytes } from 'node:crypto';

import {
  browserOidcClientFromEnv,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
  type OidcTransactionStore,
  type TokenStore,
} from '@wbs/auth';
import { Elysia, t } from 'elysia';

import { tokenFromHeaders } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';

export interface OidcRouteOptions {
  appOrigin: string;
  client: ReturnType<typeof browserOidcClientFromEnv>;
  mode: 'oidc';
  now?: () => number;
  random?: () => string;
  redirectUri: string;
  tokens: TokenStore;
  transactions: OidcTransactionStore;
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
  return {
    appOrigin: redirectUri.origin,
    client: browserOidcClientFromEnv(env),
    mode: 'oidc',
    random: () => randomBytes(32).toString('base64url'),
    redirectUri: redirectUri.href,
    tokens: new InMemoryTokenStore(),
    transactions: new InMemoryOidcTransactionStore({ ttlMs: 300_000 }),
  };
}

/**
 * Types only. Length and character rules live in AuthService, because Elysia
 * rejects a schema violation with 422 before the handler runs — so enforcing
 * them here too would give the front end two different failures ("422" and
 * `{error:'invalid'}`) for one mistake.
 */
const credentials = t.Object({
  username: t.String(),
  password: t.String(),
});

/**
 * Registration and login both return the same token shape, so the front end
 * has one code path for "I am now signed in". The token is what gw-01 accepts
 * on the WebSocket, which is why login and the realtime connection cannot
 * drift apart: there is exactly one issuer.
 */
export function authController(auth: AuthService, oidc?: OidcRouteOptions) {
  // `/api` is part of the mount, not stripped by the edge: Caddy passes the
  // prefix through with `handle`, matching smokeController. A bare `/auth`
  // here answers in unit tests and 404s behind the proxy.
  const controller = new Elysia({ prefix: '/api/auth' })
    .post(
      '/register',
      async ({ body, set }) => {
        const outcome = await auth.register(body.username, body.password);
        if (!outcome.ok) {
          // 409 for a taken name, 400 for a malformed one: the front end shows
          // different messages, and a single 400 for both made "that name is
          // gone" indistinguishable from "your password is too short".
          set.status = outcome.reason === 'taken' ? 409 : 400;
          return { error: outcome.reason };
        }
        return outcome.result;
      },
      { body: credentials },
    )
    .post(
      '/login',
      async ({ body, set }) => {
        const outcome = await auth.login(body.username, body.password);
        if (!outcome.ok) {
          set.status = 401;
          return { error: 'invalid_credentials' };
        }
        return outcome.result;
      },
      { body: credentials },
    )
    .get('/me', async ({ headers, set }) => {
      const token = tokenFromHeaders(headers);
      if (token === null) {
        set.status = 401;
        return { error: 'missing_token' };
      }
      const user = await auth.authenticate(token);
      if (user === null) {
        set.status = 401;
        return { error: 'invalid_token' };
      }
      return { user };
    });

  if (oidc === undefined) return controller;
  const now = oidc.now ?? Date.now;
  const random = oidc.random ?? (() => randomBytes(32).toString('base64url'));

  return controller
    .get('/login', async () => {
      const browserBinding = random();
      const state = random();
      const nonce = random();
      const verifier = random();
      oidc.transactions.save({ browserBinding, nonce, state, verifier });
      const location = await oidc.client.authorizationUrl({
        nonce,
        redirectUri: oidc.redirectUri,
        state,
        verifier,
      });
      return emptyResponse(302, [cookie('__Host-wbs_oidc', browserBinding, 300)], location.href);
    })
    .get('/okta/callback', async ({ request }) => {
      const state = new URL(request.url).searchParams.get('state');
      const binding = cookiesOf(request).get('__Host-wbs_oidc');
      if (state === null || binding === undefined)
        return emptyResponse(400, [clear('__Host-wbs_oidc')]);
      const transaction = oidc.transactions.consume(binding, state);
      if (transaction === null) return emptyResponse(400, [clear('__Host-wbs_oidc')]);

      const callbackUrl = new URL(oidc.redirectUri);
      callbackUrl.search = new URL(request.url).search;
      const providerCallback = new Request(callbackUrl, {
        headers: request.headers,
        method: request.method,
      });
      const tokenSet = await oidc.client.exchange(providerCallback, {
        nonce: transaction.nonce,
        state,
        verifier: transaction.verifier,
      });
      const correlation = random();
      if (tokenSet.refreshToken !== undefined) {
        oidc.tokens.save({
          expiresAt: now() + 30 * 86_400_000,
          refreshToken: tokenSet.refreshToken,
          sessionCorrelation: correlation,
        });
      }
      return emptyResponse(
        302,
        [
          clear('__Host-wbs_oidc'),
          cookie('__Host-wbs_access', tokenSet.accessToken, tokenSet.expiresIn),
          cookie('__Host-wbs_session', correlation, 30 * 86_400),
        ],
        '/',
      );
    })
    .post('/refresh', async ({ request }) => {
      const correlation = cookiesOf(request).get('__Host-wbs_session');
      const current = correlation === undefined ? null : oidc.tokens.read(correlation);
      if (correlation === undefined || current === null) return emptyResponse(401, clearSession());

      const next = await oidc.client.refresh(current.refreshToken);
      const refreshToken = next.refreshToken ?? current.refreshToken;
      const expiresAt = now() + 30 * 86_400_000;
      const rotated =
        refreshToken === current.refreshToken
          ? (oidc.tokens.save({ expiresAt, refreshToken, sessionCorrelation: correlation }),
            'rotated')
          : oidc.tokens.rotate({
              expiresAt,
              previousRefreshToken: current.refreshToken,
              refreshToken,
              sessionCorrelation: correlation,
            });
      if (rotated !== 'rotated') return emptyResponse(401, clearSession());
      return emptyResponse(204, [cookie('__Host-wbs_access', next.accessToken, next.expiresIn)]);
    })
    .post('/logout', async ({ request }) => {
      const correlation = cookiesOf(request).get('__Host-wbs_session');
      const record = correlation === undefined ? null : oidc.tokens.read(correlation);
      if (correlation !== undefined) oidc.tokens.delete(correlation);
      if (record !== null) await oidc.client.revoke(record.refreshToken);
      return emptyResponse(204, clearSession());
    });
}

export function hasInvalidCookieOrigin(request: Request, appOrigin: string): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
    return false;
  const cookies = cookiesOf(request);
  return (
    (cookies.has('__Host-wbs_access') || cookies.has('__Host-wbs_session')) &&
    request.headers.get('origin') !== appOrigin
  );
}

function cookiesOf(request: Request): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0)
      parsed.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1)));
  }
  return parsed;
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

function emptyResponse(status: number, cookies: string[], location?: string): Response {
  const headers = new Headers();
  for (const value of cookies) headers.append('set-cookie', value);
  if (location !== undefined) headers.set('location', location);
  return new Response(null, { headers, status });
}
