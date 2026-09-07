import { randomBytes } from 'node:crypto';

import {
  browserBindingCookieName,
  browserBindingsIn,
  classifyOidcFailure,
  consumeBrowserBinding,
  type HeldBrowserBinding,
  isOidcCallbackRefused,
  MAX_BROWSER_BINDINGS,
  type OidcFailureKind,
  oidcIdentityFromClaims,
  selectBrowserBindings,
} from '@wbs/auth';
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
import { cookiesIn, cookieValue } from '../middleware/authenticated';
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
/** Parameters from response modes this code-flow client never requests. */
const OTHER_RESPONSE_MODE_PARAMS = ['response', 'id_token', 'token'] as const;
/** The caller-visible status for every owned exchange-failure classification. */
const STATUS_FOR_OIDC_FAILURE: Record<OidcFailureKind, 401 | 500 | 503> = {
  defect: 500,
  indeterminate: 503,
  refused: 401,
  unavailable: 503,
};
/** Serializes one independently appended hardened browser cookie.
 * Proof: removing Secure failed the mounted recovery test’s exact three-cookie assertion. */
function cookie(name: string, value: string, maxAge: number): Header {
  return [
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${String(maxAge)}`,
  ];
}
/** Five minutes, matching the transaction store configured by {@link oidcRouteOptionsFromEnv}. */
const OIDC_BINDING_TTL_SECONDS = 300;
const bindingCookie = (binding: string): Header =>
  cookie(browserBindingCookieName(binding), binding, OIDC_BINDING_TTL_SECONDS);
const clearBinding = (name: string): Header => cookie(name, '', 0);
const clearsFor = (held: readonly HeldBrowserBinding[]): Header[] =>
  held.map(({ cookieName }) => clearBinding(cookieName));
const browserBindingsOf = (request: RequestMetadata): HeldBrowserBinding[] =>
  browserBindingsIn(cookiesIn(request.headers.get('cookie') ?? undefined));
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
 * Exchange failures carry their owned classification; account and token-store failures remain throws.
 */
export function authOidcEndpoints(auth: AuthService, options: OidcRouteOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(32).toString('base64url'));
  return [
    bind(startOidcLogin, async ({ request }) => {
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
      const held = selectBrowserBindings(options.transactions, browserBindingsOf(request), now());
      const evicted = [
        ...held.surplus,
        ...held.offered.slice(0, Math.max(0, held.offered.length - (MAX_BROWSER_BINDINGS - 1))),
      ];
      return {
        ok: true,
        status: 302,
        body: EMPTY,
        // Proof: using the shared old cookie name made `lets the first tab finish a login a
        // second tab started after it` fail at the late callback, Expected302 Received400.
        // Dropping the evictions made `holds three concurrent logins per browser and drops
        // the oldest` retain four bindings after the fourth login.
        headers: [
          bindingCookie(browserBinding),
          ...clearsFor(evicted),
          ['location', location.href],
        ],
      };
    }),
    bind(
      completeOidcLogin,
      async ({ request }): Promise<HttpReply<typeof completeOidcLogin>> => {
        const sent = request.url.searchParams;
        const state = sent.get('state') ?? undefined;
        const held = selectBrowserBindings(options.transactions, browserBindingsOf(request), now());
        let settled = held.surplus;
        // Proof: substituting invalid_query made the mounted absent-binding
        // assertion receive that code instead of invalid_oidc_callback.
        if (held.offered.length === 0 || !state)
          return {
            ok: false,
            status: 400,
            body: EMPTY,
            // Proof: clearing live bindings here made `refuses a stateless callback without
            // discarding the logins in flight` fail at its honest callback, Expected302 Received400.
            headers: clearsFor(settled),
          };
        const consumed = consumeBrowserBinding(
          options.transactions,
          held.offered.map(({ binding }) => binding),
          state,
        );
        const remaining = new Set(consumed.remaining);
        settled = [...settled, ...held.offered.filter(({ binding }) => !remaining.has(binding))];
        const transaction = consumed.transaction;
        // Proof: clearing this cookie failed the mounted empty-cookie assertion; spending
        // the retained transaction made its subsequent honest callback receive400 instead of302.
        if (transaction.outcome === 'state_mismatch')
          return {
            ok: false,
            status: 400,
            body: EMPTY,
            // Proof: clearing the mismatched binding made `refuses a forged error callback
            // without burning the login it interrupts` receive a Set-Cookie clear and made
            // its subsequent honest callback fail, Expected302 Received400.
            headers: clearsFor(settled),
          };
        // Proof: returning invalid_oidc_callback made the mounted missing-transaction
        // assertion receive its JSON envelope instead of an empty string.
        if (transaction.outcome !== 'consumed')
          return {
            ok: false,
            status: 400,
            body: EMPTY,
            headers: clearsFor(settled),
          };
        // Proof: bypassing this branch redirected access_denied to / in the mounted provider test.
        if (sent.has('error')) {
          const providerError = sent.get('error') ?? '';
          // Proof: skipping the blank-code refusal returned302 instead of400 in the mounted provider test.
          if (providerError === '') {
            options.logger?.warn({}, 'oidc callback carried an empty error code');
            return {
              ok: false,
              status: 400,
              body: EMPTY,
              headers: clearsFor(settled),
            };
          }
          // Proof: forwarding an unknown error exposed provider_secret instead of provider_error.
          const reason = reportable.has(providerError) ? providerError : 'provider_error';
          // Proof: logging description text exposed PRIVATE in the mounted provider test’s log assertion.
          const reported = {
            error: providerError,
            has_description: sent.has('error_description'),
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
            headers: [...clearsFor(settled), ['location', `/?auth_error=${reason}`]],
          };
        }
        // A matching state is not permission to choose the defect/outage bucket
        // with a callback this code-flow client could never have initiated.
        if ((sent.get('code') ?? '') === '') {
          options.logger?.info({}, 'oidc callback carried no code');
          return {
            ok: false,
            status: 400,
            body: EMPTY,
            headers: clearsFor(settled),
          };
        }
        const impossible = OTHER_RESPONSE_MODE_PARAMS.filter((name) => sent.has(name));
        if (impossible.length > 0) {
          options.logger?.info(
            { oidc_callback_params: impossible },
            'oidc callback carried a parameter from a response mode this app does not use',
          );
          return {
            ok: false,
            status: 400,
            body: EMPTY,
            headers: clearsFor(settled),
          };
        }
        // Proof: using arrived origin forwarded internal HTTP instead of configured HTTPS in the mounted proxy test.
        const callbackUrl = new URL(options.redirectUri);
        callbackUrl.search = request.url.search;
        const providerCallback = new Request(callbackUrl, {
          headers: request.headers,
          method: request.method,
        });
        // Proof: collapsing these arms to 401 made the mounted outage test receive 401 instead of 503.
        let tokens;
        try {
          tokens = await options.client.exchange(providerCallback, {
            nonce: transaction.nonce,
            state,
            verifier: transaction.verifier,
          });
        } catch (err) {
          if (isOidcCallbackRefused(err)) {
            options.logger?.info(
              { oidc_callback_refusal: err.reason },
              'oidc callback did not come from the configured issuer',
            );
            return {
              ok: false,
              status: 400,
              body: EMPTY,
              headers: clearsFor(settled),
            };
          }
          const failure = classifyOidcFailure(err);
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
          return {
            ok: false,
            status: STATUS_FOR_OIDC_FAILURE[failure.kind],
            body: EMPTY,
            headers: clearsFor(settled),
          };
        }
        if (tokens.idTokenClaims === undefined)
          return {
            ok: false,
            status: 401,
            body: EMPTY,
            headers: clearsFor(settled),
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
            body: EMPTY,
            headers: clearsFor(settled),
          };
        }
        // Proof: catching account-store failure as null returned409 instead of500 in the mounted failure test.
        const account = await auth.resolveOidcIdentity(identity);
        if (account === null)
          return {
            ok: false,
            status: 409,
            body: EMPTY,
            headers: clearsFor(settled),
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
            ...clearsFor(settled),
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
