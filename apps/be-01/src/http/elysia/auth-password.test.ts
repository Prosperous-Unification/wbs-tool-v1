import { expect, spyOn, test } from 'bun:test';

import { authPasswordEndpoints } from '../../controller/auth-password-endpoints';
import { AuthService } from '../../service/auth.service';
import { LoginThrottle } from '../../service/login-throttle';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../../testing/auth-fixture';
import type { IdentityResolver } from '../endpoint';
import { mountEndpoints } from './mount';

const appOrigin = 'https://app.example';
const unusedIdentity: IdentityResolver = () => {
  throw new Error('password endpoints resolve identity in their own protocol handler');
};

function mounted(
  auth = testAuthService(),
  oidc?: { passwordLoginEnabled?: boolean; passwordRegisterEnabled?: boolean },
  maxConcurrent = 8,
) {
  return mountEndpoints(authPasswordEndpoints(auth, oidc, new LoginThrottle({ maxConcurrent })), {
    appOrigin,
    resolveIdentity: unusedIdentity,
  });
}

function loginRequest(
  username: string,
  password: string,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://backend.example/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appOrigin,
      'x-forwarded-for': '192.0.2.1',
      ...headers,
    },
    body: JSON.stringify({ username, password }),
  });
}

test('origin precedes JSON parsing and disabled password admission precedes authentication', async () => {
  const auth = testAuthService();
  const login = spyOn(auth, 'login');
  const register = spyOn(auth, 'register');
  const app = mounted(auth, { passwordLoginEnabled: false, passwordRegisterEnabled: false });
  try {
    const foreign = await app.handle(
      new Request('https://backend.example/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://foreign.example' },
        body: '{',
      }),
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'invalid_origin' });

    const malformed = await app.handle(
      new Request('https://backend.example/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appOrigin },
        body: '{}',
      }),
    );
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ error: 'invalid_body' });

    const disabled = await app.handle(loginRequest('ada', 'lovelace99'));
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: 'not_found' });
    const disabledRegister = await app.handle(
      new Request('https://backend.example/api/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: appOrigin,
          'x-forwarded-for': '192.0.2.1',
        },
        body: JSON.stringify({ username: 'ada', password: 'lovelace99' }),
      }),
    );
    expect(disabledRegister.status).toBe(404);
    expect(await disabledRegister.json()).toEqual({ error: 'not_found' });
    expect(login).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  } finally {
    login.mockRestore();
    register.mockRestore();
  }
});

test('mounted local register, login and me preserve JSON status and content type', async () => {
  const app = mounted();
  const credentials = { username: 'ada', password: 'lovelace99' };
  const register = await app.handle(
    new Request('https://backend.example/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: appOrigin },
      body: JSON.stringify(credentials),
    }),
  );
  expect(register.status).toBe(200);
  expect(register.headers.get('content-type')).toContain('application/json');
  expect(register.headers.get('set-cookie')).toBeNull();
  const session = (await register.json()) as {
    token: string;
    user: { id: string; username: string };
  };

  const login = await app.handle(loginRequest(credentials.username, credentials.password));
  expect(login.status).toBe(200);
  expect(login.headers.get('content-type')).toContain('application/json');
  expect((await login.json()) as object).toMatchObject({ user: session.user });

  const me = await app.handle(
    new Request('https://backend.example/api/auth/me', {
      headers: { authorization: `Bearer ${session.token}` },
    }),
  );
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual({
    user: { ...session.user, scopes: ['read', 'write', 'editor'] },
  });
  const missing = await app.handle(new Request('https://backend.example/api/auth/me'));
  expect(missing.status).toBe(200);
  expect(await missing.json()).toEqual({ user: null });
  const invalid = await app.handle(
    new Request('https://backend.example/api/auth/me', {
      headers: { authorization: 'Bearer invalid' },
    }),
  );
  expect(invalid.status).toBe(401);
  expect(await invalid.json()).toEqual({ error: 'invalid_token' });
});

