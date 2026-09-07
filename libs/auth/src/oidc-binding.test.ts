import { describe, expect, it } from 'bun:test';

import {
  BROWSER_BINDING_COOKIE_PREFIX,
  browserBindingCookieName,
  browserBindingsIn,
  consumeBrowserBinding,
  MAX_BROWSER_BINDINGS,
  selectBrowserBindings,
} from './oidc-binding';
import { InMemoryOidcTransactionStore } from './oidc-store';

/** What a browser would send back for these bindings, one cookie each. */
function jarOf(bindings: readonly string[]): [string, string][] {
  return bindings.map((binding) => [browserBindingCookieName(binding), binding]);
}

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
  /**
   * The name is a function of the binding and of nothing else, which is what
   * lets a login write without reading and a callback clear without a map.
   */
  it('gives every binding its own cookie name and no other binding that name', () => {
    const first = browserBindingCookieName('binding-1');
    const second = browserBindingCookieName('binding-2');

    expect(first).toStartWith(BROWSER_BINDING_COOKIE_PREFIX);
    expect(first).not.toBe(second);
    expect(browserBindingCookieName('binding-1')).toBe(first);
    // Nothing of the binding survives into the name a browser would send back.
    expect(first).not.toContain('binding-1');
    expect(() => browserBindingCookieName('')).toThrow('OIDC browser binding must not be empty');
  });

  it('reads every binding cookie in a request and ignores everything else', () => {
    const held = browserBindingsIn([
      ...jarOf(['binding-1', 'binding-2']),
      ['__Host-wbs_session', 'correlation-1'],
      // The pre-TASK-272 shared name is not this prefix, so a browser mid-login
      // across the deploy offers nothing rather than a value read as a binding.
      ['__Host-wbs_oidc', 'binding-0'],
      [`${BROWSER_BINDING_COOKIE_PREFIX}empty`, ''],
      [`${BROWSER_BINDING_COOKIE_PREFIX}broken`, '%E0%A4%A'],
    ]);

    expect(held.map((entry) => entry.binding)).toEqual(['binding-1', 'binding-2']);
    expect(held[0]?.cookieName).toBe(browserBindingCookieName('binding-1'));
  });

  /**
   * TASK-272's fourth acceptance criterion: the bound on concurrent logins per
   * browser is a number this module publishes and enforces, not the TTL.
   */
  it('offers at most three live logins and hands back the oldest to be cleared', () => {
    let clock = 1_000;
    const store = new InMemoryOidcTransactionStore({ now: () => clock, ttlMs: 5_000 });
    for (const binding of ['binding-1', 'binding-2', 'binding-3', 'binding-4']) {
      store.save({
        browserBinding: binding,
        nonce: `nonce-for-${binding}`,
        state: `state-for-${binding}`,
        verifier: `verifier-for-${binding}`,
      });
      clock += 10;
    }

    const selected = selectBrowserBindings(
      store,
      browserBindingsIn(jarOf(['binding-1', 'binding-2', 'binding-3', 'binding-4'])),
      clock,
    );

    expect(MAX_BROWSER_BINDINGS).toBe(3);
    // Oldest expiry first, so the login that started first is the one dropped —
    // the order comes from the store's `expiresAt`, never from the cookie.
    expect(selected.offered.map((entry) => entry.binding)).toEqual([
      'binding-2',
      'binding-3',
      'binding-4',
    ]);
    expect(selected.surplus.map((entry) => entry.cookieName)).toEqual([
      browserBindingCookieName('binding-1'),
    ]);
  });

  it('treats a dead record, a repeat and a name it did not write as litter', () => {
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

    const selected = selectBrowserBindings(
      store,
      browserBindingsIn([
        // Expired: the store's deadline decides, and this one has passed.
        ...jarOf(['binding-1', 'binding-2']),
        // Never saved, so it addresses nothing and can never address anything.
        ...jarOf(['binding-3']),
        // The same binding under a second name, and a binding under a name this
        // app would never have written for it: both break the one-name-per-login
        // pairing every clear depends on, so neither is offered.
        [`${BROWSER_BINDING_COOKIE_PREFIX}duplicate`, 'binding-2'],
        [`${BROWSER_BINDING_COOKIE_PREFIX}renamed`, 'binding-4'],
      ]),
      clock,
    );

    expect(selected.offered.map((entry) => entry.binding)).toEqual(['binding-2']);
    // Deciding the order reaps what it finds already dead. Before this function
    // existed the callback offered every binding to `consume`, whose expiry arm
    // deleted on sight; reading without deleting would have left `binding-1`'s
    // nonce and verifier resident until an unrelated `save` swept them (peer
    // review, TASK-272 r2, Important). `cleanupExpired` finding nothing to do is
    // the proof that this call already did it.
    expect(store.cleanupExpired()).toBe(0);
    expect(selected.surplus.map((entry) => entry.cookieName)).toEqual([
      browserBindingCookieName('binding-1'),
      browserBindingCookieName('binding-3'),
      `${BROWSER_BINDING_COOKIE_PREFIX}duplicate`,
      `${BROWSER_BINDING_COOKIE_PREFIX}renamed`,
    ]);
    // Reading the order does delete — `binding-1`'s dead record was reaped
    // above, which is what the `cleanupExpired()` assertion above proves.
    // What it must never do is spend a *live* transaction: `binding-2` was
    // ordered, offered, and is still here to be consumed exactly once.
    expect(store.consume('binding-2', 'state-2').outcome).toBe('consumed');
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
      transaction: {
        nonce: 'nonce-for-state-1',
        outcome: 'consumed',
        verifier: 'verifier-for-state-1',
      },
    });
    expect(consumeBrowserBinding(store, ['binding-2'], 'state-2')).toEqual({
      remaining: [],
      transaction: {
        nonce: 'nonce-for-state-2',
        outcome: 'consumed',
        verifier: 'verifier-for-state-2',
      },
    });
  });

  it('consumes at most one record per callback', () => {
    const store = storeWith([
      { binding: 'binding-1', state: 'shared-state' },
      { binding: 'binding-2', state: 'shared-state' },
    ]);

    const first = consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'shared-state');

    expect(first.transaction.outcome).toBe('consumed');
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
      transaction: { outcome: 'state_mismatch' },
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
      transaction: { outcome: 'expired' },
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
      transaction: { outcome: 'state_mismatch' },
    });
  });

  it('reports an expired binding over a missing one, the more specific truth', () => {
    let clock = 1_000;
    const store = storeWith([{ binding: 'binding-1', state: 'state-1' }], () => clock);
    clock = 10_000;

    // `binding-2` was never saved, so it is `missing`; `binding-1` outlived its
    // TTL. Offering both must still report the expiry.
    expect(consumeBrowserBinding(store, ['binding-1', 'binding-2'], 'state-1')).toEqual({
      remaining: [],
      transaction: { outcome: 'expired' },
    });
  });

  it('reports a browser holding nothing consumable as missing', () => {
    const store = storeWith([]);

    expect(consumeBrowserBinding(store, ['binding-1'], 'state-1')).toEqual({
      remaining: [],
      transaction: { outcome: 'missing' },
    });
    expect(consumeBrowserBinding(store, [], 'state-1')).toEqual({
      remaining: [],
      transaction: { outcome: 'missing' },
    });
  });
});
