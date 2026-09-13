import type { Page } from '@playwright/test';

/**
 * What is painted on top at one point of the page, as far as an open hover card
 * is concerned: `'the card'`, or the tag name of whatever else is there.
 *
 * A hit test taken with the card's `pointer-events` momentarily set to `auto`
 * and restored — that property decides whether hit testing *sees* a box and has
 * nothing to do with which box is on top. Three simpler oracles were tried for
 * this question first and none of them can answer it:
 *
 * - `elementFromPoint` on its own reports whatever is **beneath** the card,
 *   because a card is `pointer-events: none`. Read as "the card is not there",
 *   it invented a defect that was never in the app (R5 #27).
 * - Two screenshots, card open against pointer moved away, differ whether the
 *   card was painted or not: moving the pointer away also unlights its row
 *   (R5 #26).
 * - One painted pixel of the overlap is a fact about the font — `--popover` and
 *   `--cell-bg` are both white, so the two reads differ only where that pixel
 *   lands on the card's own text. Green on a Mac, red on Linux.
 */
export async function cardIsOnTopAt(page: Page, at: { x: number; y: number }): Promise<string> {
  return page.evaluate((point) => {
    const card = document.querySelector('[role="tooltip"]');
    if (!(card instanceof HTMLElement)) throw new Error('no card is open');
    const was = card.style.pointerEvents;
    card.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(point.x, point.y);
    card.style.pointerEvents = was;
    if (hit === null) return 'nothing';
    return hit.closest('[role="tooltip"]') === null ? hit.tagName : 'the card';
  }, at);
}
