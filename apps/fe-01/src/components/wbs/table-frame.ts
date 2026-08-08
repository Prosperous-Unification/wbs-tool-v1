import type { CSSProperties } from 'react';

import { POINTS } from './estimate-draft';

/**
 * Every column the table can show by a fixed id, with the width
 * `table-layout: fixed` holds it to, in px.
 *
 * THE single source of truth for how wide anything in this table is: the
 * `<colgroup>` renders these numbers, {@link tableMinWidth} adds them up, and
 * the pinned offsets are prefix sums of the same numbers — so the geometry the
 * offsets assume is the geometry the browser lays out. The overlap this
 * replaces came from three width systems at once (declared px on the pinned
 * cells, auto table layout everywhere else, em-sized inputs inside the cells)
 * with no invariant tying any of them together, which is how a pinned Name
 * came to paint over "Depends on".
 *
 * These numbers are the compaction Dany asked for on 2026-08-08 ("compact
 * every column as far as it will go"), and every one of them is a figure the
 * browser gate measures rather than a preference: the table has to fit a
 * 1280px laptop with two roles folded, and `752 + 2×96 + 200` is what makes
 * that true. `name` is deliberately absent — see {@link FLEXIBLE_COLUMNS}.
 *
 * A `Map` rather than a plain object because the id being looked up is a
 * column id from the table model, not a key known here: a `Record<string,
 * number>` would type every miss as a `number` and the check below as dead
 * code, which is precisely the check that must not be dead.
 */
const COLUMN_WIDTHS = new Map<string, number>([
  // The handle and nothing else. 28 was room for a handle and a hover target;
  // the glyph is the hover target.
  ['drag', 24],
  // 168 fitted the deepest number beside the deepest indent. 100 fits it
  // beside {@link indentFor}'s shorter step, and a number deeper than that
  // clips rather than setting the width of every row above it.
  ['number', 100],
  // No `name`: it is the column that absorbs whatever the others leave.
  ['depends', 110],
  ['team', 120],
  ['final-total', 52],
  // The one column this repository does not get to choose. A native date
  // input's own furniture — the separators, the spinner and the picker icon —
  // sets a floor, and the browser gate measures it rather than arguing with
  // it: an unconstrained `input[type=date]` in the table's font asks Chromium
  // for **138px**, so the column is that plus {@link CELL}'s 8px of padding.
  // The plan proposed 108; a browser said no, and the assertion is what the
  // number moves with if a future one asks for more.
  ['not-before', 146],
  ['start', 52],
  ['finish', 52],
  ['float', 56],
  // No `notes`: a work item's notes are typed under its name, in the Name
  // cell, and the column they had of their own is gone. 260px of a table that
  // has to lose about 500 to stop scrolling sideways at 1280.
  // One ⋯ button, not a pair of labelled ones: 110 was the width Duplicate and
  // Delete needed side by side, and the menu they moved into hangs off this
  // cell rather than living in it.
  ['actions', 40],
]);

/**
 * The columns with no declared width, which take what the fixed ones leave.
 *
 * A table that fits the window is a table with one column that is not a
 * number: everything else is a figure, a date or a control of a known size,
 * and the name is the sentence that should have the rest. So the `<colgroup>`
 * emits no `<col width>` for these and `table-layout: fixed` divides the
 * remainder among them.
 *
 * A set, not a sentinel width. {@link widthFor} keeps throwing on anything it
 * has no number for, because a flexible column and an unsized one look
 * identical to a caller that gets a plausible number back — and the caller
 * that must not get one is the pinned-offset arithmetic. Membership here is
 * the question to ask instead.
 */
export const FLEXIBLE_COLUMNS: ReadonlySet<string> = new Set(['name']);

/**
 * The narrowest a flexible column is allowed to become, in px.
 *
 * It is what {@link tableMinWidth} budgets for the Name column, and it is on
 * the cell as well: below this the table stops shrinking and the frame scrolls
 * instead, with the pinned columns holding the left edge. 200px is about
 * twenty-five characters of the page's font — a phrase rather than a word.
 */
export const FLEXIBLE_FLOOR = 200;

/**
 * The widths of a role's columns, which have no fixed ids: a role is created at
 * runtime and its columns are named `<roleId>-final`, `<roleId>-<point>` and
 * `<roleId>-assignee`. Sized by suffix, because the role half of the id is
 * whatever the project called it.
 *
 * The folded column is the one that grew: it shows the figure *and* who is
 * doing the work (`4.8 · Kat`) since the assignee stopped folding away with
 * the trio. The three point boxes hold a number of days and are sized for one.
 */
