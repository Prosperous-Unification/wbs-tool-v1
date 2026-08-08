import {
  createColumnHelper,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectStream } from '@/lib/project-stream';
import type { PersonView, TeamView } from '@/lib/wbs-api';
import {
  type Days,
  type EstimateMethod,
  isEstimateMethod,
  type ProjectApi,
  type RoleView,
} from '@/lib/wbs-api';

import { ActionsMenu } from './actions-menu';
import { type CellElement, CellInput, type CommitOutcome, flushCell, unsent } from './cell-input';
import { type Caret, type CellRef, commandMove, type Direction, nextCell } from './cell-navigation';
import { CreatablePicker, pickableLabel, PickerList, type PickerOption } from './creatable-picker';
import { pickerEntries, type PickerEntry } from './dep-picker';
import { parseDependencies, unknownMessage } from './depends-input';
import { type DropRefusal, type DropZone, planMove, zoneFor } from './drag-drop';
import {
  isTrioEmpty,
  parseTrioShorthand,
  type Point,
  POINTS,
  sendableTrio,
  trioProblem,
  type TypedTrio,
} from './estimate-draft';
import { type Command, commandChordIn, undoChord } from './keyboard-bindings';
import { KeyboardCheatSheet, opensCheatSheet } from './keyboard-cheat-sheet';
import { splitMention } from './mention';
import { composeNameCell, normalizeNewlines, splitNameCell } from './name-notes';
import { NotesPreview } from './notes-preview';
import { describeGaps, findEstimateGaps } from './plan-completeness';
import { type PlanExport, planFileName, planToCsv, planToMarkdown } from './plan-export';
import {
  CELL,
  FLEXIBLE_COLUMNS,
  flexibleCellStyle,
  indentFor,
  pinnedCellStyle,
  POPOVER_ROW_LAYER,
  STICKY_HEADER_CELL,
  TABLE_FRAME,
  tableMinWidth,
  widthFor,
} from './table-frame';
import { ToastStack, useToasts } from './toasts';
import { searchTree } from './tree-search';
import { toTree, type TreeRow } from './wbs-rows';

export interface WbsTableProps {
  projectId: string;
  api: ProjectApi;
  /**
   * What this project is called, for the export's header and its filename.
   *
   * Optional for the reason `subscribe` is: the table is driven by a fake in
   * tests and the picker that holds the name is not on screen there. Supplied
   * in the app — see {@link UNNAMED_PROJECT} for what an export says without it.
   */
  projectName?: string;
  /**
   * Opens a live subscription. Optional so the table can be tested without a
   * socket; supplied in the app.
   */
  subscribe?: (projectId: string, handlers: SubscriptionHandlers) => ProjectStream;
}

export interface SubscriptionHandlers {
  onChange: () => void;
  onConnectionChange: (connected: boolean) => void;
}

const showDays = (days: Days | undefined, point: Point): string =>
  days === undefined ? '' : String(days[point]);

/** A role's final figure, or nothing at all when no estimate under this row mentions it. */
const showFinal = (days: number | undefined): string => (days === undefined ? '' : showDay(days));

/** The key one estimate box's draft is held under: one row, one role, one point. */
const draftKey = (rowId: string, roleId: string, point: Point): string =>
  `${rowId}::${roleId}::${point}`;

/**
 * The key the folded cell's `o/r/p` draft is held under: one row, one role.
 *
 * The same `drafts` record as the boxes, because there is one pending
 * estimate per row and role however it was typed — see
 * {@link commitCombinedEstimate} for the rule that keeps it one. `combined`
 * cannot collide with a {@link Point}, which is what makes one record safe.
 */
const combinedDraftKey = (rowId: string, roleId: string): string => `${rowId}::${roleId}::combined`;

/**
 * What a rejected request says, or `fallback` when it threw something that is
 * not an `Error`.
 *
 * be-01's own word where there is one — `cycle`, `forbidden` — because a
 * translation layer here would be a second vocabulary for one set of refusals.
 */
const failureText = (thrown: unknown, fallback: string): string =>
  thrown instanceof Error ? thrown.message : fallback;

/**
 * What an export calls a project it was not told the name of.
 *
 * The picker always supplies one, so this is what a caller that has no picker
 * produces — a document that says it does not know, rather than one carrying a
 * uuid nobody can read or none at all.
 */
const UNNAMED_PROJECT = 'Untitled plan';

/**
 * What a page with no clipboard says.
 *
 * `navigator.clipboard` is absent entirely on an insecure origin — the dev
 * deployment is one — so this is a condition to report, not a failure to
 * throw on. It names the way out, which is the CSV beside it.
 */
const NO_CLIPBOARD =
  'This page has no clipboard — that needs an https address. Download the CSV instead.';

/** What a clipboard that refused the write says. The permission is the browser's to give. */
const CLIPBOARD_REFUSED =
  'The browser refused the clipboard, so nothing was copied. Download the CSV instead.';

/**
 * What an empty undo stack says.
 *
 * "Yours" is load-bearing: the stack is per account, so a plan somebody else
 * has been editing all morning still has nothing in it for this reader, and a
 * message saying only "nothing to undo" would read as a bug.
 */
const NOTHING_TO_UNDO = 'There are none of your own changes left to undo on this plan.';
const NOTHING_TO_REDO = 'There is nothing to put back — nothing of yours has been undone.';

/**
 * The byte-order mark the downloaded CSV starts with.
 *
 * Written as an escape rather than as the character it is: U+FEFF is
 * zero-width, and a literal one in the source is a byte nobody reviewing this
 * file can see.
 */
const BOM = '\uFEFF';

/**
 * The columns by fixed id whose `<td>` must not clip, because something in them
 * opens over the rows below. {@link opensAPopover} is what asks.
 */
const POPOVER_COLUMNS: ReadonlySet<string> = new Set(['depends', 'name', 'team', 'actions']);

/**
 * Whether this column holds something that opens over the rows below, and so
 * needs its `<td>` exempted from {@link CELL}'s `overflow: hidden`.
 *
 * The CSS rule this exists for, stated because the first version of this change
 * got it backwards and shipped every popover in the table cut off at the cell
 * edge: an absolutely positioned box escapes an `overflow: hidden` ancestor only
 * when its containing block — its nearest *positioned* ancestor — is **outside**
 * that clipper. Every popover here is `position: absolute` inside a
 * `position: relative` wrapper span, and that wrapper is inside the cell, so the
 * `<td>`'s own clip cuts it to the cell rectangle however the wrapper is styled.
 * Lifting the clip on the `<td>` is the only thing that lets one open.
 *
 * Six kinds of column, not two: the dependency listbox (`depends`), the
 * rendered notes preview (`name` — the notes live in that box since the Notes
 * column was folded into it), a `CreatablePicker`'s list — which is the
 * service/team cell and each role's assignee cell — the row's own actions
 * menu (`actions`), which hangs a 140px box off a 40px cell one line high, and
 * a folded role's own cell (`<roleId>-final`), where an `@` opens the people
 * picker over a 96px column. That last one is the narrowest clip of the lot.
 * Both kinds of role column are named for a role that only exists at runtime,
 * so they are matched by suffix, the same way `widthFor` sizes them.
 *
 * `name` is also a pinned column, and the two rules do not fight: the pin
 * places the cell, the clip decides what may leave it, and the preview has to.
 *
 * What still keeps these cells from painting into their neighbours, now that the
 * structural backstop is off for them: every control inside them is
 * `width: 100%` (or a flex child of a `maxWidth: 100%` row) with `border-box`
 * sizing — asserted by `lets no control in a cell assert a width of its own` and
 * measured in a browser by `keeps every control inside the cell it belongs to`
 * in `e2e/layout.spec.ts`.
 */
const opensAPopover = (columnId: string): boolean =>
  POPOVER_COLUMNS.has(columnId) || columnId.endsWith('-assignee') || columnId.endsWith('-final');

/**
 * How wide the Depends on list opens, in px, whatever its column is.
 *
 * The column is 110px — enough for the chips, which wrap — and an entry in
 * this list is a number and a work item's name. A list held to its own column
 * would be a list nobody can read; it hangs over the columns beside it, which
 * is what `opensAPopover` exempts the cell for. The browser gate measures it.
 */
const DEP_LIST_WIDTH = 260;

/** What the folded cell says about itself when there is nothing to complain about. */
const SHORTHAND_HELP =
  'Days as optimistic/realistic/pessimistic — 2/3/8. One number means all three. Empty clears it. ' +
  '@ looks somebody up to do it.';

/**
 * The drafts record without the named keys.
 *
 * Rebuilt rather than copied and `delete`d: `delete` on a computed key is
 * banned here, and filtering says the same thing without reaching into the
 * object twice.
 */
const dropDrafts = (
  drafts: Readonly<Record<string, string>>,
  gone: ReadonlySet<string>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(drafts).filter(([key]) => !gone.has(key)));

/** Every key one row-and-role's pending estimate can be held under. */
const estimateDraftKeys = (rowId: string, roleId: string): ReadonlySet<string> =>
  new Set([
    ...POINTS.map((point) => draftKey(rowId, roleId, point)),
    combinedDraftKey(rowId, roleId),
  ]);

/**
 * The one sentence a frozen row's refusal says, however the move was asked for.
 *
 * Named rather than reached for through {@link REFUSAL_MESSAGES}: that record is
 * `Partial`, so every read of it is a `string | undefined` the keyboard path
 * would have to invent a fallback for — and two spellings of one refusal is how
 * a drag and a keystroke come to disagree about the same rule.
 */
const FROZEN_REFUSAL = 'That row’s number is frozen. Unfreeze it before moving it.';

/**
 * What a refused drop says out loud.
 *
 * `unchanged` is absent deliberately: dropping a row back where it was is not a
 * mistake anyone needs telling about, and a message for it would fire constantly.
 */
const REFUSAL_MESSAGES: Partial<Record<DropRefusal, string>> = {
  frozen: FROZEN_REFUSAL,
  cycle: 'A row cannot be moved inside itself.',
  not_found: 'That row is no longer here — the table has been refreshed.',
};

/**
 * What a greyed entry in the Depends on list says about itself.
 *
 * The refusal be-01 would answer with, in the words of the table it is being
 * read in: the reader is looking at rows and asking why this one is out, not
 * reading an API's vocabulary. `— would loop` is the whole of the cycle
 * explanation on purpose; the loop can run through any number of rows and
 * naming them in a dropdown entry is a paragraph nobody reads.
 *
 * Exhaustive rather than `Partial`: a new refusal must not reach the list as a
 * silently unexplained grey row.
 */
const REFUSAL_SUFFIX: Record<NonNullable<PickerEntry['refusal']>, string> = {
  ancestor: 'contains this row',
  descendant: 'inside this row',
  cycle: 'would loop',
};

/**
 * Opens `rowId`, whatever shape the expansion state is currently in.
 *
 * TanStack models "everything is open" as the boolean `true`, and a specific set
 * as a record. Dropping into a branch that is closed has to open it — a row that
 * lands somewhere invisible reads as a move that did nothing.
 */
function expandBranch(current: ExpandedState, rowId: string): ExpandedState {
  if (current === true) return true;
  return { ...current, [rowId]: true };
}

/** What a row matching the Find box is tinted, so a hit reads apart from its context. */
const MATCH_TINT = '#fff3bf';

/**
 * Where this browser remembers which of one project's branches are open.
 *
 * Per project, because the shape being remembered is that project's tree.
 * Per browser, like the chosen project beside it (`project-page.tsx`): my
 * collapsing must not reshuffle anybody else's table.
 */
const expansionKey = (projectId: string): string => `wbs.expanded.${projectId}`;

/**
 * Whether a value read back out of storage is an expansion this table can use.
 *
 * TanStack models expansion as `true` — everything open — or a record of the
 * rows that are open. Nothing else is one; `false` in particular is not, since
 * the all-closed state is the empty record.
 */
function isExpansion(value: unknown): value is ExpandedState {
  if (value === true) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((open) => typeof open === 'boolean');
}

/** `stored` as JSON, or nothing at all when it is not JSON. */
function parsedOrNothing(stored: string): unknown {
  try {
    const claimed: unknown = JSON.parse(stored);
    return claimed;
  } catch {
    // Nothing but this component writes the key, so the only way here is a
    // hand-edited store. Recovered from below rather than rethrown.
    return undefined;
  }
}

/**
 * The expansion this browser last saved for `projectId`, or everything open
 * when it has never saved one.
 *
 * The stored value is a claim, not a fact. It is user-editable storage read at
 * a boundary, so it is validated here and dropped — key and all — when it is
 * not an expansion, the same posture `project-page.tsx` takes to a remembered
 * project the list no longer holds. Deliberately not the "unknown is not OK"
 * throw: the alternative is a table that cannot be opened at all until somebody
 * clears storage by hand, over a preference about which triangles point down.
 *
 * Two things the remembered record does **not** do, both verified against
 * `getExpandedRowModel` and `RowExpanding`'s `getIsExpanded`:
 *
 * - Ids naming rows that have since been deleted are harmless. Expansion is
 *   read per row id, so a key nothing asks about is never looked at.
 * - **A row created since the save arrives collapsed** while a record is in
 *   force, because an absent key reads as closed (`expanded?.[row.id]`). Under
 *   `true` — the state of a browser that has never collapsed anything — it
 *   arrives open. That is TanStack's own rule, adopted rather than papered
 *   over: the alternative is a fourth state to keep in step with the other
 *   three.
 */
function rememberedExpansion(projectId: string): ExpandedState {
  const stored = localStorage.getItem(expansionKey(projectId));
  if (stored === null) return true;
  const claimed = parsedOrNothing(stored);
  if (isExpansion(claimed)) return claimed;
  localStorage.removeItem(expansionKey(projectId));
  return true;
}

function rememberExpansion(projectId: string, expanded: ExpandedState): void {
  localStorage.setItem(expansionKey(projectId), JSON.stringify(expanded));
}

/** Whether two role lists say the same thing, so an equal one can be discarded. */
function sameRoles(a: readonly RoleView[], b: readonly RoleView[]): boolean {
  return (
    a.length === b.length && a.every((role, i) => role.id === b[i]?.id && role.name === b[i]?.name)
  );
}

/**
 * The keys that are held rather than pressed, which a pending Ctrl+D survives.
 *
 * agy #9: reaching the second Ctrl+D means holding Control down, and on many
 * keyboards letting it go and taking it again. Every one of those is a
 * `keydown` of its own, and disarming on them would make the chord unusable by
 * anybody who does not press both keys in one motion.
 *
 * Proof: the exemption removed so every keydown disarms, `any other keystroke
 * disarms it, and a modifier on its own does not` failed on `expected null to
 * be '020'`. Watched, 2026-08-08.
 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']);

/**
 * How long an armed Ctrl+D waits for its second press.
 *
 * Long enough to read the toast that says what it will do, short enough that a
 * row cannot still be armed when the reader has moved on and forgotten. The
 * timer is the *only* thing that expires an arm — there is no second elapsed
 * check at the confirm, because a check the timer has already made unreachable
 * is a check that cannot fail.
 */
const ARM_WINDOW_MS = 3000;

/** The armed row's tint: a warning, and the only thing on screen that says so. */
const ARMED_TINT = '#fde8e8';

/** Whether an event target is one of the two elements a cell can be. */
function isCellElement(node: unknown): node is CellElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

/** What one Alt+arrow does to the focused row's place in the tree. */
type AltMove = 'up' | 'down' | 'outdent' | 'indent';

/**
 * The structural move an arrow means when Alt is held, or null for any other key.
 *
 * A function rather than a lookup record: indexing a record by an arbitrary
 * `event.key` is exactly the unchecked access `noUncheckedIndexedAccess` exists
 * to stop, and four cases read as well as four entries.
 */
function altMoveFor(key: string): AltMove | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'outdent';
    case 'ArrowRight':
      return 'indent';
    default:
      return null;
  }
}

/**
 * The structural move a keystroke asks for, or null when it asks for none.
 *
 * The modifier rules live here rather than in {@link onAltMove} because two
 * places need the same answer: the handler that performs the move, and the
 * open `@` list that has to swallow the keystroke before the handler ever sees
 * it. Two copies of "is this an Alt+arrow" is how one of them comes to accept
 * a composing arrow the other refuses.
 *
 * A second modifier is somebody else's shortcut, and an IME composition is
 * using the arrows to pick a candidate — the same rule `nextCell` applies.
 * Proof: narrowed to `!event.altKey` alone, `leaves a composing alt arrow, and
 * one with a second modifier, alone` failed on `expected false to be true`.
 * Watched here 2026-08-08, and where this line lived before, 2026-08-06.
 */
function altMoveIn(event: React.KeyboardEvent): AltMove | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return null;
  return altMoveFor(event.key);
}

/** The `data-cell` value for one editable cell, and the selector that finds it. */
const cellKey = (rowId: string, columnId: string): string => `${rowId}::${columnId}`;

/**
 * What the caret in an input is doing, for `nextCell` to decide on.
 *
 * `selectionStart`/`selectionEnd` are `null` on inputs that do not support them;
 * treated as "not at either end", which leaves the key to the browser rather
 * than guessing a jump nobody asked for.
 */
function caretOf(input: CellElement): Caret {
  // The one place the two element types are told apart for the keyboard: a
  // `<textarea>` is the Name cell, which holds the notes under the name, and
  // {@link nextCell} gives Up and Down to the text there.
  //
  // Proof, both directions, watched 2026-08-08. Hard-coded `true`: `still
  // walks a column of one-line boxes from any caret position` failed on
  // `expected true to be false` — an estimate column that could no longer be
  // filled downwards from mid-number. Hard-coded `false`: `keeps ↑ and ↓ in
  // the name until the caret has run out of text` failed on the reverse.
  const multiline = input instanceof HTMLTextAreaElement;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (start === null || end === null) {
    return { atStart: false, atEnd: false, hasSelection: false, multiline };
  }
  return {
    atStart: start === 0,
    atEnd: end === input.value.length,
    hasSelection: start !== end,
    multiline,
  };
}

/**
 * A day offset as a person should read it.
 *
 * PERT is `(O + 4R + P) / 6`, so a perfectly ordinary estimate produces
 * `3.3333333333333335` and a column full of those is unreadable. Rounded to one
 * decimal **for display only** — the schedule keeps its fractions, because
 * rounding inside the computation compounds across a chain of forty work items
 * into days that never existed.
 */
const showDay = (days: number): string => String(Math.round(days * 10) / 10);

/** Where a keyboard arrival puts the caret: over the whole value, or at one offset. */
type Landing = 'all' | number;

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
function focusCellAt(input: CellElement, landing: Landing): void {
  input.focus();
  if (!(input instanceof HTMLTextAreaElement) && input.type !== 'text') return;
  if (landing === 'all') input.select();
  else input.setSelectionRange(landing, landing);
}

/**
 * Every editable cell in the committed table, paired with the input that is it.
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
function editableGrid(table: HTMLTableElement): { input: CellElement; cell: CellRef }[] {
  return [...table.querySelectorAll<CellElement>('[data-cell]:not([readonly]):not([disabled])')]
    .map((input) => ({ input, parts: (input.dataset['cell'] ?? '').split('::') }))
    .flatMap(({ input, parts }) => {
      // A `data-cell` that is not `row::column` is markup this component did
      // not write. Skipped rather than guessed at, and not thrown on: a
      // keystroke is not the moment to take the table down.
      const [row, column] = parts;
      if (parts.length !== 2 || row === '' || column === '') return [];
      return [{ input, cell: { rowId: row, columnId: column } satisfies CellRef }];
    });
}

/**
 * Focuses the grid cell `delta` places from `from`, selecting its text the
 * way the browser's own Tab leaves a field. False at the grid's edge — the
 * caller then leaves the key to the browser rather than eating it.
 */
