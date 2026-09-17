import type { JwtClaims, TokenVerifier } from '@wbs/auth';
import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
export type { JwtClaims, TokenVerifier } from '@wbs/auth';

export interface JwtVerifierOptions {
  current: Uint8Array;
  previous?: Uint8Array;
  /** OIDC verifier used for every token not explicitly marked HS256. */
  primary?: TokenVerifier;
}

/**
 * Turns a token into the claims it carries, or throws.
 *
 * Named separately from {@link JwtVerifier} so a caller can be handed one that
 * resolves when the caller chooses — which is the only way to test what gw-01's
 * `/ws` handlers do while a verification is still in flight.
 *
 * @throws When the token does not verify.
 */
export class JwtVerifier implements TokenVerifier {
  constructor(private readonly opts: JwtVerifierOptions) {}

  async verify(token: string): Promise<JwtClaims> {
    if (this.opts.primary !== undefined && !isPasswordSession(token)) {
      // Do not catch this. A provider/JWKS outage must remain distinguishable
      // from a bad local token instead of silently degrading to HS256.
      return await this.opts.primary.verify(token);
    }
    try {
      const { payload } = await jwtVerify(token, this.opts.current);
      return payload as JwtClaims;
    } catch (err) {
      if (err instanceof joseErrors.JWSSignatureVerificationFailed && this.opts.previous) {
        const { payload } = await jwtVerify(token, this.opts.previous);
        return payload as JwtClaims;
      }
      throw err;
    }
  }
}

function isPasswordSession(token: string): boolean {
  try {
    return decodeProtectedHeader(token).alg === 'HS256';
  } catch {
    // Opaque access tokens are valid provider input even though they have no
    // JOSE header. Let the configured OIDC verifier decide their validity.
    return false;
  }
}
