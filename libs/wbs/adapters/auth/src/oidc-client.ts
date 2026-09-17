import type { Configuration } from 'openid-client';
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  refreshTokenGrant,
  tokenRevocation,
} from 'openid-client';

export interface BrowserOidcTokenSet {
  accessToken: string;
  expiresIn: number;
  idTokenClaims?: Readonly<Record<string, unknown>>;
  refreshToken?: string;
}

export interface BrowserOidcClient {
  authorizationUrl(input: {
    nonce: string;
    redirectUri: string;
    state: string;
    verifier: string;
  }): Promise<URL>;
  exchange(
    request: Request,
    checks: { nonce: string; state: string; verifier: string },
  ): Promise<BrowserOidcTokenSet>;
  refresh(refreshToken: string): Promise<BrowserOidcTokenSet>;
  revoke(refreshToken: string): Promise<void>;
}

/**
 * Why a callback from another issuer is refused here rather than left to the
 * library.
 *
 * `oauth4webapi`'s `validateAuthResponse` already refuses a callback whose
 * `iss` is not this authorization server's, and one that omits `iss` when the
 * server advertises `authorization_response_iss_parameter_supported`. It
 * refuses both as `OAUTH_INVALID_RESPONSE` — a code {@link classifyOidcFailure}
 * deliberately does not table, because only the layer that built the request
 * knows what it asked for. Every such callback therefore reached the route's
 * `defect` arm: a 500 and an `error`-level log, chosen by a caller who holds
 * their own state and binding. That bucket means "this deployment is wrong",
 * and nothing outside the deployment should be able to fill it. (Peer pass 20.)
 *
 * The route already refuses four callbacks it could not have started — a
 * missing `code`, and `response`, `id_token` or `token` from a response mode it
 * never asks for — with a bodiless 400 and the binding cleared. This is the
 * fifth and takes the same exit. It cannot be a route guard like those four,
 * because the issuer identifier exists only once discovery has resolved, and
 * that resolution lives in this module's closure.
 */
export type OidcCallbackRefusalReason = 'issuer_mismatch' | 'issuer_missing';

/**
 * The context-specific owned failure {@link BrowserOidcClient.exchange} rejects
 * with when the callback cannot belong to a login this deployment started.
 *
 * A distinct type rather than an `OidcFailure`: the classifier answers "whose
 * move is this failure", and this is not a failure of the exchange at all — the
 * exchange was never attempted. The reason is a closed union for the same
 * purpose `OidcFailureReason` is closed, so the log line still carries no
 * provider or library string.
 */
export class OidcCallbackRefused extends Error {
  readonly reason: OidcCallbackRefusalReason;

  constructor(reason: OidcCallbackRefusalReason) {
    super(`oidc callback refused: ${reason}`);
    this.name = 'OidcCallbackRefused';
    this.reason = reason;
  }
}

/**
 * Narrows a `catch` binding, which is `unknown`, so the route asks a question
 * instead of reaching for the class.
 */
export function isOidcCallbackRefused(value: unknown): value is OidcCallbackRefused {
  return value instanceof OidcCallbackRefused;
}

/**
 * The decidable half of that refusal, separated so each arm can be asserted
 * against a metadata literal rather than a provider. It is one of three layers,
 * and the split matters because a control showed two of them are not
 * substitutes: the arms are proven here, the fact that `exchange` hands this
 * function `serverMetadata()` rather than the configured discovery URL is proven
 * through {@link browserOidcClientFromEnv}'s injected `discover`, and the answer
 * the route gives the rejection is proven by an integration case whose
 * `exchange` is a fake.
 *
 * **`metadata.issuer` is the Issuer Identifier, never
 * `AUTH_ISSUER_DISCOVERY_URL`.** The two are only required to be related, never
 * equal: Okta's discovery URL ends `/.well-known/openid-configuration` and its
 * issuer identifier does not, so comparing a callback against the configured
 * discovery URL would refuse every real login. The value comes from
 * `Configuration.serverMetadata().issuer`.
 *
 * An empty `?iss=` counts as absent, which is how `oauth4webapi` reads it, so
 * the boundary cannot answer one way for `?iss=` and another for a callback
 * carrying no `iss` at all.
 */
