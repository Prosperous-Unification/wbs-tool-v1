import { DeadlineExceeded } from '@wbs/runtime-portable';
import { DeadlineClock } from '@wbs/runtime-portable/testing';
import { expect, it } from 'bun:test';

import { ForwardClient } from './forward-client';
import { ResumeClient } from './resume-client';

const context = { clientId: 'u', connectionId: 'c', traceId: 't' };
for (const kind of ['forward', 'resume'] as const) {
  for (const stage of ['headers', 'body'] as const) {
    it(`${kind} aborts stalled ${stage} within the overall budget with one attempt`, async () => {
      const timers = new DeadlineClock();
      let calls = 0;
      let aborted = false;
      const options = {
        beUrl: 'http://be',
        secret: 's',
        timers,
        attemptMs: 1000,
        overallMs: 250,
        fetchImpl: (_url: string, init?: RequestInit) => {
          calls++;
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
          if (stage === 'headers') return new Promise<Response>(() => undefined);
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener(
                    'abort',
                    () => {
                      controller.error(new Error('cancelled body'));
                    },
                    { once: true },
                  );
                },
              }),
            ),
          );
        },
      };
      const client = kind === 'forward' ? new ForwardClient(options) : new ResumeClient(options);
      let settled = false;
      const pending = (
        client instanceof ForwardClient
          ? client.forward({}, context)
          : client.resume({ presence: 0 }, context)
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await timers.advance(249);
      expect(settled).toBe(false);
      await timers.advance(1);
      expect(aborted).toBe(true);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(DeadlineExceeded);
      await timers.advance(2000);
      expect(calls).toBe(1);
      expect(timers.active).toBe(0);
    });
  }
  it(`${kind} refuses non-2xx even with valid success JSON and rejects malformed replies`, async () => {
    const timers = new DeadlineClock();
    for (const [status, body] of [
      [503, kind === 'forward' ? { ack: true } : { presence: { status: 'replaying', events: [] } }],
      [200, { ack: 'wrong' }],
    ] as const) {
      const options = {
        beUrl: 'http://be',
        secret: 's',
        timers,
        attemptMs: 100,
        overallMs: 1000,
        fetchImpl: () => Promise.resolve(Response.json(body, { status })),
      };
      const pending =
        kind === 'forward'
          ? new ForwardClient(options).forward({}, context)
          : new ResumeClient(options).resume({ presence: 0 }, context);
      expect(await pending.catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(timers.active).toBe(0);
    }
  });
  it(`${kind} propagates unknown transport failures and caller cancellation without retry`, async () => {
    const timers = new DeadlineClock();
    const sentinel = new TypeError('unexpected transport bug');
    let calls = 0;
    const options = {
      beUrl: 'http://be',
      secret: 's',
      timers,
      attemptMs: 100,
      overallMs: 1000,
      fetchImpl: () => {
        calls++;
        return Promise.reject(sentinel);
      },
    };
    const invoke = (signal?: AbortSignal) =>
      kind === 'forward'
        ? new ForwardClient(options).forward({}, context, signal)
        : new ResumeClient(options).resume({ presence: 0 }, context, signal);
    expect(await invoke().catch((error: unknown) => error)).toBe(sentinel);
    const cancellation = new AbortController();
    cancellation.abort(sentinel);
    expect(await invoke(cancellation.signal).catch((error: unknown) => error)).toBe(sentinel);
    expect(calls).toBe(1);
    expect(timers.active).toBe(0);
  });
}

for (const kind of ['forward', 'resume'] as const) {
  it(`${kind} enforces attempt budget and rejects invalid budgets`, async () => {
    const timers = new DeadlineClock();
    let calls = 0;
    const options = {
      beUrl: 'http://be',
      secret: 's',
      timers,
      attemptMs: 100,
      overallMs: 1000,
      fetchImpl: () => {
        calls++;
        return new Promise<Response>(() => undefined);
      },
    };
    const invoke = (attemptMs: number, overallMs: number) =>
      kind === 'forward'
        ? new ForwardClient({ ...options, attemptMs, overallMs }).forward({}, context)
        : new ResumeClient({ ...options, attemptMs, overallMs }).resume({ presence: 0 }, context);
    for (const [attempt, overall] of [
      [0, 1000],
      [100, Infinity],
      [-1, 1000],
      [NaN, 1000],
    ]) {
      const refusal = invoke(attempt, overall).catch((error: unknown) => error);
      expect(calls).toBe(0);
      expect(await refusal).toBeInstanceOf(Error);
    }
    expect(calls).toBe(0);
    let settled = false;
    const pending = invoke(100, 1000).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await timers.advance(99);
    expect(settled).toBe(false);
    await timers.advance(1);
    expect(settled).toBe(true);
    expect(await pending).toBeInstanceOf(DeadlineExceeded);
    expect(calls).toBe(1);
    expect(timers.active).toBe(0);
  });
}
