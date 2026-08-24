import type { User, UserStore } from '../repository';
import { AuthService } from '../service/auth.service';

/**
 * A UserStore backed by a Map, for tests that need `buildApp` to be
 * constructible without a database. It enforces the same uniqueness the
 * SQLite index does — a fixture that accepts duplicate usernames would let a
 * registration test pass against behaviour production does not have.
 */
export function inMemoryUsers(): UserStore {
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
  };
}

export const TEST_JWT_KEY = 'test-jwt-signing-key-at-least-32-chars';

export function testAuthService(users: UserStore = inMemoryUsers()): AuthService {
  return new AuthService({ users, jwtKey: TEST_JWT_KEY });
}
