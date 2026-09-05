import { ASSUMED_SLICE_WORKDAYS } from '@wbs/domain/assumed-duration';
import { automaticColor, labelInk, PALETTE } from '@wbs/domain/marker-color';
import {
  addCalendarDays,
  addWorkdays,
  firstWorkdayOf,
  isMonday,
  type IsoDate,
  isWeekend,
  lastWorkdayOf,
  wholeDaysCovering,
} from '@wbs/domain/workday';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CalendarMarkerView, PriorityBandView } from '@/lib/wbs-api';

import { useGanttDetail } from './gantt-detail';
import {
  CAPACITY_LINK_COLOR,
  droppedLinkWords,
  type EstimateTrio,
  type GanttBar,
  type GanttPlan,
  type GanttRowLabel,
  hasTags,
  inkOn,
  layOutGantt,
  type PlacedArrow,
  type PlacedBar,
  placeOnCalendar,
  placeOnWorkdays,
  routeArrow,
  ROW_MIDDLE,
  type ServiceTeamLabel,
  type TagLabel,
} from './gantt-geometry';
import { type AnchorRect, HoverCard } from './hover-card';
import { initialsOf } from './initials';
import { InlineMarkdown } from './inline-markdown';
import type { PointedRows } from './pointed-row-store';
import { priorityBandStyleOf } from './priority-band-style';
import { shortIsoDate } from './short-date';
import { hierarchyIndentFor } from './table-frame';
import { nameWords, numberWords, rowWords } from './work-item-words';

export { rowWords } from './work-item-words';

/**
 * How wide one workday may be drawn, in CSS pixels — the rungs a reader picks
 * between, **widest first**.
 *
 * The one number that turns the chart's user space into pixels. It used to be a
 * constant, and on a phone that made the chart unreadable rather than merely
 * cramped: `wbs-mobile-sweep` measured a 390×844 viewport showing **6 days of a
 * 74-day plan** — 343px of panel, 176 of it the label column, 168px left for the
 * chart at 28px a day, about twelve swipes end to end with nothing to zoom with.
 *
 * A ladder and not a continuous zoom, because every rung has to be a scale the
 * chart is honest at: the axis has to stay legible ({@link axisNumberShown}) and
 * the on-bar labels have to keep the same fitting rule ({@link barText}). Three
 * discrete answers can each be judged; a slider's every intermediate value
 * cannot.
 *
 * The rungs, and what each buys on a 390px phone with the label column out of
 * the way (`390 − 2 × {@link CHART_PAD_PX}` = 366px of chart):
 *
 * - **28** — 13 days. The scale every chart opens at, unchanged, and the one
 *   every existing pixel assertion is written against.
 * - **12** — 30 days, a month.
 * - **4** — 91 days, which is a quarter to within a day.
 *
 * 4 is below the 8px/day the mobile-parity plan proposed (§2.2), and the
 * arithmetic is why: 8px/day buys 45 days on that same 366px, so a note asking
 * for "a quarter fits" and offering 8px/day asked for two things that cannot
 * both be true. The rung is picked from the criterion, not from the note.
 *
 * **91 and not 92.** A calendar quarter is 90–92 days depending which one; at
 * the widest rung the last day of the longest quarter is two pixels past the
 * edge. Said rather than rounded off — what the gate pins is the measured
 * day-count at each rung, not the word "quarter".
 */
export const DAY_SCALES = [28, 12, 4] as const;

/** One of {@link DAY_SCALES} — the only widths a chart is ever drawn at. */
export type DayPx = (typeof DAY_SCALES)[number];

/**
 * What each rung is called on the control.
 *
 * The vocabulary every scheduling tool uses for its zoom, and it names the unit
 * a reader is *reading in* rather than the unit the axis is printed in — the
 * axis is days at every rung. The exact width is in the control's own title,
 * where a number belongs.
 */
export const DAY_SCALE_NAMES: Record<DayPx, string> = {
  28: 'Days',
  12: 'Weeks',
  4: 'Months',
};

/**
 * Whether a claim off a boundary is one of the rungs.
 *
 * Beside the ladder rather than beside the storage read that needs it, so there
 * is exactly one list of the widths this chart may be drawn at: a stored `9`
 * has to be refused by the same array the control offers, or the two drift and
 * a browser ends up holding a scale no control can get back to.
 */
export function isDayPx(claimed: unknown): claimed is DayPx {
  return DAY_SCALES.some((rung) => rung === claimed);
}

/**
 * The width a chart opens at, and the scale every pixel assertion written
 * before the ladder existed is written against.
 *
 * Still used in exactly the two places the coordinate contract allows — the
 * SVG's CSS width and one cell of the HTML axis — except that both now read the
 * rung in force rather than this. Nothing inside the SVG multiplies by either;
 * that is the whole of the contract (design §1), and a bar whose `x` were
 * computed here would be pixels asserted against pixels.
 *
 * 28 is the narrowest a two-digit day-of-month reads at, measured against
 * nothing but the eye; the browser gate is what judges it after scaling.
 */
export const DAY_PX: DayPx = 28;

/**
 * The room a printed axis number needs before it can stand in every cell, in
 * CSS pixels.
 *
 * Two digits at `text-[10px]` come to about 11px, and 14 leaves the pair either
 * side of it a hair of clear space. Below it the numbers would run into each
 * other and the axis would be a grey smear rather than a calendar — so at the
 * compressed rungs only the **heavy** cells print, and the rest keep their
 * gridline, their weekend band, their `data-` attributes and their hover card
 * while saying nothing.
 *
 * At 28 every cell prints, which is the axis exactly as it was.
 */
const AXIS_NUMBER_PX = 14;

/**
 * What one axis cell prints at `dayPx` — its number, or nothing.
 *
 * The gate is on the **cell**, not on the axis: a heavy cell prints at every
 * rung, because the week boundary is the rhythm a compressed axis is read by
 * and losing it would leave a band of days with no date anywhere on it. At
 * 4px/day a Monday's neighbours are blank, so its two digits have 28px of
 * room to overflow into and read clean.
 *
 * The one place this is tight is the **workday** axis of an undated plan, where
 * the heavy cell is every fifth rather than every seventh and the number can
 * reach three digits: 20px of room for 16px of glyph at the widest rung. Said
 * rather than special-cased — it is legible, and a second rule for a second
 * axis is a rule that can disagree with the first.
 */
export function axisNumberShown(day: { shown: string; heavy: boolean }, dayPx: number): string {
  return dayPx >= AXIS_NUMBER_PX || day.heavy ? day.shown : '';
}

/**
 * How tall one row of the chart is, in CSS pixels.
 *
 * The SVG's y unit is one row, so this is both the height of a label in the
 * sticky-left column and the scale factor of the y axis — the two cannot
 * disagree, which is what keeps a bar level with the name beside it.
 */
export const ROW_PX = 28;

/** How wide the sticky-left column of row labels is, in CSS pixels. */
export const LABEL_COLUMN_PX = 176;

/**
 * The least height a drag may leave the panel at: the axis row and two chart
 * rows, `3 × {@link ROW_PX}`. Below it the panel shows nothing worth keeping
 * open, and a drag that went further is a gesture that got away — the handle
 * stays where it is, still there to be dragged back.
 */
export const GANTT_MIN_PX = 3 * ROW_PX;

/**
 * The most height a stored drag is believed at: 80% of a 2160px display, the
 * tallest viewport a height could honestly have been dragged on. Read by
 * **both** the drag clamp and the stored-height check
 * ({@link clampedGanttHeight} is the one function they share), so no drag can
 * produce a height a reload would reject.
 */
export const GANTT_CEILING_PX = 0.8 * 2160;

/**
 * How tall the fade over a shrunk panel's bottom edge is, in CSS pixels.
 *
 * Two thirds of a row ({@link ROW_PX}), so the row the bottom edge cuts through
 * is visibly dissolving rather than sliced: a whole row's worth would swallow
 * the last legible one, and a hairline would read as an artefact.
 */
const GANTT_EDGE_FADE_PX = 20;

/**
 * The fade a panel with chart below the fold draws over its bottom edge.
 *
 * `REFERENCE_SET_EDGE_FADE` in `reference-set-field.tsx` turned on its side and
 * painted rather than masked. A **paint** and not a `mask-image` for one
 * reason: a mask fades the panel's content to whatever is behind the panel, and
 * what is behind it here is the page in the same `--background` — so on the
 * light palette the cut row would dissolve into the identical colour it was
 * already drawn on and the cue would say nothing at all. Painting the
 * background over the content says the same thing in a way both palettes can
 * show, and it leaves the panel's own scrollbar alone, which a mask on the
 * scroll box does not.
 *
 * In the panel's own `--background` rather than a shadow: the chart's rows are
 * drawn on that colour, so this reads as the chart continuing under the edge
 * instead of as a border with something behind it.
 */
const GANTT_EDGE_FADE =
  'linear-gradient(to top, var(--background), ' +
  'color-mix(in oklab, var(--background) 65%, transparent) 55%, transparent)';

/**
 * How much chart is below the bottom edge of the panel's scroll box, in CSS
 * pixels — the number that decides whether the fade is drawn.
 *
 * Zero is both "the panel holds the whole chart" and "the reader has scrolled
 * to the last row": there is nothing below the fold in either case and the
 * panel says so by not drawing the cue. A negative sum is a browser mid-bounce
 * at the end of an overscroll and is the same answer, which is what the floor
 * is for.
 *
 * jsdom answers 0 to all three of these, so it always reads "nothing below" —
 * the cue is a claim about layout and Chromium is its only oracle
 * (`e2e/gantt.spec.ts`).
 */
export function chartBelowTheFold(port: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): number {
  return Math.max(0, port.scrollHeight - port.clientHeight - port.scrollTop);
}

/**
 * How much chart may be below the fold and still count as none, in CSS pixels.
 *
 * Sub-pixel layout means a panel scrolled to its last row lands on fractions
 * rather than on zero, and a fade over a chart with half a pixel left under it
 * is a fade that never goes away.
 */
const AT_THE_LAST_ROW_PX = 1;

/**
 * The height a drag — or a stored height claiming to be one — settles at:
 * inside `[{@link GANTT_MIN_PX}, {@link GANTT_CEILING_PX}]` and no more than
 * `availablePx`, the room the panel's own column has for it
 * ({@link ganttRoomInColumn}).
 *
 * **The room, and never a share of the viewport.** The panel does not live in
 * the window — it lives in the plan's flex column, beside a toolbar, the table
 * and whatever banners are up. Measured in Chrome on 2026-08-29 at a 963px
 * viewport: the column had 488px for the panel and the old `0.8 ×
 * window.innerHeight` cap allowed 770, so a drag put the panel's bottom at
 * 1200 against a column bottom of 955 with every ancestor `overflow: visible`
 * and no page scroll — 245px of chart nothing could reach.
 *
 * The floor wins over a room below it: a panel under the floor shows nothing.
 * On a column that short the panel is drawn at the floor and clipped by the
 * column, which is the honest answer — the alternative is a strip with no chart
 * in it at all.
 */
export function clampedGanttHeight(px: number, availablePx: number): number {
  // Proof: with the fault this replaced put back — `Math.min(GANTT_CEILING_PX,
  // 0.8 * window.innerHeight)` — `caps at the room it is given` failed on
  // `expected 614.4000000000001 to be 488`, the cap answering for jsdom's 768px
  // window instead of the 488px column it was handed. Watched 2026-08-29.
  const cap = Math.min(GANTT_CEILING_PX, availablePx);
  return Math.max(GANTT_MIN_PX, Math.min(px, cap));
}

/**
 * How much height the flex column a Gantt panel lives in can give that panel,
 * read out of the boxes the browser really laid out.
 *
 * The column's content height, less **what every other child of it insists on
 * keeping**: its margins always, plus either the `min-height` it declares, if it
 * can shrink to one, or the height it is standing at.
 *
 * **Measured, never derived.** Subtracting known figures — a nominal toolbar
 * height, `TABLE_NEEDS_HEIGHT`, a banner — is the obvious alternative and it is
 * wrong at exactly the sizes nobody tests: the toolbar is `flex-wrap` and takes
 * a second row at some widths, and the banners come and go.
 * {@link GanttHeightHandle} already takes the panel's own box for that reason;
 * this is the same argument applied to the rest of the sum.
 *
 * **The panel's own height is not in the sum**, and that is the load-bearing
 * property rather than a tidiness: the answer is the same whatever the panel is
 * currently drawn at, so feeding it back into that height converges in one step
 * — and, more to the point, a panel that is *already overflowing* still gets
 * told the truth. A sum written the other way round — the panel's box, plus the
 * slack under it, plus what the others could give up — reads the room off a
 * broken layout as the broken height itself, because an overflowing column has
 * no slack and its shrinkable child is already on its floor. That version was
 * written first and is what this replaced.
 *
 * A child is credited with a `min-height` only where it declares a definite one
 * **and** can shrink to it. Every other flex child has `min-height: auto` — its
 * own content — which is not a floor this sum may count on, so such a child is
 * counted at the height it stands at.
 *
 * **`null` is "nothing has been laid out", and it is a different answer from
 * `0`.** jsdom measures every box at 0; a column that has genuinely run out of
 * room measures a real height and keeps all of it, which is a `0` the floor in
 * {@link clampedGanttHeight} then wins over. Collapsing the two would be the
 * unknown converted to a default that R5 is about.
 * Chromium is this function's only oracle (`e2e/gantt.spec.ts`).
 */
export function ganttRoomInColumn(column: HTMLElement, panel: HTMLElement): number | null {
  const columnStyle = getComputedStyle(column);
  const contentHeight =
    column.getBoundingClientRect().height -
    lengthPx(columnStyle.paddingTop) -
    lengthPx(columnStyle.paddingBottom) -
    lengthPx(columnStyle.borderTopWidth) -
    lengthPx(columnStyle.borderBottomWidth);
  // A column with no height is a column nothing has laid out. Deliberately not
  // an `isFinite` test as well: a NaN here would mean a computed length came
  // back as something other than a length, and answering "no layout" to that
  // would hide it — the sum carries the NaN out instead, where a test can see
  // it (`answers nothing where nothing has been laid out`).
  if (contentHeight <= 0) return null;

  let kept = 0;
  for (const child of column.children) {
    if (!(child instanceof HTMLElement)) continue;
    const childStyle = getComputedStyle(child);
    // Out of flow: it takes none of the column's height, so it holds none of it
    // back either. The toast stack is the production case.
    if (childStyle.position === 'fixed' || childStyle.position === 'absolute') continue;
    // Margins are never collapsed in a flex container, so they add up.
    kept += lengthPx(childStyle.marginTop) + lengthPx(childStyle.marginBottom);
    if (child === panel) continue;
    const standing = child.getBoundingClientRect().height;
    const floorPx = Number.parseFloat(childStyle.minHeight);
    kept +=
      childStyle.flexShrink !== '0' && Number.isFinite(floorPx)
        ? Math.min(standing, floorPx)
        : standing;
  }

  return Math.max(0, contentHeight - kept);
}

/**
 * A computed CSS length in px, and 0 for anything that is not one.
 *
 * The zero is jsdom, which answers every computed style with the empty string
 * and every box with 0 — so {@link ganttRoomInColumn}'s column measures no
 * height at all there and it answers `null` before any of these matter. In a
 * browser these properties are always resolved lengths.
 */
function lengthPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The height the panel is actually drawn at: the reader's claim, re-clamped
 * against the room the column has for it **now**.
 *
 * The claim is not rewritten by a re-clamp, which is the whole point of keeping
 * the two apart — a height dragged in a tall window is drawn shorter in a short
 * one and comes back in full when the window does. Same shape as the remembered
 * column widths: storage holds what the reader asked for, and the layout is the
 * authority on what that means today.
 *
 * A `roomPx` of `null` is "nothing has measured the column" — jsdom, and the
 * first paint before the measuring effect runs — and the claim is drawn
 * unclamped, under the `max-height: 100%` the panel falls back to.
 */
export function appliedGanttHeight(claimPx: number | null, roomPx: number | null): number | null {
  if (claimPx === null) return null;
  // Proof: with the unmeasured case folded into the clamp instead — `return
  // clampedGanttHeight(claimPx, roomPx ?? 0)` — `draws the claim unclamped
  // while nothing has measured the column` failed on `expected 84 to be 700`,
  // every jsdom render and every first paint collapsing to the floor. Watched
  // 2026-08-29.
  return roomPx === null ? claimPx : clampedGanttHeight(claimPx, roomPx);
}

/**
 * How much of a row's height a bar leaves empty above and below it, in rows.
 *
 * A fraction of a row rather than a pixel padding: the SVG's y unit is a row,
 * so this is the only unit available inside it — and it stays correct at any
 * {@link ROW_PX}.
 */
const BAR_INSET = 0.18;
const BAR_HEIGHT = 1 - 2 * BAR_INSET;

/**
 * How many workdays a working week is on the **workday** axis.
 *
 * Five, and that axis holds no weekends, so every fifth line **is** a week
 * boundary — the rhythm a reader counts by without anything being written down.
 * It is not a `Date` question there: on a weekend-free axis, workday 5 is the
 * Monday whatever the project started on.
 *
 * It belongs to the no-start-date axis alone. On a calendar a week is **seven**
 * cells, every fifth one is a Saturday, and the week boundary is a Monday —
 * see {@link calendarAxis}.
 */
const WEEK_DAYS = 5;

/**
 * The not-before caret: how far it reaches, in CSS pixels, and how much clear
 * air it keeps between itself and the bar below it, in rows.
 *
 * It lives in the {@link BAR_INSET} band **above** the bar, and that is the
 * whole of the fix it exists for: drawn on the bar's own left edge — which is
 * where it is in every plan where the date is what holds the row — it was
 * painted over by the bar and, on a critical row, by a 2px ring as well. A
 * marker nobody can see is not a marker.
 *
 * The clearance is what keeps the caret's box off the bar's box, and it is
 * asserted as rectangles in `e2e/gantt.spec.ts` rather than as path data: two
 * `d` strings can be provably apart and still overlap once one of them is
 * stroked.
 *
 * Pixels for the length and rows for the band, because the band **is** a
 * fraction of a row and the length is a decision about legibility — the same
 * split {@link BAR_RADIUS_PX} documents.
 */
const NOT_BEFORE_LENGTH_PX = 8;
const NOT_BEFORE_CLEARANCE = 0.03;

/**
 * How round a bar's corners are, in CSS pixels — turned into the user space's
 * **two** units to get there.
 *
 * `rx` is measured on x and `ry` on y, and this chart's two axes are scaled by
 * different amounts, so a single number in user units comes out as an ellipse:
 * `rx={0.1}` is 2.8px across and 0.1 of a row down. Dividing by each axis's own
 * scale is what makes the corner square.
 *
 * This is not the pixel arithmetic design §1 rejects. That rule is about the
 * **engine's** numbers — a start, a duration — which reach `x` and `width`
 * unconverted and are asserted against the payload. A corner radius is a
 * decision made in pixels in the first place and has no other honest unit.
 */
const BAR_RADIUS_PX = 3;

/**
 * One chip on the chart's own toolbar — `Names`, `Detail`, `Full`, `⇩`.
 *
 * Through `buttonVariants` rather than a hand-rolled border, for the reason
 * that table's own note gives: this app's reset leaves every `<button>` its
 * platform box, so a chrome control that does not go through the variants gets
 * the platform's idea of one. Three things were measured wrong before this
 * existed, at 900px in Chromium:
 *
 * - keyboard focus drew the **browser's** ring, not the app's. A chip with the
 *   old class string, appended to this same bar and arrived at by `Tab`, read
 *   `outline: auto 1px rgb(0, 95, 204)` with no ring in its `box-shadow`;
 *   every other focusable control in this app answers with `ring-ring`. That
 *   blue `auto` outline is what Dany called ugly on the sign-in form's reveal,
 *   which had the same cause.
 * - `⇩` stood 19px tall where its four neighbours and the scale `<select>`
 *   stood 16px, because the glyph's line box is taller than the words'.
 *   `leading-none` and a stated height are what make the row one row.
 * - every chip carried `ml-1` **and** sat in a `gap-1` row, so the gaps were
 *   8px between chips and 4px after the caption.
 *
 * The ring is `ring-1 ring-offset-1` rather than the variants' `ring-2
 * ring-offset-2`: on a 16px chip in a 21px bar the wider ring is clipped by
 * the panel's own top border, which reads as a broken box rather than focus.
 *
 * `cn` wraps the variants rather than `buttonVariants({ className })` taking
 * the overrides, and that is not a style choice. `cva` **appends** `className`
 * without merging it, so `size: 'default'`'s `h-9` and the base's `ring-2`
 * both survived alongside `h-4` and `ring-1`, and the stylesheet's order
 * decided: the first cut drew four 36px chips beside a 16px `<select>`. `cn`
 * is `tailwind-merge`, which drops the losing half — but only where the two
 * halves collide, which is why `py-0` is spelled out below. Every number here
 * was read off `getBoundingClientRect` in Chromium at 900px, and two guesses
 * at this paragraph were wrong before it: `h-9` was blamed for a height
 * `py-2` was making, and `box-border` was added for a `box-sizing` that was
 * already `border-box`.
 */
const chartChip = (extra?: string): string =>
  cn(
    buttonVariants({ variant: 'outline' }),
    // `py-0` is load-bearing. `tailwind-merge` resolves a conflict, and
    // `size: 'default'`'s `py-2` conflicts with nothing here — so it survived,
    // put 8px above and below a 10px word, and the chips measured 18px against
    // the scale `<select>`'s 16px. `border-border` for the same reason in the
    // other direction: `variant: 'outline'` brings `border-input`, and this
    // bar's border is `border-border`.
    'h-4 rounded border-border px-1.5 py-0 text-[10px] leading-none font-semibold tracking-wide normal-case',
    'focus-visible:ring-1 focus-visible:ring-offset-1',
    extra,
  );

/** What a chart chip looks like when the thing it names is switched off. */
const CHART_CHIP_OFF = 'border-dashed text-muted-foreground/60 line-through';

/**
 * How wide the priority cap at a bar's left edge is drawn, in px.
 *
 * The bar's own two visual channels are already spoken for — `fill` is the
 * assignee and `stroke` is the critical path — so the band gets a **third**
 * mark rather than a repaint of either. Dany's ask was "ui must display
 * differently for different priorities"; overloading the assignee colour would
 * have made two facts one colour and told the reader neither.
 *
 * Three pixels: the same figure as {@link BAR_RADIUS_PX}, because that is the
 * corner the cap sits inside and a cap narrower than the rounding would be a
 * sliver behind a curve. Pixels rather than workdays, for `BAR_RADIUS_PX`'s
 * reason — a mark's size is not a duration — divided by {@link DAY_PX} at the
 * point of use, since the viewBox is measured in workdays.
 *
 * A cap is never drawn wider than the bar it caps: a one-day bar at a wide zoom
 * is still wider than 3px, but a slice estimated at zero days draws no rect at
 * all and takes its cap with it (both come off {@link drawnBars}).
 */
const PRIORITY_CAP_PX = 3;

/**
 * A dependency arrow's approach and its head, in CSS pixels — turned into the
 * user space's two units where they are used.
 *
 * `ARROW_APPROACH_PX` is how far the line steps clear of a bar before it turns,
 * and `ARROW_HEAD_PX`/`ARROW_HEAD_HALF_PX` are the head's length and half its
 * base. Pixels rather than workdays for the reason {@link BAR_RADIUS_PX} gives:
 * an arrowhead is a decision about how big a mark has to be to be seen, and a
 * workday is not a size. Divided by {@link DAY_PX} and {@link ROW_PX} at the
 * point of use, so the head stays a triangle rather than becoming a sliver if
 * the two scales ever part.
 *
 * The approach is longer than the head on purpose: the head sits **inside** the
 * final horizontal run, so a head longer than the run it is drawn on would
 * start before the corner and read as a bend rather than as a point.
 */
const ARROW_APPROACH_PX = 10;
const ARROW_HEAD_PX = 7;
const ARROW_HEAD_HALF_PX = 3.5;

/**
 * The heaviest stroke anything on this chart is drawn with, in CSS pixels.
 *
 * Every stroke here is `non-scaling-stroke`, so it is centred on its geometry
 * and half of it lies outside: a mark standing exactly on the canvas edge is
 * painted half. Named rather than folded into the number below, because it is
 * why {@link CHART_PAD_PX} is not simply the excursion.
 */
const HEAVIEST_STROKE_PX = 2;

/**
 * How much canvas the chart keeps **outside** the schedule, at each end, in CSS
 * pixels.
 *
 * The marks are not all inside the engine's numbers. A dependency arrow steps
 * {@link ARROW_APPROACH_PX} clear of a bar before it turns and carries a head
 * back to the bar's own edge, and a not-before caret reaches
 * {@link NOT_BEFORE_LENGTH_PX} to the right of the day it holds — so a
 * successor at workday 0 routes through **negative** x, and an arrow off the
 * last bar routes past the horizon. The `viewBox` used to start at 0 and end at
 * the horizon, and a browser's own `overflow: hidden` on an `<svg>` clipped
 * both: at workday 0 the head painted **nothing at all**, measured in
 * Chromium, while `getBoundingClientRect` went on reporting the box it would
 * have had.
 *
 * So the drawn canvas is the schedule plus this band at either side, and the
 * viewBox says so: `-pad 0 (horizon + 2·pad) rowCount`. The coordinate contract
 * is untouched — a bar's `x` is still `earliestStart` and its `width` still its
 * drawn span, which for every estimated slice is `duration` verbatim (design
 * §1; the one exception is {@link ASSUMED_SLICE_WORKDAYS}, which the
 * horizon accounts for rather than this band). What moves is where the
 * **canvas** ends,
 * which the contract says nothing about, and the axis and the on-bar labels are
 * shifted by the same number so the workday a bar starts on is still the pixel
 * its axis cell starts at.
 *
 * Symmetric, because both edges have the fault and one number is one thing to
 * keep true. Wide enough for the widest excursion any mark makes plus the
 * heaviest stroke it is drawn with, so a mark standing on the boundary is
 * painted whole rather than halved.
 */
export const CHART_PAD_PX = Math.max(ARROW_APPROACH_PX, NOT_BEFORE_LENGTH_PX) + HEAVIEST_STROKE_PX;