const ROLE_FINAL_WIDTH = 96;
const ROLE_POINT_WIDTH = 52;
const ROLE_ASSIGNEE_WIDTH = 120;

/** An id the width table has never heard of — a typo, or a new column nobody sized. */
export class UnknownColumnError extends Error {
  constructor(columnId: string) {
    super(
      `No declared width for column "${columnId}". Every rendered column ` +
        `must be in COLUMN_WIDTHS or use a role suffix — an unlisted one would ` +
        `silently get a wrong width, which is the overlap bug all over again.`,
    );
    this.name = 'UnknownColumnError';
  }
}

/**
 * How wide the column with this id is laid out, in px.
 *
 * Never ask it about a {@link FLEXIBLE_COLUMNS} member: those have no declared
 * width by design and this throws for them exactly as it does for a typo. That
 * is the point — a sentinel would let the pinned-offset arithmetic add a
 * number the browser never uses.
 *
 * @throws {UnknownColumnError} when nothing declares a width for that id.
 * Unknown is not OK here: a column that fell through to a default would be laid
 * out at one width while the pinned offsets were summed from another, and the
 * two disagreeing is exactly the overlap this module exists to make impossible.
 */
export function widthFor(columnId: string): number {
  const declared = COLUMN_WIDTHS.get(columnId);
  if (declared !== undefined) return declared;
  if (columnId.includes('-')) {
    if (columnId.endsWith('-final')) return ROLE_FINAL_WIDTH;
    if (columnId.endsWith('-assignee')) return ROLE_ASSIGNEE_WIDTH;
    const point = columnId.slice(columnId.lastIndexOf('-') + 1);
    if ((POINTS as readonly string[]).includes(point)) return ROLE_POINT_WIDTH;
  }
  throw new UnknownColumnError(columnId);
}

/**
 * The narrowest the whole table may be laid out, in px: every fixed column at
 * its declared width plus {@link FLEXIBLE_FLOOR} for each flexible one.
 *
 * Set as `min-width` on a `<table>` that is otherwise `width: 100%`, which is
 * the whole of how this table fits a window. Above this number there is no
 * horizontal scroll at all and the pinning is invisible; below it the frame
 * scrolls and the pinned columns hold the left edge, which is the backstop
 * `sticky-table-frame` built and Dany kept.
 *
 * It is a per-state number rather than a constant, and that is what makes it
 * honest: two roles folded is `752 + 192 + 200 = 1144`, one of them unfolded is
 * `752 + 372 + 96 + 200 = 1420`. The first fits a 1280 laptop and the second
 * does not — which is why unfolding is an accordion, and why the number is
 * computed from the columns actually on screen rather than asserted once.
 *
 * @throws {UnknownColumnError} through {@link widthFor}, for a column nobody
 * sized. A minimum that quietly omitted a column would be a table declared
 * narrower than it lays out.
 */
export function tableMinWidth(columnIds: readonly string[]): number {
  return columnIds.reduce(
    (total, id) => total + (FLEXIBLE_COLUMNS.has(id) ? FLEXIBLE_FLOOR : widthFor(id)),
    0,
  );
}

/**
 * The columns held at the left edge while the table is scrolled sideways, in
 * order from that edge, each with the width it is held to — or `undefined`
 * where the layout decides it.
 *
 * Contiguity from the edge is not a preference: `position: sticky; left` pins a
 * cell at a fixed offset, so a pinned column with an unpinned one in front of it
 * would hang over whatever scrolled through the gap. That is why "Depends on"
 * sits to the right of Name rather than between it and Number —
 * `openspec/changes/sticky-table-frame/proposal.md` has the reversal written
 * down.
 *
 * The widths come from {@link COLUMN_WIDTHS} rather than being repeated here:
 * each offset is the sum of the widths in front of it, so Name lands beside
 * Number only while the number this offsets by is the number the browser lays
 * Number out at. Two lists of widths is one list too many.
 *
 * Name being flexible does not disturb any of that, and the reason is worth
 * stating: it is the *last* pinned column, so no offset is ever a sum that
 * includes it. {@link PINNED_GEOMETRY} throws rather than assumes that.
 */
export const PINNED_COLUMNS: readonly { id: string; width: number | undefined }[] = (
  ['drag', 'number', 'name'] as const
).map((id) => ({
  id,
  width: FLEXIBLE_COLUMNS.has(id) ? undefined : widthFor(id),
}));

