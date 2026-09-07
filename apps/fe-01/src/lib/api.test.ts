import { afterEach, describe, expect, it, vi } from 'vitest';

import { login, me, register, websocketUrl } from './api';

const response = (status: number, body: unknown) => Response.json(body, { status });
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shape-derived session requests', () => {
  it('validates every required login response field before returning a session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, { token: 't', user: { id: 'u' } }))),
    );
    await expect(login('ada', 'password')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema' },
    });
  });
  it('returns a validated session and preserves additive fields', async () => {
    const session = { token: 't', user: { id: 'u', username: 'ada', future: true } };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, session))),
    );
    await expect(login('ada', 'password')).resolves.toMatchObject({
      kind: 'success',
      body: session,
    });
  });
  it('returns typed login refusals only at their declared status', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(401, { error: 'invalid_credentials' }))
      .mockResolvedValueOnce(response(409, { error: 'invalid_credentials' }));
    vi.stubGlobal('fetch', send);
    await expect(login('ada', 'wrong')).resolves.toMatchObject({
      kind: 'refusal',
      status: 401,
      body: { error: 'invalid_credentials' },
    });
    await expect(login('ada', 'wrong')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'unexpected_status', status: 409 },
    });
  });
  it('keeps proxy challenges and malformed success responses as boundary failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('<html>Denied</html>', {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="site"' },
          }),
        )
        .mockResolvedValueOnce(new Response('not JSON', { status: 200 })),
    );
    const denied = await login('ada', 'password');
    expect(denied).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', status: 401 },
    });
    if (denied.kind !== 'failure' || denied.failure.code !== 'invalid_response')
      throw new Error('proxy fixture not refused');
    expect(denied.failure.headers.get('www-authenticate')).toBe('Basic realm="site"');
    await expect(login('ada', 'password')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'json' },
    });
  });
  it('uses the register shape and same-origin cookie transport without a token header', async () => {
    const send = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(response(200, { token: '', user: { id: 'u', username: 'ada' } })),
    );
    vi.stubGlobal('fetch', send);
    await register('ada', 'password');
    expect(send.mock.calls[0]?.[0]).toBe('/api/auth/register');
    const init = send.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-wbs-token')).toBe(false);
    expect(init?.body).toBe(JSON.stringify({ username: 'ada', password: 'password' }));
  });
  it('does not share requests or capture a stale fetch implementation', async () => {
    const send = vi.fn(() => Promise.resolve(response(401, { error: 'invalid_token' })));
    vi.stubGlobal('fetch', send);
    await Promise.all([me(), me()]);
    expect(send).toHaveBeenCalledTimes(2);
    const replacement = vi.fn(() => Promise.resolve(response(401, { error: 'invalid_token' })));
    vi.stubGlobal('fetch', replacement);
    await me();
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});

describe('current session', () => {
  it('validates scopes and distinguishes rejected credentials from an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response(200, { user: { id: 'u', username: 'ada' } }))
        .mockResolvedValueOnce(response(401, { error: 'invalid_token' }))
        .mockResolvedValueOnce(response(503, {})),
    );
    await expect(me()).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema' },
    });
    await expect(me()).resolves.toMatchObject({
      kind: 'refusal',
      body: { error: 'invalid_token' },
    });
    await expect(me()).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'unexpected_status', status: 503 },
    });
  });
  it('models a transport rejection without treating it as an application refusal', async () => {
    const cause = new Error('offline');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(cause)),
    );
    await expect(me()).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'transport', cause },
    });
  });

  it('reads the server’s explicit anonymous state without an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, { user: null }))),
    );
    await expect(me()).resolves.toMatchObject({
      kind: 'success',
      body: { user: null },
    });
  });
});

it('puts no credential in the websocket URL', () => {
  expect(websocketUrl()).toBe('ws://localhost:3000/ws');
});