test('mounted request boundary distinguishes malformed JSON, shape errors and proxy metadata', async () => {
  const auth = testAuthService();
  const login = spyOn(auth, 'login');
  const app = mounted(auth, { passwordLoginEnabled: true });
  try {
    const malformedJson = await app.handle(
      new Request('https://backend.example/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appOrigin },
        body: '{',
      }),
    );
    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.json()).toEqual({ error: 'invalid_json' });
    for (const body of [{ username: 'ada' }, { username: 'ada', password: 'p', extra: true }]) {
      const response = await app.handle(
        new Request('https://backend.example/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: appOrigin },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'invalid_body' });
    }
    const noProxy = await app.handle(
      new Request('https://backend.example/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appOrigin },
        body: JSON.stringify({ username: 'ada', password: 'lovelace99' }),
      }),
    );
    expect(noProxy.status).toBe(400);
    expect(await noProxy.json()).toEqual({ error: 'invalid_client' });
    expect(login).not.toHaveBeenCalled();
  } finally {
    login.mockRestore();
  }
});

test('mounted OIDC password login emits an empty token and one hardened access cookie', async () => {
  const users = inMemoryUsers();
  await users.create(
    {
      id: 'password-user',
      username: 'claire',
      passwordHash: 'stored-hash',
      createdAt: 1,
    },
    { at: 1, by: 'password-user' },
  );
  const auth = new AuthService({
    users,
    jwtKey: TEST_JWT_KEY,
    verifyPassword: () => Promise.resolve(true),
  });
  const response = await mounted(auth, { passwordLoginEnabled: true }).handle(
    loginRequest('claire', 'correct-password'),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('set-cookie')).toMatch(
    /^__Host-wbs_access=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=43200$/,
  );
  expect(await response.json()).toEqual({
    token: '',
    user: { id: 'password-user', username: 'claire' },
  });
});

