import { systemTimers } from '@wbs/runtime-portable';
import { expect, it } from 'bun:test';

import { buildApp } from './app';

async function until(ready: () => boolean, budgetMs = 2000): Promise<void> {
  const expires = Date.now() + budgetMs;
  while (!ready()) {
    if (Date.now() >= expires)
      throw new Error('expected transport or socket transition did not arrive');
    await Bun.sleep(5);
  }
}

for (const kind of ['forward', 'resume'] as const) {
  for (const stage of ['headers', 'body'] as const) {
    for (const closes of [false, true]) {
      it(`${kind} ${stage}: ${closes ? 'close cancels without late frames or failure metrics' : 'deadline cancels real transport and socket still pings'}`, async () => {
        let calls = 0;
        let cancelled = false;
        const backend = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch(request) {
            calls++;
            request.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
              },
              { once: true },
            );
            if (stage === 'headers') return new Promise<Response>(() => undefined);
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{'));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          },
        });
        const app = buildApp({
          beUrl: `http://127.0.0.1:${String(backend.port)}`,
          internalAuthSecret: 's'.repeat(32),
          jwtKey: 'k'.repeat(32),
          localIdentity: 'deadline-test',
          requests: { timers: systemTimers, attemptMs: closes ? 1000 : 100, overallMs: 2000 },
        });
        app.listen(0);
        const port = app.server?.port;
        if (port === undefined) throw new Error('gateway did not start');
        const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
        const frames: { type?: string; code?: string; reason?: string }[] = [];
        socket.addEventListener('message', (event: MessageEvent<string>) => {
          frames.push(JSON.parse(event.data) as { type?: string; code?: string; reason?: string });
        });
        try {
          await until(() => frames.some((frame) => frame.type === 'presence'));
          socket.send(
            JSON.stringify(
              kind === 'forward'
                ? { subscription: 'presence', message: { write: true } }
                : { type: 'resume', resume_points: { presence: 0 } },
            ),
          );
          await until(() => calls === 1);
          if (closes) {
            socket.close();
            await until(() => app.decorator.metrics.counters.activeConnections === 0);
            await until(() => cancelled, 250);
            expect(app.decorator.metrics.counters.backendUnavailableTotal).toBe(0);
            expect(app.decorator.metrics.counters.droppedFramesTotal).toBe(0);
            await Bun.sleep(150);
            expect(frames.map((frame) => frame.type)).toEqual(['presence']);
            expect(app.decorator.metrics.counters.backendUnavailableTotal).toBe(0);
            expect(app.decorator.metrics.counters.droppedFramesTotal).toBe(0);
          } else {
            await until(() =>
              frames.some((frame) =>
                kind === 'forward'
                  ? frame.code === 'backend_unavailable'
                  : frame.type === 'resume_ack',
              ),
            );
            await until(() => cancelled);
            if (kind === 'resume')
              expect(frames.some((frame) => frame.reason === 'unavailable')).toBe(true);
            socket.send('{"type":"ping"}');
            await until(() => frames.some((frame) => frame.type === 'pong'));
          }
          expect(calls).toBe(1);
          expect(cancelled).toBe(true);
        } finally {
          socket.close();
          await app.stop(true);
          await backend.stop(true);
        }
      });
    }
  }
}

it('maps success-shaped 503 resume replies to unavailable on the live socket', async () => {
  const app = buildApp({
    beUrl: 'http://be.invalid',
    internalAuthSecret: 's'.repeat(32),
    jwtKey: 'k'.repeat(32),
    localIdentity: 'status-test',
    fetchImpl: () =>
      Promise.resolve(
        Response.json(
          {
            presence: { status: 'replaying', events: [{ seq: 1, message: { unexpected: true } }] },
          },
          { status: 503 },
        ),
      ),
  });
  app.listen(0);
  const port = app.server?.port;
  if (port === undefined) throw new Error('gateway did not start');
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  const frames: unknown[] = [];
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    frames.push(JSON.parse(event.data));
  });
  try {
    await until(() => frames.length === 1);
    socket.send('{"type":"resume","resume_points":{"presence":0}}');
    await until(() => frames.length === 3);
    expect(frames.slice(1)).toEqual([
      { type: 'resume_denied', subscription: 'presence', reason: 'unavailable' },
      { type: 'resume_ack', replayed: {} },
    ]);
  } finally {
    socket.close();
    await app.stop(true);
  }
});
