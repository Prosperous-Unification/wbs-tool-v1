import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { diagonalPlacement, HoverCard, sidewaysPlacement, surfacePlacement } from './hover-card';
import { HoverPreview } from './hover-preview';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

describe('a hover card hangs over the rows below without touching them', () => {
  itDom('does not take the pointer', () => {
    // The rule the browser found and no amount of reading found: a card opens
    // over the row beneath it, and one that takes the mouse eats a click aimed
    // at that row. Read-only content has no business doing so.
    //
    // Proof: the default flipped to `pointerEvents: 'auto'` — this failed on
    // `expected 'auto' to be 'none'`, and the browser's own
    // `a click through an open card lands on the row beneath`
    // (`e2e/hover-cards.spec.ts`) failed with it. Watched, 2026-08-09.
    render(<HoverCard label="Dev for 010">4.8 days</HoverCard>);

    expect(screen.getByRole('tooltip').style.pointerEvents).toBe('none');
  });

  itDom('lets the one card that scrolls take the wheel back', () => {
    // The exception, and the whole of it: a preview taller than 320px is
    // unreadable unless it can be scrolled, and scrolling is a pointer event.
    // Asserted through the Name cell's preview rather than through the prop,
    // because the preview asking for it is the fact that matters.
    //
    // Proof: `scrolls` dropped from `HoverPreview`'s card — failed on
    // `expected 'none' to be 'auto'` and `expected '' to be 'auto'`. Watched,
    // 2026-08-09.
    render(<HoverPreview name="Strip" notes={'- one\n- two'} number="010" />);

    const preview = screen.getByRole('tooltip');
    expect(preview.style.pointerEvents).toBe('auto');
    expect(preview.style.overflowY).toBe('auto');
  });

  itDom('sizes the one card that scrolls from the room around its cell', () => {
    // The height is no longer a constant, so what can be asserted here is that
    // it is *measured*: jsdom's rectangles are all zeroes, which is a cell at
    // the very top of a 768px window, and `roomForCard` answers that with the
    // room below rather than with the old 320px.
    //
    // Proof: the `useLayoutEffect` body replaced with `return`, so the card
    // keeps its pre-measurement fallback — this failed on `expected '160px' not
    // to be '160px'`. The arithmetic itself is asserted below, and that it is a
    // real cell being measured is `e2e/hover-cards.spec.ts`. Watched 2026-08-11.
    render(<HoverPreview name="Strip" notes={'- one\n- two'} number="010" />);

    const preview = screen.getByRole('tooltip');
    // The ceiling is the room beside the cell now ({@link sidewaysPlacement}),
    // and jsdom measures every box as zero — so what is asserted here is that a
    // ceiling was set at all, and `e2e/hover-cards.spec.ts` is where the figure
    // is a real frame's.
    expect(preview.style.maxHeight).not.toBe('');
    // The declarations that put this card past its cell and below its own row
    // ({@link HoverCardProps.leavesItsRowClear}). jsdom measures every box as
    // zero, so `top` is the unmeasured `100%` here and the row's own edge in a
    // browser — `e2e/hover-cards.spec.ts`'s `leaves its own row and the marker
    // lane clear` is where that is asserted.
    //
    // `max-content` is the load-bearing one: shrink-to-fit measures the room
    // between `left: 100%` and the cell's right edge, which is 4px, so without
    // it this card is its 260px minimum however wide the plan is.
    //
    // Proof: `leavesItsRowClear` dropped from `HoverPreview`'s card — this
    // failed on `expected '0px' to be '100%'`, the card back at its cell's own
    // left edge. Watched 2026-09-10.
    expect(preview.style.left).toBe('100%');
    expect(preview.style.width).toBe('max-content');
    // `1018px` is jsdom's own window width less the 6px gap the placement
    // keeps — the measured room, which in a browser is the frame's.
    expect(preview.style.maxWidth).toBe('min(1000px, 1018px, 100vw)');
  });

  itDom('leaves every other card its own width', () => {
    // The widening is the scrolling card's alone: a folded step's figure is
    // four words and a 640px box around them is a card that covers three rows
    // to say "4.8 days".
    //
    // Proof: the `scrolls ?` conditional on `maxWidth` collapsed to the wide
    // branch — failed on `expected '640px' to be '420px'`. Watched 2026-08-11.
    render(<HoverCard label="Dev for 010">4.8 days</HoverCard>);

    // The same measured room, against the ceiling a card of words keeps.
    expect(screen.getByRole('tooltip').style.maxWidth).toBe('min(420px, 1018px, 100vw)');
  });

  itDom('renders a body that is not a work item’s notes', () => {
    // The generalization this change is about: the card is placement and the
    // body is whatever the mark has to say. The Name cell's preview is one
    // body; a Gantt bar's facts are another, and neither is built into this.
    render(
      <HoverCard label="Facts for 3.2">
        <p>Dev · Kat</p>
      </HoverCard>,
    );

    expect(screen.getByRole('tooltip').textContent).toBe('Dev · Kat');
  });

  itDom('places an anchored card out of the document, fixed, under its mark', () => {
    // jsdom measures nothing, so the card's own size is 0×0 here and the
    // placement is the anchor's own left and bottom. What this asserts is the
    // wiring the arithmetic below cannot: that an anchored card leaves the
    // component's own subtree for the document, and is `fixed` rather than
    // `absolute`. Where it lands once it has a size is a browser fact
    // (`e2e/gantt.spec.ts`).
    const { container } = render(
      <HoverCard label="Facts for 3.2" anchor={{ left: 120, right: 140, top: 200, bottom: 228 }}>
        <p>Dev · Kat</p>
      </HoverCard>,
    );

    const surface = screen.getByRole('tooltip');
    expect(container.contains(surface)).toBe(false);
    expect(document.body.contains(surface)).toBe(true);
    expect(surface.style.position).toBe('fixed');
    expect(surface.style.left).toBe('120px');
  });
});

