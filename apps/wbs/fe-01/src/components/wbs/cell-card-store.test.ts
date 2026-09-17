import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCellCards, REACH_FOR_THE_CARD_MS, TAKEOVER_MS } from './cell-card-store';

/**
 * The reach, as the store keeps it: a card is held for
 * {@link REACH_FOR_THE_CARD_MS} after the pointer leaves what opened it, and
 * only an **arrival** — back on the trigger, or on the card — keeps it past
 * that.
 *
 * Every case here is about the moment between the leave and the close, which
 * is where the 2026-09-11 fault lived: a cell the hand crossed on the
 * way out wrote the store a same-cell clear that changed nothing, and the store
 * read every write as an arrival. No unit test can walk a pointer through a
 * cell; `e2e/hover-cards.spec.ts` does, and this file says what the store
 * promised it.
 */
describe('the cell-card store’s reach', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a held card when the reach runs out', () => {
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS - 1);
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(1);
    expect(cards.openCard()).toBeNull();
  });

  it('closes it however many cells the hand crosses on the way out', () => {
    // Dany, 2026-09-11: _"cursor away from notes icon & the preview pop-up
    // for N ms => remove the preview"_. A cell with no card of its own writes
    // a same-cell clear as the pointer leaves it — the guard every leave here
    // carries, because a leave lands after the next cell's enter — and that
    // is a departure, not an arrival: it must not touch a hold another cell
    // started.
    // Proof: `stopHolding()` put back at the top of `updateHovered` — this
    // failed on `expected 'a:name' to be null`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.updateHovered((current) => (current === 'a:depends' ? null : current));
    cards.updateHovered((current) => (current === 'b:depends' ? null : current));
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBeNull();
  });

  it('keeps the card while the pointer is back on what opened it', () => {
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOn('a:name');
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBe('a:name');
  });

  it('keeps the card the pointer arrived on, not the one it left', () => {
    // The arrival elsewhere is a takeover, so it lands after {@link TAKEOVER_MS};
    // the reach the first card's leave started must not then close the second.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOn('b:start');
    vi.advanceTimersByTime(TAKEOVER_MS);
    expect(cards.openCard()).toBe('b:start');
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBe('b:start');
  });

  it('lets the card keep itself once the pointer lands on it', () => {
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOnCard();
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBe('a:name');
  });

  it('closes a card its own cell clears at once, hold or no hold', () => {
    const cards = createCellCards();
    cards.arriveOn('a:depends');
    cards.holdHovered('a:depends');
    cards.updateHovered((current) => (current === 'a:depends' ? null : current));
    expect(cards.openCard()).toBeNull();
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBeNull();
  });

  it('tells its subscribers when the held card goes, and not before', () => {
    // The card is drawn from a subscription ({@link useCardOpenOn}), so a
    // store that closed the card and told nobody would leave it on screen.
    // Proof: `stopHolding()` put back at the top of `updateHovered` — this
    // failed on `expected "vi.fn()" to be called 1 times, but got 0 times`.
    // Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    const told = vi.fn();
    cards.subscribe(told);
    cards.holdHovered('a:name');
    cards.updateHovered((current) => (current === 'a:depends' ? null : current));
    expect(told).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS);
    expect(told).toHaveBeenCalledTimes(1);
  });
});

/**
 * The takeover: an open card gives way to another cell's trigger only once
 * the pointer has **rested** there for {@link TAKEOVER_MS}. Dany, 2026-09-11:
 * _"i need for cursor in flight while the notes pop-up is open - to have a
 * small delay between when cursor is away from the cell and over another
 * pop-up triggering place and moment when current pop-up disappears"_.
 */
describe('the cell-card store’s takeover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens at once when nothing is open', () => {
    // Proof: every arrival made to wait — this failed on `expected null to be
    // 'a:name'`, with eight more. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    expect(cards.openCard()).toBe('a:name');
  });

  it('gives an open card to another trigger only after the pointer has rested there', () => {
    // Proof: the takeover branch in `arriveOn` made to land at once — this
    // failed on `expected 'a:depends' to be 'a:name'`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.arriveOn('a:depends');
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(TAKEOVER_MS - 1);
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(1);
    expect(cards.openCard()).toBe('a:depends');
  });

  it('keeps the card the hand reaches, whatever trigger it crossed on the way', () => {
    // Proof: `arriveOnCard` no longer dropping the takeover — this failed on
    // `expected 'a:depends' to be 'a:name'`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    // Off the marker, across the Depends cell beside it, onto the preview.
    cards.holdHovered('a:name');
    cards.arriveOn('a:depends');
    cards.arriveOnCard();
    vi.advanceTimersByTime(TAKEOVER_MS + REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBe('a:name');
  });

  it('drops a takeover the pointer leaves behind, and the reach still closes the first card', () => {
    // Proof: `leave` no longer dropping the takeover — this failed on `expected
    // 'a:depends' to be 'a:name'`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOn('a:depends');
    cards.leave('a:depends');
    vi.advanceTimersByTime(TAKEOVER_MS);
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS - TAKEOVER_MS);
    expect(cards.openCard()).toBeNull();
  });

  it('drops a takeover when the trigger is left with a hold of its own, and keeps the first card’s hold', () => {
    // The marker and the links cell hold rather than clear on leave — and a
    // hold named for a cell that is not the open one must not replace the hold
    // that is going to close the open one.
    // Proof: `holdHovered` no longer dropping the takeover — `expected 'b:name'
    // to be 'a:name'`; its same-cell guard removed instead — `expected 'a:name'
    // to be null`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOn('b:name');
    cards.holdHovered('b:name');
    vi.advanceTimersByTime(TAKEOVER_MS);
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(REACH_FOR_THE_CARD_MS - TAKEOVER_MS);
    expect(cards.openCard()).toBeNull();
  });

  it('coming back to its own trigger keeps the card', () => {
    // Proof: `land` no longer cancelling the hold — this failed on `expected
    // null to be 'a:name'`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.holdHovered('a:name');
    cards.arriveOn('a:depends');
    cards.arriveOn('a:name');
    vi.advanceTimersByTime(TAKEOVER_MS + REACH_FOR_THE_CARD_MS);
    expect(cards.openCard()).toBe('a:name');
  });

  it('restarts the delay for a second trigger reached inside it', () => {
    // Proof: the takeover branch made to land at once — this failed on
    // `expected 'b:name' to be 'a:name'`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    cards.arriveOn('a:depends');
    vi.advanceTimersByTime(TAKEOVER_MS - 10);
    // On to the next row's marker before the Depends cell's delay ran out.
    cards.arriveOn('b:name');
    vi.advanceTimersByTime(10);
    expect(cards.openCard()).toBe('a:name');
    vi.advanceTimersByTime(TAKEOVER_MS - 10);
    expect(cards.openCard()).toBe('b:name');
  });

  it('tells its subscribers once, when the takeover lands', () => {
    // Proof: the takeover branch made to land at once — this failed on
    // `expected "vi.fn()" to not be called at all, but actually been called 1
    // times`. Watched, 2026-09-11.
    const cards = createCellCards();
    cards.arriveOn('a:name');
    const told = vi.fn();
    cards.subscribe(told);
    cards.arriveOn('a:depends');
    expect(told).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAKEOVER_MS);
    expect(told).toHaveBeenCalledTimes(1);
  });
});
