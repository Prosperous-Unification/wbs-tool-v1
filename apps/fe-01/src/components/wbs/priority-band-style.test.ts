import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { describe, expect, it } from 'vitest';

import type { PriorityBandView } from '@/lib/wbs-api';

import { priorityBandStyleOf } from './priority-band-style';

const RECUT: readonly PriorityBandView[] = [
  { startsAt: 1, label: 'Blocker', defaultValue: 5 },
  { startsAt: 16, label: 'Urgent', defaultValue: 20 },
  { startsAt: 31, label: 'Normal', defaultValue: 40 },
  { startsAt: 71, label: 'Someday', defaultValue: 75 },
  { startsAt: 200, label: 'Never', defaultValue: 900 },
];

/**
 * The one place a priority becomes a colour and a sentence.
 *
 * Dany's ask was _"ui must display differently for different priorities"_, and
 * this file is what stops that being four rules in four renderers. The table's
 * cell, the chart's cap, the cards' chip and the export's column all resolve
 * here; the tests that they *call* it live beside each of them.
 */
describe('how a priority is drawn', () => {
  it('says nothing at all about a work item nobody has prioritised', () => {
    // Every caller renders this as no mark rather than as a grey chip reading
    // `—`. A priority is a scale, and a column of furniture down a plan nobody
    // has prioritised says less than a blank does — the bargain the Prio cell,
    // the bar's hover card and the export column each made before this change.
    expect(priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, null)).toBeNull();
  });

  it('gives each of the five rungs its own colour', () => {
    const inks = DEFAULT_PRIORITY_BANDS.map(
      (band) => priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, band.defaultValue)?.ink,
    );
    // Five, and five *different* ones — a ramp that repeated a colour would make
    // two rungs indistinguishable on every face at once.
    expect(new Set(inks).size).toBe(5);
    expect(inks.every((ink) => typeof ink === 'string' && ink !== '')).toBe(true);
  });

  it('keys the colour on the rung and never on the name', () => {
    // A project may rename `Critical` to `Blocker`, and a colour that followed
    // the word would follow it out of the ladder. Both ladders' most important
    // rung is the same ink; the labels are not.
    const critical = priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, 10);
    const blocker = priorityBandStyleOf(RECUT, 5);

    expect(blocker?.ink).toBe(critical?.ink ?? '');
    expect([critical?.label, blocker?.label]).toEqual(['Critical', 'Blocker']);
    expect([critical?.rank, blocker?.rank]).toEqual([0, 0]);
  });

  it('reads the plan’s own ladder, so one number is two names on two plans', () => {
    expect(priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, 20)?.label).toBe('Critical');
    expect(priorityBandStyleOf(RECUT, 20)?.label).toBe('Urgent');
    // And the colours differ with the rungs, which is the whole of "displays
    // differently".
    expect(priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, 20)?.ink).not.toBe(
      priorityBandStyleOf(RECUT, 20)?.ink,
    );
  });

  it('says the band and the number in one sentence, for a title and an aria-label', () => {
    // The chart's hover surface and its `aria-label` are built from `words`, and
    // the number is in it because a bar saying only `Critical` loses the figure
    // the table and the export both show.
    expect(priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, 2)?.words).toBe('Critical — priority 2');
    expect(priorityBandStyleOf(RECUT, 2)?.words).toBe('Blocker — priority 2');
  });

  it('says nothing for a ladder that has not arrived yet', () => {
    // The state between mount and the first tree read. A face that threw here
    // would be a chart that cannot draw until a second payload lands.
    expect(priorityBandStyleOf([], 10)).toBeNull();
  });
});
