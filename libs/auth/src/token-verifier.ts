import { createRemoteJWKSet, jwtVerify } from 'jose';
import { discovery } from 'openid-client';

export interface JwtClaims {
  sub: string;
  [claim: string]: unknown;
}

/**
 * Turns a token into verified claims.
 *
 * @throws When the signature or registered claims do not verify.
 */
export interface TokenVerifier {
  verify(token: string): Promise<JwtClaims>;
}

export interface JwksTokenVerifierOptions {
  audience: string;
  issuer: string;
  jwksUri: URL;
}

/**
 * Verifies RS256 access tokens against an issuer's cached remote JWKS.
 */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JwksTokenVerifierOptions) {
    this.jwks = createRemoteJWKSet(options.jwksUri);
  }

  async verify(token: string): Promise<JwtClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      algorithms: ['RS256'],
      audience: this.options.audience,
      issuer: this.options.issuer,
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('verified token has no subject');
    }
    return { ...payload, sub: payload.sub };
  }
}

/** Builds a lazy verifier from the same discovery contract as the browser flow. */
export function oidcTokenVerifierFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TokenVerifier {
  const issuerUrl = required(env, 'AUTH_ISSUER_DISCOVERY_URL');
  const audience = required(env, 'AUTH_AUDIENCE');
  const clientId = required(env, 'AUTH_CLIENT_ID');
  const clientSecret = required(env, 'AUTH_CLIENT_SECRET');
  let verifier: Promise<JwksTokenVerifier> | undefined;

  return {
    async verify(token) {
      verifier ??= discovery(new URL(issuerUrl), clientId, clientSecret).then((configuration) => {
        const metadata = configuration.serverMetadata();
        if (metadata.jwks_uri === undefined) throw new Error('OIDC discovery has no jwks_uri');
        return new JwksTokenVerifier({
          audience,
          issuer: metadata.issuer,
          jwksUri: new URL(metadata.jwks_uri),
        });
      });
      return (await verifier).verify(token);
    },
  };
}

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is required in AUTH_MODE=oidc`);
  return value;
}
