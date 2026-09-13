import { expect, it } from 'bun:test';

import { delay, withinDeadline } from './deadline';
import { DeadlineClock } from './testing';

it('cancels the transport before settling an operation that ignores its signal', async () => {
  const timers = new DeadlineClock();
  let cancelled = false;
  const pending = withinDeadline(timers, 100, (signal) => {
    signal.addEventListener(
      'abort',
      () => {
        cancelled = true;
      },
      { once: true },
    );
    return new Promise<never>(() => undefined);
  }).catch((error: unknown) => error);
  await timers.advance(100);
  expect(cancelled).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
  expect(timers.active).toBe(0);
});
it('cancels backoff without retaining a scheduled callback', async () => {
  const timers = new DeadlineClock();
  const cancellation = new AbortController();
  const pending = delay(timers, 500, cancellation.signal).catch((error: unknown) => error);
  expect(timers.active).toBe(1);
  cancellation.abort(new Error('closed'));
  expect(await pending).toBeInstanceOf(Error);
  expect(timers.active).toBe(0);
});
