import { describe, expect, it } from 'bun:test';

import { SubscriptionMap } from './subscription-map';

describe('SubscriptionMap', () => {
  it('subscribes/unsubscribes and lists sockets per key', () => {
    const m = new SubscriptionMap<string>();
    m.subscribe('doc:a', 's1');
    m.subscribe('doc:a', 's2');
    m.subscribe('doc:b', 's1');
    expect(m.socketsFor('doc:a')).toEqual(new Set(['s1', 's2']));
    m.unsubscribe('doc:a', 's1');
    expect(m.socketsFor('doc:a')).toEqual(new Set(['s2']));
  });

  it('deletes the subscription when the last socket unsubscribes', () => {
    const m = new SubscriptionMap<string>();
    m.subscribe('doc:a', 's1');
    m.unsubscribe('doc:a', 's1');
    expect(m.socketsFor('doc:a').size).toBe(0);
  });

  it('removeAll deletes the socket from every subscription', () => {
    const m = new SubscriptionMap<string>();
    m.subscribe('a', 's1');
    m.subscribe('b', 's1');
    m.subscribe('b', 's2');
    m.removeAll('s1');
    expect(m.socketsFor('a').size).toBe(0);
    expect(m.socketsFor('b')).toEqual(new Set(['s2']));
  });

  it('activeCount sums sockets across subscriptions', () => {
    const m = new SubscriptionMap<string>();
    m.subscribe('a', 's1');
    m.subscribe('b', 's1');
    m.subscribe('b', 's2');
    expect(m.activeCount()).toBe(3);
  });
});
