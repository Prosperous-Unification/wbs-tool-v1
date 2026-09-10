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
 * How far a card is pulled left of its cell to leave its own trigger's lane
 * clear, in CSS pixels — see {@link HoverCardProps.clearsMarkerLane}.
 *
 * 24 against a 15px marker sitting 1px in from the cell's right edge, measured
 * in the running app on 2026-09-09. The surplus is deliberate: the lane has to
 * be comfortably hoverable rather than exactly uncovered, and a reader running
 * down forty of them should not have to be accurate to the pixel.
 */
const MARKER_LANE_PX = 24;

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

export interface HoverCardProps {
  /**
   * The mark this card is placed against, in viewport coordinates — and the
   * whole of what makes it a **fixed** card rather than an absolute one.
   *
   * Left off by every card that opens from a cell: those are absolutely
   * positioned children of the cell's own wrapper and the cell's box is their
   * placement. A mark inside the Gantt's SVG has no such wrapper — the user
   * space is scaled non-uniformly and holds no HTML at all — so its card is
   * portalled to the document and placed from the rectangle the browser
   * measured. See {@link surfacePlacement}.
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
   * Whether this card opens **beside** its cell rather than under it, aligned
   * with the cell's top edge.
   *
   * The links card's, and Dany asked for it on 2026-09-09 for a reason about
   * the pointer rather than about looks: *"can you please move the on-hover
   * hint to the right of the cell - so that i can move my cursor down to look
   * at each item one by one uninterrupted"*. A card under a 40px cell is reached
   * by a path that leaves the cell **sideways** — there is no instant at which
   * the pointer is over both, which is what {@link CARD_GRACE_MS} in
   * `plan-columns/refs.tsx` exists to cover. Beside it there is no such gap at
   * all: the card's left edge **is** the cell's right edge, so the pointer
   * crosses straight from one to the other and then walks down the list without
   * ever leaving the card.
   *
   * Still an absolutely positioned child of the cell's own wrapper, not a
   * portal — which is the whole reason to prefer it over
   * {@link HoverCardProps.beside}: the wrapper stays the element that owns the
   * `mouseleave`, so the cell keeps the card open with no bridge, no document
   * listener and no second copy of the open state.
   *
   * It follows that a card on a row low in the table extends below its row, as
   * a card under a cell already did. That is unchanged rather than solved here.
   */
  opensSideways?: boolean;
  /**
   * Whether this card is pulled clear of the lane its own trigger stands in, so
   * that a reader can run the pointer down that lane and read each row's card
   * in turn.
   *
   * The Name cell's notes preview, and Dany asked for it on 2026-09-09: *"move
   * the preview tooltip window slightly to the left - so that preview icons can
   * be scrolled down and up by moving the mouse"*. The `≡` markers are
   * `position: absolute; right: 1` on every Name cell, so they form a column at
   * the cell's right edge — and the preview opened at `left: 0` across the whole
   * cell, which put its right edge **on that column**. Measured in the running
   * app: the preview at `[145, 240, 555, 370]`, the lane at x 685–700, and
   * `elementFromPoint` at the next marker down answering the preview's own
   * `DIV`. The marker below was unreachable, so the pointer could read one row's
   * notes and no more.
   *
   * A **horizontal** pull rather than a vertical one, because the preview flips
   * above its cell for a row low in the table ({@link roomForCard}) and would
   * then cover the lane *upward* instead. Left clear of the lane, it is out of
   * the way whichever side it opens on.
   *
   * Placed by its **right** edge, `right: 24px` inside the cell, rather than by
   * a negative `left`. Both put the same box on a wide cell, and only this one
   * holds on a narrow one: shrink-to-fit takes the room between the containing
   * block's left edge and `right`, and where that is under
   * {@link CARD_MIN_WIDTH_PX} the card grows *leftwards* out of its cell
   * instead of over the lane. A `left: -24px` card capped at `100%` of the cell
   * loses to the same minimum and covers the lane again — which is what the
   * Name column does at 192px, with the four reference columns on screen.
   */
  clearsMarkerLane?: boolean;
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

/** How wide a scrolling card may get, in CSS pixels. Documents want the width. */
const SCROLLING_MAX_WIDTH_PX = 640;

/** Which side of its cell a card opens on, and the height ceiling that side gives it. */
export interface CardRoom {
  side: 'below' | 'above';
  maxHeight: number;
}

/**
 * The side a scrolling card opens on and how tall it may be there: whichever
 * side of its cell has the clear room, capped at {@link VIEWPORT_SHARE} of the
 * container and floored at {@link SCROLLING_MIN_HEIGHT} — the cap winning over
 * the floor for a container shorter than one, which is a box with nothing to
 * give rather than a card that may hang out of it.
 *
 * **The container is the box the card is clipped by, which is not always the
 * window.** A cell's card is an absolutely positioned child of the cell, so a
 * scroll container between the two clips it — and since `unified-scroll-docking`
 * the table's frame is only as tall as its own rows, rather than as tall as the
 * window. Measured against the window, a card on the first row of a four-row
 * plan is placed 320px down a frame that ends 200px down, and the half of it a
 * reader would have to point at to scroll it is not painted at all.
 *
 * Proof: the frame stopped growing with the container left as `window
 * .innerHeight`, and `e2e/hover-cards.spec.ts`'s `scrolls a note taller than
 * the preview once the pointer is on it` failed on `the card closed on the way
 * to it: expected 1, received 0` — the pointer sent to the middle of a card
 * whose middle was outside the frame, landing on the page behind it. Watched on
 * h2puni, 2026-08-12.
 *
 * Pure, and separated from the component for the same reason as {@link
 * surfacePlacement}: the rectangle it works on comes from
 * `getBoundingClientRect`, which jsdom answers with zeroes. The wiring — that a
 * preview really is measured and really is placed by this — is a browser fact
 * asserted in `e2e/hover-cards.spec.ts`.
 *
 * The gap is subtracted from both sides so the ceiling describes room the card
 * can actually occupy rather than room up to the window's own edge.
 *
 * @param anchor The cell's rectangle, in viewport coordinates.
 * @param anchor.top Its top edge — the room above it.
 * @param anchor.bottom Its bottom edge — the container's bottom less this is the room below.
 * @param container The box the card is clipped by, in viewport coordinates —
 * the window, or the window and the scrolling frame where there is one.
 * @param container.top Its top edge.
 * @param container.bottom Its bottom edge.
 */
/** Which way a card opens beside its cell, and which of its edges is aligned. */
export interface SidewaysPlacement {
  /** The side of the cell the card stands on. */
  side: 'left' | 'right';
  /** Whether the card's top is aligned with the cell's, or its bottom. */
  align: 'top' | 'bottom';
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
 * `align` is the same question vertically, and it is not the flip
 * {@link roomForCard} makes: a card *beside* its cell hangs from the cell's own
 * top edge, so the only failure is a card taller than the room below that top —
 * a row low in the frame. Hanging it from the cell's **bottom** edge instead
 * keeps it inside, and either way it never covers its own cell.
 *
 * Pure, and separated from the component for {@link roomForCard}'s reason: the
 * rectangles come from `getBoundingClientRect`, which jsdom answers with
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
  return {
    // `>=` on both counts, so a tie opens right and hangs from the top, which
    // is where every card in this table opened before there was a choice.
    side: toTheRight >= card.width || toTheRight >= toTheLeft ? 'right' : 'left',
    align: container.bottom - cell.top >= card.height ? 'top' : 'bottom',
  };
}

export function roomForCard(
  anchor: { top: number; bottom: number },
  container: { top: number; bottom: number },
): CardRoom {
  // A box cannot be shorter than nothing. The caller hands this the frame ∩ the
  // window, and an intersection of two boxes that do not meet inverts — a frame
  // scrolled entirely off the top of the window gives `{0, -200}` — where a
  // share of the negative height is a card told to be shorter than nothing
  // rather than one told it has no room. Both reviewers, 2026-08-12.
  const bottom = Math.max(container.top, container.bottom);
  const below = bottom - anchor.bottom - ANCHOR_GAP_PX;
  const above = anchor.top - container.top - ANCHOR_GAP_PX;
  return {
    // `>=` rather than `>`: a cell with equal room either way opens downward,
    // which is where every other card in the table opens and where a reader
    // looks first.
    side: below >= above ? 'below' : 'above',
    // The share of the container wins over the floor where the container is
    // itself shorter than the floor: a card is never taller than the box that
    // clips it, however little that box has to give.
    maxHeight: Math.min(
      (bottom - container.top) * VIEWPORT_SHARE,
      Math.max(below, above, SCROLLING_MIN_HEIGHT),
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
 * `mouseenter` and cleared on `mouseleave`. A fixed-size card opening from a
 * **cell** is not flipped — it opens from the wrapper's bottom edge and that is
 * the whole of its placement. Two exceptions, for two different reasons:
 *
 * - {@link HoverCardProps.scrolls} — a card holding a document is as tall as
 *   the room it has, and below the cell is not where the room is for a row in
 *   the lower half of the table. It measures its wrapper and opens on the side
 *   {@link roomForCard} gives it, still inside the wrapper's own subtree,
 *   because the pointer has to be able to walk from the notes marker onto the
 *   card without leaving the cell that owns the `mouseleave`.
 * - {@link HoverCardProps.anchor} — a Gantt bar has no wrapper to open from, so
 *   such a card is portalled, fixed, flipped and clamped by {@link
 *   surfacePlacement}, and the delay before it opens belongs to the panel that
 *   opens it rather than to this.
 */
export function HoverCard({
  label,
  id,
  scrolls = false,
  takesPointer = false,
  opensSideways = false,
  clearsMarkerLane = false,
  compact = false,
  anchor,
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
  const [placed, setPlaced] = useState<Placement>(() => ({ left: 0, top: anchor?.bottom ?? 0 }));
  useLayoutEffect(() => {
    const node = card.current;
    if (anchor === undefined || node === null) return;
    const box = node.getBoundingClientRect();
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
  }, [anchor]);

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
   * The room this card's cell leaves it, or null until it has been measured.
   *
   * Only a scrolling card measures: it is the one card whose height is not its
   * content's, and the one that can be tall enough to run off the screen.
   */
  const [room, setRoom] = useState<CardRoom | null>(null);
  useLayoutEffect(() => {
    if (!scrolls || anchor !== undefined || beside !== undefined) return;
    // Narrowing, not a guard, and deliberately not a throw: a layout effect runs
    // on a mounted node, and a mounted node has a parent. No injected fault can
    // make either null, so a throw here would be a check whose failure can never
    // be observed — the fault R5's tally is a list of, and the one
    // `column-widths-drag` deleted a line for rather than keep unprovable. What
    // *is* provable is that the measurement happens at all: `sizes the one card
    // that scrolls from the room around its cell`, and the browser's own
    // `opens the card above a row low in the table`.
    const wrapper = card.current?.parentElement;
    if (wrapper === null || wrapper === undefined) return;
    // What clips this card: the window, and the scrolling frame as well where
    // the cell is inside one. `overflow: auto` clips to the padding box, so the
    // frame's own picker room counts as room — it is exactly what that padding
    // is for. Found by the attribute rather than by walking up looking for a
    // computed `overflow`, for `editable-grid.ts`'s reason: the frame is a
    // named thing in this app and the name is the contract.
    const port = wrapper.closest('[data-table-frame]')?.getBoundingClientRect();
    setRoom(
      roomForCard(wrapper.getBoundingClientRect(), {
        top: Math.max(0, port?.top ?? 0),
        bottom: Math.min(window.innerHeight, port?.bottom ?? window.innerHeight),
      }),
    );
    // The cell does not move while the card is open — the card is closed by the
    // pointer leaving the cell — so this runs once per opening. `beside` is in
    // the list because the guard above reads it, not because a card placed
    // beside a list is ever measured for room: it has none of its own.
  }, [scrolls, anchor, beside]);

  /**
   * Which side of its cell a sideways card stands on, once it has a size.
   *
   * `null` is the frame before the measurement, and it draws on the **right**
   * with its top aligned — the side every sideways card opened on before there
   * was a choice, so a column with the room is placed correctly on the first
   * frame and never seen to move.
   */
  const [sideways, setSideways] = useState<SidewaysPlacement | null>(null);
  useLayoutEffect(() => {
    if (!opensSideways || anchor !== undefined || beside !== undefined) return;
    const wrapper = card.current?.parentElement;
    const box = card.current?.getBoundingClientRect();
    if (wrapper === null || wrapper === undefined || box === undefined) return;
    const port = wrapper.closest('[data-table-frame]')?.getBoundingClientRect();
    setSideways(
      sidewaysPlacement(wrapper.getBoundingClientRect(), box, {
        left: Math.max(0, port?.left ?? 0),
        right: Math.min(window.innerWidth, port?.right ?? window.innerWidth),
        top: Math.max(0, port?.top ?? 0),
        bottom: Math.min(window.innerHeight, port?.bottom ?? window.innerHeight),
      }),
    );
    // Once per opening, for {@link roomForCard}'s reason: the cell cannot move
    // while the card is open, because the pointer leaving the cell is what
    // closes it.
  }, [opensSideways, anchor, beside]);

  // A window with room on neither side of the list shows no card at all. After
  // every hook, because this is a render that draws nothing rather than a
  // component that does less.
  if (beside !== undefined && besidePlaced === null) return null;

  const scrolling: CSSProperties = scrolls
    ? {
        maxHeight: room === null ? SCROLLING_MIN_HEIGHT : room.maxHeight,
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
      : anchor === undefined
        ? {
            position: 'absolute',
            // Beside the cell, or under it. Sideways is `left: 100%` with the
            // tops aligned, so the card's left edge is the cell's right edge
            // and a pointer crosses between them with nothing in between — see
            // {@link HoverCardProps.opensSideways}.
            //
            // The vertical `room` is measured, so `null` is the frame before
            // the layout effect has run rather than a card with no room: it
            // opens downward, which is where it will stay for every row that
            // has the room below.
            ...(opensSideways
              ? {
                  // Beside the cell, on the side with the room and hanging from
                  // the edge that keeps it in the frame — see
                  // {@link sidewaysPlacement}. `null` is the frame before the
                  // card has a size, and it is the right/top pair every
                  // sideways card had before the side was a choice.
                  ...(sideways?.side === 'left' ? { right: '100%' } : { left: '100%' }),
                  ...(sideways?.align === 'bottom' ? { bottom: 0 } : { top: 0 }),
                }
              : {
                  // A card asked to leave its trigger's lane clear is anchored
                  // by its **right** edge, 24px inside its cell's — see
                  // {@link HoverCardProps.clearsMarkerLane}. Anchoring the edge
                  // that has to stay clear is what makes the promise hold at
                  // any column width: the first cut of this pulled `left` 24px
                  // negative and capped the width at `100%` of the cell, which
                  // is the same box only while the cell is wider than
                  // {@link CARD_MIN_WIDTH_PX}. With the four reference columns
                  // on screen the Name cell is 192px, the minimum won, and the
                  // card stood 44px over the lane again — measured in Chromium
                  // on 2026-09-09, `elementFromPoint` at the next row's marker
                  // answering the card's own `H1`.
                  ...(clearsMarkerLane ? { right: MARKER_LANE_PX, left: 'auto' } : { left: 0 }),
                  ...(room?.side === 'above' ? { bottom: '100%' } : { top: '100%' }),
                }),
            maxWidth: scrolls
              ? `min(${String(SCROLLING_MAX_WIDTH_PX)}px, 100vw)`
              : CARD_MAX_WIDTH_PX,
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
      style={{
        ...anchored,
        // The height ceiling {@link roomForCard} computes is room in the
        // window, so it has to mean the whole box. Left at `content-box`, the
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
  return anchor === undefined && beside === undefined ? body : createPortal(body, document.body);
}
