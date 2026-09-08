import { describe, expect, it } from 'bun:test';
import { jwtVerify, SignJWT } from 'jose';

import { buildApp } from '../app';
import { bunPasswordHasher, joseTokenCodec } from '../runtime/bun-runtime';
import { AuthService } from '../service/auth.service';
import { LoginThrottle } from '../service/login-throttle';
import { inMemoryUsers, TEST_JWT_KEY, testAuthService } from '../testing/auth-fixture';
import { testCalendarMarkerService } from '../testing/calendar-marker-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';
import { authPasswordEndpoints } from './auth-password-endpoints';

const TEST_SECRET = 'x'.repeat(32);

function app(auth = testAuthService(), maxConcurrentLogins?: number) {
  return buildApp({
    appOrigin: 'http://localhost',
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth,
    maxConcurrentLogins,
    calendarMarkers: testCalendarMarkerService(),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    savedPlans: testSavedPlanService(),
    steps: testStepService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: TEST_SECRET,
    writes: testWrites(),
    migrationsApplied: true,
  });
}

const json = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/register', () => {
  it('issues a token gw-01 can verify with the shared key', async () => {
    const res = await app().handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { username: string } };
    expect(body.user.username).toBe('ada');

    // The point of the assertion: the token is verifiable by exactly the
    // procedure gw-01 runs on the WebSocket handshake. A token be-01 accepts
    // but gw-01 rejects would still pass a be-01-only test.
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(TEST_JWT_KEY));
    expect(payload['username']).toBe('ada');
    expect(typeof payload.sub).toBe('string');
  });

  it('rejects a duplicate username with 409', async () => {
    const a = app();
    await a.handle(json('/api/auth/register', { username: 'ada', password: 'lovelace99' }));
    const res = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'different1' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('taken');
  });

  it('rejects a short password with 400', async () => {
    const res = await app().handle(
      json('/api/auth/register', { username: 'ada', password: 'short' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for correct credentials', async () => {
    const a = app();
    const registered = await a.handle(
      json('/api/auth/register', { username: 'grace', password: 'hopper2026' }),
    );
    expect(registered.status).toBe(200);
    const res = await a.handle(
      json('/api/auth/login', { username: 'grace', password: 'hopper2026' }),
    );
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { token: string }).token).toBe('string');
  });

  it('returns 401 for a wrong password', async () => {
    const a = app();
    const registered = await a.handle(
      json('/api/auth/register', { username: 'grace', password: 'hopper2026' }),
    );
    expect(registered.status).toBe(200);
    const res = await a.handle(
      json('/api/auth/login', { username: 'grace', password: 'wrongpassword' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown user, with the same body as a wrong password', async () => {
    const res = await app().handle(
      json('/api/auth/login', { username: 'nobody', password: 'whatever12' }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_credentials');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the fixed development identity without a token in local mode', async () => {
    const users = inMemoryUsers();
    const local = new AuthService({
      users,
      identities: users,
      tokens: joseTokenCodec(TEST_JWT_KEY),
      passwords: bunPasswordHasher,
      localIdentity: {
        id: 'local-dev',
        username: 'local-dev',
        scopes: ['read', 'write', 'editor'],
      },
    });
    const res = await buildApp({
      appOrigin: 'http://localhost',
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      calendarMarkers: testCalendarMarkerService(),
      auth: local,
      projects: testProjectService(),
      workItems: testWorkItemService(),
      savedPlans: testSavedPlanService(),
      steps: testStepService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
    }).handle(new Request('http://localhost/api/auth/me'));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('local-dev');
  });

  it('resolves the caller from a bearer token', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe('ada');
  });

  it('rejects a token signed with a different key', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    const sub = (await jwtVerify(token, new TextEncoder().encode(TEST_JWT_KEY))).payload.sub;

    // Signed with a different key, not mutated.
    //
    // The previous version replaced the last character of the signature with
    // 'a'. An HS256 signature is 32 bytes, which base64url-encodes to 43
    // characters whose final one carries only 4 significant bits and 2 spare
    // ones — so it is drawn from `048AEIMQUYcgkosw`, and any two characters
    // sharing `index >> 2` decode to identical bytes. 'a' is index 26; 'Y' is
    // 24; both give 6. A signature ending in 'Y' therefore "tampered" into the
    // byte-identical original, and the assertion that tokens are *verified*
    // rather than decoded passed a genuinely valid token. Roughly one run in
    // sixteen: it survived nine CI runs and failed the tenth with 200.
    const forged = await new SignJWT({ username: 'ada' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub ?? 'unknown')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-different-key-of-at-least-32-chars!'));

    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${forged}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token whose signature bytes have been altered', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };

    // Deterministic: the FIRST character of the signature carries six
    // significant bits, so changing it always changes the decoded bytes —
    // unlike the last character, which has two spare ones.
    const [header, payload, signature] = token.split('.');
    const first = signature.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${first}${signature.slice(1)}`;

    const res = await a.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${tampered}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects the retired x-wbs-token header', async () => {
    const a = app();
    const reg = await a.handle(
      json('/api/auth/register', { username: 'ada', password: 'lovelace99' }),
    );
    const { token } = (await reg.json()) as { token: string };
    // Proof: restoring the x-wbs-token branch in tokenFromHeaders makes this
    // request authenticate and changes the expected 401 into 200.
    const res = await a.handle(
      new Request('http://localhost/api/auth/me', { headers: { 'x-wbs-token': token } }),
    );
    expect(res.status).toBe(401);
  });

  it('returns an explicit signed-out state when no token is sent', async () => {
    // Proof: restoring a 401 here makes Chromium emit a failed-resource console
    // error on every signed-out page; TASK-299 observed it twice under StrictMode.
    const res = await app().handle(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });
});

describe('authentication failure boundaries', () => {
  it('keeps password account lookup faults as server failures', async () => {
    const users = inMemoryUsers();
    const application = app(testAuthService(users));
    const registered = await application.handle(
      json('/api/auth/register', {
        username: 'ada',
        password: 'lovelace99',
      }),
    );
    expect(registered.status).toBe(200);
    const { token } = (await registered.json()) as { token: string };
    const request = () =>
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await application.handle(request())).status).toBe(200);
    expect(
      (
        await application.handle(
          new Request('http://localhost/api/auth/me', {
            headers: { authorization: 'Bearer invalid-token' },
          }),
        )
      ).status,
    ).toBe(401);
    users.findById = () => Promise.reject(new Error('account lookup unavailable'));
    expect((await application.handle(request())).status).toBe(500);
  });
});

interface PendingVerification {
  resolve: (matches: boolean) => void;
  reject: (cause: Error) => void;
}

function heldLogins(maxConcurrentLogins?: number, now?: () => number) {
  const pending: PendingVerification[] = [];
  const users = inMemoryUsers();
  // Hold the expensive verifier; the real auth service still looks up the fixture account and issues tokens.
  users.findByUsername = (username) =>
    Promise.resolve({
      id: username,
      username,
      passwordHash: 'stored-hash',
      createdAt: 1,
    });
  const auth = new AuthService({
    users,
    tokens: joseTokenCodec(TEST_JWT_KEY),
    passwords: {
      ...bunPasswordHasher,
      verify: () =>
        new Promise<boolean>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    },
  });
  const throttle = new LoginThrottle({ now, maxConcurrent: maxConcurrentLogins ?? 8 });
  const application = now === undefined ? app(auth, maxConcurrentLogins) : null;
  const timedLogin = authPasswordEndpoints(auth, undefined, throttle)[1];
  const requests: Promise<{ status: number }>[] = [];
  let refused = 0;
  const login = (username: string, ip: string): Promise<{ status: number }> => {
    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({ username, password: 'long-enough-password' }),
    });
    const response = (
      application === null
        ? timedLogin.handle({
            params: {},
            query: undefined,
            body: { username, password: 'long-enough-password' },
            request: {
              headers: request.headers,
              method: request.method,
              url: new URL(request.url),
            },
          })
        : application.handle(request)
    ).then((response) => {
      if (response.status === 429) refused += 1;
      return response;
    });
    requests.push(response);
    return response;
  };
  const waitForAdmissions = async (count: number): Promise<void> => {
    for (let tick = 0; tick < 1_000; tick += 1) {
      if (pending.length + refused >= count) return;
      await Bun.sleep(1);
    }
    throw new Error('login requests did not reach verification or refusal');
  };
  const finish = async (): Promise<void> => {
    for (const verification of pending) verification.resolve(false);
    await Promise.all(requests);
  };
  return { pending, login, waitForAdmissions, finish, users, throttle };
}

describe('password login admission', () => {
  for (const sharing of ['account and IP', 'account', 'IP'] as const) {
    it(`reserves at most five held attempts sharing an ${sharing}`, async () => {
      const f = heldLogins();
      const requests = Array.from({ length: 20 }, (_, index) =>
        f.login(
          sharing === 'IP' ? `person-${String(index)}` : 'ada',
          sharing === 'account' ? `192.0.2.${String(index)}` : '192.0.2.1',
        ),
      );
      try {
        await f.waitForAdmissions(20);
        expect(f.pending.length).toBe(5);
      } finally {
        await f.finish();
      }
      const statuses = (await Promise.all(requests)).map((response) => response.status);
      expect(statuses.filter((status) => status === 429)).toHaveLength(15);
      expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    });
  }

  it('applies the configured global cap to unrelated accounts', async () => {
    const f = heldLogins(2);
    const requests = ['ada', 'grace', 'alan'].map((username, index) =>
      f.login(username, `192.0.2.${String(index)}`),
    );
    try {
      await f.waitForAdmissions(3);
      expect(f.pending.length).toBe(2);
    } finally {
      await f.finish();
    }
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([
      401, 401, 429,
    ]);
  });

  for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses invalid global cap ${String(cap)} at composition`, () => {
      expect(() => app(testAuthService(), cap)).toThrow('positive integer');
    });
  }

  for (const outcome of ['success', 'refusal', 'error'] as const) {
    it(`releases capacity after ${outcome} while another login remains held`, async () => {
      const f = heldLogins(2);
      const first = f.login('ada', '192.0.2.1');
      void f.login('grace', '192.0.2.2');
      try {
        await f.waitForAdmissions(2);
        expect(f.pending.length).toBe(2);
        const verification = f.pending[0];
        if (outcome === 'error') verification.reject(new Error('password verifier unavailable'));
        else verification.resolve(outcome === 'success');
        expect((await first).status).toBe(
          outcome === 'success' ? 200 : outcome === 'refusal' ? 401 : 500,
        );
        const next = f.login('ada', '192.0.2.1');
        await f.waitForAdmissions(3);
        expect(f.pending.length).toBe(3);
        const replacement = f.pending[2];
        replacement.resolve(false);
        expect((await next).status).toBe(401);
      } finally {
        await f.finish();
      }
    });
  }

  it('bounds unrelated logins under the default composition cap', async () => {
    const f = heldLogins();
    for (let index = 0; index < 10; index += 1)
      void f.login(`person-${String(index)}`, `192.0.2.${String(index)}`);
    try {
      await f.waitForAdmissions(10);
      expect(f.pending.length).toBe(8);
    } finally {
      await f.finish();
    }
  });

  it('retains pending reservations when the failure window expires', async () => {
    let now = 1_000;
    const f = heldLogins(8, () => now);
    for (let index = 0; index < 5; index += 1) void f.login('ada', `192.0.2.${String(index)}`);
    try {
      await f.waitForAdmissions(5);
      expect(f.pending.length).toBe(5);
      now = 62_000;
      const sixth = f.login('ada', '192.0.2.10');
      await f.waitForAdmissions(6);
      expect(f.pending.length).toBe(5);
      expect((await sixth).status).toBe(429);
    } finally {
      await f.finish();
    }
  });

  it('retains other pending reservations when one login succeeds', async () => {
    const f = heldLogins();
    const first = f.login('ada', '192.0.2.1');
    for (let index = 0; index < 4; index += 1) void f.login('ada', `192.0.2.${String(index + 2)}`);
    try {
      await f.waitForAdmissions(5);
      const verification = f.pending[0];
      verification.resolve(true);
      expect((await first).status).toBe(200);
      void f.login('ada', '192.0.2.10');
      await f.waitForAdmissions(6);
      expect(f.pending.length).toBe(6);
      const seventh = f.login('ada', '192.0.2.11');
      await f.waitForAdmissions(7);
      expect(f.pending.length).toBe(6);
      expect((await seventh).status).toBe(429);
    } finally {
      await f.finish();
    }
  });

  it('releases capacity when account lookup throws before verification', async () => {
    const f = heldLogins(1);
    const lookup = f.users.findByUsername.bind(f.users);
    f.users.findByUsername = () => Promise.reject(new Error('account store unavailable'));
    expect((await f.login('ada', '192.0.2.1')).status).toBe(500);
    f.users.findByUsername = lookup;
    const next = f.login('ada', '192.0.2.1');
    try {
      await f.waitForAdmissions(1);
      expect(f.pending.length).toBe(1);
      const verification = f.pending[0];
      verification.resolve(false);
      expect((await next).status).toBe(401);
    } finally {
      await f.finish();
    }
  });

  it('does not evict a pending account while pruning a full failure map', async () => {
    let now = 1_000;
    const f = heldLogins(8, () => now);
    void f.login('ada', '192.0.2.1');
    try {
      await f.waitForAdmissions(1);
      for (let index = 0; index < 4_999; index += 1) {
        f.throttle.recordFailure(`other-${String(index)}`, `other-ip-${String(index)}`);
      }
      now = 62_000;
      // This asks about other keys, so expiry reaches the full-map eviction path.
      f.throttle.canAttempt('fresh-account', 'fresh-ip');
      for (let index = 0; index < 5; index += 1)
        void f.login('ada', `192.0.2.${String(index + 2)}`);
      await f.waitForAdmissions(6);
      expect(f.pending.length).toBe(5);
    } finally {
      await f.finish();
    }
  });

  it('starts the failure window when verification refuses, not when it was admitted', async () => {
    let now = 1_000;
    const f = heldLogins(8, () => now);
    for (let index = 0; index < 5; index += 1) void f.login('ada', `192.0.2.${String(index)}`);
    await f.waitForAdmissions(5);
    now = 31_000;
    await f.finish();
    now = 62_000;
    const sixth = f.login('ada', '192.0.2.10');
    try {
      await f.waitForAdmissions(6);
      expect(f.pending.length).toBe(5);
      expect((await sixth).status).toBe(429);
    } finally {
      await f.finish();
    }
    now = 92_000;
    const seventh = f.login('ada', '192.0.2.11');
    try {
      await f.waitForAdmissions(7);
      expect(f.pending.length).toBe(6);
      const verification = f.pending[5];
      verification.resolve(false);
      expect((await seventh).status).toBe(401);
    } finally {
      await f.finish();
    }
  });
});