function focusAdjacentCell(input: CellElement, from: CellRef, delta: 1 | -1): boolean {
  const table = input.closest('table');
  if (table === null) return false;
  const grid = editableGrid(table);
  const at = grid.findIndex(
    (g) => g.cell.rowId === from.rowId && g.cell.columnId === from.columnId,
  );
  if (at === -1) return false;
  // `.at(-1)` wraps to the far end, which would turn Shift+Tab in the first
  // cell into a jump to the last one instead of leaving the key alone.
  // Proof: the guard removed so the index reached `.at(-1)`, `at the edges of
  // the grid the key is left to the browser` failed — the key was taken and
  // the focus jumped to the last cell of the table. Watched, 2026-08-07.
  const next = at + delta < 0 ? undefined : grid.at(at + delta);
  if (next === undefined) return false;
  focusCellAt(next.input, 'all');
  return true;
}

const column = createColumnHelper<TreeRow>();

/**
 * The work breakdown: one grid that is a table and a nested list at once.
 *
 * TanStack Table owns exactly one thing here — which branches are open. Ordering
 * is not its job: be-01 returns rows already in the order they read, because the
 * numbering is built so a single lexicographic sort produces tree order across
 * every level. Sorting them again on the client would be a second implementation
 * of that, and the two would eventually disagree.
 *
 * Every edit is a request and the tree is refetched, never patched locally. A
 * create or a move can renumber rows this component never touched, and guessing
 * which would be a second implementation of the derivation as well.
 */
