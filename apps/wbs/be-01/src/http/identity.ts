import { userFromHeaders } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';
import type { IdentityResolver } from './endpoint';

/**
 * Resolves one endpoint's declared identity through the existing account boundary.
 * User credentials retain cookie/Bearer precedence and are authenticated once.
 * Internal callers use only the configured x-internal-auth secret and never
 * receive a user principal. Unknown verifier/account failures reject unchanged.
 */
export function identityResolver(auth: AuthService, internalAuthSecret: string): IdentityResolver {
  return async (requirement, request) => {
    if (requirement === 'internal') {
      // Proof: bypassing this comparison returned 200 instead of 401 in the
      // mounted internal-secret test (elysia/identity.test.ts).
      return request.headers.get('x-internal-auth') === internalAuthSecret
        ? { ok: true, principal: { kind: 'internal' } }
        : { ok: false, status: 401, body: { error: 'unauthorized' } };
    }
    // Proof: Bearer-only resolution selected grace instead of cookie account
    // ada; a second call failed expected 1/received 2; catch(() => null) changed
    // both account-store outage tests from 500 to 401 (elysia/identity.test.ts).
    const principal = await userFromHeaders(auth, Object.fromEntries(request.headers.entries()));
    // Proof: inventing a fallback account returned 200 instead of 401 in the
    // mounted absent/invalid/retired-credential test (elysia/identity.test.ts).
    if (principal === null) return { ok: false, status: 401, body: { error: 'unauthenticated' } };
    // Proof: independently removing either scope check returned 200 instead
    // of 403 in the mounted scoped-token matrix (elysia/identity.test.ts).
    if (
      (requirement === 'read-scope' && !principal.scopes.includes('read')) ||
      (requirement === 'write-scope' && !principal.scopes.includes('write'))
    ) {
      return { ok: false, status: 403, body: { error: 'insufficient_scope' } };
    }
    return { ok: true, principal };
  };
}
