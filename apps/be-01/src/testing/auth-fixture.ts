import type { OidcIdentityOptions, TokenVerifier } from '@wbs/auth';

import type { OidcIdentityStore, User, UserStore } from '../repository';
import { AuthService } from '../service/auth.service';

/**
 * A UserStore backed by a Map, for tests that need `buildApp` to be
 * constructible without a database. It enforces the same uniqueness the
 * SQLite index does — a fixture that accepts duplicate usernames would let a
 * registration test pass against behaviour production does not have.
 */
export function inMemoryUsers(): UserStore & OidcIdentityStore {
  const byId = new Map<string, User>();
  return {
    create(user) {
      for (const existing of byId.values()) {
        if (existing.username === user.username) return Promise.resolve(null);
      }
      byId.set(user.id, user);
      return Promise.resolve(user);
    },
    findByUsername(username) {
      for (const user of byId.values()) {
        if (user.username === username) return Promise.resolve(user);
      }
      return Promise.resolve(null);
    },
    findById(id) {
      return Promise.resolve(byId.get(id) ?? null);
    },
    resolveOidcIdentity(identity, create) {
      for (const user of byId.values()) {
        if (user.idpIssuer === identity.issuer && user.idpSub === identity.subject) {
          return Promise.resolve(user);
        }
      }
      const email = identity.emailVerified ? (identity.email?.toLowerCase() ?? null) : null;
      if (email !== null) {
        for (const user of byId.values()) {
          if (user.email?.toLowerCase() === email) return Promise.resolve(null);
          if (
            user.username.toLowerCase() === email &&
            user.username.includes('@') &&
            user.idpIssuer == null &&
            user.idpSub == null
          ) {
            Object.assign(user, {
              email,
              idpIssuer: identity.issuer,
              idpSub: identity.subject,
            });
            return Promise.resolve(user);
          }
        }
      }
      const local = identity.email?.split('@', 1)[0]?.toLowerCase() ?? 'oidc';
      const user: User = {
        ...create,
        username: `${local}-test`,
        passwordHash: null,
        email,
        idpIssuer: identity.issuer,
        idpSub: identity.subject,
      };
      byId.set(user.id, user);
      return Promise.resolve(user);
    },
  };
}

export const TEST_JWT_KEY = 'test-jwt-signing-key-at-least-32-chars';

export interface TestOidcAuthentication extends OidcIdentityOptions {
  verifier: TokenVerifier;
}

export function testAuthService(
  users: UserStore & OidcIdentityStore = inMemoryUsers(),
  oidc?: TestOidcAuthentication,
): AuthService {
  return new AuthService({
    users,
    identities: users,
    jwtKey: TEST_JWT_KEY,
    oidc,
    passwordSessions: oidc !== undefined,
  });
}
