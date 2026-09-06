import { systemTimers } from '@wbs/runtime-portable';
import { describe, expect, it } from 'bun:test';

import { ForwardClient } from './forward-client';

describe('ForwardClient', () => {
  it('posts to be-01 /internal/forward with auth + identity headers', async () => {
    const client = new ForwardClient({
      beUrl: 'http://be',
      timers: systemTimers,
      attemptMs: 5000,
      overallMs: 15000,
      secret: 's',
      fetchImpl: (url, init) => {
        expect(url).toBe('http://be/internal/forward');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-internal-auth')).toBe('s');
        expect(headers.get('x-client-id')).toBe('u-1');
        expect(headers.get('x-connection-id')).toBe('c-1');
        return Promise.resolve(new Response(JSON.stringify({ ack: true }), { status: 200 }));
      },
    });
    const r = await client.forward(
      { type: 'ping' },
      { clientId: 'u-1', connectionId: 'c-1', traceId: 't-1' },
    );
    expect(r.ack).toBe(true);
  });

  it('throws when backend returns non-2xx', async () => {
    const client = new ForwardClient({
      beUrl: 'http://be',
      timers: systemTimers,
      attemptMs: 5000,
      overallMs: 15000,
      secret: 's',
      fetchImpl: () => Promise.resolve(new Response('boom', { status: 502 })),
    });
    let caught: unknown;
    try {
      await client.forward({}, { clientId: 'u', connectionId: 'c', traceId: 't' });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/502/);
  });
});
