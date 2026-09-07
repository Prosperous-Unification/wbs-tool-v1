import { describe, expect, it } from 'bun:test';
import type { Configuration } from 'openid-client';

import {
  browserOidcClientFromEnv,
  cacheWhileItSucceeds,
  isOidcCallbackRefused,
  refuseCallbackFromAnotherIssuer,
} from './oidc-client';

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

/**
 * The fifth callback this app cannot have started, and the one the route cannot
 * decide on its own: a callback whose `iss` is not the issuer identifier
 * discovery resolved to, or one carrying no `iss` where the server said it
 * always sends one.
 *
 * These cases assert the decision and nothing else: they call the function with
 * a metadata literal, so they say what a mismatched or missing `iss` means and
 * say nothing about where `exchange` gets that metadata. That gap was measured
 * rather than assumed — a control swapping the resolved Issuer Identifier for
 * `AUTH_ISSUER_DISCOVERY_URL` left all of them green — and it is covered by
 * `browserOidcClientFromEnv issuer wiring` below. The answer the route gives the
 * rejection is asserted in `oidc.integration.test.ts`, against a fake
 * `exchange`, so that file proves the handling and not the decision.
 */
describe('refuseCallbackFromAnotherIssuer', () => {
  // Okta's shape, and the trap this whole check is built around: the discovery
  // URL and the issuer identifier are different strings.
  const ISSUER = 'https://puni.okta.com/oauth2/default';
  const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

  const callback = (query: string): URL =>
    new URL(`https://dev.wbs.test/api/auth/okta/callback${query}`);

  /**
   * The reason slug this call refused with, or `undefined` if it accepted.
   *
   * It narrows through `isOidcCallbackRefused` and rethrows anything else, so a
   * case can never pass by catching a `TypeError` from a rewritten check and
   * reading a `reason` off it.
   */
  const reasonOf = (
    query: string,
    metadata: { authorization_response_iss_parameter_supported?: boolean; issuer: string },
  ): string | undefined => {
    try {
      refuseCallbackFromAnotherIssuer(callback(query), metadata);
    } catch (thrown) {
      if (isOidcCallbackRefused(thrown)) return thrown.reason;
      throw thrown;
    }
    return undefined;
  };

  it('accepts a callback carrying the issuer identifier discovery resolved to', () => {
    expect(
      reasonOf(`?code=c&state=s&iss=${encodeURIComponent(ISSUER)}`, { issuer: ISSUER }),
    ).toBeUndefined();
  });

  it('accepts a callback with no iss when the server does not advertise one', () => {
    expect(reasonOf('?code=c&state=s', { issuer: ISSUER })).toBeUndefined();
  });

  it('refuses a callback from another issuer', () => {
    expect(reasonOf('?code=c&state=s&iss=https%3A%2F%2Fevil.test', { issuer: ISSUER })).toBe(
      'issuer_mismatch',
    );
  });

  it('refuses a callback with no iss when the server advertises that it sends one', () => {
    expect(
      reasonOf('?code=c&state=s', {
        authorization_response_iss_parameter_supported: true,
        issuer: ISSUER,
      }),
    ).toBe('issuer_missing');
  });

  /**
   * `?iss=` is absent, not a mismatch — the reading `oauth4webapi` itself takes
   * (`getURLSearchParameter` returns the empty string and every check there is
   * truthiness). Without this the boundary would answer `issuer_mismatch` for
   * `?iss=` and `issuer_missing` for a callback with no `iss` at all, splitting
   * one fact across two slugs in the log.
   */
  it('reads an empty iss as absent rather than as a different issuer', () => {
    expect(reasonOf('?code=c&state=s&iss=', { issuer: ISSUER })).toBeUndefined();

    expect(
      reasonOf('?code=c&state=s&iss=', {
        authorization_response_iss_parameter_supported: true,
        issuer: ISSUER,
      }),
    ).toBe('issuer_missing');
  });

  /**
   * The mistake this check would have made if it had compared against
   * `AUTH_ISSUER_DISCOVERY_URL`, which is the configured value nearest to hand.
   * A provider sending its own identifier would have been refused — every real
   * login — and a callback echoing the discovery URL would have been accepted.
   * Both halves are asserted, because either one alone would pass under the
   * wrong comparison.
   */
  it('compares the issuer identifier, not the discovery document URL', () => {
    expect(
      reasonOf(`?code=c&state=s&iss=${encodeURIComponent(ISSUER)}`, { issuer: ISSUER }),
    ).toBeUndefined();

    expect(
      reasonOf(`?code=c&state=s&iss=${encodeURIComponent(DISCOVERY_URL)}`, { issuer: ISSUER }),
    ).toBe('issuer_mismatch');
  });

  /**
   * The narrowing the route depends on, proven from the other side: an ordinary
   * failure out of `exchange` must not take the 400 exit reserved for a
   * callback this app could not have started.
   */
  it('does not claim an ordinary exchange failure as a callback refusal', () => {
    expect(isOidcCallbackRefused(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isOidcCallbackRefused({ reason: 'issuer_mismatch' })).toBe(false);
    expect(isOidcCallbackRefused(undefined)).toBe(false);
  });
});

/**
 * The wiring, which the cases above deliberately do not cover and a negative
 * control caught: replacing `resolved.serverMetadata()` with the configured
 * discovery URL left every one of them green, because they call the check
 * directly and never ask `exchange` which metadata it hands over.
 *
 * These two cases ask exactly that, and they are written as a pair on purpose —
 * each alone passes under the wrong source, since the two strings differ only in
 * which callbacks they accept.
 *
 * `discover` is injected rather than reaching a provider, and the resolved value
 * is a stand-in carrying nothing but `serverMetadata()`. That is all the refusal
 * needs: it is decided before `authorizationCodeGrant` is called. A callback
 * that is *not* refused therefore fails further in, on the stand-in — which is
 * the assertion, and why these read "not a callback refusal" rather than
 * "succeeds".
 */
describe('browserOidcClientFromEnv issuer wiring', () => {
  const DISCOVERY_URL = 'https://puni.okta.com/oauth2/default/.well-known/openid-configuration';
  const ISSUER = 'https://puni.okta.com/oauth2/default';
  const ENV = {
    AUTH_CLIENT_ID: 'client-1',
    AUTH_CLIENT_SECRET: 'secret-1',
    AUTH_ISSUER_DISCOVERY_URL: DISCOVERY_URL,
  };

  const exchangeWithIss = async (iss: string): Promise<unknown> => {
    const client = browserOidcClientFromEnv(ENV, {
      discover: () =>
        Promise.resolve({ serverMetadata: () => ({ issuer: ISSUER }) } as unknown as Configuration),
    });
    return rejectionOf(
      client.exchange(
        new Request(
          `https://dev.wbs.test/api/auth/okta/callback?code=c&state=s&iss=${encodeURIComponent(iss)}`,
        ),
        { nonce: 'nonce-1', state: 's', verifier: 'verifier-1' },
      ),
    );
  };

  it('refuses a callback carrying the discovery URL as its iss', async () => {
    expect(isOidcCallbackRefused(await exchangeWithIss(DISCOVERY_URL))).toBe(true);
  });

  it('does not refuse a callback carrying the resolved Issuer Identifier', async () => {
    expect(isOidcCallbackRefused(await exchangeWithIss(ISSUER))).toBe(false);
  });

  /**
   * And the reason `config()` is awaited before anything is compared: discovery
   * failing is an outage, and it must still reach the classifier as the original
   * rejection rather than as a callback refusal.
   */
  it('lets a discovery failure through untouched instead of refusing the callback', async () => {
    const down = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo EAI_AGAIN puni.okta.com'), { code: 'EAI_AGAIN' }),
    });
    const client = browserOidcClientFromEnv(ENV, { discover: () => Promise.reject(down) });

    const thrown = await rejectionOf(
      client.exchange(
        new Request(
          'https://dev.wbs.test/api/auth/okta/callback?code=c&state=s&iss=https%3A%2F%2Fevil.test',
        ),
        { nonce: 'nonce-1', state: 's', verifier: 'verifier-1' },
      ),
    );

    expect(thrown).toBe(down);
    expect(isOidcCallbackRefused(thrown)).toBe(false);
  });
});