describe('an anchored surface stays inside the viewport', () => {
  const SCREEN = { width: 1000, height: 800 };
  const CARD = { width: 300, height: 120 };

  itDom('opens under its mark when there is room below', () => {
    expect(
      surfacePlacement({ left: 100, right: 120, top: 200, bottom: 228 }, CARD, SCREEN),
    ).toEqual({
      left: 100,
      top: 234,
    });
  });

  itDom('flips above a mark near the bottom of the screen', () => {
    // Proof: the flip removed — `top` fixed at `anchor.bottom + gap` — `2
    // failed | 6 passed`, this one on `expected { left: 100, top: 780 } to
    // deeply equal { left: 100, top: 624 }`, a card hanging 100px off the
    // bottom of the screen, and the last test in this block with it. The
    // browser's own half of the same fault is
    // `flips a surface above a bar near the bottom of the window`. Watched,
    // 2026-08-09.
    expect(
      surfacePlacement({ left: 100, right: 120, top: 750, bottom: 774 }, CARD, SCREEN),
    ).toEqual({
      left: 100,
      top: 624,
    });
  });

  itDom('clamps a mark near the right edge back inside the screen', () => {
    // Proof: the whole clamp dropped, so `left` is the anchor's own — `2
    // failed | 6 passed`, this one on `expected { left: 950, top: 234 } to
    // deeply equal { left: 700, top: 234 }`, a card whose right edge is 1250 on
    // a 1000px screen, and the last test in this block with it. The browser's
    // half is `clamps the right-most bar's surface inside the window`.
    // Watched, 2026-08-09.
    expect(
      surfacePlacement({ left: 950, right: 970, top: 200, bottom: 228 }, CARD, SCREEN),
    ).toEqual({
      left: 700,
      top: 234,
    });
  });

  itDom('never places a card off the left edge or above the top one', () => {
    // Both clamps at once, on a screen too small for the card in either
    // direction: the `Math.max(0, …)` pair is what keeps the two corrections
    // above from overshooting into a card nobody can see.
    //
    // Proof, twice, each with the test above it: the flip removed, this failed
    // on `expected { left: +0, top: 64 } to deeply equal { left: +0, top: +0 }`
    // — no top clamp to reach; the clamp on `left` dropped, on `expected {
    // left: 10, top: +0 } to deeply equal { left: +0, top: +0 }`. Watched,
    // 2026-08-09.
    expect(
      surfacePlacement({ left: 10, right: 30, top: 30, bottom: 58 }, CARD, {
        width: 200,
        height: 100,
      }),
    ).toEqual({ left: 0, top: 0 });
  });
});

describe('a card beside its cell picks the side with the room', () => {
  /** A 1400px plan in a 900px-tall window, which is the shape being reasoned about. */
  const FRAME = { left: 0, right: 1400, top: 100, bottom: 900 };
  /** What these cards ask for: {@link CARD_MIN_WIDTH_PX} wide, three lines tall. */
  const CARD = { width: 260, height: 60 };

  it('opens right where the right has the room', () => {
    expect(
      sidewaysPlacement({ left: 300, right: 420, top: 150, bottom: 176 }, CARD, FRAME),
    ).toEqual({ side: 'right', align: 'top', maxHeight: 720 });
  });

  it('opens left for a column within a card of the right edge', () => {
    // The Start column, measured in Chromium on 2026-09-10: the cell at
    // x 1283–1381 in a frame ending at 1385, and a card that opened right ran
    // to 1637 — 252px past the edge of the plan.
    //
    // Proof: the side fixed at `right`, this failed on `expected { side:
    // 'right', align: 'top' } to deeply equal { side: 'left', align: 'top' }`.
    // Watched 2026-09-10; the browser half is `e2e/card-lanes.spec.ts`'s `an
    // informative card stands beside its cell, not over its column`.
    expect(
      sidewaysPlacement({ left: 1283, right: 1381, top: 150, bottom: 176 }, CARD, FRAME),
    ).toEqual({ side: 'left', align: 'top', maxHeight: 720 });
  });

  it('opens right on a tie, which is where every card opened before', () => {
    // 700 either side of a cell in the middle of a 1400px frame, and a card
    // that fits in neither: the tie is what the rule is written to answer.
    expect(
      sidewaysPlacement(
        { left: 700, right: 700, top: 150, bottom: 176 },
        { width: 900, height: 60 },
        FRAME,
      ),
    ).toEqual({ side: 'right', align: 'top', maxHeight: 720 });
  });

  it('hangs from the bottom edge for a row too low to hold the card', () => {
    // 60px of card from a cell whose top is 870px down an 900px frame: hung
    // from the top it ends 30px below the frame.
    //
    // Proof: `align` fixed at `top`, this failed on `expected { side: 'right',
    // align: 'top' } to deeply equal { side: 'right', align: 'bottom' }`.
    // Watched 2026-09-10.
    expect(
      sidewaysPlacement({ left: 300, right: 420, top: 870, bottom: 896 }, CARD, FRAME),
    ).toEqual({ side: 'right', align: 'bottom', maxHeight: 720 });
  });
});

