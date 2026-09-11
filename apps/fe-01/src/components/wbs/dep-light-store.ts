/**
 * Which rows a hovered **Depends on** cell lights, held outside React state so
 * that pointing at a dependency costs no render of the plan.
 *
 * `depHover` and `depFocus` were `useState`s at the top of `WbsTable` until
 * 2026-09-02, and the address was the whole of the cost — the same cost
 * `pointed-row-store.ts` was written for: the cells read their live state
 * through `live.current` and rely on every parent render reaching every cell, so
 * one pointer move across a chip re-rendered every row, every cell and the whole
 * Gantt. A store lets exactly the interested parties subscribe: each row's `<tr>`
 * shell asks "am I lit", and an open card asks "which of my entries is
 * emphasised".
 *
 * **Two readings and one resolution**, exactly as they were. `hover` is the
 * pointer's and `focus` is the keyboard's, they are set and cleared by gestures
 * that do not take turns, and the pointer wins while both are live because it
 * is the deliberate act of the moment. The writers keep their functional
 * updaters — every one of them is guarded on the row and the pill it belongs to,
 * because a leave that lands after the next enter must not undo it — so
 * {@link DepLights.updateHover} takes the same `(current) => next` a
 * `useState` setter did.
 *
 * **The resolution is total over remembered state**, which is what keeps a
 * stale reading from lighting anything: a row the tree no longer holds lights
 * nothing, and a `pillId` the cell no longer names lights nothing. Both are
 * states a hover can really be in — a refetch can outlive a pointer, and the ✕
 * is the pill itself, so a click unmounts the element and the `mouseleave`
 * that would have cleared the id never fires.
 *
 * Listeners are told only when the **lit set** changes. `setDependsOnOf` is
 * pushed after every `WbsTable` commit, and a push that moves nothing must not
 * wake every row's subscription — `pointed-row-store.ts` learned that one the
 * hard way.
 */
export interface DepReading {
  rowId: string;
  /** One entry of that row's set, or null for the whole set. */
  pillId: string | null;
}

export interface DepLights {
  /** Tells `onChange` whenever the lit set changes. */
  subscribe: (onChange: () => void) => () => void;
  /** Whether a hovered Depends on cell names this row. */
  isLit: (rowId: string) => boolean;
  /**
   * The entry an open card on `rowId` should emphasise, or null.
   *
   * The **pointer's** reading alone, and guarded on the row: a card is only on
   * screen for the hovered cell, but a stale reading from another row would
   * otherwise emphasise an entry here.
   */
  pillFor: (rowId: string) => string | null;
  /** The pointer's reading, as a `useState` setter took it. */
  updateHover: (next: (current: DepReading | null) => DepReading | null) => void;
  /** The keyboard's reading, likewise. */
  updateFocus: (next: (current: DepReading | null) => DepReading | null) => void;
  /**
   * What each row waits for, as the tree last read it — the resolution's world.
   *
   * A function rather than a map, so a commit pushes one closure instead of
   * copying a list per row. `WbsTable` pushes it from the same effect that
   * pushes the pointed store's shown rows.
   */
  setDependsOnOf: (dependsOnOf: (rowId: string) => readonly string[] | undefined) => void;
}

export function createDepLights(): DepLights {
  let hover: DepReading | null = null;
  let focus: DepReading | null = null;
  let dependsOnOf: (rowId: string) => readonly string[] | undefined = () => undefined;
  let lit: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  /**
   * The rows a reading lights: the whole set for a cell, one entry for a pill.
   *
   * Read from the row's `dependsOn` and never from its own id — that row is
   * the successor, and lighting it would answer "what does this wait for" by
   * pointing at the question. Nothing filters the row back out of its own set,
   * because nothing can put it there: be-01's dependency service refuses an
   * edge that closes a cycle (`libs/core/src/service/dependency.ts`), and a row waiting for
   * itself is the shortest cycle there is.
   *
   * `pillId` is checked against the set rather than trusted, which is what
   * makes this total over remembered state rather than dependent on every
   * writer being right. See the `✕` case above.
   *
   * Both proofs are carried from `WbsTable`'s own derivation, which this
   * replaced. Read from the hovered row's id instead, `lights every
   * dependency's row from the cell, and no other row` failed on `expected
   * ['030'] to deeply equal ['010', '020']` — the successor lit, its
   * dependencies dark; watched 2026-08-10. The `includes` check dropped
   * together with the chip's widen, `widens back to the remaining dependencies
   * when a pill is deleted under the pointer` failed on `expected ['010'] to
   * deeply equal ['020']` — the cut edge still lit; watched 2026-08-11.
   */
  const resolve = (): ReadonlySet<string> => {
    const read = hover ?? focus;
    if (read === null) return new Set();
    const dependsOn = dependsOnOf(read.rowId);
    if (dependsOn === undefined) return new Set();
    if (read.pillId === null) return new Set(dependsOn);
    return dependsOn.includes(read.pillId) ? new Set([read.pillId]) : new Set();
  };

  /** The pointer's reading as the last notification left it — see {@link settle}. */
  let toldHover: DepReading | null = null;

  const settle = (): void => {
    const next = resolve();
    const sameLit = next.size === lit.size && [...next].every((rowId) => lit.has(rowId));
    // **Both**, and the second half is not redundant: a row with exactly one
    // dependency lights the same single row whether the pointer is on the cell
    // or on its one pill, so the lit set does not move — while
    // {@link DepLights.pillFor} does, and an open card's emphasis is drawn from
    // that. Comparing the set alone left the emphasis on a one-entry card
    // stuck at whatever it was when the card opened.
    const samePill = toldHover?.rowId === hover?.rowId && toldHover?.pillId === hover?.pillId;
    // A push or a write that moves neither tells nobody: every shown row is a
    // subscriber, and waking them all to answer "still not lit" is the render
    // this store exists to stop.
    if (sameLit && samePill) return;
    lit = next;
    toldHover = hover === null ? null : { ...hover };
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    isLit: (rowId) => lit.has(rowId),
    pillFor: (rowId) => (hover?.rowId === rowId ? hover.pillId : null),
    updateHover: (next) => {
      hover = next(hover);
      settle();
    },
    updateFocus: (next) => {
      focus = next(focus);
      settle();
    },
    setDependsOnOf: (next) => {
      dependsOnOf = next;
      settle();
    },
  };
}
