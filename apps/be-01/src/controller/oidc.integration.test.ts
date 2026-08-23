import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { testAuthService } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import * as authModule from './auth.controller';

const now = Date.UTC(2026, 7, 23);

function fixture() {
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
    mode: 'oidc' as const,
    now: () => now,
    random: () => random.shift() ?? 'extra-random',
    redirectUri: 'https://dev.wbs.test/api/auth/okta/callback',
    tokens,
    transactions,
  };
  const app = buildApp({
    auth: testAuthService(),
    capacity: testCapacityService(),
    directory: testDirectoryService(),
    history: testHistoryService(),
    internalAuthSecret: 'x'.repeat(32),
    migrationsApplied: true,
    oidc,
    priorityBands: testPriorityBandService(),
    probeDatabase: () => 'ok',
    projects: testProjectService(),
    replay: testReplay().replay,
    roles: testRoleService(),
    workItems: testWorkItemService(),
  });
  return { app, calls, tokens, transactions };
}

describe('OIDC browser routes', () => {
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
  it('refuses a redirect URI whose callback path is not mounted', () => {
    const factory = (
      authModule as unknown as { oidcRouteOptionsFromEnv: (env: Record<string, string>) => unknown }
    ).oidcRouteOptionsFromEnv;
    expect(() =>
      factory({
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
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
          mode: string;
        };
      }
    ).oidcRouteOptionsFromEnv;
    expect(
      factory({
        AUTH_CLIENT_ID: 'client',
        AUTH_CLIENT_SECRET: 'secret',
        AUTH_ISSUER_DISCOVERY_URL: 'https://idp.test',
        AUTH_REDIRECT_URI: 'https://dev.wbs.test/api/auth/okta/callback',
      }),
    ).toMatchObject({ appOrigin: 'https://dev.wbs.test', mode: 'oidc' });
  });
});
