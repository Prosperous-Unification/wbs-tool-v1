import { expect, it } from 'bun:test';

import type { UserStore } from '../repository';
import { bunPasswordHasher, joseTokenCodec } from '../runtime/bun-runtime';
import { testClock } from '../testing/clock-fixture';
import { AuthService } from './auth.service';

it('rejects password login for an OIDC-only account', async () => {
  const oidcUser = {
    id: 'oidc',
    username: 'dany',
    passwordHash: null,
    email: 'dany@puni.show',
    idpIssuer: 'https://issuer.example',
    idpSub: 'sub-1',
    createdAt: 1,
  };
  const users: UserStore = {
    create: () => Promise.resolve(oidcUser),
    findByUsername: () => Promise.resolve(oidcUser),
    findById: () => Promise.resolve(oidcUser),
  };
  const auth = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec('x'.repeat(32)),
    passwords: bunPasswordHasher,
  });

  const outcome = await auth.login('dany', 'not-a-local-password');
  expect(outcome).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

it('spends the same dummy password-verifier path for unknown and OIDC-only accounts', async () => {
  const oidcUser = {
    id: 'oidc',
    username: 'dany',
    passwordHash: null,
    email: 'dany@puni.show',
    idpIssuer: 'https://issuer.example',
    idpSub: 'sub-1',
    createdAt: 1,
  };
  const users: UserStore = {
    create: () => Promise.resolve(oidcUser),
    findByUsername: (username) => Promise.resolve(username === 'dany' ? oidcUser : null),
    findById: () => Promise.resolve(oidcUser),
  };
  const verified: { password: string; hash: string }[] = [];
  const auth = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec('x'.repeat(32)),
    passwords: {
      ...bunPasswordHasher,
      verify: (password, hash) => {
        verified.push({ password, hash });
        return Promise.resolve(false);
      },
    },
  });

  await auth.login('missing', 'not-a-local-password');
  await auth.login('dany', 'not-a-local-password');

  expect(verified).toHaveLength(2);
  expect(verified[0]?.hash).toBe(verified[1]?.hash);
});

it('never feeds an unbounded login password into the expensive verifier', async () => {
  const user = {
    id: 'password',
    username: 'claire',
    passwordHash: 'real-hash',
    email: null,
    idpIssuer: null,
    idpSub: null,
    createdAt: 1,
  };
  const users: UserStore = {
    create: () => Promise.resolve(user),
    findByUsername: () => Promise.resolve(user),
    findById: () => Promise.resolve(user),
  };
  const verified: { password: string; hash: string }[] = [];
  const auth = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec('x'.repeat(32)),
    passwords: {
      ...bunPasswordHasher,
      verify: (password, hash) => {
        verified.push({ password, hash });
        return Promise.resolve(true);
      },
    },
  });

  const outcome = await auth.login('claire', 'x'.repeat(20_000));

  expect(outcome).toEqual({ ok: false, reason: 'invalid' });
  expect(verified).toHaveLength(1);
  expect(verified[0]?.password.length).toBeLessThanOrEqual(200);
  expect(verified[0]?.hash).not.toBe('real-hash');
});

it('falls back from invalid OIDC only when password sessions are enabled', async () => {
  const legacyUser = {
    id: 'legacy',
    username: 'legacy',
    passwordHash: await Bun.password.hash('legacy-password'),
    email: null,
    idpIssuer: null,
    idpSub: null,
    createdAt: 1,
  };
  const users: UserStore = {
    create: () => Promise.resolve(legacyUser),
    findByUsername: () => Promise.resolve(legacyUser),
    findById: () => Promise.resolve(legacyUser),
  };
  const key = 'x'.repeat(32);
  const legacy = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec(key),
    passwords: bunPasswordHasher,
  });
  const login = await legacy.login('legacy', 'legacy-password');
  if (!login.ok) throw new Error('legacy fixture did not issue a token');

  const invalidOidc = { verify: () => Promise.resolve(null) };
  const oidcOnly = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec(key),
    passwords: bunPasswordHasher,
    oidc: invalidOidc,
    passwordSessions: false,
  });
  const oidcWithPasswordFallback = new AuthService({
    clock: testClock,
    users,
    tokens: joseTokenCodec(key),
    passwords: bunPasswordHasher,
    oidc: invalidOidc,
    passwordSessions: true,
  });

  expect(await oidcOnly.authenticate(login.value.token)).toBeNull();
  expect(await oidcWithPasswordFallback.authenticate(login.value.token)).toEqual({
    id: 'legacy',
    username: 'legacy',
    scopes: ['read', 'write', 'editor'],
  });
});
