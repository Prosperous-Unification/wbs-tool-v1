import { randomBytes } from 'node:crypto';

import { oidcIdentityFromClaims } from '@wbs/auth';
import {
  completeOidcLogin,
  logoutOidcSession,
  refreshOidcSession,
  startOidcLogin,
} from '@wbs/contracts';

import {
  bind,
  EMPTY,
  type Header,
  type HttpReply,
  type RequestFailure,
  type RequestMetadata,
} from '../http/endpoint';
import { cookieValue } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';
import type { OidcRouteOptions } from './oidc-options';

const reportable = new Set([
  'access_denied',
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'login_required',
  'temporarily_unavailable',
]);
/** Serializes one independently appended hardened browser cookie.
 * Proof: removing Secure failed the mounted recovery test’s exact three-cookie assertion. */
function cookie(name: string, value: string, maxAge: number): Header {
  return [
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`,
  ];
}
const clearBinding = () => cookie('__Host-wbs_oidc', '', 0);
const clearSession = (): Header[] => [
  cookie('__Host-wbs_access', '', 0),
  cookie('__Host-wbs_session', '', 0),
];
const correlationOf = (request: RequestMetadata) =>
  cookieValue(request.headers.get('cookie') ?? undefined, '__Host-wbs_session');
/** HEAD must not spend state or mint a session; transport retains its Allow header.
 * Proof: deleting this admission made the mounted HEAD test receive302 instead of405. */
function callbackAdmission(request: RequestMetadata) {
  return request.method === 'GET'
    ? null
    : ({
        ok: false,
        status: 405,
        body: { error: 'method_not_allowed' },
        headers: [['allow', 'GET']],
      } as const);
}
/** The protocol’s singleton query adapter refuses pollution before transaction consumption.
 * Proof: returning invalid_query failed the mounted duplicate_parameter assertion. */
function callbackFailure(
  failure: RequestFailure,
): Extract<HttpReply<typeof completeOidcLogin>, { ok: false }> {
  if (failure.part === 'query' && failure.duplicate !== undefined)
    return { ok: false, status: 400, body: { error: 'duplicate_parameter' } };
  return { ok: false, status: 400, body: { error: failure.code } };
}
/**
 * Browser OIDC bindings. Composition registers these only when OIDC options exist.
 * Exchange failures are modeled401; account and token-store failures remain throws.
 */
export function authOidcEndpoints(auth: AuthService, options: OidcRouteOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(32).toString('base64url'));
  return [
    bind(startOidcLogin, async () => {
      const browserBinding = random();
      const state = random();
      const nonce = random();
      const verifier = random();
      options.transactions.save({ browserBinding, state, nonce, verifier });
      const location = await options.client.authorizationUrl({
        nonce,
        state,
        verifier,
        redirectUri: options.redirectUri,
      });
      return {
        ok: true,
        status: 302,
        body: EMPTY,
        headers: [cookie('__Host-wbs_oidc', browserBinding, 300), ['location', location.href]],
      };
    }),
    bind(
      completeOidcLogin,
      async ({ request, query }): Promise<HttpReply<typeof completeOidcLogin>> => {
        const state = query['state'];
        const binding = cookieValue(request.headers.get('cookie') ?? undefined, '__Host-wbs_oidc');
        // Proof: substituting invalid_query made the mounted absent-binding
        // assertion receive that code instead of invalid_oidc_callback.
        if (!state || binding === null)
          return {
            ok: false,
            status: 400,
            body: { error: 'invalid_oidc_callback' },
            headers: [clearBinding()],
          };
        const transaction = options.transactions.consume(binding, state);
        // Proof: clearing this cookie failed the mounted empty-cookie assertion; spending
        // the retained transaction made its subsequent honest callback receive400 instead of302.
        if (transaction.outcome === 'state_mismatch')
          return { ok: false, status: 400, body: { error: 'invalid_oidc_callback' } };
        // Proof: substituting invalid_query made the mounted missing-transaction
        // assertion receive that code instead of invalid_oidc_callback.
        if (transaction.outcome !== 'consumed')
          return {
            ok: false,
            status: 400,
            body: { error: 'invalid_oidc_callback' },
            headers: [clearBinding()],
          };
        // Proof: bypassing this branch redirected access_denied to / in the mounted provider test.
        if (Object.hasOwn(query, 'error')) {
          const providerError = query['error'] ?? '';
          // Proof: skipping the blank-code refusal returned302 instead of400 in the mounted provider test.
          if (providerError === '') {
            options.logger?.warn({}, 'oidc callback carried an empty error code');
            return {
              ok: false,
              status: 400,
              body: { error: 'invalid_oidc_callback' },
              headers: [clearBinding()],
            };
          }
          // Proof: forwarding an unknown error exposed provider_secret instead of provider_error.
          const reason = reportable.has(providerError) ? providerError : 'provider_error';
          // Proof: logging description text exposed PRIVATE in the mounted provider test’s log assertion.
          const reported = {
            error: providerError,
            has_description: Object.hasOwn(query, 'error_description'),
            auth_error: reason,
          };
          if (reason === 'provider_error')
            options.logger?.warn(reported, 'oidc callback carried an error this app does not name');
          else options.logger?.info(reported, 'oidc callback was refused at the identity provider');
          // Proof: JSON null instead of EMPTY returned500 instead of302 in the mounted recovery test.
          return {
            ok: true,
            status: 302,
            body: EMPTY,
            headers: [clearBinding(), ['location', `/?auth_error=${reason}`]],
          };
        }
        // Proof: using arrived origin forwarded internal HTTP instead of configured HTTPS in the mounted proxy test.
        const callbackUrl = new URL(options.redirectUri);
        callbackUrl.search = request.url.search;
        const providerCallback = new Request(callbackUrl, {
          headers: request.headers,
          method: request.method,
        });
        // Proof: rethrowing exchange failure returned500 instead of401 in the mounted failure test.
        let tokens;
        try {
          tokens = await options.client.exchange(providerCallback, {
            nonce: transaction.nonce,
            state,
            verifier: transaction.verifier,
          });
        } catch (err) {
          options.logger?.error({ err }, 'oidc token exchange failed');
          return {
            ok: false,
            status: 401,
            body: { error: 'invalid_oidc_session' },
            headers: [clearBinding()],
          };
        }
        if (tokens.idTokenClaims === undefined)
          return {
            ok: false,
            status: 401,
            body: { error: 'invalid_oidc_session' },
            headers: [clearBinding()],
          };
        let identity;
        try {
          identity = oidcIdentityFromClaims(tokens.idTokenClaims, {
            groupPrefix: options.groupPrefix,
            groupsClaim: options.groupsClaim,
          });
        } catch {
          return {
            ok: false,
            status: 401,
            body: { error: 'invalid_oidc_session' },
            headers: [clearBinding()],
          };
        }
        // Proof: catching account-store failure as null returned409 instead of500 in the mounted failure test.
        const account = await auth.resolveOidcIdentity(identity);
        if (account === null)
          return {
            ok: false,
            status: 409,
            body: { error: 'oidc_identity_conflict' },
            headers: [clearBinding()],
          };
        const correlation = random();
        if (tokens.refreshToken !== undefined)
          options.tokens.save({
            expiresAt: now() + 30 * 86400000,
            refreshToken: tokens.refreshToken,
            sessionCorrelation: correlation,
          });
        // Proof: JSON null instead of EMPTY returned500 instead of302 in the mounted recovery test.
        return {
          ok: true,
          status: 302,
          body: EMPTY,
          headers: [
            clearBinding(),
            cookie('__Host-wbs_access', tokens.accessToken, tokens.expiresIn),
            cookie('__Host-wbs_session', correlation, 30 * 86400),
            ['location', '/'],
          ],
        };
      },
      { prevalidate: callbackAdmission, classifyRequestFailure: callbackFailure },
    ),
    bind(refreshOidcSession, async ({ request }): Promise<HttpReply<typeof refreshOidcSession>> => {
      const correlation = correlationOf(request);
      const current = correlation === null ? null : options.tokens.read(correlation);
      if (correlation === null || current === null)
        return {
          ok: false,
          status: 401,
          body: { error: 'invalid_oidc_session' },
          headers: clearSession(),
        };
      const next = await options.client.refresh(current.refreshToken);
      const refreshToken = next.refreshToken ?? current.refreshToken;
      const expiresAt = now() + 30 * 86400000;
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
      // Proof: bypassing failed rotation returned204 instead of401 in the mounted refresh test.
      if (rotated !== 'rotated')
        return {
          ok: false,
          status: 401,
          body: { error: 'invalid_oidc_session' },
          headers: clearSession(),
        };
      return {
        ok: true,
        status: 204,
        body: EMPTY,
        headers: [cookie('__Host-wbs_access', next.accessToken, next.expiresIn)],
      };
    }),
    bind(logoutOidcSession, async ({ request }) => {
      const correlation = correlationOf(request);
      const record = correlation === null ? null : options.tokens.read(correlation);
      // Proof: revoking before deletion left the stored token present in the mounted logout failure test.
      if (correlation !== null) options.tokens.delete(correlation);
      if (record !== null) await options.client.revoke(record.refreshToken);
      return { ok: true, status: 204, body: EMPTY, headers: clearSession() };
    }),
  ] as const;
}
