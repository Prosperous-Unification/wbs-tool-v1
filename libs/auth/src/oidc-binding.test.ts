import { describe, expect, it } from 'bun:test';

import {
  consumeBrowserBinding,
  MAX_BROWSER_BINDINGS,
  parseBrowserBindings,
  serializeBrowserBindings,
  withBrowserBinding,
} from './oidc-binding';
import { InMemoryOidcTransactionStore } from './oidc-store';

function storeWith(
  transactions: { binding: string; state: string }[],
  now = () => 1_000,
): InMemoryOidcTransactionStore {
  const store = new InMemoryOidcTransactionStore({ now, ttlMs: 5_000 });
  for (const { binding, state } of transactions) {
    store.save({
      browserBinding: binding,
      nonce: `nonce-for-${state}`,
      state,
      verifier: `verifier-for-${state}`,
    });
  }
  return store;
}

describe('browser binding cookie', () => {
  it('reads the bindings a browser is holding, newest last', () => {
    expect(parseBrowserBindings('binding-1.binding-2')).toEqual(['binding-1', 'binding-2']);
    expect(parseBrowserBindings(null)).toEqual([]);
    expect(parseBrowserBindings('')).toEqual([]);
  });

  it('holds at most three logins per browser and drops the oldest', () => {
    let bindings: string[] = [];
    for (const binding of ['binding-1', 'binding-2', 'binding-3', 'binding-4']) {
      bindings = withBrowserBinding(bindings, binding);
    }

    expect(MAX_BROWSER_BINDINGS).toBe(3);
    expect(bindings).toEqual(['binding-2', 'binding-3', 'binding-4']);
    expect(serializeBrowserBindings(bindings)).toBe('binding-2.binding-3.binding-4');
    // The bound is enforced on the way in as well, so a cookie that somehow
    // carried more cannot make one callback ask the store for more.
    expect(parseBrowserBindings('b1.b2.b3.b4.b5')).toEqual(['b3', 'b4', 'b5']);
  });

  it('refuses a binding that would read back as two', () => {
    expect(() => withBrowserBinding([], 'first.second')).toThrow(
      'OIDC browser binding must not be empty or contain a separator',
    );
    expect(() => withBrowserBinding([], '')).toThrow();
  });

  /**
   * TASK-272's first acceptance criterion at the store seam: the callback that
   * arrives late still finds its own record among the bindings its browser
   * kept, and the login started second is not the one that has to win.
   */
  it('consumes the binding the arriving state proves and keeps the other', () => {
    const store = storeWith([
      { binding: 'binding-1', state: 'state-1' },
      { binding: 'binding-2', state: 'state-2' },
    ]);

    expect(consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'state-1')).toEqual({
      remaining: ['binding-2'],
      result: { nonce: 'nonce-for-state-1', outcome: 'consumed', verifier: 'verifier-for-state-1' },
    });
    expect(consumeBrowserBinding(store, ['binding-2'], 'state-2')).toEqual({
      remaining: [],
      result: { nonce: 'nonce-for-state-2', outcome: 'consumed', verifier: 'verifier-for-state-2' },
    });
  });

  it('consumes at most one record per callback', () => {
    const store = storeWith([
      { binding: 'binding-1', state: 'shared-state' },
      { binding: 'binding-2', state: 'shared-state' },
    ]);

    const first = consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'shared-state');

    expect(first.result.outcome).toBe('consumed');
    expect(first.remaining).toEqual(['binding-2']);
    // Proof that the second record was never read on that call: it is still
    // consumable, which it would not be had the loop kept going.
    expect(store.consume('binding-2', 'shared-state').outcome).toBe('consumed');
  });

  /**
   * TASK-272's third acceptance criterion. A callback whose state matches no
   * binding recovers no verifier and destroys nothing — the property TASK-276
   * bought for one binding, now for every binding the browser holds.
   */
  it('recovers nothing and keeps every record when the state matches none', () => {
    const store = storeWith([
      { binding: 'binding-1', state: 'state-1' },
      { binding: 'binding-2', state: 'state-2' },
    ]);

    expect(consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'guessed')).toEqual({
      remaining: ['binding-1', 'binding-2'],
      result: { outcome: 'state_mismatch' },
    });
    expect(store.consume('binding-1', 'state-1').outcome).toBe('consumed');
    expect(store.consume('binding-2', 'state-2').outcome).toBe('consumed');
  });

  it('drops an expired binding, reports the expiry, and leaves the deletion to the store', () => {
    let clock = 1_000;
    const store = storeWith([{ binding: 'binding-1', state: 'state-1' }], () => clock);
    clock = 10_000;

    expect(consumeBrowserBinding(store, ['binding-1'], 'state-1')).toEqual({
      remaining: [],
      result: { outcome: 'expired' },
    });
    expect(store.consume('binding-1', 'state-1')).toEqual({ outcome: 'missing' });
  });

  it('reports a mismatch over an expiry, because a live record outranks a dead one', () => {
    let clock = 1_000;
    const store = new InMemoryOidcTransactionStore({ now: () => clock, ttlMs: 5_000 });
    store.save({
      browserBinding: 'binding-1',
      nonce: 'nonce-1',
      state: 'state-1',
      verifier: 'verifier-1',
    });
    clock = 4_000;
    store.save({
      browserBinding: 'binding-2',
      nonce: 'nonce-2',
      state: 'state-2',
      verifier: 'verifier-2',
    });
    clock = 7_000;

    expect(consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'unrelated')).toEqual({
      remaining: ['binding-2'],
      result: { outcome: 'state_mismatch' },
    });
  });

  it('reports a browser holding nothing consumable as missing', () => {
    const store = storeWith([]);

    expect(consumeBrowserBinding(store, ['binding-1'], 'state-1')).toEqual({
      remaining: [],
      result: { outcome: 'missing' },
    });
    expect(consumeBrowserBinding(store, [], 'state-1')).toEqual({
      remaining: [],
      result: { outcome: 'missing' },
    });
  });
});
