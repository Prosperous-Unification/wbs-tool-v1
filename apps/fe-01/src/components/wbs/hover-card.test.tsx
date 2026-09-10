import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HoverCard, roomForCard, sidewaysPlacement, surfacePlacement } from './hover-card';
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
    expect(preview.style.maxHeight).not.toBe('160px');
    expect(preview.style.maxHeight).toBe(
      `${String(roomForCard({ top: 0, bottom: 0 }, { top: 0, bottom: window.innerHeight }).maxHeight)}px`,
    );
    // The card is placed by its **right** edge, 24px inside its cell's, so that
    // the lane of `≡` markers stays hoverable at any column width
    // ({@link HoverCardProps.clearsMarkerLane}) — and the width is the pixel cap
    // alone, since nothing has to be capped once the edge that matters is the
    // anchored one. jsdom lays nothing out, so these are the declarations and
    // not the geometry; what they *do* is `e2e/card-lanes.spec.ts`'s notes
    // preview lane, in a layout whose Name cell is 192px.
    //
    // Proof: `clearsMarkerLane` dropped from `HoverPreview`'s card — this failed
    // on `expected '' to be '24px'`, the empty string being an unset `right`.
    // Watched 2026-09-09.
    expect(preview.style.right).toBe('24px');
    expect(preview.style.left).toBe('auto');
    expect(preview.style.maxWidth).toBe('min(640px, 100vw)');
  });

  itDom('leaves every other card its own width', () => {
    // The widening is the scrolling card's alone: a folded step's figure is
    // four words and a 640px box around them is a card that covers three rows
    // to say "4.8 days".
    //
    // Proof: the `scrolls ?` conditional on `maxWidth` collapsed to the wide
    // branch — failed on `expected '640px' to be '420px'`. Watched 2026-08-11.
    render(<HoverCard label="Dev for 010">4.8 days</HoverCard>);

    expect(screen.getByRole('tooltip').style.maxWidth).toBe('420px');
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
      <HoverCard label="Facts for 3.2" anchor={{ left: 120, top: 200, bottom: 228 }}>
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
    expect(surfacePlacement({ left: 100, top: 200, bottom: 228 }, CARD, SCREEN)).toEqual({
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
    expect(surfacePlacement({ left: 100, top: 750, bottom: 774 }, CARD, SCREEN)).toEqual({
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
    expect(surfacePlacement({ left: 950, top: 200, bottom: 228 }, CARD, SCREEN)).toEqual({
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
      surfacePlacement({ left: 10, top: 30, bottom: 58 }, CARD, { width: 200, height: 100 }),
    ).toEqual({ left: 0, top: 0 });
  });
});

describe('a scrolling card takes the room its cell leaves it', () => {
  /** A 1000px-tall window, so a cell at 400 has 594 below it and 394 above. */
  const WINDOW_HEIGHT = 1000;
  /**
   * That window as the box a card is clipped by.
   *
   * A box rather than a height since `unified-scroll-docking`: the frame the
   * cells sit in is only as tall as its own rows now, so what clips a card is
   * the frame where there is one and the window where there is not. These cases
   * are all about the window, which starts at zero.
   */
  const WINDOW = { top: 0, bottom: WINDOW_HEIGHT };

  itDom('opens downward, as tall as the room below, for a cell high on the screen', () => {
    // Proof: `below >= above` flipped to `below > above` changes nothing here,
    // so the branch is proven by the test below instead; the *ceiling* is what
    // this one holds. `Math.max(below, above, …)` reduced to `above` — failed
    // on `expected { side: 'below', maxHeight: 194 } to deeply equal { side:
    // 'below', maxHeight: 794 }`, a card given the empty room behind it.
    // Watched 2026-08-11.
    expect(roomForCard({ top: 200, bottom: 200 }, WINDOW)).toEqual({
      side: 'below',
      maxHeight: 794,
    });
  });

  itDom('flips above when the cell is low enough that above has more room', () => {
    // The branch the change exists for: at 320px a card below this cell was
    // merely cramped, at 700px it is off the bottom of the screen entirely.
    //
    // Proof: the side forced to `'below'` — failed on `expected { side:
    // 'below', … } to deeply equal { side: 'above', … }`, and the browser's
    // half (`opens the card above a row low in the table`) failed with it.
    // Watched 2026-08-11.
    expect(roomForCard({ top: 800, bottom: 830 }, WINDOW)).toEqual({
      side: 'above',
      maxHeight: 794,
    });
  });

  itDom('never takes more than nine tenths of the window', () => {
    // A cell at the very top of a tall window has almost the whole of it below,
    // and a card that tall is one whose top edge is under the toolbar and whose
    // bottom is on the status bar.
    //
    // Proof: the `Math.min` against the share dropped — failed on `expected {
    // side: 'below', maxHeight: 994 } to deeply equal { side: 'below',
    // maxHeight: 900 }`. Watched 2026-08-11.
    expect(roomForCard({ top: 0, bottom: 0 }, WINDOW)).toEqual({
      side: 'below',
      maxHeight: 900,
    });
  });

  itDom('gives a card on the fold a floor to be readable in', () => {
    // A window 300px tall with the cell across its middle: 130 below, 144
    // above. Sized to either, the card holds a heading and one line.
    //
    // Proof: `SCROLLING_MIN_HEIGHT` dropped from the `Math.max` — failed on
    // `expected { side: 'above', maxHeight: 144 } to deeply equal { side:
    // 'above', maxHeight: 160 }`. Watched 2026-08-11.
    expect(roomForCard({ top: 150, bottom: 164 }, { top: 0, bottom: 300 })).toEqual({
      side: 'above',
      maxHeight: 160,
    });
  });

  itDom('gives a card no room rather than less than none when its frame is off screen', () => {
    // Both reviewers, 2026-08-12, agy with the arithmetic. The caller hands
    // this function the frame ∩ the window, and a frame scrolled entirely off
    // the top of the window intersects it in nothing: `{top: max(0, -900),
    // bottom: min(1000, -200)}` is `{0, -200}`, a box whose bottom is above its
    // top. Nine tenths of a negative height is a card told to be shorter than
    // nothing. Hardening rather than a bug fix — a card opens on hover and a
    // cell nobody can point at cannot be hovered — so what it is pinned to is
    // the arithmetic, not a pointer.
    //
    // Proof: the `Math.max` against the container's own top dropped — failed on
    // `expected { side: 'below', maxHeight: -180 } to deeply equal { side:
    // 'below', maxHeight: 0 }`. Watched on h2puni, 2026-08-13.
    expect(roomForCard({ top: -500, bottom: -472 }, { top: 0, bottom: -200 })).toEqual({
      side: 'below',
      maxHeight: 0,
    });
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
    ).toEqual({ side: 'right', align: 'top' });
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
    ).toEqual({ side: 'left', align: 'top' });
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
    ).toEqual({ side: 'right', align: 'top' });
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
    ).toEqual({ side: 'right', align: 'bottom' });
  });
});
