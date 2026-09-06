import { describe, expect, it, spyOn } from 'bun:test';

import { ReplayBuffer } from './replay-buffer';

describe('ReplayBuffer', () => {
  it('returns in-order events with seq strictly greater than sinceSeq', () => {
    const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000, now: () => 1_000 });
    for (let i = 0; i < 10; i++) buf.record('doc:a', i, { i });
    const out = buf.since('doc:a', 5);
    expect(out.map((e) => e.seq)).toEqual([6, 7, 8, 9]);
  });

  it('evicts oldest when size cap reached', () => {
    const buf = new ReplayBuffer({ maxPerSubscription: 3, maxAgeMs: 60_000, now: () => 1_000 });
    for (let i = 0; i < 5; i++) buf.record('doc:a', i, {});
    const out = buf.since('doc:a', -1);
    expect(out.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('evicts by age cap on subsequent record calls', () => {
    let t = 0;
    const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 1000, now: () => t });
    buf.record('doc:a', 0, {});
    t = 1500;
    buf.record('doc:a', 1, {});
    expect(buf.since('doc:a', -1).map((e) => e.seq)).toEqual([1]);
  });

  it('oldestSeq returns the first buffered seq or null when empty', () => {
    const buf = new ReplayBuffer({ maxPerSubscription: 10, maxAgeMs: 60_000, now: () => 1 });
    expect(buf.oldestSeq('doc:a')).toBeNull();
    buf.record('doc:a', 3, {});
    buf.record('doc:a', 4, {});
    expect(buf.oldestSeq('doc:a')).toBe(3);
  });

  /**
   * What a closed project leaves behind.
   *
   * Eviction was lazy and only lazy: `record`, `since` and `covers` each evict
   * the subscription they are **about**, so a project edited a thousand times
   * and then closed kept a thousand `tree_replaced` entries — whole plans,
   * hundreds of rows each — every one long past `maxAgeMs`, with nothing left
   * that would ever ask about them again.
   */
  describe('a subscription nobody touches again', () => {
    it('is swept by the traffic on the others, not held forever', () => {
      // Proof: `this.sweepOneOther(subscription)` removed from `record`, this
      // failed on `expected 0 to be null` — the abandoned project's first
      // entry still held, two thousand seconds after it expired. Watched
      // 2026-09-02.
      let t = 0;
      const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 1000, now: () => t });
      for (let seq = 0; seq < 5; seq += 1) buf.record('project:closed', seq, {});
      // Long past the age cap, and nothing will ask about that project again.
      t = 2000;

      // One write to a live project is one lap of the sweep: there is only one
      // other key.
      buf.record('project:live', 0, {});

      expect(buf.oldestSeq('project:closed')).toBeNull();
    });

    it('leaves the project being written to alone', () => {
      // The sweep must not be the thing that evicts what the caller is about
      // to read: a write and the `since` after it are one exchange.
      let t = 0;
      const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 1000, now: () => t });
      buf.record('project:a', 0, {});
      buf.record('project:b', 0, {});
      t = 500;

      buf.record('project:a', 1, {});

      expect(buf.since('project:a', -1).map((entry) => entry.seq)).toEqual([0, 1]);
    });

    it('keeps sweeping when the key it swept last has gone', () => {
      // A swept-empty key is deleted. The retained iterator must still reach
      // the following subscriptions, rather than stopping at the deleted key.
      let t = 0;
      const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 1000, now: () => t });
      buf.record('project:one', 0, {});
      buf.record('project:two', 0, {});
      t = 2000;

      // Three writes: enough laps to reach both of the other two whatever
      // order the map holds them in.
      for (let seq = 1; seq <= 3; seq += 1) buf.record('project:live', seq, {});

      expect(buf.oldestSeq('project:one')).toBeNull();
      expect(buf.oldestSeq('project:two')).toBeNull();
    });
  });
});

describe('bounded subscription selection', () => {
  for (const subscriptions of [100, 1_000, 10_000]) {
    it(`bounds record iterator work with ${String(subscriptions)} subscriptions`, () => {
      const buffer = new ReplayBuffer({ maxPerSubscription: 10, maxAgeMs: 1_000, now: () => 0 });
      for (let index = 0; index < subscriptions; index += 1) {
        buffer.record(`project:${String(index)}`, 0, {});
      }
      // Native Map keys and entries share this iterator prototype. Counting its
      // next method observes retained cursors as well as newly created ones.
      const prototype = Object.getPrototypeOf(new Map().keys()) as {
        next(this: object): IteratorResult<unknown>;
      };
      // Retain the native function; the wrapper explicitly supplies its cursor
      // receiver through call(), rather than binding it to the prototype.
      const advance = Reflect.get(prototype, 'next') as (this: object) => IteratorResult<unknown>;
      let visits = 0;
      const counter = spyOn(prototype, 'next').mockImplementation(function (this: object) {
        visits += 1;
        return advance.call(this);
      });
      const measured: number[] = [];
      try {
        for (let seq = 1; seq <= 4; seq += 1) {
          visits = 0;
          buffer.record('project:0', seq, {});
          measured.push(visits);
        }
      } finally {
        counter.mockRestore();
      }
      expect(measured.some((count) => count > 0)).toBe(true);
      for (const count of measured) expect(count).toBeLessThanOrEqual(3);
    });
  }
});

it('reaches subscriptions added after a completed sweep lap', () => {
  let now = 0;
  const buffer = new ReplayBuffer({ maxPerSubscription: 10, maxAgeMs: 1_000, now: () => now });
  buffer.record('live', 0, {});
  buffer.record('first', 0, {});
  for (let seq = 1; seq <= 4; seq += 1) buffer.record('live', seq, {});
  buffer.record('later', 0, {});
  now = 2_000;
  for (let seq = 5; seq <= 8; seq += 1) buffer.record('live', seq, {});
  expect(buffer.oldestSeq('first')).toBeNull();
  expect(buffer.oldestSeq('later')).toBeNull();
  expect(buffer.since('live', -1).map((entry) => entry.seq)).toEqual([5, 6, 7, 8]);
});

it('advances past an earlier subscription that remains unexpired', () => {
  let now = 0;
  const buffer = new ReplayBuffer({ maxPerSubscription: 10, maxAgeMs: 1_000, now: () => now });
  buffer.record('earlier', 0, {});
  buffer.record('abandoned', 0, {});
  now = 500;
  buffer.record('earlier', 1, {});
  now = 1_200;
  for (let seq = 0; seq < 4; seq += 1) buffer.record('writer', seq, {});
  expect(buffer.oldestSeq('abandoned')).toBeNull();
  expect(buffer.since('earlier', -1).map((entry) => entry.seq)).toEqual([1]);
});

it('reports expired coverage as absent before reading replay events', () => {
  let now = 0;
  const buffer = new ReplayBuffer({ maxPerSubscription: 10, maxAgeMs: 1_000, now: () => now });
  buffer.record('project', 3, {});
  expect(buffer.covers('project', 3)).toBe(true);
  now = 1_001;
  expect(buffer.covers('project', 3)).toBe(false);
});
