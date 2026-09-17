/**
 * When the marker rules are too close together to be read, and so are not drawn.
 *
 * Slice 8.3. A rule is a 1px vertical line at a marked date; at the 4px rung a
 * day is four pixels wide, so a fortnight of marked days is a picket fence
 * across the chart and the chart stops being a schedule. The measure is
 * `occupiedDatesInViewport / viewportWidthPx * 100` against
 * {@link MARKER_RULE_MAX_PER_100PX}, compared with `>`.
 *
 * Kept out of `gantt-panel.tsx` and out of its test file because all three
 * faults this can have are arithmetic, and arithmetic proved through a rendered
 * chart is proved slowly and read badly. The panel's own cases still owe the
 * wiring — that the chart asks this question at all, with the viewport it
 * really has.
 */

/**
 * Six rules per 100 horizontal pixels, and the seventh is what suppresses.
 *
 * `design.md` §3: 100px is 25 days at the 4px rung, so six is one rule per
 * ~16px and seven puts two inside a single heavy-gridline week. The comparison
 * is `>`, so six itself draws — the boundary is included on purpose, and
 * `>= 6` is one of the two ways to get this wrong.
 */
export const MARKER_RULE_MAX_PER_100PX = 6;

/**
 * The only rung the suppression applies at.
 *
 * At 12px a 100px window spans 8.3 days and at 28px it spans 3.6, so a rule per
 * day there is already legible ink — the fence is a property of 4px and nothing
 * else. Scoping it here rather than letting the measure decide is the
 * difference the 12px case exists to catch: seven dates inside 100px at 12px is
 * `7 > 6` and an unscoped implementation would suppress them.
 */
const FENCE_RUNG_PX = 4;

/** What the chart can see right now, in its own coordinates. */
export interface RuleViewport {
  /** The first day column at least partly on screen, from the scrollport. */
  readonly firstVisibleDay: number;
  /** The scrollport's own width — the `100px` in the measure is against this. */
  readonly widthPx: number;
  /** The rung, one day's width in pixels. */
  readonly dayPx: number;
}

/**
 * Whether the rules are dropped for this viewport.
 *
 * `markerOffsets` is one entry per **marker**, not per marked date, and the
 * de-duplication happens here: what the measure counts is rule *positions*, and
 * seven markers sharing one day are one line on screen. Taking the markers and
 * de-duplicating in the one place that owns the rule keeps a caller from
 * counting them a second, different way.
 */
export function markerRulesAreTooDense(
  markerOffsets: readonly number[],
  viewport: RuleViewport,
): boolean {
  if (viewport.dayPx !== FENCE_RUNG_PX) return false;
  if (viewport.widthPx <= 0) return false;
  const lastVisibleDay = viewport.firstVisibleDay + viewport.widthPx / viewport.dayPx;
  const occupied = new Set(
    markerOffsets.filter((offset) => offset >= viewport.firstVisibleDay && offset < lastVisibleDay),
  );
  return (occupied.size / viewport.widthPx) * 100 > MARKER_RULE_MAX_PER_100PX;
}
