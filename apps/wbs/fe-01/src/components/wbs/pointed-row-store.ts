/**
 * The **pointed row**, held outside React state so that pointing costs no
 * render of the plan.
 *
 * These three readings were `useState`s at the top of `WbsTable` until
 * `pointed-row-render-cost`, and that address was the whole of the cost: the
 * cells read their live state through the `live.current` ref and rely on every
 * parent render reaching every cell, so one pointed-row write re-rendered all
 * of them and the whole Gantt — 75–120ms of JS per row the pointer crossed,
 * measured in Chromium. A store lets exactly the interested parties subscribe:
 * each row's `<tr>` shell asks "am I the pointed row", the chart shell asks
 * "which row is pointed", and nothing else renders at all.
 *
 * **Why three readings and not one.** `pointTable` is the pointer on a plan
 * renderer row; `pointChart` carries the Gantt panel's two reports. The chart's
 * pointer and focus are two fields because they come and go independently — a
 * bar's blur must not clear a light the pointer is holding. The pointer wins
 * while both are live, because the pointer is where the eyes are. Bars are
 * controls (`role="button"`, `tabIndex={0}`), so the focus half is what a
 * reader who never touches a mouse gets.
 *
 * **The table's remembered hover yields once its row is no longer shown.**
 * `pointTable`'s reading is cleared by one thing only: a departure from that
 * same `<tr>`. A row can stop being drawn with the pointer sitting still on it
 * — a search narrows it away, a collapse folds it into its parent, a peer
 * deletes it — and no browser fires a departure at a node it is unmounting. The
 * remembered id then names a row that is not on screen, and on the left of the
 * fallthrough it would outrank the live reading of a pointer that has moved to
 * the chart — the chart dark under the pointer, which Dany reported on
 * 2026-08-31. So {@link PointedRows.setShownRows} keeps the guard's world
 * current, and a remembered row outside it resolves as if nothing were
 * remembered. The chart's two readings need no such guard: they are only ever
 * compared against the rows being drawn, so a stale id there lights nothing
 * and suppresses nothing.
 *
 * Proof: the guard dropped to a bare fallthrough, and `falls to the chart when
 * the pointed table row is no longer shown` failed on `expected 'gone' to be
 * 'kept'` — the remembered row outranking the pointer's live answer. Watched
 * 2026-09-01, with the browser's half (that Chromium really does leave the id
 * behind) in `e2e/hover-cards.spec.ts`.
 *
 * Listeners are told only when the **resolved** row changes: `setShownRows` is
 * pushed after every `WbsTable` commit, and a push that moves nothing must not
 * wake every row's subscription. Proof: the change guard removed, `says
 * nothing when the shown rows change and the resolution does not` failed on
 * `expected [ 'told' ] to deeply equal []` — and `says nothing on a repeated
 * arrival at the row already pointed` with it. Watched 2026-09-01.
 */
export interface PointedRows {
  /** Tells `onChange` whenever {@link pointedAt}'s answer changes. */
  subscribe: (onChange: () => void) => () => void;
  /** The one work item both faces light, or null while nothing is pointed. */
  pointedAt: () => string | null;
  /** The pointer arrived on a plan renderer row. */
  pointTable: (rowId: string) => void;
  /**
   * The pointer left a plan renderer row. Clears only if that row is still the
   * pointed one: when the pointer moves straight to the next row, the arrival
   * lands before this departure, and clearing unconditionally would blink out
   * the light the arrival had just set.
   */
  leaveTable: (rowId: string) => void;
  /**
   * The Gantt panel's report of which row the pointer or a bar's focus is on —
   * null when it leaves. Each `from` writes its own reading and nothing else,
   * so a blur cannot clear what the pointer holds.
   */
  pointChart: (rowId: string | null, from: 'pointer' | 'focus') => void;
  /** The rows the plan renderer is drawing — the shown-row guard's world. */
  setShownRows: (shown: ReadonlySet<string>) => void;
}

/** One {@link PointedRows} for one mounted plan. */
export function createPointedRows(): PointedRows {
  let tablePointed: string | null = null;
  let chartPointed: string | null = null;
  let chartFocused: string | null = null;
  let shownRows: ReadonlySet<string> = new Set();
  let resolved: string | null = null;
  const listeners = new Set<() => void>();

  const resolve = (): void => {
    const tableShown = tablePointed !== null && shownRows.has(tablePointed) ? tablePointed : null;
    const now = tableShown ?? chartPointed ?? chartFocused;
    if (now === resolved) return;
    resolved = now;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    pointedAt: () => resolved,
    pointTable: (rowId) => {
      tablePointed = rowId;
      resolve();
    },
    leaveTable: (rowId) => {
      if (tablePointed !== rowId) return;
      tablePointed = null;
      resolve();
    },
    pointChart: (rowId, from) => {
      if (from === 'pointer') chartPointed = rowId;
      else chartFocused = rowId;
      resolve();
    },
    setShownRows: (shown) => {
      shownRows = shown;
      resolve();
    },
  };
}
