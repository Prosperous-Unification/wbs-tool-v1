import { describe, expect, it } from 'bun:test';

import { cacheWhileItSucceeds } from './oidc-client';

/**
 * Returns whatever a promise rejected with, and fails the case if it resolved.
 *
 * `expect(p).rejects` is not used anywhere in this repository and does not lint
 * here — `@typescript-eslint/await-thenable` and `no-confusing-void-expression`
 * both reject `await expect(p).rejects.toThrow(…)`. This keeps the assertion
 * explicit instead: the rejection is a value, and the case says what it is.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    (value) => ({ rejected: false, value }),
    (error: unknown) => ({ rejected: true, value: error }),
  );
  expect(outcome.rejected).toBe(true);
  return outcome.value;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * A clock the case owns, and a jitter that is not random.
 *
 * `jitter: () => 1` makes the cooldown its full width, so every case below can
 * say exactly when the window closes instead of asserting a range.
 */
function stopped(at = 1_000_000) {
  let t = at;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const deterministic = (clock: { now: () => number }) => ({
  cooldownMs: 1_000,
  jitter: () => 1,
  now: clock.now,
});

// The first test file this adapter has ever had. It covers exactly one thing:
// the discovery cache, which used to hold onto a rejection forever. Nothing
// here imports `openid-client` — the cache is generic on purpose, so its
// behaviour can be asserted without standing up a provider.
describe('cacheWhileItSucceeds', () => {
  it('loads once and shares the result with every later caller', async () => {
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return Promise.resolve({ issuer: 'https://example.test' });
    });

    const first = await cached();
    const second = await cached();

    expect(loads).toBe(1);
    expect(second).toBe(first);
  });

  it('shares one in-flight load between callers that arrive together', async () => {
    let loads = 0;
    let release: ((value: string) => void) | undefined;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    const both = Promise.all([cached(), cached()]);
    release?.('discovered');

    expect(await both).toEqual(['discovered', 'discovered']);
    expect(loads).toBe(1);
  });

  // The defect this file was written for: one transient outage used to disable
  // sign-in until the process restarted, long after the provider recovered.
  it('does not cache a failure, so the next caller retries after the outage ends', async () => {
    const clock = stopped();
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('getaddrinfo ENOTFOUND idp.example.test'))
        : Promise.resolve('discovered');
    }, deterministic(clock));

    expect(messageOf(await rejectionOf(cached()))).toContain('ENOTFOUND');
    clock.advance(1_000);

    expect(await cached()).toBe('discovered');
    expect(loads).toBe(2);
  });

  // Peer pass 19, Important: forgetting the failure at once would let a public
  // caller drive one outbound discovery per request for as long as the provider
  // was down. The remembered rejection is served without a load instead.
  it('serves the remembered failure inside the cooldown without loading again', async () => {
    const clock = stopped();
    let loads = 0;
    const failure = new Error('provider still down');
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return Promise.reject(failure);
    }, deterministic(clock));

    expect(await rejectionOf(cached())).toBe(failure);
    clock.advance(999);
    expect(await rejectionOf(cached())).toBe(failure);
    expect(await rejectionOf(cached())).toBe(failure);

    expect(loads).toBe(1);
  });

  it('lets exactly one caller retry once the cooldown expires, and shares that attempt', async () => {
    const clock = stopped();
    let loads = 0;
    let release: ((value: string) => void) | undefined;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      if (loads === 1) return Promise.reject(new Error('first attempt fails'));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    }, deterministic(clock));

    expect(messageOf(await rejectionOf(cached()))).toBe('first attempt fails');
    clock.advance(1_000);

    const both = Promise.all([cached(), cached()]);
    release?.('discovered');

    expect(await both).toEqual(['discovered', 'discovered']);
    expect(loads).toBe(2);
  });

  // The classifier upstream reads the thrown value's own shape. A cache that
  // wrapped, replaced or swallowed the cause would silently break it — and the
  // one served from inside the cooldown has to be the same value too.
  it('rethrows the original failure untouched, so it can still be classified', async () => {
    const clock = stopped();
    const cause = Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    const cached = cacheWhileItSucceeds(() => Promise.reject(cause), deterministic(clock));

    expect(await rejectionOf(cached())).toBe(cause);
    expect(await rejectionOf(cached())).toBe(cause);
  });

  it('caches the success that follows a failure, rather than reloading forever', async () => {
    const clock = stopped();
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('first attempt fails'))
        : Promise.resolve(loads);
    }, deterministic(clock));

    expect(messageOf(await rejectionOf(cached()))).toBe('first attempt fails');
    clock.advance(1_000);

    expect(await cached()).toBe(2);
    expect(await cached()).toBe(2);
    expect(loads).toBe(2);
  });

  // A success has to clear the remembered failure, or the *next* outage would
  // be answered out of a stale cooldown that expired long ago.
  it('forgets a failure once a later load succeeds', async () => {
    const clock = stopped();
    const outcomes: (() => Promise<number>)[] = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(1),
    ];
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      const next = outcomes[loads] ?? (() => Promise.reject(new Error('down again')));
      loads += 1;
      return next();
    }, deterministic(clock));

    expect(messageOf(await rejectionOf(cached()))).toBe('down');
    clock.advance(1_000);
    expect(await cached()).toBe(1);

    expect(loads).toBe(2);
    expect(await cached()).toBe(1);
    expect(loads).toBe(2);
  });

  // The jitter is half the window plus up to another half, so a fleet that
  // failed on one provider does not line up on one retry instant.
  it('spreads the cooldown across a window rather than firing on one instant', async () => {
    const clock = stopped();
    let loads = 0;
    const cached = cacheWhileItSucceeds(
      () => {
        loads += 1;
        return Promise.reject(new Error('down'));
      },
      { cooldownMs: 1_000, jitter: () => 0, now: clock.now },
    );

    expect(messageOf(await rejectionOf(cached()))).toBe('down');
    clock.advance(499);
    expect(messageOf(await rejectionOf(cached()))).toBe('down');
    expect(loads).toBe(1);

    // `jitter: () => 0` is the shortest the window can be: half of it.
    clock.advance(1);
    expect(messageOf(await rejectionOf(cached()))).toBe('down');
    expect(loads).toBe(2);
  });
});
