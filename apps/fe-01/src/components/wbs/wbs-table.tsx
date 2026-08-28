import {
  createColumnHelper,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  type RowData,
  useReactTable,
} from '@tanstack/react-table';
import { effectiveServicesOf } from '@wbs/domain/effective-service';
import { effectiveTagsOf } from '@wbs/domain/effective-tag';
import { effectiveTeamsOf } from '@wbs/domain/effective-team';
import { assignedOutsideTeam, builtByNonOwner } from '@wbs/domain/label-mismatch';
import { priorityBandOf } from '@wbs/domain/priority-band';
import { workdaysBetween } from '@wbs/domain/workday';
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalTrigger } from '@/components/ui/modal';
import type { ProjectStream } from '@/lib/project-stream';
import type {
  AssignedPersonView,
  PersonView,
  PriorityBandView,
  ServiceView,
  TagView,
  TeamCapacityView,
  TeamView,
} from '@/lib/wbs-api';
import {
  type Days,
  type EstimateMethod,
  isEstimateMethod,
  type ProjectApi,
  type RoleView,
  type SliceView,
} from '@/lib/wbs-api';

import { ActionsMenu } from './actions-menu';
import { CellInput } from './cell-input';
import { type Caret, type CellRef, commandMove, type Direction, nextCell } from './cell-navigation';
import { type ColumnHintState, hintFor, ROLE_FINAL_HINT } from './column-hints';
import {
  CreatablePicker,
  pickableLabel,
  PickerList,
  type PickerOption,
  pickerOptionId,
} from './creatable-picker';
import { DateField } from './date-field';
import { pickerEntries, REFUSAL_SUFFIX } from './dep-picker';
import { DependsCard, dependsLine } from './depends-card';
import { parseDependencies, unknownMessage } from './depends-input';
import { type DropRefusal, type DropZone, planMove, zoneFor } from './drag-drop';
import {
  type CellElement,
  cellIn,
  cellKey,
  editableGrid,
  focusAdjacentCell,
  focusCellAt,
  gridOf,
  isCellElement,
} from './editable-grid';
import {
  isTrioEmpty,
  parseTrioShorthand,
  type Point,
  POINTS,
  sendableTrio,
  trioProblem,
  type TypedTrio,
} from './estimate-draft';
import { FoldedRoleCard } from './folded-role-card';
import { GanttFaultBoundary } from './gantt-fault';
import {
  type GanttPlan,
  type ServiceLabel,
  type ServiceTeamLabel,
  startFloorByRow,
  type TagLabel,
} from './gantt-geometry';
import {
  clampedGanttHeight,
  DAY_PX,
  type DayPx,
  GANTT_CEILING_PX,
  GANTT_MIN_PX,
  GanttPanel,
  isDayPx,
} from './gantt-panel';
import { HoverPreview } from './hover-preview';
import { initialsOf } from './initials';
import {
  altMoveIn,
  type Command,
  commandChordIn,
  escapesAnOpenList,
  undoChord,
} from './keyboard-bindings';
import { KeyboardCheatSheet, opensCheatSheet } from './keyboard-cheat-sheet';
import {
  type CommitOutcome,
  flushCell,
  FocusIntent,
  forgetRefusedDrafts,
  unsent,
} from './live-editing';
import { splitMention } from './mention';
import { composeNameCell, normalizeNewlines, splitNameCell } from './name-notes';
import { PhasesDialog } from './phases-dialog';
import { type CardAssignee, PlanCards } from './plan-cards';
import { describeGaps, findEstimateGaps } from './plan-completeness';
import { type PlanExport, planFileName, planToCsv, planToMarkdown } from './plan-export';
import { planToMermaid, planToMermaidDocument } from './plan-mermaid';
import { useRendererForViewport } from './plan-renderer';
import { linkPlanScroll } from './plan-scroll-link';
import { PrioritiesDialog } from './priorities-dialog';
import { PriorityCell, priorityTyped } from './priority-cell';
import {
  REFERENCE_SET_ADD_CLASS,
  REFERENCE_SET_CHIP_CLASS,
  REFERENCE_SET_STRIP_STYLE,
  ReferenceSetStrip,
} from './reference-set-field';
import { printedDay, shortIsoDate } from './short-date';
import {
  CARET_GUTTER_PX,
  CELL,
  clampColumnWidth,
  DATE_EDITOR_WIDTH,
  DEFAULT_HIDDEN_COLUMNS,
  FLEXIBLE_FLOOR,
  flexibleCellStyle,
  floorFor,
  frameLayout,
  type FrameLayoutState,
  hideableColumnIds,
  hierarchyIndentFor,
  numberIndentFor,
  pinnedCellStyle,
  POPOVER_ROW_LAYER,
  sizableColumn,
  STICKY_HEADER_CELL,
  TABLE_FRAME,
  tableWidthStyle,
  WIDEST_COLUMN,
} from './table-frame';
import { TeamsDialog, teamsOnThePlan } from './teams-dialog';
import { type Toast, toastKey, ToastStack, useToasts } from './toasts';
import {
  type FacetCriteria,
  type FilterCriteria,
  type FilterLabels,
  filterWords,
  isFiltering,
  type NarrowableRow,
  narrowTree,
  NO_FACETS,
  NO_FILTER,
} from './tree-search';
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
 * be-01's word for a rejected request, or `fallback` when it threw something
 * that is not an `Error`.
 *
 * The **code**, not a sentence: `send` throws the error word be-01 answered
 * with (or `http_<status>`), and the two callers left here want the word
 * itself. {@link refusalSentence} is what a toast says instead — see the note
 * on each call for why these two are not it.
 */
const failureText = (thrown: unknown, fallback: string): string =>
  thrown instanceof Error ? thrown.message : fallback;

/**
 * What a refused mutation says, by be-01's own word for the refusal.
 *
 * Every other refusal in this table is a full sentence — `That could not be
 * undone: …`, `020 is frozen — unfreeze it first` — and these were the
 * exception: `not_found` and `http_500` reached the corner of the screen
 * verbatim, observed live on 2026-08-09. The translation lives here rather
 * than in `wbs-api.ts` for the reason `auth-form.tsx` keeps its own map: the
 * codes are be-01's contract and have to stay stable, and the sentence is a
 * presentation decision that differs per surface.
 *
 * Not exhaustive on purpose. {@link refusalSentence} has a grammatical
 * fallback that carries the code, so a word nobody has written a sentence for
 * is still a sentence rather than a snake_case token.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string | undefined>> = {
  not_found:
    'That change could not be completed: its target is no longer here — someone may have deleted it.',
  forbidden: 'That change could not be completed: this plan is not yours to change.',
  // Reachable bare — the dependency **picker** takes one entry through `run`,
  // where the typed list composes its own sentence and keeps the word instead.
  cycle: 'That dependency could not be added: it would make a loop.',
  ancestor: 'That dependency could not be added: the row it names is already above this one.',
  // The three the In-parallel cell earns, spelled out rather than left to the
  // fallback below. That cell deliberately keeps no copy of be-01's rule and
  // sends `0`, `-1`, `1.5` and `1001` for be-01 to answer — which is right, and
  // which means be-01's own word is what arrives here, so `INVALID_REQUEST`'s
  // status arm never fires and the grammatical fallback would carry the token
  // through. `(maxParallel_must_be_a_whole_number_from_1)` in the corner of the
  // screen is the same defect `not_found` and `http_500` were fixed for above,
  // in the one column of this table somebody types a number into every week.
  // `wbs-api.ts`'s `directoryRefusalSentence` makes the same bargain for the
  // size box the same rule is written on.
  maxParallel_must_be_a_whole_number_from_1:
    'People at once is a whole number of 1 or more. Empty the cell for one at a time.',
  // be-01 refuses a parallelism on a parent because a parent holds no slices,
  // so nothing there would read the number. Only reachable through a race — the
  // cell is read-only on every row that already has children — which is exactly
  // why the sentence has to say what happened rather than name the code.
  has_children:
    'A row with work under it runs no people of its own — set People at once on the rows beneath it.',
};

/**
 * The prefix be-01 builds its parallelism ceiling out of.
 *
 * A prefix rather than an entry above, and for `wbs-api.ts`'s stated reason:
 * be-01 spells the limit into the code from its own `MOST_PEOPLE_AT_ONCE`, so a
 * literal `maxParallel_must_be_at_most_1000` here would be a second copy of
 * that number — free to drift from it, and to fall silently back to printing
 * the wire code the day it did.
 */
const PARALLELISM_CEILING_CODE = 'maxParallel_must_be_at_most_';

/** What any 5xx says. Something answered, so never "the server did not answer". */
const SERVER_REFUSAL = 'The server could not complete that change. Try again.';

/**
 * The statuses be-01 refuses a **malformed** request with, and the only ones
 * that reach here without a word of be-01's own.
 *
 * Listed rather than matched as `http_4\d\d`, which was the first shape and is
 * wrong: 401 and 403 are the same family and say nothing about the value that
 * was sent, and a sentence claiming "that change was not valid" over an expired
 * session would send the reader looking for a typo. be-01's own words —
 * `forbidden`, `not_found` — already cover those; these two are what an ArkType
 * schema refusal leaves, because Elysia answers it with its own JSON body and
 * no `error` field for `send` to read.
 */
const INVALID_REQUEST = new Set(['http_400', 'http_422']);

/**
 * What a request be-01 could not read says.
 *
 * Reachable, and observed: a year segment typed one digit at a time made a date
 * of `dd.12.82026`, be-01 answered 422, and the corner of the screen read
 * `That change could not be completed (http_422).` — a status code, to somebody
 * who typed a date. {@link DateField} is the fix for the *cause*; this is the
 * sentence for whatever else sends be-01 something it cannot take.
 *
 * It says the plan was read again because {@link run} really does read it
 * again for this family, the same way it does for {@link GONE}: what is on
 * screen was refused, and the only honest thing to show next is what be-01
 * actually holds.
 */
const INVALID_REFUSAL =
  'That change was not valid, so nothing was saved — what is on screen was read again.';

/**
 * The sentence a refused mutation is reported in.
 *
 * @param thrown Whatever the request rejected with; anything that is not an
 * `Error` reads as an unknown code rather than being guessed at.
 */
const refusalSentence = (thrown: unknown): string => {
  const code = failureText(thrown, 'unknown');
  const known = REFUSAL_SENTENCES[code];
  if (known !== undefined) return known;
  if (code.startsWith(PARALLELISM_CEILING_CODE)) {
    return `People at once is at most ${code.slice(PARALLELISM_CEILING_CODE.length)}.`;
  }
  // The whole 5xx family, matched rather than listed: a proxy in front of
  // be-01 can answer with any of them and none of them is the reader's doing.
  if (/^http_5\d\d$/.test(code)) return SERVER_REFUSAL;
  if (INVALID_REQUEST.has(code)) return INVALID_REFUSAL;
  return `That change could not be completed (${code}).`;
};

/**
 * be-01's word for "the row you named is not there", which is the one refusal
 * that also says the tree on screen is out of date.
 */
const GONE = 'not_found';

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
const POPOVER_COLUMNS: ReadonlySet<string> = new Set([
  'depends',
  'name',
  'team',
  'actions',
  'not-before',
  // The Prio cell's band list, since `priority-bands`. The column is 48px and a
  // line reads `Critical — 10`, so the list is wider than its cell by more than
  // any other in this set except the date editor. Without the exemption it is cut
  // at the cell edge and the reader sees the first three characters of a name.
  'priority',
]);

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
 * Seven kinds of column, not two: the dependency listbox (`depends`), the
 * rendered notes preview (`name` — the notes live in that box since the Notes
 * column was folded into it), a `CreatablePicker`'s list — which is the
 * service/team cell and each role's assignee cell — the row's own actions
 * menu (`actions`), which hangs a 140px box off a 40px cell one line high,
 * a folded role's own cell (`<roleId>-final`), where an `@` opens the people
 * picker over a 96px column, and the earliest-start cell (`not-before`), whose
 * date editor is `DATE_EDITOR_WIDTH` wide in a column of 84px or 56. That last
 * one is the widest escape of the lot, and the one number here this repository
 * does not get to choose: it is what Chromium lays an unconstrained
 * `input[type=date]` out at. A column that grew to fit one would move every
 * cell under the person typing, so the editor leaves the cell instead.
 * Both kinds of role column are named for a role that only exists at runtime,
 * so they are matched by suffix, the same way `widthFor` sizes them.
 *
 * `name` is also a pinned column, and the two rules do not fight: the pin
 * places the cell, the clip decides what may leave it, and the preview has to.
 *
 * Since 2026-08-09 two of these columns are exempt for a **second** reason, and
 * it is written down here so a later change that moves a picker out of one of
 * them cannot take the exemption with it: `depends` and `<roleId>-final` each
 * open a hover card as well as a list, and a card is what a reader of a folded
 * plan is left with when nothing is open. `e2e/hover-cards.spec.ts` injects the
 * suffix branch's removal and watches the folded role's card get clipped.
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
 * The column is 110px — one clipped line of chips at rest — and an entry in
 * this list is a number and a work item's name. A list held to its own column
 * would be a list nobody can read; it hangs over the columns beside it, which
 * is what `opensAPopover` exempts the cell for. The browser gate measures it.
 */
const DEP_LIST_WIDTH = 260;

/**
 * The truncation cue on the Depends on cell's strip: the strip's last 14px
 * fade to transparent, so a line of chips that was clipped visibly runs out
 * rather than ending on what looks like the last chip.
 *
 * Applied at **rest only** — whenever the picker is closed, clipped or not.
 * The rest condition is the picker's state, never a measurement: "fade only
 * when clipped" would need the `scrollWidth` read the `+N` marker was
 * rejected for, and that door stays shut. It is not applied while the picker
 * owns the cell, because the strip wraps then — nothing is clipped, there is
 * nothing to cue, and the box spans the full width, so the mask would fade
 * the focus ring, the caret and the typed text across the last 14px. One
 * known cosmetic cost at rest: the box's `width: 100%` means a chipless
 * row's placeholder tail sits under the fade — recorded in the delta spec,
 * awaiting eyes on dev. A mask rather than a painted gradient, so it holds
 * over a tinted row (`--cell-bg`) as well as a white one.
 *
 * Proof, two faults, both watched 2026-08-10: this taken off the strip,
 * `keeps the truncation fade on the rested strip, and off the open one`
 * failed at rest on `expected '' to contain 'linear-gradient'`; applied
 * unconditionally, the same test failed with the picker open on
 * `expected 'linear-gradient(to right, #000 calc(1…' to be ''`.
 */
const DEP_EDGE_FADE = 'linear-gradient(to right, #000 calc(100% - 14px), transparent)';

// SHORTHAND_HELP moved onto {@link FoldedRoleCard}: the card is the folded
// cell's one hint, and the native `title` that used to say this raced it.

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

/**
 * The role a draft key belongs to — `rowId::roleId::point` — or null when the
 * key is not one this table wrote.
 *
 * Null rather than an empty string for a malformed key: every draft in this
 * record is written by {@link draftKey} or {@link combinedDraftKey}, so a key of
 * any other shape is a fault rather than a draft for the empty role, and the
 * sanitizer below keeps it rather than dropping it silently.
 */
const roleOfDraftKey = (key: string): string | null => key.split('::')[1] ?? null;

/**
 * The role whose column a cell key names — `rowId::<roleId>-final` or
 * `rowId::<roleId>-<point>` — or null when the column is not a role's.
 *
 * The suffix rule is {@link widthFor}'s, and for the same reason: a role's half
 * of the id is whatever the project called it, so the only thing that can be
 * matched is the end. Name, Depends on and the date box answer null and are
 * never purged by a phase going.
 */
function roleOfCellKey(cellKey: string): string | null {
  const columnId = cellKey.slice(cellKey.indexOf('::') + 2);
  const at = columnId.lastIndexOf('-');
  if (at < 1) return null;
  const suffix = columnId.slice(at + 1);
  if (suffix !== 'final' && !(POINTS as readonly string[]).includes(suffix)) return null;
  return columnId.slice(0, at);
}

/** The row a cell key belongs to — the half before the `::` {@link cellKey} joins on. */
const rowOfCellKey = (key: string): string => key.slice(0, key.indexOf('::'));

/**
 * Where each row of a freshly read plan sits: `parentId::line`, by row id, where
 * the line is its position in the order the table draws.
 *
 * A walk of the tree rather than a count of siblings, and round 4's finding 10
 * is the reason. "First child of 020" is unchanged by a peer moving 020 itself
 * — the branch and everything in it goes somewhere else on screen while every
 * row inside it reports the same parent and the same place among its siblings,
 * so the card travelled with the branch and stayed open on a line the pointer
 * was never on. The line is the thing that actually moved, and no ancestor can
 * move without changing it.
 *
 * The parent stays in the pair as well, for the move that changes no line:
 * outdenting a row leaves it where it was and shifts it left by an indent. The
 * root's parent is spelled `''`, which no id can collide with.
 *
 * The tree, not the flat read, because the flat read is in this order only by
 * be-01's promise. Walking what the table is about to draw asks nothing of the
 * caller, and a fake that reorders less carefully than be-01 does cannot make
 * this quietly agree with itself.
 */
function placementsOf(rows: readonly TreeRow[]): ReadonlyMap<string, string> {
  const placements = new Map<string, string>();
  let line = 0;
  const walk = (row: TreeRow): void => {
    placements.set(row.id, `${row.parentId ?? ''}::${String(line)}`);
    line += 1;
    for (const child of row.subRows) walk(child);
  };
  for (const root of rows) walk(root);
  return placements;
}

/**
 * The hovered cell a freshly read tree still supports, or null.
 *
 * A hover card is an absolutely positioned child of one cell and the hover is
 * remembered as a row id, so a refresh that moves that row takes the card with
 * it — to a line the pointer is not on — and one that deletes the row leaves a
 * key pointing at nothing. Neither is a card anybody asked for, and the pointer
 * will not say so: it has not moved, so no `mouseleave` is coming (codex round
 * 3, finding 3).
 *
 * Same parent and same position, rather than "still exists": a create above the
 * hovered row moves it down a line without touching it, and the card would
 * follow the row while the pointer stayed where it was.
 *
 * Unchanged is the common case and it is the one that must not close anything:
 * every edit anybody makes to this plan refetches, so clearing on each read
 * would be a card nobody could hold open long enough to read.
 */
function hoveredCellAfterRefresh(
  open: string | null,
  was: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
): string | null {
  if (open === null) return null;
  const placed = now.get(rowOfCellKey(open));
  return placed !== undefined && placed === was.get(rowOfCellKey(open)) ? open : null;
}

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

/**
 * What a row matching the Find box is tinted, so a hit reads apart from its
 * context.
 *
 * A token rather than the hex it was, for the reason every colour in this file
 * is one now: `styles.css` re-points the whole palette under `.dark`, and a
 * literal is the one shade that would not follow.
 */
const MATCH_TINT = 'var(--grid-match)';

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

/**
 * Where this browser remembers how wide one project's columns were dragged.
 *
 * Per project and per browser, exactly as {@link expansionKey} beside it: a
 * width is one reader's answer to how much of their screen a column deserves,
 * and be-01 is never told about it.
 */
const widthOverridesKey = (projectId: string): string => `wbs.columnWidths.${projectId}`;

/**
 * Where this browser remembers how tall one project's Gantt panel was dragged.
 *
 * Per project and per browser for {@link widthOverridesKey}'s reason: the
 * chart's share of the screen is one reader's answer, and be-01 is never told
 * about it.
 */
const ganttHeightKey = (projectId: string): string => `wbs.ganttHeight.${projectId}`;

/**
 * The panel height this browser last saved for `projectId`, or none where it
 * has never saved one.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary. Anything that is not a number inside the same range the drag
 * clamps to — {@link GANTT_MIN_PX} up to {@link GANTT_CEILING_PX}, the same
 * constants, so the two cannot drift apart — takes the key with it and the
 * panel opens at its default share. One comparison each way and no separate
 * finiteness test in front of them: `1e999` parses to `Infinity`, which is
 * above the ceiling exactly as `-Infinity` is below the floor, and JSON has no
 * `NaN` (the line that could not fail, `T1 column-widths-drag`).
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedWidthOverrides}'s reason: the alternative is a chart nobody can
 * open until they clear storage by hand, over a preference about its height.
 */
function rememberedGanttHeight(projectId: string): number | null {
  const stored = localStorage.getItem(ganttHeightKey(projectId));
  if (stored === null) return null;
  const claimed = parsedOrNothing(stored);
  // Proof: with this refusal deleted, `refuses storage that is not a number,
  // and drops the key`, `refuses a height below the floor…` and `refuses a
  // height above the ceiling…` (wbs-table.test.tsx) all failed — the panel
  // drawn at the claimed height, the key still there. Watched, 2026-08-10.
  if (typeof claimed !== 'number' || claimed < GANTT_MIN_PX || claimed > GANTT_CEILING_PX) {
    localStorage.removeItem(ganttHeightKey(projectId));
    return null;
  }
  return claimed;
}

/**
 * Writes the panel height in force for `projectId`.
 *
 * Called when a drag is let go of and at no other time, for {@link
 * rememberWidthOverrides}'s reason: opening a project must not change what is
 * remembered about it.
 */
function rememberGanttHeight(projectId: string, heightPx: number): void {
  localStorage.setItem(ganttHeightKey(projectId), JSON.stringify(heightPx));
}

/**
 * Where this browser remembers how wide one day of one project's chart is drawn.
 *
 * Per project for {@link ganttHeightKey}'s reason, and it is the same reason
 * rather than a similar one: a scale is **this plan's span against this
 * screen**, so a 74-day plan and a fortnight's worth of work want different
 * answers and neither is a preference about the feature. That is where it parts
 * from `wbs.ganttDetail`, which is one answer for the browser because turning
 * sixty elbows off is a statement about elbows.
 */
const ganttDayPxKey = (projectId: string): string => `wbs.ganttDayPx.${projectId}`;

/**
 * The day scale this browser last picked for `projectId`, or none where it has
 * never picked one — which opens the chart at {@link DAY_PX}.
 *
 * The stored value is a claim, not a fact: user-editable storage read at a
 * boundary. Checked with {@link isDayPx} against the same `DAY_SCALES` array
 * the control offers — **not** against a range — because the rungs are discrete
 * and a stored `9` is a width no control can get back to, so a chart opened at
 * it would be one nothing could return to a rung. Anything else takes the key
 * with it.
 *
 * Deliberately not the "unknown is not OK" throw, for
 * {@link rememberedGanttHeight}'s reason: the alternative is a chart nobody can
 * open until they clear storage by hand, over a preference about its zoom.
 */
function rememberedGanttDayPx(projectId: string): DayPx | null {
  const stored = localStorage.getItem(ganttDayPxKey(projectId));
  if (stored === null) return null;
  const claimed = parsedOrNothing(stored);
  if (!isDayPx(claimed)) {
    localStorage.removeItem(ganttDayPxKey(projectId));
    return null;
  }
  return claimed;
}

/**
 * Writes the day scale in force for `projectId`.
 *
 * Called when the control is used and at no other time, for
 * {@link rememberGanttHeight}'s reason: opening a project must not change what
 * is remembered about it.
 */
function rememberGanttDayPx(projectId: string, dayPx: DayPx): void {
  localStorage.setItem(ganttDayPxKey(projectId), JSON.stringify(dayPx));
}

/** Forgets the remembered day scale for `projectId` — the third part of a {@link Layout reset}. */
function forgetGanttDayPx(projectId: string): void {
  localStorage.removeItem(ganttDayPxKey(projectId));
}

/**
 * Where this browser remembers whether one project's chart draws its row-name
 * column.
 *
 * Per project for {@link ganttDayPxKey}'s reason and the same one: the column
 * costs a fixed 176px whatever is in it, so whether that is worth paying is
 * **this plan's names against this screen** — a 74-day plan on a phone and a
 * fortnight on a monitor give opposite answers, and neither is a preference
 * about names. It parts from `wbs.ganttDetail` where the scale does.
 */
const ganttLabelsKey = (projectId: string): string => `wbs.ganttLabels.${projectId}`;

/**
 * Whether this browser last left `projectId`'s row names shown, or none where
 * it has never said — which opens the chart with them shown.
 *
 * A boolean is the whole domain, so the guard is `typeof` and there is nothing
 * else to check: unlike a height there is no range and unlike a rung there is
 * no ladder, and `false` is a real stored answer that `??` would eat. Anything
 * that is not a boolean takes the key with it.
 *
 * Deliberately not the "unknown is not OK" throw, for
 * {@link rememberedGanttHeight}'s reason.
 */
function rememberedGanttLabels(projectId: string): boolean | null {
  const stored = localStorage.getItem(ganttLabelsKey(projectId));
  if (stored === null) return null;
  const claimed = parsedOrNothing(stored);
  if (typeof claimed !== 'boolean') {
    localStorage.removeItem(ganttLabelsKey(projectId));
    return null;
  }
  return claimed;
}

/**
 * Writes whether `projectId`'s row names are shown.
 *
 * Called when the control is used and at no other time, for
 * {@link rememberGanttDayPx}'s reason.
 */
function rememberGanttLabels(projectId: string, labelsShown: boolean): void {
  localStorage.setItem(ganttLabelsKey(projectId), JSON.stringify(labelsShown));
}

/** Forgets the remembered name column for `projectId` — the fourth part of a {@link Layout reset}. */
function forgetGanttLabels(projectId: string): void {
  localStorage.removeItem(ganttLabelsKey(projectId));
}

/**
 * Forgets the remembered panel height for `projectId` — the chart half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never a default written over it: what the panel returns to is
 * its default share as it stands then, exactly as the columns return to what
 * the frame layout resolves now.
 */
function forgetGanttHeight(projectId: string): void {
  localStorage.removeItem(ganttHeightKey(projectId));
}

/**
 * The plan as it stands when the key is read, which is before a single row has
 * arrived.
 *
 * A stored width is checked against the range a drag clamps to, and that range
 * is {@link floorFor} up to {@link WIDEST_COLUMN}. Neither end moves with the
 * plan — the only width that depends on it, `not-before`, is 56px or 84px and
 * so has the same 36px floor in both states — which is what lets this be read
 * at mount rather than deferred to the first render that knows the plan.
 * `table-frame.test.ts`'s `has a floor that does not move with the plan` is
 * what holds that true.
 */
const STATE_AT_MOUNT: FrameLayoutState = { hasAnyNotBefore: false };

/**
 * Whether a value read back out of storage is a set of column widths at all.
 *
 * The whole-key question, asked before any single entry is: an array, a string
 * and a record of names are none of them a set of widths, and a table that
 * declared `widepx` for a column would be laid out by nothing at all.
 */
function isWidthOverrides(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((width) => typeof width === 'number');
}

/**
 * The column widths this browser last saved for `projectId`, or none where it
 * has never saved any.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary — and it is validated in two rounds, because the two failures are
 * different. Storage that is not a set of widths takes the key with it, as a
 * remembered expansion that is not one does. A single entry that cannot be
 * used is dropped **on its own**, and the entries beside it still apply: one
 * hand-edited number is no reason to forget the other four columns.
 *
 * Two things disqualify an entry, and each is a line with a negative test of
 * its own (`wbs-table.test.tsx`, `the widths this browser has dragged`):
 *
 * - an id the frame layout cannot size, which would throw out of the render
 *   that tried to lay it out;
 * - a width outside the range a drag can produce, read from the same
 *   {@link floorFor} and {@link WIDEST_COLUMN} the drag clamps to, so the two
 *   cannot drift apart.
 *
 * **Two, not the three this was written with.** A `Number.isFinite(width)` line
 * stood between these until its negative was watched — and passed with the line
 * deleted. It could not fail: `1e999` is the only non-finite width JSON can
 * express, it parses to `Infinity`, and `Infinity` is above every ceiling just
 * as `-Infinity` is below every floor. JSON has no `NaN` for the case it would
 * have been about. The range check below is what really refuses both, and it is
 * the line the negative watches. R5, and `P phases-ui`'s sanitizer before it.
 *
 * An id naming a phase this project no longer holds survives all three and is
 * then never looked at — the harmlessness a remembered expansion's deleted row
 * ids have, and the reason the role coming back finds its width waiting.
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedExpansion}'s reason: the alternative is a plan nobody can open
 * until they clear storage by hand, over a preference about a column.
 */
function rememberedWidthOverrides(projectId: string): Map<string, number> {
  const stored = localStorage.getItem(widthOverridesKey(projectId));
  if (stored === null) return new Map();
  const claimed = parsedOrNothing(stored);
  if (!isWidthOverrides(claimed)) {
    localStorage.removeItem(widthOverridesKey(projectId));
    return new Map();
  }
  const kept = new Map<string, number>();
  for (const [columnId, width] of Object.entries(claimed)) {
    if (!sizableColumn(columnId, STATE_AT_MOUNT)) continue;
    // One comparison each way, and no separate finiteness test in front of
    // them: see the note above about the line that could not fail. The range
    // is each column's own: `name` reads its 200px flexible floor here, so a
    // stored Name entry is judged by the same rule as everything else.
    // Proof: the check bypassed for `name`, `drops a stored Name width
    // outside Name's own bounds, each end on its own` failed on `expected
    // '150px' to be ''` — a hand-edited 150 laid onto the Name cells below
    // the floor no drag can pass. Watched, 2026-08-10.
    if (width < floorFor(columnId, STATE_AT_MOUNT) || width > WIDEST_COLUMN) continue;
    kept.set(columnId, width);
  }
  return kept;
}

/**
 * Writes the widths in force for `projectId`.
 *
 * Called when a drag is let go of and at no other time. In particular the
 * sanitized set is **not** written back on read: opening a project must not
 * change what is remembered about it, and a write-back would quietly discard
 * the entry for a phase that is only temporarily absent.
 */
function rememberWidthOverrides(projectId: string, overrides: ReadonlyMap<string, number>): void {
  localStorage.setItem(widthOverridesKey(projectId), JSON.stringify(Object.fromEntries(overrides)));
}

/**
 * Forgets every remembered width for `projectId` — the widths half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never an empty object written over it. What the columns return
 * to is whatever the frame layout resolves for them *now*, and a snapshot
 * stored here is that promise broken: a column whose default has changed since
 * the drag would come back to the old one.
 */
function forgetWidthOverrides(projectId: string): void {
  localStorage.removeItem(widthOverridesKey(projectId));
}

/**
 * Where this browser remembers which of one project's columns a reader has
 * hidden — the {@link Hidden column}s that, taken off the default column set,
 * are that reader's {@link Column set}.
 *
 * Per project and per browser for {@link widthOverridesKey}'s reason: which
 * columns a reader wants on their screen is their answer, and be-01 is never
 * told about it.
 */
const hiddenColumnsKey = (projectId: string): string => `wbs.hiddenColumns.${projectId}`;

/**
 * The hide-list this browser last saved for `projectId`, or the default hidden
 * columns where it has never saved one.
 *
 * A **hide-list**, so a column this table learns to draw later is on screen by
 * default without anybody's storage being touched; and an absent key means
 * {@link DEFAULT_HIDDEN_COLUMNS}, while a stored `[]` means "everything shown"
 * — the two are different facts and this is where they part.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary, the posture {@link rememberedWidthOverrides} takes. A value that is
 * not a list of strings takes the key with it and the default set is shown. An
 * id the table does not declare is **not** judged here: a role's id is only
 * known once the roles have loaded, so the list is kept whole and
 * `hiddenColumnIds` in the component filters it against
 * {@link hideableColumnIds} on every render that could change the answer. It
 * is also not written back — opening a project must not change what is
 * remembered about it, and a hidden role that is only temporarily absent must
 * find its entry waiting.
 *
 * Deliberately not the "unknown is not OK" throw, for {@link
 * rememberedWidthOverrides}'s reason: the alternative is a plan nobody can open
 * until they clear storage by hand, over a preference about a column.
 *
 * Proof: the shape check deleted, `clears a store that is not a list of strings
 * and shows the default set` (wbs-table.test.tsx) failed with `TypeError:
 * storedHiddenColumns.filter is not a function` — the `'4'` handed to the
 * component as a list; with only the `removeItem` deleted, on `expected '4' to
 * be null`. Watched, 2026-08-28.
 */
function rememberedHiddenColumns(projectId: string): readonly string[] {
  const stored = localStorage.getItem(hiddenColumnsKey(projectId));
  if (stored === null) return DEFAULT_HIDDEN_COLUMNS;
  const claimed = parsedOrNothing(stored);
  if (!isStringArray(claimed)) {
    localStorage.removeItem(hiddenColumnsKey(projectId));
    return DEFAULT_HIDDEN_COLUMNS;
  }
  return claimed;
}

/**
 * Writes the hide-list in force for `projectId`.
 *
 * Called when a reader ticks or unticks a column in the Columns control, or
 * applies a saved view that carries a column set, and at no other time — see
 * {@link rememberedHiddenColumns} for why not on read.
 */
function rememberHiddenColumns(projectId: string, hidden: readonly string[]): void {
  localStorage.setItem(hiddenColumnsKey(projectId), JSON.stringify(hidden));
}

/**
 * Forgets which columns are hidden for `projectId` — the columns half of a
 * {@link Layout reset}.
 *
 * `removeItem`, never the default list written over it: the default column set
 * is whatever {@link DEFAULT_HIDDEN_COLUMNS} says *now*, and a snapshot stored
 * here is that promise broken the day the default moves.
 */
function forgetHiddenColumns(projectId: string): void {
  localStorage.removeItem(hiddenColumnsKey(projectId));
}

/**
 * A named filter this browser has saved, so it can be picked again later —
 * R10 F4 — with, since `configurable-columns`, the {@link Column set} that was
 * on screen when it was saved. Not the expansion, not the column widths. A
 * saved view is *how one reader is looking at a plan*, the exact phrase
 * `planForExport` uses to justify not exporting a collapsed branch or a running
 * search — so it lives here, per browser, beside every other display
 * preference, and be-01 is never told about it.
 *
 * `hiddenColumnIds` is optional because views saved before it existed have
 * none, and absent means what it meant then: this view says nothing about
 * columns, and applying it leaves them as they are. Present, it is the whole
 * hide-list to apply — `[]` shows everything.
 */
interface SavedView {
  id: string;
  name: string;
  criteria: FilterCriteria;
  hiddenColumnIds?: readonly string[];
}

/**
 * Where this browser remembers one project's saved views.
 *
 * Per project and per browser, exactly as {@link widthOverridesKey} beside
 * it: a view is one reader's own named answer to "what am I looking at",
 * and it must not appear in front of a different reader who opens the same
 * plan on their own machine.
 */
const savedViewsKey = (projectId: string): string => `wbs.views.${projectId}`;

/** Whether a claimed value is a list of strings — a facet's chosen ids. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

/**
 * Whether a claimed value is a facet list that **was not stored at all** — the
 * state a view saved before that facet existed is in.
 *
 * Absent is usable and means "this view asks nothing about that facet", which
 * is what it did mean when it was saved. Present-but-wrong is not: a
 * hand-edited `tagIds: 3` is a view this table cannot apply, and it is dropped
 * with the rest of the unusable ones.
 */
function isAbsentOrStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

/**
 * The same tolerance for a facet that is a **flag** rather than a list — the
 * two mismatch signals, added 2026-08-21.
 *
 * Its own function rather than a widened {@link isAbsentOrStringArray}, because
 * a view storing `builtByNonOwner: []` is malformed and a check that accepted
 * either shape would apply it as `false` instead of dropping it.
 */
function isAbsentOrBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Whether a claimed value has every field {@link FilterCriteria} declares —
 * treating a facet **added after this view was saved** as absent rather than as
 * malformed.
 *
 * `saved-views` shipped on 2026-08-19 (#83) and `tags` added a facet on
 * 2026-08-20, so between those two dates a reader could save a view that has no
 * `tagIds` in it. Requiring the field outright would have made every one of
 * those views unusable, and `rememberedSavedViews` drops what it cannot use —
 * so the tool would have deleted somebody's saved filters because a feature
 * they never asked for shipped. Each new facet joins this list the same way.
 *
 * Found by `drops one unusable saved view and keeps the rest`, which crashed on
 * `Cannot read properties of undefined (reading 'length')` inside `filterWords`
 * rather than failing an assertion — the shape check passed a view the rest of
 * the module could not read. Watched 2026-08-20.
 */
function isFilterCriteriaShape(value: unknown): value is FilterCriteria {
  if (typeof value !== 'object' || value === null) return false;
  const claimed = value as Record<string, unknown>;
  return (
    typeof claimed['query'] === 'string' &&
    isStringArray(claimed['teamIds']) &&
    isAbsentOrStringArray(claimed['tagIds']) &&
    isAbsentOrStringArray(claimed['serviceIds']) &&
    isAbsentOrBoolean(claimed['builtByNonOwner']) &&
    isAbsentOrBoolean(claimed['assignedOutsideTeam']) &&
    isStringArray(claimed['assigneeIds']) &&
    isStringArray(claimed['priorityBands']) &&
    isStringArray(claimed['estimatedRoleIds']) &&
    typeof claimed['unestimated'] === 'boolean' &&
    typeof claimed['critical'] === 'boolean'
  );
}

/**
 * One stored view's criteria with every facet present, whatever the storage
 * held.
 *
 * The **one** place a stored view becomes a `FilterCriteria` the rest of this
 * module may assume is whole. `filterWords`, `narrowTree` and the facet panel
 * all read `criteria.tagIds.length` without checking, and they are right to:
 * the type says it is there. This is what makes the type true at the boundary,
 * which is where user-editable storage is turned into a fact.
 *
 * Spread over {@link NO_FILTER} rather than field by field, so a facet added
 * later is defaulted here without this function being touched again.
 */
function everyFacetOf(criteria: FilterCriteria): FilterCriteria {
  return { ...NO_FILTER, ...criteria };
}

/** Whether a claimed value is one saved view this table can offer and apply. */
function isSavedView(value: unknown): value is SavedView {
  if (typeof value !== 'object' || value === null) return false;
  const claimed = value as Record<string, unknown>;
  const name = claimed['name'];
  return (
    typeof claimed['id'] === 'string' &&
    typeof name === 'string' &&
    name.trim() !== '' &&
    isFilterCriteriaShape(claimed['criteria']) &&
    // Absent is a view from before column sets; present-but-wrong is a view
    // this table cannot apply, dropped with the other unusable ones.
    // Proof: this line deleted, `drops a view whose column set is not a list
    // of strings, and keeps the one beside it` failed on `Unable to find an
    // element with the text: Views (1)` — both offered. Watched, 2026-08-28.
    isAbsentOrStringArray(claimed['hiddenColumnIds'])
  );
}

/**
 * The views this browser last saved for `projectId`, or none where it has
 * never saved any.
 *
 * The stored value is a claim, not a fact — user-editable storage read at a
 * boundary, the same posture {@link rememberedWidthOverrides} takes. Storage
 * that is not an array at all takes the key with it; a single entry that is
 * not a usable view is dropped **on its own**, and the views beside it still
 * apply — one hand-edited view is no reason to forget the rest.
 *
 * A view naming a team, a person or a phase this project no longer holds
 * survives this check and is simply never a live checkbox: applying it ticks
 * a box the facet panel already knows how to draw for an absent value
 * (`optionsFor`, "a team this plan has not loaded"), and narrowing by an id
 * no row carries answers empty — the same "empty means empty" rule any other
 * facet with nothing left to match gets. Nothing here repairs or deletes the
 * view on the reader's behalf.
 */
function rememberedSavedViews(projectId: string): SavedView[] {
  const stored = localStorage.getItem(savedViewsKey(projectId));
  if (stored === null) return [];
  const claimed = parsedOrNothing(stored);
  if (!Array.isArray(claimed)) {
    localStorage.removeItem(savedViewsKey(projectId));
    return [];
  }
  return claimed
    .filter(isSavedView)
    .map((view) => ({ ...view, criteria: everyFacetOf(view.criteria) }));
}

/**
 * Writes the saved views in force for `projectId`.
 *
 * Called on Save and on Delete, and at no other time — same as {@link
 * rememberWidthOverrides}, opening a project must not change what it
 * remembers about it, and the sanitized set from {@link rememberedSavedViews}
 * is never written back on a read.
 */
function rememberSavedViews(projectId: string, views: readonly SavedView[]): void {
  localStorage.setItem(savedViewsKey(projectId), JSON.stringify(views));
}

/**
 * How wide a column is while its resize handle is `travel` px from where it was
 * grabbed.
 *
 * The whole of the arithmetic a drag writes, kept out of the handlers so that
 * something can hold it: jsdom performs no default action for a pointer event,
 * so the gesture is provable only in a browser (`e2e/layout.spec.ts`) and this
 * is the part that is not.
 *
 * `fromWidth` is the width the column was laid out at when the handle was taken
 * — not the width it is at now, which is this function's own answer one pointer
 * move ago.
 *
 * @throws {UnknownColumnError} through {@link clampColumnWidth}, for a column
 * with no declared width to drag. Nothing renders a handle on one.
 */
export function widthFromDrag(
  columnId: string,
  fromWidth: number,
  travel: number,
  state: FrameLayoutState,
): number {
  return clampColumnWidth(columnId, fromWidth + travel, state);
}

/** What a resize handle does with the width its gesture worked out. */
interface ColumnResize {
  /** Follows the pointer: how wide the column is drawn while the drag is in flight. */
  drag: (columnId: string, width: number) => void;
  /** The width the reader let go at, which is the one that is remembered. */
  commit: (columnId: string, width: number) => void;
  /** A `pointercancel` — the browser took the gesture away — which leaves the widths as they were. */
  abandon: () => void;
}

/**
 * The grab handle on one column header's trailing edge.
 *
 * Hand-rolled `pointerdown`/`pointermove`/`pointerup` with pointer capture,
 * rather than TanStack's own column resizing: that writes the width into the
 * column definition, which is the one place in this table a width must never
 * live — `flexRender` renders each `cell` as a component *type*, so a
 * definition that changed with a width would remount every cell in the table on
 * every pointer move (LLM_README landmine #1).
 *
 * Capture is what makes the gesture survive the pointer leaving the 6px strip,
 * which it does immediately: with it, every `pointermove` and the `pointerup`
 * are delivered here however far away they happen.
 *
 * The width the drag counts from is taken **once**, at `pointerdown`. Counting
 * from the width on screen would compound this function's own answer with every
 * move — a drag that accelerates away from the pointer.
 *
 * For the one column that resolves no width — an undragged Name — the
 * from-width is the header cell's **rendered** width, measured at
 * `pointerdown`: the only measurement in the gesture, because there is no
 * resolved number to count from and the browser is the only thing that knows
 * what the remainder-absorber is standing at. jsdom lays nothing out and
 * measures every box at 0, so a zero falls back to the column's
 * `FLEXIBLE_FLOOR`; the real from-width is provable only in Chromium
 * (`e2e/layout.spec.ts`), the same bargain {@link GanttHeightHandle} makes.
 */
function ColumnResizeHandle({
  columnId,
  heading,
  width,
  state,
  resize,
}: {
  columnId: string;
  /** What the column is called, so the control has a name to be found by. */
  heading: string;
  /**
   * The width the column resolves to now, which a new gesture starts from —
   * or `undefined` for an undragged flexible column, whose gesture starts
   * from the rendered width instead.
   */
  width: number | undefined;
  state: FrameLayoutState;
  resize: ColumnResize;
}) {
  const grabbed = useRef<{ pointerId: number; fromX: number; fromWidth: number } | null>(null);
  const widthAt = (clientX: number, from: { fromX: number; fromWidth: number }): number =>
    widthFromDrag(columnId, from.fromWidth, clientX - from.fromX, state);

  return (
    <span
      data-resize-handle={columnId}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${heading}`}
      title={`Drag to resize ${heading}`}
      onPointerDown={(event) => {
        // The browser's own answer to a press and a drag across a heading is a
        // text selection, and there is nothing in this strip to select.
        event.preventDefault();
        // Capture, so every move and the release are delivered here however far
        // the pointer has travelled — a 6px strip is not something a hand stays
        // inside.
        event.currentTarget.setPointerCapture(event.pointerId);
        const cell = event.currentTarget.closest('th');
        // The strip is rendered inside the header cell it resizes; a handle
        // with no cell above it is an invariant broken, not a state to
        // default.
        if (cell === null) throw new Error('no header cell above the resize handle');
        const measured = cell.getBoundingClientRect().width;
        grabbed.current = {
          pointerId: event.pointerId,
          fromX: event.clientX,
          fromWidth: width ?? (measured > 0 ? measured : FLEXIBLE_FLOOR),
        };
      }}
      onPointerMove={(event) => {
        const from = grabbed.current;
        // A move with no grab behind it is the pointer crossing the strip, and
        // a second pointer's move is somebody else's gesture: neither is this
        // drag.
        if (from?.pointerId !== event.pointerId) return;
        resize.drag(columnId, widthAt(event.clientX, from));
      }}
      onPointerUp={(event) => {
        const from = grabbed.current;
        if (from?.pointerId !== event.pointerId) return;
        grabbed.current = null;
        resize.commit(columnId, widthAt(event.clientX, from));
      }}
      onPointerCancel={() => {
        if (grabbed.current === null) return;
        grabbed.current = null;
        resize.abandon();
      }}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 6,
        cursor: 'col-resize',
        // Or the frame under it takes a touch drag as a scroll and the column
        // never moves.
        touchAction: 'none',
        userSelect: 'none',
      }}
    />
  );
}

/** What the handle on the Gantt panel's top edge does with the height its gesture works out. */
interface GanttHeightResize {
  /** Follows the pointer: how tall the panel is drawn while the drag is in flight. */
  drag: (heightPx: number) => void;
  /** The height the reader let go at, which is the one that is remembered. */
  commit: (heightPx: number) => void;
  /** A `pointercancel` — the browser took the gesture away — which leaves the height as it was. */
  abandon: () => void;
}

/**
 * The grab handle on the Gantt panel's top edge: dragging it up gives the
 * chart more of the screen, dragging it down gives it back to the plan.
 *
 * {@link ColumnResizeHandle}'s shape turned on its side — pointer capture, the
 * from-height taken **once** at `pointerdown`, the write held back to the
 * release — and rendered by the shell **outside** {@link GanttFaultBoundary}
 * on purpose: a chart that cannot be drawn costs the reader the chart, and
 * must not cost them the edge that gives it its screen back.
 *
 * The height a new gesture counts from is the panel as the browser really laid
 * it out — the override may be CSS-capped on a smaller screen than it was
 * dragged on, and counting from the stored number would open every such
 * gesture with a jump. jsdom lays nothing out and measures every box at 0, so
 * a zero falls back to the override, then to the floor; the real from-height
 * is provable only in Chromium (`e2e/gantt.spec.ts`).
 */
function GanttHeightHandle({
  heightPx,
  resize,
}: {
  /** The override in force, or `null` while the panel stands at its default share. */
  heightPx: number | null;
  resize: GanttHeightResize;
}) {
  const grabbed = useRef<{ pointerId: number; fromY: number; fromHeight: number } | null>(null);
  const heightAt = (clientY: number, from: { fromY: number; fromHeight: number }): number =>
    clampedGanttHeight(from.fromHeight + (from.fromY - clientY), window.innerHeight);

  return (
    <div
      data-gantt-height-handle
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the Gantt chart"
      title="Drag to resize the Gantt chart"
      onPointerDown={(event) => {
        // The browser's own answer to a press and a drag across the page is a
        // text selection, and there is nothing in this strip to select.
        event.preventDefault();
        // Capture, for {@link ColumnResizeHandle}'s reason: a hand does not
        // stay inside a 6px strip.
        event.currentTarget.setPointerCapture(event.pointerId);
        const panel = event.currentTarget.nextElementSibling;
        // The panel, or the fault standing in for it — either way the box this
        // gesture resizes. Absent means the handle was mounted without one,
        // which is an invariant broken, not a state to default.
        if (!(panel instanceof HTMLElement)) throw new Error('no chart under the height handle');
        const measured = panel.getBoundingClientRect().height;
        grabbed.current = {
          pointerId: event.pointerId,
          fromY: event.clientY,
          fromHeight: measured > 0 ? measured : (heightPx ?? GANTT_MIN_PX),
        };
      }}
      onPointerMove={(event) => {
        const from = grabbed.current;
        // A move with no grab behind it is the pointer crossing the strip, and
        // a second pointer's move is somebody else's gesture: neither is this
        // drag.
        if (from?.pointerId !== event.pointerId) return;
        resize.drag(heightAt(event.clientY, from));
      }}
      onPointerUp={(event) => {
        const from = grabbed.current;
        if (from?.pointerId !== event.pointerId) return;
        grabbed.current = null;
        resize.commit(heightAt(event.clientY, from));
      }}
      onPointerCancel={() => {
        if (grabbed.current === null) return;
        grabbed.current = null;
        resize.abandon();
      }}
      className="shrink-0"
      style={{
        height: 6,
        // Pulled over the panel's own top border so the grab strip and the
        // drawn edge are one line, not a gap above it.
        marginBottom: -6,
        position: 'relative',
        zIndex: 1,
        cursor: 'row-resize',
        // Or the frame under it takes a touch drag as a scroll and the
        // boundary never moves.
        touchAction: 'none',
        userSelect: 'none',
      }}
    />
  );
}

/**
 * The sentence both mismatch markers end on, in one constant so they end alike.
 *
 * It is the load-bearing half of D5: neither signal refuses anything, moves a
 * date or blocks a write, and a reader meeting a mark on their own row needs to
 * be told that before they go looking for what to fix. Written once because two
 * markers reassuring a reader in two different wordings read as two different
 * kinds of trouble.
 */
const MISMATCH_TAIL = ' Nothing is blocked — the plan is recording this, not refusing it.';

/**
 * A list of names as a sentence says them: `A`, `A and B`, `A, B and C`.
 *
 * Both markers name a set now — every offending service since the 2026-08-21
 * scope change, and every team in force — so the alternative is a bare
 * comma-join that reads as a fragment inside a sentence that is otherwise
 * English.
 */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Everybody named on any of this row's phases, deduplicated.
 *
 * A module function and not two inline spreads because both readers of it — the
 * `assigneeIds` facet and the assignee marker's list of who is outside — have
 * to be asking about the same people. One person on three phases is one person
 * to filter by and one person to mark, and `includes` over a list holding them
 * three times is the same answer paid for three times on every keystroke.
 */
function assigneesOf(row: TreeRow): string[] {
  return [...new Set(Object.values(row.assignees).filter((id): id is string => id !== undefined))];
}

/**
 * The quiet marker both mismatch signals wear (task 7.2, design D5).
 *
 * One component for both, which is the whole reason 7.1 was split to bring them
 * here together: two markers that must carry the same kind of sentence get
 * phrased differently when they are written a chunk apart. A hollow triangle
 * and not `!` — `!` is this table's word for a complaint the tool wants fixed
 * (a trio that saves nothing), and neither of these is a complaint. Nothing is
 * refused, nothing moves, no date changes; the plan is being honest about what
 * it holds. Muted ink for the same reason: a marker loud enough to read as an
 * error would be an error the reader cannot clear.
 *
 * `role="img"` with the sentence as its label, because the sentence is the
 * marker. A glyph that cannot say why is a mystery rather than a signal
 * (7.2's own words), and a `title` alone reaches a pointer only.
 *
 * **The pointer rule, in one sentence, because 2026-08-22 found the two marks
 * disagreeing in the DOM and read that as one of them saying nothing:** every
 * mark answers the hover that lands on it with its own sentence — as a `title`
 * where nothing else owns that hover, and off the cell's card where something
 * does. The two are the same promise through different means, not a rule and an
 * exception, which is why `carded` is a property of the *cell* rather than of
 * the kind: the folded assignee mark drops its `title` and the unfolded one
 * keeps it, and both are the same mark. What must never happen is a third case
 * — no `title` and no card — and `answers a pointer at every mark` asserts the
 * promise over every mark on a row rather than over the two this file happens
 * to place today.
 */
function MismatchMark({
  kind,
  note,
  carded = false,
}: {
  kind: 'service' | 'assignee';
  note: string;
  /**
   * Whether this mark sits in a cell whose one hint is a hover card, in which
   * case it carries no native `title`.
   *
   * The folded role cell's own decision, 2026-08-09 and stated in its code: a
   * browser tooltip is one line, a second late, and it raced the card over the
   * same pixels. So there the sentence goes on the card and the mark keeps only
   * its `aria-label`, which nothing races. A mark with no sentence anywhere
   * would be the mystery 7.2 forbids; this moves the sentence, it does not drop
   * it.
   *
   * The mark sits **inside** the cell whose `onMouseEnter` opens that card, so
   * the pointer that reaches the triangle is the pointer that opens the card:
   * the sentence arrives from hovering the mark either way. Giving this mark a
   * `title` as well would put both on screen at once over the same 96px, which
   * is the race that decision was taken to end.
   */
  carded?: boolean;
}) {
  return (
    <span
      data-mismatch={kind}
      role="img"
      aria-label={note}
      // The `title` is the pointer's copy of the same sentence. Both, not one:
      // `aria-label` is not shown to a sighted reader and `title` is not read
      // to a screen reader off a `span`.
      {...(carded ? {} : { title: note })}
      style={{
        color: 'var(--muted-foreground)',
        cursor: 'help',
        flex: 'none',
        fontSize: '0.85em',
        marginLeft: 2,
      }}
    >
      △
    </span>
  );
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
const ARMED_TINT = 'var(--grid-armed)';

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

/**
 * Which workday of the plan a stored "start no earlier than" date holds a row
 * at, or null when there is no such workday to name.
 *
 * Null in two cases and both are modeled absences rather than missing answers:
 * nobody has set a date on the row, or the project is not on a calendar at all
 * — and a plan with no start date has an axis of offsets that a date could not
 * be placed on. The chart draws no not-before flag in either case, which is
 * what the row's own Start column says too.
 *
 * `workdaysBetween` is `libs/domain`'s, imported from the module rather than
 * the lib's index barrel: it is the inverse of the `addWorkdays` be-01 placed
 * the date with, and counting the days here would be a second implementation
 * of the calendar sitting under the columns that print it.
 */
const notBeforeOffsetOf = (startDate: string | null, notBefore: string | null): number | null =>
  startDate === null || notBefore === null ? null : workdaysBetween(startDate, notBefore);

/**
 * The control on the toolbar sheet a click was on, if that click closes it.
 *
 * Taking a control on the sheet is taking it on the plan behind the sheet, and
 * the plan is what wants looking at next — a phone screen is 390px and the
 * sheet is most of it. So a click on one of the sheet's own controls closes it.
 *
 * The control itself rather than a yes/no, because the caller has a second
 * question for it: {@link TAKES_THE_FOCUS} says whether that control moves the
 * focus itself, and the answer decides whether Radix's own restore is allowed
 * to happen.
 *
 * Two exemptions, and each is a fault this was written after meeting:
 *
 * - **A control that opens a surface of its own.** `PhasesDialog` is on this
 *   sheet, and closing the sheet unmounts the dialog its trigger was about to
 *   open. Radix marks such a trigger `aria-haspopup="dialog"`, which is the
 *   question asked here.
 * - **A click on another surface entirely.** React sends a portal's events up
 *   the **React** tree, so every click inside that phases dialog arrives here
 *   even though the dialog is nowhere near this element in the DOM — and would
 *   close the sheet under it, mid-click, on the way to adding a phase.
 *
 * @param target What was clicked — `event.target`, not the handler's element.
 * @param surface The sheet's own surface, which is `event.currentTarget`.
 */
function closingControlIn(target: EventTarget | null, surface: Element): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-modal-surface]') !== surface) return null;
  const control = target.closest('button');
  if (control?.getAttribute('aria-haspopup') !== null) return null;
  return control;
}

/**
 * The mark a toolbar control wears when taking it puts the focus somewhere of
 * its own choosing, so the sheet must not put it back on the trigger.
 *
 * Three controls wear it, and no others:
 *
 * - **`Add work item`**, which asks for the caret in the new row's name.
 * - **The readiness badge**, which walks to the cell estimating the next gap.
 * - **`⌨`**, which opens the cheat sheet — a dialog that focuses its own panel
 *   on mount and restores on unmount. Radix's restore lands on a timer, so it
 *   arrives *after* that and takes the focus off a dialog that is still open;
 *   measured in jsdom, where the panel had the focus with the restore refused
 *   and the `Plan actions` trigger had it without.
 *
 * Every other control on the sheet — `Collapse all`, `Gantt`, `Undo`, the
 * exports — changes the plan without aiming the caret anywhere, and for those
 * Radix restoring the focus to the `Plan actions` trigger is the right answer
 * rather than a thing to suppress. Suppressing it left them on `<body>`.
 *
 * Not `data-lands-in-plan`, which is what the first two do and what the review
 * asked for: `⌨` lands in a dialog instead, and a name that described two of
 * the three would be a name the third is filed under wrongly.
 *
 * A DOM attribute rather than a list of labels here: the control that knows it
 * moves the focus is the control that says so, and a list would go stale the
 * next time one is added. See {@link closingControlIn} for who reads it.
 */
const TAKES_THE_FOCUS = 'data-takes-the-focus';

/**
 * What a control that is unavailable **because a save is in flight** looks
 * like, as opposed to one that is unavailable because there is nothing for it
 * to do.
 *
 * **The fault it exists for.** Every toolbar control that writes is
 * `disabled={busy}` for the whole of the write *and* the refetch after it, and
 * a `disabled` button drops a click on the floor without a sound. Typing a
 * character, pressing ⌘+Enter and clicking `Add work item` in the same breath
 * produced a `PATCH` and two `GET`s and **no `POST` at all** — no new row, no
 * cursor change, no message. Reproduced on demand in Chrome, 2026-08-09.
 *
 * The click is still dropped: queuing it would be a second, invisible order of
 * operations over a plan two people are editing, and that is a design decision
 * nobody has made. What this changes is that the drop is **visible** — the
 * whole toolbar says `aria-busy`, and the controls the wait is holding back
 * fade and take the progress cursor, so a click that goes nowhere lands on
 * something that already said it would.
 *
 * `Undo` with nothing to undo gets none of this and that is the distinction
 * being drawn: it is disabled because the stack is empty, waiting will not
 * change it, and a progress cursor over it would be a lie. The affordance is
 * spread only while `busy` is true, so a control disabled for both reasons
 * wears it for exactly as long as the wait is the reason.
 */
const busyAffordance = (busy: boolean): { 'data-busy'?: ''; style?: CSSProperties } =>
  busy ? { 'data-busy': '', style: { cursor: 'progress', opacity: 0.6 } } : {};

/**
 * One read of the tree, as far as the chart is concerned: the slices, the roles
 * they were placed under, and the names of everybody on them.
 *
 * All three arrive on the same request, and this type is what keeps them
 * arriving together — see {@link GanttPlan} for what happens to a drawing whose
 * parts came from different moments.
 */
interface ChartRead {
  slices: SliceView[];
  roles: RoleView[];
  people: AssignedPersonView[];
  /**
   * Which read this is: `refresh`'s own generation, and 0 before any has
   * landed.
   *
   * Carried here rather than kept in a ref because it is what
   * {@link GanttFaultBoundary} resets on — a fault caught while drawing one
   * read must clear when the next one arrives, and only a value that renders
   * can say a new one has.
   */
  generation: number;
}

/** No read has landed yet: no slices, no roles, nobody, and no generation. */
const NO_CHART_READ: ChartRead = { slices: [], roles: [], people: [], generation: 0 };

const column = createColumnHelper<TreeRow>();

declare module '@tanstack/react-table' {
  /**
   * What a column is called out loud, where that is not what its heading
   * shows.
   *
   * Two columns print a mark rather than a word — `#` for the numbering and
   * `o`/`r`/`p` for the three estimate points — because the words do not fit
   * in 93px and 44px and a clipped word says less than a mark does. A heading
   * a screen reader reads as "hash" or "oh" is a column with no name, so the
   * word is declared here and put on the `<th>` as its `aria-label`.
   *
   * On the definition rather than in a lookup beside the render, so the
   * heading and the word it stands for are written in the same place; on the
   * `<th>` rather than inside it because an `aria-label` on a `<span>` with no
   * role of its own is not reliably part of the cell's accessible name — the
   * fault this went through: `getByRole('columnheader', { name: 'Number' })`
   * found nothing with the label a level down.
   */
  // The generic parameters are TanStack's own; this interface is merged into
  // its declaration, so they are named to match rather than used here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    spokenHeading?: string;
  }
}

/** One tickable value of one facet: what to filter by, and what to call it. */
interface FacetOption {
  id: string;
  label: string;
}

/** How many facet values are ticked, which is what the control says on itself. */
function facetsChosen(facets: FacetCriteria): number {
  return (
    facets.teamIds.length +
    facets.tagIds.length +
    facets.serviceIds.length +
    (facets.builtByNonOwner ? 1 : 0) +
    (facets.assignedOutsideTeam ? 1 : 0) +
    facets.assigneeIds.length +
    facets.priorityBands.length +
    facets.estimatedRoleIds.length +
    (facets.unestimated ? 1 : 0) +
    (facets.critical ? 1 : 0)
  );
}

/** A value ticked or unticked, as a new list — the state here is never mutated in place. */
const toggledIn = (chosen: readonly string[], id: string): string[] =>
  chosen.includes(id) ? chosen.filter((each) => each !== id) : [...chosen, id];

/**
 * What one facet offers, for the two facets whose values have no order of their
 * own: the teams and the people on this plan.
 *
 * **The plan's values, plus whatever is still ticked.** `present` is what the
 * rows on screen actually carry, so a facet never offers a value whose only
 * possible answer is an empty table. But the tree refetches on everybody's
 * edit, so the row a tick was aimed at can leave while the tick is still in
 * force — and dropping the box then would narrow the plan to nothing with
 * nothing on screen to untick. So a ticked value is offered whether the plan
 * still carries it or not.
 *
 * By label, because neither teams nor people have a meaning in the order be-01
 * happens to return them in — unlike the bands, which are a ladder, and the
 * phases, which are the order of the columns they estimate. Those two keep
 * their own order and do not come through here.
 */
function optionsFor(
  present: ReadonlySet<string>,
  picked: readonly string[],
  labelOf: (id: string) => string,
): FacetOption[] {
  return [...new Set([...present, ...picked])]
    .map((id) => ({ id, label: labelOf(id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * The six facets a reader can narrow the plan by, beside the Find box.
 *
 * **A `<details>` and not a positioned popover**, for the reason
 * `plan-cards.tsx`'s phase breakdown is one: it needs no measurement, no
 * pointer-type guard and no dismiss handler, and a tap is what opens one
 * already — which is what makes this control work unchanged inside the phone's
 * `Plan actions` sheet, where a `<summary>` and a checkbox are not the
 * `<button>` that closes it (`closingControlIn`).
 *
 * **Every list is the plan's own.** The teams are the effective teams somebody
 * on this plan carries, the people are the ones be-01 says are assigned on it,
 * the bands are this project's ladder and the phases are its roles. A facet
 * offering a value no row has is a filter whose only possible answer is an
 * empty table.
 *
 * The narrowing itself is not here and must not be: this writes criteria, and
 * `narrowTree` is the one thing that reads them.
 */
function FilterFacets({
  facets,
  setFacets,
  teams,
  tags,
  services,
  people,
  bands,
  phases,
  ownershipKnown,
  membershipKnown,
}: {
  facets: FacetCriteria;
  setFacets: (next: FacetCriteria) => void;
  teams: readonly FacetOption[];
  tags: readonly FacetOption[];
  services: readonly FacetOption[];
  people: readonly FacetOption[];
  bands: readonly FacetOption[];
  phases: readonly FacetOption[];
  /**
   * Whether any team owns any service — the directory fact `builtByNonOwner`
   * is asked against.
   *
   * False is the state the deployment ships in (the map has no seed data, by
   * the proposal's non-goal), and in it the signal does not mean "nothing is
   * built by a non-owner" — it flags **every** row carrying a team and a
   * service, because no team owns anything. Offering the box there would put a
   * marker on most of a plan on the strength of a directory nobody has filled
   * in, which is the failure `label-mismatch.ts` exists to argue against. The
   * design's first risk, mitigated by saying so instead of by ticking.
   */
  ownershipKnown: boolean;
  /** The same fact for the second signal: whether anybody belongs to any team. */
  membershipKnown: boolean;
}) {
  const chosen = facetsChosen(facets);
  /** One group of tick boxes, or nothing at all where the plan offers none. */
  const group = (
    title: string,
    kind: string,
    options: readonly FacetOption[],
    picked: readonly string[],
    take: (next: string[]) => FacetCriteria,
  ): ReactNode =>
    options.length === 0 ? null : (
      <fieldset data-facet-group={kind} className="mb-2 border-0 p-0">
        <legend className="text-muted-foreground mb-1 text-xs font-semibold">{title}</legend>
        {options.map((option) => (
          <label key={option.id} className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              // Named by its facet as well as its value: a team and a person
              // may share a name, and two boxes with one label is a control
              // neither a reader nor a test can aim at.
              aria-label={`${title} ${option.label}`}
              checked={picked.includes(option.id)}
              onChange={() => {
                setFacets(take(toggledIn(picked, option.id)));
              }}
            />
            <span className="truncate">{option.label}</span>
          </label>
        ))}
      </fieldset>
    );

  /**
   * One mismatch signal's box, with the reason it cannot be asked yet where a
   * reader will read it.
   *
   * **Disabled only while it is not already ticked.** A view saved when the
   * directory had ownership in it, reopened after somebody emptied the map,
   * would otherwise show a ticked box that cannot be unticked and a table with
   * nothing in it — a filter a reader cannot leave. Ticked wins: the box stays
   * live so it can be turned off, and the hint below still says why it now
   * finds nothing.
   *
   * `title` rather than a paragraph under the label, because this panel is 56
   * units wide and two sentences of hint per box push the State group off the
   * bottom of a phone's sheet. The same sentence is also the box's accessible
   * description, so it is not a mouse-only explanation.
   */
  const signal = (
    label: string,
    what: string,
    ticked: boolean,
    askable: boolean,
    why: string,
    take: (next: boolean) => FacetCriteria,
  ): ReactNode => {
    const off = !askable && !ticked;
    // `aria-describedby` at a visually-hidden span rather than
    // `aria-description`, which `jsx-a11y/role-supports-aria-props` refuses on
    // a checkbox — the attribute is ARIA 1.3 and the implicit role's property
    // list is 1.2. Observed, not assumed: the `aria-description` spelling was
    // this file's only lint error at a8ad8bd. The described-by spelling has
    // been supported everywhere since forever and reads the same to a screen
    // reader. Id derived from the label the same way `waitsForId` is derived
    // from the row id — the panel renders once, and the two labels differ.
    const hint = `facet-why-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return (
      <label
        className={`flex min-h-6 items-center gap-1.5 ${off ? 'text-muted-foreground' : ''}`}
        title={off ? why : what}
      >
        <input
          type="checkbox"
          aria-label={label}
          aria-describedby={hint}
          checked={ticked}
          disabled={off}
          onChange={() => {
            setFacets(take(!ticked));
          }}
        />
        <span>{label.replace(' only', '')}</span>
        <span id={hint} className="sr-only">
          {off ? why : what}
        </span>
      </label>
    );
  };

  return (
    <details data-facets className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        title="Narrow the plan to the rows carrying these — the table, the chart and the cards together"
      >
        Filters{chosen > 0 ? ` (${String(chosen)})` : ''}
      </summary>
      {/*
        Over the plan rather than in the toolbar's flow: this row already wraps
        at 1245px of controls, and a panel opening inside it would push the
        table down the page every time somebody looked at what was ticked.
      */}
      <div
        data-facet-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        {group('Team', 'team', teams, facets.teamIds, (teamIds) => ({ ...facets, teamIds }))}
        {/*
          Directly under Team, because the two answer the neighbouring questions
          — who does the work, and what kind of thing it is — and a reader
          narrowing by one usually wants the other in view.
        */}
        {group('Tag', 'tag', tags, facets.tagIds, (tagIds) => ({ ...facets, tagIds }))}
        {/*
          The third label dimension, beside the other two and after them: Team,
          Tag and Service are one question asked three ways, and a reader
          narrowing by one wants the others in view. Like both of them it
          disappears when the plan carries no services at all — `group` returns
          nothing for an empty list.
        */}
        {group('Service', 'service', services, facets.serviceIds, (serviceIds) => ({
          ...facets,
          serviceIds,
        }))}
        {group('Assignee', 'assignee', people, facets.assigneeIds, (assigneeIds) => ({
          ...facets,
          assigneeIds,
        }))}
        {group('Priority', 'priority', bands, facets.priorityBands, (priorityBands) => ({
          ...facets,
          priorityBands,
        }))}
        {group('Estimated for', 'phase', phases, facets.estimatedRoleIds, (estimatedRoleIds) => ({
          ...facets,
          estimatedRoleIds,
        }))}
        <fieldset data-facet-group="state" className="mb-2 border-0 p-0">
          <legend className="text-muted-foreground mb-1 text-xs font-semibold">State</legend>
          <label className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              aria-label="Unestimated only"
              checked={facets.unestimated}
              onChange={() => {
                setFacets({ ...facets, unestimated: !facets.unestimated });
              }}
            />
            {/*
              The readiness badge's own count, said as a filter: the same
              `gaps.leaves` the button beside it reports, so the two cannot
              describe two different plans.
            */}
            <span>Unestimated</span>
          </label>
          <label className="flex min-h-6 items-center gap-1.5">
            <input
              type="checkbox"
              aria-label="Critical path only"
              checked={facets.critical}
              onChange={() => {
                setFacets({ ...facets, critical: !facets.critical });
              }}
            />
            <span>On the critical path</span>
          </label>
        </fieldset>
        {/*
          The two mismatch signals, in a group of their own and not in `State`.
          Every box above narrows by something a row *carries*; these two narrow
          by something a row and the **directory** disagree about, which is a
          different question and reads as one.
        */}
        <fieldset data-facet-group="mismatch" className="mb-2 border-0 p-0">
          <legend className="text-muted-foreground mb-1 text-xs font-semibold">Mismatch</legend>
          {signal(
            'Built by non-owner only',
            'Rows whose effective team does not own their effective service.',
            facets.builtByNonOwner,
            ownershipKnown,
            'No team owns a service yet — set that on the team rows in the directory.',
            (builtByNonOwner) => ({ ...facets, builtByNonOwner }),
          )}
          {signal(
            'Assigned outside the team only',
            "Rows whose assignee is not a member of the row's effective team.",
            facets.assignedOutsideTeam,
            membershipKnown,
            'Nobody belongs to a team yet — set that on the people in the directory.',
            (assignedOutsideTeam) => ({ ...facets, assignedOutsideTeam }),
          )}
        </fieldset>
        {/*
          Offered only while there is something to forget, the same bargain
          `Reset layout` makes: a control that provably does nothing reads as a
          broken one. It clears the ticks and not the Find box — Escape in the
          box is how the typed half is left, and one control undoing the other's
          work is how a reader loses a query they were still using.
        */}
        {chosen > 0 && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Untick every filter. The Find box is left as it is."
            onClick={() => {
              setFacets(NO_FACETS);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    </details>
  );
}

/**
 * The words the Columns control uses for the fixed columns a reader may hide —
 * the full word, where the header is abbreviated for width (`Prio`, `Not
 * bef.`) or is a glyph (People at once). Roles are named by the project.
 */
const COLUMN_LABELS: ReadonlyMap<string, string> = new Map([
  ['depends', 'Depends on'],
  ['priority', 'Priority'],
  ['team', 'Teams'],
  ['tag', 'Tags'],
  ['service', 'Services'],
  ['in-parallel', 'People at once'],
  ['final-total', 'Days'],
  ['not-before', 'Not before'],
  ['start', 'Start'],
  ['finish', 'End'],
  ['float', 'Slack'],
]);

/**
 * The Columns control: one tick box per column a reader may hide, and one per
 * role, in the order the table renders them. Ticked is on screen.
 *
 * A `<details>` for the reason {@link FilterFacets} is one — no measurement,
 * no dismiss handler, and it works unchanged inside the phone's `Plan actions`
 * sheet. What it writes is the hide-list {@link rememberedHiddenColumns}
 * reads; the table itself is the one reader of that list, through the
 * `columns` memo, and this control never touches a column definition.
 *
 * Each row is a `<label>` wrapping its box — the shape the phone sheet's 44px
 * floor is written on — with `htmlFor` as well, so a test can read the panel
 * label-by-label off `label[for]`.
 */
function ColumnsControl({
  offered,
  hiddenColumnIds,
  onToggle,
}: {
  offered: readonly { id: string; label: string }[];
  hiddenColumnIds: readonly string[];
  onToggle: (columnId: string) => void;
}) {
  const prefix = useId();
  return (
    <details data-columns className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        title="Choose which columns are on the table. Number, Name and the row's controls always are."
      >
        Columns
      </summary>
      <div
        data-columns-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        {offered.map(({ id, label }) => {
          const boxId = `${prefix}-${id}`;
          // A label **wrapping** its box, as the facet rows are: on a phone the
          // sheet's 44px floor (`styles.css`, `label:has(> input[type='checkbox'])`)
          // is written on exactly that shape, and the row is the tap target.
          // `htmlFor` as well, so the name can be read off `label[for]`.
          return (
            <label key={id} htmlFor={boxId} className="flex min-h-6 items-center gap-1.5">
              <input
                id={boxId}
                type="checkbox"
                checked={!hiddenColumnIds.includes(id)}
                onChange={() => {
                  onToggle(id);
                }}
              />
              <span className="truncate">{label}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

/**
 * Named filters this browser has saved for this project — R10 F4, beside
 * {@link FilterFacets} because naming a filter and ticking one are the same
 * act's two moments.
 *
 * **Narrow, not highlight**, same as the filter itself: picking a saved view
 * writes the Find box and the ticks, exactly as if a reader had typed and
 * ticked it themselves, and {@link narrowTree} is the one thing that reads
 * what a view leaves behind. Nothing here holds a narrowed tree of its own.
 *
 * Save is offered only while something is actually being asked of the plan —
 * the same bargain `Clear filters` makes: a view named for the whole,
 * unfiltered plan has nothing to be picked back to, because opening a project
 * already shows the whole plan.
 */
function SavedViews({
  views,
  current,
  labels,
  onSave,
  onApply,
  onDelete,
}: {
  views: readonly SavedView[];
  current: FilterCriteria;
  labels: FilterLabels;
  onSave: (name: string) => void;
  onApply: (view: SavedView) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const filtering = isFiltering(current);
  const canSave = filtering && name.trim() !== '';
  return (
    <details data-saved-views className="relative">
      <summary
        className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
        title="Name the current filter, or pick one already named"
      >
        Views{views.length > 0 ? ` (${String(views.length)})` : ''}
      </summary>
      <div
        data-saved-views-panel
        className="bg-popover absolute z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border p-3 text-sm shadow-md"
      >
        <div className="mb-2 flex gap-1.5">
          <Input
            className="h-8 flex-1 text-xs"
            aria-label="Name this view"
            placeholder="Name this view…"
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!canSave}
            title={
              filtering
                ? 'Save the Find box and the ticked filters under this name'
                : 'Nothing is filtered — there is no view to name'
            }
            onClick={() => {
              onSave(name.trim());
              setName('');
            }}
          >
            Save
          </Button>
        </div>
        {views.length === 0 ? (
          <p className="text-muted-foreground text-xs">No saved views yet.</p>
        ) : (
          <ul>
            {views.map((view) => {
              // What the view asks of the plan, said the same way the
              // filtered export's `Scope` line says it — one account of a
              // filter, not two that could disagree.
              const words = filterWords(view.criteria, labels);
              return (
                <li key={view.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="min-h-7 flex-1 truncate text-left text-xs underline-offset-2 hover:underline"
                    title={words.length > 0 ? words.join('; ') : view.name}
                    onClick={() => {
                      onApply(view);
                    }}
                  >
                    {view.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="square"
                    type="button"
                    aria-label={`Delete view ${view.name}`}
                    title="Forget this view. What it narrows to is untouched."
                    onClick={() => {
                      onDelete(view.id);
                    }}
                  >
                    <span aria-hidden="true">✕</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

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
  /**
   * The project this render belongs to, readable by work that outlives the
   * render which started it.
   *
   * Updated during render rather than in an effect: a click can land on the
   * newly rendered project before effects run, and stale work must already
   * know it no longer owns this table by then.
   */
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const [workItems, setWorkItems] = useState<TreeRow[]>([]);
  /**
   * Everything the chart is drawn from, as **one** read delivered it.
   *
   * Replaced whole on every refetch, never patched, for the reason the rows
   * are: one edit can move slices of work items this component never touched —
   * a person freed here starts something over there — and guessing which would
   * be a second implementation of the engine.
   *
   * One state and not three, and that is the fix rather than a tidy-up.
   * `layOutGantt` refuses a payload whose slices name a role or a person it has
   * not got, which is exactly what this client held while the slices came from
   * `tree()` and the roles and names came from `roles()` and `listPeople()`:
   * four requests, four moments, and a peer deleting a phase in between left a
   * chart that threw. Held together, they cannot disagree — there is no setter
   * that can move one without the others.
   *
   * The separate reads stay for what they are actually about: {@link roles}
   * heads the estimate columns and the phases dialog edits it, and
   * {@link people} is who the assignee picker can offer.
   */
  const [chartRead, setChartRead] = useState<ChartRead>(NO_CHART_READ);
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
   * How wide this browser has dragged this project's columns, by column id.
   *
   * Beside the expansion and **not** in the `columns` memo, which is the whole
   * of where this state is allowed to live: it reaches the layout through
   * {@link frameState} below, and a column definition that changed with a width
   * would remount every cell in the table (landmine #1).
   *
   * Read straight into the initial state for {@link rememberedExpansion}'s
   * reason: an effect would lay the table out at its defaults and move every
   * column one frame later.
   */
  const [widthOverrides, setWidthOverrides] = useState<Map<string, number>>(() =>
    rememberedWidthOverrides(projectId),
  );
  /** Which project the widths above belong to, so a save cannot pair them with another. */
  const widthProject = useRef(projectId);
  /**
   * The Gantt panel's dragged height, or `null` while this project's panel has
   * never been dragged — which is the bounded default share, not a number.
   *
   * Read straight into the initial state for {@link widthOverrides}'s reason:
   * an effect would open the chart at its default and move it a frame later.
   */
  const [ganttHeightPx, setGanttHeightPx] = useState<number | null>(() =>
    rememberedGanttHeight(projectId),
  );
  /**
   * The day scale in force, and {@link DAY_PX} where this browser has never
   * picked one for this project.
   *
   * A resolved rung rather than `DayPx | null`, which is where it parts from
   * {@link ganttHeightPx} beside it: a height of `null` is a real state — the
   * bounded default share, which is CSS and not a number — while there is no
   * such thing as a chart drawn at no scale. What "never picked" buys is
   * {@link resetLayout}'s answer, and that is `DAY_PX` either way.
   */
  const [ganttDayPx, setGanttDayPx] = useState<DayPx>(
    () => rememberedGanttDayPx(projectId) ?? DAY_PX,
  );
  /**
   * Whether the chart draws its row-name column, and `true` where this browser
   * has never said for this project.
   *
   * Resolved rather than `boolean | null` for {@link ganttDayPx}'s reason:
   * there is no such thing as a chart drawn with the names in neither state,
   * and what "never said" buys is {@link resetLayout}'s answer, which is `true`
   * either way.
   */
  const [ganttLabelsShown, setGanttLabelsShown] = useState<boolean>(
    () => rememberedGanttLabels(projectId) ?? true,
  );
  /**
   * Swaps the widths and the panel height whole when the project does.
   *
   * Not the expansion's effect, and not paired with a save: nothing is written
   * here at all. Both are written when a drag is let go of and when the
   * reset is pressed, so there is no first-save-after-a-switch to guard against
   * — only the read, which would otherwise leave one project's layout laid out
   * over another's.
   */
  useEffect(() => {
    if (widthProject.current === projectId) return;
    widthProject.current = projectId;
    setWidthOverrides(rememberedWidthOverrides(projectId));
    setStoredHiddenColumns(rememberedHiddenColumns(projectId));
    setGanttHeightPx(rememberedGanttHeight(projectId));
    setGanttDayPx(rememberedGanttDayPx(projectId) ?? DAY_PX);
    setGanttLabelsShown(rememberedGanttLabels(projectId) ?? true);
  }, [projectId]);
  /**
   * What has been typed into the Find box.
   *
   * The narrowing itself is not state: it is {@link narrowTree} of the rows on
   * screen and this string, re-derived every render. A remembered answer would
   * narrow to a plan that no longer exists — every edit by anybody refetches
   * the whole tree.
   */
  const [query, setQuery] = useState('');
  /**
   * Which facets are ticked beside the Find box — the other six of R10's seven
   * fields.
   *
   * `useState` and nothing else, deliberately: **an ad-hoc filter is not
   * remembered across a reload** (R10 §9's Q6, Dany 2026-08-17). The plan you
   * open is the whole plan; a filter restored from a session you do not
   * remember setting is the "my rows are gone" report, and it is the single
   * most likely support question this change could create. Named, deliberate
   * criteria you come back to are saved views — F4, and the opposite gesture.
   *
   * Not the URL either: which project is open lives in localStorage
   * (`project-page.tsx`) and `/` names none of it, so there is nothing here a
   * link could carry to somebody else yet.
   */
  const [facets, setFacets] = useState<Omit<FilterCriteria, 'query'>>(NO_FACETS);
  /**
   * The filters this browser has named and saved for this project — F4, and
   * the deliberate opposite of {@link facets} beside it: this **is**
   * remembered across a reload, because naming one and picking it back up is
   * a deliberate act and not a restored session nobody asked for.
   *
   * Read straight into the initial state for {@link rememberedExpansion}'s
   * reason: an effect would open the panel with nothing in it for one frame.
   */
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => rememberedSavedViews(projectId));
  /** Which project the saved views above belong to, so a save cannot pair it with another. */
  const savedViewsProject = useRef(projectId);
  /**
   * Swaps the saved views whole when the project does.
   *
   * Nothing is written here, for {@link widthProject}'s effect's reason: Save
   * and Delete are the only writers, so there is no first-save-after-a-switch
   * to guard against — only the read, which would otherwise offer one
   * project's views on another's plan.
   */
  useEffect(() => {
    if (savedViewsProject.current === projectId) return;
    savedViewsProject.current = projectId;
    setSavedViews(rememberedSavedViews(projectId));
  }, [projectId]);
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
   * The one cell whose hover card is open, as a {@link cellKey}, or null.
   *
   * One state for every surface that opens a card — the Name cell's notes
   * marker, a folded role's figure, the depends chips — rather than one state
   * each, and that is what makes "one card at a time" true by construction
   * rather than by three pieces of code remembering to close each other.
   *
   * Keyed by cell rather than by row because a row has several of them, and by
   * the `rowId::columnId` the keyboard grid already names cells with, so this
   * file holds one spelling of "which cell".
   *
   * Read through {@link live} inside `columns`, never closed over: `columns`
   * depends on `roles` alone, and a dependency that changed on every mouse
   * move would remount every cell in the table as the pointer crossed it.
   */
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  /**
   * The one cell whose card is open because it has the **focus**, as a
   * {@link cellKey}, or null.
   *
   * A second state rather than a second writer of {@link hoveredCell}, and round
   * 4's finding 9 is why. The two are set and cleared by gestures that do not
   * take turns: a pointer wandering across any other cardable cell and off it
   * again ran the hover's guarded clear, and the still-focused cell was left
   * with no card and no reason to fire a focus event ever again — a description
   * that vanishes because a mouse went past.
   *
   * Not settled against a refreshed tree the way `hoveredCell` is, deliberately:
   * a card that belongs to the focus should follow the focus, and the browser
   * moves that with its element whatever the tree did. A row deleted while its
   * box was focused leaves a key here that no rendered cell can ever match
   * again, which shows nothing and is replaced by the next focus.
   */
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  /**
   * The one cell whose card is on screen: the pointer's while it is on
   * something, and the focus's when it is not.
   *
   * Derived rather than stored, which is what keeps "one card at a time" true by
   * construction now that two gestures can open one. The pointer wins because it
   * is the deliberate act of the moment — a reader who moves the mouse onto a
   * cell is asking about that cell — and the focus is still where they left it
   * when they move away again.
   */
  const openCard = hoveredCell ?? focusedCell;
  /**
   * Where every row sat as of the last tree read, by {@link placementsOf}.
   *
   * A ref because nothing renders it: it exists so the next read can be asked
   * whether the hovered row is still where the open card was drawn.
   */
  const rowPlacements = useRef<ReadonlyMap<string, string>>(new Map());
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
   * **A set, and any number of them.** It was an accordion until
   * `unfolding-may-scroll` — unfolding a role folded whichever was open —
   * because a folded role costs 96px and an unfolded one 348, and one open
   * role already needs more width than a 1280 laptop has. That arithmetic is
   * unchanged and it is not what the rule was worth: a reader comparing two
   * phases' three points had to hold one of them in their head, and a table
   * that reshuffles itself when you open something reads as a bug whatever it
   * is protecting.
   *
   * **Horizontal scrolling is the accepted cost, and only here.** Dany's call,
   * 2026-08-08 (U3): with anything unfolded the frame MAY scroll sideways, and
   * the pinned handle, number and name are what make that readable. Folded,
   * the no-scroll guarantee is exactly what it was — that is the state a plan
   * is read in, and `e2e/layout.spec.ts` still holds it at every laptop width
   * in the matrix.
   *
   * A list rather than a `Set` because it is what the column builder asks
   * (`unfoldedRoles.includes(role.id)`) and what the `columns` memo may depend
   * on. Local state, not shared: my unfolding must not reshuffle anyone else's
   * table.
   */
  const [unfoldedRoles, setUnfoldedRoles] = useState<readonly string[]>([]);

  /**
   * The hide-list as this browser remembers it for this project, whole — see
   * {@link rememberedHiddenColumns} for why it is not judged on read.
   */
  const [storedHiddenColumns, setStoredHiddenColumns] = useState<readonly string[]>(() =>
    rememberedHiddenColumns(projectId),
  );

  /**
   * The columns this reader has hidden **and this table could show**: the
   * stored list less any id that is neither a hideable column nor one of this
   * project's roles. A typo in storage, or a role since deleted, hides nothing
   * and is never handed to `foldedTableMinWidth`, which throws on it by design.
   *
   * A memo on the two things it reads, so its identity moves only when one of
   * them does — it is a `columns` dependency, and every change of identity
   * there remounts every cell.
   */
  const hiddenColumnIds = useMemo(() => {
    const hideable = hideableColumnIds(roles.map((role) => role.id));
    return storedHiddenColumns.filter((id) => hideable.includes(id));
  }, [roles, storedHiddenColumns]);

  /**
   * What the Columns control offers: every hideable column with the word the
   * reader knows it by. A hideable id with no word is a column added to
   * `table-frame.ts` and not here — thrown, not skipped, or the column would be
   * one nobody can hide back.
   */
  const offeredColumns = useMemo(
    () =>
      hideableColumnIds(roles.map((role) => role.id)).map((id) => {
        const label = COLUMN_LABELS.get(id) ?? roles.find((role) => role.id === id)?.name;
        if (label === undefined) throw new Error(`no label for hideable column "${id}"`);
        return { id, label };
      }),
    [roles],
  );

  /**
   * Hides a shown column, or shows a hidden one — and writes the list, which is
   * the one moment it is written (see {@link rememberedHiddenColumns}). Written
   * from the sanitised list rather than the stored one, as a drag writes the
   * widths in force: an id for a role this project no longer holds is dropped
   * the first time the reader touches the control.
   */
  function toggleColumn(columnId: string): void {
    const next = hiddenColumnIds.includes(columnId)
      ? hiddenColumnIds.filter((hidden) => hidden !== columnId)
      : [...hiddenColumnIds, columnId];
    setStoredHiddenColumns(next);
    rememberHiddenColumns(projectId, next);
  }

  /**
   * Unfolds a role, or folds it again — and leaves every other role alone.
   *
   * The one writer, which is why the rule it keeps is stated on the state
   * above rather than here. It was `current.includes(roleId) ? [] : [roleId]`
   * until `unfolding-may-scroll`: the second arm is what made this an
   * accordion, and the first folded the open one whichever role was clicked.
   *
   * Proof: written as `current.includes(roleId) ? [] : [roleId]` again,
   * `unfolds each role on its own, and leaves the others open` failed on
   * `Unable to find a label with the text of: Dev optimistic for 010`, with
   * `walks both open roles in turn, and the grid arrows cross between them`
   * beside it and — in Chromium — `opens every role at once, scrolls the frame
   * for it, and holds the pinned block` on the same missing box. Watched on
   * h2puni, 2026-08-12 (fault 1).
   */
  const toggleRole = useCallback((roleId: string) => {
    setUnfoldedRoles((current) =>
      current.includes(roleId) ? current.filter((each) => each !== roleId) : [...current, roleId],
    );
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
  /** The global tag vocabulary, for the facet's labels and the cell's picker. */
  const [tags, setTags] = useState<TagView[]>([]);
  /**
   * The global service vocabulary, for the third dimension's facet labels and —
   * from task 7.1 — its cell picker.
   *
   * Beside the tags and loaded on the same read for the same reason: a facet
   * that offers ids instead of names is a filter nobody can aim.
   */
  const [services, setServices] = useState<ServiceView[]>([]);
  /**
   * How many of each team this plan may have at work at once, as be-01 sent it
   * with the tree.
   *
   * Off the tree read and not a request of its own: the dates on screen were
   * computed from these numbers, and a separately-fetched capacity could put a
   * number beside bars it does not explain. `wbs-api.ts` has the argument.
   */
  const [teamCapacities, setTeamCapacities] = useState<TeamCapacityView[]>([]);
  /**
   * What this plan calls its priority numbers — five rungs, most important first.
   *
   * Off the tree read for {@link teamCapacities}' reason and one of its own: no
   * date here was computed from the ladder, but every face draws every priority
   * through it, so a ladder fetched at a second moment would paint the wrong
   * label on every row rather than on one. `DEFAULT_PRIORITY_BANDS` is be-01's
   * answer for a plan nobody has configured, so this is empty only before the
   * first read has landed — which is the same moment the rows are empty.
   */
  const [priorityBands, setPriorityBands] = useState<PriorityBandView[]>([]);
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
   * The dependency hover: whose Depends on cell the pointer is in, and which
   * of its pills it is on — `pillId: null` while it is on the cell's input
   * area rather than on a pill.
   *
   * Two fields rather than a list of ids to light (codex 10 on the U4 plan):
   * a single list cannot distinguish "the cell" from "the cell's only pill",
   * and the card's emphasis needs exactly that distinction. The lit set is
   * derived per render — see {@link WbsTable}'s `depLit` — all of the row's
   * dependencies while `pillId` is null, the one pill's row otherwise.
   *
   * Read through {@link live} inside `columns`, for the reason `hoveredCell`
   * is: a hover **re-renders** the table, which is how React works and is
   * cheap here, but a `columns` that depended on it would **remount** every
   * cell on the first hover and take the focus with it. The writers below
   * bail out (return the current object) when the value is already there, so
   * a pointer resting on one pill costs one render, not one per mousemove.
   */
  const [depHover, setDepHover] = useState<{ rowId: string; pillId: string | null } | null>(null);
  /**
   * The same reading of the same cell, from the **keyboard**: whose Depends on
   * cell holds the focus, and which of its pills has it.
   *
   * The light is the change's one visual answer to "what does this row wait
   * for", and a hover-only answer is no answer to somebody who never touches a
   * mouse. Focus is the keyboard's pointer, so it drives the same light through
   * the same derivation ({@link WbsTable}'s `depLit` reads `depHover ??
   * depFocus`) — the pointer's reading wins while both are live, because the
   * pointer is where the eyes are.
   *
   * A second state rather than more writers on `depHover`, and that is the
   * whole of why: focus and the pointer come and go independently, so one field
   * would have a blur clearing a live hover and a mouseleave clearing a live
   * focus. Two fields cannot interfere, and "the pointer wins" is then one
   * `??` rather than a rule spread over four writers.
   *
   * **Sequential Tab reaches the box and not the chips.** `deps-single-line`
   * holds a clipped chip out of the tab order on purpose — see the chips'
   * `tabIndex` below — so the per-pill narrowing is reachable from focus
   * wherever focus can land on a chip at all, and the cell-level light is what
   * a Tab through the plan gets. That narrowing is stated in the change's spec
   * rather than left to be discovered here.
   */
  const [depFocus, setDepFocus] = useState<{ rowId: string; pillId: string | null } | null>(null);
  /**
   * The **pointed row**, in three states — one per place the answer can come
   * from — and the rule that each face lights the **other** face's.
   *
   * The plan is drawn twice and until these the two drawings said nothing about
   * each other: which of sixty rows a bar was *for* was a question a reader
   * answered by counting rows in a 176px label column. `linked-scroll` fixed
   * the coarse half — the two faces start on the same row — and this is the
   * per-row half.
   *
   * **Why three and not one.** `tablePointedRow` is the pointer on a row here;
   * the two `chart*` fields are the Gantt panel's reports. They stay apart
   * because the light has to go to the face the pointer is *not* on:
   *
   * - The `<tr>` lights from {@link pointedFromChart} alone. A row the pointer
   *   is already resting on is a row `tr:hover` is already tinting, and a
   *   second tint there both says nothing new and **breaks** the banded-hover
   *   contract: `data-row-lit` on every hovered row makes
   *   `tr:not([data-row-lit])…:nth-child(even):hover` unmatchable, and the
   *   stripe stops moving under the pointer at all. Watched — four of
   *   `e2e/hover-cards.spec.ts`'s assertions failed on it, 2026-08-14.
   * - The panel lights from {@link pointedAt}, which is either face's answer,
   *   because the chart has no hover of its own on the row it is asked about.
   *
   * The chart's pointer and focus are two fields for {@link depHover} /
   * {@link depFocus}'s reason: they come and go independently, so one field
   * would have a bar's blur clearing a light the pointer is holding. The
   * pointer wins while both are live, because the pointer is where the eyes
   * are. Bars are controls (`role="button"`, `tabIndex={0}`), so the focus half
   * is what a reader who never touches a mouse gets — the argument
   * `dep-hover-highlights` shipped `depFocus` on.
   *
   * All three are read on the `<tr>` and passed to the panel, and **never**
   * inside `columns`: that memo depends on `roles` and `unfoldedRoles` and
   * nothing else, and a dep added here would hand every cell a new component
   * type on the first hover and remount the lot, taking the focus and any
   * half-typed value with it (LLM_README landmine #1).
   *
   * Proof: `chartPointedRow` added to the `columns` memo's dependency list, and
   * `points a row without remounting the cells under a half-typed name` failed
   * on `expected <textarea …(5)></textarea> to be <textarea …(5)></textarea>` —
   * the same-labelled box a different node, the cell remounted under the
   * typist. Watched 2026-08-14.
   */
  const [tablePointedRow, setTablePointedRow] = useState<string | null>(null);
  const [chartPointedRow, setChartPointedRow] = useState<string | null>(null);
  const [chartFocusedRow, setChartFocusedRow] = useState<string | null>(null);
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
   * Where a structural edit has asked the focus to go once its refetch lands.
   *
   * A ref holding one object for the life of the component, so the two things
   * that read it — the effect below and the Name cell's `onAttach` — are
   * talking about the same intent whichever render they were built in.
   */
  const focusIntent = useRef(new FocusIntent());
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
  /**
   * The rendered grid, so the focus can be found in the DOM that is committed.
   *
   * An `HTMLElement` rather than an `HTMLTableElement` since `M mobile-cards`:
   * it holds the `<table>` at laptop width and {@link PlanCards}' list below the
   * breakpoint. {@link editableGrid} and the rest of `editable-grid.ts` only ever
   * ask it for `[data-cell]` descendants, so neither of them knows the
   * difference.
   */
  const gridElement = useRef<HTMLElement | null>(null);
  /**
   * Which of the two renderers is drawing the plan, and whether the toolbar is
   * open as a sheet under the cards.
   *
   * The sheet is closed on every renderer change rather than only on the way
   * out: a window dragged wide with the sheet open would otherwise leave a
   * modal over a table that has the toolbar in a row of its own.
   */
  const renderer = useRendererForViewport();
  const [toolbarSheetOpen, setToolbarSheetOpen] = useState(false);
  /**
   * Whether the control that closed the sheet aims the caret itself — the
   * {@link TAKES_THE_FOCUS} mark, read off the control that was clicked.
   *
   * False for every other way out, and that includes the rest of the toolbar:
   * Escape, the ✕, a tap outside, and `Collapse all`, `Gantt`, `Undo` and the
   * exports, none of which ask for the focus anywhere. Only the three that do
   * may refuse Radix's restore, because refusing it for the others drops the
   * focus on `<body>` — nothing to type into and nothing to Tab from.
   *
   * A ref because nothing renders it, and because it is read from Radix's own
   * close handler one turn of the event loop after the click that set it.
   */
  const sheetControlTakesTheFocus = useRef(false);
  useEffect(() => {
    setToolbarSheetOpen(false);
  }, [renderer]);
  /**
   * Whether the Gantt panel is under the plan.
   *
   * Off to begin with, and not remembered anywhere: the plan is the editor and
   * the chart is a second thing to look at, so a reader who opened it once on
   * one project has not asked for it on every project they open afterwards.
   */
  const [ganttOpen, setGanttOpen] = useState(false);

  /**
   * The frame the table scrolls inside, so the chart under it can be held on
   * the row the table is showing.
   *
   * The only thing this ref is for. Every other reader of the frame finds it by
   * `[data-table-frame]`, and so does the browser gate.
   */
  const frameRef = useRef<HTMLDivElement | null>(null);
  /**
   * Holds the plan's two faces on one row while both are on screen.
   *
   * Installed from here rather than from either face, because neither face owns
   * the other and this component owns both. The panel is found by the attribute
   * the gate already knows it by rather than by a ref threaded through
   * `GanttFaultBoundary` — the boundary may have unmounted the panel by the
   * time this runs, which is a state the query answers `null` for and a ref
   * would answer `null` for too, at the cost of a prop on a component this
   * change otherwise does not touch.
   *
   * `generation` is a dependency for that boundary: a chart that faulted and
   * was reset is a new panel element, and a link left holding the old one would
   * listen to a node nothing scrolls. The renderer is one because the outline
   * cards have no frame to link — `frameRef` is `null` under them, and the
   * effect re-runs to say so when a rotation swaps the renderer.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || !ganttOpen) return;
    const panel = document.querySelector<HTMLElement>('[data-gantt-panel]');
    if (panel === null) return;
    // A panel is not always a chart. A plan whose dependencies run in a circle
    // draws the sentence about it under this same attribute
    // (`gantt-panel.tsx`), and that section has no calendar axis and no rows to
    // pair — `panelFace` refuses an element it cannot measure, and it would do
    // it inside a scroll listener, where no boundary of ours is: every scroll
    // of the frame would throw for as long as the circle stood. Found in
    // cross-review, 2026-08-12; `wbs-table.test.tsx` holds it.
    //
    // Read off the axis rather than off `scheduleError` because the axis is
    // exactly what the link needs — a panel that is a message of any other kind
    // is as unusable, and would not have to be remembered here. The dependency
    // list already covers the swap: `scheduleError` is set on the same read as
    // `chartRead` below, so a read that lands or clears a circle brings a new
    // `generation` with it.
    if (panel.querySelector('[data-gantt-axis]') === null) return;
    return linkPlanScroll(frame, panel);
  }, [ganttOpen, renderer, chartRead.generation]);

  const latestRefresh = useRef(0);
  /**
   * The live subscription, so a refresh can tell it where the read landed.
   *
   * A ref rather than state: reporting the sequence must not re-render, and the
   * stream outlives every render between subscribe and unsubscribe.
   */
  const stream = useRef<ProjectStream | null>(null);

  /**
   * Settles this browser's own state against the phases be-01 just reported.
   *
   * A phase that goes takes two things with it that are nobody's but this
   * client's, and be-01 can clean up neither:
   *
   * - the **estimate drafts**, keyed `rowId::roleId::point`. A half-typed trio
   *   for a phase that has gone is a figure nobody can see, reach or finish,
   *   and it goes on counting as content — an otherwise empty row it belongs to
   *   can never be removed by Backspace again.
   * - the **held refusals**, keyed by cell, whose columns no longer exist —
   *   text nobody can ever resolve, held for the life of the page.
   *
   * `unfoldedRoles` is deliberately **not** settled here, and that is a finding
   * rather than an omission. The plan asked for it (agy #7) on the reading that
   * the set could hold a dead id; it can, and nothing can observe it,
   * because `columns` is built by mapping over `roles` and a dead id selects no
   * role to unfold. The sanitizer was written, its negative test watched
   * **passing** with the line deleted, and the line removed —
   * `openspec/changes/phases-ui/verify.md` has the run.
   *
   * The drafts sanitizer returns the object it was given when nothing changed.
   * `drafts` is not one of `columns`' dependencies, so this is about not
   * re-rendering every cell rather than about remounting them — but the rule is
   * the same one `sameRoles` keeps one line above, and stating it twice is
   * cheaper than the two of them drifting.
   *
   * A phase change **does** cost the focus, and that is the accepted trade: the
   * columns really are different, the cells really are new elements, and the
   * person sees the caret leave the box at the moment the table changes shape.
   * What must not go with it is a draft be-01 refused, which is why the hold is
   * outside `CellInput` — see {@link refusedDrafts}.
   */
  const settleAgainstRoles = useCallback((live: readonly RoleView[]) => {
    const liveIds = new Set(live.map((role) => role.id));
    // Proof: this whole block deleted, `drops a half-typed figure for a phase
    // that has gone` failed on `expected [ '010' ] to deeply equal []` — an
    // empty row nobody could remove, vetoed by a figure typed for a phase that
    // was no longer there. Watched, 2026-08-09.
    setDrafts((current) => {
      const gone = new Set(
        Object.keys(current).filter((key) => {
          const roleId = roleOfDraftKey(key);
          return roleId !== null && !liveIds.has(roleId);
        }),
      );
      return gone.size === 0 ? current : dropDrafts(current, gone);
    });
    // Proof: this call deleted, `forgets a refusal held for a phase that has
    // gone` failed on `expected '9' to be undefined`. Watched, 2026-08-09.
    forgetRefusedDrafts((cellKey) => {
      const roleId = roleOfCellKey(cellKey);
      return roleId !== null && !liveIds.has(roleId);
    });
  }, []);

  const refresh = useCallback(async () => {
    // An action from the project shown before the latest render can finish
    // afterwards. It may finish its server request, but it no longer gets a
    // read generation or a write into this project's screen.
    if (projectId !== activeProject.current) return;
    // Every mutation and every socket event starts a refresh, and they can
    // finish out of order — an earlier one landing last would replace the table
    // with a tree older than what is on screen, with nothing guaranteed to
    // arrive afterwards and repair it. Only the newest request may write.
    const generation = latestRefresh.current + 1;
    latestRefresh.current = generation;
    const [tree, loadedRoles, loadedTeams, loadedTags, loadedServices, loadedPeople] =
      await Promise.all([
        api.tree(projectId),
        api.roles(projectId),
        api.listTeams(),
        // Beside the teams rather than behind them: both are global lists the
        // pickers need before a reader can tick anything, and a second round trip
        // would put the tag facet a frame behind the team one.
        api.listTags(),
        // And the third dimension in the same breath, for that reason a third
        // time: the service facet names its options out of this list.
        api.listServices(),
        api.listPeople(),
      ]);
    if (projectId !== activeProject.current) return;
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
    setTags(loadedTags);
    setServices(loadedServices);
    setPeople(loadedPeople);
    const drawn = toTree(tree.workItems);
    setWorkItems(drawn);
    // The open hover card, settled against the rows that just arrived. The
    // previous placements are read into a local **before** the ref is replaced:
    // React may run the updater below after this call returns, and reading the
    // ref from inside it would compare the new tree against itself and never
    // close anything.
    // Proof: this pair deleted, `closes the card when a peer moves the row it
    // is anchored to` failed on `expected <div role="tooltip" …/> to be null`.
    // Watched, 2026-08-09.
    const placements = placementsOf(drawn);
    const wasPlaced = rowPlacements.current;
    rowPlacements.current = placements;
    setHoveredCell((open) => hoveredCellAfterRefresh(open, wasPlaced, placements));
    // On the same read as the rows and behind the same generation check: a
    // superseded read must not leave its slices under another read's rows.
    // Proof: written as `setSlices((current) => current.length === 0 ?
    // tree.slices : current)` — the refetch leaving the slices where the first
    // read put them — and `replaces the slices on every refetch, as it replaces
    // the rows` failed on `expected '2' to be '1'`: a second row on screen with
    // the one-row plan's slices still behind it; watched 2026-08-09.
    //
    // One call, so the chart's three parts can only ever be one payload's. The
    // roles and the names come from `tree` and **not** from `loadedRoles` or
    // `loadedPeople` below: those are three more requests, and a peer's phase
    // delete landing between them is what used to hand `layOutGantt` a slice
    // under a role the plan no longer listed.
    setChartRead({
      slices: tree.slices,
      roles: tree.roles,
      people: tree.assignedPeople,
      generation,
    });
    setStack({ undoable: tree.undoable, redoable: tree.redoable });
    setTeamCapacities(tree.teamCapacities);
    setPriorityBands(tree.priorityBands);
    setScheduleError(tree.scheduleError);
    setEstimateMethod(tree.estimateMethod);
    setStartDate(tree.startDate);
    // Replaced only when the roles actually differ. Every read returns a fresh
    // array, and `roles` is the one dependency `columns` still has — so a new
    // array on every refresh rebuilt every column definition, which is how a
    // stranger's edit used to take the focus of whoever was mid-word.
    setRoles((current) => (sameRoles(current, loadedRoles) ? current : loadedRoles));
    settleAgainstRoles(loadedRoles);
    // Reported after the generation check, so a superseded read cannot move the
    // resume point to a moment whose rows were thrown away.
    stream.current?.seen(tree.seq);
  }, [api, projectId, settleAgainstRoles]);

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
      //
      // Not `refusalSentence`: nothing was refused. This is the first read of
      // the plan failing — a network word, not a verdict on a change somebody
      // asked for — and "That change could not be completed" would name a
      // change nobody made.
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

  // The whole of what this does, and every reason it is shaped this way, is
  // {@link FocusIntent.land}. It fires on the tree because that is the render
  // that can have brought the row the intent names into the DOM.
  useEffect(() => {
    focusIntent.current.land(gridElement.current);
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
   * there is nothing new to read. **One refusal is the exception.**
   * {@link GONE} says the row this client acted on is not there any more, which
   * is a fact about the tree on screen rather than about the request — without
   * the reread the toast says a row is gone while the row stays on screen,
   * which is the worst of both.
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
      const issuedFor = projectId;
      // Read here, synchronously, because this is the moment the gesture
      // happened. The intent compares it against where the focus is when the
      // refetch lands, and everything between the two is the window in which
      // the reader may have gone somewhere else.
      focusIntent.current.commandIssued();
      setBusy(true);
      try {
        try {
          await action();
        } catch (thrown: unknown) {
          // A refusal from a project the reader has left is not a refusal of
          // anything on the screen now. The old burst stops without putting
          // its toast or refetch into the next project.
          if (activeProject.current !== issuedFor) return 'refused';
          // Proof, two faults, both watched 2026-08-09. `refusalSentence`
          // replaced by `failureText`, `says a row that has gone is gone, and
          // rereads the tree that proves it` failed on `expected [ 'not_found' ]
          // to include 'That change could not be completed: …'`. The reread
          // below dropped, the same test failed on `expected [ '010', '020',
          // '030' ] to deeply equal [ '010', '020' ]`.
          pushToast({ kind: 'error', text: refusalSentence(thrown) });
          // Two refusals say the screen is behind rather than that the request
          // was wrong: {@link GONE}, and a body be-01 could not read. The
          // second is the sentence's own claim — {@link INVALID_REFUSAL} says
          // the plan was read again, and a sentence that says so without doing
          // it is the worst of both.
          const refusal = failureText(thrown, '');
          if (refusal === GONE || INVALID_REQUEST.has(refusal)) await refreshOrMarkStale();
          return 'refused';
        }
        if (activeProject.current === issuedFor) await refreshOrMarkStale();
        return 'landed';
      } finally {
        // The next project's write owns its busy state. An older completion
        // cannot clear the affordance while that write is still in flight.
        if (activeProject.current === issuedFor) setBusy(false);
      }
    },
    [projectId, pushToast, refreshOrMarkStale],
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
          // The same register as `run`: be-01's two *modeled* refusals are read
          // out of the 409 below and get their own sentences; anything else is
          // a code, and a code is not a sentence.
          pushToast({ kind: 'error', text: refusalSentence(thrown) });
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
            text: `${direction === 'undo' ? 'That could not be undone' : 'That could not be put back'}: ${outcome.detail ?? 'the plan has changed since then.'}`,
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
   * **The toast belongs to this effect**, which is the whole of the second
   * change here. It used to be pushed from `armOrDeleteRow` and never taken
   * off, so "Ctrl+D again deletes 020" outlived every one of the ways above —
   * and the delete itself — for the five seconds an info toast lasts. Pushing
   * it where the arm begins and dismissing it in the cleanup ties the sentence
   * to the state that makes it true, re-arms included: a fresh arm is a fresh
   * object, so the cleanup takes the old sentence off before the new one goes
   * up.
   *
   * Proof, two faults. This effect's listeners removed: `leaving the cell
   * disarms it, however the focus went` failed with the row still tinted —
   * watched 2026-08-08. The `dismissToast` below dropped: `the arm toast
   * leaves with the arm, however the arm ends`, `the arm toast leaves when the
   * delete it promised happens` and `a peer renumbering the armed row disarms
   * it` all failed on `expected [ … ] to not include 'Ctrl+D again deletes 020
   * — its children move up'` — watched 2026-08-09.
   */
  useEffect(() => {
    if (armedDelete === null) return undefined;
    const promise: Toast = {
      // `info`: it is context with a way out of it, not a failure waiting to be
      // dismissed — and it takes itself off if the reader walks away.
      kind: 'info',
      text: `Ctrl+D again deletes ${armedDelete.number} — its children move up`,
    };
    pushToast(promise);
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
      dismissToast(toastKey(promise));
      clearTimeout(expiry);
      window.removeEventListener('focusout', disarm);
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [armedDelete, pushToast, dismissToast]);

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
   * Every work item in the plan, named the way a dependency names one.
   *
   * **`flat` and not `shownRows`**, and that is the whole of this lookup: a
   * collapsed branch and a search each hide rows a dependency may point at, and
   * a bar saying it waits for something it cannot name is a bar saying nothing.
   * The chart draws what is on screen; what it *says* is drawn from the tree.
   *
   * `<number> <name>` is how the plan names a predecessor out loud — the same
   * words the Depends on chips carry. An unnamed row keeps the number it does
   * have, which is why the empty name has words rather than a trailing space.
   */
  const namedInTheTree = new Map(
    flat.map((row) => [row.id, `${row.number} ${row.name === '' ? '(unnamed)' : row.name}`]),
  );

  /**
   * The service team a work item is labelled with, resolved against the
   * directory read this client holds.
   *
   * The two are different moments — the label comes with the tree and the teams
   * from their own request — so a team created between them is a **stale**
   * lookup and says so, rather than rendering a blank label or throwing the
   * chart away. See {@link ServiceTeamLabel}.
   */
  const teamLabelOf = (serviceTeamId: string | null): ServiceTeamLabel => {
    if (serviceTeamId === null) return { state: 'none' };
    const named = teams.find((team) => team.id === serviceTeamId);
    return named === undefined ? { state: 'unresolved' } : { state: 'named', name: named.name };
  };

  /**
   * Which team's work each row is, the leaf's own label or the nearest
   * ancestor's — `libs/domain`'s reading, not a second copy of it.
   *
   * The rule be-01's scheduler pools on: a leaf whose own set is empty draws
   * its slots from the team an ancestor named, so a bar can be held by a pool
   * the row it sits on never mentions. Five surfaces read this one function —
   * the scheduler's adapter, this table's Team cell, the chart, the cards and
   * the export — because five copies of "most specific wins" is five chances
   * for two of them to disagree about the same row while each holds a
   * defensible answer.
   *
   * Over `flat` and not `shownRows`: an ancestor a search or a collapse has
   * taken off screen still labels the work under it.
   *
   * Memoised on the tree since R10: it is one of the seven facts the filter
   * narrows on, so a fresh `Map` on every render would rebuild the narrowed
   * tree on every keystroke in any cell of the table, not only on a change to
   * the filter.
   */
  const effectiveTeams = useMemo(() => effectiveTeamsOf(flat), [flat]);
  /**
   * The other dimension's reading, computed the same way and over the same
   * rows — one walk each, memoised, never a second copy per surface.
   */
  const effectiveTags = useMemo(() => effectiveTagsOf(flat), [flat]);
  /**
   * The third dimension's reading — one walk, memoised, over the same rows, and
   * handed the rows themselves since task 10.2.
   *
   * The `.map` that stood here folded the row's nullable column into a set of
   * nought or one, and it was the line this task named as the one to delete:
   * `WorkItemView` carries `serviceIds` now, so a row delivering two services
   * arrives as two and the walk sees what the store holds. Nothing converts at
   * this edge any more, which is why there is no third `useMemo` shape here —
   * the three dimensions read identically.
   */
  const effectiveServices = useMemo(() => effectiveServicesOf(flat), [flat]);
  /**
   * Which services each team is responsible for, from the directory's ownership
   * map — the shape `builtByNonOwner` asks for, built once instead of per row.
   *
   * A team absent from this map owns nothing, which is the map's own rule: the
   * directory ships with no ownership filled in, and every team is absent until
   * somebody says otherwise.
   *
   * **The one place `TeamView.serviceIds` may be `undefined`.** A be-01 that has
   * never heard of services sends teams without the field, which is a real
   * state for the length of a blue/green deploy; folded to `[]` here so no
   * reader below has to hold the distinction, exactly as `toTree` folds
   * `WorkItemView.serviceIds`. Everything downstream reads a list.
   */
  const ownedServicesByTeam = useMemo(
    () => new Map(teams.map((team) => [team.id, team.serviceIds ?? []])),
    [teams],
  );
  /**
   * Which teams each person belongs to — the directory's existing `person_team`
   * membership, read and never written.
   *
   * The **directory's** `people` and not `chartRead.people`, which is the one
   * place this signal may not follow the facets beside it: `AssignedPersonView`
   * is an id and a name, and only `PersonView` carries the membership. Sourced
   * from the plan's assigned people instead, every assignee would belong to no
   * team and every labelled row would wear the marker.
   *
   * Somebody the directory read has not caught up with is absent, and absent is
   * "belongs to no team" — which flags them. That is the honest answer while the
   * directory says nothing about them, and it is the same reading
   * `ownedServicesByTeam` takes above.
   */
  const teamsByPerson = useMemo(
    () => new Map(people.map((person) => [person.id, person.teamIds])),
    [people],
  );
  /**
   * Whether the directory has been told **anything** about who owns what, and
   * about who belongs where — one bit each, off the two maps above.
   *
   * These decide whether the mismatch facets can be asked at all, and the
   * reason is the opposite of the one it looks like. An empty map does not make
   * a signal quiet: `builtByNonOwner` asks whether one of the row's teams owns
   * the service, so with nobody owning anything **every** row carrying both
   * labels is flagged, and the same holds for membership. Watched, chunk 9 —
   * emptying the map under a ticked facet leaves four of six rows on screen,
   * not none. So the box is stood down not to hide a false negative but to
   * refuse a question whose only honest answer is "nobody has said who owns
   * what" — see {@link FilterFacets} for what the panel does with that.
   *
   * `some` over a non-empty list and not `size > 0`: every team is in
   * `ownedServicesByTeam` and every person in `teamsByPerson`, each with a
   * possibly-empty list, so the map having entries says only that the directory
   * has teams.
   */
  const ownershipKnown = useMemo(
    () => [...ownedServicesByTeam.values()].some((owned) => owned.length > 0),
    [ownedServicesByTeam],
  );
  const membershipKnown = useMemo(
    () => [...teamsByPerson.values()].some((memberOf) => memberOf.length > 0),
    [teamsByPerson],
  );

  /**
   * **Which** services and **which** people each row's two signals are about —
   * not merely whether they fire.
   *
   * One memo, read by the filter facets *and* by the two markers, because the
   * facets' own note says it: recomputing a signal per surface is how a filter
   * and the marker beside it start to answer two different questions about one
   * row. The booleans in {@link narrowable} are now `length > 0` over these
   * lists rather than a second call, so a row that is filtered as a non-owner
   * build is the same row that wears the mark, by construction.
   *
   * Both lists come from `label-mismatch.ts` over **one-element sets**, which
   * is the trick both its functions document rather than a fourth rule: asking
   * "is this row built by a non-owner, considering only this one service"
   * answers "is this the offending service", and the same for one assignee.
   * That is why 7.2 needed no third export — a function answering *who* would
   * be a second place for the rule to drift from.
   */
  const mismatchByRow = useMemo(() => {
    const found = new Map<string, { unownedServices: string[]; outsideAssignees: string[] }>();
    for (const row of flat) {
      const teamIds = effectiveTeams.get(row.id)?.teamIds ?? [];
      const serviceIds = effectiveServices.get(row.id)?.serviceIds ?? [];
      found.set(row.id, {
        unownedServices: serviceIds.filter((serviceId) =>
          builtByNonOwner({ serviceIds: [serviceId], teamIds, ownedServicesByTeam }),
        ),
        outsideAssignees: assigneesOf(row).filter((personId) =>
          assignedOutsideTeam({ assigneeIds: [personId], teamIds, teamsByPerson }),
        ),
      });
    }
    return found;
  }, [flat, effectiveTeams, effectiveServices, ownedServicesByTeam, teamsByPerson]);

  /**
   * A row's team as a cell or a bar can state it: its own label, or the one it
   * inherits and the row that carries it.
   *
   * The inheriting arm is what makes a moved date explicable. Without it a leaf
   * with no team of its own is `none` everywhere on screen while its dates come
   * out of a pool, and "why did this row move when somebody edited a team's
   * number" has no answer anywhere in the tool.
   */
  const effectiveTeamLabelOf = (row: TreeRow): ServiceTeamLabel => {
    // The row's own set first, and `at(0)` because a set of more than one is
    // unwritable until R2-4 — R2-3 is the change that gives every member a
    // chip. Empty is *unstated* and inherits, which is the whole of the rule
    // this cell shares with the scheduler.
    const own = row.teamIds.at(0);
    if (own !== undefined) return teamLabelOf(own);
    const inherited = effectiveTeams.get(row.id);
    if (inherited === undefined) return { state: 'none' };
    const named = teams.find((team) => team.id === inherited.teamIds.at(0));
    if (named === undefined) return { state: 'unresolved' };
    return {
      state: 'inherited',
      name: named.name,
      fromRow: namedInTheTree.get(inherited.fromId) ?? 'a row that is not shown',
    };
  };

  /**
   * A row's tags as a cell or a card can state them: its own set, or the one it
   * inherits and the row that carries it.
   *
   * {@link effectiveTeamLabelOf}'s shape, one dimension over, and the whole set
   * rather than `at(0)`: there is no single-member stage in this dimension to
   * grow out of. A name the directory read has not caught up with is simply
   * left out — see {@link TagLabel} for why there is no `unresolved` arm.
   */
  const effectiveTagLabelOf = (row: TreeRow): TagLabel => {
    const namesFor = (ids: readonly string[]): string[] =>
      ids.flatMap((id) => {
        const found = tags.find((each) => each.id === id);
        return found === undefined ? [] : [found.name];
      });
    if (row.tagIds.length > 0) {
      const names = namesFor(row.tagIds);
      return names.length === 0 ? { state: 'none' } : { state: 'named', names };
    }
    const inherited = effectiveTags.get(row.id);
    if (inherited === undefined) return { state: 'none' };
    const names = namesFor(inherited.tagIds);
    if (names.length === 0) return { state: 'none' };
    return {
      state: 'inherited',
      names,
      fromRow: namedInTheTree.get(inherited.fromId) ?? 'a row that is not shown',
    };
  };

  /**
   * A row's service as a cell or a card can state it: its own, or the one it
   * inherits and the row that carries it.
   *
   * {@link effectiveTeamLabelOf}'s shape, third dimension over, and off
   * `effectiveServices` — `libs/domain`'s walk — rather than a second reading
   * of the tree.
   *
   * **The whole set since task 10.4**, where 7.1 read the first of them and said
   * so. The store became a join table in 10.2 and this was the last surface
   * still narrowing it — a two-service row read as its first service here while
   * the filter facet, `builtByNonOwner` and the export all had both. It is now
   * `effectiveTagLabelOf` with different names, which is what the domain walk
   * underneath has been since chunk 12.
   */
  const effectiveServiceLabelOf = (row: TreeRow): ServiceLabel => {
    // Unnamed ids are dropped rather than carried, which is `effectiveTagLabelOf`'s
    // rule and the reason `ServiceLabel` lost its `unresolved` arm: this function
    // feeds the *placeholder*, and the chips beside it show every stated id with
    // the id itself as the fallback. A service the directory has not caught up
    // with is therefore on screen in the cell, not silently absent from it.
    const namesFor = (ids: readonly string[]): string[] =>
      ids.flatMap((id) => {
        const found = services.find((each) => each.id === id);
        return found === undefined ? [] : [found.name];
      });
    // Its own set, which is what makes the row's answer its own rather than an
    // inherited one — the emptiness below is `effectiveServicesOf`'s question,
    // not this one's.
    if (row.serviceIds.length > 0) {
      const names = namesFor(row.serviceIds);
      return names.length === 0 ? { state: 'none' } : { state: 'named', names };
    }
    const inherited = effectiveServices.get(row.id);
    if (inherited === undefined) return { state: 'none' };
    const names = namesFor(inherited.serviceIds);
    if (names.length === 0) return { state: 'none' };
    return {
      state: 'inherited',
      names,
      fromRow: namedInTheTree.get(inherited.fromId) ?? 'a row that is not shown',
    };
  };

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
   * What this plan is still short of, per leaf and per role.
   *
   * Recomputed from the tree on screen rather than tracked, for the reason
   * nothing here is patched locally: an estimate can arrive from anybody, and
   * a count kept alongside would be the second answer to a question that has
   * one.
   */
  const gaps = useMemo(() => findEstimateGaps(flat, roles), [flat, roles]);
  /**
   * The rows the readiness badge counts, as a set the filter can ask.
   *
   * The badge's own answer and not a second one: "unestimated" on a checkbox
   * and `12 unestimated` on the button beside it are the same claim, and two
   * readings of it would be two plans.
   */
  const unestimatedIds = useMemo(() => new Set(gaps.leaves.map((leaf) => leaf.rowId)), [gaps]);

  /**
   * Everything the filter is allowed to ask about, one entry per row.
   *
   * Built here rather than inside {@link narrowTree} because every one of the
   * seven facts is already in scope on this component and none of them is the
   * tree walker's business: the walker's job is ancestors, descendants and
   * termination, and a walker that also knew what a priority band was would be
   * two things.
   *
   * **The effective team and not `row.teamIds`** — see {@link RowFacets}. The
   * unestimated set is the readiness badge's own `gaps`, so the facet and the
   * badge beside it cannot report two different plans.
   */
  const narrowable = useMemo<NarrowableRow[]>(
    () =>
      flat.map((row) => {
        // Named once and read below, because both mismatch signals ask about
        // the same two sets the facets themselves carry. Recomputing them per
        // signal is how a filter and the marker beside it start to answer two
        // different questions about one row.
        const teamIds = effectiveTeams.get(row.id)?.teamIds ?? [];
        const serviceIds = effectiveServices.get(row.id)?.serviceIds ?? [];
        const assigneeIds = assigneesOf(row);
        // The **same** answer the two markers wear, not a second call — see
        // {@link mismatchByRow}. A row absent from that map is a row `flat` does
        // not hold, which cannot happen here because both memos walk `flat`.
        const mismatch = mismatchByRow.get(row.id);
        return {
          id: row.id,
          name: row.name,
          parentId: row.parentId,
          facets: {
            teamIds,
            // The **effective** tags, for the effective team's reason one line
            // up: a leaf under a `regulatory` parent is regulatory, and a filter
            // reading stored labels would not find it.
            tagIds: effectiveTags.get(row.id)?.tagIds ?? [],
            // The **effective** service, for the same reason a third time, and
            // `?? null` because absence from the map is how this walk spells
            // "nobody above this row states one".
            //
            // **Task 6.2's watched red, and it is watched here now.** Written as
            // `row.serviceId` — the row's own stored column, `row.serviceIds`
            // since task 10.2 took the column out of the read path — three cases go red
            // (chunk 9, h2puni): `keeps the rows that inherit a ticked service`
            // drops from the whole branch to `['010']`, and both signal cases
            // follow it down, because a service nobody inherits is a service no
            // team can be caught not owning. Chunk 8 could not observe this and
            // said so; what changed is 6.3's facet control, which is the surface
            // that drives the read.
            serviceIds,
            // The two signals, read off {@link mismatchByRow} — which is their
            // **real site**, the one place in the app that answers them per
            // row, and what makes task 6.2's stored-instead-of-effective fault
            // a production fault rather than a fault in a test's own
            // composition (chunk 7's record of 5.2).
            // `libs/domain/src/label-mismatch.ts` owns both rules; that memo
            // hands them the effective reading and the directory's two maps,
            // and neither it nor this holds a rule of its own.
            //
            // `length > 0` over the offenders and not a second row-level call:
            // "some service is unowned" and "the list of unowned services is
            // not empty" are one sentence, and asking the domain twice is how
            // the mark and the facet would come to disagree.
            builtByNonOwner: (mismatch?.unownedServices.length ?? 0) > 0,
            assignedOutsideTeam: (mismatch?.outsideAssignees.length ?? 0) > 0,
            assigneeIds,
            // Null and not a band: a row nobody has prioritised carries no rung,
            // and `priorityBandOf` is asked about numbers only.
            priorityBand:
              row.priority === null
                ? null
                : (priorityBandOf(priorityBands, row.priority)?.label ?? null),
            // `Object.hasOwn` and not a truthy test, which is `findEstimateGaps`'
            // own rule: a stored `0 / 0 / 0` is somebody saying this costs
            // nothing, which is an answer and not an absence.
            estimatedRoleIds: roles
              .filter((role) => Object.hasOwn(row.estimates, role.id))
              .map((role) => role.id),
            unestimated: unestimatedIds.has(row.id),
            // be-01's own answer for the row, not a second reading of the
            // slices: a row is on the critical path when its work is, and the
            // Slack cell and the card both already print this field.
            critical: row.schedule.critical,
          },
        };
      }),
    [
      flat,
      effectiveTeams,
      effectiveTags,
      effectiveServices,
      // The directory's two maps, and they are the reason this list grew: the
      // three readings above are all derived from `flat`, but the ownership map
      // and the memberships come from the directory read, which reloads on its
      // own. Left out, a team given a service in the directory would leave every
      // marker on screen answering the map as it was at the last tree fetch.
      ownedServicesByTeam,
      teamsByPerson,
      // Carries both maps' dependencies of its own; listed because the two
      // booleans above are read out of it and not recomputed here.
      mismatchByRow,
      priorityBands,
      roles,
      unestimatedIds,
    ],
  );

  /**
   * What the filter is asking for: which rows stay, which of them are hits,
   * and what has to be open to show them.
   *
   * A pure function of the rows on screen and the criteria, memoised only so
   * the table's own row model is not rebuilt on every unrelated render — never
   * cached across a change to either. A structural edit refetches the tree and
   * this narrows the tree that came back, which is why a row moved out of the
   * match set disappears from the narrowed view.
   */
  const criteria = useMemo<FilterCriteria>(() => ({ query, ...facets }), [query, facets]);
  const search = useMemo(() => narrowTree(narrowable, criteria), [narrowable, criteria]);
  /**
   * Whether a filter is on — a query with something in it other than spaces,
   * or any facet ticked, and exactly when {@link narrowTree} hands back an
   * overlay.
   *
   * One source of truth rather than a second trim beside it, which is how two
   * answers to one question start to disagree. Read through {@link isFiltering}
   * rather than off the overlay so the controls that stand down while a filter
   * is on do not have to hold a narrowed tree to ask.
   */
  const filtering = isFiltering(criteria);

  /**
   * The names the ids inside a {@link FilterCriteria} stand for, in this
   * plan's own words — one object read by the filtered export's `Scope` line
   * ({@link planOnScreen}) and by the saved-views panel's tooltip, so a
   * filter is never described two different ways.
   */
  const filterLabels: FilterLabels = {
    teamName: (teamId) =>
      teams.find((team) => team.id === teamId)?.name ?? 'a team this plan has not loaded',
    personName: (personId) =>
      chartRead.people.find((person) => person.id === personId)?.name ??
      'somebody this plan has not loaded',
    phaseName: (roleId) => roles.find((role) => role.id === roleId)?.name ?? '(unknown)',
    tagName: (tagId) =>
      tags.find((each) => each.id === tagId)?.name ?? 'a tag this plan has not loaded',
    // Names a service since task 6.3 pulled `listServices` forward out of 7.6.
    // The fallback is the one every lookup here keeps: a saved view can hold an
    // id whose service the directory has since removed, and printing the id
    // would put a uuid in the export's `Scope` line.
    serviceName: (serviceId) =>
      services.find((each) => each.id === serviceId)?.name ?? 'a service this plan has not loaded',
  };

  const facetTeams = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.teamIds)),
        facets.teamIds,
        (id) =>
          // The Team cell's own sentence for a label the directory read has
          // not caught up with, rather than a blank box.
          teams.find((team) => team.id === id)?.name ?? 'a team this plan has not loaded',
      ),
    [narrowable, facets.teamIds, teams],
  );
  /**
   * The tags any row on this plan carries, plus whatever is already ticked.
   *
   * The plan's own vocabulary rather than the whole directory, for
   * `facetTeams`' reason: a facet offering a value no row has is a filter whose
   * only possible answer is an empty table.
   */
  const facetTags = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.tagIds)),
        facets.tagIds,
        (id) => tags.find((each) => each.id === id)?.name ?? 'a tag this plan has not loaded',
      ),
    [narrowable, facets.tagIds, tags],
  );
  /**
   * The services the rows on this plan are **effectively** delivered by, plus
   * whatever is already ticked.
   *
   * Off `row.facets.serviceIds` and so off the effective reading, which is what
   * makes the offered list match what ticking one will find: a plan whose only
   * stored service sits on a parent still offers it, because every child under
   * that parent answers to it.
   */
  const facetServices = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.serviceIds)),
        facets.serviceIds,
        (id) =>
          services.find((each) => each.id === id)?.name ?? 'a service this plan has not loaded',
      ),
    [narrowable, facets.serviceIds, services],
  );
  const facetPeople = useMemo(
    () =>
      optionsFor(
        new Set(narrowable.flatMap((row) => row.facets.assigneeIds)),
        facets.assigneeIds,
        // The names that came with the tree, which is be-01's own list of who
        // is assigned on this plan — not the directory's list of everybody.
        (id) =>
          chartRead.people.find((person) => person.id === id)?.name ??
          'somebody this plan has not loaded',
      ),
    [narrowable, facets.assigneeIds, chartRead.people],
  );
  /** In the ladder's order, which is the order the bands mean something in. */
  const facetBands = useMemo(() => {
    const present = new Set(
      narrowable.flatMap((row) =>
        row.facets.priorityBand === null ? [] : [row.facets.priorityBand],
      ),
    );
    return priorityBands
      .filter((band) => present.has(band.label) || facets.priorityBands.includes(band.label))
      .map((band) => ({ id: band.label, label: band.label }));
  }, [narrowable, priorityBands, facets.priorityBands]);
  /** In the phase list's order, which is the order of the columns they estimate. */
  const facetPhases = useMemo(() => {
    const present = new Set(narrowable.flatMap((row) => row.facets.estimatedRoleIds));
    return roles
      .filter((role) => present.has(role.id) || facets.estimatedRoleIds.includes(role.id))
      .map((role) => ({ id: role.id, label: role.name }));
  }, [narrowable, roles, facets.estimatedRoleIds]);

  const siblingsOf = useCallback(
    (parentId: string | null) => flat.filter((row) => row.parentId === parentId),
    [flat],
  );

  /**
   * `Add work item` clicks waiting their turn, and the drain that spends them.
   *
   * The reason this exists rather than `disabled={busy}`: **a planner clicks
   * faster than the round trip and every click is a different row.** Measured
   * on dev — 6 clicks at 350ms produced 3 rows, 4 at 1500ms produced 4 — and
   * the losses were silent, because a click on a disabled button is not
   * refused, it simply never happens. The rest of the toolbar is right to
   * refuse: `Freeze all` twice is the same command asked twice, and holding it
   * back costs nothing. This one is the exception the convention needs.
   *
   * Refs rather than state, for the reason {@link run}'s neighbours are: two
   * clicks in one tick would both read the count from before either.
   *
   * **`afterId` is chained, never re-read.** The first click in a burst reads
   * the tree, which is current because nothing is in flight yet; every click
   * after it goes after the row the click before it made. That is both more
   * correct and cheaper than re-reading `siblingsOf` per iteration — the
   * refetch's state has not necessarily rendered by the time the next turn of
   * this loop runs, so a re-read could hand be-01 the same `afterId` twice and
   * stack the burst in reverse.
   */
  const addQueue = useRef({ projectId, queued: 0, draining: false });
  if (addQueue.current.projectId !== projectId) {
    // Orphan the old project's queue. Its in-flight request may finish, but
    // pending clicks do not become writes after the reader has left it, and a
    // click here receives a fresh drain immediately.
    addQueue.current = { projectId, queued: 0, draining: false };
  }
  const addWorkItem = useCallback(() => {
    const queue = addQueue.current;
    queue.queued += 1;
    if (queue.draining) return;
    queue.draining = true;
    void (async () => {
      try {
        let afterId = siblingsOf(null).at(-1)?.id ?? null;
        while (queue.queued > 0 && activeProject.current === queue.projectId) {
          queue.queued -= 1;
          const outcome = await run(async () => {
            const created = await api.create(projectId, { parentId: null, afterId, name: '' });
            afterId = created.id;
            focusIntent.current.wants({ rowId: created.id, columnId: 'name' });
          });
          // A refused create ends the burst. The rows after it would be built
          // on an `afterId` that was never written, and be-01 has already said
          // why it said no — six more of the same toast is not more information.
          if (outcome === 'refused') queue.queued = 0;
        }
      } finally {
        queue.draining = false;
      }
    })();
  }, [api, projectId, run, siblingsOf]);

  /**
   * Every fact about this plan that a column's width is allowed to depend on.
   *
   * `flat` rather than the rows on screen, and that is the whole point of the
   * question being asked this way: it is every row in the **project**, open or
   * collapsed, matched by a search or narrowed out of it. A column that got
   * narrower because the one row with a day on it was collapsed away would
   * change width under a reader who was only scrolling.
   */
  const frameState: FrameLayoutState = {
    hasAnyNotBefore: flat.some((row) => row.startNoEarlierThan !== null),
    // The reader's own answer, which outranks whatever the fact above resolves
    // to. Built here rather than passed to each consumer, so the `<colgroup>`,
    // both minimums and the pinned offsets cannot be answers to two different
    // questions.
    columnWidthOverrides: widthOverrides,
  };

  /** What the resize handles on the heading row do with the widths they work out. */
  const resizeColumn: ColumnResize = {
    drag: (columnId, width) => {
      // Per move, so the column follows the pointer. Only the write below is
      // held back to the end of the gesture.
      setWidthOverrides((current) => new Map(current).set(columnId, width));
    },
    commit: (columnId, width) => {
      const committed = new Map(widthOverrides).set(columnId, width);
      setWidthOverrides(committed);
      rememberWidthOverrides(projectId, committed);
    },
    abandon: () => {
      // A `pointercancel` is the browser taking the gesture — a system gesture,
      // a lost device — and what it leaves behind is the last width this
      // render saw rather than a half-finished one. Re-read from storage
      // rather than remembered in a ref: the storage is the last committed
      // answer by construction.
      setWidthOverrides(rememberedWidthOverrides(projectId));
    },
  };

  /** What the handle on the Gantt panel's top edge does with the heights its gestures work out. */
  const resizeGantt: GanttHeightResize = {
    drag: (heightPx) => {
      // Per move, so the boundary follows the pointer. Only the write below is
      // held back to the end of the gesture.
      setGanttHeightPx(heightPx);
    },
    commit: (heightPx) => {
      setGanttHeightPx(heightPx);
      rememberGanttHeight(projectId, heightPx);
    },
    abandon: () => {
      // Re-read from storage rather than remembered in a ref, for
      // {@link resizeColumn}'s reason: the storage is the last committed
      // answer by construction.
      setGanttHeightPx(rememberedGanttHeight(projectId));
    },
  };

  /**
   * Forgets the Gantt's own settings for this project — the dragged panel
   * height, the picked day scale and the hidden row-name labels — so each
   * returns to what is resolved for it **now**: the panel to its default
   * share, the scale back to {@link DAY_PX} (Days), the labels to shown.
   *
   * The width half of a layout reset stays in {@link resetLayout}, which
   * delegates here: a phone card has a chart height, a scale and row names
   * but no columns to widen, so this half is the one the Plan actions sheet
   * carries, and a width override is nothing a card can forget.
   *
   * Forgotten, never frozen — storing any of the three as it stands would
   * turn a reset into a rename of today's defaults.
   */
  function resetGanttSettings(): void {
    setGanttHeightPx(null);
    forgetGanttHeight(projectId);
    setGanttDayPx(DAY_PX);
    forgetGanttDayPx(projectId);
    setGanttLabelsShown(true);
    forgetGanttLabels(projectId);
  }

  /**
   * Forgets the column widths, the hidden columns **and** the Gantt settings
   * for this project, so each returns to what is resolved for it **now** — the
   * widths to the frame layout's answer, the columns on screen to the default
   * column set, the chart to its default share, the scale to Days, the labels
   * to shown.
   *
   * Forgotten, never frozen. Storing either half as it stands would turn a
   * reset into a rename of today's defaults, and a column whose default had
   * moved since — `not-before` is 56px or 84px — would come back to the wrong
   * one.
   *
   * Proof: the height half deleted, `one reset forgets the widths and the
   * height together` (wbs-table.test.tsx) failed on `expected '500' to be
   * null` — the widths forgotten, the chart still holding its dragged share.
   * Watched, 2026-08-10.
   */
  function resetLayout(): void {
    setWidthOverrides(new Map());
    forgetWidthOverrides(projectId);
    setStoredHiddenColumns(DEFAULT_HIDDEN_COLUMNS);
    forgetHiddenColumns(projectId);
    resetGanttSettings();
  }

  /**
   * Whether the columns on screen are not the default column set — a column
   * hidden, or a default-hidden one shown — which is the columns half of
   * whether `Reset layout` has anything to do. Compared as sets: the order a
   * reader ticked things in is not a difference.
   */
  const columnsDiffer =
    hiddenColumnIds.length !== DEFAULT_HIDDEN_COLUMNS.length ||
    hiddenColumnIds.some((id) => !DEFAULT_HIDDEN_COLUMNS.includes(id));

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
      tags,
      // The service vocabulary the export's `Services` column resolves ids
      // against. Named here beside `tags` and not derived from the rows: the
      // export is self-contained, so it carries the names as they read today.
      services,
      people,
      priorityBands,
      // Every tree row as it came off the wire, not a literal built from one.
      // `toTree` spreads the whole `WorkItemView` (`wbs-rows.ts`), so a column
      // be-01 adds reaches the export the day it reaches the type — which is
      // why `Not before because` needed no line here, against what
      // `not-before-reason`'s proposal owed. Asserted rather than assumed:
      // `exports the words about a not-before date` reads the reason out of a
      // downloaded plan, so a literal introduced here later fails a test rather
      // than silently emptying a column.
      rows: flat,
      // The slices the chart on screen was drawn from, so the export's Ran at
      // column is the same placement the bars are and not a second reading of
      // it. Empty until the first read lands and empty again on a plan that
      // could not be scheduled — both of which the column renders as nothing
      // rather than as a 1.
      slices: chartRead.slices,
    }),
    [
      projectName,
      estimateMethod,
      startDate,
      scheduleError,
      roles,
      teams,
      tags,
      services,
      people,
      priorityBands,
      flat,
      chartRead.slices,
    ],
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
   * Puts the plan's chart on the clipboard as a Mermaid gantt, or says why there
   * is none. Same three clipboard outcomes as `copyAsMarkdown`, plus a fourth
   * this one has: a plan a gantt cannot be drawn of at all.
   */
  const copyAsMermaid = useCallback(() => {
    const diagram = planToMermaid(planForExport());
    if (!diagram.drawn) {
      pushToast({ kind: 'error', text: diagram.refusal });
      return;
    }
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      pushToast({ kind: 'error', text: NO_CLIPBOARD });
      return;
    }
    void clipboard.writeText(diagram.text).then(
      () => {
        pushToast({ kind: 'info', text: 'Copied as Mermaid.' });
      },
      () => {
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
   * Downloads the plan as a bundled Markdown document — the Mermaid fence plus
   * the table beneath it — or says why there is no diagram to bundle. Refuses
   * exactly where {@link copyAsMermaid} refuses, and for the same reason: a
   * document is the fence plus the table, and there is nothing to bundle around
   * a sentence.
   */
  const downloadMermaidDocument = useCallback(() => {
    const plan = planForExport();
    const bundle = planToMermaidDocument(plan);
    if (!bundle.drawn) {
      pushToast({ kind: 'error', text: bundle.refusal });
      return;
    }
    const markdown = new Blob([bundle.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(markdown);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan, 'md');
    anchor.click();
    URL.revokeObjectURL(url);
  }, [planForExport, pushToast]);

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
    const grid = gridElement.current;
    if (gapVisit === null || grid === null) return;
    const arrived = cellIn(grid, gapVisit.cell);
    if (arrived === undefined) return;
    // Proof: removed, five of this block's tests failed with the focus left
    // wherever the last created row had put it. Watched, 2026-08-06.
    //
    // Selected, the way every arrival at an estimate cell is: the value at
    // rest is a computed figure, and a caret dropped inside `4` turns the next
    // `2/3/8` into `2/3/84`.
    focusCellAt(arrived, 'all');
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
        focusIntent.current.wants({ rowId: created.id, columnId: 'name' });
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
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
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
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
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
        focusIntent.current.wants({ rowId: row.id, columnId: landOn });
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
   * for the reason every other focus intent here is asked for — a refusal must
   * leave the caret where the person left it rather than chase a row that does
   * not exist.
   */
  const duplicateRow = useCallback(
    (id: string) =>
      run(async () => {
        const copy = await api.duplicate(id);
        focusIntent.current.wants({ rowId: copy.id, columnId: 'name' });
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
   * Proof, three faults, all watched on 2026-08-08. The focus intent
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
        focusIntent.current.wants(
          landsOn === undefined ? null : { rowId: landsOn.id, columnId: 'name' },
        );
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
        focusIntent.current.wants(
          above === undefined ? null : { rowId: above.id, columnId: 'name' },
        );
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
      const container = gridOf(event.currentTarget);
      if (container === null) return;
      const grid = editableGrid(container);

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
   * Not attached globally: it lives on the cells that route their own keys,
   * which is every cell of the grid. It reached only some of them until
   * `table-mechanics` — the dependency picker, the two `CreatablePicker`
   * columns and the earliest-start cell each swallowed it, so "from any cell"
   * was false in three cell classes at once. What lets a picker hand it back
   * without handing back the chords that make and destroy a row is
   * {@link escapesAnOpenList}.
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
      const container = gridOf(input);
      if (container === null) return false;
      const grid = editableGrid(container);
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
    const container = gridOf(input);
    if (container === null) return undefined;
    const grid = editableGrid(container);
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
      // The state only. The sentence that goes with it is pushed — and taken
      // off again — by the effect that owns the arm, so it cannot outlive the
      // arm it describes.
      setArmedDelete({ rowId: row.id, number: row.number });
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
   * The work items an id list names — number and name — in the order given.
   *
   * A dependency is stored by id and read by number, because an id is not
   * something anyone can look at. A row whose predecessor has since been deleted
   * simply drops out of the list rather than rendering a blank chip — the tree
   * refetches on every change, so this cannot be stale for long.
   *
   * The name rides along with the number because a chip reading `010` is a
   * question, and the hover card over those chips is where it is answered. One
   * pass over `flat` for both: two readers looking up the same rows by id is
   * two loops and one more place for the list to come out in a different order.
   */
  const dependenciesOf = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const found = flat.find((row) => row.id === id);
        return found === undefined ? [] : [{ id, number: found.number, name: found.name }];
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
              //
              // The **word** here and a sentence everywhere else, deliberately:
              // this list is already inside one (`These were refused: 010
              // (cycle), 020 (ancestor).`), and five sentences spliced into a
              // sixth is not a sentence. A single entry taken from the picker
              // goes through `run` and does get {@link refusalSentence}.
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
   *
   * The `run` outcome is handed back rather than swallowed, so the card's
   * sheet can model the in-flight edge: a second tap on the same option must
   * not send the same write twice (the card locks it until this resolves).
   */
  const pickDependency = useCallback(
    (successorId: string, predecessorId: string): Promise<CommitOutcome> => {
      setDepPicker((current) =>
        current === null ? null : { ...current, typed: '', highlightId: null },
      );
      return run(() => api.addDependency(successorId, predecessorId));
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
   *
   * **Clearing the day clears the words with it, in the same request.** Since
   * #81 the pair is a rule be-01 checks inside the transaction that would write
   * it: a reason with no date to be about is `not_before_reason_needs_a_date`,
   * **400**. So a bare `{ startNoEarlierThan: null }` is a refusal on every row
   * somebody has explained — the date would stop clearing, in the reader's
   * face, on exactly the rows that have the most typed into them. Refused
   * rather than cascaded is be-01's call and the right one; the client that
   * cleared the date is the one place that knows the words are meant to go too.
   *
   * Setting a day names only the day, **unless the caller names the words too**.
   * The table's two boxes are edited one at a time and each sends its own
   * field, so the date box omits `reason` and the words on a row that already
   * has some stay true of the new date — a set that silently blanked them would
   * be the deletion above wearing the other hat. A card's sheet edits both at
   * once and passes both, which is why `reason` is *optional* rather than
   * absent: `undefined` means "not this caller's business", `null` means "take
   * the words off".
   *
   * **One patch and never two, which is the whole reason the parameter is here
   * rather than a second `run` at the call site.** `run` is fire-and-forget —
   * callers say `void run(…)` — so a date request and a reason request issued
   * back to back are not ordered, and the pair rule above turns the losing
   * order into a **400** on the row somebody just explained. be-01 checks the
   * pair inside one transaction; this sends it as one.
   *
   * Proof: the second field dropped from the null arm, `clearing a not-before
   * date clears the words with it` fails on `expected [ { startNoEarlierThan:
   * null } ] to deeply equal [ { startNoEarlierThan: null,
   * startNoEarlierThanReason: null } ]`. Watched, 2026-08-18.
   */
  const setNotBefore = useCallback(
    (id: string, day: string | null, reason?: string | null) => {
      void run(() =>
        api.patch(
          id,
          day === null
            ? { startNoEarlierThan: null, startNoEarlierThanReason: null }
            : reason === undefined
              ? { startNoEarlierThan: day }
              : // The blank box is `null` and never `''`, {@link setNotBeforeReason}'s
                // own call: one spelling of "nobody has said", and the one thing
                // be-01 cannot see from a field that is simply absent.
                {
                  startNoEarlierThan: day,
                  startNoEarlierThanReason:
                    reason === null || reason.trim() === '' ? null : reason.trim(),
                },
        ),
      );
    },
    [api, run],
  );

  /**
   * Sets or clears the words about one work item's "not before" day.
   *
   * A sentence, not a state. It moves no date and reaches no other row — the
   * date is the whole of the constraint and this is the whole of the
   * explanation (`openspec/changes/not-before-reason/proposal.md`).
   *
   * A blank box is `null`, not `''`, so there is one spelling of "nobody has
   * said" — the same call `setPriority` makes about an emptied number, and the
   * one thing be-01 cannot see from a request that omits the field entirely.
   *
   * **What is deliberately not decided here: whether the row may have words at
   * all.** Typing a reason onto a row with no date is refused by be-01 with the
   * pair rule above, and it is left refused there rather than guarded in this
   * client. A client-side rule the server does not share is how the two come to
   * disagree, which is the doctrine {@link setPriority} already writes down.
   */
  const setNotBeforeReason = useCallback(
    (id: string, typed: string) => {
      const said = typed.trim();
      void run(() => api.patch(id, { startNoEarlierThanReason: said === '' ? null : said }));
    },
    [api, run],
  );

  /**
   * Sets or clears one work item's priority, from what was typed into its cell.
   *
   * An ordering, which be-01 honours in its leveller's queue — never a
   * date and never a constraint: a work item with a priority still waits for its
   * dependencies, its floor and its calendar. The bars move because the engine
   * moved them.
   *
   * The parse is deliberately narrow and the refusal is be-01's. Everything
   * that is not an empty box is sent as a number and answered on: a `0`, a
   * `-1` or a `1.5` comes back a 400 and the draft stays in the box the way
   * every other refused edit does, rather than being silently swallowed by a
   * client-side rule the server does not share. What is decided here is only
   * the one thing be-01 cannot see — an emptied box is `null`, not `0`, and
   * `Number('')` is `0`.
   */
  const setPriority = useCallback(
    (id: string, typed: string): Promise<CommitOutcome> => {
      // A band's own name resolves to the number it writes, **before** anything
      // is parsed as a number. That is the manual-or-label half of Dany's ask
      // arriving through one commit path rather than two: a picked line and a
      // typed name and a typed number all become one `patch`, one journal entry
      // and one undo. `priorityTyped` owns the rule and the order in it.
      const trimmed = priorityTyped(priorityBands, typed).trim();
      if (trimmed === '') return run(() => api.patch(id, { priority: null }));
      // `Number` rather than `parseInt`: `parseInt('1.5')` is 1 and
      // `parseInt('2x')` is 2, so both would go out as priorities nobody typed.
      // `Number` answers `NaN` for either.
      const asNumber = Number(trimmed);
      // The one refusal this client makes on its own, and only because it
      // cannot be asked: JSON has no literal for `NaN` **or for `Infinity`**, so
      // a request carrying either arrives as `null` — which is what clears a
      // priority. `Number.isFinite` rather than `Number.isNaN` for exactly that
      // reason: `Number('1e999')` is `Infinity`, is not `NaN`, and would go out
      // as somebody's priority silently wiped. The same trap, on stored column
      // widths, is why {@link rememberedWidthOverrides} range-checks.
      //
      // Everything that *is* a finite number goes out and is answered on, `0`
      // and `-1` and `1.5` included: the rule about what a priority may be is
      // be-01's, and a second copy of it here is a rule that can quietly
      // disagree.
      //
      // Proof: written back as `Number.isNaN`, `says so, and sends nothing,
      // when what was typed is a number too big to be one` failed on `expected
      // [ { priority: null } ] to deeply equal []` — the clear request, sent
      // from a typed `1e999`. Watched, 2026-08-11.
      if (!Number.isFinite(asNumber)) {
        pushToast({ kind: 'error', text: 'A priority is a whole number from 1 upward.' });
        return Promise.resolve<CommitOutcome>('refused');
      }
      return run(() => api.patch(id, { priority: asNumber }));
    },
    [api, priorityBands, pushToast, run],
  );

  /**
   * Sets or resets how many people may work on one item at once, from what was
   * typed into its In-parallel cell.
   *
   * The same shape as {@link setPriority} one column along, and deliberately
   * the same: an emptied box is the one thing be-01 cannot see — `Number('')`
   * is `0`, which is a refusal rather than a reset — and everything else is
   * sent and answered on, `0`, `-1`, `1.5` and `1001` included. The rule about
   * what a parallelism may be lives in `capacity-write-paths` at be-01's
   * boundary; a second copy here is a rule that can quietly disagree with it.
   *
   * `null` is a **reset to 1** and not a clear: 1 and unset are the same fact —
   * one at a time — and the column is `NOT NULL DEFAULT 1`, which is why an
   * emptied cell renders blank rather than showing the 1 it stores.
   */
  const setParallelism = useCallback(
    (id: string, typed: string): Promise<CommitOutcome> => {
      const trimmed = typed.trim();
      if (trimmed === '') return run(() => api.patch(id, { maxParallel: null }));
      const asNumber = Number(trimmed);
      // {@link setPriority}'s refusal, for its reason: JSON has no literal for
      // `NaN` or `Infinity`, so either would arrive as `null` — which here is
      // the reset, so a typed `1e999` would silently put the item back to one
      // at a time instead of being refused.
      if (!Number.isFinite(asNumber)) {
        pushToast({ kind: 'error', text: 'People at once is a whole number from 1 to 1000.' });
        return Promise.resolve<CommitOutcome>('refused');
      }
      return run(() => api.patch(id, { maxParallel: asNumber }));
    },
    [api, pushToast, run],
  );

  /**
   * The row whose earliest-start cell is being edited, or none.
   *
   * One id rather than a set, which is the whole of "at most one editor on the
   * page": every other row's cell is the short date as text, and a native date
   * input is 138px of furniture the 84px column has no room for. It is also
   * what took `not-before` from 146px to 84 — the column had to hold an editor
   * on every row until 2026-08-09.
   */
  const [editingNotBefore, setEditingNotBefore] = useState<string | null>(null);

  /**
   * The row whose earliest-start cell is owed the focus back, once the editor
   * closing on it has actually gone from the DOM.
   *
   * A ref and an effect rather than a call, because the cell to focus does not
   * exist yet at the moment the editor asks to close: it is rendered by the
   * same pass that unmounts the editor.
   */
  const notBeforeOwedFocus = useRef<string | null>(null);

  /** Opens the editor on one row's earliest-start cell, closing any other. */
  const openNotBefore = useCallback((rowId: string) => {
    setEditingNotBefore(rowId);
  }, []);

  /**
   * Closes the editor and gives the cell it was on the focus back.
   *
   * The way out — {@link DateField}'s `onExit` — is not branched on here, and
   * that is deliberate: the day has been sent or it has not, by then, and the
   * editor closes either way. What the two answers are for is the editor's own
   * suppression of the blur an Escape causes, which is `date-field.tsx`'s.
   */
  const closeNotBefore = useCallback((rowId: string) => {
    notBeforeOwedFocus.current = rowId;
    setEditingNotBefore((editing) => (editing === rowId ? null : editing));
  }, []);

  /**
   * Puts the focus where opening or closing an editor has just moved it.
   *
   * Both directions in one effect, because both need the same thing and cannot
   * have it any sooner: the element to focus is rendered by the very pass that
   * mounted or unmounted the editor. An `autoFocus` would cover the opening
   * half and nothing at all of the closing half, which is the half the
   * contract is about.
   */
  useEffect(() => {
    const grid = gridElement.current;
    if (grid === null) return;
    if (editingNotBefore !== null) {
      const editor = cellIn(grid, { rowId: editingNotBefore, columnId: 'not-before' });
      // Gone before the focus reached it — a peer deleted the row, or a search
      // narrowed it away. A modeled absence: there is nothing to focus.
      if (editor !== undefined) focusCellAt(editor, 'all');
      return;
    }
    const rowId = notBeforeOwedFocus.current;
    if (rowId === null) return;
    notBeforeOwedFocus.current = null;
    // Only where nothing else has claimed it. `Ctrl/⌘ + Enter` from this cell
    // commits, closes **and** moves to the next row — putting the focus back on
    // the cell it left would undo the chord.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const cell = cellIn(grid, { rowId, columnId: 'not-before' });
    if (cell === undefined) return;
    focusCellAt(cell, 'all');
  }, [editingNotBefore]);

  /** Replaces a work item's own team set, whole. */
  const setTeamOf = useCallback(
    (id: string, teamIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patch(id, { teamIds: [...teamIds] })),
    [api, run],
  );

  /**
   * States which services a work item is delivered by, **whole**.
   *
   * `setTagsOf`'s shape and now its signature too: the patch states the set as
   * it will stand, so adding one sends the old set plus it, removing one sends
   * the old set minus it, and clearing sends `[]` rather than omitting the field
   * — an omitted field is "no opinion" to the patch and would leave the old
   * services standing. be-01 refuses an id the directory does not carry with
   * `unknown_service` (section 3), which is why nothing here validates a second
   * time.
   *
   * Task 10.4 took the `string | null` this had until the cell became a
   * multi-select. That parameter was the *cell's* shape rather than the
   * dimension's, and it silently dropped every service past the first on any row
   * that carried two.
   */
  const setServicesOf = useCallback(
    (id: string, serviceIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patch(id, { serviceIds: [...serviceIds] })),
    [api, run],
  );

  /**
   * Sets a work item's tags, **whole**.
   *
   * The patch states the set as it will stand, so adding one sends the old set
   * plus it and removing one sends the old set minus it. That is not a detail
   * of this function — it is what makes the undo journal able to carry a
   * before-value, and be-01 refuses to guess at a delta.
   */
  const setTagsOf = useCallback(
    (id: string, tagIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patch(id, { tagIds: [...tagIds] })),
    [api, run],
  );

  /** Adds a team nobody had yet and appends it to the work item's whole set. */
  const createTeamFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        // be-01 is idempotent by name, so two browsers typing `Platform` at
        // once end up on one team rather than two.
        const team = await api.addTeam(name);
        await api.patch(id, { teamIds: [...current, team.id] });
      }),
    [api, run],
  );

  /** Adds a service nobody had yet and labels the work item with it, in one go. */
  const createServiceFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        const service = await api.addService(name);
        await api.patch(id, { serviceIds: [...current, service.id] });
      }),
    [api, run],
  );

  /** Adds a tag nobody had yet and labels the work item with it, in one go. */
  const createTagFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        const tag = await api.addTag(name);
        await api.patch(id, { tagIds: [...current, tag.id] });
      }),
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
        const person = await api.addPerson(name, row.teamIds);
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

  const hasSchedule = useCallback(() => scheduleError === null, [scheduleError]);
  const showSchedule = useCallback(
    (days: number) => (scheduleError === null ? showDay(days) : '—'),
    [scheduleError],
  );

  /**
   * When a work item happens: real dates once the plan is on a calendar, and
   * day offsets from day zero until then.
   *
   * One function for both figures and both renderers, because the fallback is
   * the interesting half: `dates` is null both while the project has no start
   * date and while the schedule could not be computed at all, and a second copy
   * of that sentence in the card renderer is one edit away from disagreeing
   * with the columns.
   */
  const spanOf = useCallback(
    (row: TreeRow) => {
      // One `today` for both ends of one row, so a render that straddles
      // midnight cannot print a start off this year and a finish off the next.
      const today = new Date();
      return {
        start: printedDay(row.dates?.startsOn ?? null, today, () =>
          showSchedule(row.schedule.earliestStart),
        ),
        finish: printedDay(row.dates?.endsOn ?? null, today, () =>
          showSchedule(row.schedule.earliestFinish),
        ),
      };
    },
    [showSchedule],
  );

  /**
   * The teams in force for a row, as a sentence names them — the directory's
   * word where it has one, the id where it does not.
   *
   * Both markers need this half, which is why it is not written twice: the
   * non-owner sentence names who does not own the service and the assignee
   * sentence names who the person is not in, and they are the same set.
   */
  const teamNamesOn = useCallback(
    (row: TreeRow): string[] =>
      (effectiveTeams.get(row.id)?.teamIds ?? []).map(
        (id) => teams.find((team) => team.id === id)?.name ?? id,
      ),
    [effectiveTeams, teams],
  );

  /**
   * Why this row's service cell is marked, or `null` where it is not (task 7.2).
   *
   * Reads {@link mismatchByRow} rather than asking the domain again, so the
   * sentence names exactly the services the facet counted. **Every** offending
   * service, not the first — the scope change made the dimension a set, and a
   * marker naming one of two would send a reader to fix half of what it saw.
   *
   * A service the directory has not caught up with prints as its id, the same
   * fallback the chips beside it take: a sentence that silently dropped it
   * would name fewer services than the mark is about.
   */
  const nonOwnerNoteOf = useCallback(
    (row: TreeRow): string | null => {
      const unowned = mismatchByRow.get(row.id)?.unownedServices ?? [];
      if (unowned.length === 0) return null;
      const named = listed(
        unowned.map((id) => services.find((service) => service.id === id)?.name ?? id),
      );
      const owners = teamNamesOn(row);
      return `Built by a non-owner: ${listed(owners)} ${
        owners.length === 1 ? 'does' : 'do'
      } not own ${named}.${MISMATCH_TAIL}`;
    },
    [mismatchByRow, services, teamNamesOn],
  );

  /**
   * Who is doing one phase of one work item, and whether anybody said so.
   *
   * The assumption — nobody named on this phase and exactly one person named on
   * another, so they are taken to be doing all of it — is be-01's
   * (`doesEveryPhase`), and this is the one place either renderer reads it.
   * `(unknown)` rather than nothing for a person the directory has not got:
   * somebody is assigned, and printing an empty cell would say nobody is.
   *
   * **`outside` is task 7.2's other marker**, and it rides here because this is
   * the one function every surface asks who is doing the work: the folded cell,
   * the unfolded assignee column and the plan cards all read it, so a signal
   * added here cannot be on one of them and missing from another. The person
   * shown and not the row's whole set — the assumed assignee included, because
   * a phase the plan says they are doing is work assigned to them.
   */
  const assigneeOn = useCallback(
    (row: TreeRow, roleId: string): CardAssignee | null => {
      const named = row.assignees[roleId];
      const shows = named ?? row.doesEveryPhase;
      if (shows === null) return null;
      const name = people.find((each) => each.id === shows)?.name ?? '(unknown)';
      // The row's own answer, filtered to the person this cell shows — and that
      // covers the assumed assignee too, which is not obvious and is the reason
      // this is written down. An assumption is `assumedAssignee(row.assignees)`
      // (`apps/be-01/src/service/assumed-assignee.ts`): the one person the row
      // *does* state, promoted to cover the phases it does not. So whoever this
      // cell shows is always in `assigneesOf(row)` and therefore always in
      // `mismatchByRow`'s list, and a second call for the assumed case cannot
      // answer anything different.
      //
      // There was one here, with a paragraph explaining why the assumed person
      // was missing from the list. F4 of chunk 17's injection round disproved
      // it: with that arm forced off, the case written for it stayed green,
      // 1565/0 — because the else branch had been answering it all along. The
      // case is kept (an assumed phase must wear the mark, and nothing else
      // asserts it); the branch is gone.
      const outsider = mismatchByRow.get(row.id)?.outsideAssignees.includes(shows) ?? false;
      const teamNames = teamNamesOn(row);
      return {
        name,
        assumed: named === undefined,
        outside: outsider
          ? `Assigned outside the team: ${name} is not in ${listed(teamNames)}.${MISMATCH_TAIL}`
          : null,
      };
    },
    [people, mismatchByRow, teamNamesOn],
  );

  /**
   * The work items one waits for, in the order it holds them.
   *
   * The entries and not just their numbers, since `card-field-pickers` chunk 7:
   * the card's line became a control, and a wait that can be taken off has to
   * name the row a removal is keyed by. `dependenciesOf` already builds exactly
   * this, so widening it is dropping a `.map` rather than adding a second pass.
   */
  const waitsFor = useCallback((row: TreeRow) => dependenciesOf(row.dependsOn), [dependenciesOf]);

  /**
   * Takes the plan to one row: its name cell gets the caret and is scrolled to.
   *
   * The Gantt panel's way back into the editor, and it works on both faces
   * because it names a **cell** rather than a piece of markup — `cellIn` reads
   * the committed `[data-grid]`, which is the `<table>` at laptop width and the
   * card list below the breakpoint (`M mobile-cards`' contract). A column the
   * cards do not render would work on one face and quietly do nothing on the
   * other, which is why the negative for this is pointed at exactly that.
   *
   * Both absences are modeled rather than thrown on: a chart can outlive the
   * row it was drawn from by one refetch, and there is nothing to take anybody
   * to then.
   */
  const goToRow = useCallback((rowId: string) => {
    const grid = gridElement.current;
    if (grid === null) return;
    const cell = cellIn(grid, { rowId, columnId: 'name' });
    if (cell === undefined) return;
    cell.focus();
    // jsdom has no `scrollIntoView`; that boundary is the test environment, not
    // a browser this will meet. The same guard the pickers use.
    if (typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest' });
  }, []);

  /**
   * What holds each row's start, in the chart's own words — filled below, once
   * {@link ganttPlan} exists, and read by the `Start` cell out of the returned
   * tree.
   *
   * A ref for {@link live}'s reason and not a second one: the `columns` memo
   * depends on `roles` alone, and a value added to its dependency list remounts
   * every cell in the table and eats the focus (LLM_README landmine #1). Its own
   * ref rather than a field on `live` because it is assigned two thousand lines
   * further down than that object is — the plan it is computed from is built
   * after the columns are, and a field of `live` filled late would be `undefined`
   * for anybody reading `live.current` early.
   *
   * Empty until the first render gets far enough to fill it, which is the same
   * state a payload the geometry cannot explain leaves it in: a cell that says
   * only its date, exactly as it did before this existed.
   */
  const startFloor = useRef<ReadonlyMap<string, string>>(new Map());

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
    dependenciesOf,
    dependOn,
    hasSchedule,
    showSchedule,
    depPicker,
    setDepPicker,
    depHover,
    setDepHover,
    setDepFocus,
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
    openCard,
    setHoveredCell,
    setFocusedCell,
    setNotBefore,
    setNotBeforeReason,
    setPriority,
    priorityBands,
    setParallelism,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    effectiveServiceLabelOf,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
    startDate,
    teams,
    tags,
    services,
    people,
    setTeamOf,
    setTagsOf,
    setServicesOf,
    createTeamFor,
    createServiceFor,
    createTagFor,
    assignTo,
    createPersonFor,
    toggleRole,
    spanOf,
    assigneeOn,
    nonOwnerNoteOf,
    waitsFor,
    matchIds: search.matchIds,
    filtering,
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
    dependenciesOf,
    dependOn,
    hasSchedule,
    showSchedule,
    depPicker,
    setDepPicker,
    depHover,
    setDepHover,
    setDepFocus,
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
    openCard,
    setHoveredCell,
    setFocusedCell,
    setNotBefore,
    setNotBeforeReason,
    setPriority,
    priorityBands,
    setParallelism,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    effectiveServiceLabelOf,
    editingNotBefore,
    openNotBefore,
    closeNotBefore,
    startDate,
    teams,
    tags,
    services,
    people,
    setTeamOf,
    setTagsOf,
    setServicesOf,
    createTeamFor,
    createServiceFor,
    createTagFor,
    assignTo,
    createPersonFor,
    toggleRole,
    spanOf,
    assigneeOn,
    nonOwnerNoteOf,
    waitsFor,
    matchIds: search.matchIds,
    filtering,
  };

  const columns = useMemo(
    () =>
      [
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
          // `#`, which is what a column of work item numbers is called on every
          // spreadsheet a reader of this table has ever used — and 105px of a
          // 1280px laptop is not where the word `Number` earns its eight
          // characters. The accessible name is the word, on the glyph itself:
          // `#` is punctuation a screen reader announces as "number sign" or
          // skips outright, and the column header is read once per cell by
          // anything walking the table.
          meta: { spokenHeading: 'Number' },
          header: () => <span>#</span>,
          cell: ({ row }) => (
            <span
              // The whole number, because the cell may not be showing all of it:
              // the column is sized to `NUMBER_ENVELOPE` and there is no longest
              // number to size it to instead, so a number past the envelope is
              // clipped by {@link CELL}'s `overflow: hidden` and read here. The
              // same bargain the short dates make.
              // `numberIndentFor`, the capped half of the indent pair: this
              // column's declared width is what the cap protects, and the share
              // it withholds past `DEEPEST_INDENT` is carried by the Name cell
              // beside it.
              title={row.original.number}
              style={{ paddingLeft: numberIndentFor(row.depth), whiteSpace: 'nowrap' }}
            >
              {/*
              No triangles while a search is on. What is open during a search
              is the search's answer — every kept row, so no match can be
              hidden — and this control would have to either lie about that or
              close a branch holding a hit. Its state also lives in the
              reader's own expansion, which the search deliberately does not
              touch, so a click here would appear to do nothing.
            */}
              <span data-caret-gutter style={{ display: 'inline-block', width: CARET_GUTTER_PX }}>
                {row.getCanExpand() && !live.current.filtering ? (
                  <button
                    type="button"
                    aria-label={`${row.getIsExpanded() ? 'Collapse' : 'Expand'} ${row.original.number}`}
                    onClick={row.getToggleExpandedHandler()}
                  >
                    {row.getIsExpanded() ? '▾' : '▸'}
                  </button>
                ) : null}
              </span>
              <span data-number>{row.original.number}</span>
              {/*
              After the number, not before it. A marker in front shifts the
              number right on the rows that have one, which is the same fault
              the gutter above exists to fix — and this one moves a row against
              its own siblings rather than against a whole depth.
            */}
              {row.original.frozenNumber !== null && <span aria-label="Number is frozen">🔒</span>}
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
            const nameCell = cellKey(row.original.id, 'name');
            const hovered = live.current.openCard === nameCell;
            return (
              <span
                // `block`, not `inline-block`: a shrink-to-fit wrapper and a
                // `width: 100%` textarea inside it define each other in a circle.
                // It is also the positioned ancestor the preview below is placed
                // against — which decides where the preview opens, not whether it
                // is clipped. The clipper is the `<td>`, and it is what
                // {@link POPOVER_COLUMNS} exempts.
                //
                // And it is what **closes** the preview, while the marker alone
                // opens it. The two halves are deliberately different elements:
                // the preview is the one card that scrolls, so reaching it means
                // putting the pointer on it, and the trip from a 7px glyph at the
                // top right of this cell down to a card hanging off its bottom
                // edge crosses the name box in between. With the leave on the
                // marker that trip unmounted the card before the pointer arrived
                // and a note taller than 320px could never be scrolled (codex
                // round 3, finding 1). This span contains the marker *and* the
                // card, so `mouseleave` on it fires only once the pointer is
                // outside both — no timer, no grace period, and the preview's
                // placement is untouched.
                // Proof: the handler put back on the marker, `keeps the preview
                // open while the pointer crosses the cell to reach it` failed on
                // `expected null not to be null`, and the browser's `scrolls a
                // note taller than the preview once the pointer is on it` on the
                // card being gone. Watched, 2026-08-09.
                onMouseLeave={() => {
                  // The same-cell guard every surface clears with: a leave fires
                  // after the enter of whatever the pointer moved on to, so an
                  // unconditional clear would close the card the next cell had
                  // just opened.
                  live.current.setHoveredCell((current) => (current === nameCell ? null : current));
                }}
                style={{
                  position: 'relative',
                  display: 'block',
                  maxWidth: '100%',
                  // The share of the indent the Number cell's cap withheld: zero
                  // until `DEEPEST_INDENT`, one step per level past it, so the
                  // outline the reader's eye adds up across the two cells —
                  // `hierarchyIndentFor` — keeps stepping right at every depth.
                  // On this cell and not the Number cell because Name is the
                  // flexible column: it has no declared width to outgrow and no
                  // pinned neighbour to be painted over.
                  // Proof: this line put back to `paddingLeft: 0` (the shipped
                  // state the cap flattened) — `hands the Name cell the share of
                  // the indent the Number cap withheld` failed on `expected
                  // { number: '48px', name: '0px' } to deeply equal { number:
                  // '48px', name: '12px' }`. Watched, 2026-08-10.
                  paddingLeft: hierarchyIndentFor(row.depth) - numberIndentFor(row.depth),
                }}
              >
                <CellInput
                  aria-label={`Name of ${row.original.number}`}
                  data-name-input={row.original.id}
                  data-match={matched ? 'true' : undefined}
                  cellKey={cellKey(row.original.id, 'name')}
                  // A work item's name is a sentence, not a word, and an input
                  // scrolls it out of sight one character at a time. A textarea
                  // wraps, and `autoSize` is what stops it wrapping into a line
                  // nobody can see: the box is as tall as its name, focused or
                  // not. It holds the notes under the name as well, and at rest
                  // they take no height at all — `restShowsFirstLineOnly` — so a
                  // plan reads as its names. The notes are read by writing in
                  // the cell or in the hover preview below; `maxRestRows` does
                  // not bind this cell, because a name is shown whole however
                  // many lines it wraps onto.
                  // Enter is still "new work item" — the table preventDefaults it.
                  multiline
                  autoSize
                  restShowsFirstLineOnly
                  rows={1}
                  style={{
                    // The cell's width, not a width of its own: `22em` was one of
                    // the three opinions that produced the overlap, and it is the
                    // colgroup's job now.
                    width: '100%',
                    boxSizing: 'border-box',
                    // No `resize` here. It said `vertical` until
                    // `table-mechanics`, and an inline property outranks every
                    // stylesheet: the grip that put a row out of line with its
                    // chart row was written from *this* object, not from
                    // Tailwind's preflight, and a rule in `styles.css` could not
                    // reach it. `[data-grid] textarea { resize: none }` is where
                    // the answer lives now, for this box and any other the grid
                    // grows — and it is load-bearing rather than a belt: with
                    // this line gone the browser's own default is `both`.
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
                    // The Name column only: any other column is a cell this one
                    // has no business focusing, and it is landed on from the
                    // committed DOM by the effect after a refresh.
                    focusIntent.current.landOnAttached(
                      element,
                      { rowId: row.original.id, columnId: 'name' },
                      gridElement.current,
                    );
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
                {row.original.notes.trim() !== '' && (
                  // The notes marker: the mark that says this row has notes, and
                  // the only thing that opens the preview.
                  //
                  // The cell itself opened it until 2026-08-09, and Dany's
                  // reading of the result is why it does not any more: the Name
                  // column is the widest thing on the way to anywhere in this
                  // table, and a rendered document over the rows below on every
                  // pass of the mouse is disruptive rather than helpful. The
                  // compact cards keep the whole cell — see the folded role
                  // cell — because a card three lines tall over a 96px cell
                  // costs a passing mouse nothing.
                  //
                  // It is also the "this row has notes" affordance
                  // `name-title-body` deliberately left out. That non-goal is
                  // superseded and not forgotten: with the notes clipped at rest
                  // *and* the trigger no longer the whole cell, an unmarked row
                  // would keep its notes from anybody who did not already know
                  // they were there.
                  //
                  // Not a control: no `tabIndex`, no `data-cell`, no click. The
                  // keyboard grid is a matrix of cells and a stop inside the Name
                  // cell would put a Tab between a name and the next column. Its
                  // hover area is its own 12px box and nothing wider, so a click
                  // aimed at the box under it lands there everywhere else.
                  //
                  // It opens the preview and does not close it: the leave belongs
                  // to the cell around it, for the reason that span gives.
                  //
                  // The a11y rule below is right that a non-interactive element
                  // should not act; this one does not — its `onMouseDown`
                  // forwards the press to the interactive box it sits on, which
                  // is the opposite of trapping it.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                  <span
                    role="img"
                    aria-label={`Notes on ${row.original.number}`}
                    data-notes-marker={row.original.id}
                    onMouseEnter={() => {
                      live.current.setHoveredCell(nameCell);
                    }}
                    // At 15px the glyph reads as clickable, and a click that
                    // did nothing would eat the caret aimed at the name under
                    // it. The name box takes it; the marker stays no control —
                    // no focus of its own, no tab stop.
                    onMouseDown={(pressed) => {
                      pressed.preventDefault();
                      pressed.currentTarget.parentElement?.querySelector('textarea')?.focus();
                    }}
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 1,
                      // Ink, not furniture: at 11px muted this was invisible at
                      // arm's length, and an affordance nobody sees marks
                      // nothing (Dany, 2026-08-09). The padding is hit area —
                      // the glyph is the hover target.
                      fontSize: 15,
                      fontWeight: 700,
                      padding: '1px 3px',
                      lineHeight: 1,
                      color: 'var(--foreground)',
                      cursor: 'default',
                    }}
                  >
                    ≡
                  </span>
                )}
                {/*
                The rendered reading of this work item, on hover over the marker
                above. A work item with no notes has nothing to reveal — its
                name is shown whole in the cell already, and it has no marker to
                hover. It hangs off the Name cell because that is where the note
                is written; the Notes column it used to hang off does not exist.
              */}
                {hovered && row.original.notes.trim() !== '' && (
                  <HoverPreview
                    name={row.original.name}
                    notes={row.original.notes}
                    number={row.original.number}
                  />
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'depends',
          header: 'Depends on',
          cell: ({ row }) => {
            // From the tree (`dependenciesOf` walks `flat`), never from the
            // rows on screen: a collapsed or filtered-out dependency has no row
            // to light, and the card naming it is then the only place it is
            // said at all.
            // Proof: narrowed to entries with a rendered `<tr>`, `a collapsed
            // dependency has no row to light, and the card still names it`
            // failed on `Unable to find an accessible element with the role
            // "tooltip"` — the hidden dependency dropped, the cell left with
            // nothing to say. Watched, 2026-08-10.
            const waitingFor = live.current.dependenciesOf(row.original.dependsOn);
            const dependsCell = cellKey(row.original.id, 'depends');
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
            // Nothing to expand where nothing is waited for, and the picker owns
            // the cell while it is open: both boxes hang off the bottom edge of
            // one 110px cell, and the one somebody is typing into is the one they
            // are looking at. `picker`, not `open`: a picker with nothing to
            // offer is still a cell being typed in.
            const cardable = waitingFor.length > 0 && picker === null;
            const carded = cardable && live.current.openCard === dependsCell;
            // What the card says, for a reader with no pointer. This cell cannot
            // answer a focus with the card the way the folded role cell does —
            // the focus here already belongs to the picker, which opens on it and
            // offers the rows this one could *start* waiting for, and stacking
            // two boxes over one 110px cell is what the design ruled out. So the
            // names are a description of the box instead, off the same
            // `waitingFor` list the card is built from. codex round 3, finding 2.
            // Proof: the `aria-describedby` dropped from the input, `describes the
            // box with what the row waits for, pointer or no pointer` failed on
            // `expected null to be 'depends-w3'`. Watched, 2026-08-09.
            const waitsForId = `depends-${row.original.id}`;
            return (
              <span
                // **No `onMouseEnter` here, and that is this change.** The
                // cell-level dependency hover used to be on this wrapper, which
                // stands *inside* the `<td>`'s padding box and, at the column's
                // own 110px, is filled edge to edge by the pills — so a reader
                // pointing at the cell got nothing, and the only place that
                // answered the whole-cell gesture was the 15.8px add button. It
                // is on the `<td>` now; see `dependsCellHoverProps`, and
                // `openspec/changes/table-width-budget/design.md` D2 for the
                // measurement.
                //
                // This wrapper carried `whiteSpace: 'normal'` until 2026-08-10,
                // with the rationale "an uneven row height is a cost worth
                // paying; a dependency nobody can see is not". The change
                // `deps-single-line` reverses that decision by name — and
                // `table-geometry-and-tab-order`'s "wraps its chips onto a
                // second line rather than clipping them" with it (archived at
                // openspec/changes/archive/2026-08-10-table-geometry-and-tab-order/)
                // — because the full list now lives in the DependsCard hover
                // and the box's sr-only description, so the cell no longer has
                // to be several lines tall to say it. At rest the strip below
                // clamps to one clipped line; the fade on it is the cue.
                //
                // The positioned ancestor the listbox below is placed against —
                // which is what decides *where* the list opens, not whether it
                // is clipped. The clipper is the `<td>`, and it is what
                // {@link POPOVER_COLUMNS} exempts.
                style={{
                  position: 'relative',
                  display: 'block',
                  maxWidth: '100%',
                }}
              >
                {waitingFor.length > 0 && (
                  <span id={waitsForId} className="sr-only">
                    {`Waiting for ${waitingFor.map(dependsLine).join(', ')}`}
                  </span>
                )}
                {/*
                The strip: the chips and the box, and nothing else — the
                popovers below hang from the wrapper, because this box clips
                and they must not be inside the clipper. At rest it is one
                flex line that does not wrap; while the picker owns the cell
                **and the cell has chips** it wraps exactly as the cell always
                did, so typing and the open list are unchanged (precedent:
                {@link CellInputProps.restShowsFirstLineOnly} — clamped at
                rest, whole while somebody is in it). `whiteSpace: 'nowrap'`
                is not decoration beside `flexWrap`: it is what keeps a
                squeezed chip's `✕` from folding under its number and growing
                the one line into two. The fade is the rest state's
                truncation cue — {@link DEP_EDGE_FADE} says why it belongs to
                rest and to nothing else. No `+N` marker: counting hidden
                variable-width pills means real layout measurement for
                marginal information.

                **And only with chips**, which is this change's own correction
                and not a tidy. `wrap` plus the box's `width: 100%` claim
                means the box can never share a flex line with anything: its
                hypothetical size is the whole strip, so the 13px `+` beside
                it pushed it onto a second line and made an *empty* cell grow
                the moment somebody clicked into it. Measured on dev at
                `2b2affec` in a cloud Chromium, 2026-08-11: a chipless row
                rested at **26px** and stood at **44.98px** with the picker
                open, the box dropping from `y=198` to `y=219.98` and taking
                the listbox 21px down the page with it — the affordance
                moving the list somebody had just opened to read. Clicking
                the cell and clicking the `+` measured identically, so it was
                the layout and not the button's handler.

                Wrapping only for chips returns the open empty cell to the
                geometry it has at rest — one line, the box shrunk past the
                `+` by `minWidth: 0` to the same `84.2px` it rests at — and
                leaves the crowded cell's open state untouched, which is the
                half `deps-single-line` measured. The `+` was not hidden
                instead: always on screen is the whole of what it is for
                (Dany, 2026-08-11), and a cell somebody is typing into is
                where an affordance saying "another one" has most to say.

                Proof: the rest branch's `flexWrap` forced to `'wrap'`,
                `clamps the chips and the box onto one nowrap line at rest`
                failed on `expected 'wrap' to be 'nowrap'`. Watched,
                2026-08-10. The chipless half is its own check, below. The
                row height itself — seven chips no taller than none, a
                clipped chip invisible, an empty cell no taller open than
                shut — is Chromium's proof, in `e2e/deps-cell.spec.ts`.
              */}
                <span
                  data-depends-strip={row.original.id}
                  data-reference-strip=""
                  style={{
                    ...REFERENCE_SET_STRIP_STYLE,
                    // Wrapping is for the chips, and only for them. See the
                    // block above: an empty cell has nothing to wrap, and the
                    // wrap is what made it two lines tall the moment it was
                    // clicked into.
                    flexWrap: picker !== null && waitingFor.length > 0 ? 'wrap' : 'nowrap',
                    gap: 2,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    // Pinned, in one line: the mask above fades the *physical*
                    // right edge — the app is LTR-only today, and a
                    // logical-direction gradient is not portable syntax.
                    direction: 'ltr',
                    ...(picker === null
                      ? { WebkitMaskImage: DEP_EDGE_FADE, maskImage: DEP_EDGE_FADE }
                      : {}),
                  }}
                >
                  {/*
                  The add affordance, first on the strip's line and always on
                  it. Adding a dependency has only ever been discoverable by
                  knowing that the cell's box is a box — a rested cell full of
                  chips shows `010 ✕ 030 ✕` and nothing that says another one
                  can be added (Dany, 2026-08-11). This is that affordance, and
                  it triggers exactly the flow a click in the cell already
                  triggers: the box takes the focus, and the box's own
                  `onFocus` opens the picker ready to type.

                  **First, not last.** The strip clips its right edge and fades
                  the last {@link DEP_EDGE_FADE} pixels of it; a trailing
                  affordance in a cell waiting on seven rows would be clipped
                  out of sight in exactly the crowded cell that needs it most,
                  and the box's `width: 100%` claim would have pushed it there
                  on an empty one too. The leading edge is the one place on a
                  clipping `nowrap` line that is never cut. Proven in Chromium
                  — `keeps the add button visible in a cell whose chips are
                  clipped`, `e2e/deps-cell.spec.ts` — because whether a box is
                  clipped is a layout fact and jsdom lays nothing out (R5
                  #14–16).

                  Sized as a chip and no larger: the row rests at 28px and the
                  chips are what set that line's height, so an affordance built
                  to their `line-height` costs the row nothing. `flexShrink: 0`
                  because a squeezed cell must clip chips rather than crush
                  this.
                */}
                  <button
                    type="button"
                    data-dep-add={row.original.id}
                    data-reference-add=""
                    className={REFERENCE_SET_ADD_CLASS}
                    // Not `Add a dependency to 020` — that is the box's own
                    // label, and two controls in one cell answering to one name
                    // is a reader told the same thing twice with no way to tell
                    // which is which. The chips' voice instead: they say `Stop
                    // 020 waiting for 030`, so this says what it starts.
                    //
                    // No `title` beside it. `Add a dependency` was one, and a
                    // tooltip reading one thing while the accessible name reads
                    // another is the control answering to two names — the exact
                    // fault the name above was chosen to avoid, reintroduced by
                    // the attribute that was meant to explain it (codex review,
                    // 2026-08-11). The sighted reader has the `+`; anyone who
                    // needs words has the name.
                    aria-label={`Make ${row.original.number} wait for something`}
                    // Deliberately not a tab stop, at rest and with the picker
                    // open alike — where the chips flip (`deps-single-line`).
                    // The keyboard already has this exact path and reaches it
                    // first: Tab into the cell lands on the box, and the box's
                    // focus is what opens the picker. A stop here would add one
                    // Tab per row to every walk through the plan and offer
                    // nothing at the end of it that the next Tab does not
                    // already do. It stays a `<button>` with a name, so a
                    // reader's element walk still finds it; what it does not do
                    // is stand in the sequential order.
                    tabIndex={-1}
                    onMouseDown={(pressed) => {
                      // The press must not move the focus. Without this the
                      // button takes it, and a button taking the focus from this
                      // cell's *own* box is a blur — which closes the picker and
                      // drops what was typed into it (the box's `onBlur`, this
                      // cell's contract since it was written). Somebody who
                      // types `03` and then reaches for the affordance beside it
                      // would lose the search to the control that means "search".
                      // The precedent is the Name cell's notes marker, which
                      // forwards its press to the box under it the same way.
                      //
                      // The click below still fires — `preventDefault` on
                      // `mousedown` suppresses the focus, not the click (R5 #14's
                      // lesson, read the other way round). And the action lives
                      // there rather than here for two reasons: a `mousedown`
                      // that re-renders before the browser performs its default
                      // action is R5 #12's fault class, and an assistive
                      // technology's activation dispatches a click with no
                      // `mousedown` at all.
                      pressed.preventDefault();
                    }}
                    onClick={(pressed) => {
                      // The box is this button's sibling on the strip — the same
                      // reach the notes marker makes, scoped by the row's own id
                      // so a stale query can never focus another row's cell.
                      pressed.currentTarget.parentElement
                        ?.querySelector<HTMLInputElement>(
                          `[data-depends-input="${row.original.id}"]`,
                        )
                        ?.focus();
                    }}
                    style={{ flexShrink: 0 }}
                  >
                    +
                  </button>
                  {/*
                  How many rows this one waits for, on the leading edge beside
                  the `+` because that is the only place on a clipping `nowrap`
                  line that is never cut — the same reason the add affordance is
                  first (see the block above it).

                  **This is not the `+N` the block above ruled out**, and the
                  difference is the whole design. That marker was to be the
                  count of the *hidden* chips, which is a layout fact: it needs
                  the strip measured, a `ResizeObserver` on every deps cell, and
                  a number that changes when the column is dragged. This is the
                  count of the *dependencies*, which is data the cell already
                  holds — `waitingFor.length`, the same list the sr-only line
                  and the hover card are built from. It cannot be stale and it
                  needs nothing measured.

                  Filed by `wbs-e2e-planning-qa` on dev: `020` waits for four
                  rows, `030` five, `060` six, and every one of them showed two
                  clipped chips with no count anywhere — so the planner reading
                  the cell had no way to know the chips were a sample, and the
                  one dependency that explains the row's start is exactly the
                  one off the right edge. The fade said "there is more" to
                  somebody already looking for it; a number says how much more.

                  Only past one, because a single chip is the whole truth and a
                  `1` beside it is a second way of saying what is already said —
                  noise in a 110px cell whose every pixel is a chip that does
                  not fit.

                  `aria-hidden`, and that is deliberate rather than an omission:
                  the cell already tells a reader `Waiting for 010 - Strip, …`
                  in full through {@link waitsForId}, so a count spoken beside
                  it would be a third voice in one cell saying less than the
                  second. The `title` is for the pointer, which has no such
                  line — and a `title` on a non-interactive span is not the
                  "control answering to two names" the add button refuses,
                  since this span has no accessible name to contradict.
                */}
                  {waitingFor.length > 1 && (
                    <span
                      data-dep-count={row.original.id}
                      aria-hidden="true"
                      title={`Waits for ${String(waitingFor.length)} rows`}
                      style={{ flexShrink: 0 }}
                    >
                      {waitingFor.length}
                    </span>
                  )}
                  {waitingFor.map(({ id, number }) => (
                    <button
                      key={id}
                      type="button"
                      data-reference-chip={id}
                      className={`${REFERENCE_SET_CHIP_CLASS} border-0`}
                      aria-label={`Stop ${row.original.number} waiting for ${number}`}
                      title="Remove this dependency"
                      // Out of the tab order while the strip is clipped: a
                      // clipped chip is a native button a sequential Tab could
                      // still reach, invisible, and the browser may scroll the
                      // `overflow: hidden` strip to show what it focused —
                      // shifting the rested layout. With the picker open the
                      // strip wraps, every chip is on screen, and the ✕ is
                      // focusable the way a visible button should be. Keyboard
                      // removal is unchanged: Tab enters the cell at the box,
                      // the picker opens on the focus, the chips are back.
                      // Proof: the condition dropped (chips always focusable),
                      // `keeps clipped chips out of the tab order at rest`
                      // failed on `expected +0 to be -1`. Watched, 2026-08-10.
                      tabIndex={picker === null ? -1 : undefined}
                      // The pill-level hover: this one dependency's row alone,
                      // and the card's emphasis with it. A chip the strip has
                      // clipped simply has no hover target — the cell-level
                      // enter above still lights every dependency's row, which
                      // is the U3→U4 case named in the plan rather than
                      // discovered.
                      onMouseEnter={() => {
                        live.current.setDepHover((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? current
                            : { rowId: row.original.id, pillId: id },
                        );
                      }}
                      onMouseLeave={() => {
                        // Off the pill but still in the cell: back to the whole
                        // waited-for set, not cleared — the wrapper's own leave
                        // is what clears. Guarded on this pill's id so a leave
                        // that lands after the next pill's enter cannot widen
                        // the hover that enter just narrowed.
                        // Proof: the restore dropped (leave returning
                        // `current`), `narrows to the pill's row, and widens
                        // again when the pill is left` failed on `expected
                        // ['010'] to deeply equal ['010', '020']`. Watched,
                        // 2026-08-10.
                        live.current.setDepHover((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? { rowId: row.original.id, pillId: null }
                            : current,
                        );
                      }}
                      // The keyboard's reading of the same pill — see
                      // {@link depFocus}. The enter/leave pair above, with focus
                      // in place of the pointer, and one difference: the blur
                      // *clears* where the leave widens. A leave means the
                      // pointer is still in the cell (the wrapper's own leave is
                      // what clears); a blur means nothing of the sort, and
                      // widening on it would leave the cell lit forever once the
                      // focus walked out of the plan from a chip. Focus moving
                      // chip → box relights the cell from the box's own focus,
                      // which fires after this blur.
                      onFocus={() => {
                        live.current.setDepFocus((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? current
                            : { rowId: row.original.id, pillId: id },
                        );
                      }}
                      onBlur={() => {
                        live.current.setDepFocus((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? null
                            : current,
                        );
                      }}
                      onClick={() => {
                        // This button *is* the pill, so the click unmounts it and
                        // no `mouseleave` or `blur` of its own ever arrives: the
                        // hover would stay on an id the cell no longer names and
                        // keep the cut edge's row lit under a pointer that had
                        // not moved. The pointer *is* still in the cell, so this
                        // widens to the cell itself — exactly what the leave that
                        // cannot fire would have done, which is why the light
                        // goes to the remaining dependencies rather than out.
                        // Focus is cleared instead, for the reason `onBlur` above
                        // gives. `depLit` refuses a `pillId` the cell no longer
                        // names as well: this end is the pointer's truth, that
                        // end is the paint's.
                        //
                        // Proof: this widen dropped, `widens back to the
                        // remaining dependencies when a pill is deleted under the
                        // pointer` failed on `expected [] to deeply equal
                        // ['020']` — the light gone from a cell the pointer was
                        // still in. Watched, 2026-08-11.
                        live.current.setDepHover((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? { rowId: row.original.id, pillId: null }
                            : current,
                        );
                        live.current.setDepFocus((current) =>
                          current?.rowId === row.original.id && current.pillId === id
                            ? null
                            : current,
                        );
                        void live.current.run(() =>
                          live.current.api.removeDependency(row.original.id, id),
                        );
                      }}
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
                    aria-describedby={waitingFor.length > 0 ? waitsForId : undefined}
                    placeholder="search, or 010, 020"
                    title="Type to search by number or name, or a list of numbers separated by commas or spaces"
                    // `minWidth: 0` is what lets the box shrink behind the chips
                    // on the strip's one rested line: a flex item's automatic
                    // minimum would hold an `<input>` at its intrinsic width and
                    // push its rect out past the cell. `100%` is still its claim
                    // — the whole cell where it has the line to itself, the
                    // remainder where it does not.
                    style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
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
                      // The keyboard's cell-level light — see {@link depFocus}.
                      // This is the reachable half: Tab through the plan lands on
                      // this box, and the rows the row waits for light while it
                      // is here. Guarded on having something to say by the same
                      // rule the wrapper's `mouseenter` uses.
                      if (waitingFor.length > 0) {
                        live.current.setDepFocus({ rowId: row.original.id, pillId: null });
                      }
                    }}
                    onBlur={() => {
                      live.current.setDepPicker((current) =>
                        current?.rowId === row.original.id ? null : current,
                      );
                      // Only the cell-level focus this box owns. `pillId === null`
                      // in the guard and not just the row: focus moving box → chip
                      // fires this blur *before* the chip's focus, and without the
                      // field in the guard a later blur could not tell its own
                      // reading from the chip's.
                      live.current.setDepFocus((current) =>
                        current?.rowId === row.original.id && current.pillId === null
                          ? null
                          : current,
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
                      if (escapesAnOpenList(e)) {
                        // The eight keys the list may not swallow: the four
                        // motion chords out of this cell and the four row moves
                        // under it. This box opens its list on **focus**, so
                        // without this branch Ctrl+L into it had no documented
                        // way out — see {@link escapesAnOpenList}, which is where
                        // the split between these and the chords that make or
                        // destroy a row is argued.
                        //
                        // Before the ArrowUp/ArrowDown branch below on purpose:
                        // that one reads no modifiers, so an Alt+↑ aimed at the
                        // row would have moved the list's highlight instead.
                        live.current.onAltMove(e, row.original, 'depends');
                        live.current.onCommandKey(e, row.original, 'depends');
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
                        // that make and destroy a row reach it. Open, the list
                        // owns those — the routing matrix's inert row, narrowed
                        // by the branch above to the chords that act on a row
                        // rather than merely leaving the cell.
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
                        void live.current.pickDependency(row.original.id, activeOption.id);
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
                </span>
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
                      // Tokens and not `#fff`/`#ccc`: this list is the one
                      // popover in the app that never took the palette, so on a
                      // dark page it stayed a white card with near-white text on
                      // it — 1.05:1, measured. `CreatablePicker`'s `PickerList`
                      // has read `--popover` since it was written; this is the
                      // same surface saying the same thing.
                      background: 'var(--popover)',
                      color: 'var(--popover-foreground)',
                      border: '1px solid var(--border)',
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
                          color:
                            entry.refusal === undefined ? undefined : 'var(--muted-foreground)',
                          // No `background` here at all any more. `#e8f0fe` was
                          // an inline style that outranked the stylesheet's own
                          // `[data-grid] [role='option'][aria-selected='true']`
                          // rule — which paints `var(--accent)` and has been
                          // there all along — so the keyboard's highlight was a
                          // fixed pale blue while the pointer's followed the
                          // palette. One rule now answers for both.
                        }}
                        onClick={() => {
                          if (entry.refusal !== undefined) return;
                          void live.current.pickDependency(row.original.id, entry.id);
                        }}
                      >
                        {/*
                        `010 - Strip the hull`, the way the plan is spoken
                        about: a space alone let a number and a name that starts
                        with a digit run together. The filter behind the list
                        already matches either half (`pickerEntries`).
                      */}
                        {entry.number} - {entry.name}
                        {entry.refusal === undefined ? '' : ` — ${REFUSAL_SUFFIX[entry.refusal]}`}
                      </li>
                    ))}
                  </ul>
                )}
                {carded && (
                  <DependsCard
                    number={row.original.number}
                    entries={waitingFor}
                    // This cell's pill hover and no other's: a card is only on
                    // screen for the hovered cell, but the guard keeps a stale
                    // `depHover` from another row emphasising an entry here.
                    // Proof: hardcoded to null, `emphasises the pill's entry in
                    // the card as a background, not bold` failed on `expected
                    // '' to be 'var(--card-dep-lit)'`. Watched, 2026-08-11.
                    emphasisedId={
                      live.current.depHover?.rowId === row.original.id
                        ? live.current.depHover.pillId
                        : null
                    }
                    onPointEntry={(pillId) => {
                      live.current.setDepHover((current) =>
                        current?.rowId === row.original.id && current.pillId === pillId
                          ? current
                          : { rowId: row.original.id, pillId },
                      );
                    }}
                    onPointerOutside={() => {
                      live.current.setDepHover((current) =>
                        current?.rowId === row.original.id ? null : current,
                      );
                      live.current.setHoveredCell((current) =>
                        current === dependsCell ? null : current,
                      );
                    }}
                  />
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'priority',
          // `Prio`, not `Priority` and not `PRIORITY`: the column is 48px and the
          // header row is 10px all-caps, in which the full word wraps to two
          // lines and takes the whole header row with it. The sentence is on the
          // `<th>` (`column-hints.ts`), which is the bargain Days, Not bef.,
          // Start, End and Slack already make.
          header: () => <span>Prio</span>,
          cell: ({ row }) => (
            /*
            The box, the band list under it, and the colour the number is drawn
            in — all three in `priority-cell.tsx`, so the one place a band becomes
            a colour is `priority-band-style.ts` and this column has no opinion of
            its own about it.

            The ladder is read off `live.current` rather than closed over, which
            is this file's oldest landmine: `columns` depends on `roles` alone,
            and a second dependency remounts every cell in the table and eats the
            focus somebody is typing in. A re-cut ladder redraws because the rows
            redraw.
          */
            <PriorityCell
              cellKey={cellKey(row.original.id, 'priority')}
              rowNumber={row.original.number}
              rowId={row.original.id}
              bands={live.current.priorityBands}
              priority={row.original.priority}
              commit={(typed) => live.current.setPriority(row.original.id, typed)}
              // A picked line is the same write a typed number is — one `patch`,
              // one journal entry, one undo — which is what makes the two languages
              // round-trip into each other rather than into two histories.
              choose={(value) => {
                void live.current.setPriority(row.original.id, String(value));
              }}
              onEnter={(box) => {
                void flushCell(box);
              }}
              onGridKey={(e) => {
                live.current.onAltMove(e, row.original, 'priority');
                live.current.onCommandKey(e, row.original, 'priority');
                live.current.onTabKey(e, row.original.id, 'priority');
                live.current.onArrowKey(e, row.original.id, 'priority');
              }}
            />
          ),
        }),
        column.display({
          id: 'team',
          header: 'Teams',
          cell: ({ row }) => {
            // A row with no label of its own still belongs to a team, wherever an
            // ancestor named one — and the plan's dates were computed against
            // that team's people. The cell says so in the box's own muted
            // placeholder ink, which is exactly the "shown but not stored"
            // distinction a placeholder already means: it is gone the moment
            // somebody types a label of this row's own, and nothing about it is
            // sent anywhere. `↳` is the inheritance, in one glyph the 120px
            // column can afford.
            //
            // No write copies a label down. This is a reading of the tree and it
            // is recomputed from the tree every render; the day somebody moves
            // the row, its answer changes with it.
            const inherited = live.current.effectiveTeamLabelOf(row.original);
            return (
              <ReferenceSetStrip
                label={`Service or team for ${row.original.number}`}
                addLabel={`Add a team to ${row.original.number}`}
                placeholder={
                  inherited.state === 'inherited' ? `↳ ${inherited.name}` : 'search or add'
                }
                title={
                  inherited.state === 'inherited'
                    ? `${inherited.name} — inherited from ${inherited.fromRow}. This row carries no team of its own.`
                    : undefined
                }
                adapter={{
                  kind: 'team',
                  entries: live.current.teams,
                  ownIds: row.original.teamIds,
                  inheritedLabel: inherited.state === 'inherited' ? inherited.name : undefined,
                  replace: (teamIds) => live.current.setTeamOf(row.original.id, teamIds),
                  create: (name, current) =>
                    live.current.createTeamFor(row.original.id, name, current),
                }}
                gridCell={{
                  dataCell: cellKey(row.original.id, 'team'),
                  onTabKey: (e) => {
                    live.current.onTabKey(e, row.original.id, 'team');
                  },
                  onCommandKey: (e) => {
                    live.current.onCommandKey(e, row.original, 'team');
                  },
                  onAltMove: (e) => {
                    live.current.onAltMove(e, row.original, 'team');
                  },
                }}
              />
            );
          },
        }),
        column.display({
          id: 'tag',
          header: 'Tags',
          cell: ({ row }) => {
            // The same reading the Team cell makes, one dimension over: a row
            // with no tags of its own still *is* whatever an ancestor said it
            // was, and the placeholder says so in the box's own muted ink with
            // `↳` for the inheritance.
            const inherited = live.current.effectiveTagLabelOf(row.original);
            const own = row.original.tagIds;
            return (
              <ReferenceSetStrip
                label={`Tags for ${row.original.number}`}
                addLabel={`Add a tag to ${row.original.number}`}
                removeLabel={(entry) => `Remove ${entry.name} from ${row.original.number}`}
                placeholder={
                  own.length > 0
                    ? 'add'
                    : inherited.state === 'inherited'
                      ? `↳ ${inherited.names.join(', ')}`
                      : 'search'
                }
                title={
                  own.length === 0 && inherited.state === 'inherited'
                    ? `${inherited.names.join(', ')} — inherited from ${inherited.fromRow}. This row carries no tag of its own.`
                    : undefined
                }
                adapter={{
                  kind: 'tag',
                  entries: live.current.tags,
                  ownIds: own,
                  inheritedLabel:
                    inherited.state === 'inherited' ? inherited.names.join(', ') : undefined,
                  replace: (tagIds) => live.current.setTagsOf(row.original.id, tagIds),
                  create: (name, current) =>
                    live.current.createTagFor(row.original.id, name, current),
                }}
                gridCell={{
                  dataCell: cellKey(row.original.id, 'tag'),
                  onTabKey: (e) => {
                    live.current.onTabKey(e, row.original.id, 'tag');
                  },
                  onCommandKey: (e) => {
                    live.current.onCommandKey(e, row.original, 'tag');
                  },
                  onAltMove: (e) => {
                    live.current.onAltMove(e, row.original, 'tag');
                  },
                }}
              />
            );
          },
        }),
        column.display({
          // **The column id stays `service` while the header reads `Services`.**
          // The id is what `DEFAULT_HIDDEN_COLUMNS`, `cellKey`, the grid's
          // Tab/Alt/Command routing and every saved column-order key are written
          // against; renaming it would move 120px around and rewrite people's
          // stored layouts to say the same thing. The header is the word a
          // reader sees, and since task 10.4 a row can carry several.
          id: 'service',
          header: 'Services',
          cell: ({ row }) => {
            // The **tags** cell's control since task 10.4, where 7.1 built the
            // team cell's: a chip per service the row states, each with its own
            // ✕, and a picker beside them that adds one. A row that states none
            // of its own still **is** delivered by whatever an ancestor said, and
            // the placeholder says so in the box's own muted ink with `↳` for the
            // inheritance — that half is unchanged, because inheritance is per
            // dimension and blank still means inherit.
            //
            // The single-select this replaces was D2's shape: one service, one
            // nullable column. The 2026-08-21 scope change made it a set and
            // task 10.2 made the store a join table, so a single-select was by
            // then a control that could not express what the row already held.
            const inherited = live.current.effectiveServiceLabelOf(row.original);
            const own = row.original.serviceIds;
            // Task 7.2's first marker, on the cell its signal is about. The
            // **effective** reading, so a leaf inheriting a service it is not
            // owned to build is marked where the inheritance put the service —
            // which is why the note comes off `nonOwnerNoteOf` and not off
            // `own` above it, and why a row stating no service of its own can
            // still wear it.
            const nonOwner = live.current.nonOwnerNoteOf(row.original);
            return (
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 2, minWidth: 0 }}>
                {nonOwner !== null && <MismatchMark kind="service" note={nonOwner} />}
                <ReferenceSetStrip
                  label={`Services for ${row.original.number}`}
                  addLabel={`Add a service to ${row.original.number}`}
                  removeLabel={(entry) => `Remove ${entry.name} from ${row.original.number}`}
                  placeholder={
                    own.length > 0
                      ? 'add'
                      : inherited.state === 'inherited'
                        ? `↳ ${inherited.names.join(', ')}`
                        : 'search'
                  }
                  title={
                    own.length === 0 && inherited.state === 'inherited'
                      ? `${inherited.names.join(', ')} — inherited from ${inherited.fromRow}. This row carries no service of its own.`
                      : undefined
                  }
                  adapter={{
                    kind: 'service',
                    entries: live.current.services,
                    ownIds: own,
                    inheritedLabel:
                      inherited.state === 'inherited' ? inherited.names.join(', ') : undefined,
                    replace: (serviceIds) =>
                      live.current.setServicesOf(row.original.id, serviceIds),
                    create: (name, current) =>
                      live.current.createServiceFor(row.original.id, name, current),
                  }}
                  gridCell={{
                    dataCell: cellKey(row.original.id, 'service'),
                    onTabKey: (e) => {
                      live.current.onTabKey(e, row.original.id, 'service');
                    },
                    onCommandKey: (e) => {
                      live.current.onCommandKey(e, row.original, 'service');
                    },
                    onAltMove: (e) => {
                      live.current.onAltMove(e, row.original, 'service');
                    },
                  }}
                />
              </span>
            );
          },
        }),
        column.display({
          id: 'in-parallel',
          meta: { spokenHeading: 'People at once' },
          // A two-person mark, not `In parallel` and not `PAR`: the column is
          // 32px at a 10px all-caps header, in which even three letters wrap.
          // The `∥` it replaced read as "parallel" to a reader who had not
          // already been told — two people is the shortest thing that reads as
          // "at once" unprompted, and it is not a font glyph, so no platform
          // renders it as a box. The sentence is the accessible name
          // (`meta.spokenHeading`, announced by screen readers) and the
          // `title` — the bargain Prio, Days, Not bef., Start, End and Slack
          // already make. The `title` is on the `<th>` since `wbs-column-hints`,
          // where every column's is, and this one is the shape the rest were
          // written to.
          header: () => (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          ),
          cell: ({ row }) => {
            const own = row.original.maxParallel;
            const hasChildren = row.subRows.length > 0;
            /**
             * Who be-01's `widthFor` reads for one role of this leaf — its own
             * assignee, or the row's single assumed one. The same fallback
             * `assigneeOn` reads two columns back, because `widthFor` is built
             * from exactly this pair (`work-item.service.ts`'s `personFor`).
             */
            const personForRole = (roleId: string): string | null =>
              row.original.assignees[roleId] ?? row.original.doesEveryPhase ?? null;
            const estimatedRoles = Object.keys(row.original.estimates);
            /**
             * Whether **every** slice `widthFor` would cut this leaf into is
             * pinned to width 1 by a named person — the only reading that
             * agrees with be-01, which collapses **per slice** and not per row.
             *
             * `doesEveryPhase` alone used to stand in for this and is still the
             * right answer for a leaf with one role, or with several roles and
             * one assumed assignee — but it is `null` the moment a *second*
             * role gets its own explicit name, because `assumedAssignee`
             * requires exactly one named assignment project-wide on the row.
             * Two roles on two different people each still collapse their own
             * slice to width 1; the row-level reading just stopped being able
             * to say so.
             */
            const everySliceNamed =
              estimatedRoles.length > 0
                ? estimatedRoles.every((roleId) => personForRole(roleId) !== null)
                : row.original.doesEveryPhase !== null;
            // Three states the cell renders differently, and each of them is a
            // fact the reader cannot get anywhere else:
            //
            // - a **parent** holds no slices of its own, so `slicesOf` skips it
            //   and a number on it schedules nothing. The write path answers 400
            //   `has_children`; the cell is read-only rather than offering an
            //   edit be-01 refuses. A leaf that later gained a child keeps
            //   whatever it was given, inert, and the cell says so.
            // - a leaf whose **every estimated role** is named runs each of
            //   those slices at width 1 whatever this says (D3): one human
            //   cannot work beside themselves. The number is still stored and
            //   still applies the moment a name comes off, so it is shown muted
            //   rather than hidden.
            // - anything else is an ordinary editable number.
            const inert = hasChildren || (everySliceNamed && own > 1);
            const why = hasChildren
              ? 'This row has children, so it holds no work of its own. The number is kept and does nothing.'
              : everySliceNamed && own > 1
                ? 'Everybody on this work is named, so it runs one at a time whatever this says.'
                : own > 1
                  ? `${String(own)} people at once. The item's effort is compressed across them, up to the team's size.`
                  : 'How many people may work on this item at once. Blank means one at a time.';
            if (hasChildren) {
              return (
                <span
                  data-in-parallel={row.original.id}
                  title={why}
                  className="text-muted-foreground block text-right"
                >
                  {own > 1 ? String(own) : ''}
                </span>
              );
            }
            return (
              <CellInput
                aria-label={`People at once for ${row.original.number}`}
                cellKey={cellKey(row.original.id, 'in-parallel')}
                data-in-parallel={row.original.id}
                inputMode="numeric"
                title={why}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  font: 'inherit',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'right',
                  // Muted where the number is stored and not applied, which is
                  // the one thing a reader of a `3` beside a named person cannot
                  // work out. `opacity` rather than a colour token so the value
                  // stays the cell's own ink in either theme.
                  opacity: inert ? 0.55 : undefined,
                }}
                onKeyDown={(e) => {
                  // Enter saves, exactly as the Prio cell one column back does
                  // and for its reason — see the comment there.
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                    e.preventDefault();
                    void flushCell(e.currentTarget);
                    return;
                  }
                  live.current.onAltMove(e, row.original, 'in-parallel');
                  live.current.onCommandKey(e, row.original, 'in-parallel');
                  live.current.onTabKey(e, row.original.id, 'in-parallel');
                  live.current.onArrowKey(e, row.original.id, 'in-parallel');
                }}
                // Blank at 1, which is every row of every plan nobody has widened
                // — the Prio column's bargain, for the same reason: a column of
                // `1`s down a plan that runs one at a time is furniture.
                value={own > 1 ? String(own) : ''}
                commit={(typed) => live.current.setParallelism(row.original.id, typed)}
              />
            );
          },
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
                  // button is about the three points and nothing else. It said
                  // "any other role folds" until `unfolding-may-scroll`, and no
                  // other role folds now; what the reader is owed instead is
                  // that the table may become wider than the window, which is
                  // the one thing unfolding can do that it could not before.
                  // The column's own sentence first, then the toggle's: this
                  // button covers most of its `<th>`, so a title naming only the
                  // fold would be the one heading in the table where hovering
                  // teaches nothing about the column (`column-hints.ts`).
                  title={`${ROLE_FINAL_HINT} ${
                    unfolded
                      ? 'Click to fold the three points back into the figure.'
                      : 'Click to show the three points; the table may scroll sideways.'
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
                const problem = unfolded
                  ? null
                  : live.current.combinedProblem(row.original, role.id);
                // The whole trio in one cell, but only where both halves of that
                // sentence hold: a folded role, so the three boxes are not on
                // screen to disagree with it, and a leaf, because a parent's
                // figure is a sum of what is below it and nothing to type into.
                const shorthand = !unfolded && !row.original.rolledUp;
                // Nobody on this role and exactly one person on another: they are
                // assumed to be doing this phase too. The same rule the unfolded
                // column has, in the cell that is always on screen — which is the
                // whole reason the assignee stopped folding away. Read through
                // {@link assigneeOn}, which is where a card reads it too.
                const doing = live.current.assigneeOn(row.original, role.id);
                // Only while this role is folded: unfolded, the assignee has a
                // column of its own with a picker in it, and two ways to assign
                // one person side by side is two things to keep in step.
                const options = unfolded ? [] : live.current.mentionOptions(row.original, role.id);
                const listId = `mention-${row.original.id}-${role.id}`;
                const finalCell = cellKey(row.original.id, `${role.id}-final`);
                // The card opens on the cell itself — not on a marker, the way
                // the Name cell's preview does. The difference is size: this one
                // is four lines over a 96px cell, so a mouse crossing the column
                // is told something rather than interrupted.
                //
                // Not while a mention is being typed in this cell, because the
                // list and the card open from the bottom edge of this same
                // wrapper and the one somebody is typing into owns the cell.
                //
                // The **mention**, not its entries. Reading `options.length === 0`
                // was the same rule for every case but one, and that one is
                // reachable: a deployment with nobody on it yet answers a bare `@`
                // with no entries at all — nobody to match, and no `Add "…"` until
                // something follows the `@` — so the card opened over a box being
                // typed into. agy round 3, finding 7.
                // Proof: put back to `options.length === 0`, `keeps the cell to a
                // mention that has nobody to offer` failed on `expected 'Dev…' to
                // contain 'QA'`. Watched, 2026-08-09.
                const openMention = live.current.mention;
                const mentioning =
                  openMention?.rowId === row.original.id && openMention.roleId === role.id;
                const cardable = !unfolded && !mentioning;
                const carded = cardable && live.current.openCard === finalCell;
                // The card's own id, which the box below points
                // `aria-describedby` at while it is open — this cell's answer to
                // "a card only a pointer can open is data withheld from anybody
                // who does not use one" (codex round 3, finding 2). The box is
                // the cell's only focusable thing, so it is the one that can
                // carry it; a parent's rolled-up figure has no box and no
                // keyboard route, which is its own entry in `design.md`.
                const cardId = `folded-${row.original.id}-${role.id}`;
                return (
                  <span
                    data-final={role.id}
                    onMouseEnter={() => {
                      // No card to show, no state written: {@link hoveredCell}
                      // lives on the table and a write of it renders all of it.
                      // See the depends cell's own enter for the whole of it.
                      if (!cardable) return;
                      live.current.setHoveredCell(finalCell);
                    }}
                    onMouseLeave={() => {
                      // The same-cell guard the Name cell's marker gives its
                      // reason for: a leave lands after the enter of whatever the
                      // pointer moved on to.
                      live.current.setHoveredCell((current) =>
                        current === finalCell ? null : current,
                      );
                    }}
                    // No native `title` here or on the input below: the card is
                    // this cell's one hint (CONTEXT.md, "Hover preview"), and a
                    // browser tooltip raced it over the same pixels. The
                    // complaint still marks the figure (the `!` and the colour)
                    // and rides the card.
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
                      // The focus-opened card goes with the focus. Guarded like
                      // every other clear: a blur can land after the next cell has
                      // already taken the focus.
                      live.current.setFocusedCell((current) =>
                        current === finalCell ? null : current,
                      );
                    }}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'baseline',
                      maxWidth: '100%',
                      minWidth: 0,
                      fontWeight: 600,
                      color: problem === null ? undefined : 'var(--destructive)',
                    }}
                  >
                    {shorthand ? (
                      <CellInput
                        aria-label={`${role.name} estimate for ${row.original.number}`}
                        // In the keyboard grid, which is what makes Down-type-
                        // Down-type work down a role's column. Proof: dropped,
                        // `is a cell of the keyboard grid, so a column can be
                        // typed down` fails. Watched, 2026-08-06.
                        cellKey={cellKey(row.original.id, `${role.id}-final`)}
                        role="combobox"
                        aria-expanded={options.length > 0}
                        aria-controls={options.length > 0 ? listId : undefined}
                        // Which line Enter takes, for a reader who cannot see
                        // the highlight — `CreatablePicker`'s rule, carried to
                        // the one list it does not render. Cleared with
                        // `aria-controls` the moment the list closes, because
                        // both read the same `options.length > 0`.
                        aria-activedescendant={
                          options.length > 0 ? pickerOptionId(listId, 0) : undefined
                        }
                        aria-autocomplete="list"
                        placeholder="o/r/p"
                        aria-invalid={problem !== null}
                        // Every keystroke, so an `@` opens the people picker as
                        // it is typed. The estimate half is not read here and no
                        // draft is written — that is still the blur's job.
                        onTyped={(box) => {
                          live.current.readFoldedCell(row.original.id, role.id, box);
                        }}
                        onKeyDown={(e) => {
                          // `mentioning`, not `options.length > 0`, and the two
                          // are not the same thing: a deployment with nobody in it
                          // answers a bare `@` with no entries at all, and this
                          // branch then handed the keyboard back to a cell a
                          // mention owned — Alt+ArrowDown moved the row and
                          // Cmd+Enter made one, under a half-typed mention. The
                          // card's guard was corrected in round 3 and this one was
                          // left counting entries; round 4 caught the divergence.
                          // The hole itself predates the change: the same branch
                          // counts entries on the merge-base at `75d01a8`.
                          // Proof: put back to `options.length > 0`, `every chord
                          // is inert on a mention that has nobody to offer` failed
                          // on `expected [ 'Strip', 'Paint', 'Sand', '' ] to deeply
                          // equal [ 'Strip', 'Sand', 'Paint' ]` — the row moved and
                          // a row created. Watched, 2026-08-09.
                          if (mentioning) {
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
                              // rule: what is offered first is what is taken —
                              // and where there is nothing on offer, Enter is
                              // consumed and takes nothing rather than falling
                              // through to "new work item" under a live mention.
                              e.preventDefault();
                              options[0]?.take();
                              return;
                            }
                          } else {
                            // Enter saves, exactly as Prio and People-at-once do
                            // and for the same reason — see the comment on Prio's.
                            // This cell is the one it mattered most in and the
                            // last to get it: a trio typed and confirmed sat as a
                            // draft with the plan's dates unmoved until somebody
                            // happened to click elsewhere. Observed live on dev by
                            // `wbs-e2e-planning-qa`, 2026-08-22.
                            //
                            // Inside the `else`, and that is the whole placement
                            // argument: with a mention open Enter belongs to the
                            // list above, which takes the first person offered.
                            // The modifier guard leaves Ctrl/⌘ + Enter to
                            // `onCommandKey` underneath, which saves *and* makes
                            // the next row.
                            if (
                              e.key === 'Enter' &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              !e.altKey &&
                              !e.shiftKey
                            ) {
                              e.preventDefault();
                              void flushCell(e.currentTarget);
                              return;
                            }
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
                        aria-describedby={carded ? cardId : undefined}
                        onFocus={(e) => {
                          live.current.enterFoldedCell(e.currentTarget);
                          // The focus opens the card the pointer opens — through
                          // its own state, so a mouse crossing the table cannot
                          // take it away from a box somebody is still typing in
                          // (round 4, finding 9). Cleared by the wrapper's
                          // `onBlur`, which this bubbles to.
                          // Proof, both watched 2026-08-09. This line dropped:
                          // `opens the card on the focus too, and points the box
                          // at it` failed on `Unable to find an accessible element
                          // with the role "tooltip"`. Written back to
                          // `setHoveredCell`, with `openCard` folded back to the
                          // hover: `keeps the focused cell's card when the pointer
                          // visits another and leaves` failed the same way.
                          live.current.setFocusedCell(finalCell);
                          e.currentTarget.select();
                        }}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          font: 'inherit',
                          fontWeight: 600,
                          flex: 1,
                          minWidth: 0,
                          ...(problem === null
                            ? {}
                            : {
                                background: 'var(--grid-invalid)',
                                borderColor: 'var(--destructive)',
                              }),
                        }}
                        value={live.current.combinedValue(row.original, role.id)}
                        commit={(typed, baseline) =>
                          live.current.commitCombinedEstimate(
                            row.original,
                            role.id,
                            typed,
                            baseline,
                          )
                        }
                      />
                    ) : (
                      showFinal(row.original.finalDays[role.id])
                    )}
                    {problem !== null && ' !'}
                    {doing !== null && (
                      // `4.8 · VA`, and the whole name in the tooltip. 96px holds
                      // a figure and about four characters of a person, which is
                      // how this printed `vad…` and `kuc…` — two people who read
                      // identically. {@link initialsOf} is the same length every
                      // time, so the column lines up and nothing needs an
                      // ellipsis. Grey and in brackets where nobody is assigned
                      // and somebody is assumed, exactly as the unfolded column
                      // reads it.
                      <span
                        data-folded-assignee={role.id}
                        {...(doing.assumed ? { 'data-assumed': role.id } : {})}
                        // No `title`, still. One was written here for the
                        // initials and taken back out: `leaves the assignee no
                        // title of its own to say it twice` is a decision from
                        // 2026-08-09 — a native tooltip is one line, a second
                        // late, and the hover card already names them in full
                        // (`folded-role-card.tsx`). Initials make the card more
                        // load-bearing, not the tooltip more welcome.
                        style={{
                          marginLeft: 4,
                          flex: 'none',
                          whiteSpace: 'nowrap',
                          fontWeight: 'normal',
                          color: doing.assumed ? 'var(--muted-foreground)' : undefined,
                        }}
                      >
                        · {doing.assumed ? `(${initialsOf(doing.name)})` : initialsOf(doing.name)}
                      </span>
                    )}
                    {/*
                      Task 7.2's marker on the folded cell as well as the
                      unfolded one, and that is the point rather than a
                      duplication: roles start folded (`unfoldedRoles` is `[]`),
                      so a marker living only in the `by` column would be absent
                      from every plan nobody has unfolded. This cell already
                      holds the rule as `A folded role must not be able to hide
                      a complaint`; a signal is not a complaint, but it hides
                      exactly as easily.

                      `carded`, so the sentence rides {@link FoldedRoleCard}
                      with the assignee's own name rather than fighting it as a
                      native tooltip.
                    */}
                    {doing?.outside != null && (
                      <MismatchMark kind="assignee" note={doing.outside} carded />
                    )}
                    {options.length > 0 && (
                      <PickerList
                        id={listId}
                        label={`${role.name} assignee for ${row.original.number}`}
                        options={options}
                      />
                    )}
                    {carded && (
                      <FoldedRoleCard
                        roleName={role.name}
                        number={row.original.number}
                        id={cardId}
                        points={POINTS.map((point) => ({
                          point,
                          // The row's own trio, off the row — **not** through
                          // `estimateValue`, and not through `combinedValue`
                          // below it. Those two answer with the draft where there
                          // is one, which is right for a box somebody is typing
                          // in and wrong for this: a card is what the fold left
                          // behind, and what the fold hid is the estimate be-01
                          // holds — the one the figure beside it is computed
                          // from, and the one every other reader of the plan
                          // sees. Reading the draft made a card say
                          // `realistic —` beside `Final 3.7 days`, and
                          // `Final 8/3/2 days` where a number of days belongs.
                          // The draft is not lost: unfolding the role puts it
                          // back in the box it was typed into, with its
                          // complaint, which is the only place it can be
                          // corrected. codex round 3, finding 4.
                          // Proof, two faults watched 2026-08-09. Points read
                          // through `estimateValue`: `reads the trio off the row,
                          // not out of the boxes it was typed into` failed on
                          // `expected 'Devoptimistic 2 · realistic — · pessi…' to
                          // contain 'realistic 3'`. `final` read through
                          // `combinedValue`: `says Final in days, whatever
                          // half-typed shorthand the cell is holding` failed on
                          // `expected 'Dev…Final 8/3/2 days' to contain 'Final
                          // 3.7 days'`.
                          days: showDays(row.original.estimates[role.id], point),
                        }))}
                        final={showFinal(row.original.finalDays[role.id])}
                        doing={doing}
                        problem={problem}
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
                      //
                      // The word itself in a `title`, because the column is 44px
                      // and the word is not: measured on 2026-08-09, `optimistic`
                      // wants 84px and reads `optimi`, `pessimistic` wants 95px
                      // and reads `pessin`. There is no ellipsis to hint at it
                      // either — the same answer the `Days` header takes, where
                      // the sentence that would not fit moved into the `title`.
                      //
                      // One letter since `spreadsheet-geometry`, which is the
                      // shorthand these cells already teach: the folded column's
                      // box takes `o/r/p` as its placeholder and reads a trio
                      // typed as `2/3/8`. A clipped word said less than its own
                      // first letter does — `optimi` is not a word — and the
                      // letter is what let the column drop to 44px. The word is
                      // still the heading's accessible name, and it is the first
                      // word of the `<th>`'s hint — which is why that one hint
                      // opens with the column's name and the other fourteen open
                      // with the effect (`column-hints.ts`).
                      meta: { spokenHeading: point },
                      header: () => <span>{point.slice(0, 1)}</span>,
                      cell: ({ row }) => {
                        const problem = live.current.trioProblemFor(row.original, role.id);
                        const wrong = problem?.points.includes(point) ?? false;
                        return (
                          <CellInput
                            aria-label={`${role.name} ${point} for ${row.original.number}`}
                            cellKey={cellKey(row.original.id, `${role.id}-${point}`)}
                            // Narrow on purpose: these hold a number of days, and a box
                            // sized for a sentence reads as if it wants one. Which is
                            // the column's width to say now, not this box's.
                            //
                            // `decimal` and not `numeric` because half-days are typed
                            // here (`0.5`), and not `type="number"` for the folded
                            // cell's reason one column back — spinners a thumb cannot
                            // use. These three boxes had **no** `inputMode` at all
                            // until `wbs-mobile-orp-input`, so a touch device offered
                            // a letters keyboard for a box that only ever holds a
                            // number: the one three-box path a tablet can reach was
                            // the one path with no keypad on it.
                            inputMode="decimal"
                            aria-invalid={wrong}
                            title={problem?.message}
                            onKeyDown={(e) => {
                              // Enter saves, the folded cell's rule in the face
                              // an estimator opens to argue about one number.
                              // A box with no list over it, so there is no
                              // `mentioning` arm to sit inside — the modifier
                              // guard is still the chord's, and is the whole of
                              // what this branch has to be careful about.
                              if (
                                e.key === 'Enter' &&
                                !e.metaKey &&
                                !e.ctrlKey &&
                                !e.altKey &&
                                !e.shiftKey
                              ) {
                                e.preventDefault();
                                void flushCell(e.currentTarget);
                                return;
                              }
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
                                ? { color: 'var(--muted-foreground)', background: 'var(--muted)' }
                                : wrong
                                  ? {
                                      background: 'var(--grid-invalid)',
                                      borderColor: 'var(--destructive)',
                                    }
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
                      // Task 7.2's second marker. Read through `assigneeOn` and
                      // not off the row, because that is the one function that
                      // resolves *which* person this cell shows — the named one
                      // or the assumed one — and a marker computed from
                      // `assigned` alone would go quiet on exactly the assumed
                      // case, where nobody has looked at the assignment at all.
                      const doing = live.current.assigneeOn(row.original, role.id);
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
                              onAltMove: (e) => {
                                live.current.onAltMove(e, row.original, `${role.id}-assignee`);
                              },
                            }}
                          />
                          {assumed !== null && (
                            <span
                              data-assumed={role.id}
                              title="Only one person is assigned, so they are assumed to do this phase too"
                              style={{
                                color: 'var(--muted-foreground)',
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
                          {doing?.outside != null && (
                            <MismatchMark kind="assignee" note={doing.outside} />
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
          // and the roles beside it hold days too. The sentence it used to be is
          // on the `<th>` (`column-hints.ts`), where every column's is.
          header: () => <span>Days</span>,
          cell: ({ row }) => (
            <span data-final-total style={{ fontWeight: 600 }}>
              {showDay(row.original.finalTotal)}
            </span>
          ),
        }),
        column.display({
          id: 'not-before',
          // Abbreviated, because the column is 84px at its widest and 56 at its
          // narrowest. The sentence it used to be is on the `<th>`
          // (`column-hints.ts`) — the same bargain Days, Start, End and Slack
          // already make.
          header: () => <span>Not bef.</span>,
          cell: ({ row }) => {
            const day = row.original.startNoEarlierThan;
            // The words about that day, or null where nobody has said. Straight
            // off the tree read like the date above it — a draft somebody is
            // half-way through typing is not yet a fact about the plan.
            const reason = row.original.startNoEarlierThanReason;
            // Without a project start date there is no day zero to count from and
            // be-01 ignores the constraint entirely. A rendered disabled state
            // rather than an editor that opens onto nothing: a date that saves
            // and does nothing is worse than a field that will not take one.
            const noCalendar = live.current.startDate === null;
            const editing = live.current.editingNotBefore === row.original.id;
            const open = (): void => {
              if (noCalendar) return;
              live.current.openNotBefore(row.original.id);
            };
            const close = (): void => {
              live.current.closeNotBefore(row.original.id);
            };
            /**
             * Sends the words in the box, and only when they differ from the ones
             * this box last agreed about.
             *
             * `DateField`'s rule, in the one place it cannot be borrowed from: a
             * focus and a blur with nothing typed is not an edit, and sending
             * anyway writes what was on screen when the focus arrived over
             * whatever a peer has done since. What "agreed" means is kept on the
             * node rather than in a ref because this box is rendered by a cell
             * function, not by a component with a lifetime — an Enter that sends
             * and then blurs would otherwise send the same sentence twice.
             */
            const commitReason = (box: HTMLInputElement): void => {
              const agreed = box.dataset['agreed'] ?? reason ?? '';
              if (box.value === agreed) return;
              box.dataset['agreed'] = box.value;
              live.current.setNotBeforeReason(row.original.id, box.value);
            };
            return (
              /*
              The wrapper the editor escapes through. It is `position: relative`
              and **inside** the `<td>`, which is why `opensAPopover` has to
              lift this column's clip for the editor to be visible at all — see
              the note there. At rest it holds a short date and escapes nothing.

              **It is also what decides the editor is one editor.** Since the
              reason box joined the date box, leaving one of them for the other
              is not leaving the editor, and `DateField`'s `onExit` cannot tell
              the difference — it reports the blur, not where the focus went.
              `focusout` bubbles and carries `relatedTarget`, so the question is
              asked once, here, of the panel as a whole: focus still inside is
              not an exit. Proof: this guard inverted to a bare `close()`, `lets
              somebody type the reason the date is there` fails on `expected
              null to not be null` — the panel shuts on the way to the box.
              Watched, 2026-08-18.
            */
              <span
                style={{ position: 'relative', display: 'block' }}
                onBlur={(event) => {
                  if (!editing) return;
                  const going = event.relatedTarget;
                  if (going instanceof Node && event.currentTarget.contains(going)) return;
                  close();
                }}
              >
                {editing ? (
                  <>
                    <DateField
                      aria-label={`Earliest start for ${row.original.number}`}
                      data-not-before={row.original.id}
                      data-cell={cellKey(row.original.id, 'not-before')}
                      title="This work item may not start before this day. Its dependencies can still push it later."
                      onKeyDown={(e) => {
                        // Enter closes the editor, and it is this cell's job now
                        // rather than `onExit`'s: `onExit` reports a blur as well
                        // as an Enter, and a blur may be somebody reaching for the
                        // reason box under this one. By the time this runs
                        // `DateField` has already sent the day — its own handler
                        // is first, deliberately, so a `Ctrl/⌘ + Enter` that moves
                        // to the next row has saved this one on the way out.
                        if (e.key === 'Enter') close();
                        // The chords and the row moves, and nothing else this cell
                        // does not already own: a native date input keeps its own
                        // arrows for the segment under the caret, which is why
                        // {@link onArrowKey} is absent here. Alt+arrow is not one
                        // of those — {@link altMoveIn} takes it before the segment
                        // stepper sees it, exactly as it does in every other cell.
                        live.current.onAltMove(e, row.original, 'not-before');
                        live.current.onCommandKey(e, row.original, 'not-before');
                        live.current.onTabKey(e, row.original.id, 'not-before');
                      }}
                      onExit={(how) => {
                        // Escape only. It is the one exit that has already put the
                        // box back to the day the server agreed, so there is
                        // nothing left to send and nowhere else the focus is
                        // going. Every other way out of this panel is the
                        // wrapper's `focusout`, which is the one place that can
                        // see the two boxes as one editor.
                        if (how === 'cancel') close();
                      }}
                      // Wider than its column, on purpose: {@link DATE_EDITOR_WIDTH}
                      // is what this browser lays an unconstrained date input out
                      // at, and a column that grew to fit one would move every cell
                      // under the person typing. It leaves the cell instead, over
                      // the columns beside it, which is what the `z-index` is for.
                      style={{
                        position: 'relative',
                        zIndex: 10,
                        width: DATE_EDITOR_WIDTH,
                        boxSizing: 'border-box',
                        font: 'inherit',
                      }}
                      value={day ?? ''}
                      commit={(typed) => {
                        // A date input reports '' when cleared, which is the caller
                        // saying "no constraint" rather than "an empty date".
                        live.current.setNotBefore(row.original.id, typed === '' ? null : typed);
                      }}
                    />
                    {/*
                    Why the date is there, under the date itself.

                    **Absolutely positioned, so the row does not grow.** A second
                    box in the flow would make every cell of this row two lines
                    tall for as long as somebody is typing, and the table's whole
                    geometry is one line per row. It hangs off the wrapper the
                    date editor already escapes through, at the same width, and
                    reaches the reader only because `opensAPopover` lifts this
                    column's clip.

                    No `data-cell`: the grid has one cell here and it is the
                    date. A second box wearing the same key is how the keyboard
                    and the held refusal come to disagree about which box they
                    are talking about — `CellInput`'s note says it, one column
                    over.
                  */}
                    <input
                      aria-label={`Why ${row.original.number} may not start earlier`}
                      data-not-before-reason={row.original.id}
                      placeholder="Why? (optional)"
                      title="Words about the date beside this, in your own words — a date with no words is still a date. Clearing the date clears these too."
                      // No `maxLength`, deliberately. be-01 bounds this at 200
                      // (`LONGEST_NOT_BEFORE_REASON`) and refuses a longer one,
                      // and a box that quietly stopped taking characters would be
                      // this client keeping a rule the server also keeps — two
                      // copies of one number, which is how the two come to
                      // disagree. {@link setPriority} writes the doctrine down.
                      defaultValue={reason ?? ''}
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 10,
                        width: DATE_EDITOR_WIDTH,
                        boxSizing: 'border-box',
                        font: 'inherit',
                        background: 'var(--popover)',
                        color: 'var(--popover-foreground)',
                        border: '1px solid var(--border)',
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          // Back to what the server agreed, which is what makes
                          // the blur after an Escape harmless — the same rule
                          // {@link DateField} keeps, for the same reason: a box
                          // holding the agreed value has nothing left to commit.
                          e.currentTarget.value = reason ?? '';
                          close();
                          return;
                        }
                        if (e.key === 'Enter') {
                          commitReason(e.currentTarget);
                          close();
                        }
                      }}
                      onBlur={(e) => {
                        commitReason(e.currentTarget);
                      }}
                    />
                  </>
                ) : (
                  /*
                  The day at rest, and still a cell of the keyboard grid: Tab
                  lands here, the arrows land here, and `editableGrid` finds it
                  because it is an `<input>` carrying `data-cell` — which is
                  also why it is not `readOnly`, an attribute that selector
                  deliberately excludes. Nothing is ever typed into it: a
                  keystroke opens the editor instead, which is what `onChange`
                  is doing here.
                */
                  <input
                    aria-label={`Earliest start for ${row.original.number}`}
                    disabled={noCalendar}
                    data-not-before={row.original.id}
                    data-cell={cellKey(row.original.id, 'not-before')}
                    // The reason is **appended** where there is one, never
                    // substituted — the same bargain `floorWordsOf` strikes on
                    // the bar. What the constraint does is the part a reader
                    // cannot work out for themselves; what it is *for* is the
                    // part only a planner can say. A cell 84px wide has one
                    // `title` and both belong in it.
                    title={
                      noCalendar
                        ? 'Set the project start date first — without one there are no dates to constrain.'
                        : [
                            day === null ? null : `${day}.`,
                            'This work item may not start before this day. Its dependencies can still push it later.',
                            reason === null || reason.trim() === ''
                              ? null
                              : `Why: ${reason.trim()}`,
                          ]
                            .filter((part) => part !== null)
                            .join(' ')
                    }
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      font: 'inherit',
                      background: 'transparent',
                      border: 'none',
                      cursor: noCalendar ? 'not-allowed' : 'text',
                    }}
                    // An em-dash for a row that sets no day, which reads as "none"
                    // rather than as a cell that failed to load.
                    value={day === null ? '—' : shortIsoDate(day, new Date())}
                    onChange={open}
                    // `click`, not `mousedown`, and a browser is the only thing
                    // that can say why. React flushes a discrete update inside
                    // the `mousedown` dispatch, so the editor mounted and the at
                    // rest input was gone before Chromium performed that event's
                    // **default action** — focusing the node it had hit-tested.
                    // Focusing a detached node moves the focus to `<body>`, which
                    // blurred the editor, which is an exit, which closed it: a
                    // click on the cell did nothing at all. jsdom performs no
                    // default action and could not see it; found in Chromium by
                    // counting `input[type=date]` after a click and getting none.
                    // R5 #14/#15, the same fault class. `click` fires after the
                    // focus has already moved, so there is nothing left to undo
                    // the mount.
                    onClick={open}
                    onKeyDown={(e) => {
                      // A bare Enter opens the editor; a chord is the table's and
                      // is left to it, which is why the modifiers are asked about
                      // before anything else happens.
                      if (
                        e.key === 'Enter' &&
                        !e.metaKey &&
                        !e.ctrlKey &&
                        !e.altKey &&
                        !e.shiftKey
                      ) {
                        e.preventDefault();
                        open();
                        return;
                      }
                      live.current.onAltMove(e, row.original, 'not-before');
                      live.current.onCommandKey(e, row.original, 'not-before');
                      live.current.onTabKey(e, row.original.id, 'not-before');
                    }}
                  />
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'start',
          // A bare `2.5` under "Start" reads as a date that failed to load, and
          // the header used to say which of the two it was — in 52px it cannot,
          // so the distinction moved into the `title`. The column is a figure
          // either way and the cell shows which kind it is.
          header: () => <span>Start</span>,
          cell: ({ row }) => {
            const start = live.current.spanOf(row.original).start;
            const hasExplanation = start.iso !== null || startFloor.current.has(row.original.id);
            // The sentence that explains this day has moved to the `<td>` — see
            // {@link startCellProps} — so the whole cell (not a 34×13px span
            // inside it) is the target, and a keyboard can reach it. The span
            // keeps the visible day; its dotted underline is the on-screen mark
            // that there is more to read, where a bare `title` shows nothing
            // until a pointer happens to stop on it.
            return (
              <span
                data-start
                style={hasExplanation ? { textDecoration: 'underline dotted' } : undefined}
              >
                {start.text}
              </span>
            );
          },
        }),
        column.display({
          id: 'finish',
          header: () => <span>End</span>,
          cell: ({ row }) => {
            const finish = live.current.spanOf(row.original).finish;
            // Both facts in one `title`, because a cell has one: the day in full,
            // and — where the figure is a guess — what the marker beside it means.
            const said = [finish.iso, row.original.schedule.estimated ? null : 'No estimate yet']
              .filter((part) => part !== null)
              .join(' — ');
            return (
              <span data-finish title={said === '' ? undefined : said}>
                {finish.text}
                {live.current.hasSchedule() && !row.original.schedule.estimated ? ' ?' : ''}
              </span>
            );
          },
        }),
        column.display({
          id: 'float',
          header: () => <span>Slack</span>,
          cell: ({ row }) => {
            // A critical row has no slack to print, and the word that replaces
            // the figure is not a figure: the attribute is what lets `styles.css`
            // set it as a tag rather than as a number in the column's own type.
            // One word, not the `— critical` it was: the column is 56px and the
            // tag has to fit inside it, which the dash and the space did not.
            // `plan-export.ts` has printed the bare word since it was written.
            if (!live.current.hasSchedule()) {
              return (
                <span
                  data-float
                  title="No schedule could be worked out, so there is no slack to show."
                >
                  —
                </span>
              );
            }
            if (row.original.schedule.critical) {
              return (
                <span
                  data-float
                  data-critical="true"
                  title="On the critical path: any delay here moves the whole plan’s finish."
                >
                  critical
                </span>
              );
            }
            const days = showDay(row.original.schedule.float);
            return (
              <span
                data-float
                title={`This work item can slip ${days} workday${days === '1' ? '' : 's'} before the plan finishes later.`}
              >
                {days}
              </span>
            );
          },
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
                ...(row.original.frozenNumber === null
                  ? []
                  : [
                      {
                        id: 'unfreeze',
                        label: 'Unfreeze',
                        run: () => {
                          void live.current.run(() => live.current.api.unfreeze(row.original.id));
                        },
                      },
                    ]),
                {
                  id: 'delete',
                  label: 'Delete',
                  // Present and refused on a frozen row rather than absent, and
                  // it carries the real `run` deliberately: an item whose action
                  // was stubbed out could not tell a working guard from a
                  // missing one. {@link RowAction.refusedBecause} is what stops
                  // it, and the test that watches it stop is the proof.
                  ...(row.original.frozenNumber === null
                    ? {}
                    : { refusedBecause: 'Frozen — unfreeze this row before deleting it' }),
                  run: () => {
                    void live.current.deleteRow(row.original);
                  },
                },
              ]}
            />
          ),
        }),
      ]
        // **A hidden column is not in the table model at all.** Not merely
        // unrendered: absent, so the keyboard grid, the hover cards and the
        // drag geometry never learn it was declared. Fixed columns go by their
        // own id; a hidden role takes every column named after it — folded,
        // unfolded and assignee — while the role itself stays in `roles`, so
        // its estimates still reach the total and the dates be-01 computed.
        //
        // Until `configurable-columns` two filters here rendered Tags and
        // Services only where the directory held one. The default column set
        // is data-independent now — `DEFAULT_HIDDEN_COLUMNS` in
        // `table-frame.ts` says which columns start hidden and why.
        .filter((each) => {
          // Every column above declares an id; one without is a definition this
          // filter cannot judge, and hiding it by accident would be silent.
          if (each.id === undefined) throw new Error('a column definition has no id');
          const id = each.id;
          return !hiddenColumnIds.some((hidden) => id === hidden || id.startsWith(`${hidden}-`));
        }),
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
    //
    // `hiddenColumnIds` joins them because it decides which columns exist at
    // all, exactly as `unfoldedRoles` does — a memo whose identity moves only
    // on a tick in the Columns control, so the remount it costs happens on the
    // click that asked for it rather than once per render.
    [roles, unfoldedRoles, hiddenColumnIds],
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
   * The rows the dependency hover lights, by id — the read row's whole
   * waited-for set while the pointer or the focus is on the cell, the one
   * pill's row while it is on a pill.
   *
   * `depHover ?? depFocus`: the pointer's reading wins over the keyboard's
   * while both are live, because the pointer is where the eyes are. See
   * {@link depFocus} for why they are two states and not one.
   *
   * Derived from the read row's `dependsOn` and never from its own id: that row
   * is the *successor*, and lighting it would answer "what does this wait for"
   * by pointing at the question. Nothing here filters the row back out of its
   * own dependency set, because nothing can put it there: `be-01`'s dependency
   * service refuses an edge that closes a cycle (`service/dependency.ts`), and
   * a row waiting for itself is the shortest cycle there is. The guarantee is
   * upstream-enforced, and the change's spec says so.
   *
   * A dependency whose row is collapsed or filtered out is in this set and on
   * no shown `<tr>`, so nothing lights — the hover card still names it, which
   * is the guarantee. A read row the tree no longer holds lights nothing,
   * modeled rather than thrown: a hover can outlive its row by one refetch,
   * exactly as {@link goToRow}'s absences can.
   *
   * **`pillId` is checked against the cell, not trusted.** It is a remembered
   * id, and the edge under it can be cut while the pointer is still on the
   * strip — the ✕ *is* the pill, so a click unmounts the element and the
   * `mouseleave` that would have cleared the id never fires. The chip's
   * `onClick` widens the hover back to the cell for that case; this is the
   * other end of it, and it is what makes the derivation total over remembered
   * state rather than dependent on every writer being right: a `pillId` the
   * cell no longer names lights nothing, so no reader follows a light to an
   * edge that is gone.
   *
   * Proof: derived from `depHover.rowId` instead, `lights every dependency's
   * row from the cell, and no other row` failed on `expected ['030'] to
   * deeply equal ['010', '020']` — the successor lit, its dependencies dark.
   * Watched, 2026-08-10. The `includes` guard: dropped together with the
   * chip's widen, `widens back to the remaining dependencies when a pill is
   * deleted under the pointer` failed on `expected ['010'] to deeply equal
   * ['020']` — the cut edge still lit. Watched, 2026-08-11.
   */
  const depLit: ReadonlySet<string> = (() => {
    const read = depHover ?? depFocus;
    if (read === null) return new Set();
    const hovered = flat.find((row) => row.id === read.rowId);
    if (hovered === undefined) return new Set();
    if (read.pillId === null) return new Set(hovered.dependsOn);
    return hovered.dependsOn.includes(read.pillId) ? new Set([read.pillId]) : new Set();
  })();

  /**
   * The row the **chart** says the pointer or a bar's focus is on, which is the
   * only thing the table's own rows light from.
   *
   * The pointer's reading wins over a focused bar's, for the reason `depLit`'s
   * own `depHover ?? depFocus` does: the pointer is where the eyes are.
   */
  const pointedFromChart: string | null = chartPointedRow ?? chartFocusedRow;
  /**
   * The one work item the **panel** lights, from either face.
   *
   * The table's own hover comes first: while the pointer is on a row here, that
   * row is what the reader is asking about, and a bar that still held the
   * keyboard focus from earlier is not.
   *
   * A row the tree no longer holds is **not** filtered out, and that is
   * deliberate rather than an omission: the id is only ever compared against
   * the rows being drawn, so a pointed row that has been refetched away lights
   * nothing and needs no lookup to say so. `depLit` has to search `flat`
   * because it resolves an id into *other* ids; this resolves nothing.
   */
  const pointedAt: string | null = tablePointedRow ?? pointedFromChart;

  /**
   * What one row's Depends on `<td>` does with a pointer arriving and leaving.
   *
   * **On the `<td>`, because the gesture is "the pointer is in this cell".**
   * These two handlers lived on a wrapper `<span>` inside the cell until
   * 2026-08-14, and the wrapper stands inside the cell's padding box: the
   * cell's own 4px either side answered nothing, and at the column's resolved
   * 110px two pills and the add button fill the strip edge to edge, so the
   * only surface left that produced the cell's reading was the 15.8px `+`
   * — a control whose job is "start waiting for something else". Measured
   * in Chromium: the box the gesture names is laid out **7.7px outside its own
   * cell** at that width, `elementFromPoint` down the cell's midline answers a
   * pill everywhere but the padding, and the padding lit nothing.
   * `openspec/changes/table-width-budget/design.md` D2 has the table.
   *
   * The pills' own narrower reading is unaffected and is the one thing this
   * move could have cost. `mouseenter` fires on every element being entered,
   * outermost first, so a pointer arriving straight onto a pill runs this
   * handler (`pillId: null`, the whole set) and then the pill's
   * (`pillId: <id>`, one row) — and the pill's write is the one that lands.
   * jsdom cannot say so, because `fireEvent.mouseEnter` dispatches to one
   * element and walks no chain; `e2e/deps-cell.spec.ts`'s `narrows to one pill
   * when the pointer settles on it, from the cell` is the browser that can.
   *
   * Built here rather than in the column definition for landmine #1's reason:
   * `columns` depends on `roles` alone, and anything that changes per pointer
   * move must not enter it. The `<td>` is rendered outside that memo.
   */
  const dependsCellHoverProps = (
    row: TreeRow,
  ): Pick<ComponentProps<'td'>, 'onMouseEnter' | 'onMouseLeave'> => {
    const dependsCell = cellKey(row.id, 'depends');
    return {
      onMouseEnter: () => {
        // Every row this one waits for is lit, `pillId: null` saying the
        // pointer is on the cell rather than on one pill. Guarded by the same
        // "nothing to say, nothing written" rule as the card below — a cell
        // that waits for nothing has no row to light and no reason to spend a
        // render (codex round 3, finding 5). The functional writer returns the
        // current object when the value is already there, which is the
        // string-key bail-out below, spelt for an object.
        if (dependenciesOf(row.dependsOn).length > 0) {
          setDepHover((current) =>
            current?.rowId === row.id && current.pillId === null
              ? current
              : { rowId: row.id, pillId: null },
          );
        }
        // Nothing to open, nothing written. `hoveredCell` lives on the table,
        // so every boundary the pointer crosses costs one render of the whole
        // of it — and a cell with no card to show has no reason to spend one,
        // nor to close the card open somewhere else on the pointer's way past.
        // codex round 3, finding 5.
        //
        // The key is a string, so a second enter on the same cell writes the
        // value already there and React bails out without rendering.
        // Proof: this guard dropped, `writes no hovered cell from a cell
        // that has no card to show` failed on `Unable to find an accessible
        // element with the role "tooltip"`. Watched, 2026-08-09.
        //
        // `depPicker` and not the cell's local `picker`: the card and the
        // picker are the two boxes that hang off one 110px cell, and the one
        // somebody is typing into is the one they are looking at. Read from
        // the state directly, because this is outside the column definitions.
        const cardable = dependenciesOf(row.dependsOn).length > 0 && depPicker?.rowId !== row.id;
        if (!cardable) return;
        setHoveredCell(dependsCell);
      },
      onMouseLeave: () => {
        // The open dependency card owns dismissal through its document
        // pointer bridge. Clearing here would unmount the row targets while
        // the pointer is crossing the card's passive padding. The bridge sees
        // the next real pointer position and clears if it is outside; a
        // `relatedTarget` is deliberately not required because passive card
        // pixels hit-test through to the plan and Chromium may report that
        // boundary as a leave with no related node.
        if (dependenciesOf(row.dependsOn).length > 0 && depPicker?.rowId !== row.id) return;

        // Leaving the cell clears the dependency hover outright — with the
        // same-cell guard `hoveredCell`'s clear uses, because a leave lands
        // after the next cell's enter.
        setDepHover((current) => (current?.rowId === row.id ? null : current));
        // The same-cell guard, for the reason the Name cell's marker gives: a
        // leave lands after the next cell's enter.
        setHoveredCell((current) => (current === dependsCell ? null : current));
      },
    };
  };

  /**
   * What one row's Start `<td>` carries so the sentence that explains its day
   * is reachable without a pointer resting on the right 34×13px of it.
   *
   * The two facts are the same `title` the `Start` cell has always joined —
   * the whole day, so the shortening costs nothing, then what is holding that
   * day where it is, the floor sentence word for word from the chart's
   * `startFloorByRow`. It moved here for `wbs-waiting-sentence-hover-target`:
   * the `title` used to sit on `span[data-start]` *inside* the cell — a 442px²
   * surface in a 4116px² cell, `cursor: auto`, no keyboard path, no on-screen
   * mark that there was anything to read. On the `<td>` the whole cell is the
   * surface, the `cursor: help` set where the row renders says it is there
   * while a pointer is over it, the span's dotted underline says it all the
   * time, and `tabIndex` puts it on the keyboard — a focused cell reads its
   * day, then this sentence as its accessible description.
   *
   * Built outside the column definitions for the same reason as
   * {@link dependsCellHoverProps}: `columns` depends on `roles` alone, while
   * this sentence depends on `startFloor`, which is filled after the first
   * render.
   */
  const startCellProps = (row: TreeRow): Pick<ComponentProps<'td'>, 'title' | 'tabIndex'> => {
    const said = [live.current.spanOf(row).start.iso, startFloor.current.get(row.id)]
      .filter((part) => part !== null && part !== undefined)
      .join(' — ');
    return {
      title: said === '' ? undefined : said,
      tabIndex: said === '' ? undefined : 0,
    };
  };

  /**
   * What the Gantt panel draws, from the rows the renderer is drawing.
   *
   * **`shownRows`, not the row model**, and that is the whole of the mirroring:
   * the chart is the same list in the same order with the same branches open,
   * because it is the same list. The expansion is already the model's answer —
   * a collapsed branch's children are not in it — and the filter above is the
   * search's, which nothing else applies.
   *
   * Proof, twice, because one edit could not reach both halves. Fed
   * `table.getRowModel().rows`, the search's narrowing is lost and the
   * expansion's is not: `draws exactly the rows a search narrowed the plan to`
   * failed on four labels where the plan shows three, and `leaves a collapsed
   * branch's children off the chart` went on passing. Fed `flat` — every row of
   * the tree — that second test failed too, on four labels where the plan shows
   * two. Both watched, 2026-08-09.
   *
   * Built outside the `columns` memo and read by nothing inside it: that memo
   * depends on `roles` alone, and anything added to it remounts every cell in
   * the table and eats the focus (LLM_README landmine #1).
   */
  const ganttPlan: GanttPlan = {
    rows: shownRows.map((row) => ({
      id: row.id,
      // The Number column's own number, not a second derivation of it: the
      // chart's labels read `010 - Strip` because that is how the plan is
      // spoken about.
      number: row.original.number,
      name: row.original.name,
      depth: row.depth,
      // A leaf of the plan as drawn, which is a row with nothing under it —
      // the same question `getSubRows` answers for the table model.
      leaf: row.subRows.length === 0,
      schedule: {
        earliestStart: row.original.schedule.earliestStart,
        earliestFinish: row.original.schedule.earliestFinish,
      },
      notBeforeOffset: notBeforeOffsetOf(startDate, row.original.startNoEarlierThan),
      // The words about that date, for the floor sentence to append where the
      // not-before is the floor that actually binds this bar. Read on **every**
      // row rather than only the floored ones: which floor binds is
      // `floorWordsOf`'s answer, computed from the schedule, and a chart row
      // that carried the reason only where this side already thought it
      // mattered would be two places deciding one thing.
      notBeforeReason: row.original.startNoEarlierThanReason,
      // Straight off the tree read, like the trio beside it: what a bar says is
      // a fact about the plan the chart was drawn from, not about a draft
      // somebody is half-way through typing into the column.
      priority: row.original.priority,
      maxParallel: row.original.maxParallel,
      // The **effective** team, which is the pool be-01 scheduled this row's
      // slices against — not the label the row carries, which may be none at
      // all. A chart drawn from the stored label alone cannot say whose people
      // a bar is waiting for.
      team: effectiveTeamLabelOf(row.original),
      // The **effective** tags, for the team's reason one line up and for none
      // of its consequences: an inherited tag has to be sayable on the bar of a
      // row that names no tag, and that is the whole of what this field does.
      // Nothing on the chart is placed from it — see {@link GanttRow.tags}.
      tags: effectiveTagLabelOf(row.original),
      // The trio the plan holds for each role on this row, straight off the
      // tree read — the drafts a reader is half-way through typing are not
      // facts about the schedule the chart was drawn from.
      trioByRole: new Map(Object.entries(row.original.estimates)),
      waitsFor: row.original.dependsOn.map(
        // A predecessor the tree does not hold at all is the same modeled
        // absence `personFloorWords` already has words for, and it is said the
        // same way rather than left as a bare id.
        (predecessorId) => namedInTheTree.get(predecessorId) ?? 'work that is not shown',
      ),
    })),
    slices: chartRead.slices,
    // The full tree, ids and parents alone — `flat` and not `shownRows`, for
    // `namedInTheTree`'s reason: a dependency arrow's anchor is selected from
    // the predecessor's leaves' slices, and a collapsed branch's leaves are
    // exactly the rows the shown set has dropped (design.md D6).
    tree: flat.map((row) => ({ id: row.id, parentId: row.parentId })),
    // Why the rows above are the length they are, which the list itself cannot
    // say: `isFiltering`'s one answer, the same one the count beside the Find
    // box and the empty-answer sentence read, so the chart's account of what it
    // did not draw cannot disagree with the table's account of what it kept.
    narrowedByFilter: filtering,
    // **Every** stored dependency of the plan, `flat` and not `shownRows` since
    // F3. An edge whose ends are not both on screen is dropped by `layOutGantt`
    // and counted there, so the arrows drawn are the same ones as before — what
    // the widening adds is the edge that leaves a shown row for a hidden one,
    // which never reached the loop while this list was built from the
    // successors on screen, and so could not be counted or said.
    dependencies: flat.flatMap((row) =>
      row.dependsOn.map((predecessorId) => ({ predecessorId, successorId: row.id })),
    ),
    // All three off {@link chartRead}, which is one payload. **Not** `roles`
    // and `people`: those are the separate reads the pickers and the phases
    // dialog are about, and a slice checked against a role list from another
    // moment is the skew `layOutGantt` throws on.
    roles: chartRead.roles,
    personNames: new Map(chartRead.people.map((person) => [person.id, person.name])),
    teamNames: new Map(teams.map((team) => [team.id, team.name])),
    // The ladder the chart names its priorities with. Off the same state the
    // table's cells read, so a bar's cap and its row's digits are one colour.
    priorityBands,
  };

  // The `Start` column's sentences, off the same payload the chart is drawn
  // from and therefore off the same rows: a row narrowed away by the search has
  // no cell to explain, and one on a collapsed branch has none either.
  //
  // Assigned here rather than where the ref is declared because this is the
  // first line at which `ganttPlan` exists, and it is read out of the returned
  // tree — every cell renders after this statement has run.
  // The calendar is the second argument and not an optional one: a
  // dependency-floored row says *when* its wait clears, and a plan with no
  // start date has no day to say — `null` is that plan, stated rather than
  // defaulted into silence. `today` is the browser's, and it decides only
  // whether the year is printed (`shortIsoDate`).
  startFloor.current = startFloorByRow(
    ganttPlan,
    startDate === null ? null : { startDate, today: new Date() },
  );

  /**
   * The plan as one reader has it on screen: the rows the filter and the
   * collapse left, and a {@link FilteredScope} saying so.
   *
   * **A second export action and never a mode on the four above** — R10 §9's
   * Q3, settled 2026-08-17. Those four keep taking `flat` and keep claiming the
   * whole plan, because a button whose header says "the whole plan" is how
   * somebody hands a client a plan with rows missing. This one says what it is
   * in its own `Scope` line, in its file name, and in the fence's comment if it
   * ever grows one.
   *
   * Down here rather than beside {@link planForExport} because this is the one
   * export that needs `shownRows`, which is the table's own row model narrowed
   * — the same list the chart and the cards draw, so what this writes out is
   * what all three are showing and not a fourth answer.
   *
   * The figures are untouched: `slices` is the whole chart read and every date
   * is be-01's, computed over the whole plan whatever is on screen. The `Scope`
   * line says that out loud, because a reader holding a document of six rows
   * has no way to tell whether the dates were re-planned for them.
   */
  const planOnScreen = (): PlanExport => ({
    ...planForExport(),
    rows: shownRows.map((row) => row.original),
    scope: {
      totalRows: flat.length,
      // The filter's own account of itself — `filterWords`, the same criteria
      // object `narrowTree` was asked with and the same {@link filterLabels}
      // the saved-views panel reads, so the document cannot describe a
      // narrowing other than the one that produced its rows.
      criteria: filterWords(criteria, filterLabels),
    },
  });

  /**
   * Downloads what is on screen as a Markdown table with a `Scope` header.
   *
   * The **table** and not the bundled Mermaid document, which is the one thing
   * this action deliberately gives up: a document refuses when there is no
   * chart to draw (no start date, no schedule, nothing placed), and a filter
   * narrowed to parent rows alone places nothing — so the bundle would refuse
   * exactly where a reader most wants the rows they are looking at. A table
   * always writes.
   */
  const downloadOnScreen = (): void => {
    const plan = planOnScreen();
    const markdown = new Blob([planToMarkdown(plan)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(markdown);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = planFileName(plan, 'md');
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * The columns this render puts on screen, in order — which is exactly what a
   * `<colgroup>` declares and what the table's own width adds up. Read from the
   * table model rather than listed here, so unfolding a role cannot leave the
   * declared widths describing the columns of a moment ago.
   */
  const leafColumnIds = table.getVisibleLeafColumns().map((column) => column.id);

  /**
   * Every width this render declares, resolved once.
   *
   * The `<colgroup>`, the table's `min-width` and every pinned cell read this
   * one object — see {@link frameLayout}, which is where the five separate
   * arithmetics used to be. It is **not** read inside a column definition and
   * must never be: `flexRender` renders each `cell` as a component type, so a
   * definition that changed with a width would remount every cell in the table
   * and take the focus and the half-typed value with it (LLM_README landmine
   * #1).
   */
  const layout = frameLayout(leafColumnIds, frameState);

  /**
   * What the headings' hints may bend for, in one object beside the layout's.
   *
   * Read in the `<thead>` render and nowhere else, and deliberately **not**
   * inside a column definition — landmine #1 again: the schedule columns'
   * sentence changes the day the project gets a start date, and a definition
   * that changed with it would remount every cell in the table on that edit.
   */
  const hintState: ColumnHintState = { hasProjectStartDate: startDate !== null };

  /**
   * The resize handle for one heading — every leaf column carries one since
   * `name-column-drag`, the Name column included.
   *
   * Until that change a column resolving no width was refused a handle, and
   * Name was exactly that column. A dragged Name writes an override now, so
   * the suppression is retired: the one thing that still varies is where the
   * gesture's from-width comes from, and that is
   * {@link ColumnResizeHandle}'s to answer.
   *
   * `declaredHeading` is what the column definition calls itself, which is a
   * string for most of them and a node for the ones whose heading is a glyph or
   * carries a control. A node whose column declared
   * {@link ColumnMeta.spokenHeading} is called with the word instead — the call
   * site resolves it — and the rest fall back to the column id: a name a screen
   * reader can say, rather than a node this cannot read text out of.
   *
   * Proof: the call site reading `columnDef.header` alone, `says a mark
   * heading's word on the handle beside it` failed on `expected 'Resize
   * number' to be 'Resize Number'`. Watched on h2puni, 2026-08-12.
   *
   * @throws {Error} for a heading the layout did not resolve. Every header
   * cell in this table is a leaf column of the same model `layout` was built
   * from, so a miss is the overlap bug's shape — a column laid out by nothing
   * — not a state to render around.
   */
  function resizeHandleFor(columnId: string, declaredHeading: unknown): ReactNode {
    const resolved = layout.columns.find((column) => column.id === columnId);
    if (resolved === undefined) {
      throw new Error(`the ${columnId} heading is not a column this layout resolved`);
    }
    // Proof: the retired undefined-width suppression restored above this
    // return, `offers a handle on every column, the Name column included`
    // failed on `expected [ 'drag', 'number', 'depends', …(13) ] to deeply
    // equal [ 'drag', 'number', 'name', …(14) ]` — Name refused its handle
    // again. Watched, 2026-08-10.
    return (
      <ColumnResizeHandle
        columnId={columnId}
        heading={typeof declaredHeading === 'string' ? declaredHeading : columnId}
        width={resolved.width}
        state={frameState}
        resize={resizeColumn}
      />
    );
  }

  /**
   * Every control the toolbar holds, as one node.
   *
   * Built once and rendered in one of two places: the row above the table, or
   * the sheet the cards open. One list rather than two, because a control added
   * to a copy is a control one renderer does not have — and the sheet is the
   * only way to any of these on a phone.
   */
  const toolbarControls = (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => void run(() => api.freeze(projectId))}
        disabled={busy}
        {...busyAffordance(busy)}
      >
        Freeze numbering
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => void run(() => api.unfreezeProject(projectId))}
        disabled={busy}
        {...busyAffordance(busy)}
      >
        Unfreeze all
      </Button>
      <Button
        size="sm"
        type="button"
        // One of the three controls that aims the caret itself — the new
        // row's name, through `focusIntent` below. See {@link TAKES_THE_FOCUS}.
        {...{ [TAKES_THE_FOCUS]: '' }}
        onClick={addWorkItem}
        // The one write in this toolbar that is **not** `disabled={busy}`, and
        // {@link addWorkItem} is where the argument is: each click is its own
        // row, so refusing one loses work rather than deduplicating a command.
        // The affordance stays — the wait is still shown, it just no longer
        // eats what arrives during it.
        {...busyAffordance(busy)}
      >
        Add work item
      </Button>
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
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={filtering}
        title={
          filtering
            ? 'Clear the filter first — a filter opens whatever it has to.'
            : 'Close every branch'
        }
        onClick={() => {
          setExpanded({});
        }}
      >
        Collapse all
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={filtering}
        title={
          filtering
            ? 'Clear the filter first — a filter opens whatever it has to.'
            : 'Open every branch'
        }
        onClick={() => {
          setExpanded(true);
        }}
      >
        Expand all
      </Button>
      {/*
        The schedule as something to look at, under the plan. `aria-pressed`
        rather than two labels: it is one thing that is on or off, and a button
        whose word changes is a button that reads as "Gantt" when the chart is
        already there.

        Not disabled by `busy` and not by a cycle: it asks be-01 for nothing,
        and the panel is where the unscheduled state is said out loud.
      */}
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-pressed={ganttOpen}
        title="Draw the schedule under the plan"
        onClick={() => {
          setGanttOpen((open) => !open);
        }}
      >
        Gantt
      </Button>
      {/*
        The phases, which are the project's to choose since `R1 role-crud`.
        The button belongs to the dialog rather than sitting beside it: Radix
        restores the focus to its **trigger** on close and to nothing at all
        without one, so the two are one component. The surface itself lands in
        a portal, not here.

        Not disabled by `busy`: it has its own in-flight state, and a button
        that went dead while somebody else's edit was refetching would be
        unopenable on a plan two people are working on.
      */}
      {/*
        How many of each team on this plan are at work at once. Beside the phases
        for the reason it is beside them: both are the **project's** own lists,
        both move what the table draws, and the button belongs to the dialog rather
        than sitting next to it because Radix restores focus to its trigger.

        C3 put this box in the directory, where a global size belonged. The number
        is one plan's now — `capacity-per-project`, Dany 2026-08-13 — and the
        directory page has no plan; design.md D5 has the argument.

        Not disabled by `busy`: it has its own in-flight state, and a button that
        went dead while somebody else's edit was refetching would be unopenable on
        a plan two people are working on.
      */}
      <TeamsDialog
        teams={teamsOnThePlan(
          teams,
          teamCapacities,
          // Every row's **effective** teams, so a team only an ancestor carries
          // is offered a box: its pool is what the leaves below it spend. The
          // same reading the cell, the cards, the export and the bars use — one
          // `effectiveTeamsOf` per render and never a second copy. Flattened,
          // because a row on two teams puts a box beside each of them.
          flat.flatMap((row) => effectiveTeams.get(row.id)?.teamIds ?? []),
        )}
        setCapacity={(teamId, size) => api.setTeamCapacity(projectId, teamId, size)}
        onChanged={refreshOrMarkStale}
      />
      {/*
        What this plan calls its priority numbers, beside the Teams box because it
        is the same class of fact: a project's own configuration, read by every
        face, edited from the plan's own toolbar. `priority-bands`' design.md D5.
      */}
      <PrioritiesDialog
        bands={priorityBands}
        setBands={(bands) => api.setPriorityBands(projectId, bands)}
        onChanged={refreshOrMarkStale}
      />
      <PhasesDialog
        roles={roles}
        hiddenColumnIds={hiddenColumnIds}
        // The same object the `<colgroup>` above is resolved from, so the
        // figure this dialog quotes and the width the table lays out cannot
        // be answers to two different questions.
        frameState={frameState}
        numberOf={(workItemId) => flat.find((row) => row.id === workItemId)?.number ?? null}
        nameOf={(personId) => people.find((person) => person.id === personId)?.name ?? null}
        addRole={(name) => api.addRole(projectId, name)}
        renameRole={(roleId, name) => api.renameRole(projectId, roleId, name)}
        removeRole={(roleId, cascade) => api.removeRole(projectId, roleId, cascade)}
        // The same reread every other change on this page makes, which is what
        // puts the new columns on the table and the new list in the dialog.
        onChanged={refreshOrMarkStale}
      />
      {/*
        Find. Deliberately without `data-cell`: this is not a cell of the
        table's keyboard grid, and letting Tab and the arrows walk into it
        from the last cell of a row would put the caret somewhere no edit can
        be made.
      */}
      <Input
        className="h-8 w-32 text-xs"
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
      {/*
        The other six of R10's seven fields. Beside the Find box because they
        are the same act — narrowing the plan — and the count below counts what
        all seven left, not what each one did.
      */}
      <FilterFacets
        facets={facets}
        setFacets={setFacets}
        teams={facetTeams}
        tags={facetTags}
        services={facetServices}
        people={facetPeople}
        bands={facetBands}
        phases={facetPhases}
        // The two directory maps read as one bit each — the same two the row
        // facets are computed from, so the box and the answer behind it can
        // never disagree about whether the question is askable.
        ownershipKnown={ownershipKnown}
        membershipKnown={membershipKnown}
      />
      {/*
        Name the current filter, or pick one already named — R10 F4. Beside
        `FilterFacets` because saving and ticking are the same act's two
        moments, and applying a view writes {@link query} and {@link facets}
        exactly as typing and ticking would.
      */}
      <SavedViews
        views={savedViews}
        current={criteria}
        labels={filterLabels}
        onSave={(name) => {
          const next = [
            ...savedViews,
            { id: crypto.randomUUID(), name, criteria, hiddenColumnIds },
          ];
          setSavedViews(next);
          rememberSavedViews(projectId, next);
        }}
        onApply={(view) => {
          const { query: savedQuery, ...savedFacets } = view.criteria;
          setQuery(savedQuery);
          setFacets(savedFacets);
          // A view with no column set leaves the columns as they are — see
          // {@link SavedView}. One with a set applies it and remembers it, as
          // the Columns control would have.
          if (view.hiddenColumnIds !== undefined) {
            setStoredHiddenColumns(view.hiddenColumnIds);
            rememberHiddenColumns(projectId, view.hiddenColumnIds);
          }
        }}
        onDelete={(id) => {
          const next = savedViews.filter((view) => view.id !== id);
          setSavedViews(next);
          rememberSavedViews(projectId, next);
        }}
      />
      <ColumnsControl
        offered={offeredColumns}
        hiddenColumnIds={hiddenColumnIds}
        onToggle={toggleColumn}
      />
      {filtering && (
        <span role="status" className="text-muted-foreground text-sm">
          {shownRows.length} of {flat.length} rows
        </span>
      )}
      {/*
        Said out loud rather than left to an empty table, which reads as a
        plan that has been lost rather than a filter that found nothing. The
        count beside it stays, so `0 of 12 rows` says the twelve are still
        there.

        Two sentences, because a filter with nothing typed into it has no
        query to quote: `No matches for “”` would be a question mark where the
        reason should be.
      */}
      {filtering && search.matchIds.size === 0 && (
        <span className="text-sm">
          {query.trim() === ''
            ? 'No rows match these filters'
            : `No matches for “${query}”${facetsChosen(facets) > 0 ? ' with these filters' : ''}`}
        </span>
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
        <Button
          variant="outline"
          size="sm"
          type="button"
          // The second control that aims the caret itself: `walkToNextGap`
          // puts it in the cell that estimates the next gap. See
          // {@link TAKES_THE_FOCUS}.
          {...{ [TAKES_THE_FOCUS]: '' }}
          title={describeGaps(gaps)}
          onClick={walkToNextGap}
        >
          {gaps.leaves.length} unestimated
        </Button>
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
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !stack.undoable}
        {...busyAffordance(busy)}
        aria-label="Undo"
        title="Undo your last change to this plan (Ctrl/⌘ + Z)"
        onClick={() => {
          void stepStack('undo');
        }}
      >
        ↶
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !stack.redoable}
        {...busyAffordance(busy)}
        aria-label="Redo"
        title="Put back what you last undid (Ctrl/⌘ + Shift + Z)"
        onClick={() => {
          void stepStack('redo');
        }}
      >
        ↷
      </Button>
      {/*
        The way in for anyone who was never told about `?`, which is most
        people the first time. Not disabled by `busy`: it asks be-01 for
        nothing and reads nothing that a refetch could change.
      */}
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        // The third control that aims the caret itself: the cheat sheet takes
        // the focus onto its own panel as it mounts, and Radix's restore
        // arrives after it. See {@link TAKES_THE_FOCUS}.
        {...{ [TAKES_THE_FOCUS]: '' }}
        onClick={() => {
          setCheatSheetOpen(true);
        }}
      >
        ⌨
      </Button>
      {/*
        Sharing the plan, which is what most of it is written for. All four
        take the whole plan rather than what is on screen, and none asks
        be-01 for anything — so none is disabled by `busy`, and all four
        work while the socket is down or the tree is stale. What they cannot
        do is say the figures are current; the header's timestamp is what
        says when they were true. The two Mermaid buttons add a fourth
        clipboard/download outcome the CSV and Markdown-table pair do not
        have: a plan a gantt cannot be drawn of at all (no start date, no
        schedule, or nothing placed), reported the same way a refused
        clipboard write already is.
      */}
      {/*
        One menu for the five, since `configurable-columns`: measured at 1280,
        the five buttons took 683px of a 1248px toolbar and a thirteenth
        control pushed the row to three lines. A `<details>`, as Filters and
        Views are — no dismiss handler, and a `<button>` inside it still
        closes the phone's sheet (`closingControlIn`). The buttons keep their
        names, titles and handlers; the only thing that moved is where they
        sit.
      */}
      <details data-export className="relative">
        <summary
          className="border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none"
          title="Copy or download the plan — as a Markdown table, a Mermaid gantt, a CSV, or what is on screen"
        >
          Export
        </summary>
        <div
          data-export-panel
          className="bg-popover absolute z-50 mt-1 flex w-56 flex-col items-stretch gap-1 rounded-md border p-2 shadow-md"
        >
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Copy the whole plan as a Markdown table, with a header saying how to read it"
            onClick={copyAsMarkdown}
          >
            Copy as Markdown
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Copy the chart as a Mermaid gantt, for a Markdown document that draws it"
            onClick={copyAsMermaid}
          >
            Copy as Mermaid
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Download the whole plan as a CSV, with a header saying how to read it"
            onClick={downloadCsv}
          >
            Download CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Download the chart as a Mermaid gantt bundled with the Markdown table, with a header saying how to read it"
            onClick={downloadMermaidDocument}
          >
            Download as Markdown
          </Button>
          {/*
            The fifth action, and the only one that takes the rows on screen. Its
            own button rather than a switch on the four beside it: a mode on a
            button whose header claims the whole plan is how a partial plan gets
            sent as a whole one, which is what §9's Q3 refused. Always offered, not
            only while a filter is on — a collapsed branch narrows the screen too,
            and the `Scope` line it writes says which of the two did it.
          */}
          <Button
            variant="outline"
            size="sm"
            type="button"
            title="Download the rows on screen as a Markdown table, with a header saying what was filtered out and what is missing"
            onClick={downloadOnScreen}
          >
            Download what’s on screen
          </Button>
        </div>
      </details>
      <label className="ml-auto flex items-center gap-1 text-sm">
        Starts
        {/*
          The day the whole plan begins. Setting it moves every date at once,
          because every date is an offset from it — there is nothing stored
          per row to drag along.
        */}
        <DateField
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="Project start date"
          disabled={busy}
          {...busyAffordance(busy)}
          value={startDate ?? ''}
          commit={(typed) => {
            void run(() => api.setStartDate(projectId, typed === '' ? null : typed));
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        Plan with
        {/*
          A project-wide setting rather than a per-reader preference: the
          dates below are computed from it, and two people reading different
          dates off one plan is the failure this must not have.
        */}
        <select
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          aria-label="Final estimate"
          value={estimateMethod}
          disabled={busy}
          {...busyAffordance(busy)}
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
    </>
  );

  return (
    /*
      A link in the chain from `<main>` down to the frame: this section takes
      the height its parent has, and passes the remainder — what the toolbar and
      any banner leave — to the frame at the bottom of it. `min-h-0` is what
      lets it shrink below the table's own height; without it the whole chain
      falls back to content height and the frame never scrolls. `ProjectPage`
      has the same pair on `<main>`, and `table-frame.ts` has the why.
    */
    <section
      className="flex min-h-0 flex-1 flex-col"
      // How many slices the plan on screen was drawn from. The Gantt panel at
      // the bottom of this section draws them now, but only while it is open —
      // so this stays as the trace they leave with it closed, which is what
      // lets `wbs-table.test.tsx` watch "a refetch replaces the slices" break
      // without opening a chart.
      data-slice-count={chartRead.slices.length}
    >
      {/*
        Two places for one toolbar, and which one is a fact about the viewport.

        Wrapping, because this row of controls is the only thing on the page
        that can make it scroll sideways: it is about 1245px of buttons at its
        narrowest, and a window below that — a narrow one, or a wide one at
        125% zoom — carried the whole page with it while the table itself was
        behaving perfectly. Observed on h2puni, 2026-08-08. On a phone it does
        not wrap, it folds: 1245px of controls above a 390px screen is a page
        of buttons with the plan somewhere under them.
      */}
      {renderer === 'cards' ? (
        <div data-toolbar-sheet className="mb-1.5 flex shrink-0 items-center gap-2">
          <Modal open={toolbarSheetOpen} onOpenChange={setToolbarSheetOpen}>
            {/*
              The trigger belongs to the modal rather than sitting beside it,
              for `PhasesDialog`'s reason: Radix restores the focus to its
              trigger on close, and to nothing at all without one.
            */}
            <ModalTrigger asChild>
              <Button variant="outline" type="button" className="min-h-11">
                Plan actions
              </Button>
            </ModalTrigger>
            <ModalContent
              side="bottom"
              // Taking a control on this sheet is taking it on the plan behind
              // it, and the plan is what wants looking at next.
              //
              // **The bubble phase, and that is load-bearing.** As
              // `onClickCapture` this closed the sheet *before* the control's
              // own handler ran, and in a real browser that means the handler
              // never ran at all: React registers one capture listener and one
              // bubble listener per container, a discrete update flushes
              // between them, and the button is unmounted by the time the
              // bubble dispatch walks the fiber tree looking for handlers. So
              // every toolbar control on the sheet did nothing — no request,
              // no work item. jsdom passed all sixteen card tests through it,
              // because `Add work item`'s own `onClick` had already been
              // collected there.
              //
              // Found by a browser at 390×844, 2026-08-09: `POST
              // /api/projects/…/work-items` simply absent from the network log
              // after a click that closed the sheet.
              onClick={(event) => {
                const control = closingControlIn(event.target, event.currentTarget);
                if (control === null) return;
                // Assigned, never set: the flag outlives the click that wrote
                // it, so a `Collapse all` after an `Add work item` would read
                // the create's `true` and suppress a restore nothing had asked
                // for. Every close writes its own answer.
                sheetControlTakesTheFocus.current = control.hasAttribute(TAKES_THE_FOCUS);
                setToolbarSheetOpen(false);
              }}
              // Radix restores the focus to the trigger when a modal closes,
              // and it does it on a timer — so it lands *after* the refetch a
              // control on this sheet started, and takes the caret back off the
              // work item that control created. Refused for the three controls
              // that aim the caret themselves, and for nothing else: a sheet
              // closed by Escape, by the ✕, by a tap outside or by any of the
              // other dozen controls has aimed the caret nowhere, and the
              // trigger is exactly where the focus belongs.
              //
              // Proof: this handler removed, `lands the focus in the card of a
              // work item it just created` failed on `expected <button …> to be
              // <textarea …>` — Radix's restore arriving last. Watched,
              // 2026-08-09.
              //
              // Proof of the other half — the flag pinned back to an
              // unconditional `true`, which is what shipped: `gives the focus
              // back to the trigger when the control aimed the caret nowhere`
              // failed on `expected <body> to be <button …>`. Watched in jsdom
              // and in Chromium at 390×844 (`e2e/mobile.spec.ts`), 2026-08-09.
              onCloseAutoFocus={(event) => {
                if (!sheetControlTakesTheFocus.current) return;
                sheetControlTakesTheFocus.current = false;
                event.preventDefault();
              }}
            >
              <ModalHeader>
                <ModalTitle>Plan actions</ModalTitle>
              </ModalHeader>
              <div aria-busy={busy} className="flex flex-wrap items-center gap-2">
                {toolbarControls}
                {(ganttHeightPx !== null || ganttDayPx !== DAY_PX || !ganttLabelsShown) && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    title="Forget the chart height, the day scale and the hidden row names, and lay the Gantt out at its own again"
                    onClick={resetGanttSettings}
                  >
                    Reset layout
                  </Button>
                )}
              </div>
            </ModalContent>
          </Modal>
        </div>
      ) : (
        <div
          data-toolbar
          // Said out loud, because a control that is unavailable for a moment
          // and one that is unavailable for good look the same otherwise —
          // see {@link busyAffordance} for the click this makes visible.
          aria-busy={busy}
          className="mb-1.5 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1"
        >
          {toolbarControls}
          {/*
            The layout reset, and the whole of why it is **here** — the
            toolbar row's own child — rather than in `toolbarControls`: that
            array is rendered both in this row and in the Plan actions sheet,
            so a control put there reaches the phone by construction. The
            width half stays here because a phone card has no columns to
            widen; the sheet instead carries its own Gantt-only reset, for
            the height, day scale and row-name labels a card does have.

            Offered only while there is something to forget — a dragged
            column or a dragged chart edge. A control that provably does
            nothing reads as a broken one. Proof of the height half: the
            `ganttHeightPx` arm of the condition removed, `a height override
            alone offers the reset…` failed on `Unable to find … "Reset
            layout"`. Watched, 2026-08-10.

            Proof of the placement: the reset moved into `toolbarControls`,
            `plan-cards.test.tsx`'s `offers no width control at all, because a
            card has no columns` failed on `expected <button …(2)></button> to
            be null` — the control on the sheet at 390px. Watched, 2026-08-09.
          */}
          {(widthOverrides.size > 0 ||
            columnsDiffer ||
            ganttHeightPx !== null ||
            ganttDayPx !== DAY_PX ||
            !ganttLabelsShown) && (
            <Button
              variant="outline"
              size="sm"
              type="button"
              title="Forget the widths, the hidden columns, the chart height, the day scale and the hidden row names set here, and lay the layout out at its own again"
              onClick={resetLayout}
            >
              Reset layout
            </Button>
          )}
        </div>
      )}

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
        <p
          role="alert"
          data-stale-tree
          className="border-destructive/40 bg-destructive/10 mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
        >
          This plan may be out of date — the last refresh failed.{' '}
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              void refreshOrMarkStale();
            }}
          >
            Retry
          </Button>
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
        <p
          className="border-destructive/40 bg-destructive/10 mb-3 rounded-md border px-3 py-2 text-sm"
          role="alert"
        >
          These dependencies run in a circle, so no dates can be worked out. Remove one to fix it.
        </p>
      )}

      {!connected && (
        <p className="text-muted-foreground mb-3 text-sm" role="status">
          Reconnecting — edits by other people may not be shown yet.
        </p>
      )}

      {renderer === 'cards' ? (
        /*
          The same rows, the same order, the same open branches: `shownRows` is
          the table model's answer and both renderers draw it. What the cards
          get instead of the frame is an ordinary scrolling column — there is
          nothing sticky to hold, because there are no columns to pin.
        */
        <PlanCards
          rows={shownRows.map((row) => ({
            row: row.original,
            depth: row.depth,
            // No triangle while a search is on, for the reason the Number
            // column gives: what is open during a search is the search's own
            // answer, and a control that appeared to do nothing reads as broken.
            expandable: row.getCanExpand() && !filtering,
            expanded: row.getIsExpanded(),
            toggleBranch: row.getToggleExpandedHandler(),
            // The same set the table's Name cell marks from, so a plan read on
            // a phone and on a laptop marks the same rows. Read straight here
            // rather than through `live`: the cards are not a memoised column
            // definition, and there is no per-keystroke remount to protect.
            matched: search.matchIds.has(row.id),
          }))}
          roles={roles}
          priorityBands={priorityBands}
          gridRef={(node) => {
            gridElement.current = node;
          }}
          commitName={commitNameCell}
          claimFocus={(node, cell) => {
            focusIntent.current.landOnAttached(node, cell, gridElement.current);
          }}
          estimateValue={combinedValue}
          estimateProblem={combinedProblem}
          commitEstimate={commitCombinedEstimate}
          enterEstimate={enterFoldedCell}
          readEstimate={readFoldedCell}
          closeMention={closeMention}
          leaveEstimate={leaveFoldedCell}
          mentionOptions={mentionOptions}
          assigneeOn={assigneeOn}
          waitsFor={waitsFor}
          // The Depends cell's own picker rule and its own two writers, handed
          // to the face that had neither. `depEntriesFor` is `pickerEntries`,
          // which is a *ported copy of be-01's judgement* about which edges are
          // refusable — the one rule in this dimension that two implementations
          // would quietly disagree about — so the card asks the same question of
          // the same function and greys the same rows. `pickDependency` and
          // `removeDependency` are the paths the table's list and its chip `✕`
          // take, for `rowActions`' bargain, a fifth dimension over.
          dependencyOptions={(row, typed) => depEntriesFor(row, typed)}
          addDependency={(row, predecessorId) => {
            return pickDependency(row.id, predecessorId);
          }}
          dropDependency={(row, predecessorId) => {
            return run(() => api.removeDependency(row.id, predecessorId));
          }}
          // The `Start` cell's own sentence, off the one map, handed to the
          // face that has no hover to give it. `startFloor.current` is filled
          // two hundred lines above this JSX, from the same `ganttPlan` the
          // chart is drawn from — so a plan read on a phone and on a laptop
          // cannot be told two different things about one wait.
          //
          // `?? null` and never the empty string: a row this map has no entry
          // for is a row the geometry refused to explain, and the card's
          // contract is that `null` is the only way to say so.
          startFloor={(row) => startFloor.current.get(row.id) ?? null}
          teamLabel={effectiveTeamLabelOf}
          // The Service/team cell's own directory and its own two writers,
          // handed to the other face — `rowActions`' bargain, one dimension
          // over. Not card-shaped copies: `setTeamOf` is what makes the patch
          // and `createTeamFor` is what makes a team idempotently by name, so a
          // team chosen on a phone reaches be-01 by the path a team chosen on a
          // laptop reaches it by.
          teams={teams}
          setTeams={(row, teamIds) => {
            return setTeamOf(row.id, teamIds);
          }}
          createTeam={(row, name, currentTeamIds) => {
            return createTeamFor(row.id, name, currentTeamIds);
          }}
          // The `not-before` cell's own question and its own writer, handed to
          // the face that had neither. `hasCalendar` is the cell's `noCalendar`
          // read the positive way round: without a project start date be-01
          // ignores the constraint, so both faces refuse rather than taking a
          // date that would do nothing.
          hasCalendar={startDate !== null}
          // Both boxes in one call, which is what the third argument is for —
          // `setNotBefore` is the table's own writer widened, not a card-shaped
          // copy, so a date set on a phone reaches be-01 by the path a date set
          // on a laptop reaches it by, and the pair rule be-01 checks inside one
          // transaction is answered by one request.
          setNotBefore={(row, day, reason) => {
            setNotBefore(row.id, day, reason);
          }}
          // The Prio cell's own writer, handed to the face that had none — and
          // the string, not a parsed number, because `setPriority` is where
          // three rules live that a card must not keep a second copy of: a
          // band's name resolving to its number, the refusal toast for
          // anything that is not a whole number from 1 upward, and an emptied
          // box meaning `null` rather than `0`.
          setPriority={(row, typed) => {
            return setPriority(row.id, typed);
          }}
          tagLabel={effectiveTagLabelOf}
          tags={tags}
          setTags={(row, tagIds) => {
            return setTagsOf(row.id, tagIds);
          }}
          createTag={(row, name, current) => {
            return createTagFor(row.id, name, current);
          }}
          serviceLabel={effectiveServiceLabelOf}
          services={services}
          setServices={(row, serviceIds) => {
            return setServicesOf(row.id, serviceIds);
          }}
          createService={(row, name, current) => {
            return createServiceFor(row.id, name, current);
          }}
          // The same sentence the Services cell's `△` carries, handed to the
          // face that had none. Not a card-shaped copy of the rule: one memo
          // (`mismatchByRow`) answers both renderers, so a phone and a laptop
          // cannot disagree about which services a team does not own.
          nonOwner={nonOwnerNoteOf}
          spanOf={spanOf}
          showDay={showDay}
          // The `actions` column's own three handlers, handed to the only other
          // face this plan has. Not card-shaped copies of them: `duplicateRow`
          // and `deleteRow` are the callbacks the table's ⋯ calls, so a row
          // duplicated on a phone lands the caret where a row duplicated on a
          // laptop does, and a delete promotes its children the same way.
          //
          // Read straight rather than through `live`, unlike the column that
          // does the same three things: `columns` is a memo that must not
          // depend on state, and this is ordinary JSX in the render — reading
          // `live.current` here would pin the handlers to whichever render
          // built the ref last.
          //
          // Unfreeze has no `unfreezeRow` of its own to borrow because the
          // table has none either; both faces spell it the same way, one `run`
          // around one request.
          rowActions={{
            busy,
            duplicate: (rowId) => {
              void duplicateRow(rowId);
            },
            unfreeze: (rowId) => {
              void run(() => api.unfreeze(rowId));
            },
            remove: (row) => {
              void deleteRow(row);
            },
          }}
        />
      ) : (
        <>
          {/*
            The table scrolls inside this, in both directions, so the page never
            scrolls sideways and the toolbar and the alerts above stay where they
            were put. The heading row and the three identity columns are sticky
            against this box — see `table-frame.ts` for why it has to be the one
            that scrolls.
          */}
          <div data-table-frame ref={frameRef} style={TABLE_FRAME}>
            {/*
            `separate` with no spacing rather than the browser's default gap:
            the pinned columns' offsets are the running total of their widths,
            and two pixels between every pair of cells is two pixels the offsets
            do not know about.
          */}
            {/*
            `data-grid` marks the whole of the editable grid for the cascade, and
            it is the only thing this change writes into the table. Every rule in
            `styles.css`'s `@layer base` carries `:not([data-grid], [data-grid] *)`,
            so the scoped reset the vendored components need stops at this
            element: the cells, their inputs, the ⋯ menu and both pickers keep the
            `box-sizing`, margins and platform font the browser gives them, which
            is what `table-frame.ts`'s width table was measured against.

            An attribute rather than a class, because it is a marker and not a
            style — and because `editable-grid.ts` finds the grid by it: since
            `X live-editing-extraction` that module reads this attribute rather
            than `closest('table')`, so a renderer that is not a table still has
            a grid (agy #11).
          */}
            <table
              data-grid
              // A callback rather than the ref object itself: `gridElement` holds
              // an `HTMLElement` since `M mobile-cards` — a `<table>` here and a
              // list of cards below the breakpoint — and React will not hand a
              // widened ref object to a `<table>`.
              ref={(node) => {
                gridElement.current = node;
              }}
              style={{
                borderCollapse: 'separate',
                borderSpacing: 0,
                // `fixed`, so the browser lays every column out at the width
                // `table-frame.ts` says it has. Under the default `auto` the
                // widths were a suggestion the content could outvote, and a column
                // that came out wider than the offsets assumed is a pinned Name
                // painted over "Depends on".
                tableLayout: 'fixed',
                // The frame's width at rest, and the resolved sum while a
                // dragged Name holds an override — `tableWidthStyle` is the
                // one line the excess-width measurement decided, and its JSDoc
                // holds the observation. The minimum stays the floor either
                // way: below it the frame scrolls sideways with the pinned
                // columns holding the left edge.
                ...tableWidthStyle(layout),
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
                {layout.columns.map((column) => (
                  // `colWidth`, not `width`: a dragged Name resolves a width
                  // and its `<col>` must still stay silent, or fixed layout
                  // distributes the viewport's excess across every sized
                  // column and moves Number off its measured envelope. The
                  // dragged width rides on the Name cells below;
                  // `e2e/layout.spec.ts` measures the consequence.
                  // Proof: re-pointed at `column.width`, `lays a remembered
                  // Name width on the Name cells, and leaves its <col> silent`
                  // failed on `expected '300px' to be ''` — a sized
                  // `<col name>`. Watched, 2026-08-10. The browser half of the
                  // same fault — the viewport's excess distributed, Number off
                  // 93 — is `e2e/layout.spec.ts`'s to watch.
                  <col
                    key={column.id}
                    style={column.colWidth === undefined ? undefined : { width: column.colWidth }}
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
                        // The word, where the heading under it is a mark; see
                        // {@link ColumnMeta.spokenHeading}. Undefined for every
                        // other column, which renders no attribute at all.
                        aria-label={header.column.columnDef.meta?.spokenHeading}
                        // What this column does to the plan (`column-hints.ts`).
                        // On the `<th>` and not on the heading inside it, for
                        // the reason the `aria-label` is: the cell is what the
                        // reader is resting on, and a `title` on an inner
                        // `<span>` covers the word and none of the padding
                        // around it. The two headings that carry their own
                        // `title` after this — the role's fold button and the
                        // resize handle — describe a *control*, not a column,
                        // and the fold button opens with this same sentence so
                        // that hovering it still teaches the column.
                        title={hintFor(header.column.id, hintState)}
                        style={{
                          ...CELL,
                          ...STICKY_HEADER_CELL,
                          ...flexibleCellStyle(header.column.id, frameState),
                          ...pinnedCellStyle(layout, header.column.id, 'header'),
                        }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {/*
                        The grab handle, on the trailing edge of every column
                        the layout declared a width for and on no other. The one
                        column that resolves without a width is the flexible
                        one, and it has nothing to be dragged to: it is the
                        remainder above its floor, and asking for its declared
                        width is already an error.

                        Rendered here rather than in the column definition,
                        which is the rule the whole seam is built around: a
                        definition that changed with a width remounts every cell
                        in the table (landmine #1). The `<th>` is
                        `position: sticky` through `STICKY_HEADER_CELL`, which
                        is what the absolute strip is positioned against.
                      */}
                        {resizeHandleFor(
                          header.column.id,
                          header.column.columnDef.meta?.spokenHeading ??
                            header.column.columnDef.header,
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {shownRows.map((row) => (
                  <tr
                    key={row.id}
                    // The row's identity, on the row — the handle the browser
                    // proofs find a dependency's `<tr>` by (precedent:
                    // `data-armed`, `data-drop`). Nothing in the app reads it.
                    data-row-id={row.original.id}
                    data-frozen={row.original.frozenNumber !== null ? 'true' : 'false'}
                    // Lit because some hovered Depends on cell names this row.
                    // The tint itself lands on the cells through the
                    // `--cell-bg` join (`styles.css`), never on the `<tr>`,
                    // for `data-armed`'s reason: a pinned cell paints its own
                    // opaque background and would cover a colour set here.
                    data-dep-lit={depLit.has(row.original.id) ? 'true' : undefined}
                    // Lit because the pointer, or a bar's focus, is on this
                    // row's mark **on the chart**. From `pointedFromChart` and
                    // never `pointedAt`: a row the pointer is resting on here is
                    // already tinted by `tr:hover`, and writing this on it as
                    // well made `tr:not([data-row-lit])…:nth-child(even):hover`
                    // unmatchable and stopped the stripe moving under the
                    // pointer at all — see the state's own doc.
                    //
                    // A **second attribute** beside `data-dep-lit` rather than a
                    // reuse of it: the two share the tint and not the meaning,
                    // and `data-dep-lit` is read by tests and by a reader as
                    // "some Depends on cell waits for this row", which a bar's
                    // hover would make untrue. The tint lands on the cells
                    // through `--cell-bg` for the reason above.
                    data-row-lit={pointedFromChart === row.original.id ? 'true' : undefined}
                    // Enter and leave, not over and out: a pointer moving from
                    // one `<td>` of this row to the next fires `pointerout` on
                    // the first, and reading that as a departure would clear
                    // the light halfway across the row it is meant to be on.
                    // React synthesizes these two from over/out and decides
                    // "left" from where the pointer went, which is the question
                    // being asked.
                    onPointerEnter={(pointer) => {
                      // **The touch seam.** Chromium synthesizes a whole mouse
                      // sequence from a tap, so a row lit on a mouse event
                      // lights on every tap as well — and a tap has no
                      // departure behind it, so the light would then be stuck
                      // on whatever was touched last. The bar's own
                      // `onPointerOver` carries this guard for the same reason.
                      if (pointer.pointerType !== 'mouse') return;
                      setTablePointedRow(row.original.id);
                    }}
                    onPointerLeave={(pointer) => {
                      if (pointer.pointerType !== 'mouse') return;
                      // Cleared only if this row is still the pointed one. A
                      // departure from a row the pointer has already left —
                      // which is the order the events arrive in when it moves
                      // straight to the next row — would otherwise clear the
                      // light the arrival had just set.
                      setTablePointedRow((pointed) =>
                        pointed === row.original.id ? null : pointed,
                      );
                    }}
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
                      setDropHint((current) =>
                        current?.rowId === row.original.id ? null : current,
                      );
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
                        // The dependency light's own cell-level reading, on the
                        // cell. See {@link dependsCellHoverProps}: it is the
                        // whole `<td>` and not a wrapper inside it, because the
                        // gesture the spec names is "the pointer is in this
                        // cell" and a wrapper stands inside the padding.
                        {...(cell.column.id === 'depends'
                          ? dependsCellHoverProps(row.original)
                          : {})}
                        {...(cell.column.id === 'start' ? startCellProps(row.original) : {})}
                        style={{
                          ...CELL,
                          // The exception to the cell clip. See
                          // {@link opensAPopover}: a popover's containing block is
                          // the wrapper span *inside* this `<td>`, so this `<td>`
                          // clips it unless it is told not to.
                          ...(opensAPopover(cell.column.id)
                            ? { overflow: 'visible' as const }
                            : {}),
                          ...(cell.column.id === 'start' &&
                          startCellProps(row.original).title !== undefined
                            ? { cursor: 'help' as const }
                            : {}),
                          ...flexibleCellStyle(cell.column.id, frameState),
                          ...pinnedCellStyle(layout, cell.column.id, 'body'),
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
                          ...(cell.column.id === 'name' &&
                          openCard === cellKey(row.original.id, 'name')
                            ? { zIndex: POPOVER_ROW_LAYER }
                            : {}),
                          // After the pinned background, so the warning is visible
                          // on the three columns that hold the left edge too.
                          ...(armedDelete?.rowId === row.original.id
                            ? { background: ARMED_TINT }
                            : {}),
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
        </>
      )}

      {/*
        Under the plan and inside the section, so the frame splits vertically:
        the panel scrolls itself and the table keeps its own frame. Neither is
        allowed to make the page scroll sideways, which is what the panel's own
        `overflow-auto` is for.

        Mounted under either renderer — the chart is the same chart on a phone,
        and the toggle that mounts it is in the same one toolbar the sheet
        opens.
      */}
      {ganttOpen && <GanttHeightHandle heightPx={ganttHeightPx} resize={resizeGantt} />}
      {ganttOpen && (
        // The boundary wraps the panel and nothing else, which is the whole of
        // the degradation this feature is allowed: a chart that cannot be drawn
        // costs the reader the chart, never the editor above it. See
        // {@link GanttFaultBoundary} for why it resets on the read rather than
        // on a key. The height handle above stands outside it for the same
        // reason turned around: the fault must not take the drag with it.
        <GanttFaultBoundary generation={chartRead.generation}>
          <GanttPanel
            plan={ganttPlan}
            startDate={startDate}
            scheduleError={scheduleError}
            generation={chartRead.generation}
            heightPx={ganttHeightPx}
            dayPx={ganttDayPx}
            // Stored where it is set and nowhere else, exactly as a let-go drag
            // is: opening a project must not write to it.
            onPickDayPx={(picked) => {
              setGanttDayPx(picked);
              rememberGanttDayPx(projectId, picked);
            }}
            labelsShown={ganttLabelsShown}
            // Stored where it is set and nowhere else, as the rung beside it is.
            onPickLabelsShown={(shown) => {
              setGanttLabelsShown(shown);
              rememberGanttLabels(projectId, shown);
            }}
            onPickRow={goToRow}
            // The panel reports which row the pointer or a bar's focus is on,
            // and is handed back the answer both faces light. The two halves go
            // to their own state for {@link pointedRow}'s reason: a bar's blur
            // must not clear a light the pointer is holding.
            onPointRow={(rowId, from) => {
              if (from === 'pointer') setChartPointedRow(rowId);
              else setChartFocusedRow(rowId);
            }}
            pointedRow={pointedAt}
          />
        </GanttFaultBoundary>
      )}

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
          // The sheet says what *this* renderer answers, and nothing else. The
          // cards wire no chords at all, and a sheet promising ⌘+Enter on a
          // phone is the promise nothing keeps.
          renderer={renderer}
          onClose={() => {
            setCheatSheetOpen(false);
          }}
        />
      )}
    </section>
  );
}