export function refuseCallbackFromAnotherIssuer(
  callback: URL,
  metadata: { authorization_response_iss_parameter_supported?: boolean; issuer: string },
): void {
  const sent = callback.searchParams.get('iss') ?? '';
  if (sent === '') {
    if (metadata.authorization_response_iss_parameter_supported === true)
      throw new OidcCallbackRefused('issuer_missing');
    return;
  }
  if (sent !== metadata.issuer) throw new OidcCallbackRefused('issuer_mismatch');
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * `discover` is injectable for the same reason `cacheWhileItSucceeds`'s `load`
 * is, and a negative control is why it had to become so. `discovery()` performs
 * a real request, so nothing below it could be asserted without a live
 * authorization server — and a control that changed `exchange` to compare a
 * callback against `AUTH_ISSUER_DISCOVERY_URL` instead of the resolved Issuer
 * Identifier, the one mistake the comment on
 * {@link refuseCallbackFromAnotherIssuer} exists to warn about, left the whole
 * suite green (486 pass / 0 fail). The check was proven and the wiring to it was
 * not. Production never passes this.
 */
export function browserOidcClientFromEnv(
  env: Environment,
  options: { discover?: () => Promise<Configuration> } = {},
): BrowserOidcClient {
  const issuer = new URL(required(env, 'AUTH_ISSUER_DISCOVERY_URL'));
  const clientId = required(env, 'AUTH_CLIENT_ID');
  const clientSecret = required(env, 'AUTH_CLIENT_SECRET');
  const scope = env['AUTH_SCOPE'] ?? 'openid profile email offline_access';
  const audience = env['AUTH_AUDIENCE'];
  const config = cacheWhileItSucceeds(
    options.discover ?? (() => discovery(issuer, clientId, clientSecret)),
  );

  return {
    async authorizationUrl(input) {
      const parameters: Record<string, string> = {
        code_challenge: await calculatePKCECodeChallenge(input.verifier),
        code_challenge_method: 'S256',
        nonce: input.nonce,
        redirect_uri: input.redirectUri,
        response_type: 'code',
        scope,
        state: input.state,
      };
      if (audience !== undefined && audience !== '') parameters['audience'] = audience;
      return buildAuthorizationUrl(await config(), parameters);
    },
    async exchange(request, checks) {
      // `config()` is awaited first and its rejection is left untouched: a
      // provider that is down during discovery must still reach the classifier
      // as an outage rather than as the refusal below. Only once the metadata
      // resolves is there an issuer identifier to compare a callback against.
      const resolved = await config();
      refuseCallbackFromAnotherIssuer(new URL(request.url), resolved.serverMetadata());
      const result = await authorizationCodeGrant(resolved, request, {
        expectedNonce: checks.nonce,
        expectedState: checks.state,
        pkceCodeVerifier: checks.verifier,
      });
      return tokenSet(result);
    },
    async refresh(refreshToken) {
      return tokenSet(await refreshTokenGrant(await config(), refreshToken));
    },
    async revoke(refreshToken) {
      const resolved = await config();
      if (resolved.serverMetadata().revocation_endpoint !== undefined) {
        await tokenRevocation(resolved, refreshToken, { token_type_hint: 'refresh_token' });
      }
    },
  };
}

/**
 * Discovery is expensive and its result is stable, so it is loaded once and
 * shared. Caching the *promise* is what makes that sharing work — and it is
 * also how a promise that settles as a rejection gets cached, which is a very
 * different thing to cache.
 *
 * A provider that is down, a DNS blip or a TLS handshake that fails during a
 * restart all reject the first `discovery()`. If that rejection stays cached,
 * every later sign-in awaits the same stale error and SSO stays broken until
 * the process restarts — long after the provider recovered. This task exists
 * because an outage is currently indistinguishable from a bad code; an outage
 * that never ends when the outage ends is the sharper half of that.
 *
 * So: share one attempt while it is in flight or has succeeded, and forget it
 * if it fails, which lets the next caller retry. The rejection itself is
 * rethrown untouched, so the classifier upstream still sees the real cause.
 *
 * **Forgetting a failure immediately would trade one bug for a smaller one**,
 * and peer pass 19 was right to say so: `/api/auth/login` reaches `config()`,
 * so an unauthenticated caller could drive one outbound discovery per request
 * for as long as the provider was down, multiplied by every replica. The
 * remembered failure is therefore held for a short cooldown and re-served
 * without a load — long enough that an outage costs a bounded rate rather than
 * a request-rate flood, short enough that recovery is not noticeably delayed.
 * The window is jittered so replicas that failed together do not retry
 * together.
 *
 * `now` and `jitter` are injectable for the same reason `load` is: the cooldown
 * is asserted with a clock the test owns, not with a real one it has to wait
 * for.
 */
export function cacheWhileItSucceeds<T>(
  load: () => Promise<T>,
  options: { cooldownMs?: number; jitter?: () => number; now?: () => number } = {},
): () => Promise<T> {
  const cooldownMs = options.cooldownMs ?? 5_000;
  const jitter = options.jitter ?? Math.random;
  const now = options.now ?? Date.now;
  let attempt: Promise<T> | undefined;
  // Set only while `attempt` is a *rejected* promise. It is therefore both the
  // cooldown deadline and the answer to "did the held attempt fail?".
  let retryAfter: number | undefined;
  return () => {
    if (attempt !== undefined) {
      // In flight, or succeeded: `retryAfter` is unset and the held promise is
      // the shared answer. Failed and still cooling: the *same* rejected
      // promise is re-served, which is what makes this a cooldown rather than
      // a delay — the caller gets its answer now, and gets the original cause
      // rather than a rewrapped one, so the classifier upstream still works.
      if (retryAfter === undefined || now() < retryAfter) return attempt;
      // Failed, and the window has closed: this caller reloads.
      attempt = undefined;
    }
    // **Cleared before the load, not after it.** `retryAfter` means "the held
    // promise is a rejected one", so leaving it set while the retry is in
    // flight would make every concurrent caller read the new pending attempt
    // as an expired failure and start its own load — losing single-flight at
    // exactly the moment the fleet is recovering, which is the herd this
    // cooldown exists to prevent. A test caught this: `lets exactly one caller
    // retry once the cooldown expires` hung, because the second caller
    // replaced the first's attempt with a fresh one nobody resolved.
    retryAfter = undefined;
    // Neither settlement callback can race the assignment below: both are
    // microtasks and this function returns synchronously.
    attempt = load().then(
      (value) => {
        retryAfter = undefined;
        return value;
      },
      (error: unknown) => {
        // Half the window plus up to another half, so a fleet that failed on
        // the same provider does not line up on the same retry instant.
        retryAfter = now() + cooldownMs * (0.5 + jitter() * 0.5);
        throw error;
      },
    );
    return attempt;
  };
}

function tokenSet(result: {
  access_token: string;
  claims?: () => Readonly<Record<string, unknown>> | undefined;
  expires_in?: number;
  refresh_token?: string;
}): BrowserOidcTokenSet {
  if (result.expires_in === undefined || result.expires_in <= 0)
    throw new Error('OIDC access token has no positive expiry');
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in,
    idTokenClaims: result.claims?.(),
    refreshToken: result.refresh_token,
  };
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is required in AUTH_MODE=oidc`);
  return value;
}
