import type { OidcIdentityStore, User, UserStore } from '@wbs/core';

/**
 * A UserStore backed by a Map, for tests that need `buildApp` to be
 * constructible without a database. It enforces the same uniqueness the
 * SQLite index does — a fixture that accepts duplicate usernames would let a
 * registration test pass against behaviour production does not have.
 */
export interface MemoryUserTable {
  readonly byId: Map<string, User>;
}

export function memoryUserTable(): MemoryUserTable {
  return { byId: new Map() };
}

export function inMemoryUsers(
  table: MemoryUserTable = memoryUserTable(),
): UserStore & OidcIdentityStore {
  const { byId } = table;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */
  return {
    create(user, _stamp) {
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
    resolveOidcIdentity(identity, create, stamp) {
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
        // The account's own date comes off the stamp, as the real store's does:
        // `create` carries the id a first login would mint and nothing else.
        createdAt: stamp.at,
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
