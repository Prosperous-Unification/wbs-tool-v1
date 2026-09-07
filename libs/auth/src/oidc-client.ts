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

type Environment = Readonly<Record<string, string | undefined>>;

export function browserOidcClientFromEnv(env: Environment): BrowserOidcClient {
  const issuer = new URL(required(env, 'AUTH_ISSUER_DISCOVERY_URL'));
  const clientId = required(env, 'AUTH_CLIENT_ID');
  const clientSecret = required(env, 'AUTH_CLIENT_SECRET');
  const scope = env['AUTH_SCOPE'] ?? 'openid profile email offline_access';
  const audience = env['AUTH_AUDIENCE'];
  const config = cacheWhileItSucceeds(() => discovery(issuer, clientId, clientSecret));

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
      const result = await authorizationCodeGrant(await config(), request, {
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