export function WbsTable({ projectId, projectName, api, subscribe }: WbsTableProps) {
  const [workItems, setWorkItems] = useState<TreeRow[]>([]);
  const [roles, setRoles] = useState<RoleView[]>([]);
  /**
   * Which branches are open, as this browser last left them for this project.
   *
   * Read straight into the initial state rather than in an effect: an effect
   * would render the default first and collapse the tree a frame later, which
   * is the plan visibly rearranging itself under the reader on every load.
   */
  const [expanded, setExpanded] = useState<ExpandedState>(() => rememberedExpansion(projectId));
  /** Which project the expansion above belongs to, so a save cannot pair it with another. */
  const expansionProject = useRef(projectId);
  /**
   * Saves every change to the expansion, and swaps it whole for another
   * project's.
   *
   * The two are one effect because they are one rule: the state and the key it
   * is written under must always name the same project. Switching project
   * re-reads first and saves nothing — this component is not remounted between
   * projects (`project-page.tsx` renders it without a `key`), so without the
   * swap the first save after a switch would stamp the old project's collapsed
   * branches onto the new project's key.
   */
  useEffect(() => {
    if (expansionProject.current !== projectId) {
      expansionProject.current = projectId;
      setExpanded(rememberedExpansion(projectId));
      return;
    }
    // Proof: removed, `remembers a collapsed branch across a remount` failed
    // with the branch open again, and `drops a remembered expansion that is
    // not one` failed with the hand-edited value still in storage. Watched,
    // 2026-08-06.
    rememberExpansion(projectId, expanded);
  }, [projectId, expanded]);
  /**
   * What has been typed into the Find box.
   *
   * The narrowing itself is not state: it is {@link searchTree} of the rows on
   * screen and this string, re-derived every render. A remembered answer would
   * narrow to a plan that no longer exists — every edit by anybody refetches
   * the whole tree.
   */
  const [query, setQuery] = useState('');
  /**
   * What happened, in the corner, one message per event.
   *
   * Events, not states: a request that was refused, a gesture that was
   * cancelled. The two banners below — the dependency cycle and the dropped
   * socket — are states, and they stay banners, because a state is true until
   * something changes it and a toast is a thing that happened once. See
   * {@link ToastStack}.
   */
  const { toasts, pushToast, dismissToast } = useToasts();
  /**
   * Whether the last refetch failed, leaving the tree on screen possibly
   * behind what be-01 holds.
   *
   * A state, so a banner rather than a toast, and it is the counterpart to
   * keeping the last good tree on screen: rows that may be stale and no way to
   * tell are worse than an empty table. Cleared by any refresh that lands —
   * the retry button's, an edit's, or a peer's change event.
   */
  const [treeMayBeStale, setTreeMayBeStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const [scheduleError, setScheduleError] = useState<'cycle' | null>(null);
  const [estimateMethod, setEstimateMethod] = useState<EstimateMethod>('pert');
  /**
   * Estimate boxes whose typed value has not been accepted by be-01 yet, by
   * {@link draftKey}.
   *
   * These outlive the input they were typed into, on purpose. A trio is only
   * sent once all three read sensibly, so `5` typed into an empty row's
   * optimistic box is a number with nowhere to live until the other two
   * arrive — and holding it in the DOM alone would lose it to the next
   * refresh, which any peer's edit triggers. Cleared for the whole trio the
   * moment it is sent.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * The row whose Name cell the pointer is over, so its rendered notes can
   * show. The notes are written in that box, which is why the hover is on it.
   */
  const [hoveredNotes, setHoveredNotes] = useState<string | null>(null);
  /** Whether the key bindings are on screen. See {@link KeyboardCheatSheet}. */
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  /**
   * Whether this reader has anything to undo or redo, as of the last tree read.
   *
   * Read off the tree rather than tracked here. Both halves of the stack are
   * be-01's — a refused step throws its entry away, and a change of this
   * reader's own clears their redo branch — so a count kept in the browser
   * would be a second answer to a question that has one, and it would be wrong
   * in exactly the cases that matter.
   */
  const [stack, setStack] = useState({ undoable: false, redoable: false });
  /**
   * Roles whose columns are unfolded — the three points, next to the final
   * figure and its assignee, which are always on screen.
   *
   * **At most one, which is what makes the table fit.** A folded role costs
   * 96px and an unfolded one 372, and the width equation in `table-frame.ts`
   * says the difference plainly: two folded roles need 1144px and fit a 1280
   * laptop, while one of them unfolded needs 1420 and does not. So this is an
   * accordion — unfolding a role folds whichever was open — rather than a set
   * that can grow until the dates fall off the screen again. Dany's call,
   * 2026-08-08.
   *
   * A list rather than a `string | null` because it is what the column builder
   * asks (`unfoldedRoles.includes(role.id)`) and what the `columns` memo may
   * depend on; the invariant is on the writer below, which is the only one.
   * Local state, not shared: my unfolding must not reshuffle anyone else's
   * table.
   */
  const [unfoldedRoles, setUnfoldedRoles] = useState<readonly string[]>([]);

  /**
   * Unfolds a role, folding whatever was unfolded — or folds it again.
   *
   * Proof: written as `[...current, roleId]`, `unfolds one role at a time, so
   * the table still fits the window` failed on `expected <input …(5)></input>
   * to be null`. Watched, 2026-08-08.
   */
  const toggleRole = useCallback((roleId: string) => {
    setUnfoldedRoles((current) => (current.includes(roleId) ? [] : [roleId]));
  }, []);
  /** The project's start date, or null while the plan is not on a calendar. */
  const [startDate, setStartDate] = useState<string | null>(null);
  /**
   * The global directory: every team and every person on this deployment.
   *
   * Global rather than per project — Dany's ask — so it is loaded once beside
   * the tree rather than filtered by anything.
   */
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [people, setPeople] = useState<PersonView[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ rowId: string; zone: DropZone } | null>(null);
  /**
   * The Depends on picker: which row's cell it is open under, what has been
   * typed into it, and which entry is highlighted — by the entry's id, never
   * an index. A peer edit can reshuffle the list under an open picker, and an
   * index would silently move the highlight to a row the user never aimed at;
   * an id follows its row, or disappears with it (cross review #6).
   *
   * `highlightId: null` means nothing is highlighted, and it matters at
   * Enter: an empty cell whose list happens to be showing must not add the
   * first entry on a stray Enter. Typing highlights the narrowed-to entry —
   * that is what the typing was for — and the arrows move it.
   */
  const [depPicker, setDepPicker] = useState<{
    rowId: string;
    typed: string;
    highlightId: string | null;
  } | null>(null);
  /**
   * The `@` mention open in a folded role's cell: whose cell, and what has been
   * typed after the `@`.
   *
   * One at a time, for `depPicker`'s reason: one box is being typed into. Read
   * through {@link live}, because `columns` may depend on `roles` and
   * `unfoldedRoles` and nothing else.
   *
   * `typed: ''` is a bare `@` — everybody offered — and is not the same as no
   * mention at all. {@link splitMention} is what tells the two apart.
   */
  const [mention, setMention] = useState<{ rowId: string; roleId: string; typed: string } | null>(
    null,
  );
  /**
   * The folded estimate box that has the focus, and what it was showing when
   * the focus arrived.
   *
   * Both are the `@` gesture's, and both are refs rather than state because
   * neither is rendered: the node is what the mention is stripped out of, and
   * the focus-time value is what goes back in when the estimate half turns out
   * to be empty. That case is not somebody clearing an estimate — it is the
   * select-on-focus this cell has always done, with `@` typed over the whole
   * selection. Clearing an estimate is emptying the cell with no `@` in it.
   */
  const foldedBox = useRef<CellElement | null>(null);
  const foldedAtFocus = useRef('');
  /**
   * The row whose actions menu is open, or null while none is.
   *
   * One row id rather than a set, and that is the rule rather than a
   * simplification: two open menus are two `menuitem`s called `Duplicate`, and
   * an accessible name that matches several elements is ambiguous to a screen
   * reader and to a test alike. Read through {@link live} for the reason
   * `depPicker` is — `columns` must not depend on anything that changes on a
   * click, or every cell in the table remounts under the menu that was opened.
   */
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  /**
   * The row one Ctrl+D has pointed at, waiting for the second one that deletes
   * it — or null, which is almost always.
   *
   * The **number** is held beside the id because the toast promised it: "Ctrl+D
   * again deletes 020". A refresh that renumbered the row, or moved it, or took
   * it away has made that sentence untrue, and an arm whose sentence is untrue
   * is disarmed rather than re-aimed. A fresh object per arm, because it is
   * what the three-second timer fires on: re-arming the same row restarts it.
   *
   * State rather than a ref: the armed row is tinted, so this is rendered.
   * Read through {@link live} for the reason `openMenuRowId` is.
   */
  const [armedDelete, setArmedDelete] = useState<{ rowId: string; number: string } | null>(null);
  /**
   * Whether D has been let go since the arm, which the confirm waits for.
   *
   * A ref, because nothing renders it, and it is the guard that makes a *held*
   * Ctrl+D harmless: a key that is still down has produced no `keyup`, so the
   * second press it appears to make can never be one. `event.repeat` is the
   * other half — see {@link onCommandKey}.
   */
  const dReleased = useRef(false);
  /**
   * Whether a command chord's request is still out.
   *
   * A ref rather than `busy`, and the difference is the whole of what it buys:
   * `busy` is state, so two chords in one tick both read the value from before
   * either of them ran. Two Cmd+Enters on the last row are one gesture arriving
   * twice; without this they are two work items.
   */
  const commandInFlight = useRef(false);
  /**
   * The cell a structural edit asked the focus to land in once the refetched
   * tree is on screen — a row **and a column**, because a row moved from an
   * estimate box has to come back under the same box.
   *
   * Two consumers, one rule between them. The Name cell claims its own arrival
   * in `onAttach`, which is the only way to win the race a newly created row
   * has (see the comment there); every other column is focused by the effect
   * below, from the committed DOM, once the tree it names is rendered. Creating
   * and deleting rows still name the Name column, because that is where typing
   * continues.
   */
  const focusNext = useRef<CellRef | null>(null);
  /**
   * Where the readiness walk has got to: the leaf it last put the focus in,
   * and the cell it asked for.
   *
   * The row rather than an index into the list of gaps, because that list is
   * rebuilt by every edit — estimating the row you were standing on takes it
   * out, and an index would then point at whichever row slid into its place. A
   * row that has left the list starts the walk again from the top.
   *
   * A fresh object on every click on purpose: it is what the effect below
   * fires on, so a plan with one gap left focuses that same cell again rather
   * than the button doing nothing.
   */
  const [gapVisit, setGapVisit] = useState<{ rowId: string; cell: CellRef } | null>(null);
  /** The rendered table, so the focus can be found in the DOM that is committed. */
  const tableElement = useRef<HTMLTableElement | null>(null);

  const latestRefresh = useRef(0);
  /**
   * The live subscription, so a refresh can tell it where the read landed.
   *
   * A ref rather than state: reporting the sequence must not re-render, and the
   * stream outlives every render between subscribe and unsubscribe.
   */
  const stream = useRef<ProjectStream | null>(null);

  const refresh = useCallback(async () => {
    // Every mutation and every socket event starts a refresh, and they can
    // finish out of order — an earlier one landing last would replace the table
    // with a tree older than what is on screen, with nothing guaranteed to
    // arrive afterwards and repair it. Only the newest request may write.
    const generation = latestRefresh.current + 1;
    latestRefresh.current = generation;
    const [tree, loadedRoles, loadedTeams, loadedPeople] = await Promise.all([
      api.tree(projectId),
      api.roles(projectId),
      api.listTeams(),
      api.listPeople(),
    ]);
    if (generation !== latestRefresh.current) return;
    // This read landed, so whatever the last failed one left behind is over.
    // After the generation check, not before: a superseded read must not
    // vouch for a tree it is about to throw away, and the newest read is the
    // one entitled to say the screen is current.
    // Proof: removed, `raises the stale-tree banner when a socket refetch
    // fails` and `clears the banner on a later successful refetch from any
    // path` both failed with the banner still up after a clean reread.
    // Watched, 2026-08-06.
    setTreeMayBeStale(false);
    setTeams(loadedTeams);
    setPeople(loadedPeople);
    setWorkItems(toTree(tree.workItems));
    setStack({ undoable: tree.undoable, redoable: tree.redoable });
    setScheduleError(tree.scheduleError);
    setEstimateMethod(tree.estimateMethod);
    setStartDate(tree.startDate);
    // Replaced only when the roles actually differ. Every read returns a fresh
    // array, and `roles` is the one dependency `columns` still has — so a new
    // array on every refresh rebuilt every column definition, which is how a
    // stranger's edit used to take the focus of whoever was mid-word.
    setRoles((current) => (sameRoles(current, loadedRoles) ? current : loadedRoles));
    // Reported after the generation check, so a superseded read cannot move the
    // resume point to a moment whose rows were thrown away.
    stream.current?.seen(tree.seq);
  }, [api, projectId]);

  /**
   * Rereads the tree, and raises the stale banner instead of throwing when
   * that fails.
   *
   * The last good tree stays on screen — clearing it would lose the reader's
   * place over a blip — and the banner is what stops that being a silent lie
   * about how current the rows are. Never rejects, deliberately: callers that
   * have their own refusals to report (`dependOn`) must still report them
   * after a failed reread.
   */
  const refreshOrMarkStale = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // The reason is not shown. It is be-01's word for a network failure the
      // reader did not cause and cannot act on beyond retrying, and the banner
      // already says the one thing they can do about it.
      //
      // Proof: emptied to the silent catch this replaced, four of the block's
      // tests failed — `raises the stale-tree banner when a socket refetch
      // fails`, `clears the banner on a later successful refetch from any
      // path`, `raises the banner when the refetch after an edit fails` and
      // `shows both the refusal and the banner when the refetch failed too`.
      // Watched, 2026-08-06.
      setTreeMayBeStale(true);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh().catch((thrown: unknown) => {
      // The first read, which is different from a failed reread: there is no
      // last good tree to be stale, so this is an event to report rather than
      // a state to sit under. "This plan may be out of date" over an empty
      // table would be a sentence about a plan that never arrived.
      pushToast({ kind: 'error', text: failureText(thrown, 'load_failed') });
    });
  }, [refresh, pushToast]);

  /**
   * `?` anywhere on the page opens the cheat sheet.
   *
   * On the window rather than on the table, because the point is that it works
   * from wherever the reader is — and because the keys it documents are spread
   * over the cells, the toolbar and two pickers, none of which is a single
   * element to hang this on. {@link opensCheatSheet} is what keeps it out of
   * the text boxes: it judges the event's target, so a `?` on its way into a
   * name or the Find box is left alone.
   *
   * Never `preventDefault`: the keystrokes this takes are the ones no field
   * wanted.
   */
  useEffect(() => {
    const openOnQuestionMark = (event: KeyboardEvent) => {
      if (!opensCheatSheet(event, event.target)) return;
      setCheatSheetOpen(true);
    };
    window.addEventListener('keydown', openOnQuestionMark);
    return () => {
      window.removeEventListener('keydown', openOnQuestionMark);
    };
  }, []);

  // Someone else's edit refetches rather than patching: a create or move can
  // renumber rows this client never touched.
  useEffect(() => {
    if (subscribe === undefined) return undefined;
    const opened = subscribe(projectId, {
      onChange: () => {
        // No toast: nobody asked for this read, so nothing of theirs was
        // refused. What it can leave behind is a tree that has fallen behind,
        // and that is the banner's job.
        void refreshOrMarkStale();
      },
      onConnectionChange: setConnected,
    });
    stream.current = opened;
    return () => {
      opened.unsubscribe();
      stream.current = null;
    };
  }, [subscribe, projectId, refreshOrMarkStale]);

  /**
   * A drag does not survive the tree changing underneath it.
   *
   * Two things go wrong otherwise, and both reviewers found one each. The
   * browser does not reliably fire `dragend` on a source node that was replaced
   * mid-gesture, so `dragging` could stay set forever — after which merely
   * moving the pointer over the table drew drop markers, and a click moved a row
   * nobody had picked up. And `planMove` reads the *current* tree, so a peer who
   * reparents the target between pickup and release turns "below 010" into a
   * different move than the one on screen when the gesture started.
   *
   * Cancelling is the conservative answer to both: a drag lasts a second or two,
   * a concurrent edit inside it is rare, and being told to try again beats
   * either a stuck table or a row landing somewhere nobody aimed.
   */
  useEffect(() => {
    setDragging((current) => {
      // `info`, not `error`: nothing was refused and nothing was lost, so this
      // is context that may take itself off again rather than a failure
      // waiting to be dismissed.
      //
      // Pushed from inside the updater because `dragging` cannot join this
      // effect's dependencies — it would then re-run on every pickup and
      // cancel the drag it was meant to survive. StrictMode invokes an updater
      // twice, so this pushes twice under it; the stack collapses a repeated
      // message into one line, which is what makes that harmless.
      if (current !== null) {
        pushToast({
          kind: 'info',
          text: 'The table changed while you were dragging — try again.',
        });
      }
      return null;
    });
    setDropHint(null);
  }, [workItems, pushToast]);

  /**
   * Lands the focus on the cell {@link focusNext} names, once the tree that
   * holds it is on screen.
   *
   * Read from the committed DOM rather than from the render that asked for it:
   * a move is a request and a refetch, and the row it names does not exist in
   * this component's DOM until the refetched tree renders. A browser drops the
   * focus when React reorders the rows — the node is detached and reinserted —
   * so this is what puts it back, in the column the person was working in.
   *
   * The intent is cleared only once the cell is actually found. A refresh from
   * somebody else's edit can land between the request and its own refetch, and
   * clearing on that render would drop the focus on the floor rather than
   * carrying it to the tree that arrives next.
   */
  useEffect(() => {
    const wanted = focusNext.current;
    const table = tableElement.current;
    if (wanted === null || table === null) return;
    const arrived = editableGrid(table).find(
      (candidate) =>
        candidate.cell.rowId === wanted.rowId && candidate.cell.columnId === wanted.columnId,
    );
    if (arrived === undefined) return;
    focusNext.current = null;
    // Proof: left as a lookup that focuses nothing, both `lands in the same
    // column…` tests failed with the focus on the body. That is only visible
    // because those tests drop the focus first, the way a browser does — jsdom
    // keeps it on a node React moves, so without that the check could not fail.
    // Watched, 2026-08-06.
    arrived.input.focus();
  }, [workItems]);

  /**
   * One edit: send it, then reread the tree.
   *
   * The two halves fail differently and are reported differently, which is the
   * whole of this change's rule. A refused request is an **event** — somebody
   * asked for something and did not get it — so it is a toast that stays until
   * it is read. A reread that failed is a **state**: the request landed, and
   * what is on screen may now be behind be-01, which is the banner.
   *
   * Nothing is cleared on the way in. The old version reset the error line
   * before every request, so the reason a rename was refused vanished the
   * moment anything else worked; toasts own their own lifecycle instead.
   * Proof: the clear put back at the top of this function, `keeps a failure on
   * screen when the next action succeeds` failed with the toast gone. Watched,
   * 2026-08-06.
   *
   * A refused action skips the reread deliberately: be-01 changed nothing, so
   * there is nothing new to read.
   *
   * The verdict is returned as well as toasted, because a toast is a sentence
   * and some callers need the fact. `CellInput` is the one: a refused edit
   * exists only in the box it was typed into, and the box has to be told so it
   * can hold it against the next refetch (rule 4 there). A reread that failed
   * is still `landed` — the write happened, and the banner is what says the
   * screen may be behind.
   */
  const run = useCallback(
    async (action: () => Promise<void>): Promise<CommitOutcome> => {
      setBusy(true);
      try {
        try {
          await action();
        } catch (thrown: unknown) {
          pushToast({ kind: 'error', text: failureText(thrown, 'request_failed') });
          return 'refused';
        }
        await refreshOrMarkStale();
        return 'landed';
      } finally {
        setBusy(false);
      }
    },
    [pushToast, refreshOrMarkStale],
  );

  /**
   * One step along the undo stack, and the sentence that says what happened.
   *
   * Three outcomes, all of them said out loud, because a shortcut that
   * silently does nothing is worse than no shortcut. A step that worked is an
   * `info` — it is a fact to know, and it takes itself off. Both refusals are
   * errors that stay until they are read: the reader asked for something and
   * did not get it, and in the stale case somebody else's change is the reason.
   *
   * The tree is reread after a refusal too, not only after a success. be-01
   * throws away the entry it refused — it can never apply again — so what
   * there is left to undo has changed even though the plan has not.
   */
  const stepStack = useCallback(
    async (direction: 'undo' | 'redo') => {
      setBusy(true);
      try {
        let outcome;
        try {
          outcome = direction === 'undo' ? await api.undo(projectId) : await api.redo(projectId);
        } catch (thrown: unknown) {
          pushToast({ kind: 'error', text: failureText(thrown, 'request_failed') });
          return;
        }
        if (outcome.ok) {
          pushToast({
            kind: 'info',
            text: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${outcome.done}${
              outcome.detail === null ? '' : ` — ${outcome.detail}`
            }`,
          });
        } else if (outcome.reason === 'nothing_to_undo') {
          pushToast({
            kind: 'error',
            text: direction === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO,
          });
        } else {
          pushToast({
            kind: 'error',
            // be-01's own sentence about what moved, because a translation
            // here would be a second vocabulary for one set of refusals.
            text: `${direction === 'undo' ? 'That could not be undone' : 'That could not be put back'}: ${outcome.detail ?? 'the plan has changed since.'}`,
          });
        }
        await refreshOrMarkStale();
      } finally {
        setBusy(false);
      }
    },
    [api, projectId, pushToast, refreshOrMarkStale],
  );

  /**
   * Cmd/Ctrl+Z anywhere on the page, and Shift with it to go the other way.
   *
   * On the window for the same reason `?` is: the change being reversed could
   * have been made from any cell, any picker or the toolbar, and there is no
   * one element to hang it on. {@link undoChord} is what keeps it out of the
   * text boxes, where the browser's own undo is better than anything this
   * could offer for a word somebody is halfway through typing.
   *
   * `preventDefault` here and nowhere else in this file's listeners: this is
   * the one chord a browser would otherwise act on itself, undoing text in
   * whatever field it last remembers rather than the change that was asked for.
   */
  useEffect(() => {
    const walk = (event: KeyboardEvent) => {
      const direction = undoChord(event, event.target);
      if (direction === null) return;
      event.preventDefault();
      void stepStack(direction);
    };
    window.addEventListener('keydown', walk);
    return () => {
      window.removeEventListener('keydown', walk);
    };
  }, [stepStack]);

  /**
   * Everything that takes a pending Ctrl+D off, other than another keystroke.
   *
   * The arm is a promise about one row, made in a toast, and it is kept only
   * while the reader is still looking at the row it was made about. Leaving the
   * cell — by Tab, by a chord, or by clicking somewhere else entirely — ends
   * it; so does the window losing the focus, the tab being hidden, and the
   * three seconds running out. Nothing here is a nicety: a row that stays armed
   * across a coffee break is a Ctrl+D that deletes something the person has
   * stopped thinking about.
   *
   * `focusout` rather than a blur handler on the cell: the focus can leave by
   * the pointer, and the cell that was armed may not be the one that had it.
   *
   * Proof: this effect's listeners removed, `leaving the cell disarms it,
   * however the focus went` failed with the row still tinted. Watched,
   * 2026-08-08.
   */
  useEffect(() => {
    if (armedDelete === null) return undefined;
    const disarm = () => {
      setArmedDelete(null);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') disarm();
    };
    // A fresh timer per arm, because `armedDelete` is a fresh object per arm:
    // re-arming the same row starts the three seconds again.
    const expiry = setTimeout(disarm, ARM_WINDOW_MS);
    window.addEventListener('focusout', disarm);
    window.addEventListener('blur', disarm);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      clearTimeout(expiry);
      window.removeEventListener('focusout', disarm);
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [armedDelete]);

  /**
   * A `keyup` of D, which is what the confirming press waits for.
   *
   * On the window rather than on the cell: the chord is pressed in a cell, and
   * the key can be let go after the focus has moved or with the pointer
   * somewhere else entirely. Missing the release would leave a row that can
   * never be confirmed, which is the failure mode that reads as "the shortcut
   * is broken".
   */
  useEffect(() => {
    const released = (event: KeyboardEvent) => {
      if (event.key === 'd' || event.key === 'D') dReleased.current = true;
    };
    window.addEventListener('keyup', released);
    return () => {
      window.removeEventListener('keyup', released);
    };
  }, []);

  /** Every row in the order the table renders them, ignoring collapse. */
  const flat = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (rows: readonly TreeRow[]): void => {
      for (const row of rows) {
        out.push(row);
        walk(row.subRows);
      }
    };
    walk(workItems);
    return out;
  }, [workItems]);

  /**
   * A pending Ctrl+D whose row the tree no longer holds — or no longer holds
   * under the number the toast promised — is disarmed.
   *
   * "Ctrl+D again deletes 020" stops being true the moment somebody else
   * deletes that row, or moves it, or creates one above it and renumbers it.
   * The arm holds the id *and* the number for exactly this: matching on the id
   * alone would leave the second press aimed at a row that is now 030 while
   * the sentence on screen still says 020.
   *
   * Proof: this effect removed, `a peer deleting the armed row disarms it`
   * failed on `expected '020' to be null` — an arm still tinted and still
   * live on a row that had gone. Watched, 2026-08-08.
   */
  useEffect(() => {
    setArmedDelete((armed) => {
      if (armed === null) return null;
      const still = flat.find((row) => row.id === armed.rowId);
      return still?.number === armed.number ? armed : null;
    });
  }, [flat]);

  /**
   * What the Find box is asking for: which rows stay, which of them are hits,
   * and what has to be open to show them.
   *
   * A pure function of the rows on screen and the query, memoised only so the
   * table's own row model is not rebuilt on every unrelated render — never
   * cached across a change to either. A structural edit refetches the tree and
   * this narrows the tree that came back, which is why a row moved out of the
   * match set disappears from the narrowed view.
   */
  const search = useMemo(() => searchTree(flat, query), [flat, query]);
  /**
   * Whether a search is on — which is the query having something in it other
   * than spaces, and is exactly when {@link searchTree} hands back an overlay.
   *
   * One source of truth rather than a second trim beside it, which is how two
   * answers to one question start to disagree.
   */
  const searching = search.expandedOverlay !== null;

  const siblingsOf = useCallback(
    (parentId: string | null) => flat.filter((row) => row.parentId === parentId),
    [flat],
  );

  /**
   * What this plan is still short of, per leaf and per role.
   *
   * Recomputed from the tree on screen rather than tracked, for the reason
   * nothing here is patched locally: an estimate can arrive from anybody, and
   * a count kept alongside would be the second answer to a question that has
   * one.
   */
  const gaps = useMemo(() => findEstimateGaps(flat, roles), [flat, roles]);

  /**
   * The whole plan as a document, taken at the moment it is asked for.
   *
   * **Every row**, not the rows on screen: a collapsed branch and a running
   * search are how one reader is looking at the plan, and an export that
   * carried either would hand somebody else a plan with rows missing and
   * nothing saying so. The figures are be-01's own — the export computes
   * nothing, so it cannot disagree with the table it came off.
   *
   * The timestamp is read here, in the shell, and passed in: the two writers
   * are pure, and a `Date.now()` inside one of them is a header nothing can
   * assert.
   */
  const planForExport = useCallback(
    (): PlanExport => ({
      projectName: projectName ?? UNNAMED_PROJECT,
      generatedAt: new Date().toISOString(),
      method: estimateMethod,
      startDate,
      scheduleError,
      roles,
      teams,
      people,
      rows: flat,
    }),
    [projectName, estimateMethod, startDate, scheduleError, roles, teams, people, flat],
  );

  /**
   * Puts the plan on the clipboard as Markdown, and says which of the three
   * things that can happen did.
   *
   * A clipboard is a permission, not a function call: the object is absent on
   * an insecure origin and the write can be refused after the object is
   * there. Both are modeled conditions and both are reported — a Copy button
   * that silently does nothing is the failure this whole toast system exists
   * to remove. The success is an `info`, because it is a fact to know rather
   * than a task, and it takes itself off.
   */
  const copyAsMarkdown = useCallback(() => {
    const markdown = planToMarkdown(planForExport());
    // The DOM lib types `navigator.clipboard` as always present. It is not —
    // it is absent on http and in jsdom — so this annotation is the boundary
    // between what the types claim and what a browser actually ships, and it
    // is what makes the check below a real one rather than dead code.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      pushToast({ kind: 'error', text: NO_CLIPBOARD });
      return;
    }
    void clipboard.writeText(markdown).then(
      () => {
        pushToast({ kind: 'info', text: 'Copied as Markdown.' });
      },
      () => {
        // The browser's reason is not shown: it is a permission decision the
        // reader did not make and cannot act on beyond using the other button.
        pushToast({ kind: 'error', text: CLIPBOARD_REFUSED });
      },
    );
  }, [planForExport, pushToast]);

  /**
   * Downloads the plan as a CSV, without asking be-01 for anything.
   *
   * A blob and an anchor click, which is the only way a page saves a file it
   * generated itself. The object URL is revoked immediately after the click:
   * the download already holds the blob, and an unrevoked URL keeps the whole
   * file in memory for the life of the document.
   *
   * The byte-order mark is for one reader in particular — Excel on Windows
   * reads a UTF-8 CSV as the system codepage without it, which turns every
   * `—` and every non-ASCII name into mojibake. It is added here rather than
   * in {@link planToCsv} because it is a fact about a file, not about the
   * format.
   */
  const downloadCsv = useCallback(() => {
    const plan = planForExport();
    const csv = new Blob([BOM, planToCsv(plan)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(csv);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [planForExport]);

  /**
   * The work items between `rowId` and the root, nearest first.
   *
   * Terminates because `flat` is built by walking the nested tree down from
   * its roots: every row in it is reachable from a root, so its parent chain
   * is finite. A `parentId` cycle leaves both rows out of the tree `toTree`
   * builds, and so out of `flat` and out of this.
   */
  const ancestorsOf = useCallback(
    (rowId: string): string[] => {
      const above: string[] = [];
      let next = flat.find((row) => row.id === rowId)?.parentId ?? null;
      while (next !== null) {
        // Copied to a `const` because the closure below reads it: TypeScript
        // drops the narrowing of a reassigned `let` inside a callback.
        const parentId = next;
        above.push(parentId);
        next = flat.find((row) => row.id === parentId)?.parentId ?? null;
      }
      return above;
    },
    [flat],
  );

  /**
   * Walks to the next leaf the plan has no estimate for, and asks for the
   * focus in the cell that estimates it.
   *
   * The readiness badge's only behaviour. It reads nothing and writes nothing:
   * a plan is judged complete or not by {@link findEstimateGaps}, and this
   * carries the eye there. The cell aimed at is the **first role that leaf is
   * missing** — a row costed for Dev and not QA is stood in front of its QA
   * cell, because pointing at the number that is already there would be the
   * tool asking for work that is done.
   *
   * The walk wraps, and a leaf inside a closed branch opens its ancestors on
   * the way: focusing a cell that is not on screen is a keystroke landing
   * somewhere nobody can see.
   */
  const walkToNextGap = useCallback(() => {
    if (gaps.leaves.length === 0) return;
    const at =
      gapVisit === null ? -1 : gaps.leaves.findIndex((leaf) => leaf.rowId === gapVisit.rowId);
    // `-1` is both "nothing visited yet" and "the row visited has since been
    // estimated, or deleted". Both start at the top, which is the only place
    // that is still true about the list as it now stands.
    // Proof: `-1` folded up to `0` instead, `starts again from the top when
    // the leaf it was on has been estimated` failed one row further down the
    // list than anybody asked for. Watched, 2026-08-06.
    //
    // The modulo wraps. Proof: replaced with a clamp to the last entry, `moves
    // on to the next leaf on the next click, and wraps at the end` failed on
    // the third click, which sat where it was. Watched, 2026-08-06.
    //
    // Both indexes below are in range without a guard: the list is not empty,
    // and `findEstimateGaps` never reports a leaf that is missing no role at
    // all. Guards for them were written and `no-unnecessary-condition` refused
    // them — dead branches, which is exactly the check that cannot fail.
    const next = gaps.leaves[(at + 1) % gaps.leaves.length];
    const roleId = next.missingRoleIds[0];
    // Which cell edits this role depends on the fold: the combined cell while
    // the role is folded, and the optimistic box while it is not, because
    // `combined-trio-entry` deliberately never shows both editors at once.
    // Proof: hard-coded to the folded cell, `lands in the first box while the
    // role is unfolded, where the trio is typed` failed with the focus left on
    // the body — the column it named is not an editable cell while the role is
    // open. Watched, 2026-08-06.
    const columnId = unfoldedRoles.includes(roleId) ? `${roleId}-optimistic` : `${roleId}-final`;
    // Proof: removed, `opens a collapsed branch rather than focusing a cell
    // nobody can see` failed with the child row still hidden. Watched,
    // 2026-08-06.
    setExpanded((current) => ancestorsOf(next.rowId).reduce(expandBranch, current));
    setGapVisit({ rowId: next.rowId, cell: { rowId: next.rowId, columnId } });
  }, [ancestorsOf, gapVisit, gaps, unfoldedRoles]);

  /**
   * Lands the focus on the cell the readiness walk asked for.
   *
   * An effect rather than a `focus()` in the click, because the click may have
   * opened a branch as well: the row it names is not in this component's DOM
   * until the render carrying that expansion is committed. Both state updates
   * are made in one handler, so they batch into one render and this runs after
   * it — reading the committed DOM, which is the only thing that cannot be
   * ahead of itself.
   *
   * A cell that is not there is left alone: a peer's refetch can remove the
   * row between the click and this, which is a modeled condition, and the next
   * click starts the walk from the top anyway.
   */
  useEffect(() => {
    const table = tableElement.current;
    if (gapVisit === null || table === null) return;
    const arrived = editableGrid(table).find(
      (candidate) =>
        candidate.cell.rowId === gapVisit.cell.rowId &&
        candidate.cell.columnId === gapVisit.cell.columnId,
    );
    if (arrived === undefined) return;
    // Proof: removed, five of this block's tests failed with the focus left
    // wherever the last created row had put it. Watched, 2026-08-06.
    //
    // Selected, the way every arrival at an estimate cell is: the value at
    // rest is a computed figure, and a caret dropped inside `4` turns the next
    // `2/3/8` into `2/3/84`.
    focusCellAt(arrived.input, 'all');
  }, [gapVisit]);

  /**
   * Resolves a drop and sends the move, or refuses it out loud.
   *
   * The decision itself is `planMove`, which is pure and tested on its own; this
   * only turns the answer into a request or a sentence. Dropping into a
   * collapsed branch opens it, so the row is never moved somewhere invisible.
   */
  const dropOn = useCallback(
    (targetId: string, zone: DropZone, targetShowsChildren: boolean) => {
      const draggedId = dragging;
      setDragging(null);
      setDropHint(null);
      if (draggedId === null) return;

      // Whether the target's children are on screen changes what "below it"
      // means. The row that was dropped on knows; the planner is told rather
      // than left to guess, and stays pure.
      const plan = planMove(flat, draggedId, targetId, zone, targetShowsChildren);
      if (!plan.ok) {
        // `unchanged` says nothing: it is not a mistake, and a message for it
        // would fire every time someone put a row back.
        const message = REFUSAL_MESSAGES[plan.reason];
        if (message !== undefined) pushToast({ kind: 'error', text: message });
        return;
      }

      if (zone === 'into') setExpanded((current) => expandBranch(current, targetId));
      void run(() => api.move(draggedId, plan.parentId, plan.afterId));
    },
    [api, dragging, flat, pushToast, run],
  );

  const addSibling = useCallback(
    (after: TreeRow) =>
      run(async () => {
        const created = await api.create(projectId, {
          parentId: after.parentId,
          afterId: after.id,
          name: '',
        });
        focusNext.current = { rowId: created.id, columnId: 'name' };
      }),
    [api, projectId, run],
  );

  /**
   * Indent: the row becomes the last child of the sibling above it.
   *
   * `landOn` is the column the focus should come back to. It defaults to the
   * Name cell, which is where Tab is pressed from and where typing continues;
   * an Alt+arrow passes the column it was pressed in instead.
   */
  const indent = useCallback(
    (row: TreeRow, landOn = 'name') =>
      run(async () => {
        const siblings = siblingsOf(row.parentId);
        const index = siblings.findIndex((w) => w.id === row.id);
        // A ternary rather than `siblings.at(index - 1)`: at index 0 there is no
        // row above to indent under, and `.at(-1)` would return the last sibling
        // — quietly moving the row somewhere nobody asked for.
        const newParent = index > 0 ? siblings[index - 1] : undefined;
        if (newParent === undefined) return;
        const lastChild = newParent.subRows.at(-1) ?? null;
        await api.move(row.id, newParent.id, lastChild?.id ?? null);
        // After the move, not before: a refused request then leaves the focus
        // where the person left it rather than sending it after a row that
        // never went anywhere.
        focusNext.current = { rowId: row.id, columnId: landOn };
      }),
    [api, run, siblingsOf],
  );

  /** Outdent: the row becomes the next sibling of its own parent. */
  const outdent = useCallback(
    (row: TreeRow, landOn = 'name') =>
      run(async () => {
        if (row.parentId === null) return;
        const parent = flat.find((w) => w.id === row.parentId);
        if (parent === undefined) return;
        await api.move(row.id, parent.parentId, parent.id);
        // After the move, for the reason `indent` gives.
        focusNext.current = { rowId: row.id, columnId: landOn };
      }),
    [api, flat, run],
  );

  /**
   * Alt+Up / Alt+Down: the row swaps places with the sibling above or below it.
   *
   * Siblings only, and no wrap: at either end of a group the key does nothing.
   * Reparenting is Alt+Left/Right's job and the drag's, and a key that silently
   * moved a row into a different parent because it ran out of siblings would be
   * the outliner equivalent of falling off the end of the page.
   *
   * The request carries **ids read from the tree this render was drawn from** —
   * the parent it stays under and the sibling it lands after — never a computed
   * position. A tree that has since changed then produces a stale-but-valid move
   * for be-01 to judge (it refuses an `afterId` that is not a sibling of the
   * group) rather than an invented place nobody aimed at.
   */
  const moveAmongSiblings = useCallback(
    (row: TreeRow, direction: 'up' | 'down', landOn: string) => {
      const siblings = siblingsOf(row.parentId);
      const at = siblings.findIndex((sibling) => sibling.id === row.id);
      // Not in the tree on screen: a peer deleted the row between the render and
      // the keystroke. A modeled condition, like an arrow key on a cell that has
      // gone — not a move to guess at.
      if (at === -1) return;
      const swapWith = direction === 'down' ? at + 1 : at - 1;
      // The ends. Decided here rather than inside `run` so a held key at the top
      // of a group is not a request and a refetch per repeat.
      // Proof: replaced with a wrap to the other end of the group, `at the first
      // sibling it moves nothing` and `at the last sibling it moves nothing`
      // both failed on a move that was sent. Watched, 2026-08-06.
      if (swapWith < 0 || swapWith >= siblings.length) return;
      // Down: after the sibling it is passing. Up: after that sibling's own
      // predecessor, which is `null` — first in the group — when there is none.
      const afterId =
        direction === 'down'
          ? (siblings[swapWith]?.id ?? null)
          : (siblings[swapWith - 1]?.id ?? null);
      void run(async () => {
        await api.move(row.id, row.parentId, afterId);
        // Asked for only once be-01 has taken the move: a refused request leaves
        // the focus where the person left it rather than chasing a row that did
        // not go anywhere.
        // Proof: `landOn` hard-coded to `name` here and in `indent`/`outdent`,
        // and both `lands in the same column…` tests failed — the Name cell took
        // the focus. Watched, 2026-08-06.
        focusNext.current = { rowId: row.id, columnId: landOn };
      });
    },
    [api, run, siblingsOf],
  );

  /**
   * Copies a work item and everything under it, landing the caret on the copy.
   *
   * One request: be-01 writes the whole branch at once and sends the tree
   * afterwards, so there is nothing to reconstruct here and nothing to undo if
   * it is refused. The focus is asked for only after the copy has been taken,
   * for the reason every other `focusNext` write here is — a refusal must
   * leave the caret where the person left it rather than chase a row that does
   * not exist.
   */
  const duplicateRow = useCallback(
    (id: string) =>
      run(async () => {
        const copy = await api.duplicate(id);
        focusNext.current = { rowId: copy.id, columnId: 'name' };
      }),
    [api, run],
  );

  /**
   * Deletes a work item and lands the focus where its place went.
   *
   * The children come up rather than going with it (`strategy: 'promote'`),
   * which is what the Delete button did and what the actions menu keeps.
   *
   * Where the caret lands: the Name of the next sibling in this row's own
   * group, else the row above it in the flattened tree, else nowhere — a plan
   * with one row leaves the focus on the ⋯ button the menu gave it back to.
   * The target is read from the tree **on screen before the request**, because
   * afterwards the row it was computed from is gone; for a parent, promoting
   * lifts the children into the gap, so the next sibling is below them rather
   * than immediately below it. That is the sibling group's own answer to "what
   * took its place", and it is written down because the other reading — the
   * first promoted child — is defensible too.
   *
   * Assigned only once be-01 has taken the delete, for the reason
   * {@link duplicateRow} gives: a refusal must leave the focus where the person
   * left it rather than move it into a row nobody deleted.
   *
   * Proof, three faults, all watched on 2026-08-08. The `focusNext` write
   * removed: `lands the caret in the next sibling’s name after a delete` and
   * `lands the caret in the row above when the last row is deleted` both failed
   * on `expected <body>…</body> to be <textarea …>` — the deleted row takes its
   * own ⋯ button with it, so nothing is left holding the focus. `?? above`
   * dropped: the second of those failed alone. The assignment moved in front of
   * the `await`: `says why a delete was refused, moves the focus nowhere and
   * deletes nothing` failed on `expected <textarea …> to be <button …>`.
   */
  const deleteRow = useCallback(
    (row: TreeRow) =>
      run(async () => {
        const siblings = siblingsOf(row.parentId);
        const at = siblings.findIndex((sibling) => sibling.id === row.id);
        const nextSibling = at === -1 ? undefined : siblings[at + 1];
        const flatAt = flat.findIndex((each) => each.id === row.id);
        // A ternary rather than `flat.at(flatAt - 1)`: deleting the first row
        // has no row above, and `.at(-1)` would send the focus to the last one.
        const above = flatAt > 0 ? flat[flatAt - 1] : undefined;
        const landsOn = nextSibling ?? above;
        await api.remove(row.id, {
          strategy: row.subRows.length > 0 ? 'promote' : undefined,
        });
        focusNext.current = landsOn === undefined ? null : { rowId: landsOn.id, columnId: 'name' };
      }),
    [api, flat, run, siblingsOf],
  );

  /**
   * Commits the Name cell: a work item's name and its notes, typed as one text.
   *
   * **The diff is three-way, against the baseline rather than against the row
   * on screen**, and that is the whole reason this function exists. Every edit
   * refetches the tree, so a peer's change to the notes can arrive while this
   * cell is being typed in — `CellInput` holds it back (rule 2) and hands the
   * held value over as `baseline` on the way out. Comparing the typed fields
   * against `row.notes` instead would read that peer's note as one this user
   * had just deleted and send `notes: ''` over the top of it. Both reviewers
   * found that from opposite ends before a line of it was written.
   *
   * **One request for the changed subset**, so an edit that touches both fields
   * is one refusal, one journal entry and one Cmd+Z rather than two of each.
   * Nothing is sent when neither field moved, which is reachable without
   * anybody typing: a `<textarea>` normalises the newlines of whatever is
   * assigned to it, so a note be-01 holds with `\r\n` — from an API client or
   * another front end — differs from the box showing it as text while meaning
   * the same thing. Every focus-and-leave of that row would otherwise rewrite
   * it. That is where {@link normalizeNewlines} earns its place; the keyboard
   * cannot put a `\r` in here.
   *
   * Proof, five faults, all watched on 2026-08-08. `was` re-pointed at the
   * current row props off `flat`: `keeps a peer’s note when the name is what
   * was being typed` failed on `expected 'measure twice' to be 'their note'`
   * and `keeps a peer’s name when the notes are what was being typed` on
   * `expected 'Strip' to be 'Rewire the shed'` — each field replaced by the
   * stale one this client still had on screen. The `now.name === was.name`
   * guard dropped so the name is always sent: `sends only the field that
   * changed` failed on a patch carrying a name nobody retyped; the notes guard
   * dropped, the same test failed on the other half. `normalizeNewlines`
   * dropped from both sides: `does not rewrite a note that was stored with
   * Windows line endings` failed on `expected [['w1', …]] to deeply equal []`.
   * The `Object.keys(...).length === 0` return deleted: the same test failed
   * on `[['w1', {}]]`, an empty patch.
   */
  const commitNameCell = useCallback(
    (rowId: string, typed: string, baseline: string): Promise<CommitOutcome> => {
      const now = splitNameCell(normalizeNewlines(typed));
      const was = splitNameCell(normalizeNewlines(baseline));
      const patch = {
        ...(now.name === was.name ? {} : { name: now.name }),
        ...(now.notes === was.notes ? {} : { notes: now.notes }),
      };
      // Not `landed`: nothing was written. The two texts differ as text and
      // mean the same thing, so there is nothing unsaved for the cell to hold
      // and nothing for be-01 to have refused.
      if (Object.keys(patch).length === 0) return unsent();
      return run(() => api.patch(rowId, patch));
    },
    [api, run],
  );

  /** Removes a wholly empty row, landing the focus on the row above it. */
  const removeEmptyRow = useCallback(
    (row: TreeRow) =>
      run(async () => {
        const at = flat.findIndex((w) => w.id === row.id);
        // A ternary rather than `flat.at(at - 1)`: removing the first row has
        // no row above, and `.at(-1)` would send the focus to the last one.
        const above = at > 0 ? flat[at - 1] : undefined;
        focusNext.current = above === undefined ? null : { rowId: above.id, columnId: 'name' };
        await api.remove(row.id);
      }),
    [api, flat, run],
  );

  /**
   * The Name cell's own keys: Tab and Backspace, and nothing else.
   *
   * Enter is deliberately absent. It made a work item until `command-keys`,
   * and it is now the browser's own newline — which is what lets a note be
   * typed under the name in the box that holds both. A new work item is Ctrl+N
   * (Alt+N on the keyboards Chrome keeps Ctrl+N for) or Cmd/Ctrl+Enter at the
   * end of the plan; see {@link onCommandKey}.
   *
   * Proof: the `preventDefault + addSibling` branch put back, `Enter in a name
   * is a newline, and makes nothing` failed on `expected true to be false` —
   * the key taken, and no note typeable under any name. Watched, 2026-08-08.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, row: TreeRow) => {
      if (event.key === 'Tab') {
        const input = event.currentTarget;
        // Either element: the Name cell is a textarea so a long name wraps,
        // and both carry the selection fields `caretOf` reads.
        if (!isCellElement(input)) return;
        const caret = caretOf(input);
        // One rule for the structure keys: they fire at position zero, where
        // the key has no text meaning. Anywhere else — or over a selection —
        // Tab is what it is in any table: the next field, text selected the
        // way the browser's own Tab leaves it. At the grid's edge the key is
        // left to the browser rather than eaten.
        if (caret.atStart && !caret.hasSelection) {
          event.preventDefault();
          void (event.shiftKey ? outdent(row) : indent(row));
          return;
        }
        const moved = focusAdjacentCell(
          input,
          { rowId: row.id, columnId: 'name' },
          event.shiftKey ? -1 : 1,
        );
        if (moved) event.preventDefault();
        return;
      }
      if (event.key === 'Backspace') {
        // At position zero this key deletes nothing, so it is free — and
        // "backspace at the start of the line" is the outliner reflex for
        // "this does not belong under here". A selection keeps the key: the
        // user is deleting text, even when the selection touches the start.
        // Skipped rather than thrown on a non-input target, same as the grid.
        const input = event.currentTarget;
        if (!isCellElement(input)) return;
        const caret = caretOf(input);
        if (!caret.atStart || caret.hasSelection) return;
        if (row.parentId !== null) {
          event.preventDefault();
          void outdent(row);
          return;
        }
        // At root level outdenting has nowhere left to go, so this is Dany's
        // "backspace again": a wholly empty item is removed, the way the last
        // empty bullet of a list is. The Name is judged by the input rather
        // than the committed value — deleting every character and pressing
        // Backspace once more is one gesture, and blur has not happened yet.
        // Anything the item still holds vetoes the removal: content is only
        // ever deleted by the actions menu, never by a keystroke reflex.
        //
        // `input.value` is now both fields in one read: this box holds the
        // notes under the name, so a row with a note is not empty and cannot
        // be emptied by deleting the name off the top of it. `row.notes` is
        // the committed half of the same question, and it is not redundant:
        // emptying the box is not the same as having emptied the work item,
        // because the blur that would send the emptying has not happened and
        // everyone else still has the note.
        //
        // Proof, both conjuncts, watched 2026-08-08. `row.notes` dropped: `a
        // note that has not been deleted yet still vetoes the removal` failed
        // on `expected [['w1']] to deeply equal []` — a row deleted out from
        // under a note nobody had committed a deletion of. `input.value`
        // dropped: `anything the item holds vetoes the backspace removal`
        // failed on `expected [['w3']] to deeply equal []`, the row whose note
        // was typed and committed in this same box.
        const empty =
          input.value === '' &&
          row.notes === '' &&
          row.subRows.length === 0 &&
          row.dependsOn.length === 0 &&
          Object.keys(row.estimates).length === 0 &&
          // A half-typed estimate is not stored yet — it is a draft waiting for
          // the rest of its trio — and deleting the row would take it with it
          // without ever having shown it as saved. Typing counts as content.
          !Object.keys(drafts).some((key) => key.startsWith(`${row.id}::`));
        if (!empty) return;
        event.preventDefault();
        void removeEmptyRow(row);
      }
    },
    [drafts, indent, outdent, removeEmptyRow],
  );

  /**
   * Tab: the next field, or the previous one, from any cell in the grid.
   *
   * Every editable cell but the Name has this and nothing else for the key. The
   * Name's own handler holds the outliner special case — at the very start of
   * the text Tab indents the row and Shift+Tab outdents it — and everywhere
   * else in the text it makes this same move.
   *
   * The grid is the table, not one row: at the end of a row Tab walks into the
   * first field of the next. Only at the grid's own edge — past the last
   * editable cell of the last row — does `focusAdjacentCell` return false and
   * the key go to the browser, which lands on that row's ⋯ button. That is the
   * point rather than a leak: the actions are reachable at the end of the table
   * and never from the middle of a row, and no focus trap is added to stop a
   * reader Tabbing out of the table altogether. One stop per row since the
   * actions became a menu; it was two while they were buttons.
   *
   * Proof: dropped from the handler chain, `walks every field of a row in turn,
   * and on into the next row` failed at the first cell that no longer moved.
   * Watched, 2026-08-07.
   */
  const onTabKey = useCallback((event: React.KeyboardEvent, rowId: string, columnId: string) => {
    if (event.key !== 'Tab') return;
    const input = event.currentTarget;
    // Skipped rather than thrown on a target that is not a cell, the same way
    // the rest of the grid treats markup it did not write.
    if (!isCellElement(input)) return;
    const moved = focusAdjacentCell(input, { rowId, columnId }, event.shiftKey ? -1 : 1);
    if (moved) event.preventDefault();
  }, []);

  /**
   * Moves the focus between cells, or lets the browser have the key.
   *
   * The grid is read from the table's own DOM at the moment the key arrives, not
   * from a ref written during render. A ref written in render publishes rows
   * that React may not have committed — or may abandon — and a key pressed in
   * that window would look up a row the DOM does not have. Both reviewers found
   * that; the committed DOM is the only thing that cannot be ahead of itself.
   *
   * `:not([readonly])` is what keeps focus off a parent's rolled-up figures.
   * They are real numbers worth reading, and they are also numbers no keystroke
   * can change, which is the same reason the derived number column is not here.
   */
  const onArrowKey = useCallback(
    (event: React.KeyboardEvent<CellElement>, rowId: string, columnId: string) => {
      const table = event.currentTarget.closest('table');
      if (table === null) return;
      const grid = editableGrid(table);

      const move = nextCell(
        grid.map((g) => g.cell),
        { rowId, columnId },
        event.key,
        caretOf(event.currentTarget),
        {
          isComposing: event.nativeEvent.isComposing,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        },
      );
      if (move === null) return;

      const next = grid.find(
        (g) => g.cell.rowId === move.to.rowId && g.cell.columnId === move.to.columnId,
      )?.input;
      if (next === undefined) return;
      // Only now, and only because the move is happening: an unconditional
      // `preventDefault` would take the caret keys away from every input.
      event.preventDefault();
      focusCellAt(next, move.caretAt === 'start' ? 0 : next.value.length);
    },
    [],
  );

  /**
   * Alt and an arrow: restructure the row this cell belongs to.
   *
   * The four keys carry structure from **any** cell and **any** caret position,
   * which is what Tab and Backspace cannot do — those type, so they restructure
   * only at position zero of the Name cell where the keystroke has no text
   * meaning. Alt+arrow types nothing here: `nextCell` already leaves every
   * modified arrow to the browser, so the grid gives nothing up by taking these.
   *
   * `preventDefault` for every arrow this owns, including the edges and the
   * refusals. On macOS an un-prevented Alt+arrow jumps a word or a paragraph
   * and inserts a character into the field as well; a key handled halfway is
   * worse than either outcome. The trade — word-jump is no longer Alt's in
   * these cells — is stated in the change's proposal, and plain arrows and
   * Cmd+arrow still walk the caret.
   *
   * Not attached globally, and not to the dependency picker, the assignee
   * picker or the date inputs: it lives on the cells that already route their
   * own keys, which is where typing happens and where a row is being worked on.
   */
  const onAltMove = useCallback(
    (event: React.KeyboardEvent, row: TreeRow, columnId: string) => {
      // Which arrows this owns, and under which modifiers, is {@link altMoveIn}
      // — shared with the open `@` list, which has to recognize exactly the
      // same keystrokes in order to swallow them.
      const move = altMoveIn(event);
      if (move === null) return;
      // Proof: removed, nine of this block's tests failed on a key the browser
      // would still have acted on. Watched, 2026-08-06.
      event.preventDefault();
      // A held arrow repeats, and each repeat is a request and a refetch.
      // Dropped rather than queued while one is in flight: the tree the next
      // press would be judged against has not come back yet.
      // Proof: removed, `drops a second alt+down while the first is in flight`
      // failed with two moves asked for. Watched, 2026-08-06.
      if (busy) return;
      // be-01 refuses this too, and is the authority. Refusing here is what
      // lets the reason be read — the drag's own sentence, so one rule does not
      // acquire two wordings.
      // Proof: removed, `refuses to move a frozen row and says why` failed on
      // the move it sent. Watched, 2026-08-06.
      if (row.frozenNumber !== null) {
        pushToast({ kind: 'error', text: FROZEN_REFUSAL });
        return;
      }
      if (move === 'up' || move === 'down') {
        moveAmongSiblings(row, move, columnId);
        return;
      }
      void (move === 'indent' ? indent(row, columnId) : outdent(row, columnId));
    },
    [busy, indent, moveAmongSiblings, outdent, pushToast],
  );

  /** Takes the tint and the pending delete off, whatever the reason. */
  const disarmDelete = useCallback(() => {
    setArmedDelete(null);
  }, []);

  /**
   * Moves the focus to a cell by the chord's own grid walk, and says whether
   * there was one to move to.
   *
   * The DOM's grid, read at the moment the key arrives, for the reason
   * {@link onArrowKey} gives: a ref written during render can be ahead of what
   * React has committed.
   */
  const moveByCommand = useCallback(
    (input: CellElement, from: CellRef, direction: Direction): boolean => {
      const table = input.closest('table');
      if (table === null) return false;
      const grid = editableGrid(table);
      const move = commandMove(
        grid.map((g) => g.cell),
        from,
        direction,
      );
      if (move === null) return false;
      const next = grid.find(
        (g) => g.cell.rowId === move.to.rowId && g.cell.columnId === move.to.columnId,
      )?.input;
      if (next === undefined) return false;
      focusCellAt(next, move.caretAt === 'start' ? 0 : next.value.length);
      return true;
    },
    [],
  );

  /**
   * The Name cell of the row after this one, or undefined on the last row.
   *
   * Read out of the committed grid rather than out of `flat`, so "the next row"
   * means the next row **on screen**: a collapsed branch's children are not
   * cells, and Cmd+Enter must not land in one of them.
   */
  const nextRowName = useCallback((input: CellElement, rowId: string): CellElement | undefined => {
    const table = input.closest('table');
    if (table === null) return undefined;
    const grid = editableGrid(table);
    const rowIds = [...new Set(grid.map((g) => g.cell.rowId))];
    const at = rowIds.indexOf(rowId);
    // `< 0` before the lookup, for `focusAdjacentCell`'s reason: `.at(-1)`
    // would read the last row of the table as the one after this one.
    if (at === -1) return undefined;
    const next = rowIds.at(at + 1);
    return next === undefined
      ? undefined
      : grid.find((g) => g.cell.rowId === next && g.cell.columnId === 'name')?.input;
  }, []);

  /**
   * Ctrl+D: arm this row, or delete the one already armed.
   *
   * **Nothing here destroys anything on one gesture, and that is the price of
   * putting a delete on a chord at all.** The first press tints the row and
   * says what the second one will do; the second press has to satisfy all of
   * it — the same row, a `keyup` of D since the arm, and a press rather than a
   * key repeat.
   *
   * Proof, four faults, all watched 2026-08-08. The `repeat` conjunct removed:
   * `a repeat after the confirming press does not arm the row that took its
   * place` failed on `expected '020' to be null` — the key still down as the
   * row went, arming whatever slid up into it. The `dReleased` conjunct
   * removed: `two presses with no release between them only re-arm` failed on
   * `expected null to be '020'` — one gesture destroying a row, so there was
   * no arm left to find. The same-row conjunct removed: `arming 020 and
   * pressing Ctrl+D on 030 arms 030 and deletes neither` failed on `expected
   * null to be '030'`, the second press deleting a row the arm never pointed
   * at. The frozen refusal removed: `a frozen row refuses to arm and says how
   * to unfreeze it` failed on `expected [ Array(1) ] to include '020 is frozen
   * — unfreeze it first'`.
   *
   * @param row The row the chord was pressed in.
   * @param repeat Whether the browser says this is a held key repeating.
   */
  const armOrDeleteRow = useCallback(
    (row: TreeRow, repeat: boolean) => {
      // A key repeat is neither an arm nor a confirm. Before the frozen
      // refusal too, so a held chord on a frozen row is one sentence.
      if (repeat) return;
      if (row.frozenNumber !== null) {
        pushToast({ kind: 'error', text: `${row.number} is frozen — unfreeze it first` });
        disarmDelete();
        return;
      }
      if (armedDelete !== null && armedDelete.rowId === row.id && dReleased.current) {
        disarmDelete();
        void deleteRow(row).then((outcome) => {
          if (outcome !== 'landed') return;
          // The way back, in the sentence that says it happened: this is the
          // one chord in the table that takes work away.
          pushToast({ kind: 'info', text: `Deleted ${row.number} — Cmd+Z restores` });
        });
        return;
      }
      dReleased.current = false;
      setArmedDelete({ rowId: row.id, number: row.number });
      pushToast({
        kind: 'info',
        text: `Ctrl+D again deletes ${row.number} — its children move up`,
      });
    },
    [armedDelete, deleteRow, disarmDelete, pushToast],
  );

  /**
   * The command chords, from whichever cell they were pressed in.
   *
   * One handler for every cell class rather than one listener on the window,
   * which is what keeps `isTypingInto` and the undo/redo page-level guard out
   * of this entirely: these chords are only ever meant *inside* the grid, and a
   * global listener would have to reconstruct which cell it was standing in.
   * Each cell class calls this from its own `onKeyDown`, and the cells whose
   * picker list is open do not call it at all — the open list owns the
   * keyboard, and Escape is how it is given back.
   *
   * `preventDefault` for every chord this claims, including the ones that turn
   * out to have nowhere to go. Ctrl+H at the left edge of the table is still
   * Ctrl+H, and Chrome's answer to it is the history.
   *
   * The three chords that write flush the cell first and **await** it: the same
   * commit a blur runs, through {@link flushCell}, so what was typed is be-01's
   * before a row is created or the focus moves — and so a refusal leaves the
   * caret where it was with nothing created. Rule 5 in `cell-input.tsx` is what
   * keeps the blur that follows from sending it again.
   *
   * Proof, three faults, all watched 2026-08-08. The `await` dropped, the
   * outcome hard-coded to `landed` and the flush fired and forgotten: `waits
   * for the save to land before it creates anything` failed on `expected
   * [ 'patch', 'create' ] to deeply equal [ 'patch' ]` — a row created against
   * an answer nobody had. The `refused` return removed: `a refused save leaves
   * the caret where it was and makes no row` failed on `expected [ '010',
   * '020', '030', '040' ] to deeply equal [ '010', '020', '030' ]`. The
   * `preventDefault` removed: `a chord at the grid’s edge is consumed rather
   * than leaking to the browser` failed on `expected false to be true`.
   */
  const onCommandKey = useCallback(
    (event: React.KeyboardEvent, row: TreeRow, columnId: string) => {
      const command: Command | null = commandChordIn(event);
      if (command === null) {
        // Every other keystroke is what disarms a pending Ctrl+D — except the
        // modifiers, which are how the second Ctrl+D is reached at all. agy #9.
        if (!MODIFIER_KEYS.has(event.key)) disarmDelete();
        return;
      }
      event.preventDefault();
      if (command === 'delete') {
        armOrDeleteRow(row, event.nativeEvent.repeat);
        return;
      }
      // Any command that is not the confirm is a keystroke like any other.
      disarmDelete();
      const input = event.currentTarget;
      if (!isCellElement(input)) return;
      if (command !== 'new-item' && command !== 'next-or-create') {
        moveByCommand(input, { rowId: row.id, columnId }, command);
        return;
      }
      // Read now, not in the continuation: `currentTarget` is nulled the
      // moment this handler returns, and the tree the next row is found in is
      // the one that was on screen when the chord was pressed.
      const landsOn = nextRowName(input, row.id);
      if (commandInFlight.current) return;
      commandInFlight.current = true;
      void (async () => {
        try {
          const outcome = await flushCell(input);
          // A refused save is the only copy of what was typed. The caret stays
          // in it, and nothing is created above or below it.
          if (outcome === 'refused') return;
          // The next row, where there is one — and a new sibling where there
          // is not, which is what makes this the chord that walks a plan being
          // written. Ctrl+N is the one that creates mid-table.
          if (command === 'next-or-create' && landsOn !== undefined) {
            // Selected on arrival, the way every other keyboard move into a
            // cell in this table leaves it.
            focusCellAt(landsOn, 'all');
            return;
          }
          await addSibling(row);
        } finally {
          commandInFlight.current = false;
        }
      })();
    },
    [addSibling, armOrDeleteRow, disarmDelete, moveByCommand, nextRowName],
  );

  /**
   * The callbacks the cells use, read through a ref rather than closed over.
   *
   * `busy` was already kept out of the dependency list below, for the reason
   * that comment gives. It was not enough: `onKeyDown` reaches `flat` through
   * `indent` and `outdent`, and `flat` is rebuilt by every refresh — so every
   * edit by anyone else remounted every cell in the table and took the focus and
   * the half-typed value of whoever was mid-sentence. Two reviewers found it.
   *
   * Assigned during render on purpose, not in an effect: a cell can fire before
   * effects flush after a re-render, and a handler one render stale would act on
   * the tree that was on screen a moment ago.
   */
  /**
   * The numbers of the work items an id list names, in the order given.
   *
   * A dependency is stored by id and read by number, because an id is not
   * something anyone can look at. A row whose predecessor has since been deleted
   * simply drops out of the list rather than rendering a blank chip — the tree
   * refetches on every change, so this cannot be stale for long.
   */
  const numbersOf = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const found = flat.find((row) => row.id === id);
        return found === undefined ? [] : [{ id, number: found.number }];
      }),
    [flat],
  );

  /**
   * Adds the dependencies a typed list of *numbers* names — several at once.
   *
   * Numbers, not ids: numbers are what is on screen, and a typo is then a number
   * nobody has rather than a 404 carrying a uuid that means nothing to whoever
   * is reading it.
   *
   * Several, because a row that waits for three things is ordinary and typing
   * `010, 020, 030` once beats three rounds of type-Enter. Each is still its own
   * request — be-01 judges every edge against the graph including the ones just
   * added, so asking it to take a batch would mean teaching it a second way to
   * do the same thing.
   *
   * Partial success is deliberate. A typo in the middle keeps the numbers around
   * it, and one refused as a cycle keeps the rest; what landed is visible in the
   * chips and what did not is named. All-or-nothing here would throw away four
   * correct entries over a fifth.
   *
   * **One toast for the whole list**, however many entries were refused. Both
   * UX reviewers killed a toast per change for being noise, and three boxes
   * saying three halves of one answer is that failure wearing a different hat:
   * a typed list is one gesture and its outcome is one sentence.
   */
  const dependOn = useCallback(
    (successorId: string, typed: string) => {
      const { found, unknown } = parseDependencies(typed, flat);
      const notThere = unknownMessage(unknown);
      if (found.length === 0) {
        if (notThere !== null) pushToast({ kind: 'error', text: notThere });
        return;
      }

      // Not routed through `run`, deliberately. `run` models all-or-nothing:
      // one request, and a throw abandons the reread. Here a partial success is
      // a real outcome — some edges land, some are refused, and both the new
      // chips and the reasons have to survive. Through `run` a refusal skipped
      // the refresh that would have shown the edges that did land.
      void (async () => {
        setBusy(true);
        const refused: string[] = [];
        try {
          for (const predecessor of found) {
            try {
              await api.addDependency(successorId, predecessor.id);
            } catch (thrown: unknown) {
              // Collected rather than rethrown, so one refusal does not abandon
              // the numbers after it. The reason is be-01's own word — `cycle`,
              // `ancestor` — beside the number it belongs to.
              refused.push(`${predecessor.number} (${failureText(thrown, 'refused')})`);
            }
          }
          // Never rejects: a failed reread raises the banner and returns, so
          // the refusals below are still reported. The two are different facts
          // and a reader who saw only one of them would be misled either way.
          await refreshOrMarkStale();
        } finally {
          setBusy(false);
        }
        const problems = [
          notThere,
          refused.length === 0
            ? null
            : `${refused.length === 1 ? 'Refused' : 'These were refused'}: ${refused.join(', ')}.`,
        ].filter((line): line is string => line !== null);
        // Proof: split into one push per line, `reports every refused
        // dependency in one toast, not one each` failed with two. Watched,
        // 2026-08-06.
        if (problems.length > 0) pushToast({ kind: 'error', text: problems.join(' ') });
      })();
    },
    [api, flat, pushToast, refreshOrMarkStale],
  );

  /**
   * The rows the picker may offer `forRow`, narrowed by what is typed, each
   * marked with the refusal be-01 would answer with.
   *
   * Recomputed from `flat` on every render rather than remembered: a peer's
   * edit lands as a whole new tree, and a list that kept yesterday's marks
   * would grey a row that has since moved out of this one.
   */
  const depEntriesFor = useCallback(
    (forRow: { id: string; dependsOn: readonly string[] }, typed: string) =>
      pickerEntries(flat, forRow, typed),
    [flat],
  );

  /**
   * Adds the picked dependency and keeps the picker open, cleared, for the
   * next one — picking three predecessors is one visit, not three.
   */
  const pickDependency = useCallback(
    (successorId: string, predecessorId: string) => {
      setDepPicker((current) =>
        current === null ? null : { ...current, typed: '', highlightId: null },
      );
      void run(() => api.addDependency(successorId, predecessorId));
    },
    [api, run],
  );

  /** Moves the picker highlight by `delta` over `entryIds`, clamped. */
  const moveDepHighlight = useCallback(
    (rowId: string, delta: 1 | -1, entryIds: readonly string[]) => {
      if (entryIds.length === 0) return;
      setDepPicker((current) => {
        if (current?.rowId !== rowId) return current;
        const at = current.highlightId === null ? -1 : entryIds.indexOf(current.highlightId);
        // From nothing highlighted — or a highlight whose row left the list —
        // Down enters at the top and Up at the bottom.
        const from = at === -1 ? (delta === 1 ? -1 : entryIds.length) : at;
        const to = Math.min(entryIds.length - 1, Math.max(0, from + delta));
        return { ...current, highlightId: entryIds[to] ?? null };
      });
    },
    [],
  );

  // A roles change rebuilds the column definitions and remounts every cell —
  // the one remount this table still allows itself. React fires no blur on an
  // unmounted input, so an open picker would stay open under a fresh, unfocused
  // cell with no keyboard attached to it. Closed instead.
  useEffect(() => {
    setDepPicker(null);
  }, [roles]);

  /**
   * Whether the numbers in the schedule columns mean anything.
   *
   * When be-01 could not order the graph it sends every row the same zeroed
   * schedule, and printing those is a page of `0`s that reads as "everything
   * happens on day zero" — a confident wrong answer of exactly the kind the
   * banner above is there to prevent. A reviewer caught the columns still doing
   * it while `verify.md` claimed they did not.
   */
  /**
   * One trio as it currently reads: the draft where there is one, the stored
   * figure where there is not.
   *
   * The draft wins because it is what the person typed and has not been told
   * off about yet. A stored figure showing through under it would be the tool
   * quietly disagreeing with the box.
   */
  const typedTrio = useCallback(
    (row: TreeRow, roleId: string): TypedTrio => {
      const stored = row.estimates[roleId];
      const read = (point: Point): string =>
        drafts[draftKey(row.id, roleId, point)] ?? showDays(stored, point);
      return {
        optimistic: read('optimistic'),
        realistic: read('realistic'),
        pessimistic: read('pessimistic'),
      };
    },
    [drafts],
  );

  const estimateValue = useCallback(
    (row: TreeRow, roleId: string, point: Point): string => typedTrio(row, roleId)[point],
    [typedTrio],
  );

  /**
   * What is wrong with this row-and-role's trio, or null.
   *
   * A parent's figures are rolled up rather than typed, so they are never
   * anyone's mistake: complaining about a sum the tool computed would be the
   * tool telling somebody off for its own arithmetic.
   */
  const trioProblemFor = useCallback(
    (row: TreeRow, roleId: string) => (row.rolledUp ? null : trioProblem(typedTrio(row, roleId))),
    [typedTrio],
  );

  /**
   * Forgets every draft of one row-and-role — the three boxes' and the folded
   * cell's — once be-01 has the answer.
   *
   * All four together, whichever of them was typed: they are drafts of one
   * estimate, and leaving the others behind would put a stale entry back on
   * screen the moment the role was folded or unfolded.
   *
   * Rebuilt without those keys rather than deleted from a copy: `delete` on a
   * computed key is banned here, and filtering says the same thing without
   * reaching into the object twice.
   */
  const forgetEstimateDrafts = useCallback((rowId: string, roleId: string) => {
    setDrafts((current) => dropDrafts(current, estimateDraftKeys(rowId, roleId)));
  }, []);

  /**
   * Takes a typed estimate box: holds it as a draft, and either sends the trio
   * once it can stand on its own or clears the stored one it just emptied.
   *
   * Nothing is repaired and nothing partial is sent — that is the whole of
   * Dany's "never edit estimates", and emptying boxes does not weaken it. A
   * deletion is only all three boxes reading empty against a trio be-01
   * actually holds; one or two empty boxes is a half-filled trio and stays a
   * complaint. The drafts for the trio are dropped only once be-01 has
   * accepted the write, so a refused request leaves what was typed on screen
   * to be corrected rather than swallowed.
   *
   * Proof: making the clear fire on `!== null` drafts instead of an empty trio
   * — i.e. on one emptied box — fails `does not clear when only two of the
   * three boxes are emptied` in `wbs-table.test.tsx`; watched, 2026-08-06.
   */
  const commitEstimate = useCallback(
    (row: TreeRow, roleId: string, point: Point, typed: string): Promise<CommitOutcome> => {
      const next = { ...typedTrio(row, roleId), [point]: typed };
      setDrafts((current) => ({
        // A box edited last drops the folded cell's pending shorthand for this
        // trio: one row and role has one draft, whichever way it was typed.
        // Proof: left as `...current`, `lets a box replace what the folded cell
        // was holding` fails — the refused `8/3/2` came back over the box's
        // own complaint. Watched, 2026-08-06.
        ...dropDrafts(current, new Set([combinedDraftKey(row.id, roleId)])),
        [draftKey(row.id, roleId, point)]: typed,
      }));
      const days = sendableTrio(next);
      if (days === null) {
        // `hasOwn` rather than a truthiness test: what matters is whether
        // be-01 holds a trio for this row and role at all, and a stored
        // `0 / 0 / 0` is one.
        if (isTrioEmpty(next) && Object.hasOwn(row.estimates, roleId)) {
          return run(async () => {
            await api.clearEstimate(row.id, roleId);
            forgetEstimateDrafts(row.id, roleId);
          });
        }
        // A half-filled trio is a complaint, not a request: what was typed
        // stays in `drafts`, which is where this cell's unsent text lives.
        return unsent();
      }
      return run(async () => {
        await api.setEstimate(row.id, roleId, days);
        forgetEstimateDrafts(row.id, roleId);
      });
    },
    [api, forgetEstimateDrafts, run, typedTrio],
  );

  /**
   * What the folded role column's cell reads: the pending shorthand if there
   * is one, and otherwise be-01's computed final figure.
   *
   * The one cell in the table whose value at rest is not what typing into it
   * takes. That is deliberate and it is the point: a plan is read by the final
   * figure, and the trio behind it is what an estimator types. The draft wins
   * while it exists for the same reason a box's does — it is what the person
   * typed and has not been told off about yet.
   */
  const combinedValue = useCallback(
    (row: TreeRow, roleId: string): string =>
      drafts[combinedDraftKey(row.id, roleId)] ?? showFinal(row.finalDays[roleId]),
    [drafts],
  );

  /**
   * What is wrong with what the folded column is showing for one row and role,
   * or null.
   *
   * Two sources, never both at once: the folded cell's own shorthand if
   * something is pending there, and otherwise the three boxes' trio — which is
   * the complaint `role-columns-fold` put on the figure so a fold could not
   * hide one. Precedence rather than a merge, because the draft that exists is
   * the one somebody typed last, and it is the only one they can correct
   * without unfolding.
   */
  const combinedProblem = useCallback(
    (row: TreeRow, roleId: string): string | null => {
      // `hasOwn` rather than a nullish test: an empty draft is a person having
      // just emptied the cell, and it is the entry that reads as a clear —
      // reading it as "nothing pending here" would show the stored figure back
      // over the emptying.
      // Proof: returning null instead of the boxes' complaint fails `a folded
      // role cannot hide a complaint`, `marks the folded cell when the boxes
      // hold a trio that saves nothing` and `lets a box replace what the
      // folded cell was holding`. Watched, 2026-08-06.
      const key = combinedDraftKey(row.id, roleId);
      if (!Object.hasOwn(drafts, key)) return trioProblemFor(row, roleId)?.message ?? null;
      const entry = parseTrioShorthand(drafts[key]);
      return entry.kind === 'problem' ? entry.message : null;
    },
    [drafts, trioProblemFor],
  );

  /**
   * Takes a whole trio typed into one cell as `o/r/p`, and sends it in one
   * request — or holds it as a draft and complains, exactly as a box does.
   *
   * The shorthand is the estimating loop's short path: the role stays folded,
   * one cell takes `2/3/8`, and be-01 is asked once rather than three times.
   * `5` means `5/5/5` because the person typed one number meaning three equal
   * ones; nothing here invents a figure, and a trio that runs backwards, has
   * the wrong count or is not a number is refused whole — see
   * {@link parseTrioShorthand}.
   *
   * Emptying the cell against a stored trio clears it through the same
   * `clearEstimate` the three emptied boxes use; emptying it against nothing
   * stored asks for nothing.
   *
   * Proof: made to send a two-number entry (`parseTrioShorthand` returning a
   * trio for `2/3`), `sends nothing for two numbers where three were needed`
   * in `wbs-table.test.tsx` fails; watched, 2026-08-06.
   */
  const commitCombinedEstimate = useCallback(
    (row: TreeRow, roleId: string, typed: string, baseline: string): Promise<CommitOutcome> => {
      // The estimate half, always — {@link parseTrioShorthand} never sees a
      // mention. Two things follow, and both are refusals to send rather than
      // repairs: a cell left with `@ka` still in it whose estimate half is
      // what the cell was already showing has nothing to commit (`4.8@ka` is a
      // figure this tool computed and a search nobody finished, not somebody
      // asking for 4.8/4.8/4.8), and an *empty* estimate half beside a mention
      // is the select-on-focus rather than somebody clearing an estimate.
      // Emptying a cell with no `@` in it still clears it.
      const { estimate, mention: fragment } = splitMention(typed);
      if (fragment !== null && (estimate.trim() === '' || estimate === baseline)) return unsent();
      const entry = parseTrioShorthand(estimate);
      setDrafts((current) => ({
        // Last edit wins: this entry replaces whatever the three boxes were
        // holding unsent for the same trio. Translating it into three box
        // drafts instead would put figures into boxes nobody typed them into.
        // Proof: left as `...current`, `lets a folded entry replace what the
        // boxes were holding` fails — the box still held a `7` nobody could
        // see. Watched, 2026-08-06.
        ...dropDrafts(current, new Set(POINTS.map((point) => draftKey(row.id, roleId, point)))),
        // The estimate half, so a draft rendered back into the box can never
        // carry a mention somebody abandoned.
        [combinedDraftKey(row.id, roleId)]: estimate,
      }));
      if (entry.kind === 'problem') return unsent();
      if (entry.kind === 'empty') {
        // `hasOwn`, as above: a stored `0 / 0 / 0` is an estimate to clear.
        // Proof: inverted, `clears the stored trio when the cell is emptied`
        // and `asks for nothing when a cell with no estimate is emptied` both
        // fail — one clear lost, one deletion posted per cell tabbed through.
        // Watched, 2026-08-06.
        if (!Object.hasOwn(row.estimates, roleId)) return unsent();
        return run(async () => {
          await api.clearEstimate(row.id, roleId);
          forgetEstimateDrafts(row.id, roleId);
        });
      }
      return run(async () => {
        await api.setEstimate(row.id, roleId, entry.days);
        forgetEstimateDrafts(row.id, roleId);
      });
    },
    [api, forgetEstimateDrafts, run],
  );

  /**
   * Sets or clears one work item's "not before" day.
   *
   * A floor rather than a pin, which be-01 enforces: everything that depends
   * on this row still moves with it, and a predecessor finishing later still
   * wins. Dany's call — it keeps the calendar and the dependency tree from
   * being able to contradict each other.
   */
  const setNotBefore = useCallback(
    (id: string, day: string | null) => {
      void run(() => api.patch(id, { startNoEarlierThan: day }));
    },
    [api, run],
  );

  /** Labels a work item with a team, or takes the label off. */
  const setTeamOf = useCallback(
    (id: string, serviceTeamId: string | null) => {
      void run(() => api.patch(id, { serviceTeamId }));
    },
    [api, run],
  );

  /** Adds a team nobody had yet and labels the work item with it, in one go. */
  const createTeamFor = useCallback(
    (id: string, name: string) => {
      void run(async () => {
        // be-01 is idempotent by name, so two browsers typing `Platform` at
        // once end up on one team rather than two.
        const team = await api.addTeam(name);
        await api.patch(id, { serviceTeamId: team.id });
      });
    },
    [api, run],
  );

  const assignTo = useCallback(
    (id: string, roleId: string, personId: string | null) => {
      void run(() => api.assign(id, roleId, personId));
    },
    [api, run],
  );

  /**
   * Adds a person and assigns them, joining them to the work item's team.
   *
   * A person typed in against a work item labelled `Billing` almost certainly
   * belongs to Billing, and saying so beats leaving every new person a free
   * agent for somebody to sort out later. Typed in against an unlabelled work
   * item, they are a free agent — which is the absence of a team rather than
   * membership of one.
   */
  const createPersonFor = useCallback(
    (row: TreeRow, roleId: string, name: string) => {
      void run(async () => {
        const person = await api.addPerson(
          name,
          row.serviceTeamId === null ? [] : [row.serviceTeamId],
        );
        await api.assign(row.id, roleId, person.id);
      });
    },
    [api, run],
  );

  /** Changes how the project turns its trios into one number, for everybody. */
  const chooseEstimateMethod = useCallback(
    (method: EstimateMethod) => {
      void run(() => api.setEstimateMethod(projectId, method));
    },
    [api, projectId, run],
  );

  /**
   * Takes the focus into a folded role's cell, remembering what it holds.
   *
   * Called from the box's own `onFocus`, before the select that cell has
   * always done — the value has to be read while it is still there.
   */
  const enterFoldedCell = useCallback((box: CellElement) => {
    foldedBox.current = box;
    foldedAtFocus.current = box.value;
  }, []);

  /**
   * Reads a folded role's box on every keystroke and opens or closes its `@`
   * picker.
   *
   * The estimate half is not touched here and no draft is written: what has
   * been typed lives in the box until the cell is left, exactly as it did
   * before mentions existed. All this does is decide whether a list is open
   * and what it is filtered by.
   */
  const readFoldedCell = useCallback((rowId: string, roleId: string, box: CellElement) => {
    const { mention: fragment } = splitMention(box.value);
    setMention(fragment === null ? null : { rowId, roleId, typed: fragment });
  }, []);

  /**
   * Takes the `@fragment` back out of the focused folded box, leaving the
   * estimate half exactly as it was.
   *
   * The empty case is the one worth reading: a cell is selected on focus, so
   * `@` typed straight into one replaces the figure it was showing, and an
   * empty estimate half committed on the blur that follows would clear an
   * estimate the person never touched. So an empty half is put back to what
   * the cell held when the focus arrived. Emptying a cell deliberately — with
   * no `@` in it — still clears the estimate, which is the gesture the cheat
   * sheet documents.
   */
  const takeMentionOut = useCallback(() => {
    const box = foldedBox.current;
    if (box !== null) {
      const { estimate } = splitMention(box.value);
      box.value = estimate.trim() === '' ? foldedAtFocus.current : estimate;
    }
    setMention(null);
  }, []);

  /**
   * Closes the `@` list and leaves the box exactly as it is — Escape's answer,
   * and the same one every picker in this table gives it.
   */
  const closeMention = useCallback(() => {
    setMention(null);
  }, []);

  /** Leaves a folded cell: the mention goes with the focus, the estimate stays. */
  const leaveFoldedCell = useCallback(() => {
    takeMentionOut();
    foldedBox.current = null;
  }, [takeMentionOut]);

  /**
   * What the `@` picker in one folded cell is offering.
   *
   * The same three kinds of entry the unfolded assignee column has, in the
   * order they are read in: the people whose names contain what was typed,
   * `Add "…"` when nothing matches it exactly, and `Remove …` when somebody is
   * already assigned. Enter takes the first of them, which is
   * {@link CreatablePicker}'s rule — so `Remove` is first on a bare `@` and
   * nowhere else, and `@ka⏎` can never be the gesture that unassigns anybody.
   */
  const mentionOptions = useCallback(
    (row: TreeRow, roleId: string): PickerOption[] => {
      const open = mention;
      if (open?.rowId !== row.id || open.roleId !== roleId) return [];
      const wanted = open.typed.trim().toLowerCase();
      const assigned = row.assignees[roleId];
      const assignedPerson = people.find((each) => each.id === assigned);
      const matching = people.filter(
        (each) => wanted === '' || each.name.toLowerCase().includes(wanted),
      );
      const exact = people.some((each) => each.name.toLowerCase() === wanted);
      return [
        ...(wanted === '' && assignedPerson !== undefined
          ? [
              {
                key: '(remove)',
                label: `Remove ${assignedPerson.name}`,
                selected: false,
                take: () => {
                  assignTo(row.id, roleId, null);
                  takeMentionOut();
                },
              },
            ]
          : []),
        ...matching.map((each) => ({
          key: each.id,
          label: pickableLabel({
            id: each.id,
            name: each.name,
            detail:
              each.teamIds.length === 0
                ? 'free agent'
                : each.teamIds
                    .map((id) => teams.find((team) => team.id === id)?.name ?? '?')
                    .join(', '),
          }),
          selected: each.id === assigned,
          take: () => {
            assignTo(row.id, roleId, each.id);
            takeMentionOut();
          },
        })),
        ...(wanted !== '' && !exact
          ? [
              {
                key: '(add)',
                label: `Add “${open.typed.trim()}”`,
                selected: false,
                take: () => {
                  createPersonFor(row, roleId, open.typed.trim());
                  takeMentionOut();
                },
              },
            ]
          : []),
      ];
    },
    [assignTo, createPersonFor, mention, people, takeMentionOut, teams],
  );

  /**
   * What a schedule column's heading says about itself, in a `title`.
   *
   * The headings are one word each — the columns are 52px — so the fact that
   * decides how to read the figures under them cannot be in the heading text:
   * without a project start date these are day numbers counted from day zero,
   * and with one they are calendar dates. A bare `2.5` under "Start" reads as
   * a date that failed to load, and this sentence is where that is answered.
   */
  const startDateHint = useCallback(
    (what: string): string =>
      startDate === null
        ? `This work item's ${what}, in days from the start of the plan. Set a project start date to see real dates.`
        : `This work item's ${what}.`,
    [startDate],
  );

  const hasSchedule = useCallback(() => scheduleError === null, [scheduleError]);
  const showSchedule = useCallback(
    (days: number) => (scheduleError === null ? showDay(days) : '—'),
    [scheduleError],
  );

  const live = useRef({
    api,
    projectId,
    run,
    busy,
    duplicateRow,
    deleteRow,
    commitNameCell,
    onKeyDown,
    onTabKey,
    onArrowKey,
    onAltMove,
    onCommandKey,
    armedDelete,
    setDragging,
    setDropHint,
    numbersOf,
    dependOn,
    hasSchedule,
    showSchedule,
    startDateHint,
    depPicker,
    setDepPicker,
    openMenuRowId,
    setOpenMenuRowId,
    depEntriesFor,
    pickDependency,
    moveDepHighlight,
    estimateValue,
    trioProblemFor,
    commitEstimate,
    combinedValue,
    combinedProblem,
    commitCombinedEstimate,
    mention,
    enterFoldedCell,
    readFoldedCell,
    closeMention,
    leaveFoldedCell,
    mentionOptions,
    hoveredNotes,
    setHoveredNotes,
    setNotBefore,
    startDate,
    teams,
    people,
    setTeamOf,
    createTeamFor,
    assignTo,
    createPersonFor,
    toggleRole,
    matchIds: search.matchIds,
    searching,
  });
  live.current = {
    api,
    projectId,
    run,
    busy,
    duplicateRow,
    deleteRow,
    commitNameCell,
    onKeyDown,
    onTabKey,
    onArrowKey,
    onAltMove,
    onCommandKey,
    armedDelete,
    setDragging,
    setDropHint,
    numbersOf,
    dependOn,
    hasSchedule,
    showSchedule,
    startDateHint,
    depPicker,
    setDepPicker,
    openMenuRowId,
    setOpenMenuRowId,
    depEntriesFor,
    pickDependency,
    moveDepHighlight,
    estimateValue,
    trioProblemFor,
    commitEstimate,
    combinedValue,
    combinedProblem,
    commitCombinedEstimate,
    mention,
    enterFoldedCell,
    readFoldedCell,
    closeMention,
    leaveFoldedCell,
    mentionOptions,
    hoveredNotes,
    setHoveredNotes,
    setNotBefore,
    startDate,
    teams,
    people,
    setTeamOf,
    createTeamFor,
    assignTo,
    createPersonFor,
    toggleRole,
    matchIds: search.matchIds,
    searching,
  };

  const columns = useMemo(
    () => [
      column.display({
        id: 'drag',
        header: () => <span aria-label="Reorder" />,
        cell: ({ row }) => {
          // A frozen row keeps its handle, and says on it why the handle will
          // not help. Hiding it was the first attempt, and it made the refusal
          // unreachable: nothing could explain the freeze to someone who tried,
          // and the test that claimed to prove the refusal was proving only that
          // the handle was gone. Both reviewers found that test.
          const frozen = row.original.frozenNumber !== null;
          return (
            <span
              draggable
              role="button"
              tabIndex={-1}
              aria-disabled={frozen}
              aria-label={`Reorder ${row.original.number}`}
              title={
                frozen ? 'Frozen — unfreeze this row before moving it' : 'Drag to move this row'
              }
              style={{ cursor: frozen ? 'not-allowed' : 'grab' }}
              onDragStart={() => {
                live.current.setDragging(row.original.id);
              }}
              onDragEnd={() => {
                live.current.setDragging(null);
                live.current.setDropHint(null);
              }}
            >
              ⠿
            </span>
          );
        },
      }),
      column.display({
        id: 'number',
        header: 'Number',
        cell: ({ row }) => (
          <span style={{ paddingLeft: indentFor(row.depth), whiteSpace: 'nowrap' }}>
            {/*
              No triangles while a search is on. What is open during a search
              is the search's answer — every kept row, so no match can be
              hidden — and this control would have to either lie about that or
              close a branch holding a hit. Its state also lives in the
              reader's own expansion, which the search deliberately does not
              touch, so a click here would appear to do nothing.
            */}
            {row.getCanExpand() && !live.current.searching ? (
              <button
                type="button"
                aria-label={`${row.getIsExpanded() ? 'Collapse' : 'Expand'} ${row.original.number}`}
                onClick={row.getToggleExpandedHandler()}
              >
                {row.getIsExpanded() ? '▾' : '▸'}
              </button>
            ) : null}
            {row.original.frozenNumber !== null && <span aria-label="Number is frozen">🔒</span>}
            <span data-number>{row.original.number}</span>
          </span>
        ),
      }),
      column.display({
        id: 'name',
        header: 'Name',
        cell: ({ row }) => {
          // Why this row is on screen, at a glance: a hit is tinted, and every
          // other row in a narrowed table is context — an ancestor placing a
          // hit, or work underneath one. Read through `live` rather than closed
          // over, for the reason the dependency list below gives: `columns`
          // must not depend on anything that changes per keystroke.
          // Proof: hard-coded to false, `marks the row that matched, so the
          // rows around it read as context` and `shows the whole subtree under
          // a matched parent` failed — the second because it is the mark that
          // says the parent is the hit and the subtree is not. Watched,
          // 2026-08-06.
          const matched = live.current.matchIds.has(row.original.id);
          const hovered = live.current.hoveredNotes === row.original.id;
          return (
            <span
              // `block`, not `inline-block`: a shrink-to-fit wrapper and a
              // `width: 100%` textarea inside it define each other in a circle.
              // It is also the positioned ancestor the preview below is placed
              // against — which decides where the preview opens, not whether it
              // is clipped. The clipper is the `<td>`, and it is what
              // {@link POPOVER_COLUMNS} exempts.
              style={{ position: 'relative', display: 'block', maxWidth: '100%' }}
              onMouseEnter={() => {
                live.current.setHoveredNotes(row.original.id);
              }}
              onMouseLeave={() => {
                live.current.setHoveredNotes((current) =>
                  current === row.original.id ? null : current,
                );
              }}
            >
              <CellInput
                aria-label={`Name of ${row.original.number}`}
                data-name-input={row.original.id}
                data-match={matched ? 'true' : undefined}
                data-cell={cellKey(row.original.id, 'name')}
                // A work item's name is a sentence, not a word, and an input
                // scrolls it out of sight one character at a time. A textarea
                // wraps, and `autoSize` is what stops it wrapping into a line
                // nobody can see: the box is as tall as its name, focused or
                // not. It holds the notes under the name as well, which is what
                // `maxRestRows` caps — past four lines the box scrolls and the
                // hover preview is where a long note is read.
                // Enter is still "new work item" — the table preventDefaults it.
                multiline
                autoSize
                rows={1}
                maxRestRows={4}
                style={{
                  // The cell's width, not a width of its own: `22em` was one of
                  // the three opinions that produced the overlap, and it is the
                  // colgroup's job now.
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  font: 'inherit',
                  ...(matched ? { background: MATCH_TINT } : {}),
                }}
                // A callback ref rather than an effect: it fires exactly when
                // this node is attached, so the focus cannot be lost to a later
                // render arriving before the row does. That race is what
                // Enter-Enter-Enter depends on not losing. It fires on every
                // render rather than only the first, which the id check already
                // tolerated.
                onAttach={(element) => {
                  const wanted = focusNext.current;
                  // The Name column only: any other column is a cell this one
                  // has no business focusing, and it is landed on from the
                  // committed DOM by the effect that reads `focusNext` after a
                  // refresh.
                  if (wanted?.rowId !== row.original.id || wanted.columnId !== 'name') return;
                  focusNext.current = null;
                  element.focus();
                }}
                // Both fields, as one text: the name, and the notes under it.
                // The reverse trip and the rule that a peer's edit is diffed
                // against the baseline rather than against this value are in
                // {@link commitNameCell}.
                value={composeNameCell(row.original.name, row.original.notes)}
                // Returned rather than dropped: what be-01 did with the edit is
                // what tells the box whether the text in it has been saved.
                commit={(typed, baseline) =>
                  live.current.commitNameCell(row.original.id, typed, baseline)
                }
                onKeyDown={(e) => {
                  live.current.onAltMove(e, row.original, 'name');
                  // Before the Name cell's own keys, and before the arrows:
                  // Ctrl+Enter is a command here and a plain Enter is a
                  // newline the browser writes, and only one handler may
                  // answer for the pair.
                  live.current.onCommandKey(e, row.original, 'name');
                  live.current.onKeyDown(e, row.original);
                  live.current.onArrowKey(e, row.original.id, 'name');
                }}
              />
              {/*
                The rendered note, on hover, and only when there is one. A
                popover over an empty note is a box of nothing that hides the
                row beneath it. It hangs off the Name cell because that is where
                the note is now written; the Notes column it used to hang off
                does not exist.
              */}
              {hovered && row.original.notes.trim() !== '' && (
                <NotesPreview notes={row.original.notes} number={row.original.number} />
              )}
            </span>
          );
        },
      }),
      column.display({
        id: 'depends',
        header: 'Depends on',
        cell: ({ row }) => {
          const numbers = live.current.numbersOf(row.original.dependsOn);
          // This cell's picker, or null while it is closed or under another row.
          const picker =
            live.current.depPicker?.rowId === row.original.id ? live.current.depPicker : null;
          const entries =
            picker === null ? [] : live.current.depEntriesFor(row.original, picker.typed);
          // The entries a click or an Enter may actually take. A marked entry
          // is on screen to be read, not to be picked: be-01 would refuse it,
          // and the mark is this cell saying so before the click rather than
          // after it.
          const pickable = entries.filter((entry) => entry.refusal === undefined);
          // Resolved by id at render, so a highlight whose row has left the
          // list — or has since become one be-01 would refuse — is simply
          // nothing rather than somebody else's row.
          const activeOption =
            picker?.highlightId == null
              ? undefined
              : pickable.find((entry) => entry.id === picker.highlightId);
          const open = picker !== null && entries.length > 0;
          return (
            <span
              // `normal` rather than `nowrap`: a row waiting on six others has
              // six chips, and a line of them that cannot wrap is a line that
              // runs into the next column — or, now, one the cell clips. An
              // uneven row height is a cost worth paying; a dependency nobody
              // can see is not.
              //
              // The positioned ancestor the listbox below is placed against —
              // which is what decides *where* the list opens, not whether it
              // is clipped. The clipper is the `<td>`, and it is what
              // {@link POPOVER_COLUMNS} exempts.
              style={{
                whiteSpace: 'normal',
                position: 'relative',
                display: 'block',
                maxWidth: '100%',
              }}
            >
              {numbers.map(({ id, number }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={`Stop ${row.original.number} waiting for ${number}`}
                  title="Remove this dependency"
                  onClick={() =>
                    void live.current.run(() =>
                      live.current.api.removeDependency(row.original.id, id),
                    )
                  }
                >
                  {number} ✕
                </button>
              ))}
              <input
                aria-label={`Add a dependency to ${row.original.number}`}
                role="combobox"
                aria-expanded={open}
                aria-controls={open ? `dep-options-${row.original.id}` : undefined}
                aria-activedescendant={
                  activeOption === undefined ? undefined : `dep-option-${activeOption.id}`
                }
                aria-autocomplete="list"
                placeholder="search, or 010, 020"
                title="Type to search by number or name, or a list of numbers separated by commas or spaces"
                style={{ width: '100%', boxSizing: 'border-box' }}
                data-depends-input={row.original.id}
                // A cell of the keyboard grid, so Tab reaches this box and
                // leaves it again rather than walking the chips' ✕ buttons.
                data-cell={cellKey(row.original.id, 'depends')}
                value={picker?.typed ?? ''}
                onFocus={() => {
                  live.current.setDepPicker({
                    rowId: row.original.id,
                    typed: '',
                    highlightId: null,
                  });
                }}
                onBlur={() => {
                  live.current.setDepPicker((current) =>
                    current?.rowId === row.original.id ? null : current,
                  );
                }}
                onChange={(e) => {
                  const typed = e.currentTarget.value;
                  // Typing is aiming at the narrowed-to entry; emptying the
                  // cell aims at nothing again.
                  const first =
                    typed.trim() === ''
                      ? undefined
                      : live.current
                          .depEntriesFor(row.original, typed)
                          .find((entry) => entry.refusal === undefined);
                  live.current.setDepPicker({
                    rowId: row.original.id,
                    typed,
                    highlightId: first?.id ?? null,
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    // The move blurs this input, which closes the list and
                    // drops what was typed into it — this cell's blur contract
                    // since it was written, now reached by Tab on purpose. The
                    // typed text is a *search*: committing it on the way out
                    // would add dependencies nobody confirmed.
                    //
                    // Proof: the call dropped, leaving only the `return`, both
                    // `Tab from the depends input closes the picker…` and
                    // `Shift+Tab from the depends input lands in the name…`
                    // failed with the key left to the browser. Watched,
                    // 2026-08-07.
                    live.current.onTabKey(e, row.original.id, 'depends');
                    return;
                  }
                  if (open && commandChordIn(e) !== null) {
                    // Inert means consumed. Skipping `onCommandKey` was not
                    // enough on its own: Cmd/⌘+Enter fell through to the Enter
                    // branch below, which reads no modifiers, and added the
                    // highlighted dependency — codex round 2, finding 2.
                    // Proof: this guard removed, `Cmd+Enter in the open
                    // depends list adds no dependency` failed on `expected
                    // <button type="button" …(2)></button> to be null` — the
                    // chip for an edge nobody confirmed. Watched, 2026-08-08.
                    e.preventDefault();
                    return;
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    live.current.moveDepHighlight(
                      row.original.id,
                      e.key === 'ArrowDown' ? 1 : -1,
                      // The refused entries are not in this list, so the
                      // highlight steps over them: a highlight that could stop
                      // on one would be an Enter that does nothing, which is
                      // the click this change exists to prevent.
                      pickable.map((entry) => entry.id),
                    );
                    return;
                  }
                  if (e.key === 'Escape') {
                    live.current.setDepPicker(null);
                    return;
                  }
                  if (!open) {
                    // Closed, this is a cell like any other and the chords
                    // reach it. Open, the list owns the keyboard — the routing
                    // matrix's inert row, and the reason this is a condition
                    // rather than an unconditional call.
                    // Proof: the condition forced true, `every chord is inert
                    // while the depends list is open` failed on `expected
                    // <input …(11)></input> to be <input …(10)></input>` — the
                    // focus taken out of a list somebody was reading. Watched,
                    // 2026-08-08.
                    live.current.onCommandKey(e, row.original, 'depends');
                  }
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (activeOption !== undefined) {
                    live.current.pickDependency(row.original.id, activeOption.id);
                    return;
                  }
                  // No highlight to take — the typed flow: one number or a
                  // separated list of them, exactly as this cell always worked.
                  const typed = picker?.typed ?? e.currentTarget.value;
                  if (typed.trim() === '') return;
                  live.current.dependOn(row.original.id, typed);
                  live.current.setDepPicker((current) =>
                    current === null ? null : { ...current, typed: '', highlightId: null },
                  );
                }}
              />
              {picker !== null && entries.length > 0 && (
                <ul
                  role="listbox"
                  id={`dep-options-${row.original.id}`}
                  aria-label={`Work items ${row.original.number} can depend on`}
                  // One preventDefault for the whole list — options included,
                  // by bubbling. A mousedown anywhere here must not take the
                  // input's focus: on an option, blur would close the list
                  // before the click could pick; on the scrollbar, the list
                  // unmounted under the pointer and everything past the fold
                  // was unpickable by mouse (cross review #6).
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    background: '#fff',
                    border: '1px solid #ccc',
                    maxHeight: 200,
                    overflowY: 'auto',
                    zIndex: 10,
                    // Wider than its own column on purpose, since that column
                    // is 110px: an entry is a work item's number and its name,
                    // and a list as narrow as the box it drops from would show
                    // the number and about four letters. It escapes the cell
                    // either way — see `opensAPopover`.
                    minWidth: DEP_LIST_WIDTH,
                  }}
                >
                  {entries.map((entry) => (
                    // The ARIA combobox pattern is the boundary that makes this
                    // safe: options are not focusable, and the keyboard drives
                    // them from the input above through aria-activedescendant
                    // (ArrowUp/ArrowDown/Enter there).
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <li
                      key={entry.id}
                      id={`dep-option-${entry.id}`}
                      role="option"
                      aria-selected={entry.id === activeOption?.id}
                      // Shown and refused, rather than quietly absent: a row
                      // that vanishes from the list reads as a bug in the tool,
                      // and one that says why it cannot be picked teaches the
                      // shape of the plan.
                      aria-disabled={entry.refusal !== undefined}
                      // The list scrolls; the highlighted entry must be where
                      // the eye is. jsdom has no scrollIntoView, hence the
                      // typeof — that boundary is the test environment, not a
                      // browser this will meet.
                      ref={(element) => {
                        if (
                          entry.id === activeOption?.id &&
                          element !== null &&
                          typeof element.scrollIntoView === 'function'
                        ) {
                          element.scrollIntoView({ block: 'nearest' });
                        }
                      }}
                      style={{
                        padding: '2px 6px',
                        cursor: entry.refusal === undefined ? 'pointer' : 'default',
                        whiteSpace: 'nowrap',
                        color: entry.refusal === undefined ? undefined : '#999',
                        background: entry.id === activeOption?.id ? '#e8f0fe' : undefined,
                      }}
                      onClick={() => {
                        if (entry.refusal !== undefined) return;
                        live.current.pickDependency(row.original.id, entry.id);
                      }}
                    >
                      {entry.number} {entry.name}
                      {entry.refusal === undefined ? '' : ` — ${REFUSAL_SUFFIX[entry.refusal]}`}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          );
        },
      }),
      column.display({
        id: 'team',
        header: 'Service/team',
        cell: ({ row }) => (
          <CreatablePicker
            label={`Service or team for ${row.original.number}`}
            placeholder="search or add"
            entries={live.current.teams}
            value={row.original.serviceTeamId}
            onChoose={(id) => {
              live.current.setTeamOf(row.original.id, id);
            }}
            onCreate={(name) => {
              live.current.createTeamFor(row.original.id, name);
            }}
            onClear={() => {
              live.current.setTeamOf(row.original.id, null);
            }}
            gridCell={{
              dataCell: cellKey(row.original.id, 'team'),
              onTabKey: (e) => {
                live.current.onTabKey(e, row.original.id, 'team');
              },
              onCommandKey: (e) => {
                live.current.onCommandKey(e, row.original, 'team');
              },
            }}
          />
        ),
      }),
      ...roles.flatMap((role) => {
        const unfolded = unfoldedRoles.includes(role.id);
        return [
          column.display({
            id: `${role.id}-final`,
            // The toggle lives on the column that never goes away, so nothing
            // jumps when the group opens: it extends to the right of this one.
            header: () => (
              <button
                type="button"
                aria-expanded={unfolded}
                aria-label={`${unfolded ? 'Fold' : 'Unfold'} ${role.name} estimates`}
                // The role's own name, in full, because the button now shows as
                // much of it as the column has room for and no more. A role
                // called "Infrastructure and platform" used to set the width of
                // everything under it instead.
                // The assignee no longer folds away — it is beside the figure
                // in this very cell, and `@` assigns from there — so the
                // button is about the three points and nothing else. It says
                // the accordion out loud too, because unfolding this role
                // folds whichever one was open and a table that reshuffles
                // without saying why reads as a bug.
                title={`${role.name} — ${
                  unfolded
                    ? 'fold the three points back into the figure'
                    : 'show the three points behind the figure; any other role folds'
                }`}
                onClick={() => {
                  live.current.toggleRole(role.id);
                }}
                style={{
                  font: 'inherit',
                  fontWeight: 'inherit',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {role.name} {unfolded ? '▾' : '▸'}
              </button>
            ),
            cell: ({ row }) => {
              // A folded role must not be able to hide a complaint: a typed
              // trio that saves nothing stays visible as a mark on the figure
              // the fold leaves behind.
              const problem = unfolded ? null : live.current.combinedProblem(row.original, role.id);
              // The whole trio in one cell, but only where both halves of that
              // sentence hold: a folded role, so the three boxes are not on
              // screen to disagree with it, and a leaf, because a parent's
              // figure is a sum of what is below it and nothing to type into.
              const shorthand = !unfolded && !row.original.rolledUp;
              const assigned = row.original.assignees[role.id];
              // Nobody on this role and exactly one person on another: they are
              // assumed to be doing this phase too. The same rule the unfolded
              // column has, in the cell that is always on screen — which is the
              // whole reason the assignee stopped folding away.
              const assumed = assigned === undefined ? row.original.doesEveryPhase : null;
              const shows = assigned ?? assumed;
              const shownName =
                shows === null
                  ? null
                  : (live.current.people.find((each) => each.id === shows)?.name ?? '(unknown)');
              // Only while this role is folded: unfolded, the assignee has a
              // column of its own with a picker in it, and two ways to assign
              // one person side by side is two things to keep in step.
              const options = unfolded ? [] : live.current.mentionOptions(row.original, role.id);
              const listId = `mention-${row.original.id}-${role.id}`;
              return (
                <span
                  data-final={role.id}
                  // On the wrapper as well as on the input below: the marker is
                  // its own hover target, and it is the half a reader of a
                  // folded plan sees first.
                  title={problem ?? undefined}
                  // A flex row, because this cell holds two things now: the
                  // figure (or the box it is typed into) and who is doing it.
                  // `relative` makes it the positioned ancestor the `@` list
                  // opens against — the clip that would cut the list to 96px is
                  // the `<td>`'s, which {@link opensAPopover} lifts.
                  // The blur is the mention's: it bubbles from the box inside,
                  // and leaving the cell has to take a half-typed `@ka` with
                  // it. Nothing else in here can hold the focus.
                  onBlur={() => {
                    live.current.leaveFoldedCell();
                  }}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'baseline',
                    maxWidth: '100%',
                    minWidth: 0,
                    fontWeight: 600,
                    color: problem === null ? undefined : '#c00',
                  }}
                >
                  {shorthand ? (
                    <CellInput
                      aria-label={`${role.name} estimate for ${row.original.number}`}
                      // In the keyboard grid, which is what makes Down-type-
                      // Down-type work down a role's column. Proof: dropped,
                      // `is a cell of the keyboard grid, so a column can be
                      // typed down` fails. Watched, 2026-08-06.
                      data-cell={cellKey(row.original.id, `${role.id}-final`)}
                      role="combobox"
                      aria-expanded={options.length > 0}
                      aria-controls={options.length > 0 ? listId : undefined}
                      aria-autocomplete="list"
                      placeholder="o/r/p"
                      aria-invalid={problem !== null}
                      title={problem ?? SHORTHAND_HELP}
                      // Every keystroke, so an `@` opens the people picker as
                      // it is typed. The estimate half is not read here and no
                      // draft is written — that is still the blur's job.
                      onTyped={(box) => {
                        live.current.readFoldedCell(row.original.id, role.id, box);
                      }}
                      onKeyDown={(e) => {
                        if (options.length > 0) {
                          // Inert means consumed, and this is the one open list
                          // that had two ways out of it. Cmd/⌘+Enter fell
                          // through to the bare Enter below and assigned the
                          // first person offered; every Alt+arrow went on to
                          // `onAltMove` underneath and moved the row while its
                          // list was open — codex round 2, finding 2.
                          //
                          // Proof, two faults, both watched 2026-08-08. This
                          // guard removed: `Cmd+Enter in the folded cell’s open
                          // @ list assigns nobody` failed on `expected
                          // [ 'assign w2 role-dev person1' ] to deeply equal []`,
                          // and `Alt+arrows in the folded cell’s open @ list
                          // move no row` on `expected [ 'Strip', 'Paint',
                          // 'Sand' ] to deeply equal [ 'Strip', 'Sand',
                          // 'Paint' ]`.
                          if (commandChordIn(e) !== null || altMoveIn(e) !== null) {
                            e.preventDefault();
                            return;
                          }
                          if (e.key === 'Escape') {
                            // Closes the list and strips nothing: what was
                            // typed is still on screen to be corrected, and the
                            // blur that follows is what takes it back out.
                            e.preventDefault();
                            live.current.closeMention();
                            return;
                          }
                          if (e.key === 'Enter') {
                            // The first entry, which is `CreatablePicker`'s
                            // rule: what is offered first is what is taken.
                            e.preventDefault();
                            options[0]?.take();
                            return;
                          }
                        } else {
                          // The routing matrix's inert row is this `else` and
                          // nothing more: while the `@` list is open it owns
                          // the keyboard, and Escape above is how it is given
                          // back. A chord that fired through an open list
                          // would create a row under a half-typed name search.
                          live.current.onCommandKey(e, row.original, `${role.id}-final`);
                        }
                        live.current.onAltMove(e, row.original, `${role.id}-final`);
                        live.current.onTabKey(e, row.original.id, `${role.id}-final`);
                        live.current.onArrowKey(e, row.original.id, `${role.id}-final`);
                      }}
                      // Selected on arrival, because the value at rest is a
                      // computed figure and the syntax is a trio: there is no
                      // sensible edit to make *inside* `4`, and a caret dropped
                      // into it turns `2/3/8` into `2/3/84`. What the selection
                      // replaces is remembered first — see `enterFoldedCell`.
                      onFocus={(e) => {
                        live.current.enterFoldedCell(e.currentTarget);
                        e.currentTarget.select();
                      }}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        font: 'inherit',
                        fontWeight: 600,
                        flex: 1,
                        minWidth: 0,
                        ...(problem === null ? {} : { background: '#fde8e8', borderColor: '#c00' }),
                      }}
                      value={live.current.combinedValue(row.original, role.id)}
                      commit={(typed, baseline) =>
                        live.current.commitCombinedEstimate(row.original, role.id, typed, baseline)
                      }
                    />
                  ) : (
                    showFinal(row.original.finalDays[role.id])
                  )}
                  {problem !== null && ' !'}
                  {shownName !== null && (
                    // `4.8 · Kat`, truncated, with the whole name in the
                    // tooltip: 96px holds a figure and about four characters of
                    // a person. Grey and in brackets where nobody is assigned
                    // and somebody is assumed, exactly as the unfolded column
                    // reads it.
                    <span
                      data-folded-assignee={role.id}
                      {...(assigned === undefined ? { 'data-assumed': role.id } : {})}
                      title={
                        assigned === undefined
                          ? `${shownName} — only one person is assigned, so they are assumed to do this phase too`
                          : shownName
                      }
                      style={{
                        marginLeft: 4,
                        flex: 'none',
                        minWidth: 0,
                        maxWidth: '60%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 'normal',
                        color: assigned === undefined ? '#666' : undefined,
                      }}
                    >
                      · {assigned === undefined ? `(${shownName})` : shownName}
                    </span>
                  )}
                  {options.length > 0 && (
                    <PickerList
                      id={listId}
                      label={`${role.name} assignee for ${row.original.number}`}
                      options={options}
                    />
                  )}
                </span>
              );
            },
          }),
          ...(!unfolded
            ? []
            : [
                ...POINTS.map((point) =>
                  column.display({
                    id: `${role.id}-${point}`,
                    // The role's name is on the group column; repeating it three
                    // times over is how the headers came to set the table's width.
                    header: point,
                    cell: ({ row }) => {
                      const problem = live.current.trioProblemFor(row.original, role.id);
                      const wrong = problem?.points.includes(point) ?? false;
                      return (
                        <CellInput
                          aria-label={`${role.name} ${point} for ${row.original.number}`}
                          data-cell={cellKey(row.original.id, `${role.id}-${point}`)}
                          // Narrow on purpose: these hold a number of days, and a box
                          // sized for a sentence reads as if it wants one. Which is
                          // the column's width to say now, not this box's.
                          aria-invalid={wrong}
                          title={problem?.message}
                          onKeyDown={(e) => {
                            live.current.onAltMove(e, row.original, `${role.id}-${point}`);
                            live.current.onCommandKey(e, row.original, `${role.id}-${point}`);
                            live.current.onTabKey(e, row.original.id, `${role.id}-${point}`);
                            live.current.onArrowKey(e, row.original.id, `${role.id}-${point}`);
                          }}
                          // A parent's figures are sums of what is below it, so the cell is
                          // shown and not editable — greyed rather than blank, because the
                          // number is real and worth reading.
                          readOnly={row.original.rolledUp}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            ...(row.original.rolledUp
                              ? { color: '#666', background: '#f4f4f4' }
                              : wrong
                                ? { background: '#fde8e8', borderColor: '#c00' }
                                : {}),
                          }}
                          value={live.current.estimateValue(row.original, role.id, point)}
                          commit={(typed) =>
                            // A rolled-up figure is a sum of the rows below it:
                            // the box is read-only and there is nothing to send.
                            row.original.rolledUp
                              ? unsent()
                              : live.current.commitEstimate(row.original, role.id, point, typed)
                          }
                        />
                      );
                    },
                  }),
                ),
                column.display({
                  id: `${role.id}-assignee`,
                  header: 'by',
                  cell: ({ row }) => {
                    const assigned = row.original.assignees[role.id];
                    // Nobody on this role, and exactly one person on another: they are
                    // assumed to be doing this phase too, so the cell says so rather
                    // than reading as unassigned. Assigning anyone here ends the
                    // assumption by itself.
                    const assumed = assigned === undefined ? row.original.doesEveryPhase : null;
                    const nameOf = (id: string) =>
                      live.current.people.find((each) => each.id === id)?.name ?? '(unknown)';
                    return (
                      // A flex row because the picker inside it is one now: the
                      // assumed name has to sit beside the box and shrink with
                      // it, rather than being pushed onto a line of its own.
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          maxWidth: '100%',
                          minWidth: 0,
                        }}
                      >
                        <CreatablePicker
                          label={`${role.name} assignee for ${row.original.number}`}
                          placeholder="search or add"
                          entries={live.current.people.map((each) => ({
                            id: each.id,
                            name: each.name,
                            detail:
                              each.teamIds.length === 0
                                ? 'free agent'
                                : each.teamIds
                                    .map(
                                      (id) =>
                                        live.current.teams.find((team) => team.id === id)?.name ??
                                        '?',
                                    )
                                    .join(', '),
                          }))}
                          value={assigned ?? null}
                          onChoose={(id) => {
                            live.current.assignTo(row.original.id, role.id, id);
                          }}
                          onCreate={(name) => {
                            live.current.createPersonFor(row.original, role.id, name);
                          }}
                          onClear={() => {
                            live.current.assignTo(row.original.id, role.id, null);
                          }}
                          gridCell={{
                            dataCell: cellKey(row.original.id, `${role.id}-assignee`),
                            onTabKey: (e) => {
                              live.current.onTabKey(e, row.original.id, `${role.id}-assignee`);
                            },
                            onCommandKey: (e) => {
                              live.current.onCommandKey(e, row.original, `${role.id}-assignee`);
                            },
                          }}
                        />
                        {assumed !== null && (
                          <span
                            data-assumed={role.id}
                            title="Only one person is assigned, so they are assumed to do this phase too"
                            style={{
                              color: '#666',
                              marginLeft: 4,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            ({nameOf(assumed)})
                          </span>
                        )}
                      </span>
                    );
                  },
                }),
              ]),
        ];
      }),
      column.display({
        id: 'final-total',
        // One word, because the column is 52px wide: it holds a number of days
        // and the roles beside it hold days too. The sentence it used to be
        // moved into the `title`, where a reader who wants it can still get it.
        header: () => (
          <span title="Every role's final figure for this work item, added up">Days</span>
        ),
        cell: ({ row }) => (
          <span data-final-total style={{ fontWeight: 600 }}>
            {showDay(row.original.finalTotal)}
          </span>
        ),
      }),
      column.display({
        id: 'not-before',
        header: 'Not before',
        cell: ({ row }) => (
          <input
            type="date"
            aria-label={`Earliest start for ${row.original.number}`}
            // Disabled without a project start date, because there is then no
            // day zero to count from and be-01 ignores the constraint
            // entirely. A date that saves and does nothing is worse than one
            // the field will not take.
            disabled={live.current.startDate === null}
            title={
              live.current.startDate === null
                ? 'Set the project start date first — without one there are no dates to constrain.'
                : 'This work item may not start before this day. Its dependencies can still push it later.'
            }
            data-not-before={row.original.id}
            // A cell of the keyboard grid like any other — while it is enabled.
            // Disabled it is left out by `editableGrid`, which is what keeps
            // Tab from stopping on a field that will not take the focus.
            data-cell={cellKey(row.original.id, 'not-before')}
            onKeyDown={(e) => {
              // The chords, and nothing else this cell does not already own: a
              // native date input keeps its own arrows for the segment under
              // the caret, which is why {@link onArrowKey} is absent here.
              live.current.onCommandKey(e, row.original, 'not-before');
              live.current.onTabKey(e, row.original.id, 'not-before');
            }}
            // A date input carries an intrinsic width — the spinner and the
            // picker icon — that is wider than this column on some browsers,
            // so it is told to follow the column like every other control.
            style={{ width: '100%', boxSizing: 'border-box', font: 'inherit' }}
            value={row.original.startNoEarlierThan ?? ''}
            onChange={(e) => {
              // A date input reports '' when cleared, which is the caller
              // saying "no constraint" rather than "an empty date".
              const typed = e.target.value;
              live.current.setNotBefore(row.original.id, typed === '' ? null : typed);
            }}
          />
        ),
      }),
      column.display({
        id: 'start',
        // A bare `2.5` under "Start" reads as a date that failed to load, and
        // the header used to say which of the two it was — in 52px it cannot,
        // so the distinction moved into the `title`. The column is a figure
        // either way and the cell shows which kind it is.
        header: () => <span title={live.current.startDateHint('earliest start')}>Start</span>,
        cell: ({ row }) => (
          <span data-start>
            {row.original.dates?.startsOn ??
              live.current.showSchedule(row.original.schedule.earliestStart)}
          </span>
        ),
      }),
      column.display({
        id: 'finish',
        header: () => <span title={live.current.startDateHint('earliest finish')}>End</span>,
        cell: ({ row }) => (
          <span data-finish title={row.original.schedule.estimated ? undefined : 'No estimate yet'}>
            {row.original.dates?.endsOn ??
              live.current.showSchedule(row.original.schedule.earliestFinish)}
            {live.current.hasSchedule() && !row.original.schedule.estimated ? ' ?' : ''}
          </span>
        ),
      }),
      column.display({
        id: 'float',
        header: () => (
          <span title="Days this work item can slip before the plan's end moves">Slack</span>
        ),
        cell: ({ row }) => (
          <span data-float>
            {!live.current.hasSchedule()
              ? '—'
              : row.original.schedule.critical
                ? '— critical'
                : showDay(row.original.schedule.float)}
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span aria-label="Row actions" />,
        cell: ({ row }) => (
          <ActionsMenu
            number={row.original.number}
            // Read through `live`, both of them, for the reason every other
            // cell here reads its state that way: `columns` may depend on
            // `roles` and `unfoldedRoles` and nothing else, or a click on one
            // menu remounts every cell in the table.
            open={live.current.openMenuRowId === row.original.id}
            busy={live.current.busy}
            onOpen={() => {
              live.current.setOpenMenuRowId(row.original.id);
            }}
            onClose={() => {
              // Only this row's own menu, so a menu that has already been
              // replaced by another row's cannot close the new one on its way
              // out.
              live.current.setOpenMenuRowId((current) =>
                current === row.original.id ? null : current,
              );
            }}
            actions={[
              {
                id: 'duplicate',
                // Offered on a frozen row as well, unlike Delete and unlike
                // moving one: a freeze pins the number a row left the tool
                // under, and the copy is given none. Copying is not moving.
                label: 'Duplicate',
                run: () => {
                  void live.current.duplicateRow(row.original.id);
                },
              },
              row.original.frozenNumber !== null
                ? {
                    id: 'unfreeze',
                    label: 'Unfreeze',
                    run: () => {
                      void live.current.run(() => live.current.api.unfreeze(row.original.id));
                    },
                  }
                : {
                    id: 'delete',
                    label: 'Delete',
                    run: () => {
                      void live.current.deleteRow(row.original);
                    },
                  },
            ]}
          />
        ),
      }),
    ],
    // `roles` because a role's name is rendered in a header, and
    // `unfoldedRoles` because it decides which columns exist at all.
    // `flexRender` renders each `cell` function as a component type, so
    // rebuilding these definitions gives every cell a new type and React
    // unmounts and remounts the lot — losing focus, selection and any
    // half-typed value. For `roles` that is rare and tolerated; for the fold
    // it happens exactly on the click that asked for it, when the only focus
    // to lose is the button's own. Estimate drafts live in `drafts`, not in
    // the inputs, so a fold cannot swallow one. Everything else the cells need
    // is read through `live`, which is why `api`, `run` and `onKeyDown` are
    // absent rather than forgotten.
    [roles, unfoldedRoles],
  );

  const table = useReactTable({
    data: workItems,
    columns,
    // While a search is on, the expansion in force is the search's overlay:
    // every kept row open, so a hit inside a branch this reader had closed is
    // revealed rather than counted and hidden. The reader's own `expanded` is
    // not merged into and not written over — clearing the box puts the plan
    // back exactly as it was left, collapsed branches included.
    //
    // Proof: narrowed to the reader's own `expanded`, `reveals a match inside
    // a branch the reader had closed` failed with the hit counted and hidden.
    // And with the overlay committed into `expanded` on the way out — the
    // merge this avoids — `clearing the search puts the reader’s own collapse
    // back` failed with the whole plan open. Both watched, 2026-08-06.
    state: { expanded: search.expandedOverlay ?? expanded },
    onExpandedChange: setExpanded,
    getSubRows: (row) => row.subRows,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  /**
   * The rows this render puts on screen.
   *
   * The overlay above opens every kept row; this drops the ones a search did
   * not keep — the siblings that neither match nor sit on a match's line, which
   * are open branches' children and so still in the row model. With nothing
   * typed the kept set is every row and this filters nothing out.
   */
  const shownRows = table.getRowModel().rows.filter((row) => search.visibleIds.has(row.id));

  /**
   * The columns this render puts on screen, in order — which is exactly what a
   * `<colgroup>` declares and what the table's own width adds up. Read from the
   * table model rather than listed here, so unfolding a role cannot leave the
   * declared widths describing the columns of a moment ago.
   */
  const leafColumnIds = table.getVisibleLeafColumns().map((column) => column.id);

  return (
    <section>
      {/*
        Wrapping, because this row of controls is the only thing on the page
        that can make it scroll sideways: it is about 1245px of buttons at its
        narrowest, and a window below that — a narrow one, or a wide one at
        125% zoom — carried the whole page with it while the table itself was
        behaving perfectly. Observed on h2puni, 2026-08-08.
      */}
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={() => void run(() => api.freeze(projectId))} disabled={busy}>
          Freeze numbering
        </button>
        <button
          type="button"
          onClick={() => void run(() => api.unfreezeProject(projectId))}
          disabled={busy}
        >
          Unfreeze all
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const created = await api.create(projectId, {
                parentId: null,
                afterId: siblingsOf(null).at(-1)?.id ?? null,
                name: '',
              });
              focusNext.current = { rowId: created.id, columnId: 'name' };
            })
          }
          disabled={busy}
        >
          Add work item
        </button>
        {/*
          The two ends of the expansion, which is otherwise one triangle at a
          time — a forty-row plan takes forty clicks to fold. Both write the
          reader's own expansion, and it is remembered per project from there.

          Disabled while the Find box holds something, for the reason the
          triangles are hidden then: what is open during a search is the
          search's answer, and a button that appeared to do nothing would read
          as broken. Not disabled by `busy`, unlike the buttons above: neither
          asks be-01 for anything.
        */}
        <button
          type="button"
          disabled={searching}
          title={
            searching
              ? 'Clear the Find box first — a search opens whatever it has to.'
              : 'Close every branch'
          }
          onClick={() => {
            setExpanded({});
          }}
        >
          Collapse all
        </button>
        <button
          type="button"
          disabled={searching}
          title={
            searching
              ? 'Clear the Find box first — a search opens whatever it has to.'
              : 'Open every branch'
          }
          onClick={() => {
            setExpanded(true);
          }}
        >
          Expand all
        </button>
        {/*
          Find. Deliberately without `data-cell`: this is not a cell of the
          table's keyboard grid, and letting Tab and the arrows walk into it
          from the last cell of a row would put the caret somewhere no edit can
          be made.
        */}
        <input
          aria-label="Find"
          placeholder="Find…"
          size={14}
          title="Show work items whose name contains this, with the rows above and below them"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            // Escape empties the box, which is how a search is left — and
            // leaving it puts every collapsed branch back, because the search
            // never wrote to the reader's own expansion.
            if (e.key !== 'Escape') return;
            e.preventDefault();
            setQuery('');
          }}
        />
        {searching && (
          <span role="status" style={{ alignSelf: 'center', color: '#555' }}>
            {shownRows.length} of {flat.length} rows
          </span>
        )}
        {/*
          Said out loud rather than left to an empty table, which reads as a
          plan that has been lost rather than a search that found nothing. The
          count beside it stays, so `0 of 12 rows` says the twelve are still
          there.
        */}
        {searching && search.matchIds.size === 0 && (
          <span style={{ alignSelf: 'center' }}>No matches for “{query}”</span>
        )}
        {/*
          How ready this plan is to be read, and the way to the rows that make
          it not ready. Absent entirely when every leaf is estimated for every
          role: a complete plan needs no badge, and a tick that is always there
          is a thing to stop seeing — this has to be noticed the day it appears.

          Not disabled while the table is busy, unlike the buttons beside it:
          it writes nothing, and a button that greys out during somebody else's
          refetch reads as broken.
        */}
        {gaps.leaves.length > 0 && (
          <button type="button" title={describeGaps(gaps)} onClick={walkToNextGap}>
            {gaps.leaves.length} unestimated
          </button>
        )}
        {/*
          The way in for anyone who never learns the chord — which is most
          people, and the reason the buttons are here at all rather than the
          keyboard being the only route. Disabled by `busy` like every other
          control that writes, and by an empty half of the stack: be-01 would
          answer 409 and a button that is always live invites that.

          The disabled state is read off the last tree read rather than counted
          here. It is per account, and be-01 is the only thing that knows what
          somebody else's edit did to it.
        */}
        <button
          type="button"
          disabled={busy || !stack.undoable}
          title="Undo your last change to this plan (Ctrl/⌘ + Z)"
          onClick={() => {
            void stepStack('undo');
          }}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={busy || !stack.redoable}
          title="Put back what you last undid (Ctrl/⌘ + Shift + Z)"
          onClick={() => {
            void stepStack('redo');
          }}
        >
          Redo
        </button>
        {/*
          The way in for anyone who was never told about `?`, which is most
          people the first time. Not disabled by `busy`: it asks be-01 for
          nothing and reads nothing that a refetch could change.
        */}
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => {
            setCheatSheetOpen(true);
          }}
        >
          ⌨
        </button>
        {/*
          Sharing the plan, which is what most of it is written for. Both take
          the whole plan rather than what is on screen, and neither asks be-01
          for anything — so neither is disabled by `busy`, and both work while
          the socket is down or the tree is stale. What they cannot do is say
          the figures are current; the header's timestamp is what says when
          they were true.
        */}
        <button
          type="button"
          title="Copy the whole plan as a Markdown table, with a header saying how to read it"
          onClick={copyAsMarkdown}
        >
          Copy as Markdown
        </button>
        <button
          type="button"
          title="Download the whole plan as a CSV, with a header saying how to read it"
          onClick={downloadCsv}
        >
          Download CSV
        </button>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          Starts
          {/*
            The day the whole plan begins. Setting it moves every date at once,
            because every date is an offset from it — there is nothing stored
            per row to drag along.
          */}
          <input
            type="date"
            aria-label="Project start date"
            disabled={busy}
            value={startDate ?? ''}
            onChange={(e) => {
              const typed = e.target.value;
              void run(() => api.setStartDate(projectId, typed === '' ? null : typed));
            }}
          />
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          Plan with
          {/*
            A project-wide setting rather than a per-reader preference: the
            dates below are computed from it, and two people reading different
            dates off one plan is the failure this must not have.
          */}
          <select
            aria-label="Final estimate"
            value={estimateMethod}
            disabled={busy}
            onChange={(e) => {
              const chosen = e.target.value;
              if (isEstimateMethod(chosen)) chooseEstimateMethod(chosen);
            }}
          >
            <option value="pert">PERT</option>
            <option value="optimistic">optimistic</option>
            <option value="realistic">realistic</option>
            <option value="pessimistic">pessimistic</option>
          </select>
        </label>
      </div>

      {/*
        A state, so a banner: the rows on screen are the last ones that
        arrived, and until a read lands they may be behind what be-01 holds.
        The alternative was to say nothing, which left a plan that could be
        minutes out of date looking exactly like one that was current.

        The retry is the only control here, because it is the only thing the
        reader can do about it — and it clears this by succeeding, not by being
        pressed.
      */}
      {treeMayBeStale && (
        <p role="alert" data-stale-tree>
          This plan may be out of date — the last refresh failed.{' '}
          <button
            type="button"
            onClick={() => {
              void refreshOrMarkStale();
            }}
          >
            Retry
          </button>
        </p>
      )}

      {/*
        Said out loud rather than left to be noticed. Someone else's edits stop
        arriving the moment the socket drops, and a table that looks exactly the
        same when it is no longer live is the failure this whole change exists
        to remove.
      */}
      {/*
        Not an error the user caused, and not one they can leave alone. The rows
        are all still here — only the dates are gone — so this says which, rather
        than letting a page of zeroes speak for itself.
      */}
      {scheduleError === 'cycle' && (
        <p role="alert">
          These dependencies run in a circle, so no dates can be worked out. Remove one to fix it.
        </p>
      )}

      {!connected && (
        <p role="status">Reconnecting — edits by other people may not be shown yet.</p>
      )}

      {/*
        The table scrolls inside this, in both directions, so the page never
        scrolls sideways and the toolbar and the alerts above stay where they
        were put. The heading row and the three identity columns are sticky
        against this box — see `table-frame.ts` for why it has to be the one
        that scrolls.
      */}
      <div data-table-frame style={TABLE_FRAME}>
        {/*
          `separate` with no spacing rather than the browser's default gap:
          the pinned columns' offsets are the running total of their widths,
          and two pixels between every pair of cells is two pixels the offsets
          do not know about.
        */}
        <table
          ref={tableElement}
          style={{
            borderCollapse: 'separate',
            borderSpacing: 0,
            // `fixed`, so the browser lays every column out at the width
            // `table-frame.ts` says it has. Under the default `auto` the
            // widths were a suggestion the content could outvote, and a column
            // that came out wider than the offsets assumed is a pinned Name
            // painted over "Depends on".
            tableLayout: 'fixed',
            // The frame's width, never a declared total: every fixed column
            // takes its declared px and Name absorbs whatever is left, so the
            // table fits the window instead of the window having to fit the
            // table. The minimum is the floor under that — the fixed columns
            // plus Name's own floor — and below it the frame scrolls sideways
            // with the pinned columns holding the left edge, which is the one
            // case `width: 100%` cannot cover.
            width: '100%',
            minWidth: tableMinWidth(leafColumnIds),
          }}
        >
          {/*
            The one place the declared widths reach the browser. `col` sizes a
            column and nothing else about it, which is why the cells below
            carry no width of their own.

            A flexible column gets a `<col>` with no width at all — not a
            width of `auto`, which is the same thing said less clearly — and
            `table-layout: fixed` hands it whatever the declared ones leave.
          */}
          <colgroup>
            {leafColumnIds.map((id) => (
              <col
                key={id}
                style={FLEXIBLE_COLUMNS.has(id) ? undefined : { width: widthFor(id) }}
              />
            ))}
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    // Which column this cell is, on the cell itself. Nothing in
                    // the app reads it: the browser layout gate does
                    // (`e2e/layout.spec.ts`), and a measured rectangle with no
                    // name attached is a failure that says two numbers
                    // disagreed without saying which column moved.
                    data-column={header.column.id}
                    style={{
                      ...CELL,
                      ...STICKY_HEADER_CELL,
                      ...flexibleCellStyle(header.column.id),
                      ...pinnedCellStyle(header.column.id, 'header'),
                    }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr
                key={row.id}
                data-frozen={row.original.frozenNumber !== null ? 'true' : 'false'}
                // The armed row, said on the row rather than only in the
                // toast: a sentence in the corner of the screen is not where
                // somebody looks to find out which row a second Ctrl+D will
                // take. The tint itself is on the cells below, because a
                // pinned cell carries its own opaque background and would
                // paint straight over a colour set here.
                data-armed={armedDelete?.rowId === row.original.id ? 'true' : undefined}
                data-drop={dropHint?.rowId === row.original.id ? dropHint.zone : undefined}
                // The handlers sit on the row rather than in a column definition:
                // `flexRender` renders each `cell` as a component *type*, so a
                // definition that changed with the drag would remount every cell
                // in the table on every pointer move.
                onDragOver={(event) => {
                  if (dragging === null) return;
                  // Without this the browser refuses the drop outright.
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  setDropHint({
                    rowId: row.original.id,
                    zone: zoneFor(event.clientY - box.top, box.height),
                  });
                }}
                onDragLeave={() => {
                  setDropHint((current) => (current?.rowId === row.original.id ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  // The zone the last `dragover` worked out, not one recomputed
                  // here. That one is the marker the person was looking at when
                  // they let go, and a drop that lands somewhere other than where
                  // the line was drawn is the one thing drag must never do.
                  if (dropHint?.rowId !== row.original.id) return;
                  dropOn(
                    row.original.id,
                    dropHint.zone,
                    row.getIsExpanded() && row.subRows.length > 0,
                  );
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    // See the `th` above: the layout gate measures these boxes
                    // and has to be able to name the one that moved.
                    data-column={cell.column.id}
                    style={{
                      ...CELL,
                      // The exception to the cell clip. See
                      // {@link opensAPopover}: a popover's containing block is
                      // the wrapper span *inside* this `<td>`, so this `<td>`
                      // clips it unless it is told not to.
                      ...(opensAPopover(cell.column.id) ? { overflow: 'visible' as const } : {}),
                      ...flexibleCellStyle(cell.column.id),
                      ...pinnedCellStyle(cell.column.id, 'body'),
                      // Last, so it wins over the pinned layer it is raising.
                      // A pinned cell is sticky *with a z-index*, which makes
                      // it a stacking context — so the preview hanging off
                      // this one is trapped inside it and the next row's
                      // pinned Name cell paints over it, whatever the
                      // preview's own z-index says. The Name column is the
                      // only cell in the table that is both pinned and holds a
                      // popover, and this is the row it is open on.
                      // Proof: found in a browser rather than reasoned about —
                      // `4px below the name cell is <textarea> in the name
                      // column, not the preview`, on h2puni 2026-08-08, with
                      // `opensAPopover` and every other rule already correct.
                      ...(cell.column.id === 'name' && hoveredNotes === row.original.id
                        ? { zIndex: POPOVER_ROW_LAYER }
                        : {}),
                      // After the pinned background, so the warning is visible
                      // on the three columns that hold the left edge too.
                      ...(armedDelete?.rowId === row.original.id ? { background: ARMED_TINT } : {}),
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        Outside the scrolling frame on purpose: it is fixed to the corner of
        the viewport, and the thing it replaced was a line above the table that
        scrolled out of sight exactly when it mattered.

        Proof that the line is really gone: restored as a second `role="alert"`
        above the table, `says a refused rename in a toast, and puts nothing
        above the table` failed on two alerts where it asserts one. Watched,
        2026-08-06.
      */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/*
        Rendered only while it is open, which is what makes the focus return
        work: the overlay stores what had the focus when it mounted and gives
        it back when it unmounts, so all three ways of closing put the reader
        back where they were without any of them saying so.
      */}
      {cheatSheetOpen && (
        <KeyboardCheatSheet
          onClose={() => {
            setCheatSheetOpen(false);
          }}
        />
      )}
    </section>
  );
}