test('mounted OIDC registration counts successful hashes against the IP admission limit', async () => {
  const auth = testAuthService();
  const register = spyOn(auth, 'register').mockImplementation((username) =>
    Promise.resolve({
      ok: true,
      value: { token: `token-${username}`, user: { id: username, username } },
    }),
  );
  const app = mounted(auth, { passwordRegisterEnabled: true });
  try {
    const missingProxy = await app.handle(
      new Request('https://backend.example/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appOrigin },
        body: JSON.stringify({ username: 'member-0', password: 'correct-password' }),
      }),
    );
    expect(missingProxy.status).toBe(400);
    expect(await missingProxy.json()).toEqual({ error: 'invalid_client' });
    const statuses: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await app.handle(
        new Request('https://backend.example/api/auth/register', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: appOrigin,
            'x-forwarded-for': '192.0.2.20',
          },
          body: JSON.stringify({
            username: `member-${String(attempt)}`,
            password: 'correct-password',
          }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(register).toHaveBeenCalledTimes(5);
  } finally {
    register.mockRestore();
  }
});

test('mounted login retains urlencoded credential admission', async () => {
  const users = inMemoryUsers();
  await users.create(
    { id: 'form-user', username: 'grace', passwordHash: 'stored-hash', createdAt: 1 },
    { at: 1, by: 'form-user' },
  );
  const auth = new AuthService({
    users,
    jwtKey: TEST_JWT_KEY,
    verifyPassword: () => Promise.resolve(true),
  });
  const response = await mounted(auth).handle(
    new Request('https://backend.example/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: appOrigin },
      body: new URLSearchParams({ username: 'grace', password: 'correct-password' }),
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()) as object).toMatchObject({
    user: { id: 'form-user', username: 'grace' },
  });
});

interface PendingVerification {
  resolve: (matches: boolean) => void;
  reject: (cause: Error) => void;
}

function heldLogins(maxConcurrent = 8) {
  const pending: PendingVerification[] = [];
  const users = inMemoryUsers();
  users.findByUsername = (username) =>
    Promise.resolve({ id: username, username, passwordHash: 'stored-hash', createdAt: 1 });
  const auth = new AuthService({
    users,
    jwtKey: TEST_JWT_KEY,
    verifyPassword: () =>
      new Promise<boolean>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  });
  const app = mounted(auth, undefined, maxConcurrent);
  const requests: Promise<Response>[] = [];
  let answered = 0;
  const login = (username: string, ip: string): Promise<Response> => {
    const response = app
      .handle(loginRequest(username, 'long-enough-password', { 'x-forwarded-for': ip }))
      .then((answer) => {
        answered += 1;
        return answer;
      });
    requests.push(response);
    return response;
  };
  const waitForAttempts = async (count: number): Promise<void> => {
    for (let tick = 0; tick < 1_000; tick += 1) {
      if (pending.length + answered >= count) return;
      await Bun.sleep(1);
    }
    throw new Error('login attempts did not reach verification or refusal');
  };
  const waitForVerifiers = async (count: number): Promise<void> => {
    for (let tick = 0; tick < 1_000; tick += 1) {
      if (pending.length >= count) return;
      await Bun.sleep(1);
    }
    expect(pending).toHaveLength(count);
  };
  const finish = async (): Promise<void> => {
    for (const verification of pending) verification.resolve(false);
    await Promise.all(requests);
  };
  return { app, pending, requests, login, waitForAttempts, waitForVerifiers, finish };
}

test('production endpoint admits five of twenty held attempts sharing account and IP', async () => {
  const fixture = heldLogins();
  for (let index = 0; index < 20; index += 1) void fixture.login('ada', '192.0.2.1');
  try {
    await fixture.waitForAttempts(20);
    expect(fixture.pending).toHaveLength(5);
  } finally {
    await fixture.finish();
  }
  expect((await Promise.all(fixture.requests)).filter(({ status }) => status === 429)).toHaveLength(
    15,
  );
});

test('production endpoint applies the global cap and releases it after success, refusal and throw', async () => {
  for (const outcome of ['success', 'refusal', 'error'] as const) {
    const fixture = heldLogins(2);
    const first = fixture.login('ada', '192.0.2.1');
    void fixture.login('grace', '192.0.2.2');
    try {
      await fixture.waitForAttempts(2);
      expect(fixture.pending).toHaveLength(2);
      const verification = fixture.pending[0];
      if (outcome === 'error') verification.reject(new Error('password verifier unavailable'));
      else verification.resolve(outcome === 'success');
      expect((await first).status).toBe(
        outcome === 'success' ? 200 : outcome === 'refusal' ? 401 : 500,
      );

      const replacement = fixture.login('alan', '192.0.2.3');
      await fixture.waitForVerifiers(3);
      expect(fixture.pending).toHaveLength(3);
      fixture.pending[2].resolve(false);
      expect((await replacement).status).toBe(401);
    } finally {
      await fixture.finish();
    }
  }

  const capped = heldLogins(2);
  const attempts = ['ada', 'grace', 'alan'].map((username, index) =>
    capped.login(username, `192.0.2.${String(index + 1)}`),
  );
  try {
    await capped.waitForAttempts(3);
    expect(capped.pending).toHaveLength(2);
  } finally {
    await capped.finish();
  }
  expect((await Promise.all(attempts)).map(({ status }) => status)).toEqual([401, 401, 429]);
});

test('mounted valid-token account lookup failure reaches the server boundary', async () => {
  const users = inMemoryUsers();
  const auth = testAuthService(users);
  const registered = await auth.register('ada', 'lovelace99');
  if (!registered.ok) throw new Error('fixture registration refused');
  const app = mounted(auth);
  const lookup = spyOn(users, 'findById').mockRejectedValue(
    new Error('account lookup unavailable'),
  );
  try {
    const response = await app.handle(
      new Request('https://backend.example/api/auth/me', {
        headers: { authorization: `Bearer ${registered.value.token}` },
      }),
    );
    expect(response.status).toBe(500);
  } finally {
    lookup.mockRestore();
  }
});
