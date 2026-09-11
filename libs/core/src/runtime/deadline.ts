import type { Timers } from '../ports/timers';

/** The request exhausted its application budget, independently of network timeouts. */
export class DeadlineExceeded extends Error {
  override name = 'DeadlineExceeded';
}

/**
 * Runs an operation with cancellation held through all of its asynchronous work.
 * The signal must reach the transport, including response-body consumption. Racing
 * settlement also bounds a misbehaving adapter; it does not prove that adapter stopped.
 */
export async function withinDeadline<T>(
  timers: Timers,
  ms: number,
  act: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const expiresAt = timers.nowMs() + ms;
  const controller = new AbortController();
  const cancelParent = (): void => {
    controller.abort(parent?.reason);
  };
  // Proof: ignoring an already-aborted parent made its client test issue one
  // fetch instead of zero (push-deadline.test.ts).
  if (parent?.aborted === true) cancelParent();
  else parent?.addEventListener('abort', cancelParent, { once: true });
  const cancelTimer = timers.schedule(ms, () => {
    controller.abort(new DeadlineExceeded('request deadline exceeded'));
  });
  try {
    const value = await untilAborted(controller.signal, () => act(controller.signal));
    // Proof: without the clock check a delayed-timer test returned delivered=1
    // after its 250ms deadline instead of an error.
    if (timers.nowMs() >= expiresAt)
      controller.abort(new DeadlineExceeded('request deadline exceeded'));
    controller.signal.throwIfAborted();
    return value;
  } finally {
    // Proof: omitted cleanup left three active timers after successful socket
    // retry instead of zero (push-deadline.test.ts).
    cancelTimer();
    parent?.removeEventListener('abort', cancelParent);
  }
}

/** Settles cancellation even when an injected operation ignores its signal. */
export async function untilAborted<T>(signal: AbortSignal, act: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('request cancelled', { cause: reason }));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([act(), cancelled]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** A retry delay owned by the same cancellation lifetime as the request. */
export async function delay(timers: Timers, ms: number, signal: AbortSignal): Promise<void> {
  let clear = (): void => undefined;
  try {
    await untilAborted(
      signal,
      () =>
        new Promise<void>((resolve) => {
          clear = timers.schedule(ms, resolve);
        }),
    );
  } finally {
    clear();
  }
}
