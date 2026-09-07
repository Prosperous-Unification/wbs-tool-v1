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
 */
export function cacheWhileItSucceeds<T>(load: () => Promise<T>): () => Promise<T> {
  let attempt: Promise<T> | undefined;
  return () => {
    if (attempt !== undefined) return attempt;
    // `attempt = undefined` inside the catch cannot race the assignment below:
    // the callback is a microtask and this function returns synchronously.
    attempt = load().catch((error: unknown) => {
      attempt = undefined;
      throw error;
    });
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
