import { priorityBandRankOf } from '@wbs/domain/priority-band';

import type { PriorityBandView } from '@/lib/wbs-api';

/**
 * How one band is drawn: a colour, and the words that go with it.
 *
 * `ink` and `tint` are CSS colours rather than class names, because three of the
 * four faces that read them are not writing `className` at all — the chart paints
 * an SVG `fill`, the export writes a cell, and the cards use an inline style
 * beside a token they already carry. One shape all four can use beats a class for
 * the two that can and a second answer for the two that cannot.
 */
export interface PriorityBandStyle {
  /** The band's own label, verbatim — renameable, so never inferred from the rank. */
  label: string;
  /** The rung, 0 (most important) to 4. What the colour is chosen by. */
  rank: number;
  /** A foreground colour: text, a chart cap, a card chip's letters. */
  ink: string;
  /** The same hue behind text, at an alpha a body font stays readable on. */
  tint: string;
  /** One sentence naming the band and the number, for a `title` or an `aria-label`. */
  words: string;
}

/**
 * The five inks, most important first, keyed on **rank** and never on the label.
 *
 * A project may rename `Critical` to `Blocker`, so a colour that followed the
 * word would follow it out of the ladder. The rank is the rung and the rung is
 * what "more important" means, so the ramp runs with it: hot at 0, cool and quiet
 * at 4.
 *
 * `oklch` and not hex, which is this app's convention and the reason is
 * legibility in both themes — the lightness component is stated rather than
 * emerging from a hue rotation, so `Lowest` is quiet in dark mode instead of
 * disappearing. The five are held at one lightness band on purpose: this is a
 * **nominal** scale drawn from an ordinal one, and a ramp that also got darker
 * would say "more important" twice and read as a heat map of something measured.
 *
 * **Dany has said the colours will be revisited once he can see them** (the R9
 * brief, 2026-08-14). That is exactly why they are five entries in one array
 * behind one function rather than a rule in each renderer: changing them is
 * editing this table, and no face has an opinion of its own to update.
 */
const BAND_INKS: readonly { ink: string; tint: string }[] = [
  { ink: 'oklch(0.55 0.21 27)', tint: 'oklch(0.55 0.21 27 / 14%)' },
  { ink: 'oklch(0.62 0.17 52)', tint: 'oklch(0.62 0.17 52 / 14%)' },
  { ink: 'oklch(0.62 0.13 92)', tint: 'oklch(0.62 0.13 92 / 14%)' },
  { ink: 'oklch(0.58 0.11 205)', tint: 'oklch(0.58 0.11 205 / 14%)' },
  { ink: 'oklch(0.58 0.02 265)', tint: 'oklch(0.58 0.02 265 / 14%)' },
];

/**
 * How a priority is drawn on **every** face, or `null` for a work item nobody has
 * prioritised.
 *
 * **This is the one function.** The table's Prio cell, the chart's bars, the plan
 * cards and the export all resolve a number to a label and a colour here and
 * nowhere else. Dany's ask was "ui must display differently for different
 * priorities"; a rule spread across four renderers is four rules that agree until
 * one of them is edited, and the geometry files are where such a rule goes to be
 * forgotten.
 *
 * Null for an unprioritised work item, and every caller renders that as **nothing
 * at all** rather than as a grey chip reading `—`. A priority is a scale, and a
 * column of furniture down a plan nobody has prioritised says less than a blank
 * does — the bargain the Prio cell, the bar's hover card and the export column
 * each already made before this change.
 *
 * The rank comes from {@link priorityBandRankOf}, which is total by construction:
 * a ladder starts at 1 and a priority is 1 or more, so a number always lands on a
 * rung. The `?? null` below is unreachable from stored data and is here because
 * `BAND_INKS` is indexed by a number the compiler cannot bound.
 */
export function priorityBandStyleOf(
  bands: readonly PriorityBandView[],
  priority: number | null,
): PriorityBandStyle | null {
  if (priority === null) return null;
  const rank = priorityBandRankOf(bands, priority);
  const band = bands[rank];
  const paint = BAND_INKS[rank];
  if (band === undefined || paint === undefined) return null;
  return {
    label: band.label,
    rank,
    ink: paint.ink,
    tint: paint.tint,
    words: `${band.label} — priority ${String(priority)}`,
  };
}
