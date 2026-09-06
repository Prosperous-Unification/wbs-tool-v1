import { describe, expect, it } from 'bun:test';

import { InMemoryOidcTransactionStore, InMemoryTokenStore } from './oidc-store';

describe('InMemoryOidcTransactionStore', () => {
  it('consumes a browser-bound transaction exactly once', () => {
    const store = new InMemoryOidcTransactionStore({ now: () => 1_000, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    expect(store.consume('browser-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      outcome: 'consumed',
      verifier: 'verifier-1',
    });
    expect(store.consume('browser-1', 'state-1')).toEqual({ outcome: 'missing' });
  });

  it('refuses another browser without consuming the initiating browser transaction', () => {
    const store = new InMemoryOidcTransactionStore({ now: () => 1_000, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    expect(store.consume('browser-2', 'state-1')).toEqual({ outcome: 'missing' });
    expect(store.consume('browser-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      outcome: 'consumed',
      verifier: 'verifier-1',
    });
  });

  /**
   * TASK-276, and it **inverts an assertion this file made on purpose.** The
   * case it replaces was `burns a transaction when the initiating browser
   * returns the wrong state`, which consumed with `'wrong-state'` and then
   * asserted the *correct* state was also gone. That was TASK-269's recorded
   * decision, and the argument for it is quoted and answered on `consume`: the
   * retry oracle it avoided needs 256 bits, and the burn it created needs one
   * navigation carrying the `SameSite=Lax` binding cookie.
   *
   * The three arrivals here are the whole contract in order — the forged
   * callback finds the door shut, the honest one still finishes the login it
   * started, and single-use survives the move from the arrival to the match.
   */
  it('keeps the initiating browser transaction when a forged callback returns the wrong state', () => {
    const store = new InMemoryOidcTransactionStore({ now: () => 1_000, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    expect(store.consume('browser-1', 'wrong-state')).toEqual({ outcome: 'state_mismatch' });
    expect(store.consume('browser-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      outcome: 'consumed',
      verifier: 'verifier-1',
    });
    expect(store.consume('browser-1', 'state-1')).toEqual({ outcome: 'missing' });
  });

  it('refuses and removes an expired transaction', () => {
    let now = 1_000;
    const store = new InMemoryOidcTransactionStore({ now: () => now, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    now = 6_000;
    expect(store.consume('browser-1', 'state-1')).toEqual({ outcome: 'expired' });
    expect(store.cleanupExpired()).toBe(0);
  });

  /**
   * The ordering the preserved mismatch arm depends on. Expiry is dead for
   * everyone and keeps deleting on sight; if the comparison ran first, an
   * expired record answering a wrong state would be preserved by the very arm
   * that exists to protect a live login.
   *
   * **The claim is about this call, not about the record's fate.** An earlier
   * version of this comment said nothing would ever remove such a record except
   * a later `save` on the same binding; that is wrong, because `save` runs the
   * whole-map `cleanupExpired` and the public `cleanupExpired` removes every
   * expired entry regardless of binding. What the ordering actually decides is
   * whether a callback that reaches a dead record leaves it behind, which is
   * why the second assertion is `cleanupExpired()` finding nothing left to do.
   */
  it('reports an expired transaction as expired even when the state also mismatches', () => {
    let now = 1_000;
    const store = new InMemoryOidcTransactionStore({ now: () => now, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    now = 6_000;
    expect(store.consume('browser-1', 'wrong-state')).toEqual({ outcome: 'expired' });
    expect(store.cleanupExpired()).toBe(0);
  });
});

describe('InMemoryTokenStore', () => {
  it('keeps a refresh token behind the session correlation', () => {
    const store = new InMemoryTokenStore({ now: () => 1_000 });
    store.save({
      expiresAt: 6_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });

    expect(store.read('session-1')).toEqual({ expiresAt: 6_000, refreshToken: 'refresh-1' });
    expect(store.read('another-session')).toBeNull();
  });

  it('rotates a refresh token atomically', () => {
    const store = new InMemoryTokenStore({ now: () => 1_000 });
    store.save({
      expiresAt: 6_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });

    expect(
      store.rotate({
        expiresAt: 7_000,
        previousRefreshToken: 'refresh-1',
        refreshToken: 'refresh-2',
        sessionCorrelation: 'session-1',
      }),
    ).toBe('rotated');
    expect(store.read('session-1')).toEqual({ expiresAt: 7_000, refreshToken: 'refresh-2' });
  });

  it('detects replay of a rotated token and ends the session', () => {
    const store = new InMemoryTokenStore({ now: () => 1_000 });
    store.save({
      expiresAt: 6_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });
    store.rotate({
      expiresAt: 7_000,
      previousRefreshToken: 'refresh-1',
      refreshToken: 'refresh-2',
      sessionCorrelation: 'session-1',
    });

    expect(
      store.rotate({
        expiresAt: 8_000,
        previousRefreshToken: 'refresh-1',
        refreshToken: 'refresh-3',
        sessionCorrelation: 'session-1',
      }),
    ).toBe('replay');
    expect(store.read('session-1')).toBeNull();
  });

  it('refuses an unknown previous token without ending the session', () => {
    const store = new InMemoryTokenStore({ now: () => 1_000 });
    store.save({
      expiresAt: 6_000,
      refreshToken: 'refresh-1',
      sessionCorrelation: 'session-1',
    });

    expect(
      store.rotate({
        expiresAt: 7_000,
        previousRefreshToken: 'unknown',
        refreshToken: 'refresh-2',
        sessionCorrelation: 'session-1',
      }),
    ).toBe('invalid');
    expect(store.read('session-1')?.refreshToken).toBe('refresh-1');
  });

  it('removes expired and logged-out sessions', () => {
    let now = 1_000;
    const store = new InMemoryTokenStore({ now: () => now });
    store.save({ expiresAt: 6_000, refreshToken: 'refresh-1', sessionCorrelation: 'expired' });
    store.save({ expiresAt: 7_000, refreshToken: 'refresh-2', sessionCorrelation: 'logout' });

    expect(store.delete('logout')).toBe(true);
    expect(store.read('logout')).toBeNull();
    now = 6_000;
    expect(store.cleanupExpired()).toBe(1);
    expect(store.read('expired')).toBeNull();
  });
});
