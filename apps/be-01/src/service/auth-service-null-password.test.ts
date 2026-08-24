import { expect, it } from 'bun:test';

import type { UserStore } from '../repository';
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
  const auth = new AuthService({ users, jwtKey: 'x'.repeat(32) });

  const outcome = await auth.login('dany', 'not-a-local-password');
  expect(outcome).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

it('rejects legacy HS256 sessions after OIDC mode is configured', async () => {
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
  const legacy = new AuthService({ users, jwtKey: key });
  const login = await legacy.login('legacy', 'legacy-password');
  if (!login.ok) throw new Error('legacy fixture did not issue a token');

  const oidc = new AuthService({
    users,
    jwtKey: key,
    oidc: {
      groupPrefix: 'dev',
      groupsClaim: 'wbs_groups',
      verifier: { verify: () => Promise.reject(new Error('not an OIDC token')) },
    },
  });

  expect(await oidc.authenticate(login.result.token)).toBeNull();
});
