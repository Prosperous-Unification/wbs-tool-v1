import { describe, expect, it } from 'bun:test';

import type { OptimizedScheduleReader } from './optimized-schedule-reader';
import { optimizerWiring } from './optimizer-wiring';

/**
 * The invariant the settings gate rests on, tested where it lives rather than
 * through the HTTP surface: `available()` is a **reading of** the reader, so no
 * caller can hold one without the other.
 *
 * This is the test that would fail if someone later "simplified"
 * `optimizerWiring` into two independent fields, which is the shape the review
 * rejected.
 */
describe('optimizerWiring', () => {
  it('reports unavailable when there is no reader', () => {
    const wiring = optimizerWiring(undefined);
    expect(wiring.scheduler.supports('optimized')).toBe(false);
    expect(wiring.available()).toBe(false);
  });

  it('reports available exactly when it is holding the reader it hands out', () => {
    // Never called: what is under test is the pairing, not the read. A reader
    // that threw would prove the same thing, and less clearly.
    const read: OptimizedScheduleReader = () => ({
      inputHash: 'hash',
      generation: null,
      contractVersion: '7+test',
      budgetMs: 60_000,
      variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
      schedules: { pri: null, time: null },
    });
    const wiring = optimizerWiring({ readLive: read, readCaptured: read });
    expect(wiring.scheduler.supports('optimized')).toBe(true);
    expect(wiring.available()).toBe(true);
  });
});
