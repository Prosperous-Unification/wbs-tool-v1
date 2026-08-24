import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDGE_UNAUTHORIZED, login, me, websocketUrl } from './api';

/** A Response as the edge or the app would really produce one. */
function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login error codes', () => {
  it('names the site gate when the edge rejects the request', async () => {
    // Reproduces what a browser with a wrong site password receives: the edge
    // answers before be-01 is reached, with its own challenge header and an
    // HTML body. Observed on dev 2026-08-05, four consecutive times, while the
    // app reported only "Something went wrong (http_401)".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          response(401, '<html>401 Unauthorized</html>', {
            'www-authenticate': 'Basic realm="restricted"',
          }),
        ),
      ),
    );
    await expect(login('ada', 'lovelace99')).rejects.toThrow(EDGE_UNAUTHORIZED);
  });

  it('keeps the app’s own 401 distinct from the edge’s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(response(401, JSON.stringify({ error: 'invalid_credentials' }))),
      ),
    );
    await expect(login('ada', 'wrong')).rejects.toThrow('invalid_credentials');
  });

  it('surfaces a named code when a 200 is not the JSON this app expects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(response(200, 'not json at all'))),
    );
    await expect(login('ada', 'lovelace99')).rejects.toThrow('unexpected_response');
  });

  it('returns the session on success', async () => {
    const session = { token: 't', user: { id: 'u', username: 'ada' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(response(200, JSON.stringify(session)))),
    );
    await expect(login('ada', 'lovelace99')).resolves.toEqual(session);
  });
});

describe('me', () => {
  it('uses the browser cookie and sends no application token header', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(response(200, JSON.stringify({ user: { id: 'u', username: 'ada' } }))),
    );
    vi.stubGlobal('fetch', fetchMock);

    await me();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-wbs-token']).toBeUndefined();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('reports a rejected token as signed-out rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(response(401, '{}'))),
    );
    await expect(me()).resolves.toBeNull();
  });
});

describe('websocketUrl', () => {
  it('relies on the browser cookie and puts no token in the URL', () => {
    expect(websocketUrl()).toBe('ws://localhost:3000/ws');
  });
});
