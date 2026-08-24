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
