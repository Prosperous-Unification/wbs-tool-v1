import {
  browserBindingCookieName,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
} from '@wbs/auth';
import { expect, test } from 'bun:test';

import { EMPTY } from '../http/endpoint';
import { testAuthService } from '../testing/auth-fixture';
import { authOidcEndpoints } from './auth-oidc-endpoints';

test('direct OIDC login binds the exact transaction to the provider and emits an empty redirect', async () => {
  const transactions = new InMemoryOidcTransactionStore({ ttlMs: 300000 });
  const random = ['browser', 'state', 'nonce', 'verifier'];
  const provider: unknown[] = [];
  const [start] = authOidcEndpoints(testAuthService(), {
    mode: 'oidc',
    appOrigin: 'https://app.test',
    redirectUri: 'https://app.test/api/auth/okta/callback',
    groupPrefix: 'dev',
    groupsClaim: 'groups',
    transactions,
    tokens: new InMemoryTokenStore(),
    random: () => {
      const next = random.shift();
      if (next === undefined) throw new Error('random fixture exhausted');
      return next;
    },
    verifier: {
      verify: () => {
        return Promise.reject(new Error('not reached'));
      },
    },
    client: {
      authorizationUrl: (input) => {
        provider.push(input);
        return Promise.resolve(new URL('https://provider.test'));
      },
      exchange: () => {
        return Promise.reject(new Error('not reached'));
      },
      refresh: () => {
        return Promise.reject(new Error('not reached'));
      },
      revoke: () => {
        return Promise.reject(new Error('not reached'));
      },
    },
  });
  const reply = await start.handle({
    params: {},
    query: undefined,
    body: undefined,
    request: {
      method: 'GET',
      url: new URL('https://app.test/api/auth/login'),
      headers: new Headers(),
    },
  });
  expect(reply).toEqual({
    ok: true,
    status: 302,
    body: EMPTY,
    headers: [
      [
        'set-cookie',
        `${browserBindingCookieName('browser')}=browser; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`,
      ],
      ['location', 'https://provider.test/'],
    ],
  });
  expect(provider).toEqual([
    {
      nonce: 'nonce',
      state: 'state',
      verifier: 'verifier',
      redirectUri: 'https://app.test/api/auth/okta/callback',
    },
  ]);
  expect(transactions.consume('browser', 'state')).toEqual({
    outcome: 'consumed',
    nonce: 'nonce',
    verifier: 'verifier',
  });
});
