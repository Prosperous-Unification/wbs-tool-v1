import { describe, expect, it } from 'vitest';

import { MARKER_RULE_MAX_PER_100PX, markerRulesAreTooDense } from './marker-rule-density';

/**
 * Slice 8.3's arithmetic, on the function that owns it.
 *
 * Every case here is a 100px viewport, so `occupied / widthPx * 100` is just
 * the occupied count and the threshold reads as itself. The panel's own cases
 * still owe the wiring — that the chart asks this question, with the viewport
 * it really has, and that the off-screen rules stay in the DOM.
 */

/** A 100px scrollport at the 4px rung, starting at the day given. */
const at4px = (firstVisibleDay = 0) => ({ firstVisibleDay, widthPx: 100, dayPx: 4 });

/** The same 100px scrollport at a rung the fence is not a problem at. */
const atRung = (dayPx: number, firstVisibleDay = 0) => ({
  firstVisibleDay,
  widthPx: 100,
  dayPx,
});

describe('the marker rules’ density measure', () => {
  it('pins the constant at six, which every case below is written against', () => {
    // Asserted rather than imported into the expectations: a case reading
    // `MARKER_RULE_MAX_PER_100PX` on both sides would go on passing whatever
    // the constant became, and `design.md` §3 fixes it at six.
    expect(MARKER_RULE_MAX_PER_100PX).toBe(6);
  });

  it('draws six distinct dates in 100px — the boundary the `>` includes', () => {
    expect(markerRulesAreTooDense([0, 1, 2, 3, 4, 5], at4px())).toBe(false);
  });

  it('drops the rules at seven distinct dates in the same 100px', () => {
    expect(markerRulesAreTooDense([0, 1, 2, 3, 4, 5, 6], at4px())).toBe(true);
  });

  it('counts rule positions, so seven markers on one date are one', () => {
    // The fault this is about is a density measured over markers: the array
    // below is seven entries and one line on screen, and a chart that dropped
    // its rules here would blank a single marked day for being crowded by
    // itself.
    expect(markerRulesAreTooDense([3, 3, 3, 3, 3, 3, 3], at4px())).toBe(false);
  });

  it('never reaches the threshold at 28px, where 100px is 3.6 days', () => {
    // Not a scope assertion — it cannot be one. At 28px the viewport holds at
    // most four rule positions, so the count is unreachable whether the rung
    // is checked or not, and the offsets past 3.6 days prove the viewport is
    // what bounds it.
    //
    // The prose here says "viewport" throughout on purpose: `test-tiers.test.ts`
    // reads the bare browser-global spelling of that idea as evidence a suite
    // needs a DOM, and this file is in the fast tier. It caught the first draft
    // of this file, which is the guard doing exactly its job.
    expect(markerRulesAreTooDense([0, 1, 2, 3, 4, 5, 6, 7, 8], atRung(28))).toBe(false);
  });

  it('draws all seven at 12px, where 100px is 8.3 days and seven do fit', () => {
    // **The rung scope, and the only case that can see it.** `7 > 6` here, so
    // an implementation that measured density without checking the rung would
    // suppress — and would pass every 4px case above and the 28px case too.
    expect(markerRulesAreTooDense([0, 1, 2, 3, 4, 5, 6], atRung(12))).toBe(false);
  });

  it('counts only the dates inside the viewport, not the whole horizon', () => {
    // Six visible and four more marked days scrolled off to the right: `6 > 6`
    // is false, so the rules stand. An implementation that counted the horizon
    // would see ten and drop them.
    const horizon = [0, 1, 2, 3, 4, 5, 30, 31, 32, 33];
    expect(markerRulesAreTooDense(horizon, at4px())).toBe(false);
  });

  it('drops them once the viewport is scrolled onto a denser region', () => {
    // The same horizon, the viewport moved to where seven of its marked days
    // are: 25 days fit in 100px at 4px, so a viewport starting at day 26 holds
    // 26…50.
    const horizon = [0, 1, 2, 26, 27, 28, 29, 30, 31, 32];
    expect(markerRulesAreTooDense(horizon, at4px(26))).toBe(true);
  });

  it('answers false for a viewport with no width, rather than dividing by it', () => {
    // The first paint, before the scrollport has been measured. A `0 / 0` here
    // is `NaN`, `NaN > 6` is false and the rules would stand by accident; this
    // says so on purpose.
    expect(markerRulesAreTooDense([0, 1, 2, 3, 4, 5, 6], { ...at4px(), widthPx: 0 })).toBe(false);
  });
});
