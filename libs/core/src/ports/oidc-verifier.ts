import type { OidcIdentity } from '@wbs/contracts';

/** Verifies an upstream credential; null means the credential is invalid. */
export interface OidcVerifier {
  verify(token: string): Promise<OidcIdentity | null>;
}
