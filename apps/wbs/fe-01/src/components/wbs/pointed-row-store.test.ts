import { describe, expect, it } from 'vitest';

import { createPointedRows, type PointedRows } from './pointed-row-store';

/** A store with the given rows on screen, which is every test's first fact. */
const showing = (...rowIds: string[]): PointedRows => {
  const pointed = createPointedRows();
  pointed.setShownRows(new Set(rowIds));
  return pointed;
};

describe('the pointed-row store', () => {
  it('answers the table pointer while its row is shown', () => {
    const pointed = showing('a', 'b');
    pointed.pointTable('a');
    expect(pointed.pointedAt()).toBe('a');
  });

  it('clears a departure only while its row is still the pointed one', () => {
    const pointed = showing('a', 'b');
    pointed.pointTable('a');
    // The pointer moved straight to the next row: the arrival lands first,
    // then the departure from the row it left. The light must stay on 'b'.
    pointed.pointTable('b');
    pointed.leaveTable('a');
    expect(pointed.pointedAt()).toBe('b');

    pointed.leaveTable('b');
    expect(pointed.pointedAt()).toBeNull();
  });

  it('keeps the chart pointer and a bar’s focus apart, pointer first', () => {
    const pointed = showing('a', 'b');
    pointed.pointChart('a', 'focus');
    expect(pointed.pointedAt()).toBe('a');

    // A pointer elsewhere wins while both are live: it is where the eyes are.
    pointed.pointChart('b', 'pointer');
    expect(pointed.pointedAt()).toBe('b');

    // And losing the pointer falls back to the focus rather than to nothing.
    pointed.pointChart(null, 'pointer');
    expect(pointed.pointedAt()).toBe('a');

    // A blur clears its own reading and nothing else.
    pointed.pointChart(null, 'focus');
    expect(pointed.pointedAt()).toBeNull();
  });

  it('lets the table outrank the chart while both are live', () => {
    const pointed = showing('a', 'b');
    pointed.pointChart('b', 'pointer');
    pointed.pointTable('a');
    expect(pointed.pointedAt()).toBe('a');

    pointed.leaveTable('a');
    expect(pointed.pointedAt()).toBe('b');
  });

  it('falls to the chart when the pointed table row is no longer shown', () => {
    const pointed = showing('a', 'b');
    pointed.pointTable('b');
    // A search narrows 'b' away under the stationary pointer: no departure
    // fires at a node being unmounted, so the reading is still remembered —
    // and must stop outranking the pointer's live answer on the chart.
    //
    // Proof: the shown guard dropped to a bare fallthrough, watched failing on
    // `expected 'b' to be 'a'` — the remembered row outranking the live one.
    // Watched 2026-09-01.
    pointed.setShownRows(new Set(['a']));
    pointed.pointChart('a', 'pointer');
    expect(pointed.pointedAt()).toBe('a');

    // And the remembered reading is only outranked, not forgotten: drawn
    // again with the chart silent, the pointer is still resting on it.
    pointed.pointChart(null, 'pointer');
    pointed.setShownRows(new Set(['a', 'b']));
    expect(pointed.pointedAt()).toBe('b');
  });

  it('tells a subscriber when the answer changes, and lets it leave', () => {
    const pointed = showing('a');
    const told: (string | null)[] = [];
    const leave = pointed.subscribe(() => told.push(pointed.pointedAt()));

    pointed.pointTable('a');
    pointed.leaveTable('a');
    expect(told).toEqual(['a', null]);

    leave();
    pointed.pointTable('a');
    expect(told).toEqual(['a', null]);
  });

  it('says nothing when the shown rows change and the resolution does not', () => {
    const pointed = showing('a', 'b');
    pointed.pointTable('a');
    const told: string[] = [];
    pointed.subscribe(() => told.push('told'));

    // The push WbsTable makes after every commit: same rows, nothing pointed
    // differently. Every row's subscription must sleep through it.
    //
    // Proof: the change guard in `resolve` removed, watched failing on
    // `expected [ 'told' ] to deeply equal []`, 2026-09-01.
    pointed.setShownRows(new Set(['a', 'b', 'c']));
    expect(told).toEqual([]);
  });

  it('says nothing on a repeated arrival at the row already pointed', () => {
    const pointed = showing('a');
    pointed.pointTable('a');
    const told: string[] = [];
    pointed.subscribe(() => told.push('told'));

    pointed.pointTable('a');
    expect(told).toEqual([]);
  });
});
