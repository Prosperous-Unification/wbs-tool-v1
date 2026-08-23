import { createRemoteJWKSet, jwtVerify } from 'jose';

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
