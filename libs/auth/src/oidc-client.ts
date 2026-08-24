import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  type Configuration,
  discovery,
  refreshTokenGrant,
  tokenRevocation,
} from 'openid-client';

export interface BrowserOidcTokenSet {
  accessToken: string;
  expiresIn: number;
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
  let discovered: Promise<Configuration> | undefined;
  const config = () => (discovered ??= discovery(issuer, clientId, clientSecret));

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

function tokenSet(result: {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}): BrowserOidcTokenSet {
  if (result.expires_in === undefined || result.expires_in <= 0)
    throw new Error('OIDC access token has no positive expiry');
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in,
    refreshToken: result.refresh_token,
  };
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is required in AUTH_MODE=oidc`);
  return value;
}
