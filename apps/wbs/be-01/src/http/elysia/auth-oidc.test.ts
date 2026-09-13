import { InMemoryOidcTransactionStore, InMemoryTokenStore } from '@wbs/auth';
import { expect, spyOn, test } from 'bun:test';

import { authOidcEndpoints } from '../../controller/auth-oidc-endpoints';
import type { OidcRouteOptions } from '../../controller/oidc-options';
import { testAuthService } from '../../testing/auth-fixture';
import { mountEndpoints } from './mount';

const origin = 'https://app.test';
const claims = {
  iss: 'https://provider.test',
  sub: 'subject',
  email: 'person@example.com',
  email_verified: true,
  wbs_groups: ['dev:wbs:read', 'dev:wbs:write'],
};
function fixture() {
  let clock = 1000;
  let counter = 0;
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const exchanges: Request[] = [];
  const refreshed: string[] = [];
  const revoked: string[] = [];
  const options: OidcRouteOptions = {
    mode: 'oidc',
    appOrigin: origin,
    redirectUri: `${origin}/api/auth/okta/callback`,
    groupPrefix: 'dev',
    groupsClaim: 'wbs_groups',
    now: () => clock,
    random: () => `random-${String(++counter)}`,
    transactions: new InMemoryOidcTransactionStore({ now: () => clock, ttlMs: 300000 }),
    tokens: new InMemoryTokenStore({ now: () => clock }),
    verifier: { verify: () => Promise.resolve(claims) },
    logger: {
      info: (fields) => {
        logs.push({ level: 'info', fields });
      },
      warn: (fields) => {
        logs.push({ level: 'warn', fields });
      },
      error: (fields) => {
        logs.push({ level: 'error', fields });
      },
    },
    client: {
      authorizationUrl: () => Promise.resolve(new URL('https://provider.test/authorize')),
      exchange: (request) => {
        exchanges.push(request);
        return Promise.resolve({
          accessToken: 'access',
          expiresIn: 900,
          refreshToken: 'refresh',
          idTokenClaims: claims,
        });
      },
      refresh: (token) => {
        refreshed.push(token);
        return Promise.resolve({ accessToken: 'next', expiresIn: 600, refreshToken: 'rotated' });
      },
      revoke: (token) => {
        revoked.push(token);
        return Promise.resolve();
      },
    },
  };
  const auth = testAuthService();
  const resolve = spyOn(auth, 'resolveOidcIdentity').mockResolvedValue({
    id: 'account',
    username: 'person',
    passwordHash: null,
    createdAt: 1,
  });
  const app = mountEndpoints(authOidcEndpoints(auth, options), {
    appOrigin: origin,
    resolveIdentity: () => {
      return Promise.reject(new Error('OIDC handshakes do not resolve an access identity'));
    },
  });
  const send = (path: string, init?: RequestInit) =>
    app.handle(new Request(`${origin}${path}`, init));
  const start = async () => {
    const response = await send('/api/auth/login');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://provider.test/authorize');
    return response.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  };
  const callback = (cookie: string, query = 'state=random-2&code=ok', method = 'GET') =>
    send(`/api/auth/okta/callback?${query}`, { method, headers: { cookie } });
  return {
    options,
    auth,
    resolve,
    app,
    send,
    start,
    callback,
    exchanges,
    logs,
    refreshed,
    revoked,
    expire: () => {
      clock += 300001;
    },
  };
}

test('HEAD and every duplicate key leave the browser login unspent', async () => {
  for (const query of [
    'state=random-2&state=forged',
    'state=random-2&code=a&code=b',
    'state=random-2&future=a&future=b',
  ]) {
    const f = fixture();
    const cookie = await f.start();
    const head = await f.callback(cookie, 'state=random-2&code=ok', 'HEAD');
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    expect(head.headers.getSetCookie()).toEqual([]);
    expect(f.exchanges).toEqual([]);
    const duplicate = await f.callback(cookie, query);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_parameter' });
    expect(duplicate.headers.getSetCookie()).toEqual([]);
    expect(f.exchanges).toEqual([]);
    const honest = await f.callback(cookie, 'state=random-2&code=ok&future=accepted');
    expect(honest.status).toBe(302);
    expect(f.exchanges).toHaveLength(1);
    expect(f.exchanges[0]?.url).toBe(
      `${origin}/api/auth/okta/callback?state=random-2&code=ok&future=accepted`,
    );
  }
});

