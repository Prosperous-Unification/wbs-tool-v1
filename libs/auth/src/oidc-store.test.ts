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
      verifier: 'verifier-1',
    });
    expect(store.consume('browser-1', 'state-1')).toBeNull();
  });

  it('refuses another browser without consuming the initiating browser transaction', () => {
    const store = new InMemoryOidcTransactionStore({ now: () => 1_000, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    expect(store.consume('browser-2', 'state-1')).toBeNull();
    expect(store.consume('browser-1', 'state-1')).toEqual({
      nonce: 'nonce-1',
      verifier: 'verifier-1',
    });
  });

  it('burns a transaction when the initiating browser returns the wrong state', () => {
    const store = new InMemoryOidcTransactionStore({ now: () => 1_000, ttlMs: 5_000 });
    store.save({
      browserBinding: 'browser-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });

    expect(store.consume('browser-1', 'wrong-state')).toBeNull();
    expect(store.consume('browser-1', 'state-1')).toBeNull();
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
    expect(store.consume('browser-1', 'state-1')).toBeNull();
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