/** How many levels the Number column indents a row before it stops. */
export const DEEPEST_INDENT = 4;

const INDENT_STEP = 12;

/**
 * The Number cell's indent for a row `depth` levels down, in px.
 *
 * The cap is what keeps the pinned columns from overlapping. Number is held to a
 * declared width, and an indent that kept growing would push the number itself
 * past that width — where Name, pinned at the sum of the widths in front of it,
 * would paint straight over it once the table is scrolled sideways. Past
 * {@link DEEPEST_INDENT} levels a row stops moving right; the number printed in
 * the cell still says how deep it is.
 *
 * The step is 12px rather than 16 because the column is 100px rather than 168:
 * four levels take 48 of it and the number itself keeps the larger half.
 */
export const indentFor = (depth: number): number => Math.min(depth, DEEPEST_INDENT) * INDENT_STEP;

const PINNED_GEOMETRY = new Map<string, { left: number; width: number | undefined }>(
  PINNED_COLUMNS.map((column, at) => [
    column.id,
    {
      left: PINNED_COLUMNS.slice(0, at).reduce((total, before) => {
        if (before.width === undefined) {
          // Unknown is not OK, and this is the shape of the unknown: a
          // flexible column's width is whatever the frame leaves over, so
          // every column pinned after one would be pinned at an offset that is
          // right at exactly one window size. Name is last today; this is what
          // stops a fourth pinned column being added behind it in silence.
          throw new Error(
            `${before.id} has no declared width, so ${column.id} cannot be pinned after it — ` +
              `a sticky offset is a sum of the widths in front of it and a flexible column has none.`,
          );
        }
        return total + before.width;
      }, 0),
      width: column.width,
    },
  ]),
);

/**
 * Where a pinned column sits, or nothing when that column is not pinned.
 *
 * `width` is `undefined` for a flexible column: the `<colgroup>` owns that
 * number and there isn't one to declare here.
 */
export function pinnedGeometry(
  columnId: string,
): { left: number; width: number | undefined } | undefined {
  return PINNED_GEOMETRY.get(columnId);
}

const HEADER_BACKGROUND = '#f4f4f4';
const ROW_BACKGROUND = '#fff';

/**
 * Which sticky cell paints over which. A pinned header cell is sticky on both
 * axes and crosses every other one, so it is on top; the header row crosses the
 * body; a pinned body cell only crosses the cells scrolling behind it.
 *
 * The pickers inside the cells sit at `z-index: 10` and above, deliberately
 * higher than all of these: an open list has to be readable over a pinned
 * column, and it closes the moment the person is done with it.
 *
 * {@link POPOVER_ROW_LAYER} is the fourth, and it exists because a browser
 * found the reason. A pinned cell is `position: sticky` **with a z-index**,
 * which makes it a stacking context — so a popover inside one is trapped in
 * it, however high its own z-index, and the *next* row's pinned cell paints
 * straight over it. The Name column is the only cell in this table that is
 * both pinned and holds a popover, and the notes preview hanging off it was
 * invisible under the row below until this layer existed. Observed on h2puni,
 * 2026-08-08: `4px below the name cell is <textarea> in the name column, not
 * the preview`.
 *
 * It sits above the other body cells and below both header layers, which is
 * the whole of what it has to do: the preview opens downwards, over the rows,
 * and the heading stays a heading.
 */
const PINNED_BODY_LAYER = 1;
export const POPOVER_ROW_LAYER = 2;
const HEADER_LAYER = 3;
const PINNED_HEADER_LAYER = 4;

/**
 * What every `<td>` and `<th>` carries, spread before anything a particular cell
 * adds.
 *
 * `border-box` is what makes the declared width the width including the cell's
 * own padding — without it every column is a few pixels wider than the offset
 * computed from it and the pinned edge drifts a little further with each one.
 *
 * `overflow: hidden` is the backstop. Every control in a cell is sized to follow
 * that cell, but "paints into the neighbouring column" has to be structurally
 * impossible rather than a rule each control is trusted to keep — including for
 * a descendant nobody thought about.
 *
 * It is a backstop with holes cut in it, and the rule that cuts them is worth
 * stating exactly, because this comment first stated it backwards. An
 * absolutely positioned box escapes an `overflow: hidden` ancestor only when
 * its containing block — its nearest *positioned* ancestor — is **outside**
 * that clipper. It is not enough for the containing block itself not to clip.
 * Everything in this table that must escape its cell — the dependency listbox,
 * the notes preview, a picker's list — sits in a `position: relative` wrapper
 * span that is **inside** the `<td>`, so the `<td>`'s own clip cuts it to the
 * cell rectangle no matter how the wrapper is styled. The columns carrying
 * those popovers therefore spread this and then override `overflow` to
 * `visible`; the exception, which columns it covers, and what still contains
 * those cells are written out at `opensAPopover` in `wbs-table.tsx`.
 */
