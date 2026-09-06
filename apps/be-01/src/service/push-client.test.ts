import { systemTimers } from '@wbs/runtime-portable';
import { describe, expect, it } from 'bun:test';

import { PushClient, PushFailed } from './push-client';

describe('PushClient', () => {
  it('posts to /internal/push and returns response', async () => {
    let called = 0;
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw:3200',
      secret: 'sec',
      fetchImpl: (url, init) => {
        called++;
        expect(url).toBe('http://gw:3200/internal/push');
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-Internal-Auth']).toBe('sec');
        return Promise.resolve(
          new Response(JSON.stringify({ delivered_to_sockets: 2 }), { status: 202 }),
        );
      },
      sleep: () => Promise.resolve(),
      maxRetries: 1,
    });
    const result = await client.push({ subscription: 'doc:a', seq: 1, message: {} });
    expect(called).toBe(1);
    expect(result.delivered).toBe(2);
  });

  it('retries with exponential backoff on 5xx then succeeds', async () => {
    let attempts = 0;
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      fetchImpl: () => {
        attempts++;
        if (attempts < 3) return Promise.resolve(new Response('err', { status: 500 }));
        return Promise.resolve(
          new Response(JSON.stringify({ delivered_to_sockets: 1 }), { status: 202 }),
        );
      },
      sleep: () => Promise.resolve(),
      maxRetries: 5,
    });
    const result = await client.push({ subscription: 'doc:a', seq: 1, message: {} });
    expect(attempts).toBe(3);
    expect(result.delivered).toBe(1);
  });

  it('raises PushFailed after exceeding retries', async () => {
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      fetchImpl: () => Promise.resolve(new Response('err', { status: 503 })),
      sleep: () => Promise.resolve(),
      maxRetries: 2,
    });
    let caught: unknown;
    try {
      await client.push({ subscription: 'doc:a', seq: 1, message: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PushFailed);
  });

  it('raises PushFailed immediately on 4xx (non-408/429)', async () => {
    let calls = 0;
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      fetchImpl: () => {
        calls++;
        return Promise.resolve(new Response('bad', { status: 400 }));
      },
      sleep: () => Promise.resolve(),
      maxRetries: 5,
    });
    let caught: unknown;
    try {
      await client.push({ subscription: 'doc:a', seq: 1, message: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PushFailed);
    expect(calls).toBe(1);
  });
});
