import type { JwtClaims } from '@wbs/auth';
import {
  browserBindingCookieName,
  InMemoryOidcTransactionStore,
  InMemoryTokenStore,
  OidcCallbackRefused,
} from '@wbs/auth';
import { describe, expect, it } from 'bun:test';
import { errors } from 'jose';

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
import * as oidcOptionsModule from './oidc-options';

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

interface ExchangeResult {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  idTokenClaims?: JwtClaims;
}

function fixture(
  idTokenClaims?: JwtClaims,
  routeOverrides: {
    passwordLoginEnabled?: boolean;
    passwordRegisterEnabled?: boolean;
    // Spread over the fixture's own five-value list, for the cases that drive
    // more than one login through one browser (TASK-272).
    random?: () => string;
    // Drives the routes *and* both stores, for the one case that needs two
    // logins to have started at different instants — the eviction order is the
    // store's `expiresAt`, so a frozen clock would make it a tie (TASK-272).
    clock?: () => number;
  } = {},
  // Separate from `routeOverrides`, which is spread onto the options object:
  // this replaces one method of the fake provider client, and the only case
  // that uses it makes `exchange` reject (TASK-273).
  clientOverrides: {
    exchange?: (request: Request, checks: unknown) => Promise<ExchangeResult>;
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
    ...clientOverrides,
  };
  const { clock, ...routeOptions } = routeOverrides;
  const tick = clock ?? ((): number => now);
  const transactions = new InMemoryOidcTransactionStore({ now: tick, ttlMs: 300_000 });
  const tokens = new InMemoryTokenStore({ now: tick });
  const random = ['binding-1', 'state-1', 'nonce-1', 'verifier-1', 'session-1'];
  // What a refused or failed login writes down. `buildApp` hands the route list
  // its own pino logger when the options carry none; supplying one here wins,
  // which is what lets these cases read the fields without a destination.
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const record = (level: string) => (fields: Record<string, unknown>, message: string) =>
    void logs.push({ level, fields, message });
  const oidc = {
    appOrigin: 'https://dev.wbs.test',
    client,
    groupPrefix: 'dev',
    groupsClaim: 'wbs_groups',
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    mode: 'oidc' as const,
    now: tick,
    random: () => random.shift() ?? 'extra-random',
    redirectUri: 'https://dev.wbs.test/api/auth/okta/callback',
    verifier: {
      verify: (token: string) =>
        token.includes('.')
          ? Promise.reject(new errors.JOSEAlgNotAllowed('HS256 is not an upstream OIDC token'))
          : Promise.resolve(exchangeClaims ?? claims),
    },
    tokens,
    transactions,
    ...routeOptions,
  };
  const users = inMemoryUsers();
  const app = buildApp({
    appOrigin: oidc.appOrigin,
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
  return { app, calls, logs, tokens, transactions, users, oidc };
}

/**
 * The binding cookies one response writes, name to value, with a cleared cookie
 * reading `null` (TASK-272).
 *
 * A login is one cookie now rather than one entry in a list, so the cases below
 * track a jar. Reading the values rather than whole attribute strings keeps an
 * assertion about which logins a browser holds from also asserting `HttpOnly`
 * and `Max-Age`; those are asserted once, at `binds login state, nonce, and
 * PKCE verifier to the initiating browser`.
 */
function bindingCookiesOf(res: Response): Map<string, string | null> {
  const written = new Map<string, string | null>();
  for (const [, name, value] of (res.headers.get('set-cookie') ?? '').matchAll(
    /(__Host-wbs_oidc_[^=;,\s]+)=([^;,]*)/g,
  )) {
    written.set(name, value === '' ? null : value);
  }
  return written;
}

/** The cookies a browser would hold for these logins, one each. */
function jarOf(...bindings: string[]): Map<string, string> {
  return new Map(bindings.map((binding) => [browserBindingCookieName(binding), binding]));
}

/** What a browser holds after applying one response to the jar it had. */
function browserJar(held: Map<string, string>, res: Response): Map<string, string> {
  const next = new Map(held);
  for (const [name, value] of bindingCookiesOf(res)) {
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  return next;
}

/** The logins a jar is holding, in the order a browser would send them. */
function bindingsOf(jar: Map<string, string>): string[] {
  return [...jar.values()];
}

/** Whether this answer retired the cookie that was holding `binding`. */
function retires(res: Response, binding: string): boolean {
  return bindingCookiesOf(res).get(browserBindingCookieName(binding)) === null;
}

/** What the browser sends back, or no cookie header at all when it holds none. */
function cookieHeader(jar: Map<string, string>): Record<string, string> {
  if (jar.size === 0) return {};
  return { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
}

describe('OIDC browser routes', () => {
  it('keeps password registration closed in OIDC mode', async () => {
    const f = fixture();

    const register = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/register', {
        body: JSON.stringify({ username: 'bypass', password: 'bypass-password' }),
        headers: { 'content-type': 'application/json', origin: 'https://dev.wbs.test' },
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
        headers: { 'content-type': 'application/json', origin: 'https://dev.wbs.test' },
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
      expect(await res.json()).toEqual({ error: 'insufficient_scope' });
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
    expect(bindingCookiesOf(res).get(browserBindingCookieName('binding-1'))).toBe('binding-1');
    // The one place the binding cookie's attributes are asserted: the name is
    // new under TASK-272 and `__Host-` only means anything with all of these.
    expect(res.headers.get('set-cookie')).toContain(
      `${browserBindingCookieName('binding-1')}=binding-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`,
    );
    expect(f.transactions.consume('binding-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      outcome: 'consumed',
      verifier: 'verifier-1',
    });
  });

  /**
   * TASK-272, end to end, and it is the case the whole change exists for.
   *
   * Two tabs, one cookie name. Before this, the second login's `Set-Cookie`
   * replaced the first's, so the first tab's callback came back holding a
   * binding that was not its own and was refused — a login lost to nothing but
   * a second tab, with no attacker anywhere in it. TASK-276 had already stopped
   * that arrival from destroying the *second* tab's record; what it could not
   * do is give the first tab back a cookie the browser had overwritten.
   *
   * Every request here carries what a browser would actually be holding, taken
   * from the previous response rather than written down, because the cookie's
   * value is now the thing under test.
   *
   * Measured against the login route writing both logins under one shared
   * cookie name: this fails first at the jar the second login leaves behind,
   * `Expected: ["binding-1", "binding-2"] Received: ["binding-2"]`, because that
   * assertion throws and ends the case. Delete it as well and it fails where a
   * browser would suffer it, at the late callback: `Expected: 302 Received:
   * 400`. Both were run; the loss is asserted at the cause and at the effect.
   *
   * **The second login's answer must also not name the first login's cookie**
   * (TASK-272 r1, Important). The shape this replaced kept both bindings in one
   * value, so starting a login meant rewriting the list — and a login started
   * while that request was in flight was erased by a write it never appeared in.
   * `expect(bindingCookiesOf(secondTab).size).toBe(1)` is that: the second login
   * writes its own name and says nothing whatever about the first's.
   */
  it('lets the first tab finish a login a second tab started after it', async () => {
    const sequence = [
      'binding-1',
      'state-1',
      'nonce-1',
      'verifier-1',
      'binding-2',
      'state-2',
      'nonce-2',
      'verifier-2',
      'session-1',
    ];
    const f = fixture(claims, { random: () => sequence.shift() ?? 'extra-random' });

    const firstTab = await f.app.handle(new Request('https://dev.wbs.test/api/auth/login'));
    const afterFirst = browserJar(new Map(), firstTab);
    const secondTab = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/login', { headers: cookieHeader(afterFirst) }),
    );
    const afterSecond = browserJar(afterFirst, secondTab);

    expect(bindingsOf(afterFirst)).toEqual(['binding-1']);
    expect(bindingsOf(afterSecond)).toEqual(['binding-1', 'binding-2']);
    expect(bindingCookiesOf(secondTab).size).toBe(1);

    // The first tab's callback, returning after the second login started and
    // carrying every binding cookie the browser holds, with its own state.
    const late = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(afterSecond),
      }),
    );
    const afterLate = browserJar(afterSecond, late);

    expect(late.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
    // The second tab's login is still in the browser and still live, and the
    // answer never named its cookie at all — only the one it spent.
    expect(bindingsOf(afterLate)).toEqual(['binding-2']);
    expect([...bindingCookiesOf(late).keys()]).toEqual([browserBindingCookieName('binding-1')]);

    const second = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-2', {
        headers: cookieHeader(afterLate),
      }),
    );

    expect(second.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(2);
    expect(bindingsOf(browserJar(afterLate, second))).toEqual([]);
  });

  /**
   * TASK-272's fourth acceptance criterion: the bound on how many logins one
   * browser may hold is `MAX_BROWSER_BINDINGS`, it is written down, and it is
   * the *oldest* login that is dropped — not the one being completed. Without
   * it the jar would grow for as long as a person keeps opening tabs and the
   * real limit would be the user agent's silent per-domain cap.
   *
   * With one cookie per login the bound is kept by **clearing a name**, and the
   * name to clear comes from the store's `expiresAt` rather than from anything
   * the cookie says about itself. Removing the eviction from the login route
   * leaves the fourth login's jar reading four bindings here.
   */
  it('holds three concurrent logins per browser and drops the oldest', async () => {
    const sequence = [1, 2, 3, 4].flatMap((n) => [
      `binding-${String(n)}`,
      `state-${String(n)}`,
      `nonce-${String(n)}`,
      `verifier-${String(n)}`,
    ]);
    // A second between tabs, so "oldest" is a fact the store holds rather than
    // the order the browser happened to send its cookies in.
    let clock = now;
    const f = fixture(claims, {
      clock: () => clock,
      random: () => sequence.shift() ?? 'session-1',
    });

    let held = new Map<string, string>();
    for (let tab = 0; tab < 4; tab += 1) {
      const res = await f.app.handle(
        new Request('https://dev.wbs.test/api/auth/login', { headers: cookieHeader(held) }),
      );
      held = browserJar(held, res);
      clock += 1_000;
    }

    expect(bindingsOf(held)).toEqual(['binding-2', 'binding-3', 'binding-4']);

    // The dropped login is unfinishable, and its refusal is the ordinary one:
    // the browser cannot present a binding it no longer holds.
    const dropped = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(held),
      }),
    );

    expect(dropped.status).toBe(400);
    // Proof: restoring the JSON invalid-callback envelope produced
    // `Received: {"error":"invalid_oidc_callback"}` instead of this empty body.
    expect(await dropped.text()).toBe('');
    expect(f.calls.exchange).toHaveLength(0);
    // …and it costs the three surviving logins nothing: state-1 matched none of
    // them, so the answer names no cookie at all.
    expect(dropped.headers.get('set-cookie')).toBeNull();

    const surviving = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-2', {
        headers: cookieHeader(held),
      }),
    );

    expect(surviving.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
    expect(bindingsOf(browserJar(held, surviving))).toEqual(['binding-3', 'binding-4']);
  });

  /**
   * The denial TASK-272 would have opened if the stateless refusal had gone on
   * clearing the browser's bindings. They are `SameSite=Lax`, so a hostile page
   * can navigate a browser to this route with **no query at all** — and once a
   * browser can hold three logins, one such navigation would have ended all
   * three. It is the TASK-276 attack with a shorter URL and it gets the same
   * answer: the bodiless 400, nothing live cleared.
   */
  it('refuses a stateless callback without discarding the logins in flight', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });
    const held = jarOf('binding-1');

    const stateless = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c', {
        headers: cookieHeader(held),
      }),
    );

    expect(stateless.status).toBe(400);
    expect(await stateless.text()).toBe('');
    expect(stateless.headers.get('set-cookie')).toBeNull();
    expect(f.calls.exchange).toHaveLength(0);

    // The second request carries what a browser would still be holding, derived
    // from the first answer rather than written down — the shape TASK-276's
    // sibling case arrived at, because re-sending the jar unconditionally makes
    // this assertion vacuous against a route that cleared the binding.
    const honest = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(browserJar(held, stateless)),
      }),
    );

    expect(honest.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
  });

  it('burns a callback with no matching browser transaction', async () => {
    const f = fixture();
    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1'),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
    expect(f.calls.exchange).toHaveLength(0);
  });

  /**
   * TASK-276, end to end, and it is the case the whole change exists for.
   *
   * The binding cookie is `SameSite=Lax`, so a hostile page can send a browser
   * with a login in flight to this route on a top-level GET and the cookie
   * rides along. Until now `consume` deleted the record before comparing the
   * state, so that navigation destroyed a transaction that was about to
   * succeed — no state guess required, because any string reached the delete.
   *
   * The refusal keeps its public error and now carries the shared Refusal
   * envelope: 400 invalid_oidc_callback, exchange untouched. The two
   * assertions that carry the fix are the **absent `Set-Cookie`** — clearing the
   * binding would lose the login from the other end, the honest callback
   * arriving to find no cookie — and the honest callback that still completes.
   *
   * **The second request carries what a browser would still be holding, and
   * that is the point of `surviving` below.** Re-sending the cookie string
   * unconditionally is what the sibling cases do, and it made this case's
   * status assertion vacuous against a route that cleared the binding: the
   * header assertion caught that mutation and the 302 did not. The seats split
   * on whether that mattered — Sol called the two assertions complementary,
   * agy called the second one vacuous — and it is cheaper to make both catch it
   * than to record the disagreement. Measured: with the route clearing the
   * binding *and* the header assertion deleted, this case fails `Expected: 302
   * Received: 400`, which it could not do before.
   */
  it('refuses a forged error callback without burning the login it interrupts', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const forged = await f.app.handle(
      new Request(
        'https://dev.wbs.test/api/auth/okta/callback?error=access_denied&state=anything',
        { headers: cookieHeader(jarOf('binding-1')) },
      ),
    );

    expect(forged.status).toBe(400);
    expect(await forged.text()).toBe('');
    expect(forged.headers.get('set-cookie')).toBeNull();
    expect(f.calls.exchange).toHaveLength(0);

    // Derived from the forged answer rather than written down: a route that
    // retired the binding leaves the browser holding nothing, and the honest
    // callback below then fails the way a person would experience it.
    const honest = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(browserJar(jarOf('binding-1'), forged)),
      }),
    );

    expect(honest.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
  });

  /**
   * TASK-269, the first half. `searchParams.get('state')` answers the **first**
   * value of a repeated key and the former collapsed query answered the **last**, so
   * moving this handler onto the framework-free route shape silently changed
   * which string a duplicated `state` selected — and `consume` deleted the
   * record before it compared, so the wrong value burned a login that was about
   * to succeed. **That last clause is history now:** TASK-276 made the mismatch
   * keep the record, so picking the wrong value costs the transaction nothing.
   * The refusal stays for its own reason — no authorization server sends a
   * parameter twice, and `openid-client` rejects one a moment later regardless.
   *
   * The decision is to refuse the request rather than to pick a value: no
   * authorization server sends `state` twice, and `openid-client` refuses a
   * repeated response parameter a moment later regardless, so first-value would
   * only move the failure past the point where the transaction is gone.
   *
   * The assertion that carries it is the second callback: refusing costs the
   * caller nothing, and the login they actually started still completes.
   */
  it('refuses a callback carrying two states without spending the transaction', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const polluted = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1&state=other', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(polluted.status).toBe(400);
    // Read as text, because the answer this refusal replaces is a *bodiless*
    // 400 with the binding cookie cleared, and `json()` on that throws a
    // `SyntaxError` before any assertion can report what actually differed.
    expect(await polluted.text()).toBe(JSON.stringify({ error: 'duplicate_parameter' }));
    expect(f.calls.exchange).toHaveLength(0);
    expect(polluted.headers.get('set-cookie')).toBeNull();

    const honest = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(honest.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
  });

  /**
   * The same refusal one parameter over, and the case that says why the rule is
   * "any repeated key" rather than "a repeated `state`".
   *
   * A doubled `code` passes the state check, so `consume` succeeds and spends
   * the transaction — and then `authorizationCodeGrant` throws on the duplicate,
   * which nothing in this handler catches. The caller would get a framework 500
   * for a login that is now gone. The fixture's `exchange` is a stub and cannot
   * reproduce that throw, so what is asserted is the refusal that stops it
   * happening — and, as above, the honest callback that still completes, which
   * is what says the transaction and the cookie both survived.
   */
  it('refuses a callback carrying two codes with the transaction still unspent', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const polluted = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&code=c2&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(polluted.status).toBe(400);
    expect(await polluted.text()).toBe(JSON.stringify({ error: 'duplicate_parameter' }));
    expect(f.calls.exchange).toHaveLength(0);
    expect(polluted.headers.get('set-cookie')).toBeNull();

    const honest = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(honest.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
  });

  /**
   * TASK-269, the second half. Elysia answers a HEAD from the path's GET and so
   * does the second binder, which is right for a route that reads something.
   * This one consumes a single-use transaction and mints session cookies, so a
   * HEAD — a link preview, an uptime probe — would spend a whole login on a
   * request that carries no body back.
   *
   * Before the route shape the handler read the raw `request.method` and the
   * provider saw HEAD; afterwards it read the registered verb and the provider
   * saw GET. Refusing closes the difference instead of choosing which of the
   * two the provider should be told.
   */
  it('refuses a HEAD callback with 405 and Allow, before consuming or exchanging', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const probed = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
        method: 'HEAD',
      }),
    );

    expect(probed.status).toBe(405);
    expect(probed.headers.get('allow')).toBe('GET');
    expect(f.calls.exchange).toHaveLength(0);
    // The cookie has to survive the refusal, not just the record: reading
    // `f.transactions` by key would still pass if the 405 cleared the binding
    // cookie, and a browser with no binding cannot finish the login
    // the record is still holding. So the carrying assertion is the honest GET
    // that follows, sending the same cookie the probe was answered with.
    expect(probed.headers.get('set-cookie')).toBeNull();

    const honest = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(honest.status).toBe(302);
    expect(f.calls.exchange).toHaveLength(1);
  });

  /**
   * TASK-273. Clicking **Cancel** at the identity provider is the most ordinary
   * thing a person can do in a login flow, and it came back as an untyped 500:
   * the state matches, so every check above passed, `consume` spent the
   * transaction, and `authorizationCodeGrant` then threw for the missing `code`
   * into a handler that caught nothing.
   *
   * The transaction being spent is asserted rather than tolerated — no code
   * will ever arrive for this state, so the record is dead and the second
   * request here is what says so.
   *
   * **This case does not observe the 500 and its name no longer claims to.**
   * The fake client above resolves a token set for any query, so with the guard
   * removed this handler *completes* the cancelled login and the case reads
   * `Expected: "/?auth_error=access_denied" Received: "/"` — measured, not
   * assumed, and a worse defect than the one being fixed. That is the sharper
   * statement anyway: what removes the 500 is that an error callback never
   * reaches the provider, which `f.calls.exchange` is here to say. The 500
   * itself belongs to the real `authorizationCodeGrant` and is reproduced by
   * `answers a failed exchange with a typed refusal rather than a framework
   * 500` below, the one case whose client actually rejects.
   *
   * **The description is sent and the assertion is not vacuous**, which is the
   * round-1 review's point: an exact `toBe` on a location that also had to
   * survive `error_description` is what says the suppression holds for an
   * allowlisted code, where a `not.toContain` after an exact `toBe` would have
   * asserted nothing at all.
   */
  it('answers a cancelled login by returning to the sign-in page without reaching the provider', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const cancelled = await f.app.handle(
      new Request(
        'https://dev.wbs.test/api/auth/okta/callback?error=access_denied&error_description=The+resource+owner+declined&state=state-1',
        { headers: cookieHeader(jarOf('binding-1')) },
      ),
    );

    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get('location')).toBe('/?auth_error=access_denied');
    expect(f.calls.exchange).toHaveLength(0);
    expect(retires(cancelled, 'binding-1')).toBe(true);

    // The login is over, so the transaction went with it: a code arriving for
    // the same state afterwards finds nothing to complete.
    const late = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(late.status).toBe(400);
    expect(f.calls.exchange).toHaveLength(0);
  });

  it('sends a silent-login refusal back under its own name', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const refused = await f.app.handle(
      new Request(
        'https://dev.wbs.test/api/auth/okta/callback?error=login_required&state=state-1',
        {
          headers: cookieHeader(jarOf('binding-1')),
        },
      ),
    );

    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toBe('/?auth_error=login_required');
    expect(retires(refused, 'binding-1')).toBe(true);
    expect(f.calls.exchange).toHaveLength(0);
  });

  /**
   * The `error` and `error_description` a callback carries are both written by
   * the authorization server, and this app repeats one of them on its own
   * origin and never the other. An unrecognised code collapses to
   * `provider_error` so the provider cannot choose the string in the URL; the
   * description is dropped from the answer entirely.
   *
   * A `?error=` with nothing after it is the same callback one degree more
   * malformed and takes the same exit, which is the round-1 review's third
   * finding: letting it fall through spent a real request on the provider to
   * learn what the presence of the key already said.
   */
  it('repeats no provider text the app does not publish', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const opaque = await f.app.handle(
      new Request(
        'https://dev.wbs.test/api/auth/okta/callback?error=okta_policy_evaluation_failure&error_description=Call+support+on+555-0100&state=state-1',
        { headers: cookieHeader(jarOf('binding-1')) },
      ),
    );

    expect(opaque.status).toBe(302);
    expect(opaque.headers.get('location')).toBe('/?auth_error=provider_error');
    expect(retires(opaque, 'binding-1')).toBe(true);
    expect(f.calls.exchange).toHaveLength(0);
    // The location is not the only place a description could surface. This
    // answer carries no body at all, and a regression that started explaining
    // itself would fail here rather than in a reader's browser.
    expect(await opaque.text()).toBe('');
  });

  /**
   * A blank `?error=` names no reason, so it is a malformed callback rather than
   * an error response, and it takes this route's existing shape for one: the
   * bodiless 400 with the binding cleared. The first version let it fall through
   * to `exchange`, which spent a real request on the provider to learn what the
   * empty value already said.
   */
  it('refuses a blank error code at the boundary instead of at the provider', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const blank = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?error=&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(blank.status).toBe(400);
    expect(await blank.text()).toBe('');
    expect(blank.headers.get('location')).toBeNull();
    expect(retires(blank, 'binding-1')).toBe(true);
    expect(f.calls.exchange).toHaveLength(0);
  });

  /**
   * What the operator is told, which is the half the reader is deliberately not
   * told. Round 1 of this change logged nothing anywhere and recorded that as a
   * decision; both terminal seats called it Important on an auth path, because
   * a sign-on policy that starts refusing every login looks — with no line
   * written down — exactly like a building full of people clicking Cancel.
   *
   * **The level carries the distinction**, so the routine cancellations cannot
   * bury the deployment fault: a code this app names is `info`, and a code it
   * will not repeat is `warn`. Both carry the provider's raw `error` and its
   * `error_description`, neither of which reaches the browser.
   */
  it('writes the provider’s own words to the log and not to the answer', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    await f.app.handle(
      new Request(
        'https://dev.wbs.test/api/auth/okta/callback?error=okta_policy_evaluation_failure&error_description=Blocked+by+policy+Zone-7&state=state-1',
        { headers: cookieHeader(jarOf('binding-1')) },
      ),
    );

    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]?.level).toBe('warn');
    expect(f.logs[0]?.fields).toEqual({
      error: 'okta_policy_evaluation_failure',
      has_description: true,
      auth_error: 'provider_error',
    });
    // The description itself is nowhere in the log line either. `error` is a
    // protocol token from a small vocabulary; `error_description` is prose the
    // provider composes and has been seen naming the person it refused, and an
    // operator does not need it to learn that a policy started refusing
    // everyone.
    expect(JSON.stringify(f.logs)).not.toContain('Zone-7');
  });

  it('reports a person’s own cancellation at info, not as a fault', async () => {
    const f = fixture();
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?error=access_denied&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]?.level).toBe('info');
    expect(f.logs[0]?.fields).toEqual({
      error: 'access_denied',
      has_description: false,
      auth_error: 'access_denied',
    });
  });

  /**
   * The other half of TASK-273: a rejection out of `exchange` for any other
   * reason — the provider unreachable, a `code` it will not honour, clock skew
   * on the ID token — was the same untyped 500. It answers 401 with the binding
   * cleared, which is what the verified-claims refusal below already answers,
   * because a browser cannot act on the difference.
   *
   * **And the error reaches the log**, which round 1 discarded: a bodiless 401
   * with no stack anywhere turns an expired token-endpoint certificate into an
   * unexplained login failure, the defect this route was just fixed for one
   * layer down.
   */
  it('answers a failed exchange with a typed refusal rather than a framework 500', async () => {
    // The provider answered in OAuth's error shape and said the grant is no
    // good — the arm this case has always been about, now said in the shape
    // `classifyOidcFailure` reads rather than as a bare `Error`, which
    // TASK-277 classifies as a defect and no longer answers 401.
    const failure = Object.assign(new Error('idp refused the code'), {
      code: 'OAUTH_RESPONSE_BODY_ERROR',
      error: 'invalid_grant',
    });
    // The override records before it rejects. Replacing `exchange` outright
    // would take the fixture's counter with it, and a 401 returned from
    // anywhere *before* the exchange would then satisfy a case whose name says
    // one was attempted.
    const attempts: unknown[] = [];
    const f = fixture(
      claims,
      {},
      {
        exchange: (request, checks) => {
          attempts.push({ request, checks });
          return Promise.reject(failure);
        },
      },
    );
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const failed = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(failed.status).toBe(401);
    // Proof: returning invalid_oidc_session here made this assertion receive its
    // JSON envelope instead of the empty TASK-277 refusal.
    expect(await failed.text()).toBe('');
    expect(attempts).toHaveLength(1);
    expect(retires(failed, 'binding-1')).toBe(true);
    // A failed exchange mints nothing: the two session cookies never appear.
    expect(failed.headers.get('set-cookie')).not.toContain('__Host-wbs_access=');
    expect(failed.headers.get('set-cookie')).not.toContain('__Host-wbs_session=');
    expect(f.logs).toHaveLength(1);
    // `info`, not `error`: a spent or wrong code is something a person did,
    // and a flood of them must not bury the one line an operator is looking
    // for. The error-callback branch splits its levels the same way.
    expect(f.logs[0]?.level).toBe('info');
    expect(f.logs[0]?.fields).toEqual({
      err: failure,
      oidc_failure_kind: 'refused',
      oidc_failure_reason: 'grant_refused',
    });
  });

  /**
   * AC #2 and AC #3, one arm per case.
   *
   * Each drives the whole route — a real callback, a real transaction, the
   * fixture's own `exchange` rejecting with the shape the arm is reached by —
   * and asserts three things: the status the caller gets, the level the
   * operator is paged (or not paged) at, and the two flat fields an outage is
   * grepped by. Nothing here names an `openid-client` class; the shapes are
   * the ones a provider or a socket really produces.
   *
   * **The bodies are asserted empty in every arm.** AC #2 says no provider
   * text reaches the browser, and each rejection below carries a distinctive
   * string in its message precisely so the assertion is not vacuous.
   */
  const arms = [
    {
      name: 'an unreachable provider',
      kind: 'unavailable',
      reason: 'provider_unreachable',
      level: 'error',
      status: 503,
      // What `fetch` really throws: the code is on the cause, not the top.
      failure: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND idp.example.test'), {
          code: 'ENOTFOUND',
        }),
      }),
    },
    {
      name: 'a TLS handshake that names no party',
      kind: 'indeterminate',
      reason: 'tls_negotiation_failed',
      // `warn`, not `error`: the far end was reachable and objected, and
      // nothing in that evidence says whose move it is. Paging an operator
      // about a provider outage on it would be a claim the alert cannot make.
      level: 'warn',
      status: 503,
      failure: Object.assign(new Error('write EPROTO handshake failure'), {
        code: 'ERR_SSL_TLSV1_ALERT_HANDSHAKE_FAILURE',
      }),
    },
    {
      name: 'a failure this project does not recognise',
      kind: 'defect',
      reason: 'unrecognised_failure',
      level: 'error',
      // The distinguishable path AC #2 asks for, and not a return of what
      // TASK-273 closed: that was *every* failure arriving as an untyped 500
      // with nothing written down. This is the one arm that means the
      // deployment is wrong, and it arrives with a reason slug.
      status: 500,
      failure: new Error('secret-provider-prose nobody classified'),
    },
  ] as const;

  for (const arm of arms) {
    it(`answers ${arm.name} with ${String(arm.status)} and logs the classification`, async () => {
      const attempts: unknown[] = [];
      const f = fixture(
        claims,
        {},
        {
          exchange: (request, checks) => {
            attempts.push({ request, checks });
            return Promise.reject(arm.failure);
          },
        },
      );
      f.transactions.save({
        browserBinding: 'binding-1',
        nonce: 'nonce-1',
        state: 'state-1',
        verifier: 'verifier-1',
      });

      const failed = await f.app.handle(
        new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
          headers: cookieHeader(jarOf('binding-1')),
        }),
      );

      expect(failed.status).toBe(arm.status);
      expect(attempts).toHaveLength(1);
      // The login is over in every arm, including the two that say come back
      // later: the code is spent and the next attempt starts a new transaction.
      expect(retires(failed, 'binding-1')).toBe(true);
      expect(failed.headers.get('set-cookie')).not.toContain('__Host-wbs_access=');
      expect(failed.headers.get('set-cookie')).not.toContain('__Host-wbs_session=');
      // No provider text reaches the browser — asserted against the string each
      // rejection carries rather than against emptiness alone.
      expect(await failed.text()).toBe('');

      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]?.level).toBe(arm.level);
      expect(f.logs[0]?.fields).toEqual({
        err: arm.failure,
        oidc_failure_kind: arm.kind,
        oidc_failure_reason: arm.reason,
      });
    });
  }

  /**
   * Peer pass 19, Important: without this branch a caller who has started one
   * legitimate login holds a valid `state` and binding, and a callback with
   * that state and no `code` reaches `exchange`, rejects as
   * `OAUTH_INVALID_RESPONSE`, and is classified `defect` → 500. That would let
   * a caller choose the status and the alert bucket reserved for "this
   * deployment is wrong".
   *
   * `f.calls.exchange` is the load-bearing assertion: a 400 returned from
   * anywhere *after* the provider was reached would satisfy the status alone.
   */
  for (const [name, query] of [
    ['no code at all', 'state=state-1'],
    ['an empty code', 'code=&state=state-1'],
    // Peer pass 20, Important: a parameter from a response mode this app never
    // asks for. `oauth4webapi` refuses each of these before any provider
    // request, as a code the classifier does not table, so each was a
    // caller-chosen `defect` 500 until this branch existed.
    ['a hybrid-flow response parameter', 'code=c&state=state-1&response=x'],
    ['an implicit-flow id_token', 'code=c&state=state-1&id_token=x'],
    ['an implicit-flow token', 'code=c&state=state-1&token=x'],
  ] as const) {
    it(`refuses a callback with ${name} without reaching the provider`, async () => {
      const f = fixture();
      f.transactions.save({
        browserBinding: 'binding-1',
        nonce: 'nonce-1',
        state: 'state-1',
        verifier: 'verifier-1',
      });

      const malformed = await f.app.handle(
        new Request(`https://dev.wbs.test/api/auth/okta/callback?${query}`, {
          headers: cookieHeader(jarOf('binding-1')),
        }),
      );

      expect(malformed.status).toBe(400);
      expect(f.calls.exchange).toHaveLength(0);
      expect(retires(malformed, 'binding-1')).toBe(true);
      expect(await malformed.text()).toBe('');
      expect(f.logs).toHaveLength(1);
      // `info`, matching the invalid-grant refusal: every one of these is
      // wholly caller-authored, so a caller could otherwise choose how loud the
      // log gets. (Peer pass 20, Minor.)
      expect(f.logs[0]?.level).toBe('info');
    });
  }

  // An outage is greppable without reading stack text: the whole point of AC
  // #3, asserted as a reader would actually use it. `JSON.stringify` over the
  // recorded fields stands in for the log stream a `grep` would run against.
  it('makes an outage greppable by a field rather than by stack text', async () => {
    const f = fixture(
      claims,
      {},
      {
        exchange: () =>
          Promise.reject(
            Object.assign(new TypeError('fetch failed'), {
              cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
                code: 'ECONNREFUSED',
              }),
            }),
          ),
      },
    );
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    const line = JSON.stringify(f.logs[0]?.fields ?? {});
    expect(line).toContain('"oidc_failure_kind":"unavailable"');
    expect(line).toContain('"oidc_failure_reason":"provider_unreachable"');
  });

  /**
   * The route's half of the fifth malformed callback. The adapter refuses a
   * callback whose `iss` is not the issuer discovery resolved to — it is the one
   * such refusal the route cannot make itself, because the issuer identifier
   * only exists after discovery — and rejects with a type this project owns.
   *
   * **What this asserts is that the owned rejection does not reach the
   * classifier.** Before it did: the library refused the same callback as
   * `OAUTH_INVALID_RESPONSE`, which the classifier deliberately does not table,
   * so it landed in `defect` — a 500 and an `error`-level log that a caller
   * holding their own state and binding could choose to trigger. The answer now
   * is the one the other four malformed callbacks already get.
   *
   * The client here is a fake, so the *decision* is not what is under test —
   * `refuseCallbackFromAnotherIssuer`'s own cases own that. What is under test is
   * that the route recognises the rejection.
   */
  for (const reason of ['issuer_mismatch', 'issuer_missing'] as const) {
    it(`answers a callback the adapter refused (${reason}) with 400 and not a defect 500`, async () => {
      const f = fixture(
        claims,
        {},
        { exchange: () => Promise.reject(new OidcCallbackRefused(reason)) },
      );
      f.transactions.save({
        browserBinding: 'binding-1',
        nonce: 'nonce-1',
        state: 'state-1',
        verifier: 'verifier-1',
      });

      const res = await f.app.handle(
        new Request(
          'https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1&iss=https%3A%2F%2Fevil.test',
          {
            headers: cookieHeader(jarOf('binding-1')),
          },
        ),
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      // No provider or library text reaches the browser in this arm either.
      expect(await res.text()).toBe('');
      expect(retires(res, 'binding-1')).toBe(true);
      // Caller-authored input, so a caller cannot choose how loud the log gets —
      // the same principle as the other four malformed-callback branches.
      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]?.level).toBe('info');
      expect(f.logs[0]?.fields).toEqual({ oidc_callback_refusal: reason });
      // And the classifier never saw it: a `defect` line would carry these.
      const line = JSON.stringify(f.logs[0]?.fields ?? {});
      expect(line).not.toContain('oidc_failure_kind');
      expect(line).not.toContain('evil.test');
    });
  }

  /**
   * The negative control for the branch above, and the reason `exchange` awaits
   * `config()` before it compares anything: a provider that is down during
   * discovery must still be an outage. If the refusal branch ever widened to
   * catch every rejection, this case would go 400 and green would be a lie.
   */
  it('still answers a discovery outage 503 rather than the callback refusal 400', async () => {
    const f = fixture(
      claims,
      {},
      {
        exchange: () =>
          Promise.reject(
            Object.assign(new TypeError('fetch failed'), {
              cause: Object.assign(new Error('getaddrinfo EAI_AGAIN puni.okta.com'), {
                code: 'EAI_AGAIN',
              }),
            }),
          ),
      },
    );
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(res.status).toBe(503);
    expect(f.logs[0]?.level).toBe('error');
    expect(JSON.stringify(f.logs[0]?.fields ?? {})).toContain('"oidc_failure_kind":"unavailable"');
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
        headers: cookieHeader(jarOf('binding-1')),
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
        headers: cookieHeader(jarOf('binding-1')),
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
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).not.toContain('__Host-wbs_access=');
  });

  it('refuses an OIDC identity conflict without a response body', async () => {
    const f = fixture();
    f.users.resolveOidcIdentity = () => Promise.resolve(null);
    f.transactions.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    const res = await f.app.handle(
      new Request('https://dev.wbs.test/api/auth/okta/callback?code=c&state=state-1', {
        headers: cookieHeader(jarOf('binding-1')),
      }),
    );

    expect(res.status).toBe(409);
    // Proof: restoring oidc_identity_conflict made this receive its JSON envelope.
    expect(await res.text()).toBe('');
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
        headers: { ...cookieHeader(jarOf('binding-1')), 'x-forwarded-proto': 'https' },
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
      oidcOptionsModule as unknown as {
        oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown;
      }
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
      oidcOptionsModule as unknown as {
        oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown;
      }
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
      oidcOptionsModule as unknown as {
        oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown;
      }
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
      oidcOptionsModule as unknown as {
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

describe('OIDC authentication failure boundaries', () => {
  const request = () =>
    new Request('https://dev.wbs.test/api/auth/me', {
      headers: { authorization: 'Bearer access-1' },
    });

  it('keeps OIDC account resolution faults as server failures', async () => {
    const f = fixture();
    expect((await f.app.handle(request())).status).toBe(200);
    f.users.resolveOidcIdentity = () => Promise.reject(new Error('identity store unavailable'));
    expect((await f.app.handle(request())).status).toBe(500);
  });

  it('keeps unexpected verifier failures as server failures', async () => {
    const f = fixture();
    expect((await f.app.handle(request())).status).toBe(200);
    f.oidc.verifier.verify = () => Promise.reject(new Error('discovery unavailable'));
    expect((await f.app.handle(request())).status).toBe(500);
  });

  it('refuses malformed identity claims as credentials', async () => {
    const f = fixture({ sub: 'subject-1' });
    expect((await f.app.handle(request())).status).toBe(401);
  });
});

it('checks password-route origin before reporting a disabled route', async () => {
  const f = fixture(undefined, { passwordLoginEnabled: false });
  for (const action of ['login', 'register']) {
    const origins: Record<string, string>[] = [{}, { origin: 'https://foreign.example' }];
    for (const headers of origins) {
      const response = await f.app.handle(
        new Request(`https://dev.wbs.test/api/auth/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ username: 'disabled', password: 'valid-password-123' }),
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid_origin' });
    }
  }
});
