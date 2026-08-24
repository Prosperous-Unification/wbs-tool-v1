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
   * Whether this card scrolls its own content, and so has to take the wheel.
   *
   * The Name cell's preview alone. See {@link HoverCard} for why every other
   * card is pointer-transparent.
   */
  scrolls?: boolean;
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
export function HoverCard({ label, id, scrolls = false, anchor, children }: HoverCardProps) {
  const card = useRef<HTMLDivElement | null>(null);
  // Placed under the mark to begin with and corrected once the card has a size,
  // which is the only moment its own width and height exist. `useLayoutEffect`
  // rather than `useEffect`, so the correction lands before the browser paints
  // and no card is ever seen off the edge it is about to be pulled back from.
  const [placed, setPlaced] = useState<Placement>(() =>
    anchor === undefined ? { left: 0, top: 0 } : { left: anchor.left, top: anchor.bottom },
  );
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
   * The room this card's cell leaves it, or null until it has been measured.
   *
   * Only a scrolling card measures: it is the one card whose height is not its
   * content's, and the one that can be tall enough to run off the screen.
   */
  const [room, setRoom] = useState<CardRoom | null>(null);
  useLayoutEffect(() => {
    if (!scrolls || anchor !== undefined) return;
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
    // pointer leaving the cell — so this runs once per opening.
  }, [scrolls, anchor]);

  const scrolling: CSSProperties = scrolls
    ? {
        maxHeight: room === null ? SCROLLING_MIN_HEIGHT : room.maxHeight,
        overflowY: 'auto',
        pointerEvents: 'auto',
      }
    : { pointerEvents: 'none' };
  const anchored: CSSProperties =
    anchor === undefined
      ? {
          position: 'absolute',
          // Measured, so `null` is the frame before the layout effect has run
          // rather than a card with no room: it opens downward, which is where
          // it will stay for every row that has the room below.
          ...(room?.side === 'above' ? { bottom: '100%' } : { top: '100%' }),
          left: 0,
          maxWidth: scrolls ? `min(${String(SCROLLING_MAX_WIDTH_PX)}px, 100vw)` : CARD_MAX_WIDTH_PX,
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
        minWidth: 260,
        background: 'var(--popover)',
        color: 'var(--popover-foreground)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '6px 10px',
        boxShadow: '0 4px 14px oklch(0 0 0 / 14%)',
        textAlign: 'left',
        // The cells these open from are bold, right-aligned, or both — a
        // folded role's figure is `font-weight: 600` — and a card inheriting
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
  // all, and every ancestor of it clips.
  return anchor === undefined ? body : createPortal(body, document.body);
}
