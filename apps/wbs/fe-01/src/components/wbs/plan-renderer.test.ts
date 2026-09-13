import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CARDS_BELOW,
  rendererForViewport,
  TABLE_NEEDS_HEIGHT,
  useRendererForViewport,
} from './plan-renderer';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** jsdom's own defaults, which is what every other test in this app runs at. */
const LAPTOP = 1024;
const LAPTOP_TALL = 768;
const PHONE = 390;

/**
 * Resizes the window the way a rotation does: the size first, then the event
 * the page hears about it through.
 *
 * `window.innerWidth` and `innerHeight` are both writable in jsdom 24 (probed,
 * 2026-08-09 and 2026-08-23) and `matchMedia` is not there at all — which is
 * why the hook under test reads the two and not the one.
 */
function resizeTo(width: number, height = LAPTOP_TALL): void {
  act(() => {
    const w = window as unknown as { innerWidth: number; innerHeight: number };
    w.innerWidth = width;
    w.innerHeight = height;
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  cleanup();
  const w = window as unknown as { innerWidth: number; innerHeight: number };
  w.innerWidth = LAPTOP;
  w.innerHeight = LAPTOP_TALL;
});

describe('which renderer draws the plan', () => {
  /**
   * The boundary itself, which is the only interesting part of the arithmetic
   * and the only part a test can hold still.
   *
   * Proof: the comparison widened to `<=`, `768 is the table` failed on
   * `expected 'cards' to be 'table'` — a laptop window one pixel wide enough
   * for the table drawn as cards. Watched, 2026-08-09.
   */
  it('is cards below 768 and the table at it', () => {
    // At a tablet's height, so the width is the only thing being asked about
    // and the boundary is read where the sweep that found the landscape defect
    // read it: 767×1024 cards, 768×1024 table, one pixel apart.
    expect(rendererForViewport(CARDS_BELOW - 1, 1024)).toBe('cards');
    expect(rendererForViewport(CARDS_BELOW, 1024)).toBe('table');
  });

  it('is cards on a phone and the table on a laptop', () => {
    expect(rendererForViewport(PHONE, 844)).toBe('cards');
    expect(rendererForViewport(1400, 900)).toBe('table');
  });

  /**
   * The defect this rule was widened for: an iPhone 14 turned sideways is
   * 844 CSS px wide, which cleared a width-only test and put a 1471px
   * spreadsheet on a screen 390px tall. Measured on dev at `9b62ef1`.
   *
   * The two viewports are the same phone, so the answer must be the same
   * whichever way up it is held — that is the whole claim, and it is written as
   * a pair rather than as one landscape assertion so a rule that fixed
   * landscape by breaking portrait cannot pass.
   */
  it('is cards on a phone held either way up', () => {
    expect(rendererForViewport(390, 844)).toBe('cards');
    expect(rendererForViewport(844, 390)).toBe('cards');
  });

  /**
   * The boundary the height brings with it, held at both edges the same way the
   * width's is — a rule with a number in it is wrong at the number or nowhere.
   */
  it('is cards below the height floor and the table at it', () => {
    expect(rendererForViewport(1400, TABLE_NEEDS_HEIGHT - 1)).toBe('cards');
    expect(rendererForViewport(1400, TABLE_NEEDS_HEIGHT)).toBe('table');
  });

  /**
   * The two populations either side of that floor, named as the devices they
   * are, because the number was chosen to sit in the gap between them and a
   * later reader moving it deserves to see what it costs.
   *
   * The tablet is the load-bearing half: `Math.min(width, height) < 768` is the
   * obvious rule and passes every other case in this file, and this one — a
   * 1133×744 iPad mini in landscape — is where it draws cards on a tablet.
   */
  it('is the table on a landscape tablet and cards on the largest landscape phone', () => {
    expect(rendererForViewport(1133, 744)).toBe('table');
    expect(rendererForViewport(932, 430)).toBe('cards');
  });

  /**
   * The other rule that passes the landscape case and should not be taken: a
   * 1366×768 laptop screen leaves a viewport around 630px tall once the browser
   * has taken its chrome, and nobody on a mouse wants that answered as a phone.
   */
  it('is the table in a short window on a laptop', () => {
    expect(rendererForViewport(1366, 630)).toBe('table');
  });

  /**
   * The hook, and the whole reason it is a hook rather than a read: a window
   * that becomes narrow becomes cards without a reload, which is what a phone
   * being turned is.
   *
   * Proof: `subscribeToResize` replaced by one that registers nothing and
   * returns a no-op, `follows the window across the breakpoint, both ways`
   * failed on `expected 'table' to be 'cards'` — the renderer stuck at the
   * width the page was opened at. Watched, 2026-08-09.
   */
  itDom('follows the window across the breakpoint, both ways', () => {
    const held = renderHook(() => useRendererForViewport());
    expect(held.result.current).toBe('table');

    resizeTo(PHONE);
    expect(held.result.current).toBe('cards');

    resizeTo(LAPTOP);
    expect(held.result.current).toBe('table');
  });

  /**
   * The hook reading the height at all, which the pure function above cannot
   * prove: a rotation changes both numbers at once and the width alone goes the
   * **wrong way** — 390 → 844 is a window getting wider, and a hook that only
   * looked at `innerWidth` would answer a phone being turned with the table.
   */
  itDom('stays on cards when the phone is turned sideways', () => {
    resizeTo(390, 844);
    const held = renderHook(() => useRendererForViewport());
    expect(held.result.current).toBe('cards');

    resizeTo(844, 390);
    expect(held.result.current).toBe('cards');
  });
});
