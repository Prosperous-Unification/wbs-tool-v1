import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

/** The original shared event-log cases, retaining their stable case IDs. */
export function eventLogRegistrations(open: OpenCase<'eventLog'>): readonly CaseRegistration[] {
  return [
    storeCase('eventLog', 'eventLog.recordEvent', open, async ({ port, seed }) => {
      const subscription = `project:${seed.projectIds[0]}`;
      expect(await port.latestSeq(subscription)).toBe(-1);
      const first = await port.recordEvent(subscription, { type: 'first' }, 1);
      const second = await port.recordEvent(subscription, { type: 'second' }, 2);
      expect([first.seq, second.seq]).toEqual([0, 1]);
      expect(await port.latestSeq(subscription)).toBe(1);
    }),
    storeCase('eventLog', 'eventLog.rangeSince', open, async ({ port, seed }) => {
      const subscription = `project:${seed.projectIds[0]}`;
      await port.recordEvent(subscription, { type: 'first' }, 1);
      await port.recordEvent(subscription, { type: 'second' }, 2);
      const since = await port.rangeSince(subscription, 0);
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:eventLog.rangeSince`; this failed on `Expected: [1] · Received: []`.
      expect(since.map(({ seq }) => seq)).toEqual([1]);
    }),
    storeCase('eventLog', 'eventLog.pruneBeyond', open, async ({ port, seed }) => {
      const subscription = `project:${seed.projectIds[0]}`;
      for (let sequence = 0; sequence < 4; sequence += 1) {
        await port.recordEvent(subscription, { type: `e${String(sequence)}` }, sequence);
      }
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:eventLog.pruneBeyond`; this failed on `Expected: 2 · Received: 0`.
      expect(await port.pruneBeyond(2)).toBe(2);
      expect(await port.latestSeq(subscription)).toBe(3);
      expect((await port.rangeSince(subscription, -1)).map(({ seq }) => seq)).toEqual([2, 3]);
    }),
    storeCase('eventLog', 'eventLog.pruneBeyond:empty-sequence', open, async ({ port, seed }) => {
      const subscription = `project:${seed.projectIds[0]}`;
      const otherSubscription = `project:${seed.projectIds[1]}`;
      const first = await port.recordEvent(subscription, { type: 'empty-first' }, 101);
      const second = await port.recordEvent(subscription, { type: 'empty-second' }, 102);
      const other = await port.recordEvent(otherSubscription, { type: 'scope-sentinel' }, 103);
      expect({ first, second, other }).toEqual({
        first: {
          subscription,
          seq: 0,
          message: { type: 'empty-first' },
          createdAt: 101,
        },
        second: {
          subscription,
          seq: 1,
          message: { type: 'empty-second' },
          createdAt: 102,
        },
        other: {
          subscription: otherSubscription,
          seq: 0,
          message: { type: 'scope-sentinel' },
          createdAt: 103,
        },
      });
      expect(await port.rangeSince(subscription, -1)).toEqual([
        { subscription, seq: 0, message: { type: 'empty-first' }, createdAt: 101 },
        { subscription, seq: 1, message: { type: 'empty-second' }, createdAt: 102 },
      ]);
      expect(await port.rangeSince(otherSubscription, -1)).toEqual([
        {
          subscription: otherSubscription,
          seq: 0,
          message: { type: 'scope-sentinel' },
          createdAt: 103,
        },
      ]);

      expect(await port.pruneBeyond(0)).toBe(3);
      expect(await port.rangeSince(subscription, -1)).toEqual([]);
      expect(await port.oldestSeq(subscription)).toBeNull();
      expect(await port.latestSeq(subscription)).toBe(1);
      expect(await port.rangeSince(otherSubscription, -1)).toEqual([]);
      expect(await port.oldestSeq(otherSubscription)).toBeNull();
      expect(await port.latestSeq(otherSubscription)).toBe(0);

      const next = await port.recordEvent(subscription, { type: 'empty-next' }, 201);
      // Proof: both source proofs derive this return from the empty retained
      // range; the received exact record reports sequence 0 instead of 2.
      expect(next).toEqual({
        subscription,
        seq: 2,
        message: { type: 'empty-next' },
        createdAt: 201,
      });
      expect(await port.rangeSince(subscription, -1)).toEqual([
        { subscription, seq: 2, message: { type: 'empty-next' }, createdAt: 201 },
      ]);
      expect(await port.rangeSince(otherSubscription, -1)).toEqual([]);
      expect(await port.latestSeq(otherSubscription)).toBe(0);
    }),
  ];
}
