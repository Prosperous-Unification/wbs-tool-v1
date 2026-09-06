import { systemTimers } from '@wbs/runtime-portable';
import { DeadlineClock } from '@wbs/runtime-portable/testing';
import { describe, expect, it } from 'bun:test';

import { PushClient } from './push-client';

const payload = { subscription: 'doc:a', seq: 1, message: {} };

function heldFetch(): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal === undefined || init.signal === null) return;
        const signal = init.signal;
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('transport aborted'));
          },
          { once: true },
        );
      }),
  };
}

describe('PushClient deadlines', () => {
  it('cancels hung headers at the overall deadline even with zero retries', async () => {
    const timers = new DeadlineClock();
    const transport = heldFetch();
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      fetchImpl: transport.fetch,
      timers,
      attemptMs: 1000,
      overallMs: 250,
      maxRetries: 0,
    });
    let settled = false;
    const pending = client.push(payload).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await timers.advance(249);
    expect(settled).toBe(false);
    await timers.advance(1);
    expect(transport.signals).toHaveLength(1);
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    await timers.advance(1000);
    expect(transport.signals).toHaveLength(1);
    expect(timers.active).toBe(0);
  });
});

for (const status of [202, 400]) {
  it(`cancels a stalled ${String(status)} body after headers arrive`, async () => {
    const timers = new DeadlineClock();
    let aborted = false;
    const client = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      timers,
      attemptMs: 1000,
      overallMs: 250,
      maxRetries: 0,
      fetchImpl: (_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    controller.error(init.signal?.reason);
                  },
                  { once: true },
                );
              },
            }),
            { status },
          ),
        ),
    });
    let settled = false;
    const pending = client.push(payload).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await timers.advance(249);
    expect(settled).toBe(false);
    await timers.advance(1);
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(timers.active).toBe(0);
  });
}

it('retries timed-out attempts without exceeding the overall budget', async () => {
  const timers = new DeadlineClock();
  const transport = heldFetch();
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    attemptMs: 400,
    overallMs: 1000,
    maxRetries: 5,
    fetchImpl: transport.fetch,
  });
  let settled = false;
  const pending = client.push(payload).catch((error: unknown) => {
    settled = true;
    return error;
  });
  await timers.advance(400);
  expect(settled).toBe(false);
  expect(transport.signals).toHaveLength(1);
  await timers.advance(500);
  expect(transport.signals).toHaveLength(2);
  await timers.advance(99);
  expect(settled).toBe(false);
  await timers.advance(1);
  expect(settled).toBe(true);
  expect(transport.signals.every((signal) => signal.aborted)).toBe(true);
  await pending;
  await timers.advance(2000);
  expect(transport.signals).toHaveLength(2);
  expect(timers.active).toBe(0);
});

it('cancels retry backoff without issuing a later request', async () => {
  const timers = new DeadlineClock();
  const caller = new AbortController();
  let calls = 0;
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    attemptMs: 400,
    overallMs: 1000,
    maxRetries: 5,
    fetchImpl: () => {
      calls++;
      return Promise.resolve(new Response('busy', { status: 503 }));
    },
  });
  const pending = client.push(payload, caller.signal).catch((error: unknown) => error);
  await timers.flush();
  caller.abort(new Error('caller left'));
  await timers.flush();
  expect(await pending).toEqual(new Error('caller left'));
  await timers.advance(2000);
  expect(calls).toBe(1);
  expect(timers.active).toBe(0);
});

it('rejects invalid budgets and retry counts at construction', () => {
  for (const policy of [
    { attemptMs: 0 },
    { overallMs: Infinity },
    { maxRetries: -1 },
    { maxRetries: 0.5 },
  ]) {
    expect(
      () =>
        new PushClient({
          ...{
            timers: systemTimers,
            fetchImpl: globalThis.fetch,
            attemptMs: 5000,
            overallMs: 15000,
          },
          gwUrl: 'http://gw',
          secret: 's',
          ...policy,
        }),
    ).toThrow();
  }
});

it('starts no request for an already cancelled caller', async () => {
  const timers = new DeadlineClock();
  const caller = new AbortController();
  caller.abort(new Error('gone'));
  let calls = 0;
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    fetchImpl: () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    },
  });
  const failure = await client.push(payload, caller.signal).catch((error: unknown) => error);
  expect(calls).toBe(0);
  expect(failure).toEqual(new Error('gone'));
  expect(timers.active).toBe(0);
});

it('rejects malformed trusted acknowledgements without retrying', async () => {
  let calls = 0;
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    fetchImpl: () => {
      calls++;
      return Promise.resolve(Response.json({ delivered_to_sockets: 'wrong' }));
    },
  });
  expect(await client.push(payload).catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(calls).toBe(1);
});

it('propagates unknown transport failures without retrying', async () => {
  const failure = new TypeError('programmer failure');
  let calls = 0;
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    fetchImpl: () => {
      calls++;
      return Promise.reject(failure);
    },
  });
  expect(await client.push(payload).catch((error: unknown) => error)).toBe(failure);
  expect(calls).toBe(1);
});

it('retries a modeled socket failure within the same overall budget', async () => {
  const timers = new DeadlineClock();
  let calls = 0;
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    overallMs: 1000,
    fetchImpl: () => {
      calls++;
      if (calls === 1)
        return Promise.reject(
          Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
      return Promise.resolve(Response.json({ delivered_to_sockets: 2 }));
    },
  });
  const pending = client.push(payload);
  const observed = pending.catch((error: unknown) => error);
  await timers.flush();
  await timers.advance(500);
  expect(calls).toBe(2);
  expect(await observed).toEqual({ delivered: 2 });
  expect(timers.active).toBe(0);
});

it('refuses a response that settles after the clock deadline before its timer fires', async () => {
  let now = 0;
  const timers = { nowMs: () => now, schedule: () => () => undefined };
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    overallMs: 250,
    maxRetries: 0,
    fetchImpl: () => {
      now = 251;
      return Promise.resolve(Response.json({ delivered_to_sockets: 1 }));
    },
  });
  expect(await client.push(payload).catch((error: unknown) => error)).toBeInstanceOf(Error);
});

it('admits no retry after the overall clock expires before timers fire', async () => {
  let now = 0;
  let calls = 0;
  const timers = { nowMs: () => now, schedule: () => () => undefined };
  const client = new PushClient({
    ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    overallMs: 250,
    sleep: () => Promise.resolve(),
    fetchImpl: () => {
      calls++;
      now = 251;
      return Promise.resolve(new Response('busy', { status: 503 }));
    },
  });
  const failure = await client.push(payload).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(calls).toBe(1);
});

it('does not retry a permanent refusal when its diagnostic body times out', async () => {
  const timers = new DeadlineClock();
  let calls = 0;
  let bodyAborted = false;
  const client = new PushClient({
    gwUrl: 'http://gw',
    secret: 's',
    timers,
    attemptMs: 100,
    overallMs: 1000,
    maxRetries: 5,
    fetchImpl: (_url, init) => {
      calls++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  bodyAborted = true;
                  controller.error(new Error('diagnostic body aborted'));
                },
                { once: true },
              );
            },
          }),
          { status: 400 },
        ),
      );
    },
  });
  let settled = false;
  const pending = client.push(payload).catch((error: unknown) => {
    settled = true;
    return error;
  });
  await timers.advance(100);
  expect(bodyAborted).toBe(true);
  await timers.advance(500);
  expect(calls).toBe(1);
  expect(settled).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
  await timers.advance(1000);
  expect(calls).toBe(1);
  expect(timers.active).toBe(0);
});
