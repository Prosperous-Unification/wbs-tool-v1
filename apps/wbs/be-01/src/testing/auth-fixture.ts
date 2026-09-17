import { buildOidcVerifier, type OidcIdentityOptions, type TokenVerifier } from '@wbs/auth';
import { inMemoryUsers } from '@wbs/store-memory/auth-fixture';

import type { OidcIdentityStore, UserStore } from '../repository';
import { bunPasswordHasher, joseTokenCodec } from '../runtime/bun-runtime';
import { AuthService } from '../service/auth.service';
import { testClock } from './clock-fixture';

export const TEST_JWT_KEY = 'test-jwt-signing-key-at-least-32-chars';

export interface TestOidcAuthentication extends OidcIdentityOptions {
  verifier: TokenVerifier;
}

export function testAuthService(
  users: UserStore & OidcIdentityStore = inMemoryUsers(),
  oidc?: TestOidcAuthentication,
): AuthService {
  return new AuthService({
    clock: testClock,
    users,
    identities: users,
    // The real adapters over the test key: a fake codec would make every token
    // in these suites a string this deployment cannot read, and a fake hasher
    // would make `register` a claim about nothing.
    tokens: joseTokenCodec(TEST_JWT_KEY),
    passwords: bunPasswordHasher,
    oidc: oidc === undefined ? undefined : buildOidcVerifier(oidc.verifier, oidc),
    passwordSessions: oidc !== undefined,
  });
}

export { inMemoryUsers } from '@wbs/store-memory/auth-fixture';
