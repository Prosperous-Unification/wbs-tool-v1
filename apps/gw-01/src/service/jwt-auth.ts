import type { JwtClaims, TokenVerifier } from '@wbs/auth';
import { errors as joseErrors, jwtVerify } from 'jose';
export type { JwtClaims, TokenVerifier } from '@wbs/auth';

export interface JwtVerifierOptions {
  current: Uint8Array;
  previous?: Uint8Array;
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
