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
    expect(wiring.read).toBeUndefined();
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
      selectedSchedule: null,
    });
    const wiring = optimizerWiring(read);
    // The same function object, not merely a truthy one — a wiring that
    // reported available while handing `WorkItemService` something else would
    // be the defect wearing a different hat.
    expect(wiring.read).toBe(read);
    expect(wiring.available()).toBe(true);
  });
});
