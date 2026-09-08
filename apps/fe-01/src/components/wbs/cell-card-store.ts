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
  /** The pointer's reading, as a `useState` setter took it. */
  updateHovered: (next: (current: string | null) => string | null) => void;
  /** The keyboard's reading, likewise. */
  updateFocused: (next: (current: string | null) => string | null) => void;
}

export function createCellCards(): CellCards {
  let hovered: string | null = null;
  let focused: string | null = null;
  let open: string | null = null;
  const listeners = new Set<() => void>();

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
    updateHovered: (next) => {
      hovered = next(hovered);
      settle();
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
