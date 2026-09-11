import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import { ReplayBuffer } from './replay-buffer';

describe('Layer-A invariants (ReplayBuffer)', () => {
  it('invariant: no replay below ack — since(lastAck) yields only seq > lastAck', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 50 }),
        fc.integer({ min: -1, max: 100 }),
        (seqs, lastAck) => {
          const buf = new ReplayBuffer({
            maxPerSubscription: 1000,
            maxAgeMs: 600_000,
            now: () => 1,
          });
          for (const s of seqs) buf.record('doc:a', s, {});
          const replayed = buf.since('doc:a', lastAck);
          for (const e of replayed) expect(e.seq).toBeGreaterThan(lastAck);
        },
      ),
      { numRuns: 100, seed: 1234 },
    );
  });

  it('invariant: buffer bound — |buffer| never exceeds maxPerSubscription cap', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1000), { minLength: 0, maxLength: 500 }), (seqs) => {
        const cap = 50;
        const buf = new ReplayBuffer({
          maxPerSubscription: cap,
          maxAgeMs: Number.MAX_SAFE_INTEGER,
          now: () => 1,
        });
        for (const s of seqs) buf.record('doc:a', s, {});
        expect(buf.since('doc:a', -1).length).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 100, seed: 1234 },
    );
  });

  it('invariant: session isolation — two subscriptions never cross-deliver', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom('doc:a', 'doc:b'), fc.nat(100))), (ops) => {
        const buf = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000, now: () => 1 });
        for (const [sub, s] of ops) buf.record(sub, s, { sub });
        const aMsgs = buf.since('doc:a', -1);
        expect(aMsgs.every((e) => (e.message as { sub: string }).sub === 'doc:a')).toBe(true);
      }),
      { numRuns: 50, seed: 42 },
    );
  });
});
