import { useSyncExternalStore } from 'react';

/**
 * Which cell's hover card is on screen, held outside React state so that
 * moving the pointer across a cardable cell costs no render of the plan.
 *
 * `hoveredCell` and `focusedCell` were `useState`s at the top of `WbsTable`
 * until this change, and the address was the whole of the cost — the same cost
 * {@link createDepLights} and `pointed-row-store.ts` were written for. The
 * cells read their live state through `live.current` and rely on every parent
 * render reaching every cell, so one pointer move onto a Name cell re-rendered
 * every row, every cell and the whole Gantt to draw one card. `plan-cell-props`
 * said so in its own JSDoc — *"`hoveredCell` lives on the table, so every
 * boundary the pointer crosses costs one render of the whole of it"* — and
 * guarded the write on having something to show, which narrows the cost without
 * moving it. This is W2-7's cell half, deferred out of W4-4 in writing and
 * named there as R10's.
 *
 * **Two readings and one resolution**, exactly as the two states were. `hovered`
 * is the pointer's, `focused` is the keyboard's, they are set and cleared by
 * gestures that do not take turns, and the pointer wins while both are live
 * because it is the deliberate act of the moment. Both writers keep their
 * functional updaters — every one of them is guarded on the cell it belongs to,
 * because a leave lands after the next cell's enter — so
 * {@link CellCards.updateHovered} takes the same `(current) => next` a
 * `useState` setter did, and `hoveredCellAfterRefresh` still reads as one.
 *
 * Listeners are told only when the **resolved** cell changes: a hover that
 * writes the key already there, or a focus write underneath a live hover, wakes
 * nobody. Every cardable cell on screen is a subscriber, so waking them all to
 * answer "still not mine" is the render this store exists to stop.
 */
export interface CellCards {
  /** Tells `onChange` whenever the cell whose card is open changes. */
  subscribe: (onChange: () => void) => () => void;
  /**
   * The cell whose card is on screen, as a `cellKey`, or null.
   *
   * Read by the writers' own guards — which ask "is this still mine" — and by
   * {@link useCardOpenOn}. A cell that draws a card asks the hook, never this:
   * a subscription on the string would wake on every card anywhere.
   */
  openCard: () => string | null;
  /**
   * The pointer arrived on `cell`.
   *
   * With nothing open, or back on the open card's own trigger, its card is on
   * screen at once and any pending {@link CellCards.holdHovered} is cancelled —
   * the card the pointer is on must not be closed by a timer the previous cell
   * started, and the cell it came back to must not lose its card to the hold
   * its own leave began.
   *
   * With **another** cell's card open, this is a **takeover** and it waits
   * {@link TAKEOVER_MS}: the card changes only if the pointer is still here
   * when the delay runs out. Every in-cell card opens diagonally — past its
   * cell and past its row — so the hand going from the notes marker to the
   * preview crosses the Depends cell beside it, or the next row's marker, and
   * both are triggers. Until 2026-09-11 either took the card over the moment
   * the pointer entered it. Dany: _"i need for cursor in flight while the
   * notes pop-up is open - to have a small delay between when cursor is away
   * from the cell and over another pop-up triggering place and moment when
   * current pop-up disappears; same for links, deps"_.
   *
   * A pending takeover is dropped by {@link CellCards.arriveOnCard} (the hand
   * got where it was going), by {@link CellCards.leave} or
   * {@link CellCards.holdHovered} naming the pending cell (the hand moved on),
   * and by a later arrival anywhere (which starts its own).
   *
   * The pointer's enter handlers call this and nothing else does. It is the
   * one write that means "the hand is here"; a keyboard focus goes through
   * {@link CellCards.updateFocused}, so a focus never waits behind a pointer
   * rule.
   */
  arriveOn: (cell: string) => void;
  /**
   * The pointer left `cell`: a takeover aimed at it is dropped, and its card —
   * if it is the one open — closes at once.
   *
   * The same-cell guard every leave carries, because a leave lands after the
   * next cell's enter: a cell whose card is not the open one clears nothing.
   * For a card a reader may point at, {@link CellCards.holdHovered} is the
   * leave instead.
   */
  leave: (cell: string) => void;
  /**
   * The pointer's reading revised without an arrival, as a `useState` setter
   * took it: a refresh settling the open card against the rows that just
   * arrived (`hoveredCellAfterRefresh`). The leave handlers' same-cell clears
   * went through here until the takeover, and are {@link CellCards.leave} now.
   *
   * **Does not touch a pending {@link CellCards.holdHovered}.** It did until
   * 2026-09-11, on the reasoning that a write means the pointer has arrived
   * somewhere — and a same-cell clear from a cell with no card of its own is a
   * write that changes nothing. The notes marker is the right edge of the Name
   * cell, so the hand leaving it crossed the Depends cell beside it inside the
   * reach, that cell's leave cancelled the hold, and the preview stayed for as
   * long as the pointer kept off anything that opens a card of its own (Dany:
   * _"notes md preview pop-up does not go away if i move cursor away, but then
   * move it up or down to other table elements"_). A departure is not an
   * arrival; only {@link CellCards.arriveOn} and {@link CellCards.arriveOnCard}
   * keep a held card.
   *
   * A clear of the held cell itself is still immediate: `hovered` goes to null
   * and the hold finds nothing of its own to close.
   */
  updateHovered: (next: (current: string | null) => string | null) => void;
  /**
   * Clears `cell` after a moment, unless something writes in the meantime.
   *
   * **The reach.** Every card a plan cell opens hangs diagonally off it since
   * 2026-09-10 — past the column so the column can be run down, past the row so
   * the row stays readable — so the hand going to a card a reader may point at
   * (the notes preview, which scrolls; the links card, whose lines are links)
   * leaves the cell on the way, and an immediate clear loses the card under it.
   * Dany: *"make it available to switch cursor and hover over the md preview if
   * moving cursor fast"*.
   *
   * In the store rather than in the cells because **arriving** is what cancels
   * it, and arriving is {@link CellCards.arriveOn}: a cell that opens its own
   * card cancels the previous cell's hold without knowing it exists. The first
   * cut put the timer in the cells and the dependency cell's card died to a
   * hold started before the pointer came back — 120 seconds of `waiting for
   * locator('[role="tooltip"]')`, in Chromium.
   *
   * Only the open card's own trigger holds anything: a hold named for any
   * other cell drops a takeover aimed at that cell and does nothing else. It
   * used to replace whatever hold was running — harmless while every arrival
   * was instant, and with the takeover it would have let the marker the hand
   * crossed cancel the hold on the card it was leaving.
   *
   * Nothing but an arrival cancels it. Dany's rule, 2026-09-11: *"cursor away
   * from notes icon & the preview pop-up for N ms => remove the preview"* —
   * whatever else the hand crosses on the way.
   */
  holdHovered: (cell: string) => void;
  /**
   * The pointer landed **on the open card**: a pending
   * {@link CellCards.holdHovered} and a pending takeover are both dropped, and
   * nothing is written.
   *
   * The one arrival that is not a write. A card is a child of its cell's
   * wrapper, so entering it is entering that wrapper — but the cell must not
   * re-open a card the marker alone is allowed to open (the Name cell's
   * preview, Dany's rule since 2026-08-09), so the arrival cancels and says
   * nothing else.
   *
   * Without the hold's half the card runs out while the reader is reading:
   * watched in Chromium as `the card closed while walking to item 2`, three
   * items into the links card. Without the takeover's half the Depends cell
   * the hand crossed on the way takes the card over under the reader.
   */
  arriveOnCard: () => void;
  /** The keyboard's reading, likewise. */
  updateFocused: (next: (current: string | null) => string | null) => void;
}

