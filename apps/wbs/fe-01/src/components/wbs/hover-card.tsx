import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The viewport rectangle of the mark a surface belongs to.
 *
 * Four numbers rather than the `DOMRect` they are read off, because that is all
 * placement needs and a `DOMRect` is a live object in a scrolling box: a card
 * holding one would be placed against wherever the mark has since moved to.
 */
export interface AnchorRect {
  left: number;
  /**
   * Its right edge, which is where a card standing **past** the mark opens.
   *
   * Added on 2026-09-10: Dany asked for every column's pop-up to stand left or
   * right of the thing it explains rather than under it, and the marks the hint
   * layer reads are in those columns too. Read by {@link diagonalPlacement},
   * which is the whole of that promise a day later — past the column *and* past
   * the row.
   */
  right: number;
  top: number;
  bottom: number;
}

/** Where a card is drawn, in viewport coordinates. */
interface Placement {
  left: number;
  top: number;
}

/** How much clear air an anchored card keeps between itself and its mark, in CSS pixels. */
const ANCHOR_GAP_PX = 6;

/** How wide a card may get, in CSS pixels. */
const CARD_MAX_WIDTH_PX = 420;

/**
 * How narrow a card explaining a cell may be, in CSS pixels.
 *
 * A floor rather than a fit, because these cards hold sentences: a card sized
 * to `Waits for 010` and then given `This work item may not start before this
 * day…` on the next row would be two different shapes in one column. A hint —
 * {@link HoverCardProps.compact} — is exempt, and is the width of its words.
 */
const CARD_MIN_WIDTH_PX = 260;

/**
 * Where a **diagonal** card is drawn: past the cross of its cell's column and
 * its own row, clamped so its own rectangle stays inside the frame.
 *
 * Dany, 2026-09-11: _"implement 'diagonal' pop-up for ALL columns including
 * PRIO, not before, deadline, end, slack; ALL of them, must have same look and
 * feel"_. Every card that opens from a **cell** has been diagonal since
 * `cards-open-diagonally`; the hint layer's card was the one that was not, and
 * the hint layer is what most of those columns' pop-up is — `data-hint` and
 * `data-fact` marks on the drag grip, the row number, Prio, Not before,
 * Deadline, End, Slack, In parallel, Service, Team, Tag and the estimate cells.
 * It stood **beside** its mark with the tops aligned, which left the column
 * clear and the row covered.
 *
 * Two promises, one per axis, and they are the two an in-cell card already makes
 * (see {@link HoverCard}): past the **column**, so the lane the pointer is
 * running down stays under the pointer, and past the **row**, so the work item's
 * own dates, estimates and dependencies stay readable beside the words that
 * explain one of them. Which side and which edge are measured rather than fixed
 * — the roomier one — so a column at the right edge of the frame answers to its
 * left, and a row at the bottom of it answers above itself.
 *
 * **No gap on either axis**, which is the half of _"same look and feel"_ that
 * lives in the arithmetic: an in-cell card hangs from `left: 100%` and from its
 * row's own bottom edge, so it touches the cross it clears, and a hint card
 * standing 6px off it would be a second look for the same pop-up.
 *
 * **Clamped rather than refused**, which is where this differs from
 * {@link besidePlacement}: a picker's card that would cover the list it explains
 * is better not shown, but a hint is a sentence about the thing under the
 * pointer and a reader who gets nothing has no way to ask again. So a frame with
 * room on neither side gets the card on the roomier side, pushed inside the
 * edge.
 *
 * Pure, for {@link surfacePlacement}'s reason: jsdom measures every box as zero.
 *
 * @param clear The cross to clear: the **cell's** horizontal band and the **row's** vertical one, in viewport coordinates.
 * @param clear.left The column's left edge — a card standing left of it ends here.
 * @param clear.right The column's right edge — a card standing right of it starts here.
 * @param clear.top The row's top edge — a card above the row ends here.
 * @param clear.bottom The row's bottom edge — a card below the row starts here.
 * @param card The card's own box.
 * @param card.width How wide it is.
 * @param card.height How tall it is.
 * @param frame The box it stays inside: the plan's scrolling frame ∩ the window.
 * @param frame.left Its left edge.
 * @param frame.right Its right edge.
 * @param frame.top Its top edge.
 * @param frame.bottom Its bottom edge.
 */
