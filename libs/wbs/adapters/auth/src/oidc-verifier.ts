import type { OidcIdentity } from '@wbs/contracts';
import type { OidcVerifier } from '@wbs/core';
import { errors } from 'jose';

import { oidcIdentityFromClaims, type OidcIdentityOptions } from './oidc-identity';
import type { TokenVerifier } from './token-verifier';

/** Builds the application verifier over the JOSE claims adapter. */
export function buildOidcVerifier(
  verifier: TokenVerifier,
  options: OidcIdentityOptions,
): OidcVerifier {
  return {
    async verify(token): Promise<OidcIdentity | null> {
      try {
        return oidcIdentityFromClaims(await verifier.verify(token), options);
      } catch (cause) {
        // Proof: returning null for every verifier failure made the mounted
        // discovery-outage case answer 401 instead of 500
        // (controller/oidc.integration.test.ts).
        if (isInvalidCredential(cause)) return null;
        throw cause;
      }
    },
  };
}

/** Credential failures only; malformed JWKS, discovery and network faults propagate. */
function isInvalidCredential(cause: unknown): boolean {
  return (
    cause instanceof errors.JWTClaimValidationFailed ||
    cause instanceof errors.JWTExpired ||
    cause instanceof errors.JWTInvalid ||
    cause instanceof errors.JWSInvalid ||
    cause instanceof errors.JWSSignatureVerificationFailed ||
    cause instanceof errors.JOSEAlgNotAllowed ||
    cause instanceof errors.JWKSNoMatchingKey
  );
}