/**
 * How long a cell's card is held after the pointer leaves it, in milliseconds.
 *
 * 180ms, and the two numbers it sits between are why. The **floor** is the
 * travel: 260px from a trigger to its card at a flick's ~2000px/s is 130ms, so
 * anything under that loses the card under the hand it was written for. The
 * **ceiling** is Dany's eye — 300ms was the first cut and he asked for it
 * shorter on 2026-09-10 (*"ok, can you remove it just a bit faster"*), a card
 * that lingers being a card in the way.
 *
 * A hold that outlives the pointer by a moment costs nothing else: any
 * arrival cancels it, and the same-cell guard inside it means a card another
 * cell has opened is never the one closed.
 */
export const REACH_FOR_THE_CARD_MS = 180;

/**
 * How long the pointer rests on another cell's trigger before its card takes
 * an open card's place, in milliseconds.
 *
 * 50ms, Dany's figure. 100 shipped first, on the arithmetic that the path from
 * the notes marker to its preview's nearest corner runs ~26px through the
 * Depends cell beside it — 13ms at a flick, ~90ms at a deliberate 300px/s — and
 * he asked for it halved the day after, having watched it (_"maybe reduce it
 * to 50ms?"_, 2026-09-12): a card that waits 100ms under a hand that has
 * stopped is a card that hesitates. The flick is still covered, and a slow
 * hand that dwells on a live cell gets that cell's card, which is what dwelling
 * asks for. Running down a column of markers shows each card 50ms after
 * landing. One constant, judged in Chrome.
 */
export const TAKEOVER_MS = 50;