describe('a hint card past its cell and past its row', () => {
  const CARD = { width: 260, height: 60 };
  /** A plan's frame: the whole window, so the plain cases read as coordinates. */
  const FRAME = { left: 0, right: 1000, top: 0, bottom: 800 };

  it('stands right of the column and below the row', () => {
    // A 140px cell in a 26px row, with the rest of the plan to its right: the
    // card's left edge is the **cell's** right edge and its top is the
    // **row's** bottom, which is the whole of what "diagonal" is. No gap on
    // either axis, so it is the same corner an in-cell card hangs in.
    expect(
      diagonalPlacement({ left: 100, right: 240, top: 200, bottom: 226 }, CARD, FRAME),
    ).toEqual({ left: 240, top: 226 });
  });

  it('flips to the left of a column with no room on its right', () => {
    // The Slack column, 20px from the frame's right edge: a card opening right
    // would start at 980 and end 240px past the plan.
    //
    // Proof: the side fixed at right, this failed on `expected { left: 740, top:
    // 226 } to deeply equal { left: 600, top: 226 }` — the clamped card standing
    // over its own column and three more. Watched 2026-09-11.
    expect(
      diagonalPlacement({ left: 860, right: 980, top: 200, bottom: 226 }, CARD, FRAME),
    ).toEqual({ left: 600, top: 226 });
  });

  it('hangs above the row for a row too low to hold the card', () => {
    // 60px of card from a row whose bottom is 4px off the frame's: hung below
    // it, the card would be 56px past the plan.
    //
    // Proof: `underneath` fixed at true, this failed on `expected { left: 240,
    // top: 740 } to deeply equal { left: 240, top: 710 }` — the card clamped up
    // the screen and over the row it explains. Watched 2026-09-11.
    expect(
      diagonalPlacement({ left: 100, right: 240, top: 770, bottom: 796 }, CARD, FRAME),
    ).toEqual({ left: 240, top: 710 });
  });

  it('is clamped into the frame rather than into the window', () => {
    // The frame is the plan's own scrolling box and it starts 300px in — a
    // narrow plan beside a wide chart. A card pushed off the roomier side is
    // pushed back to the **frame's** left edge, not to the window's, because
    // the promise is that the card stays inside the plan.
    //
    // A 120px-wide, 100px-tall frame, and a card that fits in neither
    // direction: both clamps bind, which is what lets one case prove both.
    //
    // Proof: both clamps taken back to the window (`Math.max(0, …)`, which is
    // what the placement this replaced did), this failed on `expected { left:
    // 160, top: 90 } to deeply equal { left: 300, top: 100 }` — 140px of card
    // hanging left of the plan, over the chart, and 10px of it above the frame.
    // Watched 2026-09-11.
    expect(
      diagonalPlacement({ left: 310, right: 330, top: 150, bottom: 176 }, CARD, {
        left: 300,
        right: 420,
        top: 100,
        bottom: 200,
      }),
    ).toEqual({ left: 300, top: 100 });
  });

  it('clamps rather than refuses where neither side has the room', () => {
    // 260px of card and 200px of frame. `besidePlacement` answers `null` for
    // this and is right to: a picker's card that must cover the list it explains
    // has no claim on the space. A hint is a sentence about the thing under the
    // pointer, and a reader who is shown nothing cannot ask again.
    //
    // Proof: a refusal put in front of the clamp — `if (toTheRight < card.width
    // && toTheLeft < card.width) return null;`, which is what {@link
    // besidePlacement} does — this failed on `expected null to deeply equal {
    // left: +0, top: 40 }`. Watched 2026-09-11. (The refusal is not typeable
    // here: the placement's return type is not nullable, and the fault runs
    // because vitest transpiles rather than checks.)
    expect(
      diagonalPlacement({ left: 10, right: 30, top: 30, bottom: 58 }, CARD, {
        left: 0,
        right: 200,
        top: 0,
        bottom: 100,
      }),
    ).toEqual({ left: 0, top: 40 });
  });
});
