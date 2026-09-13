import { describe, expect, it } from 'bun:test';

import { buildApp } from './app';

const OPTS = {
  beUrl: 'http://be',
  internalAuthSecret: 's'.repeat(32),
  jwtKey: 'k'.repeat(32),
  // A backend that answers, so the tests below are about their own subject.
  fetchImpl: (() => Promise.resolve(new Response('{"status":"ok"}'))) as unknown as typeof fetch,
};

describe('gw-01 /health', () => {
  it('returns 200 when the backend it forwards to answers', async () => {
    const app = buildApp(OPTS);
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
  });

  it('is unhealthy when be-01 cannot be reached', async () => {
    // Open finding 4: this endpoint was unconditional. A gateway whose `BE_URL`
    // was wrong passed the deploy's health gate, took the socket traffic, and
    // failed every forward — which the smoke test could not see either, because
    // it talks to be-01 directly.
    const app = buildApp({
      ...OPTS,
      fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const res = await app.handle(new Request('http://localhost/health'));

    expect(res.status).toBe(503);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: 'backend_unreachable',
    });
  });

  it('is unhealthy when be-01 answers but is not itself healthy', async () => {
    const app = buildApp({
      ...OPTS,
      fetchImpl: () =>
        Promise.resolve(new Response('{"status":"schema_missing"}', { status: 503 })),
    });

    const res = await app.handle(new Request('http://localhost/health'));

    expect(res.status).toBe(503);
  });
});

describe('gw-01 /metrics', () => {
  it('keeps the Prometheus representation after the shared Elysia plugin is removed', async () => {
    for (const scrape of [
      { status: 200 as const, text: 'gateway_connections 1\n' },
      { status: 500 as const, text: '# scrape errors: collector unavailable\n' },
    ]) {
      const response = await buildApp({
        ...OPTS,
        metricsScrape: () => Promise.resolve(scrape),
      }).handle(new Request('http://localhost/metrics'));
      expect(response.status).toBe(scrape.status);
      expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4');
      expect(await response.text()).toBe(scrape.text);
    }
  });
});

describe('POST /internal/push', () => {
  it('rejects without auth', async () => {
    const app = buildApp(OPTS);
    const res = await app.handle(
      new Request('http://localhost/internal/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: 'a', seq: 1, message: {} }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns delivered_to_sockets:0 when no subscribers', async () => {
    const app = buildApp(OPTS);
    const res = await app.handle(
      new Request('http://localhost/internal/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-auth': OPTS.internalAuthSecret,
        },
        body: JSON.stringify({ subscription: 'a', seq: 1, message: {} }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { delivered_to_sockets: number };
    expect(body.delivered_to_sockets).toBe(0);
  });

  it('rejects malformed body with 400', async () => {
    const app = buildApp(OPTS);
    const res = await app.handle(
      new Request('http://localhost/internal/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-auth': OPTS.internalAuthSecret,
        },
        body: JSON.stringify({ subscription: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