export function diagonalPlacement(
  clear: AnchorRect,
  card: { width: number; height: number },
  frame: { left: number; right: number; top: number; bottom: number },
): Placement {
  const toTheRight = frame.right - clear.right;
  const toTheLeft = clear.left - frame.left;
  const below = frame.bottom - clear.bottom;
  const above = clear.top - frame.top;
  // The **roomier** side on each axis rather than "does it fit", which is
  // {@link sidewaysPlacement}'s rule for an in-cell card and is this one's for
  // the same reason: a card that fits in 30px of room is a card 30px wide. `>=`
  // on both counts, so a tie stands right of the column and below the row —
  // where an in-cell card stands when it has the choice.
  const onTheRight = toTheRight >= card.width || toTheRight >= toTheLeft;
  const underneath = below >= card.height || below >= above;
  return {
    // Inside both edges on each axis: the `max` for a card pushed off the near
    // edge of the frame, the `min` for one that would run off the far one.
    left: Math.max(
      frame.left,
      Math.min(onTheRight ? clear.right : clear.left - card.width, frame.right - card.width),
    ),
    top: Math.max(
      frame.top,
      Math.min(underneath ? clear.bottom : clear.top - card.height, frame.bottom - card.height),
    ),
  };
}

/**
 * Where an anchored card is drawn: under its mark, flipped above it when there
 * is no room, and clamped so its **own** rectangle stays inside the viewport.
 *
 * Pure, and separated from the component for the one reason that matters here:
 * the numbers it works on come from `getBoundingClientRect`, which jsdom
 * answers with zeroes, so the arithmetic can only be asserted where it is
 * handed the measurements. The wiring — that the card really is measured, and
 * really is placed by this — is a browser fact and is asserted in
 * `e2e/gantt.spec.ts` against the card's own rectangle.
 *
 * The clamp is on `left` alone. A card is `position: fixed` and never wider
 * than the viewport (see {@link HoverCard}), so a left at or past 0 with the
 * width subtracted from the right edge puts both edges inside.
 */
export function surfacePlacement(
  anchor: AnchorRect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const below = anchor.bottom + ANCHOR_GAP_PX;
  // Above only when below does not fit, and never above the top edge: a card
  // flipped off the top of the screen is the fault it was flipped to avoid.
  const top =
    below + card.height <= viewport.height
      ? below
      : Math.max(0, anchor.top - ANCHOR_GAP_PX - card.height);
  const left = Math.max(0, Math.min(anchor.left, viewport.width - card.width));
  return { left, top };
}

/**
 * The horizontal bounds of a **list**, at the row of the option a card is
 * open for — the mark a card opens *beside* rather than under.
 *
 * Both edges, because the card may open at either: see {@link
 * besidePlacement}. The list's own rect rather than the option's, because
 * every option in a one-column list shares the list's width, and a card
 * anchored to the option lands on top of the list it is being read against.
 */
export interface BesideAnchorRect {
  left: number;
  right: number;
  top: number;
}

/**
 * Where a card opens beside a list: clear of the list's right edge, on the
 * row of the option it describes.
 *
 * Flipped to the list's **left** edge where the viewport has no room on the
 * right, and `null` — no card at all — where neither side fits. A clamp back
 * into the viewport is what this deliberately is not: a clamped card slides
 * over the list at exactly the widths where the list is hardest to read, which
 * is the fault the placement exists to fix. A card that must cover the list to
 * exist has no claim on the space.
 *
 * `top` is clamped so a card opening from the last row of a long list does not
 * hang off the bottom of the window; it is never moved horizontally to make
 * room, which is what lets the card stay still while the pointer walks the
 * list.
 *
 * Pure, and separated from the component for {@link surfacePlacement}'s
 * reason: jsdom measures every box as zero, so the arithmetic can only be
 * asserted where the measurements are handed to it. That it is really wired to
 * the listbox's own rectangle is asserted through the production call path in
 * `project-page.test.tsx`, where the card's box is stubbed for the same
 * reason.
 *
 * Proof: the flip replaced by a clamp to the viewport's right edge — `a narrow
 * window flips the card to the left of the list` failed on `expected 400 to be
 * less than 400`, the clamped card starting exactly where the list starts, and
 * `a window with room on neither side shows no card` failed on `expected <div
 * role="tooltip" …(2)>…(4)</div> to be null`. Watched 2026-08-29.
 */