/**
 * The two paths one dependency arrow is drawn from: the elbow, and the filled
 * head at the end of it.
 *
 * **The head is a path and not a `<marker>`.** A marker's contents are laid out
 * in the marker's own viewport, but the element is placed by the referencing
 * geometry's user space — which here is `preserveAspectRatio="none"` over a
 * viewBox measured in workdays by rows, so `markerUnits="userSpaceOnUse"` buys
 * a triangle that is still stretched by whatever ratio the panel happens to be
 * sized at. A path in the same units the rest of the chart is drawn in, with
 * each axis divided by its own scale, is the only shape that stays a triangle —
 * and it is an element a test can find and a browser can measure the box of.
 *
 * **The route is {@link routeArrow}'s**, and it is chosen against the bars the
 * panel is drawing rather than from the two ends alone. A finish-to-start
 * dependency very often has `toStart === fromFinish`: the successor begins the
 * day the predecessor ends. The old elbow then collapsed into a vertical line
 * **on** the successor's left edge, underneath its bar and — on a critical row
 * — underneath a 2px ring, which is a dependency drawn and invisible. With no
 * room the line steps out past the predecessor's right edge and crosses in the
 * clear band beside its row; with room and nothing under the turn, the plain
 * elbow does the same thing in three points; and with a bar under the turn it
 * dodges. Which is which is the geometry's to decide, on the rectangles this
 * function hands it — `drawnBars`, because a bar nothing paints is not
 * something to dodge.
 *
 * **Since `declutter-one-button` that set depends on the switch**, and the
 * consequence is worth stating rather than discovering. With the detail on,
 * every unestimated bar is drawn, so every one of them is also an obstacle.
 * `arrow-dodge` was cleared partly on the argument that `arrow.fromX` is never
 * strictly inside a drawn bar — and that argument was load-bearing on the
 * assumed bars being *absent*. It is reachable now: a leaf whose slices in step
 * order are an unestimated one and then an estimated one of under two workdays
 * has `fromX = stopOf(fromStart, fromFinish)` landing inside the ghost's own
 * `[startOf(s), stopOf(s, s + ASSUMED_SLICE_WORKDAYS)]`, on the arrow's
 * own row. Every candidate route's first run then reads as crossing and
 * `routeArrow` falls through to its banded fallback, which returns a route
 * known to cross. It bites when the anchor's duration is under two workdays and
 * not when it is two or more.
 *
 * The consequence is cosmetic — an elbow drawn over a translucent dashed ghost,
 * which is what the chart did before `gantt-declutter` anyway — and it is left
 * as it is: the alternative is a second, switch-independent obstacle list, and
 * the honest version of that is a geometry change with its own proposal. What
 * it costs is that a fallback the `arrow-dodge` review proved dead is a live
 * path in the detail-on state. Written down here and in that change's
 * `verify.md` rather than fixed. Cross-review, 2026-08-12.
 *
 * Either way the last run is horizontal and arrives at the successor's start,
 * so the head always points right and never has to be rotated.
 */
function arrowRoute(
  arrow: PlacedArrow,
  barsByRow: ReadonlyMap<number, PlacedBar[]>,
  dayPx: number,
): { elbow: string; head: string } {
  const at = (x: number, y: number): string => `${String(x)} ${String(y)}`;
  const toY = arrow.toRowIndex + ROW_MIDDLE;
  // Both of these turn a **pixel** length into the user space's own unit, so
  // the rung has to be the one in force: at 4px/day an approach of ten pixels
  // is two and a half days of user space, not the third of a day it is at 28.
  // Held constant, the head would shrink to a speck and the elbow would leave
  // no clear band at all.
  // Only the rows this arrow runs between, which is what `routeArrow` filters
  // for anyway: every run of every candidate route stays between the two rows
  // the arrow joins. It was handed **every** drawn bar until 2026-09-02 and
  // filtered them per arrow — 100 arrows over 200 bars is 20,000 comparisons
  // per re-render of the chart, for a range two lookups answer.
  const obstacles: PlacedBar[] = [];
  for (
    let row = Math.min(arrow.fromRowIndex, arrow.toRowIndex);
    row <= Math.max(arrow.fromRowIndex, arrow.toRowIndex);
    row += 1
  ) {
    obstacles.push(...(barsByRow.get(row) ?? []));
  }
  const route = routeArrow(arrow, obstacles, {
    approach: ARROW_APPROACH_PX / dayPx,
    barInset: BAR_INSET,
  });
  const headX = ARROW_HEAD_PX / dayPx;
  const headY = ARROW_HEAD_HALF_PX / ROW_PX;
  return {
    elbow: route
      .map((corner, index) => `${index === 0 ? 'M' : 'L'} ${at(corner.x, corner.y)}`)
      .join(' '),
    head:
      `M ${at(arrow.toX, toY)} ` +
      `L ${at(arrow.toX - headX, toY - headY)} ` +
      `L ${at(arrow.toX - headX, toY + headY)} Z`,
  };
}

/**
 * What an unestimated slice's bar is drawn with beyond its colour: a fill it can
 * be seen through and an outline that is not solid.
 *
 * Both, and not either alone. The bar has a **width nobody gave it**
 * ({@link ASSUMED_SLICE_WORKDAYS}), so it has to be unmistakable at a
 * glance against every estimated bar on the chart: translucent says the block is
 * not solid ground, and the dashes say the edges are not where anybody put them.
 * A solid bar at 35% could still read as a pale assignee colour; a dashed bar at
 * full strength reads as a bar with a border.
 *
 * Arbitrary properties rather than a stylesheet for the same reason
 * {@link BAR_RADIUS_PX} is divided by two scales: these land on an SVG element
 * inside a non-uniformly scaled user space, and `stroke-dasharray` there is in
 * user units unless the stroke is non-scaling — which every stroke here is.
 *
 * Proof: this arm of {@link barClasses} emptied, so an assumed bar was painted
 * like a costed one. `draws no mark for a slice nobody estimated until the
 * detail is asked for` alone failed, `1 failed | 90 passed`, on `expected '' to
 * contain '[fill-opacity:0.35]'`. Watched 2026-08-12.
 */
const ASSUMED_BAR_CLASSES = '[fill-opacity:0.35] [stroke-dasharray:3_2]';

/**
 * The classes a bar carries beyond its two colours, and the two facts they say.
 *
 * The critical path is a ring rather than a fill, because the fill is the
 * assignee: it is asserted by name in `gantt-panel.test.tsx` rather than through
 * a `data-` attribute that could be right while the bar drew like every other
 * one. `data-critical` rides along for the browser gate, which needs to find the
 * bar before it can measure it.
 *
 * An unestimated bar is only ever drawn with the detail switch on, and when it
 * is it has to be told apart from the costed bars beside it at a glance — see
 * {@link ASSUMED_BAR_CLASSES}.
 *
 * `[stroke-width:2]` and not a border: strokes here carry
 * `vector-effect="non-scaling-stroke"`, so 2 is 2 CSS pixels at any zoom of a
 * user space measured in workdays.
 */
function barClasses(critical: boolean, estimated: boolean): string {
  return [
    critical ? 'stroke-foreground [stroke-width:2]' : '',
    estimated ? '' : ASSUMED_BAR_CLASSES,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * How much room the on-bar label leaves at each end of the bar, in CSS pixels,
 * and roughly how wide one of its characters is at `text-[10px]` semibold.
 *
 * `LABEL_CHAR_PX` is an estimate and is allowed to be: it decides only whether a name
 * is swapped for initials or dropped, and it is deliberately generous so the
 * swap happens before a name is clipped rather than after. The browser gate is
 * what judges the result. 5 is the 9px reading of the 5.5 this held at
 * `text-[10px]` — the label dropped a size in `gantt-polish` and the estimate
 * follows the font it measures.
 */
const LABEL_PAD_PX = 3;
const LABEL_CHAR_PX = 5;

/**
 * A calendar day's month as a person says it: `Aug 2026`, never `2026-08`.
 *
 * A fixed English table rather than `toLocaleDateString`: the corner caption is
 * asserted by text in tests that run under whatever locale the machine has, and
 * a caption that moves with the machine is a test that passes here and fails on
 * CI. The app has no i18n anywhere else; the chart does not start one.
 *
 * @throws on a month no calendar has. `IsoDate` is validated where it enters,
 * so a slice outside 01–12 here is malformed trusted data, not a state.
 */
export function monthWords(date: IsoDate): string {
  const shortMonths = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ] as const;
  const monthIndex = Number(date.slice(5, 7)) - 1;
  // Proof: this guard deleted, the lookup ran unchecked and the fault came
  // back as the string `undefined 2026`. `refuses a month no calendar has,
  // out loud` alone failed, on `expected [Function] to throw an error`.
  // Watched 2026-08-09.
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error(`${date} names a month no calendar has`);
  }
  return `${shortMonths[monthIndex]} ${date.slice(0, 4)}`;
}

/**
 * One axis cell's two lines: the date in words, then what kind of day it is.
 *
 * `Mon 17 Aug 2026` over `Workday 5` or `Weekend`; a cell of the dateless
 * workday axis has only its number to say. Fixed English tables for
 * {@link monthWords}' reason — a caption asserted by text cannot move with the
 * machine's locale — and the weekday is read at UTC midnight the way
 * `isWeekend` reads it, never through a bare `new Date(iso)`, whose parse
 * moves the day by one in half the world's zones.
 *
 * @throws monthWords' error on a month no calendar has.
 */
export function axisDayWords(day: {
  date: IsoDate | null;
  workday: number | null;
  offset: number;
  weekend: boolean;
}): string[] {
  if (day.date === null) return [`Workday ${String(day.workday ?? day.offset)}`];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const weekday = weekdays[new Date(`${day.date}T00:00:00Z`).getUTCDay()];
  const dated = `${weekday} ${String(Number(day.date.slice(8)))} ${monthWords(day.date)}`;
  return [
    dated,
    day.weekend || day.workday === null ? 'Weekend' : `Workday ${String(day.workday)}`,
  ];
}

/**
 * The reader's own today as a calendar date, in **their** zone.
 *
 * `toISOString().slice(0, 10)` is the obvious spelling and it is wrong here: it
 * converts to UTC first, so at 01:00 in Kyiv it answers yesterday and the
 * marker stands a day left of where the reader's calendar has it. Everything
 * else in this panel takes an `IsoDate` that came from be-01 and was already a
 * date; this is the one place a `Date` becomes one, so the conversion is
 * written out and tested rather than inlined.
 *
 * Which half of the day breaks depends on which side of Greenwich the reader
 * is: **east of UTC it is the small hours** — 00:30 in Kyiv is 21:30 UTC the
 * day before, so the marker stands a column *left* of today — and west of it,
 * the late evening, the other way. The test asserts both ends of one day for
 * that reason.
 *
 * Proof: written as `today.toISOString().slice(0, 10)` and `reads a late
 * evening as the day the reader is having` failed under `TZ=Europe/Kyiv` on
 * `expected '2026-08-18' to be '2026-08-19'` — the 00:30 assertion, a reader
 * in Dany's own zone shown yesterday's column as today for the first three
 * hours of every day. Watched 2026-08-19, see verify.md.
 */
export function isoToday(today: Date): IsoDate {
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${String(today.getFullYear())}-${month}-${day}`;
}

/**
 * Where a calendar date stands on the chart, or null when the axis does not
 * hold that date at all.
 *
 * **Read off the axis rather than computed a second time**, and that is the
 * whole of the design: the gridlines, the weekend bands and the day cells are
 * all `axis[k].offset`, so a mark that looks its own offset up in the same
 * array cannot drift from the lines it is drawn between. A parallel
 * `calendarDaysBetween(axis[0].date, date)` would be a second scale agreeing
 * with the first only for as long as nobody touched either — the failure
 * `calendarAxis`' own docstring warns about, one layer up.
 *
 * **The agreement is what makes the drift invisible in ordinary tests.** On
 * every axis {@link calendarAxis} builds, a cell's stored `offset`, its index
 * and its calendar distance from `axis[0].date` are the same number, so the
 * arithmetic spelling passes each of them. Only an axis whose offsets are none
 * of those three can tell the two apart, which is what this function's own
 * negative is built on.
 *
 * Null is a real answer and not an error: a date before the first cell, a date
 * past the last, and every date on a plan with no calendar — {@link workdayAxis}
 * gives every cell `date: null`, so the lookup finds nothing without needing to
 * know why. What null then means is the caller's to say; {@link todayOffset}
 * gives the three readings today has for it.
 */
export function axisOffsetOf(axis: readonly AxisDay[], date: IsoDate): number | null {
  return axis.find((day) => day.date === date)?.offset ?? null;
}

/**
 * Where today stands on the chart, or null when it does not stand on it at all.
 *
 * **The lookup itself is {@link axisOffsetOf}'s**, and today is only its first
 * caller: a calendar marker asks the same question of the same array, and two
 * spellings of one lookup are two scales that can disagree — the thing the
 * lookup exists to prevent, reintroduced one level down. What stays here is
 * what is true of *today* specifically and of no other date on the chart.
 *
 * **Null is a real answer in three different situations, and all three want the
 * same thing — no line:**
 *
 * - **Today is before the plan begins.** Dany, 2026-08-19, asked what should
 *   happen and the call is no line rather than one pinned to the left edge: a
 *   rule at the margin reads as "today is the start date", which is a statement
 *   the chart would be making up.
 * - **Today is past the last day drawn.** The same argument on the other side.
 *   A plan that finished last month is a plan today is not on.
 * - **The chart has no calendar at all.** Every cell of {@link workdayAxis} has
 *   `date: null`, so the lookup finds nothing and the marker is absent without
 *   needing to know why. Nothing on that axis is a date, so there is no honest
 *   place to put today on it — the same reason the hover text falls back to
 *   workday offsets there.
 *
 * **A weekend is not one of them.** On the calendar axis a Saturday is a cell
 * two wide with the rest of them, so today falling on one puts the line in the
 * gap between Friday's work and Monday's, where it belongs. That the marker
 * needs no weekend arm of its own is a property of the axis, not an oversight.
 */
export function todayOffset(axis: readonly AxisDay[], today: IsoDate): number | null {
  return axisOffsetOf(axis, today);
}

/**
 * What a bar writes on itself: the assignee's **short name**, or nothing.
 *
 * Two answers and not three, since `gantt-short-assignee` (Dany, 2026-08-31 —
 * _"the Gantt must always use the assignee's short name"_). This measured the
 * bar and wrote the whole name where it fitted, so one person read two ways on
 * one chart — `vadym kucherenko` on a ten-day bar and `VK` on a one-day bar —
 * and a reader scanning a column of bars for one person had no fixed mark to
 * scan for. The width a bar happens to have is not a fact about who is on it.
 *
 * The short name is {@link initialsOf}'s, which is the folded step cell's, so a
 * bar and the cell beside it name the same person identically. Nothing is lost
 * that the bar's own hover card does not say in full.
 *
 * The one measurement left is the refusal: a bar without room for the short name
 * writes no assignee, because a label box over a 5px bar is a stray outline and
 * a swallowed click rather than words. A bar with nobody on it writes nothing
 * either — its colour already says so.
 *
 * Null rather than an empty string, so a caller cannot render a label that is
 * there and blank.
 *
 * @param personName The assignee's name as the directory holds it, or null.
 * @param drawnSpan The bar's drawn span in calendar cells, weekends included.
 * @param dayPx How wide one cell is drawn.
 * @returns One or two characters, or null where nobody is on it or nothing fits.
 */
export function barLabelFor(
  personName: string | null,
  drawnSpan: number,
  dayPx: number,
): string | null {
  // Before {@link initialsOf}, which **throws** on a name with no non-space
  // character in it rather than answering with a blank badge (its own R5 note).
  // The chart's deleted copy returned `''` and this guard is what replaces it.
  if (personName === null || personName.trim() === '') return null;
  const room = drawnSpan * dayPx - 2 * LABEL_PAD_PX;
  const short = initialsOf(personName);
  return room >= short.length * LABEL_CHAR_PX ? short : null;
}

/**
 * What a bar with nobody on it writes instead of a name: whose team's work it
 * is, and how many of them are on it.
 *
 * `Platform ×3` where the plan runs three at once, `Platform` where it runs
 * one. The team and not a blank because an unassigned bar's colour says only
 * "nobody is named", and on a plan that schedules by team that is the least
 * interesting half of the truth — the pool it draws from is what decides its
 * dates. A bar somebody **is** named on keeps the name: one label, and the
 * person is the more specific fact.
 *
 * The candidates are tried longest-first through the same room measurement
 * {@link barLabelFor} makes, so a narrow bar drops the name and keeps the
 * count — `×3` is the half a reader cannot get from anywhere else on the chart.
 *
 * Null where there is no team to name: no label, exactly as an unassigned bar
 * writes none today.
 */
export function poolLabelFor(
  team: ServiceTeamLabel,
  width: number,
  drawnSpan: number,
  dayPx: number,
): string | null {
  const name = team.state === 'named' || team.state === 'inherited' ? team.name : null;
  if (name === null) return null;
  const room = drawnSpan * dayPx - 2 * LABEL_PAD_PX;
  const candidates = width > 1 ? [`${name} ×${String(width)}`, `×${String(width)}`, name] : [name];
  return candidates.find((label) => room >= label.length * LABEL_CHAR_PX) ?? null;
}

/**
 * The whole of what a bar writes on itself: who, then the row's own words.
 *
 * `who` is the assignee reading the width already decided — a name, initials,
 * the assumed bar's `?`-carrying candidate, or null when nobody fits or nobody
 * is on it — and the row words follow it always, because sixty anonymous
 * colours was the fault this label exists to remove. The string is **not**
 * measured against the bar: the label box is the bar's width and crops with an
 * ellipsis, so a narrow bar shows as much of the words as it has pixels for
 * rather than none of them.
 *
 * The one refusal left is a bar without room for a single character, which
 * keeps `writes nothing at all on a bar too narrow to hold a letter` true: a
 * label box over a 5px bar is a stray outline and a swallowed click, not words.
 *
 * Proof: given the old appending rule — the words only when they fully fit —
 * `4 failed | 48 passed`: `carries the row words whole even where the box must
 * crop them` on `expected 'Kat' to be 'Kat · strip - strip'` and the three
 * narrow-bar cases with it, every wide bar green. Watched 2026-08-09.
 */
export function barText(
  who: string | null,
  words: string,
  drawnSpan: number,
  dayPx: number,
): string | null {
  if (drawnSpan * dayPx - 2 * LABEL_PAD_PX < LABEL_CHAR_PX) return null;
  return who === null ? words : `${who} · ${words}`;
}

/**
 * What an unestimated bar writes on itself: the `?` always, and whoever is on it
 * if there is room for them too.
 *
 * The `?` is the point and is never dropped for the name: this bar's width is
 * {@link ASSUMED_SLICE_WORKDAYS} and not an estimate, and a bar that says
 * `KA` and nothing else is a bar claiming two days of Kat's time. So the two
 * candidates are tried longer-first and the bare `?` is the second of them —
 * which at two workdays always fits, and is what a bar drawn narrower than that
 * would fall back to.
 *
 * **Two candidates and not three, since `gantt-short-assignee`.** The middle one
 * was the full name, and {@link barLabelFor} says why it is gone: one person is
 * one mark whatever a bar's width is.
 *
 * Null rather than an empty string, for {@link barLabelFor}'s reason: a caller
 * cannot render a label that is there and blank.
 *
 * Proof: the call site swapped for {@link barLabelFor}, so an assumed bar wrote
 * the assignee and the row words and nothing about being a guess. `draws no
 * mark for a slice nobody estimated until the detail is asked for` alone
 * failed, `1 failed | 90 passed`, on `expected 'Kat · sand - sand' to contain
 * '?'`. Watched 2026-08-12.
 */
export function assumedLabelFor(
  personName: string | null,
  drawnSpan: number,
  dayPx: number,
): string | null {
  const room = drawnSpan * dayPx - 2 * LABEL_PAD_PX;
  const who = personName === null ? '' : personName.trim();
  // The trim above is what makes {@link initialsOf} safe to call: it throws on a
  // name with no non-space character rather than answering with a blank badge.
  const candidates = who === '' ? ['?'] : [`${initialsOf(who)} · ?`, '?'];
  return candidates.find((label) => room >= label.length * LABEL_CHAR_PX) ?? null;
}

/**
 * One cell of the axis: where it stands, what it prints, and what it is.
 *
 * `offset` is the cell's own place in the chart's user space — one unit per
 * cell, so cell `k` stands at `x = k` and the axis and the canvas under it
 * cannot drift. `date` and `workday` are the two things a cell may or may not
 * have: a plan with no start date has no dates at all, and a weekend cell of a
 * calendar has no workday number.
 */
export interface AxisDay {
  offset: number;
  /** The workday this cell is, or null on a weekend and on a plan with no calendar. */
  workday: number | null;
  date: IsoDate | null;
  shown: string;
  weekend: boolean;
  /** Whether the heavy gridline falls here — a Monday, or every fifth workday off a calendar. */
  heavy: boolean;
}

/**
 * One calendar marker, as the chart draws it.
 *
 * The shape be-01's list route answers with, minus the `projectId` and
 * `createdAt` no mark on this chart reads — a view type rather than a re-export
 * so a column added to `calendar_marker` later reaches the panel only when
 * somebody names it here.
 *
 * **`color` is nullable and that is the stored value, not the drawn one.**
 * `null` means *automatic*, which {@link automaticColor} resolves from the
 * marker's own id (`schema.ts`: the auto colour is derived on the way out and
 * never materialised, so a marker that has never been recoloured has no fill in
 * the database at all). {@link markerFill} is the one place that resolution
 * happens on this side.
 */
/**
 * Re-exported, not declared: the shape is what be-01 sends, so it moved to
 * `lib/wbs-api.ts` beside the calls that fetch it (task 7.2a). This line is
 * what keeps every importer here unchanged — and a second `interface` would be
 * a second shape free to drift from the one the read actually answers.
 */
export type { CalendarMarkerView };

/**
 * The fill a marker is actually drawn in: its own colour, or the automatic one
 * its id decides.
 *
 * Named rather than inlined at the chip because two marks draw one marker —
 * the chip here and the rule down the body (task 8.2) — and a second spelling
 * of `?? automaticColor(id)` is a chart that can disagree with itself about
 * what colour one marker is.
 */
export function markerFill(marker: CalendarMarkerView): string {
  return marker.color ?? automaticColor(marker.id);
}

/**
 * The empty marker list, once.
 *
 * A module constant and not a `= []` default in the parameter list: that
 * spelling builds a **new** array on every render, and the chip layer's memo
 * takes `markers` as a dependency — so every unrelated re-render of the panel
 * would rebuild every chip on a chart that has no markers at all.
 */
const NO_MARKERS: readonly CalendarMarkerView[] = [];

/**
 * What an undated plan's axis cell says when it is operated.
 *
 * It names the **missing project start date** and not merely "this cannot be
 * marked", because the refusal is only actionable if the reader learns which
 * thing to go and set. A marker's date is absolute, so the marker itself is
 * perfectly storable against an undated project (task 7.4) — what is missing
 * is the calendar this axis would have to draw it on, and saying that is the
 * difference between a dead control and a next step.
 */
const UNDATED_REFUSAL =
  'This plan has no project start date, so its days are workday numbers rather than calendar days and cannot carry a calendar marker. Set a project start date first.';

/**
 * The workday axis: one cell per whole workday the horizon reaches, printing
 * the offset itself.
 *
 * What a plan with **no start date** is drawn on, and nothing else. It holds no
 * weekend anywhere — there is no calendar to have one on — so the week boundary
 * is {@link WEEK_DAYS} arithmetic rather than a date.
 *
 * The cell count is `wholeDaysCovering` and never a bare ceil: this axis's
 * horizon is the engine's own workday numbers, drift included, and one drifted
 * bit on the last finish is not a cell no work can ever stand in.
 *
 * **`date: null` on every cell is a guarantee and not an implementation
 * detail**, which is why this function and {@link AxisDay} are exported for a
 * test that calls it directly. The whole of §7's refusal hangs off it: a
 * calendar marker is an absolute date, an undated plan has none to offer, and
 * the cell says so by having no date rather than by anyone asking whether the
 * project has a start. Give these cells a synthesised date — the plausible
 * helpful change — and every refusal in section 7 becomes unreachable while
 * each of its tests keeps passing, because a live cell refuses nothing. Routed
 * through the panel the same assertion would go green the day some future
 * change gave every project a start date; asserted here it breaks loudly.
 */
export function workdayAxis(horizon: number): AxisDay[] {
  return Array.from({ length: wholeDaysCovering(horizon) }, (_, workday) => ({
    offset: workday,
    workday,
    date: null,
    shown: String(workday),
    weekend: false,
    heavy: workday % WEEK_DAYS === 0,
  }));
}

/**
 * The calendar axis: one cell per calendar day from the plan's first working
 * day, weekends among them.
 *
 * Cell `k` is `origin + k` calendar days and stands at user-space `x = k`,
 * which is the same reading {@link placeOnCalendar} gives every mark under it —
 * the two cannot drift because they are one scale. The weekend cells are the
 * point of the whole change: a bar that used to cross a Saturday of no width
 * now stops at one two cells wide.
 *
 * The origin is `addWorkdays(startDate, 0)`, the same normalisation the Start
 * column and {@link calendarScale} make, so a project beginning on a weekend
 * begins on the Monday. The dates come from the module be-01 prints the Start
 * column with, imported directly rather than through `libs/domain`'s index,
 * which re-exports arktype-touching validators this bundle excludes
 * (`wbs-api.ts:1-9`).
 *
 * The heavy line falls on a **Monday** and not on every fifth cell: a calendar
 * week is seven cells wide and its fifth is a Saturday.
 *
 * @throws Whatever `addWorkdays` throws when `startDate` is not a calendar
 * date. be-01 validated it at its boundary; a string that reaches here and is
 * not one is malformed trusted data, and the panel lets it reach the error
 * boundary rather than drawing an axis of `Invalid Date`.
 */
function calendarAxis(startDate: IsoDate, horizon: number): AxisDay[] {
  const origin = addWorkdays(startDate, 0);
  // Counted as the days are walked rather than asked for per cell: the workday
  // a calendar day is, is how many working days have gone before it, and the
  // walk already knows. The origin is a workday by construction, so the first
  // cell takes 0.
  let workday = -1;
  // A bare ceil, and **not** `wholeDaysCovering` — which the workday axis does
  // count with, because there the horizon is the engine's own drifted numbers.
  // The invariant here: this horizon is read off marks already placed by
  // `calendarScale`, whose `startOf`/`endOf` snap before every discrete step,
  // so nothing drifted survives to reach this ceil. A snap-aware helper on that
  // input is protection whose absence no test can observe — R5 does not ship
  // one. `gantt-calendar-snap`'s `verify.md` records the injection that stayed
  // green and why.
  return Array.from({ length: Math.ceil(horizon) }, (_, offset) => {
    const date = addCalendarDays(origin, offset);
    const weekend = isWeekend(date);
    if (!weekend) workday += 1;
    return {
      offset,
      workday: weekend ? null : workday,
      date,
      weekend,
      heavy: isMonday(date),
      // The day of the month alone: 28px is not a date. The whole date is on
      // the cell — in `data-axis-date` and in the `title` — and the corner
      // above the labels says which month these numbers are days of.
      shown: date.slice(8),
    };
  });
}

/**
 * The days a bar runs over, for the sentence it shows on hover.
 *
 * The same two dates the row's Start and End columns print, computed the same
 * way rather than read off the row: this is the panel's own reading of the
 * engine's numbers, and a test comparing the two is what says they agree.
 * Without a project start date there are no days to name, so the workday
 * offsets stand in — the same fallback the axis above makes.
 *
 * **Workday arithmetic on the engine's own offsets, never the calendar scale's
 * coordinates.** `placeOnCalendar` answers where a mark is *drawn*, and a
 * coordinate is not an index into working days: a slice running 3 → 5 has its
 * right edge at calendar day 5, which off a Monday origin is the Saturday
 * nobody worked, while `addWorkdays(origin, 5)` is the Monday after it. Both
 * ends go through the shared `@wbs/domain` readings — `firstWorkdayOf` and
 * `lastWorkdayOf`, the same pair be-01's `datesOf` prints the columns with —
 * rather than a bare floor and ceil of this file's own: an inline floor
 * applied *before* `addWorkdays` defeated the snap inside it, and a drifted
 * 2.9999999999999996 named the day before the one the Start column prints.
 *
 * Proof: the inline floor put back — `addWorkdays(startDate,
 * Math.floor(start))` — and `reads a drifted schedule as the same days be-01
 * prints` failed alone, on the sentence no longer containing `13 Aug →
 * 14 Aug`: the drifted 2.9999999999999996 floored to 2 before the snap inside
 * `addWorkdays` could see it, naming 12 Aug. Watched 2026-08-10.
 *
 * Printed by {@link shortIsoDate} and by nothing else: `shortInstant` formats an
 * epoch in the browser's zone, and a `new Date(iso)` of its own parses midnight
 * UTC and reads the day back in the reader's, one day early for everybody west
 * of Greenwich.
 */
function spanWords(startDate: IsoDate | null, start: number, finish: number, today: Date): string {
  if (startDate === null) return `Workdays ${daysNumber(start)} → ${daysNumber(finish)}`;
  const from = addWorkdays(startDate, firstWorkdayOf(start));
  const to = addWorkdays(startDate, lastWorkdayOf(start, finish));
  return `${shortIsoDate(from, today)} → ${shortIsoDate(to, today)}`;
}

/**
 * A number of days as prose reads it: two decimals at most, and no trailing
 * zeroes.
 *
 * The one place a schedule number is **not** carried verbatim, and deliberately
 * so: PERT hands out 3.6666666666666665, which is the right number to draw with
 * and an unreadable thing to write in a sentence. The drawing and the
 * `data-start`/`data-finish` attributes beside it still carry it whole — this
 * is prose, and it says so by rounding.
 */
const daysNumber = (days: number): string => String(Number(days.toFixed(2)));

/**
 * What a screen reader announces when it lands on a dated axis cell.
 *
 * The cell's own text is a bare number — `19` — which is the one thing a
 * reader arriving by Tab already cannot use: §6's argument for giving these
 * cells a tab stop at all is that a row of stops announced "button" and
 * nothing else is worse than no stop. So the name carries the day, and it
 * carries what is already standing on it, because the marker chips are drawn
 * in a `pointer-events-none` layer over the band and are therefore invisible
 * to everything except sight.
 *
 * The count is spelled out rather than left to the chips because a cell with
 * two markers and a cell with none are the same element to a reader otherwise
 * — and "no calendar markers" is said out loud rather than omitted, so that
 * silence on a cell means the name failed to build rather than that the day is
 * empty.
 */
function axisCellName(date: IsoDate, markers: number, today: Date): string {
  const day = shortIsoDate(date, today);
  if (markers === 0) return `${day}, no calendar markers`;
  return markers === 1
    ? `${day}, 1 calendar marker`
    : `${day}, ${String(markers)} calendar markers`;
}

/** `1 day`, `2 days`, `3.67 days`. */
function dayWords(days: number): string {
  const shown = daysNumber(days);
  return `${shown} ${shown === '1' ? 'day' : 'days'}`;
}

/**
 * How long a bar runs, and what an unestimated slice says instead of a length.
 *
 * Proof: the not-estimated arm dropped, so a guessed width read as `0 days` —
 * the engine's own finish-where-it-starts printed as a fact. `draws no mark for
 * a slice nobody estimated until the detail is asked for` alone failed,
 * `1 failed | 90 passed`, on `expected '…14 Aug → 14 Aug · 0 days…' to contain
 * 'not estimated'`. Watched 2026-08-12.
 */
const durationWords = (bar: GanttBar): string =>
  bar.estimated ? dayWords(bar.duration) : 'not estimated';

/**
 * The service team a bar is labelled with, in words, absences included.
 *
 * An **inherited** label says where it came from, because a reader looking at
 * the row cannot: the row itself names no team, and the pool its dates were
 * computed against belongs to an ancestor. "Why did this bar move when somebody
 * edited a team's number" is exactly the question the ancestor's number
 * answers, and it is unanswerable from a bar that says `Team Platform` with no
 * Platform anywhere on the row.
 */
function teamWords(team: ServiceTeamLabel): string {
  switch (team.state) {
    case 'named':
      return `Team ${team.name}`;
    case 'inherited':
      return `Team ${team.name} — inherited from ${team.fromRow}`;
    case 'none':
      return 'No team';
    // Not a blank and not a throw: the label and the team list are two reads at
    // two moments, so a team added between them is stale rather than lost. See
    // {@link ServiceTeamLabel}.
    case 'unresolved':
      return 'Team not in this directory read';
  }
}

/**
 * What kind of thing a bar's work is, in words, or null where nobody has said.
 *
 * **Null on an untagged row, where the team's line prints `No team`.** Not an
 * inconsistency: a team is the pool the dates were computed against, so its
 * absence is a fact about the schedule this surface exists to explain, and
 * `No team` is why nothing is holding the bar up. A tag decides nothing, so
 * `No tags` on every bar of every plan nobody has tagged is furniture — the
 * bargain the priority line already strikes two lines down.
 *
 * The **inherited** arm names its ancestor for {@link teamWords}'s reason, and
 * it is the weaker of the two: a reader looking at a row that names no tag has
 * nowhere else to learn where the words came from.
 */
function tagWords(tags: TagLabel): string | null {
  if (!hasTags(tags)) return null;
  // Per name rather than per set, which is what ADR 0008 cost this sentence: a
  // row states `Ready` and carries `Risk` from `010` at once, so there is no
  // single source to put after a single `—`. Naming each inherited one where it
  // stands is longer and is the only version that is true.
  const said = [
    ...tags.own,
    ...tags.inherited.map((each) => `${each.name} (inherited from ${each.fromRow})`),
  ];
  return `Tags ${said.join(', ')}`;
}

/**
 * What a bar says about running several people at once, or null where there is
 * nothing to say.
 *
 * Three states, and the two that print are the two a reader cannot work out
 * from the dates alone:
 *
 * - **Compressed.** `width > 1`: the bar is shorter than the work is long, and
 *   the sentence carries both numbers — `3 people in parallel — 6 days of work
 *   in 2` — so nobody reads a 2-day bar as a 2-day job.
 * - **Overridden.** A person is named on a work item asking for several: D3's
 *   rule is that one human cannot work beside themselves, so the engine
 *   scheduled width 1 and the number somebody typed did nothing. Silence here
 *   is the plan ignoring that number without saying so.
 *
 * Null at width 1 with nothing overridden, which is every plan that has never
 * been given a parallelism: a line reading `1 person in parallel` on every bar
 * of every plan is furniture, exactly as the priority line would be.
 *
 * Both numbers are needed and they are different facts — `maxParallel` is what
 * was typed on the work item, `width` is what the engine could give it after
 * the team's size and the named person had their say. The **other** way the two
 * come apart is the team being smaller than the number, and that is
 * {@link clampWords} on the line below this one.
 */
function parallelWords(bar: GanttBar): string | null {
  if (bar.personName !== null && bar.maxParallel > 1) {
    return `One person is named — ${daysNumber(bar.maxParallel)} in parallel not applied`;
  }
  if (bar.width <= 1) return null;
  return `${daysNumber(bar.width)} people in parallel — ${dayWords(bar.effort)} of work in ${daysNumber(
    bar.duration,
  )}`;
}

/**
 * What a bar says when the team's size took the parallelism down, or null where
 * nothing was clamped.
 *
 * The second reason `maxParallel` and `width` differ, and the one the chart has
 * never said: be-01's `widthFor` is `min(maxParallel, slots)` for work nobody is
 * named on, so a row asking for 3 people from a team of 2 runs at 2 and no
 * sentence on the chart says why. The export's `People at once` / `Ran at` pair
 * and the in-parallel cell's `title` were the only places to learn it — neither of them
 * on the drawing whose dates it moved. C3 recorded it (2026-08-13, P3).
 *
 * `width` **is** the team's size whenever this line prints: the clamp is the
 * only thing that can put `width` under `maxParallel` once a named person is
 * ruled out, and `min(a, b) < a` means the answer was `b`. That is what lets
 * the sentence state a number the payload does not carry as a field.
 *
 * Silent on a bar somebody is named on, however small the team: D3 collapses
 * that width to 1 on its own and {@link parallelWords} already says so. Two
 * `not applied` lines over one bar would be the chart reporting one number as
 * ignored twice, for two reasons, only one of which is load-bearing.
 *
 * The team is not named here. The line above it in {@link barFacts} is
 * {@link teamWords}, which names it — and naming it again would need words for
 * the two nameless label states this sentence has no business owning.
 *
 * **Silent on a payload carrying no `maxParallel` at all**, which the type says
 * cannot happen and one test fake does: `apiWithMovableFloor` in
 * `wbs-table.test.tsx` builds a work item without the field, and the row built
 * from it reaches here with `undefined` where a number belongs. Written as this
 * line found it — `daysNumber(undefined)` threw and the fault boundary replaced
 * the whole chart in `redraws the open chart when a not-before edit moves the
 * schedule`. {@link parallelWords} beside it has been quietly silent on the same
 * payload since C3 (`undefined > 1` is false), and a missing hover line is the
 * proportionate answer to a missing number where a whole chart is not. The fake
 * wants `maxParallel: 1` — `wbs-table.tsx` and its test were another agent's
 * file the day this landed, and the fix is recorded in `verify.md` rather than
 * taken.
 */
function clampWords(bar: GanttBar): string | null {
  if (bar.personName !== null) return null;
  if (!Number.isFinite(bar.maxParallel) || bar.width >= bar.maxParallel) return null;
  return `The team may have ${daysNumber(bar.width)} at work at once — ${daysNumber(
    bar.maxParallel,
  )} in parallel not applied`;
}

/** A bar's own step's three points, or the absence of them, in words. */
function trioWords(trio: EstimateTrio | null): string {
  if (trio === null) return 'No estimate for this step';
  return [trio.optimistic, trio.realistic, trio.pessimistic].map(daysNumber).join('/');
}

/**
 * Everything a bar can say about itself, one fact to a line, in the order a
 * reader meets them: which row, who and what, the team, the dates, the trio,
 * the float, what holds it where it is, and what it waits for.
 *
 * Lines rather than one string, because the same facts are rendered twice — as
 * paragraphs in the hover surface and joined onto the bar's `aria-label`, which
 * is what carries them once the native `<title>` is off the bars. One
 * derivation, so the two cannot drift.
 *
 * Every absence is a named state: no step, nobody assigned, no team, a team the
 * directory read does not hold, no estimate for this step — each says so in
 * words rather than leaving a blank or dropping its line, because a reader
 * cannot tell a missing fact from a fact nobody wrote down. The one line that
 * _is_ dropped is what the row waits for, and only when it waits for nothing:
 * `after` with nothing after it is not a fact.
 *
 * The floor keeps its place near the end because it is the sentence the panel
 * was built to show.
 *
 * @param bar the slice this states the facts of.
 * @param startDate the day the plan begins, or null while it is not on a
 * calendar and the words are workday offsets.
 * @param today the reader's own today, which is the year {@link shortIsoDate}
 * measures its omission against.
 */
export function barFacts(
  bar: GanttBar,
  startDate: IsoDate | null,
  today: Date,
  /**
   * This plan's ladder, so the line reads `Critical — priority 10` rather than a
   * bare number nobody on this chart can name. Empty before the first read
   * lands, which resolves to no band and leaves the line as the number alone.
   */
  bands: readonly PriorityBandView[] = [],
): string[] {
  return [
    // The row's own label, word for word — {@link rowWords} and not a second
    // spelling of it, so the surface opens on the same line the chart's label
    // column and the plan's Number column read.
    rowWords(bar.workItemNumber, bar.workItemName),
    `${bar.stepName ?? 'No step'} · ${bar.personName ?? 'Unassigned'}`,
    teamWords(bar.team),
    // Straight after the team, because it is a fact about that team's people:
    // the compressed line explains a bar shorter than its own estimate, and the
    // override line explains a stored number the plan did not use. Both are
    // null on a plan nobody has given a parallelism, which is every plan today.
    parallelWords(bar),
    // And the other way the stored number and the scheduled one come apart:
    // the team was smaller than what was asked for. Its own line rather than a
    // clause on the one above, because at width 1 there is no line above —
    // which is exactly the case the chart said nothing about at all.
    clampWords(bar),
    // After the team and its two people-lines rather than beside the team,
    // because those three are one subject — whose people this bar is waiting
    // for — and the tags are a different one. Before the dates, because it is a
    // fact about *what this work is* and those are facts about when it runs.
    //
    // Proof: this line deleted, so the chart held the tags and said them
    // nowhere — a dimension that exists everywhere else in the tool and not on
    // the one surface a reader hovers to ask what a bar is. `1 failed | 132
    // passed` in `gantt-panel.test.tsx`, on `expected [ '010 - Strip', …(6) ]
    // to include 'Tags Compliance, Rework'`. Watched on h2puni, 2026-08-20.
    tagWords(bar.tags),
    `${spanWords(startDate, bar.start, bar.finish, today)} · ${durationWords(bar)}`,
    // A line of its own rather than a word tucked into the duration: the bar is
    // drawn a width nobody gave it, and the sentence that says so has to be as
    // findable as the dates above it. See {@link ASSUMED_SLICE_WORKDAYS}.
    // Only ever reached with the detail switch on, which is the only state an
    // unestimated slice has a bar to say anything about itself in.
    //
    // Proof: this line deleted, so the width nobody gave was stated nowhere but
    // in the paint. `draws no mark for a slice nobody estimated until the detail
    // is asked for` alone failed, `1 failed | 90 passed`, on the accessible name
    // no longer containing `Not estimated — drawn as 2 days`. Watched
    // 2026-08-12.
    bar.estimated ? null : `Not estimated — drawn as ${dayWords(ASSUMED_SLICE_WORKDAYS)}`,
    trioWords(bar.trio),
    bar.critical ? 'On the critical path — no float' : `Float ${dayWords(bar.float)}`,
    // Only where somebody set one. Unranked is a state of its own, and a line
    // reading `Priority —` on every bar of every plan that priorities nothing is
    // furniture, not a fact — the same bargain the cell in the table makes by
    // rendering blank at rest.
    //
    // Proof: the null check dropped, so the line is always built, and `says
    // nothing about priority for a work item nobody has given a priority` failed on the
    // card containing `Priority null`; watched 2026-08-11.
    // The band's own words where the ladder can name the number, and the bare
    // number where it cannot — which is only the moment before the first read
    // lands. `priorityBandStyleOf` is the same resolution the table's cell, the
    // cards and the export use; this face takes the sentence out of it and the
    // colour is on the cap drawn at the bar's left edge.
    //
    // Still nothing at all for a work item nobody has prioritised: a line reading
    // `Priority —` on every bar of every plan that priorities nothing is
    // furniture, not a fact, and that bargain predates this change.
    bar.priority === null
      ? null
      : (priorityBandStyleOf(bands, bar.priority)?.words ?? `Priority ${String(bar.priority)}`),
    bar.floorWords,
    bar.waitsFor.length === 0 ? null : `after ${bar.waitsFor.join(', ')}`,
  ].filter((line): line is string => line !== null);
}

