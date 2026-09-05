import type { JwtClaims } from '@wbs/auth';
import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { inMemoryUsers, testAuthService } from '../testing/auth-fixture';
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
import * as authModule from './auth.controller';

const now = Date.UTC(2026, 7, 23);

const claims = {
  iss: 'https://idp.test',
  sub: 'subject-1',
  email: 'DANY@PUNI.SHOW',
  email_verified: true,
  wbs_groups: ['dev:wbs:read', 'dev:wbs:write'],
};

interface RegisteredRoute {
  method: string;
  path: string;
}

function registeredRoutes(value: unknown): RegisteredRoute[] {
  if (!Array.isArray(value)) throw new Error('Elysia route table is not an array');
  const candidates: unknown[] = value;
  return candidates.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null)
      throw new Error('Elysia route entry is not an object');
    const record = candidate as Record<string, unknown>;
    const path = record['path'];
    const rawMethods = record['method'];
    if (typeof path !== 'string') throw new Error('Elysia route path is not a string');
    const methods: string[] = [];
    for (const method of Array.isArray(rawMethods) ? (rawMethods as unknown[]) : [rawMethods]) {
      if (typeof method !== 'string') throw new Error('Elysia route method is not a string');
      methods.push(method);
    }
    return methods.map((method) => ({ method, path }));
  });
}

function fixture(
  idTokenClaims?: JwtClaims,
  routeOverrides: {
    passwordLoginEnabled?: boolean;
    passwordRegisterEnabled?: boolean;
  } = {},
) {
  const exchangeClaims = arguments.length === 0 ? claims : idTokenClaims;
  const calls = {
    authorize: [] as unknown[],
    exchange: [] as unknown[],
    refresh: [] as string[],
    revoke: [] as string[],
  };
  const client = {
    authorizationUrl: (input: unknown) => {
      calls.authorize.push(input);
      return Promise.resolve(new URL('https://idp.test/authorize?client_id=wbs'));
    },
    exchange: (request: Request, checks: unknown) => {
      calls.exchange.push({ request, checks });
      return Promise.resolve({
        accessToken: 'access-1',
        expiresIn: 900,
        refreshToken: 'refresh-1',
        idTokenClaims: exchangeClaims,
      });
    },
    refresh: (token: string) => {
      calls.refresh.push(token);
      return Promise.resolve({
        accessToken: 'access-2',
        expiresIn: 600,
        refreshToken: 'refresh-2',
      });
    },
    revoke: (token: string) => {
      calls.revoke.push(token);
      return Promise.resolve();
    },
  };
  const transactions = new InMemoryOidcTransactionStore({ now: () => now, ttlMs: 300_000 });
  const tokens = new InMemoryTokenStore({ now: () => now });
  const random = ['binding-1', 'state-1', 'nonce-1', 'verifier-1', 'session-1'];
  const oidc = {
    appOrigin: 'https://dev.wbs.test',
    client,
    groupPrefix: 'dev',
    groupsClaim: 'wbs_groups',
    mode: 'oidc' as const,
    now: () => now,
    random: () => random.shift() ?? 'extra-random',
    redirectUri: 'https://dev.wbs.test/api/auth/okta/callback',
    verifier: {
      verify: (token: string) =>
        token.includes('.')
          ? Promise.reject(new Error('HS256 is not an upstream OIDC token'))
          : Promise.resolve(exchangeClaims ?? claims),
    },
    tokens,
    transactions,
    ...routeOverrides,
  };
  const users = inMemoryUsers();
  const app = buildApp({
    auth: testAuthService(users, oidc),
    capacity: testCapacityService(),
    directory: testDirectoryService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    internalAuthSecret: 'x'.repeat(32),
    writes: testWrites(),
    migrationsApplied: true,
    oidc,
    priorityBands: testPriorityBandService(),
    probeDatabase: () => 'ok',
    projects: testProjectService(),
    replay: testReplay().replay,
    steps: testStepService(),
    workItems: testWorkItemService(),
    savedPlans: testSavedPlanService(),
  });
  return { app, calls, tokens, transactions, users };
}

