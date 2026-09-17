import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import { computeBackoff } from './reconnecting-ws';
import { SubscriptionTracker } from './subscription-tracker';

describe('computeBackoff property: value is within ±20% jitter band of base delay', () => {
  it('holds for 100 arbitrary attempt counts and random streams', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.func(fc.double({ min: 0, max: 1, noNaN: true })),
        (attempt, rng) => {
          const base = Math.min(500 * 2 ** attempt, 30_000);
          const value = computeBackoff(attempt, rng);
          expect(value).toBeGreaterThanOrEqual(Math.floor(base * 0.8) - 1);
          expect(value).toBeLessThanOrEqual(Math.ceil(base * 1.2) + 1);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});

describe('SubscriptionTracker property: last_seq is monotonic', () => {
  it('never regresses after any sequence of updates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.constantFrom('doc:a', 'doc:b', 'user:x'), fc.integer({ min: 0, max: 1000 })),
          { minLength: 0, maxLength: 100 },
        ),
        (updates) => {
          const storage = new Map<string, string>();
          const tr = new SubscriptionTracker({
            getItem: (k) => storage.get(k) ?? null,
            setItem: (k, v) => {
              storage.set(k, v);
            },
          });
          const expected: Record<string, number> = {};
          for (const [sub, seq] of updates) {
            tr.update(sub, seq);
            expected[sub] = Math.max(expected[sub] ?? -1, seq);
          }
          expect(tr.snapshot()).toEqual(expected);
        },
      ),
      { numRuns: 50, seed: 7 },
    );
  });
});