export const CELL: CSSProperties = {
  boxSizing: 'border-box',
  padding: '1px 4px',
  verticalAlign: 'top',
  overflow: 'hidden',
};

/**
 * What every header cell carries so the column headings survive scrolling a long
 * plan.
 *
 * On the cells rather than on `<thead>`: sticky on a row group is the newer of
 * the two — Chrome 91, Safari 15 — while sticky on `th` has worked for as long
 * as sticky has. The background is what makes it an opaque strip rather than a
 * heading with rows sliding through it.
 */
export const STICKY_HEADER_CELL: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: HEADER_LAYER,
  background: HEADER_BACKGROUND,
};

/**
 * What one cell carries because its column is pinned, or nothing when it is not.
 *
 * The background is not decoration. A sticky cell keeps its place while the rest
 * of its row scrolls behind it, and a transparent one shows that row straight
 * through itself — two sets of numbers on top of each other and no way to tell
 * which is which. `box-sizing` is the same kind of load-bearing: the declared
 * width has to include the cell's own padding, or every column is a couple of
 * pixels wider than the offset computed from it and the pinned edge drifts.
 */
export function pinnedCellStyle(
  columnId: string,
  part: 'header' | 'body',
): CSSProperties | undefined {
  const pinned = pinnedGeometry(columnId);
  if (pinned === undefined) return undefined;
  return {
    position: 'sticky',
    left: pinned.left,
    // Only where there is one to declare. A flexible column's width is the
    // `<colgroup>`'s to decide and a fixed `width` here would be a second
    // opinion about it — the two-width-systems bug, one column along.
    ...(pinned.width === undefined ? {} : { width: pinned.width }),
    boxSizing: 'border-box',
    background: part === 'header' ? HEADER_BACKGROUND : ROW_BACKGROUND,
    zIndex: part === 'header' ? PINNED_HEADER_LAYER : PINNED_BODY_LAYER,
  };
}

/**
 * What one cell carries because its column is flexible, or nothing when it is
 * not.
 *
 * The floor, on the cell as well as in {@link tableMinWidth}. The table's own
 * `min-width` is what really holds it — under `table-layout: fixed` a cell does
 * not get a vote on its column's width — and this is the belt that says so
 * where a reader of the markup is looking, and that keeps the cell honest if
 * the table is ever laid out any other way.
 */
export function flexibleCellStyle(columnId: string): CSSProperties | undefined {
  return FLEXIBLE_COLUMNS.has(columnId) ? { minWidth: FLEXIBLE_FLOOR } : undefined;
}

/**
 * The frame the table scrolls inside, so the page never scrolls sideways.
 *
 * `overflow` on both axes rather than `overflow-x` alone, because there is no
 * such thing as one axis here: `overflow-x: auto` forces the other axis to
 * compute to `auto` as well, and this element becomes the scroll container
 * either way. That is also why the height is bounded. A sticky heading sticks to
 * the scrollport that actually scrolls, and a frame as tall as its own table
 * never scrolls vertically — the whole frame would ride up the page with the
 * header inside it, which is the failure this exists to remove.
 *
 * `16rem` is the chrome above the table on the project page: the page padding,
 * the heading, the signed-in line, the project picker and this table's own
 * toolbar. Approximate on purpose and safe in both directions — too generous
 * only means the page scrolls a little as well, too mean only means blank space
 * under the frame. A short window falls back to `minHeight`, and then the page
 * scrolls; the exact remaining height would need a full-height flex layout from
 * `main` down, which is a bigger change than this one.
 *
 * The bottom padding is room for the pickers to open into. They are absolutely
 * positioned inside their cells at `top: 100%` and up to 200px tall, and a
 * scroll container clips to its padding box — without the padding a picker on
 * the last row would need the frame scrolled before it could be read. The notes
 * preview is taller than this (320px) and still can.
 */
export const TABLE_FRAME: CSSProperties = {
  overflow: 'auto',
  maxHeight: 'calc(100vh - 16rem)',
  minHeight: '20rem',
  paddingBottom: '13rem',
};