export function besidePlacement(
  anchor: BesideAnchorRect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement | null {
  const top = Math.max(0, Math.min(anchor.top, viewport.height - card.height));
  const beyondRight = anchor.right + ANCHOR_GAP_PX;
  if (beyondRight + card.width <= viewport.width) return { left: beyondRight, top };
  const beforeLeft = anchor.left - ANCHOR_GAP_PX - card.width;
  return beforeLeft >= 0 ? { left: beforeLeft, top } : null;
}

/**
 * What a {@link diagonalPlacement} card is placed from: the cross it stands past
 * and the box it stays inside.
 *
 * One object rather than two props because neither half is meaningful alone — a
 * cross with no frame has nothing to be clamped into, and a frame with no cross
 * has nothing to clear — and because the owner measures both in the one pass,
 * from the one mark. See {@link HoverCardProps.diagonal}.
 */
export interface DiagonalAnchor {
  /**
   * The cell's horizontal band and the row's vertical one, in viewport
   * coordinates: `left`/`right` from the mark's `<td>`, `top`/`bottom` from its
   * `<tr>`.
   */
  clear: AnchorRect;
  /** The plan's scrolling frame ∩ the window, which the card is clamped inside. */
  frame: { left: number; right: number; top: number; bottom: number };
}

export interface HoverCardProps {
  /**
   * The mark this card opens **under**, in viewport coordinates — one of the
   * three things that make it a **fixed**, portalled card rather than an
   * absolute one.
   *
   * Left off by every card that opens from a cell: those are absolutely
   * positioned children of the cell's own wrapper and the cell's box is their
   * placement. A mark inside the Gantt's SVG has no such wrapper — the user
   * space is scaled non-uniformly and holds no HTML at all — so its card is
   * portalled to the document and placed from the rectangle the browser
   * measured. See {@link surfacePlacement}.
   *
   * A mark in a **cell** whose card is portalled all the same — the hint
   * layer's — takes {@link HoverCardProps.diagonal} instead: it has a column
   * and a row to clear, and this one has neither.
   */
  anchor?: AnchorRect;
  /**
   * The list this card opens beside, in viewport coordinates — a **fixed**,
   * portalled card like {@link HoverCardProps.anchor}, placed by {@link
   * besidePlacement} instead.
   *
   * The project picker's alone. A card that explains one option of a list is
   * read against the other options, so it opens clear of the list rather than
   * over it; every card that explains a *cell* opens under that cell, where
   * there is nothing being compared.
   *
   * Never passed together with `anchor`: they are two placements of one card.
   */
  beside?: BesideAnchorRect;
  /**
   * What the card is, for a screen reader — it names the row, because a table
   * of forty of these otherwise announces "tooltip" and nothing else.
   *
   * Left off by a card something points `aria-describedby` at, and that is not
   * a style choice: a description is computed by the accessible-name algorithm
   * over the element it names, where a label **wins over contents**. A labelled
   * card used as a description would read out its label and nothing else —
   * four words in place of the whole of what the cell folded away. Such a card
   * names itself in its first line instead, where it is both read out and on
   * screen. {@link HoverCardProps.id} is the other half of that pair.
   */
  label?: string;
  /**
   * The card's own id, so a control can point `aria-describedby` at it.
   *
   * Only where one does: a card nothing refers to needs no id, and minting one
   * anyway would suggest something reads it.
   */
  id?: string;
  /**
   * Whether this card is a **hint** rather than an explanation of a cell.
   *
   * One number's worth of difference and it is a real one: an explanatory card
   * is at least {@link CARD_MIN_WIDTH_PX} wide so a sentence about a cell does
   * not come out one word per line, and a hint on a 24px toolbar button drawn
   * to that floor is a 260px slab under a button that says "Undo". A hint takes
   * the width of its own words instead.
   *
   * {@link HintLayer} is the only caller, and passes it always.
   */
  compact?: boolean;
  /**
   * Whether this card scrolls its own content, and so has to take the wheel.
   *
   * The Name cell's preview alone. See {@link HoverCard} for why every other
   * card is pointer-transparent.
   */
  scrolls?: boolean;
  /**
   * Whether the **whole** card takes the pointer, rather than only the lines
   * inside it that ask for it.
   *
   * **A card a reader is meant to walk onto needs this, and a per-line
   * `pointer-events: auto` is not enough.** The card has 6px of its own padding
   * and gaps between its lines, and every one of those pixels is
   * pointer-transparent without this — so a cursor travelling down from the
   * cell crosses that band, hit-tests the row *beneath* the card, fires the
   * cell wrapper's `mouseleave`, and the card unmounts before the cursor ever
   * reaches a line. Dany, 2026-09-09: *"i cannot hover over the dropdown - it
   * disappears when i move cursor down to it"*.
   *
   * Measured in the running app at that moment: the card at `[88, 242, 370,
   * 56]` with `pointer-events: none` and `padding: 6px 10px`, and
   * `elementFromPoint` 1px and 4px inside its top edge both answering the next
   * row's name `<textarea>`.
   *
   * **`locator.hover()` cannot see this.** Playwright puts the pointer straight
   * on the element's centre, so it skips the band a hand has to cross — which
   * is why `e2e/external-refs.spec.ts` walks the pointer in `steps` now.
   *
   * Off by default, because {@link HoverCard}'s transparency is load-bearing
   * for every card that is only there to be read: one that takes the mouse eats
   * a click aimed at the row it hangs over.
   */
  takesPointer?: boolean;
  /**
   * The cross this card stands past, and the box it stays inside — a **fixed**,
   * portalled card like {@link HoverCardProps.anchor}, placed by
   * {@link diagonalPlacement} instead.
   *
   * The hint layer's card for a mark inside the plan's frame, which is what most
   * columns' pop-up is: `data-hint` and `data-fact` marks live on the drag grip,
   * the row number, Prio, Not before, Deadline, End, Slack, In parallel,
   * Service, Team, Tag and the estimate cells. Dany, 2026-09-11: _"implement
   * 'diagonal' pop-up for ALL columns ... ALL of them, must have same look and
   * feel"_.
   *
   * **Two rectangles, because the two axes clear two different things**: the
   * column is the mark's own `<td>` and the row is its `<tr>`, and a hint mark is
   * often a 20px glyph inside a 100px cell — placed against the glyph, the card
   * stands in the middle of the lane it was supposed to leave alone. The owner
   * measures both and hands over the cross; see `HintLayer`.
   *
   * Never passed together with `anchor` or `beside`: they are placements of one
   * card. A mark **outside** the frame — the toolbar's controls — keeps
   * `anchor`: its card covers nothing but the header, and a row of small buttons
   * whose cards jumped sideways would be worse for it. Nor the Gantt's own
   * anchored cards: a bar is as wide as the work it draws, and a card beside a
   * bar that fills the chart has nowhere to stand.
   */
  diagonal?: DiagonalAnchor;
  /**
   * Told when the pointer arrives on the card, and when it leaves again.
   *
   * The cell cannot see either: the card is its child in the DOM, so the
   * pointer moving from the cell onto the card fires no `mouseleave` there, and
   * moving off the card fires no `mouseenter` either. A cell that holds its card
   * open for a moment while the hand travels ({@link CellCards.holdHovered})
   * therefore needs the card itself to say "arrived" and "gone" — Dany,
   * 2026-09-10: *"i need it to go away when i move my mouse away from the
   * preview icon and not directly into the preview"*.
   *
   * Only a card that takes the pointer can report either. A transparent one is
   * never entered at all, and its cell's own leave is the whole of its
   * dismissal.
   */
  onPointerArrives?: () => void;
  children: ReactNode;
}

/** How much of the window's height a scrolling card may take. */
const VIEWPORT_SHARE = 0.9;

/**
 * How tall a scrolling card is where neither side of its cell has the room.
 *
 * A floor rather than a fit: a cell sitting on the fold has a few pixels either
 * way, and a card sized to those is a card with one line in it. Overflowing the
 * window by a little and scrolling inside is the readable failure.
 */
const SCROLLING_MIN_HEIGHT = 160;

/**
 * How wide the one card that leaves its own row clear may get, in CSS pixels.
 *
 * Dany, 2026-09-10: *"i need the tooltip ... to be way wider to the right"*.
 * It starts past its cell and runs right, so the room it has is the rest of the
 * plan — 1000px is a document's worth of line length and still less than that
 * room on any screen this table is read on. The measured room caps it anyway,
 * which is what keeps it inside the frame.
 */
const WIDE_CARD_WIDTH_PX = 1000;

/** Which way a card opens beside its cell, which edge it hangs from, and how tall it may be. */
export interface SidewaysPlacement {
  /** The side of the cell the card stands on. */
  side: 'left' | 'right';
  /** Whether the card hangs from the row's bottom edge or from its top. */
  align: 'top' | 'bottom';
  /**
   * How tall it may be, in CSS pixels: the room the frame has at the edge it
   * hangs from, capped at {@link VIEWPORT_SHARE} of the frame and floored at
   * {@link SCROLLING_MIN_HEIGHT}.
   *
   * Only a scrolling card reads it — every other one is as tall as its own
   * words.
   */
  maxHeight: number;
}

/**
 * Which side of its cell a card opens on, and which edge it hangs from.
 *
 * Dany, 2026-09-10, about the cards that only inform — Start, the reference
 * cells, a folded step: *"I still want to see what is up and down from it for
 * context; like, just push them to the side (left or right) ... depending on
 * where horizontally it is"*. A card beside its cell leaves that cell's whole
 * column clear, so the rows above and below it stay readable — which is the
 * thing a plan is read down.
 *
 * **The side is measured rather than fixed**, and that is the *"depending on
 * where horizontally it is"*: a card that always opened right would be cut off
 * by the frame for every column near the right edge, and a 260px card on a cell
 * 100px from the edge is not a card anybody can read. Right where the room is
 * there, otherwise the roomier side.
 *
 * `align` is the same question vertically: a card *beside* its cell hangs from
 * the cell's own top edge, so the only failure is a card taller than the room
 * below that top — a row low in the frame. Hanging it from the cell's
 * **bottom** edge instead keeps it inside, and either way it never covers its
 * own cell.
 *
 * Pure, and separated from the component for {@link surfacePlacement}'s reason:
 * the rectangles come from `getBoundingClientRect`, which jsdom answers with
 * zeroes. That a real cell is measured and really placed by this is a browser
 * fact, in `e2e/card-lanes.spec.ts`.
 *
 * @param cell The cell's wrapper, in viewport coordinates.
 * @param cell.left Its left edge — the container's left less this is the room to the left.
 * @param cell.right Its right edge — the container's right less this is the room to the right.
 * @param cell.top Its top edge, which a card hangs from where there is room below it.
 * @param cell.bottom Its bottom edge, which a card hangs from where there is not.
 * @param card The card's own box — how much room it is asking for.
 * @param card.width How wide it wants to be.
 * @param card.height How tall it is.
 * @param container The box that clips it: the window, ∩ the scrolling frame.
 * @param container.left Its left edge.
 * @param container.right Its right edge.
 * @param container.top Its top edge.
 * @param container.bottom Its bottom edge.
 */
export function sidewaysPlacement(
  cell: { left: number; right: number; top: number; bottom: number },
  card: { width: number; height: number },
  container: { left: number; right: number; top: number; bottom: number },
): SidewaysPlacement {
  const toTheRight = container.right - cell.right;
  const toTheLeft = cell.left - container.left;
  const below = container.bottom - cell.top;
  const above = cell.bottom - container.top;
  // The **roomier** side rather than "does it fit": a card that fits in 30px of
  // room is a card 30px tall, and the reader asked for the room. `>=` so a tie
  // hangs downward, which is where every card in this table hung before there
  // was a choice.
  const align = below >= above ? 'top' : 'bottom';
  return {
    // `>=` on both counts, so a tie opens right and hangs from the top, which
    // is where every card in this table opened before there was a choice.
    side: toTheRight >= card.width || toTheRight >= toTheLeft ? 'right' : 'left',
    align,
    // The room at the edge it hangs from, and never taller than the frame
    // itself: a card in a frame with 100px to give is 100px tall, whatever
    // floor a scrolling card would otherwise keep.
    maxHeight: Math.min(
      (container.bottom - container.top) * VIEWPORT_SHARE,
      Math.max(align === 'top' ? below : above, SCROLLING_MIN_HEIGHT),
    ),
  };
}

/**
 * The box a cell opens over the rows below when the mouse rests on it: the
 * whole of what the cell's at-rest face folds away.
 *
 * Placement, not content. Every card is an absolutely positioned child of the
 * cell's own `position: relative` wrapper, opening from the wrapper's bottom
 * edge — which is why the `<td>` it sits in has to be exempt from the grid's
 * `overflow: hidden` (`opensAPopover` in `wbs-table.tsx` is what exempts it;
 * the containing block is inside the clipper, so no styling here can escape
 * it).
 *
 * **A card does not take the pointer.** `pointer-events: none` is the default
 * and it is load-bearing rather than tidy: a card hangs over the row beneath
 * it, and one that takes the mouse eats a click aimed at that row — found in a
 * browser during the fix round, not reasoned about. A card is something to
 * read; the only reason to take the pointer back is content taller than the
 * card, which has to be scrollable to be readable at all, and {@link
 * HoverCardProps.scrolls} is that one exception.
 *
 * The other is {@link HoverCardProps.takesPointer}, for a card a reader is
 * meant to walk onto and click something on. Its own JSDoc has the measurement:
 * a card's 6px padding is pointer-transparent without it, so the cursor
 * hit-tests the row beneath on the way in and the card closes under the hand
 * reaching for it.
 *
 * No delay and no follow-cursor anywhere: the state that renders one is set on
 * `mouseenter` and cleared on `mouseleave`. **Every card in the plan is
 * diagonal** — past the thing it explains horizontally and past that thing's
 * row vertically — and there are two ways of being so, which is a fact about
 * where the card can be rendered rather than about how it looks:
 *
 * - A card that opens from a **cell** is an absolutely positioned child of that
 *   cell's own wrapper. It has to be: the pointer must be able to walk from the
 *   marker onto the card without leaving the cell that owns the `mouseleave`.
 *   The side and the edge come from {@link sidewaysPlacement} and the offsets
 *   are CSS — `left: 100%`, and the measured distance past the row.
 * - A card the owner **measures for it** is fixed and portalled, placed by
 *   {@link diagonalPlacement} from {@link HoverCardProps.diagonal}. The hint
 *   layer's card is this: its mark is any of ninety-odd elements across the app,
 *   so there is no wrapper for it to be a child of.
 *
 * Two placements are not diagonal, and both are outside the plan's frame:
 * {@link HoverCardProps.anchor} opens under its mark — a Gantt bar is as wide
 * as the work it draws, and a toolbar control's card covers nothing but the
 * header — and {@link HoverCardProps.beside} stands clear of a **list**.
 *
 * One more thing is measured rather than fixed: {@link HoverCardProps.scrolls}
 * — a card holding a document is as tall as the room its side of the cell has
 * ({@link SidewaysPlacement.maxHeight}), because below the cell is not where the
 * room is for a row in the lower half of the table.
 */
export function HoverCard({
  label,
  id,
  scrolls = false,
  takesPointer = false,
  compact = false,
  onPointerArrives,
  anchor,
  diagonal,
  beside,
  children,
}: HoverCardProps) {
  const card = useRef<HTMLDivElement | null>(null);
  // Placed under the mark to begin with and corrected once the card has a size,
  // which is the only moment its own width and height exist. `useLayoutEffect`
  // rather than `useEffect`, so the correction lands before the browser paints
  // and no card is ever seen off the edge it is about to be pulled back from.
  /**
   * Where an anchored card is drawn, and `left: 0` on the first frame **even
   * when it has an anchor**.
   *
   * A `position: fixed` card laid out at its mark's own left edge has only the
   * room between that edge and the window to lay out in, so a card anchored
   * near the right edge measures narrow and {@link surfacePlacement} is then
   * handed a width that has already been squeezed — there is nothing left for
   * it to clamp. Measured in Chromium: the schedule cue's fact card came out
   * 195px wide and eight lines tall from a pill at x=1405 in a 1600px window,
   * against a 420px ceiling it never got near.
   *
   * From zero it measures its own width up to that ceiling and the layout
   * effect below moves it into place — in `useLayoutEffect`, so the correction
   * lands before the browser paints and no card is ever seen at the left edge.
   */
  const [placed, setPlaced] = useState<Placement>(() => ({
    left: 0,
    top: anchor?.bottom ?? diagonal?.clear.bottom ?? 0,
  }));
  useLayoutEffect(() => {
    const node = card.current;
    if (node === null) return;
    const box = node.getBoundingClientRect();
    if (diagonal !== undefined) {
      setPlaced(
        diagonalPlacement(diagonal.clear, { width: box.width, height: box.height }, diagonal.frame),
      );
      return;
    }
    if (anchor === undefined) return;
    setPlaced(
      surfacePlacement(
        anchor,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    // Most owners measure once per opening. A portalled card inside a
    // scrollbox may hand over a fresh rectangle while it stays open, so each
    // anchor identity places the card again.
  }, [anchor, diagonal]);

  /**
   * This card's own box, or null before it has ever been measured.
   *
   * Held rather than read at placement time because a card placed beside a
   * list can be **suppressed**, and a suppressed card is not in the document
   * to be measured again: the size it last had is what the next option's
   * placement is decided from. Without it a window with no room either side
   * would suppress the card once and never let it back, since the effect that
   * measures has no node to run against.
   */
  const [cardBox, setCardBox] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const node = card.current;
    if (beside === undefined || node === null) return;
    const measured = node.getBoundingClientRect();
    setCardBox({ width: measured.width, height: measured.height });
    // Each anchor identity measures again: the card's content is the option's
    // and a longer project name is a wider card.
  }, [beside]);
  const besidePlaced =
    beside === undefined
      ? null
      : besidePlacement(beside, cardBox ?? { width: 0, height: 0 }, {
          width: window.innerWidth,
          height: window.innerHeight,
        });

  /**
   * Where this card stands against its cell, once both have been measured.
   *
   * `null` is the frame before the measurement: the card draws to the **right**
   * of its cell and hangs from `100%` of its wrapper, which is where every one
   * of these opened before any of it was a choice, so nothing is ever seen to
   * jump on a cell with the room.
   *
   * Three numbers rather than one placement object, because they answer three
   * different questions: which side and which edge ({@link sidewaysPlacement}),
   * how far past the **row** that edge is, and how much room the side it took
   * actually has.
   */
  const [sideways, setSideways] = useState<SidewaysPlacement | null>(null);
  const [roomBeside, setRoomBeside] = useState<number | null>(null);
  const [pastTheRow, setPastTheRow] = useState<{ below: number; above: number } | null>(null);
  useLayoutEffect(() => {
    if (anchor !== undefined || beside !== undefined || diagonal !== undefined) return;
    // Narrowing, not a guard, and deliberately not a throw: a layout effect runs
    // on a mounted node, and a mounted node has a parent. No injected fault can
    // make either null, so a throw here would be a check whose failure can never
    // be observed — the fault R5's tally is a list of, and the one
    // `column-widths-drag` deleted a line for rather than keep unprovable. What
    // *is* provable is that the measurement happens at all, which every case in
    // `e2e/card-lanes.spec.ts` is.
    const wrapper = card.current?.parentElement;
    const box = card.current?.getBoundingClientRect();
    if (wrapper === null || wrapper === undefined || box === undefined) return;
    // What clips this card: the window, and the scrolling frame as well where
    // the cell is inside one. `overflow: auto` clips to the padding box, so the
    // frame's own picker room counts as room — it is exactly what that padding
    // is for. Found by the attribute rather than by walking up looking for a
    // computed `overflow`, for `editable-grid.ts`'s reason: the frame is a
    // named thing in this app and the name is the contract.
    const port = wrapper.closest('[data-table-frame]')?.getBoundingClientRect();
    const cell = wrapper.getBoundingClientRect();
    const frame = {
      left: Math.max(0, port?.left ?? 0),
      right: Math.min(window.innerWidth, port?.right ?? window.innerWidth),
      top: Math.max(0, port?.top ?? 0),
      bottom: Math.min(window.innerHeight, port?.bottom ?? window.innerHeight),
    };
    const placement = sidewaysPlacement(cell, box, frame);
    setSideways(placement);
    setRoomBeside(
      (placement.side === 'right' ? frame.right - cell.right : cell.left - frame.left) -
        ANCHOR_GAP_PX,
    );
    // How far the card has to hang to clear the **row** it belongs to, measured
    // from the wrapper it is positioned in: `100%` is that wrapper, and a
    // wrapper is a line box inside a row rather than the row itself.
    const row = wrapper.closest('tr')?.getBoundingClientRect();
    setPastTheRow(
      row === undefined ? null : { below: row.bottom - cell.top, above: cell.bottom - row.top },
    );
    // Once per opening: the cell cannot move while the card is open, because
    // the pointer leaving the cell is what closes it.
  }, [anchor, beside, diagonal]);

  // A window with room on neither side of the list shows no card at all. After
  // every hook, because this is a render that draws nothing rather than a
  // component that does less.
  if (beside !== undefined && besidePlaced === null) return null;

  const scrolling: CSSProperties = scrolls
    ? {
        maxHeight: sideways?.maxHeight ?? SCROLLING_MIN_HEIGHT,
        overflowY: 'auto',
        pointerEvents: 'auto',
      }
    : { pointerEvents: takesPointer ? 'auto' : 'none' };
  const anchored: CSSProperties =
    besidePlaced !== null
      ? {
          position: 'fixed',
          top: besidePlaced.top,
          left: besidePlaced.left,
          // The same ceiling as an anchored card's, and load-bearing for the
          // same reason twice over: it is the width {@link besidePlacement}
          // decides the side from, so a card that could grow past it would be
          // placed against a width it does not have.
          maxWidth: `min(${String(CARD_MAX_WIDTH_PX)}px, 100vw)`,
        }
      : anchor === undefined && diagonal === undefined
        ? {
            position: 'absolute',
            // **Diagonally: past the cell, and past the row.** Dany,
            // 2026-09-10: _"can you make it so that all on-hover pop-ups over
            // cells - all display diagonally? like to make both the on-hover
            // element available for vertical scroll of mouse & the whole row
            // seen for context on all columns of the row"_.
            //
            // Two promises in one placement. Past the **cell** horizontally, so
            // the column the pointer is running down stays under the pointer
            // rather than under the card; past the **row** vertically, so the
            // work item's own dates, estimates and dependencies stay readable
            // beside the words that explain one of them.
            //
            // Which side and which edge are measured ({@link
            // sidewaysPlacement}); how far past the row is measured too,
            // because `100%` is the cell's own wrapper and a wrapper is a line
            // box inside a row rather than the row itself — hanging from it left
            // 3px of the row covered, in Chromium on 2026-09-10.
            ...(sideways?.side === 'left' ? { right: '100%' } : { left: '100%' }),
            ...(sideways?.align === 'bottom'
              ? { bottom: pastTheRow === null ? '100%' : pastTheRow.above }
              : { top: pastTheRow === null ? '100%' : pastTheRow.below }),
            // Shrink-to-fit measures the room between `left` and the containing
            // block's right edge, and that block is the cell — 4px. Without
            // `max-content` every one of these cards is its 260px minimum
            // however much room the plan has beside it.
            width: 'max-content',
            // The room beside the cell, measured, against the ceiling this
            // kind of card keeps: a document's is wide because it is a document,
            // and a sentence about a cell is 420px of sentence.
            maxWidth: `min(${String(scrolls ? WIDE_CARD_WIDTH_PX : CARD_MAX_WIDTH_PX)}px, ${
              roomBeside === null ? '100vw' : `${String(Math.round(roomBeside))}px`
            }, 100vw)`,
          }
        : {
            position: 'fixed',
            top: placed.top,
            left: placed.left,
            // Never wider than the screen it is clamped inside, which is what
            // lets {@link surfacePlacement} promise both edges at once. `min`
            // rather than the constant alone: 420px on a 390px phone is a card
            // that cannot be clamped into view.
            maxWidth: `min(${String(CARD_MAX_WIDTH_PX)}px, 100vw)`,
          };
  const body = (
    <div
      ref={card}
      role="tooltip"
      id={id}
      aria-label={label}
      onMouseEnter={onPointerArrives}
      style={{
        ...anchored,
        // The height ceiling {@link sidewaysPlacement} computes is room in the
        // frame, so it has to mean the whole box. Left at `content-box`, the
        // card's own 6px padding and 1px border are added to it and the card
        // ends 14px past the edge it was sized to stay inside.
        //
        // Proof: this line removed — both browser tests in
        // `e2e/hover-cards.spec.ts`'s `takes the room around its cell` failed,
        // on `the card runs off the bottom of the window` and `the flipped card
        // runs off the top of the window`. It is the fault that found this
        // line: measured in Chromium at `cardBottom: 908` in a 900px window
        // before it existed. Watched 2026-08-11.
        boxSizing: 'border-box',
        zIndex: 20,
        minWidth: compact ? undefined : CARD_MIN_WIDTH_PX,
        background: 'var(--popover)',
        color: 'var(--popover-foreground)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '6px 10px',
        boxShadow: '0 4px 14px oklch(0 0 0 / 14%)',
        textAlign: 'left',
        // A card's content is names and URLs, and both arrive as one unbroken
        // token often enough that this is not a nicety: a 192-character work
        // item name laid 1396px of text inside a 388px card on a phone, and
        // the card was clipped rather than tall (measured in Chromium,
        // 2026-09-08, `e2e/project-settings.spec.ts`'s phone case).
        //
        // `break-word` rather than `anywhere`: it leaves the card's
        // **min-content** width alone, so a compact card is still the width of
        // its words and only a token that cannot fit the ceiling is broken.
        overflowWrap: 'break-word',
        // The cells these open from are bold, right-aligned, or both — a
        // folded step's figure is `font-weight: 600` — and a card inheriting
        // that reads as a heading rather than as a paragraph.
        fontWeight: 400,
        ...scrolling,
      }}
    >
      {children}
    </div>
  );
  // A card that opens from a cell stays inside that cell's wrapper, which is
  // what its `position: absolute` is measured against. An anchored one is
  // portalled out: its mark is inside an `<svg>`, which can hold no HTML at
  // all, and every ancestor of it clips. A card placed beside a list is
  // portalled for the second of those reasons — the listbox scrolls and clips.
  return anchor === undefined && beside === undefined && diagonal === undefined
    ? body
    : createPortal(body, document.body);
}