describe('OIDC browser routes', () => {
  it('keeps password registration closed in OIDC mode', async () => {
    const f = fixture();

    const register = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/register', {
        body: JSON.stringify({ username: 'bypass', password: 'bypass-password' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(register.status).toBe(404);
  });

  it('issues the hardened browser cookie for a password account in OIDC mode', async () => {
    const f = fixture();
    await f.users.create(
      {
        id: 'password-user',
        username: 'claire-qa',
        passwordHash: await Bun.password.hash('correct-horse-2026'),
        email: null,
        idpIssuer: null,
        idpSub: null,
        createdAt: now,
      },
      { at: now, by: 'password-user' },
    );

    const login = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://dev.wbs.test',
          'x-forwarded-for': '192.0.2.10',
        },
        method: 'POST',
      }),
    );
    const setCookie = login.headers.get('set-cookie') ?? '';
    const token = /__Host-wbs_access=([^;]+)/.exec(setCookie)?.[1];

    expect(login.status).toBe(200);
    expect(setCookie).toContain('HttpOnly; Secure; SameSite=Lax; Path=/');
    expect(token).toBeDefined();
    expect(await login.json()).toEqual({
      token: '',
      user: { id: 'password-user', username: 'claire-qa' },
    });

    const me = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/me', {
        headers: { cookie: `__Host-wbs_access=${token ?? ''}` },
      }),
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        id: 'password-user',
        username: 'claire-qa',
        scopes: ['read', 'write', 'editor'],
      },
    });
  });

  it('keeps an enabled registration token in the hardened cookie and throttles its IP', async () => {
    const f = fixture(undefined, { passwordRegisterEnabled: true });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const registered = await f.app.handle(
        new Request('https://dev.wbs.test/api/auth/register', {
          body: JSON.stringify({
            username: `member-${String(attempt)}`,
            password: 'correct-horse-2026',
          }),
          headers: {
            'content-type': 'application/json',
            origin: 'https://dev.wbs.test',
            'x-forwarded-for': '192.0.2.20',
          },
          method: 'POST',
        }),
      );
      expect(registered.status).toBe(200);
      expect(registered.headers.get('set-cookie')).toContain('__Host-wbs_access=');
      const body = (await registered.json()) as {
        token: string;
        user: { id: string; username: string };
      };
      expect(body.token).toBe('');
      expect(body.user.username).toBe(`member-${String(attempt)}`);
      expect(typeof body.user.id).toBe('string');
    }

    const throttled = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/register', {
        body: JSON.stringify({ username: 'member-6', password: 'correct-horse-2026' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://dev.wbs.test',
          'x-forwarded-for': '192.0.2.20',
        },
        method: 'POST',
      }),
    );
    expect(throttled.status).toBe(429);
  });

  it('rejects cross-origin password login before setting a session cookie', async () => {
    const f = fixture();

    const login = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.test',
          'x-forwarded-for': '192.0.2.30',
        },
        method: 'POST',
      }),
    );

    expect(login.status).toBe(403);
    expect(await login.json()).toEqual({ error: 'invalid_origin' });
    expect(login.headers.get('set-cookie')).toBeNull();
  });

  it('rejects password login that bypasses the trusted proxy metadata', async () => {
    const f = fixture();

    const login = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: { 'content-type': 'application/json', origin: 'https://dev.wbs.test' },
        method: 'POST',
      }),
    );

    expect(login.status).toBe(400);
    expect(await login.json()).toEqual({ error: 'invalid_client' });
  });

  it('locks a normalized username after five failures even when IPs change', async () => {
    const f = fixture();
    await f.users.create(
      {
        id: 'password-user',
        username: 'claire-qa',
        passwordHash: await Bun.password.hash('correct-horse-2026'),
        email: null,
        idpIssuer: null,
        idpSub: null,
        createdAt: now,
      },
      { at: now, by: 'password-user' },
    );

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await f.app.handle(
        new Request('https://dev.wbs.test/api/auth/login', {
          body: JSON.stringify({ username: 'CLAIRE-QA', password: 'wrong-password' }),
          headers: {
            'content-type': 'application/json',
            origin: 'https://dev.wbs.test',
            'x-forwarded-for': `192.0.2.${String(attempt)}`,
          },
          method: 'POST',
        }),
      );
      expect(failed.status).toBe(401);
      expect(await failed.json()).toEqual({ error: 'invalid_credentials' });
    }

    const locked = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://dev.wbs.test',
          'x-forwarded-for': '198.51.100.1',
        },
        method: 'POST',
      }),
    );
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('locks a client IP after five unknown usernames without revealing which exist', async () => {
    const f = fixture();
    await f.users.create(
      {
        id: 'password-user',
        username: 'claire-qa',
        passwordHash: await Bun.password.hash('correct-horse-2026'),
        email: null,
        idpIssuer: null,
        idpSub: null,
        createdAt: now,
      },
      { at: now, by: 'password-user' },
    );

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await f.app.handle(
        new Request('https://dev.wbs.test/api/auth/login', {
          body: JSON.stringify({
            username: `missing-${String(attempt)}`,
            password: 'wrong-password',
          }),
          headers: {
            'content-type': 'application/json',
            origin: 'https://dev.wbs.test',
            'x-forwarded-for': `203.0.113.${String(attempt)}, 192.0.2.50`,
          },
          method: 'POST',
        }),
      );
      expect(failed.status).toBe(401);
      expect(await failed.json()).toEqual({ error: 'invalid_credentials' });
    }

    const locked = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://dev.wbs.test',
          'x-forwarded-for': '203.0.113.99, 192.0.2.50',
        },
        method: 'POST',
      }),
    );
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('keeps the password login route hidden when its kill switch is false', async () => {
    const f = fixture(undefined, { passwordLoginEnabled: false });

    const login = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', {
        body: JSON.stringify({ username: 'claire-qa', password: 'correct-horse-2026' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(login.status).toBe(404);
    expect(await login.json()).toEqual({ error: 'not_found' });
  });

  it('refuses a read-only cookie before a domain mutation changes state', async () => {
    const f = fixture({ ...claims, wbs_groups: ['dev:wbs:read'] });

    const write = await f.app.handle(
      new Request('https://dev.wbs.test/api/projects', {
        body: JSON.stringify({ name: 'Must remain absent' }),
        headers: {
          'content-type': 'application/json',
          cookie: '__Host-wbs_access=reader-token',
          origin: 'https://dev.wbs.test',
        },
        method: 'POST',
      }),
    );
    const read = await f.app.handle(
      new Request('https://dev.wbs.test/api/projects', {
        headers: { cookie: '__Host-wbs_access=reader-token' },
      }),
    );

    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'insufficient_scope' });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ projects: [] });
  });

  it('guards every registered user-facing mutation with write scope', async () => {
    const f = fixture({ ...claims, wbs_groups: ['dev:wbs:read'] });
    const publicProtocolRoutes = new Set([
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/refresh',
      '/api/auth/register',
      '/api/smoke/echo',
    ]);
    const mutations = registeredRoutes(f.app.routes as unknown).filter(
      ({ method, path }) =>
        ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method) &&
        path.startsWith('/api/') &&
        !publicProtocolRoutes.has(path),
    );

    // The route table really was read, and it holds the two writes every plan
    // and directory edit now goes through: with the single-item routes gone,
    // a table that dropped either of these would leave every edit unguarded
    // while the loop below still passed over what was left.
    const commandRoutes = mutations
      .filter(({ path }) => path.endsWith('/commands'))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(commandRoutes).toEqual([
      { method: 'POST', path: '/api/directory/commands' },
      { method: 'POST', path: '/api/projects/:id/commands' },
    ]);
    expect(mutations.length).toBeGreaterThanOrEqual(10);
    for (const route of mutations) {
      const path = route.path.replace(/:[^/]+/g, 'test-id');
      const res = await f.app.handle(
        new Request(`https://dev.wbs.test${path}`, {
          body: route.method === 'DELETE' ? undefined : '{}',
          headers: {
            'content-type': 'application/json',
            cookie: '__Host-wbs_access=reader-token',
            origin: 'https://dev.wbs.test',
          },
          method: route.method,
        }),
      );
      expect({ method: route.method, path: route.path, status: res.status }).toEqual({
        method: route.method,
        path: route.path,
        status: 403,
      });
    }
  });

  it('treats a malformed access cookie as unauthenticated instead of crashing', async () => {
    const f = fixture();
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/projects', {
        headers: { cookie: '__Host-wbs_access=%E0%A4%A' },
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('binds login state, nonce, and PKCE verifier to the initiating browser', async () => {
    const f = fixture();
    const res = await f.app.handle(new Request('https://dev.wbs.test/api/auth/login'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.test/authorize?client_id=wbs');
    expect(f.calls.authorize).toEqual([
      {
        nonce: 'nonce-1',
        redirectUri: 'https://dev.wbs.test/api/auth/okta/callback',
        state: 'state-1',
        verifier: 'verifier-1',
      },
    ]);
    expect(res.headers.get('set-cookie')).toContain('__Host-wbs_oidc=binding-1;');
    expect(f.transactions.consume('binding-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      verifier: 'verifier-1',
    });
  });

  it('burns a callback with no matching browser transaction', async () => {
    const f = fixture();
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1'),
    );

    expect(res.status).toBe(400);
    expect(f.calls.exchange).toHaveLength(0);
  });

  it('exchanges once and sets hardened access and refresh-correlation cookies', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: { cookie: '__Host-wbs_oidc=binding-1' },
      }),
    );

    expect(res.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('__Host-wbs_access=access-1;');
    expect(cookies).toContain('__Host-wbs_session=binding-1;');
    expect(cookies).toContain('HttpOnly; Secure; SameSite=Lax; Path=/');
    expect(f.tokens.read('binding-1')?.refreshToken).toBe('refresh-1');
  });

  it('links the verified first-login identity before establishing the browser session', async () => {
    const f = fixture();
    await f.users.create(
      {
        id: 'legacy',
        username: 'dany@puni.show',
        passwordHash: 'local-hash',
        createdAt: 1,
      },
      { at: 1, by: 'legacy' },
    );
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: { cookie: '__Host-wbs_oidc=binding-1' },
      }),
    );

    expect(res.status).toBe(302);
    expect(await f.users.findById('legacy')).toMatchObject({
      email: 'dany@puni.show',
      idpIssuer: 'https://idp.test',
      idpSub: 'subject-1',
      passwordHash: 'local-hash',
    });
  });

  it('refuses a callback whose exchange has no verified ID-token claims', async () => {
    const f = fixture(undefined);
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: { cookie: '__Host-wbs_oidc=binding-1' },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).not.toContain('__Host-wbs_access=');
  });

  it('exchanges with the configured HTTPS callback behind an HTTP reverse proxy', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });
    const res = await f.app.handle(
      new Request('http://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: { cookie: '__Host-wbs_oidc=binding-1', 'x-forwarded-proto': 'https' },
      }),
    );

    expect(res.status).toBe(302);
    const exchange = f.calls.exchange[0] as { request: Request };
    expect(exchange.request.url).toBe(
      'https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1',
    );
  });

  it('rejects cross-origin refresh before reading the stored token', async () => {
    const f = fixture();
    f.tokens.save({
      expiresAt: now + 86_400_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/refresh', {
        method: 'POST',
        headers: { cookie: '__Host-wbs_session=session-1', origin: 'https://evil.test' },
      }),
    );

    expect(res.status).toBe(403);
    expect(f.calls.refresh).toHaveLength(0);
  });

  it('rotates the refresh token atomically and resets the access cookie', async () => {
    const f = fixture();
    f.tokens.save({
      expiresAt: now + 86_400_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/refresh', {
        method: 'POST',
        headers: { cookie: '__Host-wbs_session=session-1', origin: 'https://dev.wbs.test' },
      }),
    );

    expect(res.status).toBe(204);
    expect(f.calls.refresh).toEqual(['refresh-1']);
    expect(f.tokens.read('session-1')?.refreshToken).toBe('refresh-2');
    expect(res.headers.get('set-cookie')).toContain('__Host-wbs_access=access-2;');
  });

  it('deletes the session, revokes upstream, and clears cookies on same-origin logout', async () => {
    const f = fixture();
    f.tokens.save({
      expiresAt: now + 86_400_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/logout', {
        method: 'POST',
        headers: { cookie: '__Host-wbs_session=session-1', origin: 'https://dev.wbs.test' },
      }),
    );

    expect(res.status).toBe(204);
    expect(f.calls.revoke).toEqual(['refresh-1']);
    expect(f.tokens.read('session-1')).toBeNull();
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('OIDC startup configuration', () => {
  it('refuses misspelled password security flags instead of choosing a mode', () => {
    const factory = (
      authModule as unknown as { oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown }
    ).oidcRouteOptionsFromEnv;
    const base = {
      AUTH_CLIENT_ID: 'client',
      AUTH_CLIENT_SECRET: 'secret',
      AUTH_AUDIENCE: 'wbs-api',
      AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
      AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
    };

    expect(() => factory({ ...base, AUTH_PASSWORD_LOGIN: 'TRUE' })).toThrow(
      /AUTH_PASSWORD_LOGIN.*true.*false/,
    );
    expect(() => factory({ ...base, AUTH_PASSWORD_REGISTER: 'yes' })).toThrow(
      /AUTH_PASSWORD_REGISTER.*true.*false/,
    );
  });

  it('refuses registration when password sessions are disabled', () => {
    const factory = (
      authModule as unknown as { oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown }
    ).oidcRouteOptionsFromEnv;

    expect(() =>
      factory({
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
        AUTH_AUDIENCE: 'wbs-api',
        AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
        AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
        AUTH_PASSWORD_LOGIN: 'false',
        AUTH_PASSWORD_REGISTER: 'true',
      }),
    ).toThrow(/AUTH_PASSWORD_REGISTER=true.*AUTH_PASSWORD_LOGIN=true/);
  });

  it('refuses a redirect URI whose callback path is not mounted', () => {
    const factory = (
      authModule as unknown as { oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown }
    ).oidcRouteOptionsFromEnv;
    expect(() =>
      factory({
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
        AUTH_AUDIENCE: 'wbs-api',
        AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
        AUTH_REDIRECT_URI: 'https://dev.wbs.test/auth/callback',
      }),
    ).toThrow('/api/auth/okta/callback');
  });

  it('builds a lazy provider client for the fixed callback route', () => {
    const factory = (
      authModule as unknown as {
        oidcRouteOptionsFromEnv: (env: Record<string, string>) => {
          appOrigin: string;
          groupPrefix: string;
          groupsClaim: string;
          mode: string;
        };
      }
    ).oidcRouteOptionsFromEnv;
    expect(
      factory({
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
        AUTH_AUDIENCE: 'wbs-api',
        AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
        AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
        AUTH_GROUPS_CLAIM: 'custom_groups',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({
      appOrigin: 'https://dev.wbs.test',
      groupPrefix: 'prod',
      groupsClaim: 'custom_groups',
      mode: 'oidc',
    });
  });
});
