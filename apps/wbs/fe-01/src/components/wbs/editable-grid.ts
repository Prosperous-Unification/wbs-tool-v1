import type { CellRef } from './cell-navigation';

/**
 * The two element types a cell can be.
 *
 * A `<textarea>` is what makes a long name wrap instead of scrolling out of
 * sight, and it carries the same `selectionStart`/`selectionEnd`/`value` the
 * keyboard code reads — so Tab, Backspace and the arrows keep working without
 * knowing which one they are standing in.
 */
export type CellElement = HTMLInputElement | HTMLTextAreaElement;

/** Whether an event target is one of the two elements a cell can be. */
export function isCellElement(node: unknown): node is CellElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

/** The logical address written on a cell element, or null for unrelated or malformed markup. */
export function cellRefOf(node: unknown): CellRef | null {
  if (!isCellElement(node)) return null;
  const parts = (node.dataset['cell'] ?? '').split('::');
  const [rowId, columnId] = parts;
  return parts.length === 2 && rowId !== '' && columnId !== '' ? { rowId, columnId } : null;
}

/** The `data-cell` value for one editable cell, and the selector that finds it. */
export const cellKey = (rowId: string, columnId: string): string => `${rowId}::${columnId}`;

/**
 * The attribute that marks the container every editable cell lives inside.
 *
 * One grid per renderer, and the renderer decides what element carries it: the
 * desktop table puts it on `<table>`, and `M mobile-cards` will put it on the
 * list that replaces it. Everything in this module reads the container through
 * this attribute for that reason — it used to be `closest('table')`, which is a
 * sentence about one renderer's markup rather than about the grid, and a card
 * that is not a table would have found no grid at all and silently lost every
 * arrow key (agy #11).
 *
 * The desktop table has carried the attribute since `F shadcn-foundation`,
 * where it scopes the vendored components' CSS reset — see `wbs-table.tsx`.
 *
 * Proof that the anchor is load-bearing rather than decorative: pointed at
 * `[data-grid-that-is-not-there]`, 26 tests failed — every Tab, every arrow
 * between cells, `steps over the date cell until the plan is on a calendar`,
 * and the Cmd+Enter walk. Watched, 2026-08-09.
 */
const GRID_SELECTOR = '[data-grid]';

/**
 * The grid `node` is a cell of, or null when it is in none.
 *
 * Null is a modeled answer, not a missing one: a box outside any grid is what
 * a keystroke in a toolbar field looks like, and the caller leaves the key to
 * the browser rather than taking it.
 */
export function gridOf(node: Element): HTMLElement | null {
  const grid = node.closest(GRID_SELECTOR);
  return grid instanceof HTMLElement ? grid : null;
}

/**
 * The `data-cell` of whatever holds the focus, or null when that is not a cell
 * of the grid at all — a ⋯ button, a toolbar button, or nothing.
 *
 * Null is a real answer here rather than a missing one: "the reader is not
 * standing in a cell" is exactly the state a command taken from the actions
 * menu leaves behind, and it is what tells a pending focus intent apart from a
 * reader who has moved on.
 */
export function focusedCellKey(): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? (active.dataset['cell'] ?? null) : null;
}

/**
 * Whether a list is open somewhere in the grid: the folded cell's `@`
 * mentions, the dependency picker, or a `CreatablePicker`'s.
 *
 * Read from the committed DOM rather than from the three pieces of state that
 * can open one, for {@link editableGrid}'s reason and one more: they are three,
 * and a fourth list would have to remember to join them here.
 */
export const aListIsOpenIn = (grid: HTMLElement): boolean =>
  grid.querySelector('[role="listbox"]') !== null;

/** Where a keyboard arrival puts the caret: over the whole value, or at one offset. */
export type Landing = 'all' | number;
export type CellLanding = 'all' | 'start' | 'end' | 'focus';
export type CellAttacher = (cell: CellRef, landing: CellLanding) => boolean;