/**
 * What a not-before caret says on hover: the date the row cannot start before.
 *
 * The mark itself can only say *where*, and a workday on a scaled axis is not a
 * date anybody can read off. The offset is turned back into a date by the same
 * `addWorkdays` the axis above it is printed with — `wbs-table.tsx`'s
 * `notBeforeOffsetOf` got the offset out of the stored date with that function's
 * own inverse, so this reads back the day that was typed.
 *
 * Without a project start date there is no date to name, and the axis is
 * offsets: the sentence says the offset, exactly as {@link spanWords} does.
 */
function notBeforeWords(startDate: IsoDate | null, offset: number): string {
  if (startDate === null) return `No earlier than workday ${daysNumber(offset)}`;
  return `No earlier than ${addWorkdays(startDate, offset)}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The five theme tokens the standalone export paints with — every colour the
 * live chart's marks read off a class rather than a literal attribute (§2 of
 * the enumeration this answers: weekend bands, row bands, gridlines,
 * brackets, the not-before caret and the arrow paths all resolve one of
 * these through Tailwind's `bg-*`/`fill-*`/`stroke-*` utilities and
 * `styles.css`'s custom properties).
 *
 * A bar's own colour, the critical outline and the capacity link are never
 * in this set: they are literal hex already ({@link PERSON_BAR_COLORS},
 * {@link CAPACITY_LINK_COLOR}), so a file opened with no stylesheet at all
 * paints them correctly with nothing read here.
 */
interface GanttSvgTheme {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
}

/**
 * What jsdom hands back for every custom property: nothing, because no
 * stylesheet is loaded into a component test. A real browser resolves the
 * five reads below to `styles.css`'s tokens for whichever palette is
 * painted; jsdom's empty string falls back to this literal light palette
 * instead, which is what makes the exporter's structure testable at all
 * without a browser (`vitest.setup.ts` carries the same bargain for
 * `matchMedia`). Values are `styles.css`'s own `:root` numbers, not a
 * second palette invented for this file.
 */
export const FALLBACK_GANTT_THEME: GanttSvgTheme = {
  background: 'oklch(1 0 0)',
  foreground: 'oklch(0.129 0.042 264.695)',
  muted: 'oklch(0.968 0.007 247.896)',
  mutedForeground: 'oklch(0.554 0.046 257.417)',
  border: 'oklch(0.929 0.013 255.508)',
};

/**
 * The palette actually painted right now, read off the document rather than
 * duplicated from `styles.css` — which is what lets a reader who chose dark
 * download a file that looks like their own screen instead of always the
 * light one. {@link paintPalette} is the one line that ever puts `.dark` on
 * `documentElement`, and a custom property's computed value is the raw
 * `oklch(...)` token stream `styles.css` wrote, valid SVG paint on its own.
 */
function resolvedGanttTheme(): GanttSvgTheme {
  const computed = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = computed.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };
  return {
    background: read('--background', FALLBACK_GANTT_THEME.background),
    foreground: read('--foreground', FALLBACK_GANTT_THEME.foreground),
    muted: read('--muted', FALLBACK_GANTT_THEME.muted),
    mutedForeground: read('--muted-foreground', FALLBACK_GANTT_THEME.mutedForeground),
    border: read('--border', FALLBACK_GANTT_THEME.border),
  };
}

/** The presentation properties a class can carry that a standalone file needs literally. */
const INLINE_STYLE_PROPS = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
] as const;

/**
 * The C0 control range XML 1.0 refuses outright (tab/LF/CR excepted).
 *
 * `schedule.ts` builds a slice id as `${workItemId}\u0000${stepId}` -- a
 * separator nobody can type, deliberately -- and that id reaches
 * `data-gantt-bar` verbatim. A browser paints a NUL in an HTML/SVG attribute
 * without complaint, which is exactly why this went unnoticed until the file
 * was opened standalone: XMLSerializer writes the byte through and a strict
 * XML parser refuses it, so every mark after the first bar was silently
 * unparsed ("invalid character in attribute value", Chromium, watched
 * 2026-08-17). Replaced rather than dropped, so two ids that only differed
 * in the separator do not become the same string.
 */
// eslint-disable-next-line no-control-regex -- the control characters are exactly what this strips
const XML_INVALID_ATTR_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function withInlineComputedStyle(original: Element): Element {
  const clone = original.cloneNode(false) as Element;
  if (original.hasAttribute('class')) {
    const computed = window.getComputedStyle(original);
    for (const prop of INLINE_STYLE_PROPS) {
      if (clone.hasAttribute(prop)) continue;
      const value = computed.getPropertyValue(prop).trim();
      if (value !== '') clone.setAttribute(prop, value);
    }
    clone.removeAttribute('class');
  }
  clone.removeAttribute('role');
  clone.removeAttribute('tabindex');
  for (const name of Array.from(clone.getAttributeNames())) {
    const value = clone.getAttribute(name) ?? '';
    const safe = value.replace(XML_INVALID_ATTR_CHARS, '-');
    if (safe !== value) clone.setAttribute(name, safe);
  }
  for (const child of Array.from(original.childNodes)) {
    clone.appendChild(
      child instanceof Element ? withInlineComputedStyle(child) : child.cloneNode(true),
    );
  }
  return clone;
}

function svgRect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(width));
  rect.setAttribute('height', String(height));
  rect.setAttribute('fill', fill);
  return rect;
}

function svgLine(x1: number, y1: number, x2: number, y2: number, stroke: string): SVGLineElement {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', stroke);
  return line;
}

function svgText(
  x: number,
  y: number,
  content: string,
  opts: { fontSize: number; fill: string; fontWeight?: string; anchor?: string },
): SVGTextElement {
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(x));
  text.setAttribute('y', String(y));
  text.setAttribute('font-size', String(opts.fontSize));
  text.setAttribute('fill', opts.fill);
  if (opts.fontWeight !== undefined) text.setAttribute('font-weight', opts.fontWeight);
  if (opts.anchor !== undefined) text.setAttribute('text-anchor', opts.anchor);
  text.textContent = content;
  return text;
}

/** The corner's own month caption, read off the plan's first day rather than the scroll position a static file has none of. */
function monthCaptionFor(axis: readonly AxisDay[], startDate: IsoDate | null): string {
  if (startDate === null) return 'Workday';
  const first = axis[0]?.date ?? null;
  return first === null ? 'Workday' : monthWords(first);
}

/** What {@link buildStandaloneGanttSvg} needs — every input already computed for the live render, nothing re-derived. */
interface StandaloneGanttSvgInput {
  chartSvg: SVGSVGElement;
  /**
   * The rung the live chart is drawn at, carried across rather than assumed.
   *
   * The one field here that is not merely "already computed": the nested
   * `<svg>` brings its own geometry over at whatever width the live panel sized
   * it to, while the label column, the axis and the on-bar words are rebuilt
   * from pixel arithmetic in this function. A constant here would let the two
   * halves of one file disagree — bars laid out at 4px a day under an axis
   * printed at 28 — which is precisely the drift a downloaded file cannot be
   * checked for after the fact.
   */
  dayPx: number;
  labels: readonly GanttRowLabel[];
  axis: readonly AxisDay[];
  drawnBars: readonly PlacedBar[];
  monthCaption: string;
  theme: GanttSvgTheme;
}

/** The gap a label keeps from the divider, the same 8px it starts at on the other side. */
const LABEL_GUTTER_PAD_PX = 8;

/** The font stack every word in the standalone document is drawn in, named once so the measuring pass cannot disagree with the drawing pass. */
const STANDALONE_FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif';

/** One word the file will draw in its gutter, as the measuring pass needs it. */
interface GutterWord {
  content: string;
  /** Where the word starts — indent included, so what is measured is its right edge. */
  x: number;
  fontSize: number;
  fontWeight?: string;
}

/**
 * How wide the downloaded file's label gutter has to be for every word in it
 * to end before the divider.
 *
 * Measured rather than assumed, and that is the whole point: the live panel's
 * label column is {@link LABEL_COLUMN_PX} of HTML that **truncates**, and the
 * file's is `<text>` with nothing clipping it, so until 2026-08-31 a name
 * longer than 176px was drawn straight across the divider into the plot and
 * the bars — appended after it — painted over it.
 *
 * The measurement is a real one: a `<svg>` attached to the document (a
 * detached one measures 0 in Chrome), the same font stack and the same
 * `font-size`/`font-weight` the drawing pass uses, and `getComputedTextLength`
 * per word. It is torn down in a `finally` so a throw between the two cannot
 * leave a stray `<svg>` in the page.
 *
 * **Throws where the document cannot measure text.** `getComputedTextLength`
 * is on every browser and on no jsdom — asking a document that has no layout
 * how wide a word is has no answer, and a guessed one is exactly the gutter
 * this function exists to stop being guessed. Tests get a deterministic
 * stand-in from `vitest.setup.ts`, as they already do for `matchMedia`.
 *
 * The floor is {@link LABEL_COLUMN_PX}: a chart of short names keeps the
 * proportions it has always had, and only a name that does not fit moves
 * anything.
 *
 * Proof: with the measurement thrown away (`widest = LABEL_COLUMN_PX`),
 * `moves the divider, the axis and the chart together for a name that does not
 * fit` fails on `expected 176 to be greater than 176`; with only the axis put
 * back on the constant, the same case fails on `expected -165 to be 20`. Both
 * watched 2026-08-31. What a real font does with a real name is not this
 * document's to say — `e2e/gantt.spec.ts`'s `a name longer than the gutter
 * ends before the first day column` is, in Chromium, and under the same
 * injection it failed on `the name is drawn across the divider and under the
 * bars · Expected: <= 176 · Received: 469.609375`: 294px of name over the
 * plot, which is the fault this exists for.
 */
function measureLabelGutterPx(words: readonly GutterWord[]): number {
  const ruler = document.createElementNS(SVG_NS, 'svg');
  ruler.setAttribute('font-family', STANDALONE_FONT_FAMILY);
  ruler.setAttribute('aria-hidden', 'true');
  ruler.style.position = 'absolute';
  ruler.style.visibility = 'hidden';
  ruler.style.pointerEvents = 'none';
  // `visibility: hidden` and not `display: none`: a box that is not laid out
  // has no text to measure, which is the same answer as no ruler at all.
  ruler.style.left = '-10000px';
  ruler.style.top = '0';
  document.body.appendChild(ruler);
  try {
    let widest = LABEL_COLUMN_PX;
    for (const word of words) {
      const text = svgText(word.x, 0, word.content, {
        fontSize: word.fontSize,
        fill: '#000',
        fontWeight: word.fontWeight,
      });
      ruler.appendChild(text);
      const measure = (text as Partial<SVGTextContentElement>).getComputedTextLength;
      if (typeof measure !== 'function') {
        throw new Error(
          'this document cannot measure SVG text (no getComputedTextLength), so the downloaded chart cannot size its label gutter',
        );
      }
      widest = Math.max(widest, word.x + measure.call(text) + LABEL_GUTTER_PAD_PX);
    }
    return widest;
  } finally {
    ruler.remove();
  }
}

/**
 * The whole standalone document: the label column and the calendar axis,
 * both built fresh as `<text>` because neither exists inside the live `<svg>`
 * (design §1 — "every word is HTML around it"), and the chart's own geometry,
 * reused rather than re-derived by nesting a style-inlined clone of the live
 * `<svg>` at the label column's own width. A nested `<svg>` keeps its own
 * `viewBox`/`preserveAspectRatio`, so the geometry's non-uniform scale — a
 * calendar day wide, a row tall — travels with it unchanged.
 *
 * The bar text (who is on it) is the one word that has to be rebuilt rather
 * than reused: it is HTML overlaid on the live page for the same reason the
 * labels and axis are (design §1), so it is drawn here from the same
 * {@link barLabelFor}/{@link poolLabelFor}/{@link assumedLabelFor}/
 * {@link barText} pure functions the live overlay calls, at the same pixel
 * arithmetic.
 */
function buildStandaloneGanttSvg(input: StandaloneGanttSvgInput): SVGSVGElement {
  const { chartSvg, labels, axis, drawnBars, monthCaption, theme, dayPx } = input;
  const innerWidth = Number(chartSvg.getAttribute('width') ?? '0');
  const innerHeight = Number(chartSvg.getAttribute('height') ?? '0');
  // The words that stand in the gutter: every row label, and the corner's own
  // month caption above them. Built **once** and then both measured and drawn
  // from — a second expression for `x` further down is how a gutter comes to be
  // measured for a label the file does not actually draw.
  const monthWord: GutterWord = { content: monthCaption, x: 8, fontSize: 10, fontWeight: '600' };
  const labelWords = labels.map((label) => ({
    content: rowWords(label.number, label.name),
    x: 8 + hierarchyIndentFor(label.depth),
    y: ROW_PX + label.rowIndex * ROW_PX + ROW_PX / 2 + 3,
    fontSize: 10,
  }));
  const gutterPx = measureLabelGutterPx([monthWord, ...labelWords]);
  const totalWidth = gutterPx + innerWidth;
  const totalHeight = ROW_PX + innerHeight;

  // No explicit `xmlns` attribute: `createElementNS` already puts the SVG
  // namespace on the element itself, and `XMLSerializer` writes it out on
  // serialization — a second one set here is the same declaration twice,
  // which a strict XML parser refuses as a duplicate attribute.
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', `0 0 ${String(totalWidth)} ${String(totalHeight)}`);
  root.setAttribute('width', String(totalWidth));
  root.setAttribute('height', String(totalHeight));
  root.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');

  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = 'Gantt chart';
  root.appendChild(title);

  root.appendChild(svgRect(0, 0, totalWidth, totalHeight, theme.background));
  root.appendChild(
    svgText(monthWord.x, ROW_PX / 2 + 3, monthWord.content, {
      fontSize: monthWord.fontSize,
      fontWeight: monthWord.fontWeight,
      fill: theme.mutedForeground,
    }),
  );

  for (const word of labelWords) {
    root.appendChild(
      svgText(word.x, word.y, word.content, { fontSize: word.fontSize, fill: theme.foreground }),
    );
  }

  root.appendChild(svgLine(gutterPx, 0, gutterPx, totalHeight, theme.border));
  root.appendChild(svgLine(0, ROW_PX, totalWidth, ROW_PX, theme.border));

  for (const day of axis) {
    const cellX = gutterPx + CHART_PAD_PX + day.offset * dayPx;
    if (day.weekend) {
      const band = svgRect(cellX, 0, dayPx, ROW_PX, theme.mutedForeground);
      band.setAttribute('fill-opacity', '0.1');
      root.appendChild(band);
    }
    // The same gate the live axis prints under: a downloaded chart of a
    // compressed plan is a picture somebody looks at, and 91 two-digit numbers
    // in 366px is a grey smear there for exactly the reason it is one on screen.
    root.appendChild(
      svgText(cellX + dayPx / 2, ROW_PX / 2 + 3, axisNumberShown(day, dayPx), {
        fontSize: 9,
        fontWeight: day.heavy ? '600' : undefined,
        fill: day.heavy ? theme.foreground : theme.mutedForeground,
        anchor: 'middle',
      }),
    );
  }

  const nestedChart = withInlineComputedStyle(chartSvg) as SVGSVGElement;
  nestedChart.setAttribute('x', String(gutterPx));
  nestedChart.setAttribute('y', String(ROW_PX));
  root.appendChild(nestedChart);

  const labelClips = document.createElementNS(SVG_NS, 'defs');
  root.appendChild(labelClips);

  for (const [index, { bar, x, width }] of drawnBars.entries()) {
    const who = bar.estimated
      ? bar.personName === null
        ? poolLabelFor(bar.team, bar.width, width, dayPx)
        : barLabelFor(bar.personName, width, dayPx)
      : assumedLabelFor(bar.personName, width, dayPx);
    const shown = barText(who, rowWords(bar.workItemNumber, bar.workItemName), width, dayPx);
    if (shown === null) continue;
    const barLeft = gutterPx + x * dayPx + CHART_PAD_PX;
    const barTop = ROW_PX + (bar.rowIndex + BAR_INSET) * ROW_PX;
    const clipId = `gantt-bar-label-clip-${String(index)}`;
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.setAttribute('id', clipId);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    clip.appendChild(svgRect(barLeft, barTop, width * dayPx, BAR_HEIGHT * ROW_PX, '#000'));
    labelClips.appendChild(clip);

    const left = barLeft + LABEL_PAD_PX;
    const top = ROW_PX + (bar.rowIndex + BAR_INSET) * ROW_PX + (BAR_HEIGHT * ROW_PX) / 2 + 3;
    const label = svgText(left, top, shown, {
      fontSize: 9,
      fontWeight: '600',
      fill: bar.estimated ? inkOn(bar.personColor) : theme.foreground,
    });
    // SVG text has no dependable equivalent of the live HTML label's
    // overflow-hidden box. Clip in the outer document's pixel space instead,
    // so real font metrics cannot carry this label into its neighbour. The
    // cloned bar retains the full barFacts aria-label; this visible copy is
    // presentation-only and must not announce a shorter duplicate.
    label.setAttribute('clip-path', `url(#${clipId})`);
    label.setAttribute('aria-hidden', 'true');
    root.appendChild(label);
  }

  return root;
}

