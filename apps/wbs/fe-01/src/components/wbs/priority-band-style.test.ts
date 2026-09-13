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

/**
 * `oklch(L C H)` and `oklch(L C H / a%)` read back into its three numbers.
 *
 * Written here rather than imported: the assertions below are about a **margin**
 * between two chromas, and a margin cannot be asserted against a string. jsdom
 * parses no colours, so the table's own literals are the only thing to measure.
 *
 * Throws on anything it cannot read, because a colour this cannot parse is a
 * colour the test would otherwise silently score as `NaN` — and `NaN >= 0.05` is
 * false while `NaN < 0.03` is false too, so an unparsed ink would fail one
 * assertion for the wrong reason and pass another. The regex is the whole gate:
 * three groups matched or nothing, so there is no half-read colour past it.
 */
function oklchOf(colour: string): { lightness: number; chroma: number; hue: number } {
  const read = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/[^)]*)?\)$/.exec(colour);
  if (read === null) throw new Error(`not an oklch colour: ${colour}`);
  const [, lightness, chroma, hue] = read;
  return { lightness: Number(lightness), chroma: Number(chroma), hue: Number(hue) };
}

/** The ink of a rung of the default ladder, by rank. */
function inkAt(rank: number): string {
  const band = DEFAULT_PRIORITY_BANDS.at(rank);
  if (band === undefined) throw new Error(`the default ladder has no rank ${String(rank)}`);
  const style = priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, band.defaultValue);
  if (style === null) throw new Error(`rank ${String(rank)} resolved to no style`);
  expect(style.rank).toBe(rank);
  return style.ink;
}

/**
 * The smallest chroma gap that still reads as two steps of one hue.
 *
 * Stated rather than inferred from the table, which is the whole point: a margin
 * read off the very values under test is satisfied by any two numbers at all.
 */
const LEAST_CHROMA_STEP = 0.05;

/** Above this, a colour carries a hue somebody can name. Rank 2 has to stay under it. */
const NEUTRAL_CHROMA = 0.03;

/**
 * The ramp diverges around the rung a create stamps.
 *
 * `openspec/changes/priority-default-medium/design.md` D3. Colour reads as
 * distance from ordinary: hot above the middle rung, quiet at it, cool below.
 */
describe('the priority ramp', () => {
  it('the middle rank is neutral', () => {
    // The exact value rank 4 carried before this change, pinned as a string
    // rather than described: Dany asked for "same as Lowest now", so the grey on
    // screen has to be the grey he approved and not one re-picked to match a
    // description of it.
    expect(inkAt(2)).toBe('oklch(0.58 0.02 265)');
    expect(oklchOf(inkAt(2)).chroma).toBeLessThan(NEUTRAL_CHROMA);
  });

  it('the two cool ranks are told apart', () => {
    // Proof: ranks 3 and 4 both set to `oklch(0.58 0.12 240)`, and this failed on
    // `expected 0 to be greater than or equal to 0.05` — the margin, which a
    // `toBeDefined`-shaped assertion on either ink could never have seen.
    // Watched 2026-08-29.
    const low = oklchOf(inkAt(3));
    const lowest = oklchOf(inkAt(4));

    expect(low.hue).toBe(lowest.hue);
    // One lightness *band*, not one number: rank 3 carries an extra 0.01 so the
    // less saturated of the pair does not read as the darker one.
    expect(Math.abs(low.lightness - lowest.lightness)).toBeLessThanOrEqual(0.02);
    // Rank 4 is the more saturated, which is the counter-intuitive half: with
    // neutral in the middle, chroma measures distance from ordinary rather than
    // importance.
    expect(lowest.chroma - low.chroma).toBeGreaterThanOrEqual(LEAST_CHROMA_STEP);
  });

  it('a plan of ordinary work carries no warm chip', () => {
    // Every row at the middle rung is what a plan looks like the day after this
    // change, and it must not be a column of yellow.
    const ordinary = oklchOf(inkAt(2));
    expect(ordinary.chroma).toBeLessThan(NEUTRAL_CHROMA);
    // The two hot rungs, for contrast — they are the ones that may shout, and
    // they are unchanged.
    expect([inkAt(0), inkAt(1)]).toEqual(['oklch(0.55 0.21 27)', 'oklch(0.62 0.17 52)']);
  });

  it('paints a tint of the same hue behind the text, at one alpha', () => {
    // The tint is the ink at 14%, on every rung. A tint that drifted off its own
    // ink is a chip whose background argues with its letters.
    for (let rank = 0; rank < 5; rank += 1) {
      const band = DEFAULT_PRIORITY_BANDS.at(rank);
      if (band === undefined) throw new Error('the default ladder is short');
      const style = priorityBandStyleOf(DEFAULT_PRIORITY_BANDS, band.defaultValue);
      expect(style?.tint).toBe(`${style?.ink.slice(0, -1) ?? ''} / 14%)`);
    }
  });
});