test('live mismatch retains cookies for honest recovery; expired and missing bindings clear', async () => {
  const f = fixture();
  const absent = await f.callback('', 'state=random-2&code=ok');
  expect(absent.status).toBe(400);
  // Proof: serializing a declared bodyless refusal as
  // `{"error":"restored-envelope"}` failed on Expected: "", Received: that envelope.
  expect(await absent.text()).toBe('');
  expect(absent.headers.getSetCookie()).toEqual([]);
  let cookie = await f.start();
  const bindingName = cookie.split('=')[0] ?? '';
  const clearedBinding = `${bindingName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  const forged = await f.callback(cookie, 'state=forged&error=access_denied');
  expect(forged.status).toBe(400);
  expect(await forged.text()).toBe('');
  expect(forged.headers.getSetCookie()).toEqual([]);
  for (const changed of forged.headers.getSetCookie()) cookie = changed.split(';')[0] ?? '';
  const honest = await f.callback(cookie);
  expect(honest.status).toBe(302);
  expect(honest.headers.getSetCookie()).toEqual([
    clearedBinding,
    '__Host-wbs_access=access; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=900',
    '__Host-wbs_session=random-5; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
  ]);
  expect(await honest.text()).toBe('');
  const missing = await f.callback(cookie);
  expect(missing.status).toBe(400);
  expect(await missing.text()).toBe('');
  expect(missing.headers.getSetCookie()).toEqual([clearedBinding]);
  const expired = fixture();
  const old = await expired.start();
  const oldName = old.split('=')[0] ?? '';
  expired.expire();
  const refused = await expired.callback(old);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toBe('');
  expect(refused.headers.getSetCookie()).toEqual([
    `${oldName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
});

test('provider refusals never exchange or reflect descriptions and blank errors stay400', async () => {
  for (const [error, reason, level] of [
    ['access_denied', 'access_denied', 'info'],
    ['account_selection_required', 'account_selection_required', 'info'],
    ['consent_required', 'consent_required', 'info'],
    ['interaction_required', 'interaction_required', 'info'],
    ['login_required', 'login_required', 'info'],
    ['temporarily_unavailable', 'temporarily_unavailable', 'info'],
    ['provider_secret', 'provider_error', 'warn'],
    ['', '', 'warn'],
  ]) {
    const f = fixture();
    const cookie = await f.start();
    const response = await f.callback(
      cookie,
      `state=random-2&error=${error}&error_description=PRIVATE`,
    );
    expect(response.status).toBe(error === '' ? 400 : 302);
    expect(response.headers.get('location')).toBe(error === '' ? null : `/?auth_error=${reason}`);
    expect(f.exchanges).toEqual([]);
    expect(f.logs[0]?.level).toBe(level);
    expect(JSON.stringify(f.logs)).not.toContain('PRIVATE');
    expect(response.headers.getSetCookie()).toHaveLength(1);
  }
});

test('exchange defects are classified as bodiless500 while account-store failures remain500', async () => {
  const f = fixture();
  const cookie = await f.start();
  const failure = new Error('provider unavailable');
  spyOn(f.options.client, 'exchange').mockRejectedValueOnce(failure);
  const response = await f.callback(cookie);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('');
  expect(f.logs).toContainEqual({
    level: 'error',
    fields: {
      err: failure,
      oidc_failure_kind: 'defect',
      oidc_failure_reason: 'unrecognised_failure',
    },
  });
  const broken = fixture();
  const next = await broken.start();
  broken.resolve.mockRejectedValueOnce(new Error('account store unavailable'));
  expect((await broken.callback(next)).status).toBe(500);
});

test('refresh and logout require cookie Origin before reading state and retain empty cookie replies', async () => {
  const f = fixture();
  f.options.tokens.save({
    sessionCorrelation: 'session',
    refreshToken: 'refresh',
    expiresAt: 100000,
  });
  const read = spyOn(f.options.tokens, 'read');
  for (const path of ['/api/auth/refresh', '/api/auth/logout']) {
    const refused = await f.send(path, {
      method: 'POST',
      headers: { cookie: '__Host-wbs_session=session' },
    });
    expect(refused.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  }
  const refreshed = await f.send('/api/auth/refresh', {
    method: 'POST',
    headers: { origin, cookie: '__Host-wbs_session=session' },
  });
  expect(refreshed.status).toBe(204);
  expect(await refreshed.text()).toBe('');
  expect(refreshed.headers.getSetCookie()).toEqual([
    '__Host-wbs_access=next; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
  ]);
  expect(f.refreshed).toEqual(['refresh']);
  const loggedOut = await f.send('/api/auth/logout', {
    method: 'POST',
    headers: { origin, cookie: '__Host-wbs_session=session' },
  });
  expect(loggedOut.status).toBe(204);
  expect(loggedOut.headers.getSetCookie()).toHaveLength(2);
  expect(f.revoked).toEqual(['rotated']);
  expect(f.options.tokens.read('session')).toBeNull();
  const missing = await f.send('/api/auth/refresh', { method: 'POST' });
  expect(missing.status).toBe(401);
  expect(await missing.json()).toEqual({ error: 'invalid_oidc_session' });
  expect(missing.headers.getSetCookie()).toHaveLength(2);
});

test.each(['missing', 'malformed', 'conflict'] as const)(
  '%s callback retains its distinct status and cleared binding',
  async (mode) => {
    const f = fixture();
    const cookie = await f.start();
    if (mode === 'conflict') f.resolve.mockResolvedValueOnce(null);
    else
      spyOn(f.options.client, 'exchange').mockResolvedValueOnce({
        accessToken: 'access',
        expiresIn: 1,
        ...(mode === 'malformed' ? { idTokenClaims: { sub: 'broken' } } : {}),
      });
    const response = await f.callback(cookie);
    expect(response.status).toBe(mode === 'conflict' ? 409 : 401);
    // Proof: serializing declared bodyless refusals as `{"error":"restored-envelope"}`
    // failed both mounted 401 cases and the mounted 409 case on Expected: "", Received: that envelope.
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toHaveLength(1);
  },
);

test('refresh refuses lost rotation, retains a nonrotating token, and leaves unknown outages as500', async () => {
  const f = fixture();
  f.options.tokens.save({
    sessionCorrelation: 'session',
    refreshToken: 'refresh',
    expiresAt: 100000,
  });
  const request = { method: 'POST', headers: { origin, cookie: '__Host-wbs_session=session' } };
  const rotate = spyOn(f.options.tokens, 'rotate').mockReturnValueOnce('missing');
  const refused = await f.send('/api/auth/refresh', request);
  expect(refused.status).toBe(401);
  expect(refused.headers.getSetCookie()).toHaveLength(2);
  rotate.mockRestore();
  spyOn(f.options.client, 'refresh').mockResolvedValueOnce({
    accessToken: 'unchanged',
    expiresIn: 3,
  });
  expect((await f.send('/api/auth/refresh', request)).status).toBe(204);
  expect(f.options.tokens.read('session')?.refreshToken).toBe('refresh');
  spyOn(f.options.client, 'refresh').mockRejectedValueOnce(new Error('refresh unavailable'));
  expect((await f.send('/api/auth/refresh', request)).status).toBe(500);
  spyOn(f.options.client, 'revoke').mockImplementationOnce(() => {
    expect(f.options.tokens.read('session')).toBeNull();
    return Promise.reject(new Error('revoke unavailable'));
  });
  expect((await f.send('/api/auth/logout', request)).status).toBe(500);
  expect(f.options.tokens.read('session')).toBeNull();
});

test('exchange uses configured HTTPS callback behind HTTP and forwards arrived headers', async () => {
  const f = fixture();
  const cookie = await f.start();
  const response = await f.app.handle(
    new Request('http://internal.test/api/auth/okta/callback?state=random-2&code=ok', {
      headers: { cookie, 'x-request-id': 'request-1' },
    }),
  );
  expect(response.status).toBe(302);
  expect(f.exchanges[0]?.url).toBe(`${origin}/api/auth/okta/callback?state=random-2&code=ok`);
  expect(f.exchanges[0]?.method).toBe('GET');
  expect(f.exchanges[0]?.headers.get('x-request-id')).toBe('request-1');
});