/**
 * Focuses a cell and places its caret, where the element has a caret to place.
 *
 * A date input has none. `setSelectionRange` throws `InvalidStateError` on one,
 * and `select()` has nothing to select there either, so the caret half is asked
 * for only of a textarea or a text input and everything else is simply focused
 * — which is all a date cell needs to be arrived in.
 *
 * Proof: the element check removed, `the arrows land in a date cell without
 * asking it for a caret it has none of` failed with `InvalidStateError` thrown
 * out of the arrow handler. Watched, 2026-08-07.
 */
export function focusCellAt(input: CellElement, landing: Landing): void {
  input.focus();
  if (!(input instanceof HTMLTextAreaElement) && input.type !== 'text') return;
  if (landing === 'all') input.select();
  else input.setSelectionRange(landing, landing);
}

/**
 * Every editable cell in the committed grid, paired with the input that is it.
 *
 * Kept as pairs, so the cell a move names and the input it focuses cannot
 * drift apart — an index into two separately filtered lists is one dropped
 * entry away from focusing the wrong box. Read from the DOM at the moment a
 * key arrives, never from a ref written during render: the committed DOM is
 * the only thing that cannot be ahead of itself.
 *
 * `readonly` keeps the focus off a parent's rolled-up figures, and `disabled`
 * off the earliest-start cell of a plan with no start date — a cell that
 * refuses the focus is a keystroke that takes the key and lands nothing.
 * Proof: `:not([disabled])` dropped, `steps over the date cell until the plan
 * is on a calendar` failed with the focus left where it started. Watched,
 * 2026-08-07.
 */
export function editableGrid(grid: HTMLElement): { input: CellElement; cell: CellRef }[] {
  return [
    ...grid.querySelectorAll<CellElement>('[data-cell]:not([readonly]):not([disabled])'),
  ].flatMap((input) => {
    // A `data-cell` that is not `row::column` is markup this component did
    // not write. Skipped rather than guessed at, and not thrown on: a
    // keystroke is not the moment to take the table down.
    const cell = cellRefOf(input);
    return cell === null ? [] : [{ input, cell }];
  });
}

/** The cell of `grid` that `wanted` names, or undefined when it is not on screen. */
export function cellIn(grid: HTMLElement, wanted: CellRef): CellElement | undefined {
  return editableGrid(grid).find(
    (candidate) =>
      candidate.cell.rowId === wanted.rowId && candidate.cell.columnId === wanted.columnId,
  )?.input;
}

/**
 * Focuses the logical cell `delta` places from `from`, selecting its text the
 * way the browser's own Tab leaves a field. The supplied order chooses the
 * destination; the DOM is consulted only to attach it. False at the grid's
 * edge or while the destination is not mounted — the caller then leaves the
 * key to the browser rather than eating it.
 */
export function focusAdjacentCell(
  input: CellElement,
  cells: readonly CellRef[],
  from: CellRef,
  delta: 1 | -1,
  attach?: CellAttacher,
): boolean {
  const grid = gridOf(input);
  if (grid === null) return false;
  const at = cells.findIndex(
    (cell) => cell.rowId === from.rowId && cell.columnId === from.columnId,
  );
  if (at === -1) return false;
  // `.at(-1)` wraps to the far end, which would turn Shift+Tab in the first
  // cell into a jump to the last one instead of leaving the key alone.
  // Proof: the guard removed so the index reached `.at(-1)`, `at the edges of
  // the grid the key is left to the browser` failed — the key was taken and
  // the focus jumped to the last cell of the table. Watched, 2026-08-07.
  const next = at + delta < 0 ? undefined : cells.at(at + delta);
  if (next === undefined) return false;
  const target = cellIn(grid, next);
  if (target === undefined) return attach?.(next, 'all') ?? false;
  focusCellAt(target, 'all');
  return true;
}