export function createCellCards(): CellCards {
  let hovered: string | null = null;
  let focused: string | null = null;
  let open: string | null = null;
  let holding: ReturnType<typeof setTimeout> | null = null;
  let takeover: { cell: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const listeners = new Set<() => void>();

  const stopHolding = (): void => {
    if (holding === null) return;
    clearTimeout(holding);
    holding = null;
  };
  const dropTakeover = (): void => {
    if (takeover === null) return;
    clearTimeout(takeover.timer);
    takeover = null;
  };
  const dropTakeoverAimedAt = (cell: string): void => {
    if (takeover?.cell === cell) dropTakeover();
  };

  const settle = (): void => {
    const next = hovered ?? focused;
    if (next === open) return;
    open = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    openCard: () => open,
    arriveOn: (cell) => {
      // Wherever the hand is now, it is not on the trigger it was waiting on.
      dropTakeover();
      const land = (): void => {
        // Proof: this `stopHolding()` removed — `keeps the card while the
        // pointer is back on what opened it` and `coming back to its own
        // trigger keeps the card` failed on `expected null to be 'a:name'`.
        // Watched, 2026-09-11.
        stopHolding();
        hovered = cell;
        settle();
      };
      // Proof: the `null` half removed, so that every arrival waited — nine
      // cases failed, `opens at once when nothing is open` on `expected null to
      // be 'a:name'`. Watched, 2026-09-11.
      if (hovered === null || hovered === cell) {
        land();
        return;
      }
      // Proof: the branch above made unconditional, so an arrival under an
      // open card landed at once — six takeover cases failed, `gives an open
      // card to another trigger only after the pointer has rested there` on
      // `expected 'a:depends' to be 'a:name'`; and in Chromium, with
      // `TAKEOVER_MS` at 0 (the same fault), `e2e/hover-cards.spec.ts`'s
      // `keeps the preview while the hand crosses a live trigger on its way to
      // it` on `the preview was taken over on the way · Expected: 1 · Received:
      // 0`. The timer's `land()` removed instead: `lets a pointer that rests on
      // another trigger take over` on `the rested-on cell opened no card ·
      // Expected: 1 · Received: 0`. Watched, 2026-09-11.
      takeover = {
        cell,
        timer: setTimeout(() => {
          takeover = null;
          land();
        }, TAKEOVER_MS),
      };
    },
    leave: (cell) => {
      // Proof: this drop removed — `drops a takeover the pointer leaves behind,
      // and the reach still closes the first card` failed on `expected
      // 'a:depends' to be 'a:name'`. Watched, 2026-09-11.
      dropTakeoverAimedAt(cell);
      if (hovered !== cell) return;
      hovered = null;
      settle();
    },
    // No `stopHolding()` here — see the interface: a departure written from
    // another cell must not keep the card the hand is leaving.
    // Proof: `stopHolding()` put back on the first line — `closes it however
    // many cells the hand crosses on the way out` failed on `expected 'a:name'
    // to be null`, `tells its subscribers when the held card goes, and not
    // before` on `expected "vi.fn()" to be called 1 times, but got 0 times`,
    // and `e2e/hover-cards.spec.ts`'s `goes when the hand leaves the marker
    // through the cell beside it` on `the preview stayed after the hand left ·
    // Expected: 0 · Received: 1`, in Chromium. Watched, 2026-09-11.
    updateHovered: (next) => {
      hovered = next(hovered);
      settle();
    },
    arriveOnCard: () => {
      // Proof: this drop removed — `keeps the card the hand reaches, whatever
      // trigger it crossed on the way` failed on `expected 'a:depends' to be
      // 'a:name'`. Watched, 2026-09-11.
      dropTakeover();
      stopHolding();
    },
    holdHovered: (cell) => {
      // Proof: the drop removed — `drops a takeover when the trigger is left
      // with a hold of its own, and keeps the first card’s hold` failed on
      // `expected 'b:name' to be 'a:name'`; the guard under it removed instead
      // — the same case on `expected 'a:name' to be null`, the open card's hold
      // replaced by an inert one for the crossed trigger. Watched, 2026-09-11.
      dropTakeoverAimedAt(cell);
      if (hovered !== cell) return;
      stopHolding();
      holding = setTimeout(() => {
        holding = null;
        if (hovered !== cell) return;
        hovered = null;
        settle();
      }, REACH_FOR_THE_CARD_MS);
    },
    updateFocused: (next) => {
      focused = next(focused);
      settle();
    },
  };
}

/**
 * Whether this cell is the one whose card is on screen.
 *
 * A boolean and not the key, so a card opening three rows away tells this cell
 * nothing: `useSyncExternalStore` compares what the getter returns, and every
 * cardable cell on a five-hundred-row plan subscribes.
 */
export function useCardOpenOn(cards: CellCards, cell: string): boolean {
  return useSyncExternalStore(
    cards.subscribe,
    () => cards.openCard() === cell,
    () => false,
  );
}
