import { systemTimers } from '@wbs/runtime-portable';
import { expect, it } from 'bun:test';

import { PushClient } from './push-client';

for (const phase of ['headers', 'body'] as const) {
  it(`aborts real fetch while gateway ${phase} stall`, async () => {
    let accepted = false;
    const transport = { cancelled: false };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        accepted = true;
        request.signal.addEventListener(
          'abort',
          () => {
            transport.cancelled = true;
          },
          { once: true },
        );
        if (phase === 'headers') return new Promise<Response>(() => undefined);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"delivered_to_sockets":'));
            },
            cancel() {
              transport.cancelled = true;
            },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    try {
      const client = new PushClient({
        ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
        gwUrl: server.url.origin,
        secret: 's',
        attemptMs: 100,
        overallMs: 1000,
        maxRetries: 0,
      });
      expect(
        await client
          .push({ subscription: 'doc:a', seq: 1, message: {} })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
      expect(accepted).toBe(true);
      const cutoff = performance.now() + 1000;
      while (!transport.cancelled && performance.now() < cutoff) await Bun.sleep(5);
      expect(transport.cancelled).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
}