/** The bytes a browser downloads: an XML declaration ahead of the serialized tree, so a file opened by extension alone still declares its own encoding. */
function serializeStandaloneGanttSvg(svg: SVGSVGElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}\n`;
}

/**
 * One name per day, so two downloads on the same afternoon do not silently
 * overwrite each other in a Downloads folder that dedupes on nothing but the
 * name.
 *
 * **Through {@link isoToday} and not `toISOString()`**, which is the same fault
 * the marker's own date had and the same reason: `toISOString` converts to UTC
 * first, so for the first three hours of every Kyiv day this named the file
 * after yesterday. That breaks the one property the name is for — a download at
 * 01:00 and another at 10:00 on the same day would land as two different names,
 * and a download at 01:00 today would collide with one at 23:00 yesterday.
 *
 * Proof: written back as `now.toISOString().slice(0, 10)` and `names the file
 * after the reader's own day, not UTC's` fails under `TZ=Europe/Kyiv` on
 * `expected 'gantt-chart-2026-08-18.svg' to be 'gantt-chart-2026-08-19.svg'`.
 * Watched 2026-08-19, see verify.md.
 */
export function ganttSvgFileName(now: Date): string {
  return `gantt-chart-${isoToday(now)}.svg`;
}

/**
 * The Gantt panel: the placed schedule drawn, in the units it was placed in.
 *
 * **One SVG whose user space is the schedule, one day per unit.** With a start
 * date that unit is a **calendar** day and every horizontal coordinate on the
 * chart — the axis included — comes from {@link placeOnCalendar}; without one
 * it is a workday and the engine's numbers stand as they are
 * ({@link placeOnWorkdays}). Nothing in here reads a workday number as a
 * position, and nothing multiplies by {@link DAY_PX} except the two arrangements
 * of HTML around the SVG. A bar's `data-start`/`data-finish` stay the engine's
 * workday numbers whatever the unit is: the test hook is engine-true, the
 * drawing is the scale's, and the difference between them is what says the
 * conversion happened.
 *
 * **At rest, only costed work is drawn.** A slice nobody has estimated has no
 * bar, no tick and no label, a parent's row has no mark of its own, and no
 * dependency arrow is drawn: all three were read as clutter (`gantt-declutter`),
 * and `declutter-one-button` put all three behind **one** switch rather than
 * two mechanisms. Pressed, it draws each family as it was drawn before that
 * change; unpressed — the state every reader starts in — the chart is costed
 * bars, their labels, the hand-offs between them and the carets over them.
 * Every row is on the chart at its own index in **both** states: the chart's row
 * `N` stands beside the plan's row `N`, and nothing the switch does moves a
 * coordinate. See {@link drawnBars}.
 *
 * **The words are not marks.** The dates a bar and a caret say are
 * `addWorkdays`/{@link lastWorkdayOf} on the engine's workday numbers and are
 * never read off a coordinate — a bar that stops at calendar day 5 stops at a
 * Saturday nobody worked, while the fifth working day is the Monday after it.
 *
 * The cost of that non-uniform scale is that glyphs and stroke widths would be
 * stretched with it, so **the SVG holds geometry and nothing else**: every word
 * is HTML around it — the row labels in the sticky-left column, the calendar in
 * the axis row, and the assignee written **over** each bar by the same
 * {@link DAY_PX} arithmetic — and every stroke carries
 * `vector-effect="non-scaling-stroke"`.
 *
 * **A bar says what it is in a surface, not in a tooltip.** The `<title>`
 * children the bars used to carry are gone: they were browser-placed and
 * browser-timed, and a second tooltip beside the one this application draws is
 * a bug. What a bar knows is now {@link barFacts}, rendered into the same
 * {@link HoverCard} the Name cell opens — portalled, because the SVG can hold
 * no HTML — and joined onto the bar's `aria-label`, which is the accessible
 * name that had to arrive **before** the `<title>` left. The not-before caret
 * keeps its own `<title>`: it is the one mark here with no surface, and its
 * words are a single stored date rather than a slice's facts.
 *
 * **A bar's colour is who is on it** — `PERSON_BAR_COLORS` in
 * `gantt-geometry.ts`, handed out there so the whole chart agrees — which is
 * why the critical path is an outline here and not a fill. See
 * {@link barClasses}.
 *
 * A cycle draws no bars at all. be-01 sends an empty slice array with it and
 * the row projections are meaningless, so the honest answer is the sentence
 * rather than a chart of zeroes — the same thing the banner above the plan
 * says, in the place somebody looking at the schedule is looking.
 *
 * @throws GanttDataError out of {@link layOutGantt} when the payload's slices
 * name something the payload has not got. See there.
 */
export function GanttPanel({
  plan,
  startDate,
  scheduleError,
  generation,
  heightPx,
  roomPx = null,
  // Resolved **here** and passed on explicitly, so {@link GanttChart} below
  // takes both as required: optional at the panel's boundary, decided once, and
  // never defaulted a second time somewhere that could disagree.
  dayPx = DAY_PX,
  onPickDayPx = () => undefined,
  labelsShown = true,
  onPickLabelsShown = () => undefined,
  onPickRow,
  onPointRow,
  pointed,
  registerSvgDownload = () => undefined,
  // Defaulted here for `dayPx`'s reason and taken as required below: the
  // seventy-odd renders in `gantt-panel.test.tsx` are about bars, arrows and
  // carets and have no markers to state, and a chart that had to be handed an
  // empty array by every one of them would be stating an absence rather than
  // drawing one.
  markers = NO_MARKERS,
  // Defaulted here beside `markers` and taken as required below, for the same
  // reason: a chart drawn with no markers has nothing to rename, and every
  // render in this file that is about bars would otherwise have to hand over a
  // writer it never reaches.
  onRenameMarker = () => undefined,
  onRecolorMarker = () => undefined,
  onDeleteMarker = () => undefined,
}: GanttProps) {
  // The cycle answer is a different panel rather than a branch inside one, and
  // that is what lets {@link GanttChart} hold its hooks unconditionally: this
  // component has none, so the early return below cannot be a hook order that
  // changes with the payload.
  if (scheduleError === 'cycle') {
    return (
      <section data-gantt-panel aria-label="Gantt chart" className="border-border border-t p-3">
        <p role="status" className="text-sm">
          Nothing can be drawn while these dependencies run in a circle — no dates could be worked
          out. Remove one and the chart comes back.
        </p>
      </section>
    );
  }
  return (
    <GanttChart
      plan={plan}
      startDate={startDate}
      generation={generation}
      heightPx={heightPx}
      roomPx={roomPx}
      dayPx={dayPx}
      onPickDayPx={onPickDayPx}
      labelsShown={labelsShown}
      onPickLabelsShown={onPickLabelsShown}
      onPickRow={onPickRow}
      onPointRow={onPointRow}
      pointed={pointed}
      registerSvgDownload={registerSvgDownload}
      markers={markers}
      onRenameMarker={onRenameMarker}
      onRecolorMarker={onRecolorMarker}
      onDeleteMarker={onDeleteMarker}
    />
  );
}

/** What the panel is given: one chart read, and what to do with a click on it. */
interface GanttProps {
  plan: GanttPlan;
  /** The day the plan begins, or null while it is not on a calendar. */
  startDate: IsoDate | null;
  /** be-01's answer when no dates could be worked out at all. */
  scheduleError: 'cycle' | null;
  /**
   * Which chart read this is drawn from — a number that moves whenever a new
   * one lands.
   *
   * An open hover surface is closed when this moves, and that is the whole of
   * why it is a prop rather than something the panel could work out. A slice
   * that keeps its id across a refetch keeps its `<rect>`: React reuses the
   * node, nothing unmounts, and a surface left open would go on stating the
   * numbers of a read that has been replaced.
   */
  generation: number;
  /**
   * The panel height override in force, or `null` while nothing has been
   * dragged — which keeps the bounded default share, and stores nothing.
   * A number is applied as the panel's own height, with {@link roomPx} stated
   * beside it as a `max-height`.
   *
   * Already re-clamped by the caller ({@link appliedGanttHeight}) — this panel
   * draws what it is handed.
   */
  heightPx: number | null;
  /**
   * The room the column this panel is in has for it, measured
   * ({@link ganttRoomInColumn}), or `null` where nothing has measured it.
   *
   * Applied as the panel's `max-height` in place of the share of the viewport
   * it used to carry — the panel is bounded by its column, which is the only
   * box that can hide part of the chart. `null` falls back to `100%`, still the
   * column and never the window: the column is this panel's containing block.
   */
  roomPx?: number | null;
  /**
   * How wide one day is drawn — one of {@link DAY_SCALES}.
   *
   * A prop and not this panel's own state, which is where it parts from the
   * detail switch beside it: the scale is **one plan's fit against one screen**,
   * so it is remembered per project, and the caller is the only place that
   * knows which project this is. The same bargain `heightPx` makes, for the
   * same reason.
   *
   * **Optional, defaulting to {@link DAY_PX}** — the one prop pair here that is.
   * There is exactly one production mount of this panel (`wbs-table.tsx`), so
   * a required prop would buy no compiler pressure worth having, while the
   * seventy-odd renders in `gantt-panel.test.tsx` are about bars, arrows and
   * carets and have no opinion about the zoom. A case that *does* have one says
   * so by passing a rung, which is also how it reads.
   */
  dayPx?: DayPx;
  /**
   * Says which rung the reader picked. The caller decides what remembering it
   * means — this panel draws what it is handed and stores nothing.
   *
   * Optional for `dayPx`'s reason and defaulting to a no-op. The hazard that
   * buys — a case that works the control and asserts nothing happened, and
   * passes — is real and narrow: it bites only a case that goes looking for
   * `[data-gantt-day-scale]`, and such a case is one that meant to pass a spy.
   */
  onPickDayPx?: (dayPx: DayPx) => void;
  /**
   * Whether the row-name column is drawn beside the chart.
   *
   * Remembered per project by the caller for `dayPx`'s reason and not a
   * similar one: what the column costs is **this plan's names against this
   * screen**, and a 74-day plan on a 390px phone and a fortnight on a monitor
   * want different answers. That is the same argument the scale makes, one
   * axis over.
   *
   * Optional and defaulting to shown, exactly as `dayPx` defaults to
   * {@link DAY_PX}: one production mount, seventy-odd renders here that have no
   * opinion about the column, and a case that does have one says so by passing
   * `false`.
   */
  labelsShown?: boolean;
  /**
   * Says the reader asked for the names to be shown or hidden. The caller
   * decides what remembering it means — this panel draws what it is handed.
   */
  onPickLabelsShown?: (labelsShown: boolean) => void;
  /** Takes the plan to a row — the caller decides what "takes" means. */
  onPickRow: (rowId: string) => void;
  /**
   * Says which row the pointer is on, or null when it is on none of them.
   *
   * The panel reports rather than decides, because the **pointed row** is a fact
   * about the plan and not about this drawing of it: the table lights the same
   * row from the same id, and the caller is the only place that holds both.
   *
   * Called on the pointer arriving and leaving, and on a bar taking and losing
   * the keyboard focus — the focus half because bars are controls, and a
   * hover-only answer is no answer to somebody who never touches a mouse.
   */
  onPointRow: (rowId: string | null, from: 'pointer' | 'focus') => void;
  /**
   * Where the pointed row is read from — the panel subscribes and lights the
   * row's label and a band across its row, without its caller rendering.
   *
   * A subscription rather than a resolved `string | null` prop since
   * `pointed-row-render-cost`, and the shape is the point: the pointer may be
   * on the **table**, and a prop would make every pointed change a render of
   * the component that owns the table's ~500 cells. The store's answer is
   * never resolved against the rows drawn here — an id this drawing does not
   * hold simply lights nothing, which is what a row filtered out of the plan
   * should do.
   */
  pointed: PointedRows;
  /**
   * Hands the host this chart's own `.svg` downloader, and takes it back with
   * `null` when there is no chart to download.
   *
   * The Export menu offers the chart beside the four text exports, and it
   * cannot build the file itself: {@link buildStandaloneGanttSvg} nests a clone
   * of the **live** `<svg>`, which exists only while this panel is mounted. So
   * the panel lends the act rather than the toolbar reaching for the drawing —
   * and a plan whose dependencies run in a circle registers nothing at all,
   * because {@link GanttPanel} answers that with a sentence and never mounts
   * {@link GanttChart}. The menu's refusal is that `null`, spoken.
   */
  registerSvgDownload?: (download: (() => void) | null) => void;
  /**
   * This project's calendar markers, in the total order be-01 answers them in
   * (`date`, then `createdAt`, then `id`).
   *
   * **Non-scheduling overlays**: nothing here reaches {@link layOutGantt} or
   * moves a bar, which is the whole of what task 5 asserts on the other side of
   * the wire. A marker is drawn over the calendar the schedule already decided.
   *
   * Optional, defaulting to {@link NO_MARKERS}, for {@link GanttProps.dayPx}'s
   * reason — and required inside {@link GanttChart}, so the default is decided
   * once and cannot disagree with itself.
   */
  markers?: readonly CalendarMarkerView[];
  /**
   * A marker on this chart has been given a new name.
   *
   * Reported upward rather than written here, which is the same rule
   * {@link GanttProps.onPickRow} and every other write on this panel follows:
   * the list it draws arrives as {@link GanttProps.markers}, so the owner of
   * that list is the only place a write and the redraw that follows it can
   * agree. A panel that called `renameCalendarMarker` itself would leave the
   * markers it is drawing stale until somebody above it happened to read them
   * again — or would have to keep a second copy, which is two sources of truth
   * for one list.
   *
   * Rename and recolour stay **two** reports for `ProjectApi`'s reason: be-01
   * refuses a `PATCH` body naming both, so a single edit callback here would be
   * a surface whose two-field call can only ever be refused.
   *
   * The name arrives trimmed and is not otherwise checked. What a name may be
   * is be-01's rule (4.2's refusal table) and a second copy of it on this side
   * would be free to disagree with it.
   *
   * Optional, defaulting to a no-op, for {@link GanttProps.dayPx}'s reason: the
   * seventy-odd renders in `gantt-panel.test.tsx` are about bars, arrows and
   * carets and have no markers to rename.
   */
  onRenameMarker?: (markerId: string, name: string) => void;
  /**
   * A marker on this chart has been given a new fill.
   *
   * Reported upward for {@link GanttProps.onRenameMarker}'s reason, and a
   * second callback beside it rather than one edit for the same one: be-01
   * refuses a `PATCH` body naming both a name and a colour.
   *
   * `string` and not `string | null`, because this surface offers the eight
   * {@link PALETTE} fills and nothing else — a marker cannot be handed back to
   * the automatic colour from here yet. `recolorCalendarMarker` takes the
   * `null`; the day the sheet grows an Automatic entry this widens to match it,
   * and until then an arm nothing can reach would be a branch no test could
   * fail.
   */
  onRecolorMarker?: (markerId: string, color: string) => void;
  /**
   * A marker on this chart has been taken off it.
   *
   * Reported upward for {@link GanttProps.onRenameMarker}'s reason. No
   * confirmation step in front of it: `undo` covers the whole plan and a
   * marker moves nothing in the schedule (task 4, axis-1), so the cost of the
   * mistake is one row retyped — and a dialog in front of every delete is the
   * affordance readers learn to click through.
   */
  onDeleteMarker?: (markerId: string) => void;
}

/**
 * How long the pointer has to rest on a bar before its surface opens, in ms.
 *
 * The one delay in this application's hover cards — the table's open with none
 * (`instant-hovers`) — and it is here because the marks are 28px apart on a
 * chart a reader crosses to get anywhere. A pointer travelling over eight bars
 * would otherwise open eight surfaces on its way to the ninth.
 *
 * The keyboard has no delay: focus is deliberate and there is no crossing.
 */
const HOVER_OPEN_MS = 220;

/** The surface that is open: whose bar it belongs to, and the rectangle it was placed against. */
interface OpenSurface {
  sliceId: string;
  anchor: AnchorRect;
}

/**
 * The chart itself — every hook this panel has, and the drawing.
 *
 * Separate from {@link GanttPanel} for the cycle answer's sake alone; see
 * there.
 */
function GanttChart({
  plan,
  startDate,
  generation,
  heightPx,
  roomPx,
  dayPx,
  onPickDayPx,
  labelsShown,
  onPickLabelsShown,
  onPickRow,
  onPointRow,
  pointed,
  registerSvgDownload,
  markers,
  onRenameMarker,
  onRecolorMarker,
  onDeleteMarker,
}: Omit<
  GanttProps,
  | 'scheduleError'
  | 'dayPx'
  | 'onPickDayPx'
  | 'labelsShown'
  | 'onPickLabelsShown'
  | 'markers'
  | 'onRenameMarker'
  | 'onRecolorMarker'
  | 'onDeleteMarker'
> & {
  dayPx: DayPx;
  onPickDayPx: (dayPx: DayPx) => void;
  labelsShown: boolean;
  onPickLabelsShown: (labelsShown: boolean) => void;
  registerSvgDownload: (download: (() => void) | null) => void;
  markers: readonly CalendarMarkerView[];
  onRenameMarker: (markerId: string, name: string) => void;
  onRecolorMarker: (markerId: string, color: string) => void;
  onDeleteMarker: (markerId: string) => void;
}) {
  // How far the chart is scrolled, in CSS pixels. Held only so the caption can
  // name the month actually on screen.
  const [scrolledPx, setScrolledPx] = useState(0);
  /**
   * The panel's own scroll box, so what is below its bottom edge can be
   * measured off the boxes the browser really laid out.
   */
  const scrollport = useRef<HTMLElement | null>(null);
  /**
   * Whether there is chart under the panel's bottom edge — which is when the
   * fade is drawn.
   *
   * A panel shrunk by its handle scrolls, and on macOS the scrollbar that would
   * say so is an overlay one: invisible until something moves it. So a reader
   * who drags the edge down gets a chart cut through a row with nothing on
   * screen to suggest the rest is a scroll away, which is the report this state
   * exists to answer (Dany, 2026-08-29).
   */
  const [moreBelow, setMoreBelow] = useState(false);
  /**
   * How wide the chart's own content is inside the scroll box, in CSS pixels,
   * or `null` where nothing has laid it out.
   *
   * The fade is a child of the scroll box and has to cover the visible band at
   * **every** horizontal offset, so it is as wide as the widest thing that
   * scrolls under it rather than as wide as the box. A `width: 100%` cue is the
   * scrollport's width pinned at the content's left edge: scroll the calendar
   * right and the fade slides off to the left with it.
   *
   * Measured off the content row rather than off `scrollWidth`, and that is
   * load-bearing: the cue is itself in the scroll area, so a width read from
   * `scrollWidth` would be a width holding its own answer up — a chart that got
   * narrower could never make the cue narrower again.
   *
   * `null` is jsdom, which lays nothing out. The fallback where it is drawn is
   * the scrollport's own width, which is where a cue with nothing measured
   * belongs.
   */
  /**
   * The pointed row, from the store's own subscription: a pointed change
   * re-renders this chart shell and nothing above it. The label rail and the
   * band below are the only readers.
   */
  const pointedRow = useSyncExternalStore(pointed.subscribe, pointed.pointedAt);
  const [chartSpanPx, setChartSpanPx] = useState<number | null>(null);
  /**
   * Whether anything is below the fold, off one laid-out scroll box.
   *
   * The box is a parameter rather than the ref: the observer below holds the
   * element it was given for as long as it is connected, and the scroll handler
   * has it as the event's own target — so there is no nullable read here at
   * all, and no null branch that nothing could ever take.
   *
   * **Reads no rect**, which is why it is separate from {@link measureTheSpan}:
   * `scrollTop`, `scrollHeight` and `clientHeight` are what a scroll changes,
   * and this runs on **every scroll event**. It measured the content row's
   * width too until 2026-09-02 — a `getBoundingClientRect` per scroll event,
   * for a width that only a resize can change and that two `ResizeObserver`s
   * are already watching.
   */
  const measureTheFold = useCallback((port: HTMLElement): void => {
    setMoreBelow(chartBelowTheFold(port) > AT_THE_LAST_ROW_PX);
  }, []);
  /**
   * How wide the content row is, off the same box.
   *
   * On the observers' path and on mount, never on a scroll: scrolling moves the
   * content under the box and changes nothing about its width.
   *
   * @throws When the scroll box has no content row to measure. That row is the
   * one element this panel always draws inside it, so its absence is an
   * invariant broken rather than a width to default (`AGENTS.md` R5).
   */
  const measureTheSpan = useCallback((port: HTMLElement): void => {
    const row = port.firstElementChild;
    if (!(row instanceof HTMLElement)) {
      throw new Error("the chart's scroll box holds no content row to measure");
    }
    const span = row.getBoundingClientRect().width;
    setChartSpanPx(span > 0 ? span : null);
  }, []);
  /**
   * Keeps {@link moreBelow} and {@link chartSpanPx} on what is really drawn.
   *
   * Three things move the fold and each has its own event: the reader scrolls
   * (the box's own `onScroll`), the panel is resized by the height handle (the
   * observer on the box), and the chart itself grows or shrinks — a row added,
   * the names put away, a coarser scale (the observer on the content row).
   *
   * `ResizeObserver` is absent in jsdom, where every box measures 0 and there
   * is nothing to observe anyway; the fade stays off there and Chromium is the
   * oracle (`e2e/gantt.spec.ts`), as it is for the panel's room next door.
   *
   * @throws When the panel drew no scroll box, or that box no content row.
   * Both are drawn on every render of this component, so either absence is a
   * broken invariant rather than a state to skip past.
   */
  useEffect(() => {
    const port = scrollport.current;
    if (port === null) throw new Error('the chart drew no scroll box to measure');
    const row = port.firstElementChild;
    if (!(row instanceof HTMLElement)) {
      throw new Error("the chart's scroll box holds no content row to watch");
    }
    measureTheFold(port);
    measureTheSpan(port);
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      measureTheFold(port);
      measureTheSpan(port);
    });
    watch.observe(port);
    watch.observe(row);
    return () => {
      watch.disconnect();
    };
  }, [measureTheFold, measureTheSpan]);
  // Whether the chart's detail is drawn: the stored-dependency arrows, the
  // parent rows' summary brackets and the unestimated slices' assumed bars, all
  // three together. The key, the read, the state and the write are one file —
  // {@link useGanttDetail} — and what is left here is the drawing: the three
  // `detail.shown &&` gates over the marks, and the switch's own label.
  const detail = useGanttDetail(plan.dependencies.length > 0);
  const detailShown = detail.shown;
  // Whether the chart has taken the whole viewport. Chunk 4 of
  // `wbs-gantt-phone-scale`, and Dany's R8 #1 — built once, for both faces.
  //
  // **Not remembered, where the scale and the names both are.** Those two are
  // answers about how to draw a chart and are worth keeping; this one is a
  // reader standing closer for a moment. An overlay that survives a reload is
  // an app that opens covering itself, with no table, no toolbar and one small
  // button between the reader and everything they came for — and the reader who
  // would meet it is the one who closed the tab *because* they were finished.
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenRef = useRef<HTMLDivElement | null>(null);
  const fullScreenToggleRef = useRef<HTMLButtonElement | null>(null);
  const wasFullScreen = useRef(false);
  // A deliberate tap on the bar that navigates to a row leaves full screen,
  // and focus belongs on that row, not back on the Full trigger or trapped in
  // the layer. Escape and the Close/Full toggle still restore the trigger, so
  // this flag is only set by the one navigation path that must opt out.
  const leavingToRow = useRef(false);
  // Escape leaves, because a box that covers the whole app has to answer the
  // one key every reader already tries on one — and the button that opened it
  // is the only other way out, at the far end of a strip a finger may have
  // scrolled past. Bound on the document rather than the overlay: focus after
  // the click is on the toggle, but a tap on a bar moves it onto the chart, and
  // a reader who has scrolled 2000px along should not have to find a control to
  // be allowed to press Escape.
  //
  // Registered only while it is open, so the ordinary chart adds no key
  // listener at all and nothing here can swallow an Escape the hover surface
  // (`dismiss`) or a dialog above it wanted.
  useEffect(() => {
    if (!fullScreen) {
      if (wasFullScreen.current) {
        wasFullScreen.current = false;
        const leaving = leavingToRow.current;
        leavingToRow.current = false;
        if (!leaving) {
          requestAnimationFrame(() => fullScreenToggleRef.current?.focus());
        }
      }
      return undefined;
    }
    wasFullScreen.current = true;
    requestAnimationFrame(() => fullScreenToggleRef.current?.focus());
    const focusableSelector = [
      'button:not(:disabled)',
      'select:not(:disabled)',
      'input:not(:disabled)',
      'textarea:not(:disabled)',
      'a[href]',
      'iframe',
      '[contenteditable]:not([contenteditable="false"])',
      'audio[controls]',
      'video[controls]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    // The hover card and any dialog/toast are portalled above this layer
    // (`z-20` card, `z-50` modals and toasts), so they are real surfaces the
    // reader may be inside — focus that enters one must not be yanked back.
    const overlayRoles = new Set(['tooltip', 'dialog', 'alertdialog', 'alert', 'status']);
    const insideOverlay = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      for (let el: Element | null = target; el; el = el.parentElement) {
        const role = el.getAttribute('role');
        if (role !== null && overlayRoles.has(role)) return true;
      }
      return false;
    };
    const visibleFocusables = (): HTMLElement[] => {
      const layer = fullScreenRef.current;
      if (layer === null) return [];
      return [...layer.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => element.getClientRects().length > 0,
      );
    };
    const keepFocusInside = (event: FocusEvent) => {
      const layer = fullScreenRef.current;
      if (layer === null || layer.contains(event.target as Node)) return;
      // Navigation focuses the row's cell before the layer unmounts, so a
      // redirect here would yank focus back into a layer that is already
      // on its way out.
      if (leavingToRow.current) return;
      if (insideOverlay(event.target)) return;
      visibleFocusables()[0]?.focus();
    };
    const containKeys = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        setFullScreen(false);
        return;
      }
      if (key.key !== 'Tab') return;
      const layer = fullScreenRef.current;
      if (layer === null) return;
      const focusable = visibleFocusables();
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        key.preventDefault();
        layer.focus();
      } else if (key.shiftKey && document.activeElement === first) {
        key.preventDefault();
        last.focus();
      } else if (!key.shiftKey && document.activeElement === last) {
        key.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('focusin', keepFocusInside);
    document.addEventListener('keydown', containKeys);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      document.removeEventListener('keydown', containKeys);
    };
  }, [fullScreen]);
  const [open, setOpen] = useState<OpenSurface | null>(null);
  // The axis's own open card: which cell, and the rectangle it was placed
  // against. Separate from the bars' state and mutually exclusive with it —
  // each opener closes the other, so `getByRole('tooltip')` is singular.
  const [openDay, setOpenDay] = useState<{ offset: number; anchor: AnchorRect } | null>(null);
  /**
   * The calendar-marker composer's day, and it is the **date** rather than the
   * offset the cell was drawn at.
   *
   * The offset is what every other piece of axis state carries, and that is the
   * trap: past the first weekend an offset is not a workday and a workday is
   * not a calendar day, so a composer handed `offset` would have to convert,
   * and there are two wrong conversions that both look right on a plan starting
   * on a Monday. Cell 9 of the 2026-08-10 fixture is 2026-08-19, its workday is
   * 7, `addWorkdays(start, 9)` is 2026-08-21 and `addCalendarDays(start, 7)` is
   * 2026-08-17 — three different days for one cell. The cell already knows
   * which one it is, in the same `day.date` it publishes as `data-axis-date`,
   * so the answer is carried and never recomputed.
   */
  const [composerAt, setComposerAt] = useState<IsoDate | null>(null);
  /**
   * Why the cell that was just operated refuses to open a composer, or `null`
   * when nothing has been refused.
   *
   * Separate state from {@link composerAt} rather than a derived
   * `startDate === null`, because the refusal is an **answer to an action**:
   * a plan with no start date draws a whole axis of cells that cannot be
   * marked, and rendering the sentence merely because the plan is undated
   * would put a standing complaint on a chart nobody has asked anything of.
   * It is cleared on the dated branch so a refusal does not outlive the plan
   * gaining a start date and a cell then opening normally.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * The day sheet's day — the surface a **populated** cell opens, listing every
   * marker already standing on that date.
   *
   * A second piece of state beside {@link composerAt} rather than one union,
   * because the two surfaces answer different questions and 6.3's one-marker
   * case is exactly the confusion a single "the open editor" state invites: a
   * day carrying one marker opens the *list*, not that marker's editor, or the
   * second marker on that day becomes unreachable.
   */
  const [sheetAt, setSheetAt] = useState<IsoDate | null>(null);
  /**
   * Which listed marker is being renamed, or `null` while the sheet is only a
   * list.
   *
   * One id rather than a flag per row: two open name fields on one day is two
   * drafts a reader can lose track of, and the row that is not being edited has
   * nothing to remember.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /**
   * What the open name field says right now.
   *
   * Held here rather than read off the DOM at save time, because the field is
   * inside a list that repaints whenever the markers prop lands: an uncontrolled
   * input would keep its text through the repaint by accident rather than by
   * decision, and nothing would say which.
   */
  const [draftName, setDraftName] = useState('');
  /**
   * Which listed marker has its palette open, or `null` while none has.
   *
   * Separate from {@link renamingId} rather than one "open editor" union: the
   * two are different questions about the same row, and a reader who opened the
   * palette and then decided to rename should not have to close one to reach
   * the other.
   */
  const [recoloringId, setRecoloringId] = useState<string | null>(null);
  /**
   * A sheet that closes, or opens on another day, drops the draft with it.
   *
   * One effect rather than a `setRenamingId(null)` beside each of the four
   * places `sheetAt` moves: a draft that outlived its sheet would reappear on
   * the next opening, over a row the reader had not asked to edit — and the
   * fourth call site is the one that would be forgotten.
   */
  useEffect(() => {
    setRenamingId(null);
    setRecoloringId(null);
  }, [sheetAt]);
  /**
   * Escape closes the composer, which is the only way it closes at all.
   *
   * A `role="dialog"` a keyboard cannot dismiss is a trap, and this one is
   * reachable **by** keyboard as of 6.4 — Enter on an axis cell opens it — so
   * the dismissal has to be reachable the same way. On `document` rather than
   * on the dialog because nothing focuses the dialog yet: 6.3 is the slice that
   * moves focus into the name field, and until it lands a listener bound to the
   * dialog's own subtree would never receive the key.
   *
   * Bound only while the composer is open, so a chart with no composer holds no
   * document listener and no other Escape handler on the page has to compete
   * with one.
   */
  useEffect(() => {
    if (composerAt === null && sheetAt === null) return;
    const closeOnEscape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      setComposerAt(null);
      setSheetAt(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [composerAt, sheetAt]);
  /** The opening that has been asked for and not yet happened. */
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether the next click belongs to the touch pointer that pressed a bar. */
  const pressedWithTouch = useRef(false);
  /**
   * Ends a touch press on a bar, unless the click that spends it is still coming.
   *
   * `pressedWithTouch` used to be cleared in `onClick` alone, and a touch that
   * pressed a bar and was then dragged off it or cancelled never reaches one —
   * so the ref stayed set, the `onFocus` guard below went on early-returning,
   * and the next reader to *focus* a bar got no facts at all. Keyboard and
   * switch-control readers arrive by focus and by nothing else, so their only
   * recovery was a pointer event they may not have (TASK-185).
   *
   * The one thing a bar cannot know at `pointerup` is whether a click is
   * following, and clearing unconditionally there would break the tap contract
   * this guard exists for: a tap's `focus` arrives *between* its `pointerup`
   * and its `click`, and a cleared ref would let that focus open the card the
   * click is about to be asked to decide on. So the finger's last position
   * answers it — a press released **on** the bar is a tap whose click is still
   * to come and stays pressed; one released anywhere else, or cancelled
   * outright, gets no click and ends here.
   */
  const endTouchPress = useCallback((pointer: ReactPointerEvent<SVGRectElement>) => {
    if (pointer.type === 'pointercancel') {
      pressedWithTouch.current = false;
      return;
    }
    const box = pointer.currentTarget.getBoundingClientRect();
    const onTheMark =
      pointer.clientX >= box.left &&
      pointer.clientX <= box.right &&
      pointer.clientY >= box.top &&
      pointer.clientY <= box.bottom;
    if (onTheMark) return;
    pressedWithTouch.current = false;
  }, []);
  /** The live geometry `<svg>`, read by {@link downloadGanttSvg} and nothing else. */
  const chartSvgRef = useRef<SVGSVGElement | null>(null);

  const cancelOpening = useCallback(() => {
    if (opening.current !== null) clearTimeout(opening.current);
    opening.current = null;
  }, []);
  const dismiss = useCallback(() => {
    cancelOpening();
    setOpen(null);
    setOpenDay(null);
  }, [cancelOpening]);

  // Every timer this panel started, stopped when it goes: a surface opening
  // 220ms after the chart was closed is a state update on a component nobody
  // is looking at.
  useEffect(() => cancelOpening, [cancelOpening]);

  // Memoized against the one read it is a pure layout of, so a pointed-row
  // render of this shell re-draws no geometry (`pointed-row-render-cost`).
  const chart = useMemo(() => layOutGantt(plan), [plan]);

  /**
   * The two per-gesture facts the marks' **handlers** read, mirrored so the
   * marks themselves do not depend on them.
   *
   * `fullScreen` and the open card's slice id are read in `onClick`,
   * `onPointerLeave` and `onFocus` and drawn nowhere, but they were entries 15
   * and 28 of `marksOverLight`'s dependency list — so opening one bar's facts,
   * or going full screen, re-rendered **every mark in the chart**: every bar,
   * every arrow, every flag, every tick.
   *
   * `wbs-table.tsx`'s `live` ref is the pattern, and its rule holds here too:
   * anything a mark *draws* stays in the dependency list. These two are only
   * ever asked "what is true now" by a handler the reader has just fired.
   */
  const gesture = useRef({ fullScreen: false, openSliceId: undefined as string | undefined });
  gesture.current = { fullScreen, openSliceId: open?.sliceId };
  /**
   * The sentence about the waits this chart could not draw, or null where it
   * drew every one — {@link droppedLinkWords}, whose count comes from the three
   * loops that drop them rather than from a second walk of the rows here.
   */
  const droppedWords = droppedLinkWords(chart.droppedLinks);

  // The chart read has been replaced, **whether or not the anchor survived**.
  // A slice keeping its id across a refetch keeps its `<rect>` — React reuses
  // the node and nothing unmounts — so the check above cannot see this at all
  // while every number under the surface has changed. See
  // {@link GanttProps.generation}.
  useEffect(() => {
    setOpen(null);
    setOpenDay(null);
  }, [generation]);

  // At least one row of user space, so an empty plan still has a viewBox with a
  // height rather than one the browser divides by.
  const rowCount = Math.max(1, chart.labels.length);
  /** The reader's own today, which is the year {@link shortIsoDate} omits. */
  // Stable for as long as it names the same calendar day: the marks read it
  // (bar sentences, today's column), and a `new Date()` per render would churn
  // their memo below every time this shell renders for a pointed row.
  const todayIso = isoToday(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- todayIso is the day the Date is rebuilt for; the Date itself is the dependency's product, not its input.
  const today = useMemo(() => new Date(), [todayIso]);
  /**
   * The chart resolved into the unit it is drawn in, and the axis over it.
   *
   * The two are one decision made once: with a start date every mark is a
   * calendar-day offset and the axis is a calendar; without one the engine's
   * workday numbers stand as they are, no scale is built and nothing is asked
   * for a date. That is a state this panel is in, not a path it falls through.
   */
  const placed = useMemo(
    () => (startDate === null ? placeOnWorkdays(chart) : placeOnCalendar(chart, startDate)),
    [chart, startDate],
  );
  /**
   * The bars that are drawn: every placed bar with the detail asked for, and
   * the slices somebody costed alone without it.
   *
   * A slice nobody has estimated is drawn across an assumed span of two
   * workdays, translucent and dashed and carrying a `?`. On a fresh plan that is
   * most of the chart — two steps a leaf, one of them nearly always uncosted, so
   * ten rows draw twenty bars and half of them are a width nobody gave (Dany,
   * 2026-08-11: "remove … unestimated QA bars"). At rest they are not drawn, and
   * where unestimated work is found is the plan's own `?` cells, which is a
   * place that can say how many there are; a chart cannot. Asked for, they come
   * back whole — the reader who wants to see what has not been costed yet says
   * so with the one switch that says it about everything.
   *
   * One list, read by the rects, the ticks and the on-bar labels alike, so the
   * three cannot come to different answers about which bars exist.
   *
   * The narrowing is here and not in {@link layOutGantt}: `placed.horizon`
   * contains the assumed span either way, so the canvas and the axis are one
   * width in both states and the switch moves no coordinate of anything.
   *
   * Proof, both directions, watched 2026-08-12. Pinned to `placed.bars` — the
   * uncosted slice drawn at rest — `6 failed | 85 passed`: the five tests that
   * assert a mark is absent, each on `expected SVGElement{…} to be null`, and
   * `the detail switch`'s own case on `expected 1 to be +0` for the assumed
   * count. Pinned to the filtered arm — the switch drawing nothing new —
   * `7 failed | 84 passed`: four of them on {@link askForTheDetail}'s own throw,
   * `the detail switch was pressed and nothing arrived at [data-assumed]`, and
   * three on `expected +0 to be 1` / `expected undefined to be 'true'`.
   */
  const drawnBars = useMemo(
    () => (detailShown ? placed.bars : placed.bars.filter(({ bar }) => bar.estimated)),
    [detailShown, placed],
  );
  /**
   * The bar the open surface belongs to, or null when there is no surface, or
   * no such bar, or that bar is not being drawn.
   *
   * Resolved against {@link drawnBars} and not against `chart.bars`, which
   * holds every bar the plan has. Before this switch existed the two could not
   * disagree: the drawn set only ever changed on a refetch, and a refetch bumps
   * `generation`, which clears both surfaces below. Now the set changes when
   * somebody presses `Detail`, and a surface resolved off the plan would
   * outlive the mark it belongs to.
   *
   * Both self-healing paths close most of it — keyboard focus on a bar blurs on
   * the way to the switch, and a pointer must leave the rect to click it — so
   * what is left is a pointer resting on a bar while the switch is worked from
   * the **keyboard**: no blur, no pointerout, the rect unmounts, and the card
   * stays anchored by its `AnchorRect` snapshot to coordinates on a row that is
   * now empty, reciting `not estimated` facts about a bar nobody can see. Narrow,
   * and the effect below has always claimed to cover it — "or is simply no
   * longer drawn" — which was true of every set but this one. Cross-review,
   * 2026-08-12.
   *
   * It has to sit here, under `drawnBars`, rather than up beside `chart`.
   */
  /**
   * The slices and the rows that have a bar on the chart, indexed once.
   *
   * Four readers asked "is this drawn?" with a `some` or a `find` over every
   * drawn bar — the two link filters, the flag filter and `openBar` — so a plan
   * of 200 bars with 100 links cost 40,000 comparisons per re-render of the
   * chart shell, for a question a `Set` answers in one. The rows are here too,
   * because the flag filter asks by row rather than by slice: a not-before
   * holds the work item, not one of its steps.
   */
  const drawn = useMemo(() => {
    const barsByRow = new Map<number, PlacedBar[]>();
    for (const placed of drawnBars) {
      const onRow = barsByRow.get(placed.bar.rowIndex);
      if (onRow === undefined) barsByRow.set(placed.bar.rowIndex, [placed]);
      else onRow.push(placed);
    }
    return {
      sliceIds: new Set(drawnBars.map(({ bar }) => bar.sliceId)),
      rowIndexes: new Set(barsByRow.keys()),
      // The obstacles an arrow can hit, by row — see {@link arrowRoute}, which
      // asked every drawn bar per arrow until 2026-09-02.
      barsByRow,
    };
  }, [drawnBars]);
  /**
   * The rows this chart can light, by id.
   *
   * The pointed band read `chart.labels.filter((label) => label.id ===
   * pointedRow)` — a scan of every row to draw **one** rectangle, and it sits on
   * the path a pointer moves along, so it ran per row per pointer move. In the
   * memo rather than beside it because `chart.labels` is what it indexes and
   * that is what the memo is keyed on.
   */
  const labelsById = useMemo(
    () => new Map(chart.labels.map((label) => [label.id, label])),
    [chart.labels],
  );
  /**
   * The row the band is drawn on, or nothing at all.
   *
   * `undefined` is the answer for an id the chart does not hold — a row a
   * search has narrowed away or a collapse has taken — and drawing nothing is
   * what that should do, which is what the `filter` this replaced achieved by
   * finding no match.
   */
  const pointedLabel = pointedRow === null ? undefined : labelsById.get(pointedRow);
  const openBar =
    open === null || !drawn.sliceIds.has(open.sliceId)
      ? null
      : (drawnBars.find(({ bar }) => bar.sliceId === open.sliceId)?.bar ?? null);

  // The anchor has gone: its row was collapsed away, narrowed off by a search,
  // or is simply no longer drawn. A surface pointing at a mark that is not on
  // the chart is worse than none.
  useEffect(() => {
    if (open !== null && openBar === null) setOpen(null);
  }, [open, openBar]);
  /**
   * The hand-offs whose both ends are on the chart.
   *
   * A person link is drawn from one bar to another, so a link onto a slice that
   * is not drawn would run to a point on an empty row: a dashed line pointing at
   * nothing, which is worse than no line.
   *
   * Read off {@link drawnBars} and **not** gated on the switch of its own, which
   * would be a branch nothing could see: with the detail on every placed bar is
   * drawn, so this filter passes every link, and a `detailShown ? …` here would
   * have an arm no test could tell from the one beside it. The rule is about
   * what is on the chart, and the chart is what it reads.
   *
   * Proof: this filter deleted, `placed.personLinks` drawn whole. `2 failed |
   * 89 passed` — `draws no hand-off line to a slice that is not drawn` on an
   * `SVGElement` where the link to the undrawn slice is asserted null, and `the
   * detail switch`'s own case on `expected 2 to be 1` for the link count at
   * rest. Watched 2026-08-11, and again on this branch 2026-08-12.
   */
  const drawnLinks = useMemo(
    () =>
      placed.personLinks.filter(
        (link) => drawn.sliceIds.has(link.fromSliceId) && drawn.sliceIds.has(link.toSliceId),
      ),
    [drawn, placed],
  );
  /**
   * The pool waits whose both ends are on the chart — {@link drawnLinks}' rule,
   * one mark along and for the same reason: a line onto a bar that is not drawn
   * runs to a point on an empty row.
   */
  const drawnPoolWaits = useMemo(
    () =>
      placed.capacityLinks.filter(
        (link) => drawn.sliceIds.has(link.fromSliceId) && drawn.sliceIds.has(link.toSliceId),
      ),
    [drawn, placed],
  );
  /**
   * The not-before carets that have something to stand over.
   *
   * The same reasoning as {@link drawnLinks}, one mark along: the caret is
   * drawn in the clear band **above** the bar its row starts with, so on a row
   * that draws nothing — a parent, or a leaf nobody estimated — it is a
   * triangle floating over an empty track. `layOutGantt` collects the flag
   * before it asks whether the row is a leaf and before any slice is costed,
   * which is right for the geometry and wrong for the paint.
   *
   * Gated on the switch and **not** left to {@link drawnBars} alone, which is
   * where this parts from {@link drawnLinks}: a parent's row draws a bracket
   * with the detail on and never a bar, so a filter written over the bars would
   * go on hiding its caret in the one state where the row is not empty. With the
   * detail on, every row carrying a date draws something — which is the rule as
   * it stood before `gantt-declutter`.
   *
   * By **row** and not by slice: a not-before holds the work item, not one of
   * its steps, so any drawn bar on the row is a bar for the caret to sit over.
   *
   * Proof, both directions, `2 failed | 89 passed` each way and watched
   * 2026-08-12. Pinned to `placed.notBeforeFlags` — the caret back over the
   * empty row — `draws no not-before caret on a row that draws no bar until the
   * detail is asked for` on `expected SVGElement{…} to be null`, and `the detail
   * switch` on `expected 3 to be 1` at rest. Pinned to the filtered arm — the
   * switch leaving the empty rows' carets off — the same two, on `expected
   * <path …(3)><title></title></path>` not to be null and `expected 2 to be 3`.
   */
  const drawnFlags = useMemo(
    () =>
      detailShown
        ? placed.notBeforeFlags
        : placed.notBeforeFlags.filter((flag) => drawn.rowIndexes.has(flag.rowIndex)),
    [detailShown, drawn, placed],
  );
  const axis = useMemo(
    () =>
      startDate === null ? workdayAxis(placed.horizon) : calendarAxis(startDate, placed.horizon),
    [placed, startDate],
  );
  /**
   * This project's markers grouped by the day they stand on, in the order
   * `markers` arrives in — which is be-01's total order, so the sheet lists two
   * markers on one day the same way twice running.
   *
   * A map and not a filter at the call site: the axis names every dated cell
   * and the sheet lists one, and a `markers.filter(…)` in either place is a
   * scan of every marker per day drawn.
   */
  const markersByDate = useMemo(() => {
    const byDate = new Map<IsoDate, CalendarMarkerView[]>();
    for (const marker of markers) {
      const standing = byDate.get(marker.date);
      if (standing === undefined) byDate.set(marker.date, [marker]);
      else standing.push(marker);
    }
    return byDate;
  }, [markers]);
  /**
   * What operating a dated axis cell opens: the sheet when the day already
   * carries markers, the composer when it carries none.
   *
   * Shared by the click and the key handlers so the two cannot drift — 6.4's
   * Enter and Space are the same gesture as a click and have to reach the same
   * surface. Declared here rather than beside {@link sheetAt} because it reads
   * {@link markersByDate}, and a `useCallback` whose dependency array names a
   * `const` declared below it is a temporal-dead-zone throw at first render.
   */
  const operateDay = useCallback(
    (date: IsoDate) => {
      setRefusal(null);
      if ((markersByDate.get(date)?.length ?? 0) === 0) {
        setSheetAt(null);
        setComposerAt(date);
        return;
      }
      setComposerAt(null);
      setSheetAt(date);
    },
    [markersByDate],
  );
  /**
   * Puts the caret in the composer's name field the moment the composer exists.
   *
   * A callback ref rather than an effect keyed on {@link composerAt}: the field
   * is mounted by the composer opening and unmounted by it closing, so the ref
   * fires on exactly the transition an effect would have to reconstruct, and
   * there is no window in which the state says open and the input is not yet in
   * the document.
   *
   * Why at all: the cell that opened this was clicked or Entered, and a reader
   * who then has to go and find the field with a second gesture is being asked
   * to pay twice for one intention.
   */
  /**
   * The composer opening this caret has already been spent on, so a **remount**
   * cannot spend it twice.
   *
   * The date and not a boolean: moving straight from one day's composer to
   * another's is a new opening and does deserve the caret, and the date is the
   * only thing that tells the two apart from inside the ref.
   */
  const caretGivenTo = useRef<IsoDate | null>(null);
  const focusOnOpen = useCallback(
    (field: HTMLInputElement | null) => {
      if (field === null) return;
      if (caretGivenTo.current === composerAt) return;
      caretGivenTo.current = composerAt;
      field.focus();
    },
    [composerAt],
  );
  /**
   * Forgets the opening the caret was spent on, so the **same** day can open a
   * second time and be focused again.
   *
   * Closing is the only transition that can say this: the ref is handed `null`
   * both when the composer closes and when a remount detaches the field, and by
   * then the closure that receives it is the old one either way.
   */
  useEffect(() => {
    if (composerAt === null) caretGivenTo.current = null;
  }, [composerAt]);
  /**
   * Every dated cell's accessible name, by offset — the day it is and how many
   * markers stand on it ({@link axisCellName}).
   *
   * **Memoised for `marksOverLight`'s reason and proved by its tests.** These
   * names are the axis band's first {@link shortIsoDate} callers, and that
   * function is the oracle the two "re-renders no Gantt mark" cases count: a
   * name rebuilt inline in the `axis.map` below turned pointing a row from
   * zero extra calls into five, because a light moving re-renders the band and
   * would now recompute a string for every day of the horizon. Nothing here
   * depends on a gesture, so nothing here should be recomputed by one.
   *
   * The counts come off {@link markersByDate} rather than a second pass: the
   * day sheet needs the markers themselves anyway, and a count is that list's
   * length. One grouping serves both, which is what keeps the cell loop from
   * scanning `markers` per day.
   */
  const axisCellNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const day of axis) {
      if (day.date === null) continue;
      names.set(
        day.offset,
        axisCellName(day.date, markersByDate.get(day.date)?.length ?? 0, today),
      );
    }
    return names;
  }, [axis, markersByDate, today]);
  /**
   * The column today stands in, or null when today is not on this chart.
   *
   * Dany, 2026-08-19: _"on Gantt chart view I want to see the current date
   * marked"_. Off the axis, so it is on the same scale as the gridlines beside
   * it — see {@link todayOffset} for why null is the answer three different
   * ways.
   */
  const todayAt = todayOffset(axis, isoToday(today));
  // How many cells the axis holds — every whole day of the schedule. Read off
  // the axis rather than rounded again here, and deliberately **not** what the
  // canvas below is sized from: the two are computed apart so that a test can
  // ask whether they agree. An axis built from a horizon the canvas is not on
  // is two cells short of the chart under it and every label drifts right.
  const days = axis.length;
  // The band outside the schedule, in the user space's own unit: a day is
  // {@link DAY_PX} across, so this is what {@link CHART_PAD_PX} is worth in
  // them. See there for why the canvas is wider than the horizon.
  const pad = CHART_PAD_PX / dayPx;
  const chartWidth = days * dayPx + 2 * CHART_PAD_PX;
  const rowIdAt = useCallback(
    (rowIndex: number): string | undefined => chart.labels[rowIndex]?.id,
    [chart],
  );
  /**
   * Reports the row at `rowIndex` as the pointed one.
   *
   * The mark's own row rather than a `workItemId` on the mark: every mark is
   * placed on a row by {@link layOutGantt} and {@link rowIdAt} is the join the
   * click handlers already use, so a second copy of the id on every bar would
   * be a field that could disagree with where the bar is drawn.
   *
   * A `rowIndex` naming no row is not a state this can be in, for the reason
   * the click handlers give — so nothing is reported rather than a null, which
   * would clear a light some other mark had just set.
   */
  const pointRow = useCallback(
    (rowIndex: number, from: 'pointer' | 'focus'): void => {
      const rowId = rowIdAt(rowIndex);
      if (rowId !== undefined) onPointRow(rowId, from);
    },
    [onPointRow, rowIdAt],
  );
  /**
   * The first cell at least partly visible right of the sticky labels. The
   * labels overlay the scroll content's left edge, so the first chart pixel on
   * screen sits `scrolledPx` past the pad in the chart's own coordinates.
   * Clamped so an overscroll or an empty axis still names a real day.
   *
   * Proof: the caption pinned back to `axis[0]` — `names the month that is on
   * screen, not the one it started in` failed on `Unable to find an element
   * with the text: 2026-09` while the opening-month test beside it stayed
   * green. Watched, 2026-08-09.
   */
  const firstVisibleCell = Math.min(
    Math.max(0, Math.floor((scrolledPx - CHART_PAD_PX) / dayPx)),
    Math.max(0, days - 1),
  );

  /**
   * Opens a surface on one bar, against the rectangle the browser has that
   * mark at.
   *
   * The rectangle is read here and kept, rather than the element: the surface
   * is a fixed layer outside this scroll box, so a live measurement would
   * follow the bar while the card stayed where it was put. Scrolling dismisses
   * instead — see the panel's `onScroll`.
   */
  const showSurface = (sliceId: string, mark: SVGRectElement): void => {
    const box = mark.getBoundingClientRect();
    setOpenDay(null);
    setOpen({ sliceId, anchor: { left: box.left, top: box.top, bottom: box.bottom } });
  };
  const showDaySurface = (offset: number, cell: HTMLElement): void => {
    const box = cell.getBoundingClientRect();
    setOpen(null);
    setOpenDay({ offset, anchor: { left: box.left, top: box.top, bottom: box.bottom } });
  };

  /**
   * Blob and an anchor click, exactly `wbs-table.tsx`'s `downloadCsv` — the
   * only way a page saves a file it generated itself, and the same reason the
   * object URL is revoked right after the click. Nothing to refuse here: a
   * cycle draws no `<svg>` at all ({@link GanttPanel}'s early return), so
   * this branch is only ever reached with one to serialize.
   */
  const downloadGanttSvg = (): void => {
    const svgEl = chartSvgRef.current;
    if (svgEl === null) return;
    const standalone = buildStandaloneGanttSvg({
      chartSvg: svgEl,
      labels: chart.labels,
      axis,
      drawnBars,
      monthCaption: monthCaptionFor(axis, startDate),
      theme: resolvedGanttTheme(),
      // The rung this chart is on screen at, so the file is the chart as
      // drawn — which is the whole promise the download makes.
      dayPx,
    });
    const blob = new Blob([serializeStandaloneGanttSvg(standalone)], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = ganttSvgFileName(new Date());
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * The downloader as it stands **now**, so the act lent to the host is never a
   * stale closure over a chart read that has since been replaced.
   *
   * Two effects rather than one, and the split is the point: the first keeps
   * the closure current on every render and registers nothing, the second
   * registers exactly once per host and hands back `null` on the way out. One
   * effect would have to re-register whenever the chart's labels, bars or rung
   * changed — which is every read that lands — and a registration that churns
   * is a registration whose cleanup order decides what the toolbar holds.
   */
  const downloadNow = useRef(downloadGanttSvg);
  useEffect(() => {
    downloadNow.current = downloadGanttSvg;
  });
  useEffect(() => {
    registerSvgDownload(() => {
      downloadNow.current();
    });
    // Taken back on unmount, which is what makes the Export menu's refusal
    // true rather than a guess: the chart is closed, the toolbar holds
    // nothing, and it says so.
    //
    // Proof: with this cleanup emptied, `wbs-table.test.tsx`'s `refuses the
    // chart the menu has no drawing of, and says where it is` fails on
    // `expected [] to deeply equal [ Array(1) ]` — the stale downloader finds
    // `chartSvgRef.current` null, returns, and the button does nothing at all.
    // Watched 2026-08-31.
    return () => {
      registerSvgDownload(null);
    };
  }, [registerSvgDownload]);

  /**
   * The chart's marks that stand **under** the row light: the weekend columns
   * and the alternating row bands. One memo per side of the pointed band so
   * the paint order is exactly the child order it always was, and a pointed
   * change — which renders this shell through its subscription — reuses both
   * sides untouched. The band itself stays live between them: it is the one
   * mark that reads the pointed row.
   */
  const marksUnderLight = useMemo(
    () => (
      <>
        {/*
                The weekends, as columns. Drawn first and so **under** the row
                bands and every mark: this is the change's whole point on
                screen, and it is a column of the chart rather than a seam
                between two days. A plan with no start date has none — there is
                no calendar to have a Saturday on.
              */}
        {axis
          .filter((day) => day.weekend)
          .map((day) => (
            <rect
              key={`${String(day.offset)}-weekend`}
              data-gantt-weekend={day.offset}
              x={day.offset}
              y={0}
              width={1}
              height={rowCount}
              className="fill-muted-foreground/10"
            />
          ))}

        {/*
                A band behind every other row, so an eye tracking one row across
                a chart wider than the window does not land a row out. Over the
                weekend columns and under everything else, in the user space's
                own units — a row is 1.
              */}
        {chart.labels
          .filter((label) => label.rowIndex % 2 === 1)
          .map((label) => (
            <rect
              key={`${label.id}-band`}
              data-gantt-band={label.rowIndex}
              x={0}
              y={label.rowIndex}
              width={days}
              height={1}
              className="fill-muted/40"
            />
          ))}
      </>
    ),
    [axis, chart, days, rowCount],
  );
  /**
   * Every mark **over** the row light: today's column and edge, the gridlines,
   * the row lines, the brackets and ticks, the dependency and hand-off lines,
   * the not-before carets and the bars. See {@link marksUnderLight} for the
   * split; nothing here may read the pointed row, which is what the
   * render-isolation probe holds up.
   *
   * Proof: `pointedRow` added to this memo's dependencies — the marks made to
   * read the pointed row — and `pointing a row re-renders no Gantt mark`
   * failed on `expected 4 to be +0` at the marks' own counter. Watched
   * 2026-09-01.
   */
  const marksOverLight = useMemo(
    () => (
      <>
        {/*
                Today's column, tinted, under the gridlines and over the row
                bands — the reading a weekend column gets, because it is the
                same kind of fact: a property of the calendar rather than of any
                row. A **column and not a hairline**: the axis cell is a whole
                day wide, a 1px rule at its left edge would say "this instant"
                when what is known is "this day", and at the widest rung a tinted
                column is easier to find while scrolling than a line the width
                of a gridline. The line down its leading edge is what makes the
                boundary between done and not-yet legible when a bar covers the
                tint.

                Absent entirely when today is not on the chart — see
                {@link todayOffset}. There is deliberately no "today is off to
                the right" affordance at the margin: it would be a second thing
                to explain, and the caption above the labels already names the
                month on screen.
              */}
        {todayAt !== null && (
          <rect
            data-gantt-today={todayAt}
            x={todayAt}
            y={0}
            width={1}
            height={rowCount}
            className="fill-sky-500/15"
          >
            <title>Today</title>
          </rect>
        )}

        {axis.map((day) => (
          <line
            key={day.offset}
            x1={day.offset}
            y1={0}
            x2={day.offset}
            y2={rowCount}
            data-gantt-gridline={day.offset}
            // The week boundary heavier: a Monday on a calendar, and every
            // fifth workday on an axis that holds no weekends to count
            // from. See {@link WEEK_DAYS} and {@link calendarAxis}.
            className={day.heavy ? 'stroke-border' : 'stroke-border/40'}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/*
                The leading edge of today, over the gridlines and under every
                mark: it says where the past stops, and a bar drawn across it is
                work that started before today and is not finished — which is
                the sentence a reader is looking for and the reason a bar must
                stay on top of this rather than under it.

                `non-scaling-stroke` for the gridlines' reason: the user space is
                one unit per day and a stroke in it would be a day wide.
              */}
        {todayAt !== null && (
          <line
            x1={todayAt}
            y1={0}
            x2={todayAt}
            y2={rowCount}
            data-gantt-today-edge={todayAt}
            className="stroke-sky-500"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/*
                Every row's own line, as a hit surface and nothing else.

                Dany, 2026-09-01: _"when i hover over gantt chart rows they must
                also be highlighted, not only when i hover over the item on
                gantt chart"_. The chart pointed a row from a {@link
                data-gantt-bar} or a row label and from nothing else, so the
                plot area — most of a row's width, and the whole of it on a row
                nobody has estimated — pointed nothing at all. Measured in
                Chromium before this change: the pointer on a row's line past
                the end of its bar left the label rail, the band and the table
                row all dark.

                **Here in the order, and the position is the whole design.**
                After the weekend columns, the bands, today's tint and the
                gridlines — none of which is `pointer-events: none`, so a
                surface under them would be dead in stripes — and before the
                dependency links, the carets and the bars, which keep their own
                hover by standing on top of this.

                The full viewBox width rather than the horizon: the chart is
                padded either side and a reader crossing that pad is still on
                this row.

                **No `onPointerOut`.** Leaving this rect for a caret or a
                dependency link on the *same* row is not leaving the row, and
                clearing there would blink the light off under a mark the reader
                is looking straight at. What ends a chart's pointing is leaving
                the chart, which the SVG's own `onPointerLeave` says.
              */}
        {chart.labels.map((label) => (
          <rect
            key={`${label.id}-line`}
            data-gantt-row-line={label.rowIndex}
            x={-pad}
            y={label.rowIndex}
            width={placed.horizon + 2 * pad}
            height={1}
            fill="none"
            // **`fill` and not `all`, and the difference is three rows
            // wide.** `pointer-events: all` is the fill region *and the
            // stroke region*, and stroke width is inherited in user
            // units — one unit here is a whole row — so every line
            // hit-tested over its neighbours while its own
            // `getBoundingClientRect` went on reporting one row. Asked
            // in Chromium at a point squarely inside row 0,
            // `elementsFromPoint` answered
            // `rect[data-gantt-row-line=1] > rect[data-gantt-row-line=0]`
            // and the chart lit the wrong row.
            //
            // `fill` is the interior and only the interior, whatever the
            // `fill` property is painted with — which is why the rect can
            // stay unpainted and still be the row's own surface.
            pointerEvents="fill"
            onPointerOver={(pointer) => {
              // The touch seam every mark on this chart carries: a tap
              // synthesizes a whole mouse sequence, and a light set from
              // one has no departure behind it to clear it.
              if (pointer.pointerType !== 'mouse') return;
              pointRow(label.rowIndex, 'pointer');
            }}
          />
        ))}

        {/*
                A summary row's span, drawn as the **ghost of a bar**: the same
                rounded shape a leaf gets, in the page's own ink at low opacity
                and unstroked, so it reads as the projection of the rows
                beneath it rather than as work of its own. It used to be a 2px
                bracket with dropped legs, which read as a scratch (Dany,
                2026-08-09). The span is still the projection be-01 computed —
                `from`/`to` are the bracket readings `placeGantt` already
                makes, never a sum of children — and the hook keeps the
                bracket's name so the browser gate goes on measuring the same
                fact.

                **Behind the switch**, which is the whole of `declutter-one-button`
                here: the ghost restates a span its children's own bars already
                draw, and on a plan of sixty rows the restatement is most of the
                ink — so at rest a parent's row draws nothing at all. The row
                itself stays either way: `chart.labels` holds it, the label rail
                names it, and the chart's row `N` stands beside the plan's row
                `N`, which is what the browser gate measures.

                `placed.brackets` is computed in both states and feeds the
                horizon in `gantt-geometry.ts`, so the switch moves no
                coordinate of anything.

                Proof of the paint: the class made `fill-foreground` whole — a
                parent drawn as solid ink. `draws a parent as the ghost of a
                bar` alone failed, on `expected 'fill-foreground' to contain
                'fill-foreground/15'`. Watched 2026-08-09.

                Proof of the gate, both directions, `6 failed | 85 passed` each
                way and watched 2026-08-12. `detailShown &&` dropped from both
                blocks and the mark came back at rest: `leaves a zero-projection
                parent's row empty until the detail is asked for` on `expected
                <line …(7)></line> to have a length of +0 but got 1`, `draws no
                mark of its own on a parent's row until the detail is asked for`
                on the same for the `<rect>`, and four counts in `the detail
                switch` on `expected 1 to be +0`. Replaced by `false &&`, and the
                switch drew nothing: `puts the bar, the caret, the tick, the axis
                cell and the label on day 7` on `nothing on the chart at
                [data-gantt-bracket="hull"]`, three on
                {@link askForTheDetail}'s own throw, and two on `expected +0 to
                be 1`.

                Proof that the row stays: the tempting next step — a row that
                draws nothing left off the chart — injected as `rowCount` and
                the label rail taken from the rows something is drawn on.
                `7 failed | 85 passed`, `draws no mark of its own on a parent's
                row` and `leaves a zero-projection parent's row empty…` on
                `expected …(2) to have a length of 3 but got 2`, and five of
                `the chart mirrors the plan`'s cases with them on lists missing
                `010 - Hull`. Watched 2026-08-11.
              */}
        {detailShown &&
          placed.brackets
            .filter((bracket) => bracket.to > bracket.from)
            .map((bracket) => (
              <rect
                key={bracket.rowId}
                data-gantt-bracket={bracket.rowId}
                x={bracket.from}
                width={bracket.to - bracket.from}
                y={bracket.rowIndex + BAR_INSET}
                height={BAR_HEIGHT}
                rx={BAR_RADIUS_PX / dayPx}
                ry={BAR_RADIUS_PX / ROW_PX}
                className="fill-foreground/15"
              />
            ))}

        {/*
                A parent whose projection has no days — every child unestimated
                — is a modeled state, not a missing row, and a zero-width rect
                is no mark at all. The same answer the leaves give a zero-day
                slice: a tick where the branch stands. The bracket path this
                mark replaced stayed visible at zero span through its stroke,
                so the tick is what keeps that true of the ghost.

                Behind the same switch as the rect above, for the same reason
                and by the same `detailShown` — the two are one mark with two
                shapes, and a state where a branch of no days drew a tick while
                a branch of some days drew nothing would be a chart nobody
                designed.

                Proof: this block deleted, so a zero-span parent drew the
                zero-width rect above. `still marks a parent whose projection
                has no days` alone failed, `1 failed | 52 passed`, on the mark
                not being there. Watched 2026-08-09.
              */}
        {detailShown &&
          placed.brackets
            .filter((bracket) => bracket.to <= bracket.from)
            .map((bracket) => (
              <line
                key={bracket.rowId}
                data-gantt-bracket={bracket.rowId}
                x1={bracket.from}
                y1={bracket.rowIndex + BAR_INSET}
                x2={bracket.from}
                y2={bracket.rowIndex + BAR_INSET + BAR_HEIGHT}
                className="stroke-foreground/40"
                vectorEffect="non-scaling-stroke"
              />
            ))}

        {/*
                A stored dependency: an elbow that always arrives horizontally at
                the successor's left edge, and a filled head on the end of it.
                See {@link arrowRoute} — the head is a path rather than a
                `<marker>`, and the route jogs when the two bars touch.
              */}
        {/*
                Behind the switch as a whole: the elbow and the head are two
                paths of one mark, and hiding one alone leaves a floating
                triangle pointing at nothing.

                Proof: the `detailShown &&` moved onto the elbow alone. `opens
                with none of the three families, and draws all of them when
                asked` alone failed, `1 failed | 90 passed`, on `expected 1 to
                be +0` for the head count at rest. Watched 2026-08-09 as
                `arrowsShown`, and again 2026-08-12 over this gate.
              */}
        {detailShown &&
          placed.arrows.map((arrow) => {
            const route = arrowRoute(arrow, drawn.barsByRow, dayPx);
            const id = `${arrow.predecessorId}->${arrow.successorId}`;
            return (
              <g key={id}>
                <path
                  data-gantt-arrow={id}
                  d={route.elbow}
                  className="stroke-foreground fill-none [stroke-width:1.5]"
                  vectorEffect="non-scaling-stroke"
                />
                {/*
                      No `vector-effect` and no stroke: the head is filled, so
                      nothing about it is a stroke width to hold steady.
                    */}
                <path data-gantt-arrow-head={id} d={route.head} className="fill-foreground" />
              </g>
            );
          })}

        {/*
              Drawn unlike a dependency, because it is not one: nobody wrote this
              down. It is where one person's queue put a slice behind another.
            */}
        {drawnLinks.map((link) => (
          <path
            key={`${link.fromSliceId}->${link.toSliceId}`}
            data-gantt-person-link={`${link.fromSliceId}->${link.toSliceId}`}
            d={
              `M ${String(link.fromX)} ${String(link.fromRowIndex + ROW_MIDDLE)} ` +
              `L ${String(link.toX)} ${String(link.toRowIndex + ROW_MIDDLE)}`
            }
            // The person's own colour, so the line and the two bars it
            // joins read as one queue rather than as a third kind of edge.
            stroke={link.personColor}
            className="fill-none [stroke-dasharray:4_3]"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/*
                Where a team had nobody spare: the slice whose finish freed the
                slots, to the slice that was waiting for them. One line per
                wait, drawn from be-01's display referent — the hover sentence
                is what says "and N others", because a fan of lines onto one
                start is unreadable.

                A longer dash and one colour for every team, so it cannot be
                read as somebody's hand-off — see {@link CAPACITY_LINK_COLOR}.
              */}
        {drawnPoolWaits.map((link) => (
          <path
            key={`${link.fromSliceId}~>${link.toSliceId}`}
            data-gantt-capacity-link={`${link.fromSliceId}->${link.toSliceId}`}
            d={
              `M ${String(link.fromX)} ${String(link.fromRowIndex + ROW_MIDDLE)} ` +
              `L ${String(link.toX)} ${String(link.toRowIndex + ROW_MIDDLE)}`
            }
            stroke={CAPACITY_LINK_COLOR}
            className="fill-none [stroke-dasharray:8_4]"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/*
                Where a row's own start date holds it: a caret in the clear band
                above the bar, pointing at the day. Above and not on, because on
                is where it was and where nothing could see it — see
                {@link NOT_BEFORE_LENGTH_PX}. The `<title>` names the date,
                which is the one thing the mark's position cannot say. From
                {@link drawnFlags}: a row with no bar has nothing to stand over.
              */}
        {drawnFlags.map((flag) => (
          <path
            key={`${String(flag.rowIndex)}@${String(flag.workday)}`}
            data-gantt-not-before={flag.rowIndex}
            d={
              `M ${String(flag.x)} ${String(flag.rowIndex + NOT_BEFORE_CLEARANCE)} ` +
              `L ${String(flag.x + NOT_BEFORE_LENGTH_PX / dayPx)} ` +
              `${String(flag.rowIndex + BAR_INSET / 2)} ` +
              `L ${String(flag.x)} ` +
              `${String(flag.rowIndex + BAR_INSET - NOT_BEFORE_CLEARANCE)} Z`
            }
            className="fill-foreground"
          >
            {/*
                    The **workday**, not the coordinate: the caret stands where
                    the calendar puts it and says the date the row was held at,
                    and `x` is a position on a canvas rather than an index into
                    the working days.
                  */}
            <title>{notBeforeWords(startDate, flag.workday)}</title>
          </path>
        ))}

        {drawnBars.map(({ bar, x, width }) => (
          <rect
            key={bar.sliceId}
            data-gantt-bar={bar.sliceId}
            // The engine's own **workday** numbers, and the geometry
            // beside them is the calendar's: the two are allowed to
            // disagree, and the difference between them is exactly what a
            // test reads to say the conversion happened. A bar at workday
            // 5 on a Monday-start plan carries `data-start="5"` and stands
            // at `x="7"`.
            data-start={bar.start}
            data-finish={bar.finish}
            // The last workday this bar is still on, which is the axis cell
            // its right edge stops inside rather than the one it stops at.
            // See {@link lastWorkdayOf} — it is the one number about a bar
            // that cannot be read off `x` and `width` without repeating the
            // nudge, and the browser gate has to know it to say which label
            // the edge should line up with.
            data-last-day={lastWorkdayOf(bar.start, bar.finish)}
            {...(bar.critical ? { 'data-critical': 'true' } : {})}
            // The bar whose width is an assumption, findable as such. The
            // styling below is what a reader sees; this is what the
            // browser gate selects on, and it has to tell a drawn span
            // from a measured one before it measures anything. Only ever
            // in the document with the detail switch on.
            //
            // Proof: this hook dropped. `7 failed | 84 passed` —
            // four on {@link askForTheDetail}'s own throw, `the detail
            // switch was pressed and nothing arrived at [data-assumed]`,
            // and three on `expected null to be 'true'` /
            // `expected +0 to be 1`. Watched 2026-08-12.
            {...(bar.estimated ? {} : { 'data-assumed': 'true' })}
            x={x}
            // The **drawn** span in calendar days — the end reading of
            // the drawn finish less the start reading of the start, so a
            // bar working through a weekend is drawn across it and one
            // stopping on the Friday stops at the Saturday. Never a span
            // from the engine's `finish`: an unestimated slice finishes
            // where it starts, and that width is no bar at all.
            width={width}
            y={bar.rowIndex + BAR_INSET}
            height={BAR_HEIGHT}
            rx={BAR_RADIUS_PX / dayPx}
            ry={BAR_RADIUS_PX / ROW_PX}
            // Who is on it — an unestimated slice included, at 35% through
            // {@link ASSUMED_BAR_CLASSES}. It used to be hollow, which was
            // honest about the length and cost the reader the assignee;
            // now it keeps the person and says "guessed" in how it is
            // painted rather than by having no paint.
            fill={bar.personColor}
            // The critical path is the **outline**, because the fill is
            // already saying who. A ring in the foreground colour rather
            // than the destructive one: `#d62728` is the fourth person's
            // colour, and a red ring on a red bar is no ring at all.
            stroke={bar.critical ? undefined : bar.personColor}
            className={barClasses(bar.critical, bar.estimated)}
            vectorEffect="non-scaling-stroke"
            // A control, because it is one: it takes the keyboard, it has
            // a name, and Enter and Space act on it. The step is what
            // makes the `aria-label` below a name a screen reader reads —
            // a bare `<rect>` is presentational whatever it is labelled.
            role="button"
            tabIndex={0}
            // **The bar's only accessible name**, and the reason it is
            // here rather than in the `<title>` this change took off the
            // bars: two tooltips on one mark is a bug, and the browser's
            // is the one nothing can place or style. The same facts the
            // surface shows, from the same derivation.
            aria-label={barFacts(bar, startDate, today, plan.priorityBands).join('. ')}
            onPointerDown={(pointer) => {
              pressedWithTouch.current = pointer.pointerType === 'touch';
            }}
            // The three ends a touch has that are not a click, all of
            // them through {@link endTouchPress}: the release, the
            // cancellation a scroll or a system gesture takes the touch
            // away with, and the capture release that follows either.
            onPointerUp={endTouchPress}
            onPointerCancel={endTouchPress}
            onLostPointerCapture={endTouchPress}
            onClick={(click) => {
              const rowId = rowIdAt(bar.rowIndex);
              // A bar with no row is not a state this can be in — the bar
              // was placed on that row by {@link layOutGantt} — so there is
              // nothing to do about it but leave the click alone.
              const touchPress = pressedWithTouch.current;
              pressedWithTouch.current = false;
              if (gesture.current.fullScreen && touchPress) {
                cancelOpening();
                if (gesture.current.openSliceId !== bar.sliceId) {
                  showSurface(bar.sliceId, click.currentTarget);
                  return;
                }
                dismiss();
                // A deliberate second tap navigates to the row, so focus
                // belongs on its name cell after leaving full screen, not
                // back inside the layer or on the Full trigger.
                leavingToRow.current = true;
                setFullScreen(false);
              }
              if (rowId !== undefined) onPickRow(rowId);
            }}
            onKeyDown={(key) => {
              if (key.key !== 'Enter' && key.key !== ' ') return;
              // Before anything else: Space's own default is to scroll
              // the panel, and a reader who asked to go to a row and got
              // the chart scrolled out from under them is R5 #14's fault
              // wearing another hat. jsdom performs no default action, so
              // this line is guarded in a browser (`e2e/gantt.spec.ts`).
              key.preventDefault();
              const rowId = rowIdAt(bar.rowIndex);
              if (rowId !== undefined) onPickRow(rowId);
            }}
            onPointerOver={(pointer) => {
              // **The touch seam.** Chromium synthesizes a whole mouse
              // sequence from a tap — `mouseover` included — so a surface
              // opened on a mouse event opens on every tap as well, over
              // the row the tap was taking the reader to. The pointer
              // events are the only ones that say which they came from.
              if (pointer.pointerType !== 'mouse') return;
              // Before the timer and never inside it: the pointed row is
              // a tint, which is cheap to paint and cheap to be wrong
              // about for a moment, while the surface is a card that
              // covers the chart. So the light is immediate and the card
              // still waits out {@link HOVER_OPEN_MS} — a pointer
              // crossing eight bars lights eight rows in turn, which
              // reads as a trail, and opens no cards at all.
              pointRow(bar.rowIndex, 'pointer');
              const mark = pointer.currentTarget;
              cancelOpening();
              opening.current = setTimeout(() => {
                showSurface(bar.sliceId, mark);
              }, HOVER_OPEN_MS);
            }}
            onPointerOut={(pointer) => {
              // **The card, and not the light.** Leaving a bar used to
              // clear the pointed row here, which was right while a bar
              // was one of only two things on this chart that could
              // point one. Since `pointed-row-one-ink` the row's own
              // line points it, so leaving a bar is usually landing on
              // the same row — and clearing here blinked the light off
              // under the caret or the dependency link the reader had
              // moved onto, then straight back on. What clears the
              // light is leaving the drawing, which the SVG root says.
              //
              // A touch leaves the mark before its synthesized click.
              // In full screen that click owns the surface: first tap
              // opens it, and a second tap on the same bar navigates.
              if (gesture.current.fullScreen && pointer.pointerType === 'touch') return;
              dismiss();
            }}
            // No delay on the keyboard: focus is deliberate, and there is
            // no crossing of the chart to protect a reader from.
            onFocus={(focus) => {
              // A touch focuses before its click. Let that click decide
              // between opening the facts and deliberate navigation;
              // keyboard focus keeps the immediate surface below.
              if (gesture.current.fullScreen && pressedWithTouch.current) return;
              pointRow(bar.rowIndex, 'focus');
              cancelOpening();
              showSurface(bar.sliceId, focus.currentTarget);
            }}
            onBlur={() => {
              onPointRow(null, 'focus');
              dismiss();
            }}
          />
        ))}

        {/*
              The band, as a cap at the bar's left edge — the third channel, and
              the only one this mark had spare. Its colour is
              `priorityBandStyleOf`'s and nothing here decides it: the same
              function paints the Prio cell's digits, the cards' chip and names
              the export's column, which is what keeps "different priorities look
              different" one rule rather than four that agree today.

              Nothing at all for a work item nobody has prioritised, which is the
              bargain every face makes with an unranked row — and the reason this
              is a separate element rather than a property of the rect: an absent
              cap is an absent node, not a transparent one.

              After the bars in document order so it paints over the rounded
              corner, and `pointer-events: none` so it is not a second target in
              front of the control the bar is. The bar keeps the hover, the focus
              and the accessible name; this is paint.
            */}
        {drawnBars.flatMap(({ bar, x, width }) => {
          const paint = priorityBandStyleOf(plan.priorityBands, bar.priority);
          if (paint === null) return [];
          return [
            <rect
              key={`${bar.sliceId}-band`}
              data-priority-cap={bar.sliceId}
              data-priority-rank={paint.rank}
              x={x}
              y={bar.rowIndex + BAR_INSET}
              width={Math.min(PRIORITY_CAP_PX / dayPx, width)}
              height={BAR_HEIGHT}
              fill={paint.ink}
              pointerEvents="none"
            />,
          ];
        })}

        {/*
              A slice **estimated** at no days is a real answer — somebody
              costed this work at nothing — and a zero-width rect draws nothing
              at all, so the tick is where it starts and the row does not read as
              empty. Drawn from {@link drawnBars} like the rects above, so the
              slice that has no bar has no tick either.

              `drawnSpan` and not `duration`, which is what keeps the tick the
              zero-day estimate's alone: an unestimated slice's drawn span is
              {@link ASSUMED_SLICE_WORKDAYS}, so with the detail on it
              draws its own bar here and never a tick, and with the detail off it
              is not in {@link drawnBars} to draw either. Nobody estimating a
              slice is not the same answer as somebody estimating it at zero
              (`expectedDays({0,0,0})` is 0, and
              `libs/domain/src/estimate.test.ts` says so).
            */}
        {drawnBars
          .filter(({ bar }) => bar.drawnSpan === 0)
          .map(({ bar, x }) => (
            <line
              key={`${bar.sliceId}-tick`}
              x1={x}
              y1={bar.rowIndex + BAR_INSET}
              x2={x}
              y2={bar.rowIndex + BAR_INSET + BAR_HEIGHT}
              data-gantt-tick={bar.sliceId}
              stroke={bar.critical ? undefined : bar.personColor}
              className={bar.critical ? 'stroke-foreground [stroke-width:2]' : ''}
              vectorEffect="non-scaling-stroke"
            />
          ))}
      </>
    ),
    [
      axis,
      cancelOpening,
      chart,
      dayPx,
      detailShown,
      dismiss,
      // Changes exactly when `drawnBars` does — it is derived from it and
      // nothing else — so this adds no re-render. It is listed because the
      // marks read `drawn.barsByRow`, and a dependency the linter cannot see is
      // a dependency the next reader cannot either.
      drawn,
      drawnBars,
      drawnFlags,
      drawnLinks,
      drawnPoolWaits,
      endTouchPress,
      onPickRow,
      pad,
      placed,
      plan,
      onPointRow,
      pointRow,
      rowCount,
      rowIdAt,
      startDate,
      today,
      todayAt,
    ],
  );
  /**
   * The words on the bars, in HTML over the SVG — marks like the rest, split
   * out with them: {@link initialsOf} runs once per assigned bar here, which
   * is exactly what the render-isolation probe counts.
   *
   * Proof: `pointedRow` added to this memo's dependencies, and `pointing a
   * row re-renders no Gantt mark` failed on `expected 2 to be +0` at the
   * words' counter. Watched 2026-09-01.
   */
  const barWords = useMemo(
    () => (
      <>
        {/*
              Who is on each bar, written **in HTML over the SVG** and never in
              it: the user space is non-uniformly scaled and would stretch every
              glyph (design §1). The position is the same arithmetic the axis
              above makes — the engine's workday through {@link DAY_PX} — which
              is what lets a browser check that this span and the rect under it
              start at the same pixel.

              `pointer-events-none` so the label is not a hole in the bar: the
              click that takes the plan to a row belongs to the rect underneath,
              and a span on top would swallow it in its middle.
            */}
        {drawnBars.map(({ bar, x, width }) => {
          // An unestimated bar writes the `?` its width is a guess about —
          // see {@link assumedLabelFor} — and an estimated one writes who is
          // on it. The room is the **drawn** width, weekend cells included:
          // a bar stretched over a Saturday has those pixels to write in.
          // The row's own words follow either answer and are cropped by
          // the box, not the string — see {@link barText}.
          // Nobody named and a team on the row: the bar says whose people
          // are on it and how many — see {@link poolLabelFor}. Never over a
          // name: one label, and the person is the more specific fact.
          const who = bar.estimated
            ? bar.personName === null
              ? poolLabelFor(bar.team, bar.width, width, dayPx)
              : barLabelFor(bar.personName, width, dayPx)
            : assumedLabelFor(bar.personName, width, dayPx);
          const shown = barText(who, rowWords(bar.workItemNumber, bar.workItemName), width, dayPx);
          if (shown === null) return null;
          return (
            <span
              key={`${bar.sliceId}-label`}
              data-gantt-bar-label={bar.sliceId}
              aria-hidden="true"
              className={
                bar.estimated
                  ? 'pointer-events-none absolute overflow-hidden text-[9px] font-semibold text-ellipsis whitespace-nowrap'
                  : // The page's own ink on an assumed bar: `inkOn` picks a
                    // colour to be read on a **solid** fill, and this one is
                    // 35% of that colour over whatever the page is.
                    'text-foreground pointer-events-none absolute overflow-hidden text-[9px] font-semibold text-ellipsis whitespace-nowrap'
              }
              style={{
                // Dark ink on the three light entries of the palette and
                // white on the other seven, never one white for all ten.
                // See {@link inkOn}.
                ...(bar.estimated ? { color: inkOn(bar.personColor) } : {}),
                // Over the SVG, which now begins one band left of the
                // schedule: the label's pixel is the bar's pixel only with
                // the same band added. See {@link CHART_PAD_PX}.
                left: x * dayPx + CHART_PAD_PX,
                top: (bar.rowIndex + BAR_INSET) * ROW_PX,
                width: width * dayPx,
                height: BAR_HEIGHT * ROW_PX,
                lineHeight: `${String(BAR_HEIGHT * ROW_PX)}px`,
                paddingLeft: LABEL_PAD_PX,
                paddingRight: LABEL_PAD_PX,
              }}
            >
              {shown}
            </span>
          );
        })}
      </>
    ),
    [dayPx, drawnBars],
  );

  const chartAndItsControls = (
    <>
      <section
        ref={scrollport}
        data-gantt-panel
        aria-label="Gantt chart"
        // Its own scroll area, in both directions: the plan above keeps its frame
        // and this takes a bounded share of what is left, so neither the page nor
        // the section it sits in ever scrolls sideways. A max height rather than
        // a flex basis — the table stays the editor and the chart takes what it
        // needs up to the cap. A dragged height replaces the bounded share with
        // its own number, under {@link roomPx} — the column's own room, measured.
        //
        // **`shrink-0` stays, and `gantt-height-column-clamp` asked for it to
        // go.** The reasoning it was asked on is that a flex item with an
        // explicit height and no give leaves an over-constrained column nothing
        // to do but overflow — true, and it is what drew 245px of chart off the
        // bottom of a window nothing scrolls (Chrome, 2026-08-29). But the
        // browser resolves an over-constraint by *sharing* it out across every
        // shrinkable item in proportion to `shrink × flex-basis`, and this
        // column's other shrinkable item is the table frame, whose basis is its
        // whole content. At the very height this clamp exists to allow — the
        // column's room, where the frame must come down to its 20rem floor —
        // the two would split that deficit and the chart would settle *shorter
        // than the reader dragged it*, by its share. On the 2026-08-29 numbers:
        // a 126px deficit split 446:512 leaves the panel at 444.7 where 512 was
        // asked for. A chart that quietly ignores 67px of a gesture is its own
        // bug, and it would land on every maximal drag rather than on the
        // stale-column edge case the give-way was wanted for.
        //
        // So containment is the clamp's alone: {@link appliedGanttHeight} and
        // the `max-height` below, both off one measured room. **Reasoned, not
        // measured** — the flex resolution above was worked out from the spec
        // and never watched in a browser, which is exactly what makes it the
        // first thing to check when this is next opened in Chromium.
        //
        // Proof that this class is doing something: with it dropped, `does not
        // split an over-constraint with the table frame` failed on `expected
        // false to be true`. That is the class and not the layout — jsdom
        // measures every box at 0 — and the layout half is a browser's.
        // Watched 2026-08-29.
        //
        // `isolate` is what keeps the chart's own layering inside the chart. The
        // sticky label column, its corner and the calendar axis stack against
        // each other at `z-10`/`z-20`, and `overflow` makes no stacking context
        // to hold them: without this they stack against the page, and the height
        // handle sitting over this box at `z-index: 1` loses every pixel the
        // chart's content reaches — the strip is unpressable exactly where there
        // is a chart to resize.
        //
        // The invariant is a pair, and this keyword is only half of it: the
        // section makes the stacking context, and the handle's own `z-index: 1`
        // (`wbs-table.tsx`, on the 6px grab strip) paints above it. Either half
        // alone is not enough.
        //
        // Proof: two faults, each injected on its own — `isolate` deleted from
        // this class list, and `zIndex: 1` deleted from the handle. Both turned
        // `e2e/gantt.spec.ts`'s `owns every point on its strip, rather than the
        // chart sliding under it` red the same way: all 18 sampled points across
        // the strip came back as the chart's own boxes (15 × `div in the chart`,
        // 3 × `span in the chart`) instead of the handle. Watched in Chromium
        // 2026-08-12.
        //
        // **Full screen takes both the share and the dragged height away**, and
        // that is the whole mechanism: `flex-1` inside the overlay's column, with
        // `min-h-0` so a chart taller than the phone scrolls inside this box
        // instead of pushing the control strip off the bottom of the screen (a
        // flex item's default `min-height: auto` refuses to shrink below its
        // content, and the strip is the item after it). `heightPx` is ignored
        // rather than raised: it is a number dragged against a page that is not
        // on screen, and the handle that set it is behind the overlay.
        className={cn(
          'border-border isolate overflow-auto border-t',
          fullScreen ? 'min-h-0 flex-1' : 'shrink-0',
          !fullScreen && heightPx === null && 'max-h-[40vh]',
        )}
        style={
          fullScreen || heightPx === null
            ? undefined
            : {
                height: heightPx,
                // The same bound the height was already clamped to, stated to
                // the browser as well: `height` comes from a room measured on a
                // render that has been laid out, and this is what holds the
                // frame between a column changing and the observer that
                // re-measures it saying so. No floor beside it — the clamp is
                // the floor, and a `min-height` here would be a line whose
                // removal nothing could see.
                //
                // Proof: with `'80vh'` restored here, `the panel's ceiling is
                // its column, not the window` failed on `expected '80vh' to be
                // '488px'`. Watched 2026-08-29.
                maxHeight: roomPx ?? '100%',
              }
        }
        onScroll={(scrollEvent) => {
          setScrolledPx(scrollEvent.currentTarget.scrollLeft);
          // The fold moved: a reader who has scrolled to the last row is owed
          // the fade going away, and one who scrolls back up is owed it
          // returning. The event's own target is the box, so nothing here has
          // to go looking for it.
          //
          // The fold only — the content's **width** is `measureTheSpan`'s, and
          // it is not on this path: a scroll moves the content under the box
          // and changes nothing about how wide it is. This handler read a rect
          // per scroll event for it until 2026-09-02.
          measureTheFold(scrollEvent.currentTarget);
          // The surface is a fixed layer and is not in this scroll box, so the
          // bar moves out from under it and the card stays where it was put. A
          // surface pointing at the wrong bar is worse than none.
          dismiss();
        }}
      >
        <div className="flex w-max">
          {/*
            Holds the left edge while the chart scrolls under it. `sticky
            left-0` inside this scroll container, with a background of its own —
            a transparent one would have the bars painted through the names.

            **Not rendered at all when it is collapsed**, rather than drawn at
            `width: 0` or hidden: the names are `<button>`s, and a zero-width
            box full of focusable controls is a tab order that goes somewhere
            nobody can see. `hidden` would fix the focus and keep 176px of
            layout arguing with `w-max`; absent settles both, and it is what
            `layout.spec.ts` already asserts about the panel as a whole
            (`toHaveCount(0)`) when the chart is shut.
          */}
          {labelsShown && (
            <div
              data-gantt-labels
              className="bg-background border-border sticky left-0 z-10 shrink-0 border-r"
              style={{ width: LABEL_COLUMN_PX }}
            >
              {/*
                The row that lines this column's names up with the calendar
                beside them, and since chunk 2 nothing else: the caption and the
                three controls that shared it are in `[data-gantt-controls]`
                above. Kept rather than deleted, and kept **opaque** — it is one
                row of height that has to exist for the first name to sit beside
                the first cell rather than under the axis, and a transparent one
                would have the axis painted through it while the chart scrolls.
              */}
              <div
                className="border-border bg-background sticky top-0 z-20 border-b"
                style={{ height: ROW_PX }}
              />
              {chart.labels.map((label: GanttRowLabel) => (
                <button
                  key={label.id}
                  type="button"
                  data-gantt-label={label.id}
                  // Lit because this is the **pointed row**, wherever the pointer
                  // is: on this label, on a bar of its row, or on the row in the
                  // table above. The attribute is what the browser gate selects
                  // on; the tint is the class below.
                  data-gantt-label-lit={pointedRow === label.id ? 'true' : undefined}
                  // The same words the button shows, so a label the column has
                  // truncated can still be read whole on hover.
                  //
                  // Proof: the button's text put back to `label.name === '' ?
                  // '(unnamed)' : label.name` — the chart labelled by name alone.
                  // **Four** tests failed, `4 failed | 39 passed`: `leaves a
                  // collapsed branch's children off the chart`, `draws exactly the
                  // rows a search narrowed the plan to` and `draws under the steps
                  // the payload carried…` on `expected [ 'Hull', 'Sanding',
                  // 'Sealing', …(1) ] to deeply equal [ '010 - Hull', '011 -
                  // Sanding', …(2) ]`, and `takes the plan to a row when its label
                  // is clicked` on the button no longer being findable by its
                  // number. Watched, 2026-08-09.
                  data-fact={rowWords(label.number, label.name)}
                  // The house indent, so the chart's outline is the plan's outline
                  // — `hierarchyIndentFor`, the uncapped half of the pair: this
                  // rail has no declared column width to protect, so a depth-6
                  // label stands two steps deeper than a depth-4 one, where the
                  // Number cell's capped indent would draw them flush.
                  style={{ height: ROW_PX, paddingLeft: hierarchyIndentFor(label.depth) + 8 }}
                  // The lit tint after `hover:bg-accent` so it wins where both
                  // apply, which is every time the pointer is on the label
                  // itself. `data-[…]` rather than a ternary on the class string:
                  // the attribute above is already the condition, and two
                  // spellings of one condition can disagree.
                  className="hover:bg-accent block w-full truncate pr-2 text-left text-xs data-[gantt-label-lit]:bg-(--grid-dep-lit)"
                  onClick={() => {
                    onPickRow(label.id);
                  }}
                  // The label is a pointable row in its own right, which is what
                  // makes a row with **no bar** reachable: nobody has estimated
                  // it, so the chart draws nothing on its row, and this column is
                  // the only mark it has.
                  onPointerEnter={(pointer) => {
                    // The touch seam, as on the bars and on the table's rows: a
                    // tap synthesizes a mouse sequence and has no departure
                    // behind it, so a light set here would be stuck.
                    if (pointer.pointerType !== 'mouse') return;
                    onPointRow(label.id, 'pointer');
                  }}
                  onPointerLeave={(pointer) => {
                    if (pointer.pointerType !== 'mouse') return;
                    onPointRow(null, 'pointer');
                  }}
                  onFocus={() => {
                    onPointRow(label.id, 'focus');
                  }}
                  onBlur={() => {
                    onPointRow(null, 'focus');
                  }}
                >
                  {/*
                    The number as the plan writes it, then the name as the
                    reader wrote it — the fourth face of {@link InlineMarkdown},
                    and the reason the two halves are separate functions above.

                    The split is **structure, not a guard**: it is what lets the
                    tooltip say the whole sentence in its own source while the
                    button draws only half of it through the parser. Putting the
                    whole sentence through instead was tried and changes nothing
                    a test can see — a number in front of a name suppresses
                    block parsing rather than causing it — so no check here
                    claims otherwise (`gantt-panel.test.tsx`, and `AGENTS.md`'s
                    R5).
                  */}
                  {numberWords(label.number)}
                  <InlineMarkdown>{nameWords(label.name)}</InlineMarkdown>
                </button>
              ))}
            </div>
          )}

          <div className="shrink-0" style={{ width: chartWidth }}>
            {/*
            The calendar, in HTML and positioned by the same {@link DAY_PX} the
            SVG is sized by — which is what lets a browser check that a bar's
            left edge is under its own date. Inside the SVG it would be text in
            a stretched user space.
          */}
            <div
              data-gantt-axis
              // `sticky` is already a positioned box, so it is the containing
              // block the chip layer below is placed against — a `relative`
              // beside it would be a second `position` on one element and which
              // of the two won would be a question about stylesheet order.
              className="border-border bg-background sticky top-0 z-10 flex border-b"
              // The same band the SVG keeps at its left, so workday 0's cell
              // starts where the SVG's user x=0 does. Without it the whole
              // calendar sits {@link CHART_PAD_PX} left of the bars it labels.
              style={{ height: ROW_PX, paddingLeft: CHART_PAD_PX }}
            >
              {axis.map((day) => (
                <span
                  key={day.offset}
                  // Where the cell stands, which is the same number every mark
                  // under it is placed at. The workday it **is** rides beside it
                  // — a weekend cell is nobody's workday, and a bar's
                  // `data-start` is a workday, so the two attributes are how a
                  // test says the conversion happened.
                  data-axis-day={day.offset}
                  {...(day.date === null ? {} : { 'data-axis-date': day.date })}
                  {...(day.workday === null ? {} : { 'data-axis-workday': day.workday })}
                  {...(day.weekend ? { 'data-axis-weekend': 'true' } : {})}
                  // Today's cell says so, and says it in text rather than in
                  // colour alone: the tint below is a hint and `aria-current`
                  // is the fact, which is what a reader on a screen reader or a
                  // monochrome display gets. `date` and not `true` because the
                  // cell **is** the date — the value HTML defines for it.
                  {...(day.offset === todayAt ? { 'aria-current': 'date' } : {})}
                  // No native `title`: one hint, and it is the card the pointer
                  // opens below — the browser's own tooltip would race it after
                  // a delay nobody chose (`instant-hovers`' rule, and Dany's
                  // ask: knowing the month must not take a second and a half).
                  onPointerOver={(pointer) => {
                    // The bars' touch seam, on the axis: a tap synthesizes mouse
                    // events, and only the pointer events say which they came
                    // from.
                    if (pointer.pointerType !== 'mouse') return;
                    const cell = pointer.currentTarget;
                    cancelOpening();
                    opening.current = setTimeout(() => {
                      showDaySurface(day.offset, cell);
                    }, HOVER_OPEN_MS);
                  }}
                  onPointerOut={dismiss}
                  // A click opens the composer on **this cell's own date**, and
                  // the date is the one the cell already publishes rather than
                  // one derived from `day.offset` — see {@link composerAt} for
                  // the two conversions that agree with it on a Monday start
                  // and disagree past the first weekend.
                  //
                  // It does **not** dismiss the hover card: the two surfaces
                  // answer different questions about the same cell (which day
                  // is this, versus mark this day) and the pointer that clicked
                  // is by definition still over the cell that opened it.
                  onClick={() => {
                    if (day.date === null) {
                      setRefusal(UNDATED_REFUSAL);
                      return;
                    }
                    operateDay(day.date);
                  }}
                  // The control contract, and it ships **with** the click
                  // rather than after it: `jsx-a11y/click-events-have-key-events`
                  // and `no-static-element-interactions` both refuse a `<span>`
                  // that grew an `onClick` and nothing else, so 6.1 cannot land
                  // without this much of 6.4. Only this much — 6.4's seven
                  // cases and 6.4a's undated ones are still owed, and both
                  // slices stay unticked until they exist.
                  //
                  // Space is `preventDefault`ed because its default on a
                  // focusable element is to scroll the page, which on an axis
                  // inside a horizontal scroll box is the one thing a reader
                  // operating it by keyboard would notice.
                  //
                  // `aria-expanded` is the **transition** and not the
                  // attribute: it is `composerAt === day.date`, so the cell
                  // that opened the composer says `true` and every other dated
                  // cell on the axis says `false` at the same moment. A value
                  // hard-coded either way would satisfy a single-state
                  // assertion, and one derived from `composerAt !== null`
                  // would announce the whole row as open.
                  role="button"
                  tabIndex={0}
                  {...(day.date === null
                    ? {
                        'aria-disabled': true,
                        // **Not a generic name.** §6's argument for giving
                        // these cells a tab stop at all is that a row of stops
                        // announced "button" and nothing else is worse than no
                        // stop, so a cell that cannot be marked has to say
                        // which cell it is and why — the workday it stands at,
                        // and the project start date that is missing. That is
                        // 6.4a's own contract and two Sol rounds found it
                        // unasserted, not merely unimplemented.
                        //
                        // The `null` arm is the shared type's, not this axis's:
                        // an undated cell is drawn only by `workdayAxis`, which
                        // sets `workday` on every cell it makes. It is
                        // `calendarAxis` that has workdayless cells, and those
                        // are weekends — which always carry a date and so never
                        // reach this branch.
                        'aria-label':
                          day.workday === null
                            ? 'No project start date'
                            : `Workday ${String(day.workday)}, no project start date`,
                      }
                    : {
                        'aria-haspopup': 'dialog' as const,
                        // Either surface counts as open, because a populated
                        // cell opens the sheet and an empty one the composer —
                        // an `aria-expanded` naming only the composer would say
                        // `false` on exactly the cells that just opened
                        // something.
                        'aria-expanded': composerAt === day.date || sheetAt === day.date,
                        'aria-label': axisCellNames.get(day.offset),
                      })}
                  onKeyDown={(key) => {
                    if (key.key !== 'Enter' && key.key !== ' ') return;
                    key.preventDefault();
                    if (day.date === null) {
                      setRefusal(UNDATED_REFUSAL);
                      return;
                    }
                    operateDay(day.date);
                  }}
                  // The first day of each week reads as the heading it is, over
                  // the heavier gridline under it; a weekend cell is greyed back,
                  // like the column beneath it.
                  className={[
                    'shrink-0 text-center text-[10px] leading-7',
                    day.heavy ? 'text-foreground font-semibold' : 'text-muted-foreground',
                    day.weekend ? 'bg-muted-foreground/10' : '',
                    // Today's number, in the same ink as the rule under it, and
                    // bold whether or not it is a Monday — a reader scanning for
                    // where they are should not have to find a week boundary
                    // first.
                    day.offset === todayAt ? 'font-semibold text-sky-600' : '',
                  ]
                    .filter((part) => part !== '')
                    .join(' ')}
                  style={{ width: dayPx }}
                >
                  {axisNumberShown(day, dayPx)}
                </span>
              ))}
              {/*
              The chips, in one layer over the cells rather than inside them.

              **Placed by {@link axisOffsetOf} and by nothing else**, which is
              the whole of task 8.1. A chip drawn inside its cell's `<span>`
              would be at the right x by construction and could never be wrong,
              and the fault this slice exists to catch is exactly the one that
              looks right: a marker placed at its **workday** number instead of
              its calendar offset. Those two numbers agree until the first
              weekend and drift by a day per weekend after it — the drift
              `gantt-calendar-axis` was built to end — so a chart that placed
              chips workday-wise would look correct on week one and be a day
              early on week three.

              Its own {@link CHART_PAD_PX} offset, for the band's reason: `left`
              on an absolutely positioned child is measured from the containing
              block's **padding** edge, so the band's own `paddingLeft` does not
              move it and the pad has to be spent again here. Spending it on the
              layer rather than on each chip is what keeps a chip's own `left`
              the plain calendar x a test can read.

              `pointer-events-none`: the cell underneath is the control — it
              carries the click that opens the composer and the hover that opens
              the day card — and a chip lying across it would eat both on
              exactly the days that have something to say. What a chip does when
              it is pointed at is task 8.4's, and it will need this line
              revisited rather than kept.

              Overflow is **not** here: `MARKER_BAND_MAX_PER_CELL` and the `+N`
              collapse are task 8.4, and until they land two markers on one date
              draw two chips at one x.
            */}
              <div
                data-gantt-marker-band
                className="pointer-events-none absolute inset-y-0"
                style={{ left: CHART_PAD_PX }}
              >
                {markers.map((marker) => {
                  const offset = axisOffsetOf(axis, marker.date);
                  // A marker off the drawn horizon draws nothing — the axis has
                  // no cell to stand it on, and inventing one would put it at
                  // the edge as if it were on the last day. Task 8.5 is the case
                  // that says so; this arm is what lets it pass silently rather
                  // than at `NaN` pixels.
                  if (offset === null) return null;
                  const fill = markerFill(marker);
                  return (
                    <span
                      key={marker.id}
                      data-marker-chip={marker.id}
                      // The x it was placed at, published beside the pixels: the
                      // `left` below is `offset * dayPx` and a test that read
                      // only the pixels would be reading the zoom rung as much
                      // as the placement.
                      data-marker-offset={offset}
                      className="absolute bottom-0 block truncate rounded-sm px-0.5 text-[9px] leading-3"
                      style={{
                        left: offset * dayPx,
                        maxWidth: dayPx,
                        backgroundColor: fill,
                        // **Chosen, not carried.** `labelInk` is the chooser
                        // task 3.2a built and this is its only call site in the
                        // application: hard-code the ink here and 3.2a's own
                        // table stays green while every chip on the chart is
                        // painted in a colour nothing measured.
                        color: labelInk(fill),
                      }}
                    >
                      {marker.name}
                    </span>
                  );
                })}
              </div>
            </div>
            {/*
            The chart and the words on it, stacked: the SVG lays the geometry
            out and the spans below sit on top of it, positioned by the same
            {@link DAY_PX} and {@link ROW_PX} the SVG is sized by. `relative` is
            what they are absolute against.
          */}
            <div className="relative">
              <svg
                ref={chartSvgRef}
                data-gantt-chart
                // The contract, in three attributes: the user space is days by
                // rows, and the CSS size is the only place either becomes a pixel.
                // The schedule band is the **horizon** the marks were placed
                // against, so one user unit is exactly {@link DAY_PX} however
                // fractional the last day is.
                viewBox={`${String(-pad)} 0 ${String(placed.horizon + 2 * pad)} ${String(rowCount)}`}
                preserveAspectRatio="none"
                width={placed.horizon * dayPx + 2 * CHART_PAD_PX}
                height={rowCount * ROW_PX}
                style={{ display: 'block' }}
                // What ends the chart's pointing: leaving the chart. The row
                // lines below deliberately do not clear on their own departure,
                // because a caret or a dependency link on the same row is not a
                // departure from the row — so the one place that can say "the
                // pointer is no longer on any row of this chart" is the edge of
                // the drawing itself.
                //
                // Proof: this handler removed, `clears when the pointer leaves
                // the chart` watched failing on `expected [ '030' ] to deeply
                // equal []`.
                onPointerLeave={(pointer) => {
                  if (pointer.pointerType !== 'mouse') return;
                  onPointRow(null, 'pointer');
                }}
              >
                {marksUnderLight}

                {/*
                The **pointed row**, as a band across the whole chart.

                The chart's own answer to lighting a `<tr>`, and a band rather
                than anything on the bars because the two channels a bar has are
                taken: its stroke is the critical path and its fill-opacity is an
                unestimated span, so a ring or a brightness lift here would say
                something the chart already says with those. A band also answers
                on a row that has **no** bar, which a mark on the bars cannot.

                After the zebra bands, so it wins on the odd rows they cover, and
                before today's tint, the gridlines and every mark — today is
                translucent and still reads over this, and nothing the reader is
                looking at is painted over. Drawn only when a row is pointed: the
                rows are `chart.labels`, so an id this drawing does not hold finds
                no row and draws nothing, which is what a row a search has
                narrowed away should do.
              */}
                {pointedLabel === undefined ? null : (
                  <rect
                    key={`${pointedLabel.id}-pointed`}
                    data-gantt-row-lit={pointedLabel.rowIndex}
                    x={0}
                    y={pointedLabel.rowIndex}
                    width={days}
                    height={1}
                    className="fill-(--grid-dep-lit)"
                  />
                )}

                {marksOverLight}
              </svg>

              {barWords}
            </div>
          </div>
        </div>

        {/*
          The bottom edge of a panel with chart still under it, said in a way
          that does not depend on a scrollbar.

          **Why it exists.** A panel dragged short scrolls, and macOS draws an
          overlay scrollbar — nothing at all until something moves it. So the
          chart ends mid-row against a hard edge and reads as broken rather than
          as scrolled: Dany's report of 2026-08-29, measured at `height: 124`
          over a `scrollHeight` of 196.

          **Sticky, and inside the scroll box.** `bottom-0` on a zero-height box
          at the end of the content pins it to the bottom of the scrollport at
          every offset. Zero height and the fade absolutely placed above it, so
          the cue adds nothing to the scroll area it is measuring — a cue with
          height of its own would be chart below the fold in its own right, and
          the fade would never go out.

          **As wide as the chart, not as wide as the box.** {@link chartSpanPx},
          where the reasoning is; `min-w-full` is the other half of it, for the
          plans whose chart is narrower than the panel — `width` alone would
          leave the band right of a short chart unfaded.

          Above the label column (`z-10`) and its corner (`z-20`), because the
          names are cut by the same edge the bars are. The section's `isolate`
          is what keeps this contest inside the chart, exactly as it does for
          those two.

          `aria-hidden`, and it costs nothing: every row of the chart is in the
          DOM whatever the panel's height is, so a reader on a screen reader
          never met the cut this fade is about.
        */}
        {moreBelow && (
          <div
            aria-hidden="true"
            className="pointer-events-none sticky bottom-0 z-30 h-0 min-w-full"
            style={{ width: chartSpanPx ?? '100%' }}
          >
            {/*
              The painted half, and the one the attribute is on: it is the box
              with an area, so a check about the cue is a check about the band
              the reader can actually see rather than about a zero-height
              wrapper two of which would compare equal.
            */}
            <div
              data-gantt-more-below
              className="absolute inset-x-0 bottom-0"
              style={{ height: GANTT_EDGE_FADE_PX, backgroundImage: GANTT_EDGE_FADE }}
            />
          </div>
        )}

        {/*
        The one surface, and one at a time by construction: there is a single
        piece of state for it, so a second bar's opening replaces the first's
        rather than adding to it. Notes are deliberately absent — they belong
        to the Name cell's preview, which is the same {@link HoverCard} with a
        different body.
      */}
        {openBar !== null && open !== null && (
          <HoverCard label={`Facts for ${openBar.workItemNumber}`} anchor={open.anchor}>
            {barFacts(openBar, startDate, today, plan.priorityBands).map((line) => (
              <p key={line} className="text-xs">
                {line}
              </p>
            ))}
          </HoverCard>
        )}
        {/*
        The axis cell's card: the date in words, because the cell itself has
        room for two digits and the corner names only the month on screen. The
        cell is found through the axis again rather than carried in the state —
        an axis rebuilt under an open card (start date edited) answers with
        the new cell or with nothing, never with a stale date.
      */}
        {openDay !== null &&
          (() => {
            const day = axis.find((cell) => cell.offset === openDay.offset);
            if (day === undefined) return null;
            const lines = axisDayWords(day);
            return (
              <HoverCard label={lines[0] ?? 'this day'} anchor={openDay.anchor}>
                {lines.map((line) => (
                  <p key={line} className="text-xs">
                    {line}
                  </p>
                ))}
              </HoverCard>
            );
          })()}
        {/*
        The calendar-marker composer.

        It reports the day it was opened on twice over — once in words for a
        reader and once as the `YYYY-MM-DD` it will send, which is the same
        string the cell carries in `data-axis-date`. The ISO form is not
        decoration: the words are produced by {@link shortIsoDate}, so a test
        that read only them would be asserting about the formatter as much as
        about the day the composer is bound to.

        The rest of the editor — the name field's validation, the previewed
        colour, the day sheet's list of existing markers — arrives with slices
        3.5 and 6.3. What is here is what 6.1 is about: the click surface
        reaching a composer bound to the right date.
      */}
        {/*
        The refusal, drawn where the composer it stands in for would have
        opened, so a reader who clicked a cell finds the answer in the place
        they were looking.

        **Announced as well as drawn** (task 6.5). `role="status"` and not an
        alert, the same choice the filter note below makes: nothing is wrong —
        the plan simply has no start date yet — and an alert interrupts. The
        role also carries `aria-live="polite"` implicitly, so the sentence is
        not spelled twice.

        The paragraph **is** the region rather than sitting inside one: a
        wrapper that stayed mounted while its child came and went would
        announce on the child's insertion, which is the same event, and the
        extra element would be one more thing that can lose the role. Mounting
        the region with its text already in it is what the panel does
        everywhere else it says something transient.
      */}
        {refusal !== null && (
          <p
            role="status"
            data-marker-refusal
            className="border-border bg-background text-muted-foreground fixed bottom-4 left-1/2 z-30 max-w-xs -translate-x-1/2 rounded-md border p-3 text-xs shadow-md"
          >
            {refusal}
          </p>
        )}
        {composerAt !== null && (
          <div
            role="dialog"
            aria-label={`New calendar marker on ${shortIsoDate(composerAt, today)}`}
            data-marker-composer
            data-composer-date={composerAt}
            className="border-border bg-background fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-md border p-3 shadow-md"
          >
            <p className="text-xs font-semibold">{shortIsoDate(composerAt, today)}</p>
            <input
              ref={focusOnOpen}
              type="text"
              aria-label="Marker name"
              className="border-border mt-2 w-48 rounded border px-2 py-1 text-xs"
            />
          </div>
        )}
        {/*
        The day sheet — what a **populated** cell opens.

        Every marker on that date, in be-01's order, each row carrying rename,
        recolour and delete, and an Add below them. A day with exactly one
        marker gets the same list: shortcutting one marker to its own editor
        would read as helpful and make a second marker on that day unreachable,
        which is the conflict 6.3 exists to settle.

        **All three actions report a write now**, each proved by the call it
        reports as well as by the DOM the answer repaints. The names are
        per marker (`Rename Cutover`) rather than bare verbs, because a list of
        rows announcing three identical buttons apiece is a list a screen reader
        cannot navigate.
      */}
        {sheetAt !== null && (
          <div
            role="dialog"
            aria-label={`Calendar markers on ${shortIsoDate(sheetAt, today)}`}
            data-marker-sheet
            data-sheet-date={sheetAt}
            className="border-border bg-background fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-md border p-3 shadow-md"
          >
            <p className="text-xs font-semibold">{shortIsoDate(sheetAt, today)}</p>
            <ul className="mt-2 flex w-56 flex-col gap-1">
              {(markersByDate.get(sheetAt) ?? []).map((marker) => (
                <li
                  key={marker.id}
                  data-marker-row={marker.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: markerFill(marker) }}
                  />
                  {renamingId === marker.id ? (
                    <>
                      <input
                        type="text"
                        aria-label={`New name for ${marker.name}`}
                        value={draftName}
                        onChange={(event) => {
                          setDraftName(event.target.value);
                        }}
                        className="border-border grow rounded border px-1 py-0.5 text-xs"
                      />
                      <button
                        type="button"
                        aria-label={`Save the new name for ${marker.name}`}
                        // The write is a **report**, and the list this row is
                        // drawn from is the owner's: the new name arrives back
                        // through `markers`, so a handler that repainted here
                        // as well would be showing its own guess beside the
                        // answer. See {@link GanttProps.onRenameMarker}.
                        onClick={() => {
                          onRenameMarker(marker.id, draftName.trim());
                          setRenamingId(null);
                        }}
                      >
                        ✓
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="grow truncate">{marker.name}</span>
                      <button
                        type="button"
                        aria-label={`Rename ${marker.name}`}
                        // Seeded with the name it is replacing: renaming is
                        // nearly always an edit of what is there, and a field
                        // that opened empty would make the common gesture a
                        // retype.
                        onClick={() => {
                          setRenamingId(marker.id);
                          setDraftName(marker.name);
                        }}
                      >
                        ✎
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    aria-label={`Recolour ${marker.name}`}
                    aria-expanded={recoloringId === marker.id}
                    onClick={() => {
                      setRecoloringId(recoloringId === marker.id ? null : marker.id);
                    }}
                  >
                    ◑
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${marker.name}`}
                    onClick={() => {
                      onDeleteMarker(marker.id);
                    }}
                  >
                    ✕
                  </button>
                  {recoloringId === marker.id && (
                    <ul
                      data-marker-palette={marker.id}
                      className="flex w-full basis-full flex-wrap gap-1"
                    >
                      {PALETTE.map((entry) => (
                        <li key={entry.name}>
                          <button
                            type="button"
                            // The colour's name and the marker's, because eight
                            // unnamed swatches per row is eight buttons a screen
                            // reader announces identically — the same rule the
                            // three actions above follow.
                            aria-label={`${entry.name} for ${marker.name}`}
                            className="border-border size-4 rounded-sm border"
                            style={{ backgroundColor: entry.fill }}
                            onClick={() => {
                              onRecolorMarker(marker.id, entry.fill);
                              setRecoloringId(null);
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              aria-label={`Add a calendar marker on ${shortIsoDate(sheetAt, today)}`}
              className="mt-2 text-xs underline"
              // The sheet's own day, carried across rather than recomputed —
              // the same rule the cell's click follows, and here there is not
              // even an offset to be tempted by.
              //
              // The sheet **gives way** to the composer rather than stacking
              // behind it: two dialogs open on one date is two things for a
              // keyboard to be lost between, and the composer's own Escape
              // closes both states at once either way.
              onClick={() => {
                setSheetAt(null);
                setComposerAt(sheetAt);
              }}
            >
              Add
            </button>
          </div>
        )}
      </section>
      {/*
        The chart's controls, and they are **outside** the scroll box on
        purpose. Chunk 1 left them `sticky left-0 top-0` in the label column's
        corner and named the hazard it was leaving: a control living inside a
        column that can vanish is a control that can vanish with it. Chunk 2 is
        that column becoming collapsible, so this is the debt falling due.

        A sibling of the scroll box is visible at every scroll offset by
        construction — nothing to stack against, no z-index to hold, and no
        share of the `isolate` contest the section below has already lost once.
        Sticky bought the same reachability with a stacking argument that has to
        keep being won.

        It also settles the question chunk 1 handed forward unmeasured —
        whether four controls fit in 176px of corner. They no longer have to:
        this row is as wide as the panel, which on the 390px phone this task is
        about is 343px rather than 176, and that is what makes the 44px floor in
        `styles.css` affordable here at all. That floor now reaches
        `[data-gantt-controls]`, which is the fourth time this panel's controls
        have been measured under it and the first time they pass.

        **Below the chart and not above it, and CI is why.** Above, it sat
        between the height handle and the box that handle resizes, and five
        `pixels` cases said so at once — `gives the chart the screen the
        pointer asks for` and `stops at the floor` off by **93px** and **64px**,
        which is this strip's own height once its controls have wrapped to two
        lines, plus both `plan-surface.spec.ts` docking cases. The handle drags
        the panel's top edge; a 93px band welded between the two makes the grab
        point and the thing grabbed different objects. Below, the handle is
        adjacent to the panel again and every existing height assertion holds
        untouched.

        The reachability argument is unchanged — a sibling of the scroll box is
        outside it in either direction — and on a phone the controls land in
        the thumb's half of the screen rather than under the plan above.
      */}
      <div
        data-gantt-controls
        className="border-border text-muted-foreground flex flex-wrap items-center gap-1 border-t px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
      >
        <span data-gantt-month>
          {(() => {
            if (startDate === null) return 'Workday';
            // The nullish arm is the workday axis's cells, which a dated
            // plan never builds — but the index above is clamped, not
            // proven, and 'Workday' is the honest fallback either way.
            const visibleDate = axis[firstVisibleCell]?.date ?? null;
            return visibleDate === null ? 'Workday' : monthWords(visibleDate);
          })()}
        </span>
        {/*
          The label column's own switch. First control after the caption
          because it is the one that changes how much chart there is to read —
          on a 390px phone the column is 176 of 343, so collapsing it is worth
          more than any rung of the scale below 28px is.

          `aria-pressed` on "are the labels shown", not on "is the column
          collapsed": the pressed state of a control has to be the state of the
          thing it is named after, and `Names` is named after what it shows.
          Same reason `Detail` beside it is pressed when there is detail.

          It is **not** offered a third state. A rail wide enough for the row
          numbers alone was the obvious middle, and it is a worse deal than it
          looks: `hierarchyIndentFor` puts a depth-6 row's number 48px in on its
          own, so the rail that fits every number is most of the column, and one
          that clips is a column of numbers that lie about depth.
        */}
        <button
          type="button"
          data-gantt-labels-toggle
          aria-pressed={labelsShown}
          data-hint={
            labelsShown
              ? 'Hide the row names and give their 176px to the chart'
              : 'Show the row names beside the chart again'
          }
          className={labelsShown ? chartChip() : chartChip(CHART_CHIP_OFF)}
          onClick={() => {
            onPickLabelsShown(!labelsShown);
          }}
        >
          Names
        </button>
        {/*
        The detail switch. It was `sticky left-0 top-0` in the label
        column's corner until chunk 2, and it is in this strip for the
        strip's own reason above — the column it stood in can be collapsed
        away now. Reachability is unchanged and cheaper: this row is
        outside the scroll box, so a 60-row chart scrolled 2000px along
        cannot take it anywhere.
        `aria-pressed` is the state — a toggle, not two buttons.

        `Detail` and no longer `Arrows`: it draws three families of mark
        and naming one of them was a label that lied about the other two.
        Six characters — chosen when the corner was 176px wide and kept
        now that it is not, because the `title` is still where the three
        are named and a longer word here would buy nothing.
      */}
        <button
          type="button"
          data-gantt-detail-toggle
          aria-pressed={detailShown}
          data-hint={
            detailShown
              ? 'Hide the arrows, the parent bars and the unestimated slices'
              : 'Show the arrows, the parent bars and the unestimated slices'
          }
          className={detailShown ? chartChip() : chartChip(CHART_CHIP_OFF)}
          onClick={() => {
            // The next answer worked out here, beside the write, and the
            // setter given a value rather than a function: a state updater
            // React may call twice is no place for a side effect, and the
            // rendered `detailShown` is the only answer a click on this
            // switch can be flipping.
            const asked = !detailShown;
            // The write and the state together — see {@link GanttDetail.ask},
            // which is where the "remember it here and nowhere else" rule and
            // its watched proof now live.
            detail.ask(asked);
          }}
        >
          Detail
        </button>
        {/*
        The day scale. A `<select>` and not a cycling button: three rungs
        stated at once in one native control that a finger, a keyboard and
        a screen reader all already know, and a reader who wants `Days`
        back gets there in one gesture rather than two. A cycler also has
        to say what pressing it does next, which costs more words than
        naming the three.

        Chunk 1 put this in the label column's corner and wrote down that
        **chunk 2 owned what became of it** once that column could be
        collapsed away. This is that answer, and it is the strip rather
        than a narrower corner: the collapsed column is **zero** pixels
        wide, so there is no corner left to shrink into.

        `aria-label` and not a visible label: the corner has no room for
        the word `Scale` beside the value, and a select whose accessible
        name is the month caption above it would be no name at all.
      */}
        <select
          data-gantt-day-scale
          aria-label="Day scale — how wide one day is drawn"
          data-hint={`One day is ${String(dayPx)}px wide. Narrower rungs fit more of the plan on screen at once.`}
          // The chips' look without their element: `buttonVariants` is for
          // `<button>`, and a `<select>` put through it loses the platform
          // chevron this corner has no room to redraw. So the four classes the
          // bar is made of are stated here instead, and the height is the same
          // `h-4` the chips take.
          className="border-border hover:bg-accent focus-visible:ring-ring focus-visible:ring-offset-background h-4 rounded border bg-transparent px-1 text-[10px] leading-none font-semibold tracking-wide normal-case transition-colors focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-none"
          value={dayPx}
          onChange={(pick) => {
            const asked = Number(pick.currentTarget.value);
            // Checked rather than cast, though every option here is a rung
            // by construction: `value` off a DOM node is a string from the
            // page, and the same guard the storage boundary uses is the
            // one that keeps this a `DayPx` without an assertion.
            if (isDayPx(asked)) onPickDayPx(asked);
          }}
        >
          {DAY_SCALES.map((rung) => (
            <option key={rung} value={rung}>
              {DAY_SCALE_NAMES[rung]}
            </option>
          ))}
        </select>
        {/*
        The whole capability M4 owes: a standalone `.svg` of the chart
        as drawn — every bar, arrow, hand-off and colour, in a file that
        renders correctly with no app around it (`buildStandaloneGanttSvg`).
        It sits here, in the panel's own control strip, rather than beside
        **Copy as Mermaid** / **Download CSV** / **Download .md** in
        `wbs-table.tsx`'s toolbar, because this file may not touch that
        one — see the PR proposal for the control still owed there.
      */}
        {/*
        Full screen. Beside the scale rather than at the end of the strip
        because the two are one gesture on a phone — widen the rung, take the
        page padding, and the chart is as much of the plan as this screen can
        hold. `Full` / `Close` and not one word with a pressed state: the strip
        is *inside* the layer once it is open, so this button is the way out and
        has to say so. `aria-pressed` is carried as well, for the reader who
        meets it by name and not by position.

        No keyboard shortcut of its own. `f` is a character a plan full of
        `<input>`s is being typed into, and the panel has no focus of its own to
        scope one to; Escape is bound only while the layer is open, which is the
        half that costs nothing.
      */}
        <button
          ref={fullScreenToggleRef}
          type="button"
          data-gantt-fullscreen-toggle
          aria-pressed={fullScreen}
          data-hint={
            fullScreen
              ? 'Leave full screen and put the chart back under the plan (Escape)'
              : 'Draw the chart on the whole screen — the page padding is about 47px of it'
          }
          className={chartChip()}
          onClick={() => {
            setFullScreen(!fullScreen);
          }}
        >
          {fullScreen ? 'Close' : 'Full'}
        </button>
        <button
          type="button"
          data-gantt-svg-download
          aria-label="Download this chart as a standalone SVG"
          data-hint="Download this chart as a standalone .svg — every bar, arrow, hand-off and colour, openable with no app around it"
          className={chartChip()}
          onClick={downloadGanttSvg}
        >
          ⇩
        </button>
      </div>
      {/*
        What the chart did not draw, under the chart it did not draw it on.

        **Outside the scroll box on purpose.** Inside it the sentence would sit
        at the bottom of a canvas a 60-row plan scrolls, which is the one place
        a reader who has not noticed a missing arrow will never look. A `<p>` in
        the ordinary flow under the panel is on screen whenever the panel is.

        `role="status"` and not an alert: nothing is wrong. The filter is doing
        what it was asked and this is the part of the answer the drawing cannot
        carry — the same voice the `N of M rows` count beside the Find box uses.
      */}
      {plan.narrowedByFilter && droppedWords !== null && (
        <p
          data-gantt-dropped-links
          role="status"
          className="text-muted-foreground px-3 py-1 text-sm"
        >
          {droppedWords}
        </p>
      )}
    </>
  );

  /*
    Full screen, and it is **this** box rather than the browser's own.

    `Element.requestFullscreen` was the first answer and it is the wrong one for
    the reader this chunk is for: WebKit gives iOS no element fullscreen at all
    — only `HTMLVideoElement.webkitEnterFullscreen` — so on an iPhone the native
    call is a rejected promise and a button that does nothing, which is the one
    device the whole task is measured on. A fixed layer works identically on
    every browser here, and the 47px it wins back is the page padding around the
    panel, which is what the arithmetic needs: 4px/day on the panel's 343px buys
    about 79 days, and a quarter is 91.

    `z-20` and not higher, which is a real ordering and not a spare number. It
    clears the table's sticky cells (`zIndex: 10`) and stays under the toasts
    and the modals (`z-50`), so a save that fails while the chart is open is
    still on screen. It ties with the hover surface, which is `zIndex: 20`
    **portalled to `document.body`** — later in tree order than this layer, so
    the card a tapped bar opens paints over the chart it belongs to. Tested at
    the pixel rather than asserted here: `e2e/gantt.spec.ts` hit-tests the card's
    own centre in full screen, because "the card is visible" is true of a card
    painted underneath.

    `flex-col` with the panel `flex-1` above: the control strip is the last row
    and keeps its own height, so the way out is on screen whatever the chart
    does. No `body` scroll lock — the layer covers the page, the page under it
    keeps its offset, and taking `overflow: hidden` off `body` on the way out is
    a global this component would then own for every other reason it is unmounted.
  */
  return fullScreen ? (
    <div
      ref={fullScreenRef}
      data-gantt-fullscreen
      role="dialog"
      aria-modal="true"
      aria-label="Gantt chart, full screen"
      tabIndex={-1}
      className="bg-background fixed inset-0 z-20 flex flex-col"
      onPointerDownCapture={(pointer) => {
        if (pointer.pointerType !== 'touch' || open === null) return;
        const target = pointer.target;
        if (target instanceof Element) {
          const bar = target.closest('[data-gantt-bar]');
          if (bar?.getAttribute('data-gantt-bar') === open.sliceId) return;
        }
        dismiss();
      }}
    >
      {chartAndItsControls}
    </div>
  ) : (
    chartAndItsControls
  );
}
