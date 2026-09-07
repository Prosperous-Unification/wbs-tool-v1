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
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('getaddrinfo ENOTFOUND idp.example.test'))
        : Promise.resolve('discovered');
    });

    expect(messageOf(await rejectionOf(cached()))).toContain('ENOTFOUND');
    expect(await cached()).toBe('discovered');
    expect(loads).toBe(2);
  });

  it('retries once per caller while the provider is still down', async () => {
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return Promise.reject(new Error('provider still down'));
    });

    expect(messageOf(await rejectionOf(cached()))).toBe('provider still down');
    expect(messageOf(await rejectionOf(cached()))).toBe('provider still down');

    expect(loads).toBe(2);
  });

  // The classifier upstream reads the thrown value's own shape. A cache that
  // wrapped, replaced or swallowed the cause would silently break it.
  it('rethrows the original failure untouched, so it can still be classified', async () => {
    const cause = Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    const cached = cacheWhileItSucceeds(() => Promise.reject(cause));

    expect(await rejectionOf(cached())).toBe(cause);
  });

  it('caches the success that follows a failure, rather than reloading forever', async () => {
    let loads = 0;
    const cached = cacheWhileItSucceeds(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('first attempt fails'))
        : Promise.resolve(loads);
    });

    expect(messageOf(await rejectionOf(cached()))).toBe('first attempt fails');

    expect(await cached()).toBe(2);
    expect(await cached()).toBe(2);
    expect(loads).toBe(2);
  });
});
