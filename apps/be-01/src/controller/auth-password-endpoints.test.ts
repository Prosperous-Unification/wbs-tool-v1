import { expect, spyOn, test } from 'bun:test';

import type { User } from '../repository';
import { bunPasswordHasher, joseTokenCodec } from '../runtime/bun-runtime';
import { AuthService } from '../service/auth.service';
import { LoginThrottle } from '../service/login-throttle';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../testing/auth-fixture';
import { authPasswordEndpoints } from './auth-password-endpoints';

const request = (path: string, method = 'POST') => ({
  method,
  url: new URL(`https://backend.example${path}`),
  headers: new Headers({ origin: 'https://app.example', 'x-forwarded-for': '192.0.2.1' }),
});

test('direct password bindings preserve service refusals and local bearer sessions', async () => {
  const auth = testAuthService();
  const endpoints = authPasswordEndpoints(auth, undefined, new LoginThrottle({ maxConcurrent: 8 }));
  const credentials = { username: 'ada', password: 'lovelace99' };
  const registered = await endpoints[0].handle({
    params: {},
    query: undefined,
    body: credentials,
    request: request('/api/auth/register'),
  });
  if (!registered.ok) throw new Error('registration refused');
  expect(registered.body.user.username).toBe('ada');
  expect(registered.body.token.length).toBeGreaterThan(20);
  expect(registered.headers).toBeUndefined();

  expect(
    await endpoints[0].handle({
      params: {},
      query: undefined,
      body: credentials,
      request: request('/api/auth/register'),
    }),
  ).toEqual({ ok: false, status: 409, body: { error: 'taken' } });
  expect(
    await endpoints[0].handle({
      params: {},
      query: undefined,
      body: { username: 'x', password: 'short' },
      request: request('/api/auth/register'),
    }),
  ).toEqual({ ok: false, status: 400, body: { error: 'invalid' } });
  expect(
    await endpoints[1].handle({
      params: {},
      query: undefined,
      body: { ...credentials, password: 'wrong-password' },
      request: request('/api/auth/login'),
    }),
  ).toEqual({ ok: false, status: 401, body: { error: 'invalid_credentials' } });
});

test('direct me binding distinguishes signed out, invalid credentials and store failures', async () => {
  const users = inMemoryUsers();
  const auth = testAuthService(users);
  const endpoints = authPasswordEndpoints(auth, undefined, new LoginThrottle({ maxConcurrent: 8 }));
  const registered = await auth.register('ada', 'lovelace99');
  if (!registered.ok) throw new Error('fixture registration refused');
  const input = {
    params: {},
    query: undefined,
    body: undefined,
    request: {
      ...request('/api/auth/me', 'GET'),
      headers: new Headers({ authorization: `Bearer ${registered.value.token}` }),
    },
  };
  expect(await endpoints[2].handle(input)).toEqual({
    ok: true,
    status: 200,
    body: {
      user: { id: registered.value.user.id, username: 'ada', scopes: ['read', 'write', 'editor'] },
    },
  });
  expect(
    await endpoints[2].handle({
      ...input,
      request: { ...input.request, headers: new Headers({ authorization: 'Bearer invalid' }) },
    }),
  ).toEqual({ ok: false, status: 401, body: { error: 'invalid_token' } });
  expect(
    await endpoints[2].handle({
      ...input,
      request: { ...input.request, headers: new Headers() },
    }),
  ).toEqual({ ok: true, status: 200, body: { user: null } });

  const failure = new Error('account lookup unavailable');
  const lookup = spyOn(users, 'findById').mockRejectedValue(failure);
  try {
    expect(await endpoints[2].handle(input).catch((cause: unknown) => cause)).toBe(failure);
  } finally {
    lookup.mockRestore();
  }
});

test('direct login releases its reservation after an account-store failure', async () => {
  const users = inMemoryUsers();
  const failure = new Error('account store unavailable');
  const lookup = spyOn(users, 'findByUsername').mockRejectedValueOnce(failure);
  const auth = testAuthService(users);
  const endpoints = authPasswordEndpoints(auth, undefined, new LoginThrottle({ maxConcurrent: 1 }));
  const input = {
    params: {},
    query: undefined,
    body: { username: 'ada', password: 'lovelace99' },
    request: request('/api/auth/login'),
  };
  try {
    expect(await endpoints[1].handle(input).catch((cause: unknown) => cause)).toBe(failure);
    expect(await endpoints[1].handle(input)).toEqual({
      ok: false,
      status: 401,
      body: { error: 'invalid_credentials' },
    });
  } finally {
    lookup.mockRestore();
  }
});

test('OIDC password success keeps the token in the hardened access cookie', async () => {
  const users = inMemoryUsers();
  const auth = new AuthService({
    users,
    identities: users,
    tokens: joseTokenCodec(TEST_JWT_KEY),
    passwords: { ...bunPasswordHasher, verify: () => Promise.resolve(true) },
  });
  await users.create(
    {
      id: 'password-user',
      username: 'claire',
      passwordHash: 'stored-hash',
      createdAt: 1,
    } satisfies User,
    { at: 1, by: 'password-user' },
  );
  const endpoints = authPasswordEndpoints(
    auth,
    { passwordLoginEnabled: true, passwordRegisterEnabled: false },
    new LoginThrottle({ maxConcurrent: 8 }),
  );
  const login = await endpoints[1].handle({
    params: {},
    query: undefined,
    body: { username: 'claire', password: 'correct-password' },
    request: request('/api/auth/login'),
  });
  if (!login.ok) throw new Error('login refused');
  expect(login.body).toEqual({ token: '', user: { id: 'password-user', username: 'claire' } });
  expect(login.headers?.[0]?.[0]).toBe('set-cookie');
  expect(login.headers?.[0]?.[1]).toMatch(
    /^__Host-wbs_access=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=43200$/,
  );
});
