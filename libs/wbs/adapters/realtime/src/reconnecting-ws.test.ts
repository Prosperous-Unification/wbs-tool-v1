import { describe, expect, it } from 'bun:test';

import { computeBackoff, createReconnectingWs } from './reconnecting-ws';
import { SubscriptionTracker } from './subscription-tracker';

describe('SubscriptionTracker', () => {
  it('records and reads last_seq per subscription', () => {
    const storage = new Map<string, string>();
    const tr = new SubscriptionTracker({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
    });
    tr.update('doc:abc', 5);
    tr.update('doc:abc', 7);
    tr.update('user:xyz', 2);
    expect(tr.snapshot()).toEqual({ 'doc:abc': 7, 'user:xyz': 2 });
  });

  it('persists across instances via storage', () => {
    const storage = new Map<string, string>();
    const s = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    };
    const t1 = new SubscriptionTracker(s);
    t1.update('doc:abc', 42);
    const t2 = new SubscriptionTracker(s);
    expect(t2.snapshot()['doc:abc']).toBe(42);
  });

  it('does not regress on out-of-order updates', () => {
    const storage = new Map<string, string>();
    const tr = new SubscriptionTracker({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
    });
    tr.update('doc:abc', 10);
    tr.update('doc:abc', 3);
    expect(tr.snapshot()['doc:abc']).toBe(10);
  });
});

describe('computeBackoff', () => {
  it('starts at 500ms and doubles up to a 30s cap', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => computeBackoff(n, () => 0.5));
    expect(samples[0]).toBe(500);
    expect(samples[1]).toBe(1000);
    expect(samples[2]).toBe(2000);
    expect(samples[6]).toBe(30_000);
    expect(samples[8]).toBe(30_000);
  });

  it('applies a jitter band around the base delay', () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i++) {
      values.add(computeBackoff(3, Math.random));
    }
    expect(values.size).toBeGreaterThan(10);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(Math.floor(4000 * 0.8));
      expect(v).toBeLessThanOrEqual(Math.ceil(4000 * 1.2));
    }
  });
});

describe('createReconnectingWs', () => {
  it('opens the configured URL without requiring or appending a JWT', async () => {
    const opened: string[] = [];
    const storage = new Map<string, string>();
    const subscriptions = new SubscriptionTracker({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
    });
    const socket = {
      readyState: WebSocket.CONNECTING,
      send: () => undefined,
      close: () => undefined,
    } as unknown as WebSocket;
    const handle = createReconnectingWs({
      url: 'wss://wbs.test/ws',
      onFrame: () => undefined,
      onStateChange: () => undefined,
      subscriptions,
      websocketFactory: (url) => {
        opened.push(url);
        return socket;
      },
    });
    await Promise.resolve();

    expect(opened).toEqual(['wss://wbs.test/ws']);
    handle.close();
  });
});
