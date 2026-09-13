import { describe, expect, it } from 'bun:test';

import { clockOf } from './clock';

/**
 * The clock's own behaviour, beside the clock.
 *
 * `apps/be-01/src/service/clock.test.ts` is the other half and stays where the
 * services are: it refuses a **service** growing a clock back, by reading that
 * folder. This half is about what the object does, which is the half that came
 * with it into `@wbs/core`.
 */
describe('a clock', () => {
  it('reads its own clock for each stamp, rather than one it took at birth', () => {
    // ADR 0012 says an **act** reads the clock once, and this is the half of
    // that a caller can check: the stamp comes from the clock as it is now, so
    // a service holding one clock for the process's life still dates each act
    // from when that act happened.
    //
    // Proof: `stampFor` given the instant of construction —
    // `((frozen) => (actorId) => ({ at: frozen, … }))(now())` — failed here on
    // `Expected: > 2 · Received: 1`, every act in the process dated from boot.
    // Watched 2026-09-08.
    let ticks = 0;
    const clock = clockOf({
      newId: () => crypto.randomUUID(),
      now: () => {
        ticks += 1;
        return ticks;
      },
    });
    const at = clock.now();
    const stamp = clock.stampFor('ada');
    expect(stamp.by).toBe('ada');
    expect(stamp.at).toBeGreaterThan(at);
    // The same act asked twice is the same act: nothing here caches, so two
    // stamps are two acts and their instants differ.
    expect(clock.stampFor('ada').at).toBeGreaterThan(stamp.at);
  });

  it('mints an id nobody has to supply', () => {
    const clock = clockOf({ now: () => Date.now(), newId: () => crypto.randomUUID() });
    const first = clock.newId();
    expect(first).not.toBe(clock.newId());
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
