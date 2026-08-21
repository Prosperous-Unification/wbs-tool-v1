import type { CSSProperties } from 'react';

import { POINTS } from './estimate-draft';

/**
 * Every fact about the plan a column's width is allowed to depend on, in one
 * object.
 *
 * One object rather than a widening argument list, and that is the whole of
 * why it exists: {@link frameLayout} has five consumers, and a second
 * parameter is a second thing each of them has to remember to pass. The second
 * fact arrived on 2026-08-09 as a field — `columnWidthOverrides` — and every
 * consumer that already built this object carried it without being edited.
 *
 * The first question is deliberately about the **project** rather than about
 * the rows on screen: a column that narrowed because the one row with a day on
 * it was collapsed away would change width under a reader who was only
 * scrolling.
 */
export interface FrameLayoutState {
  /** Whether any row in the project sets an earliest start. */
  hasAnyNotBefore: boolean;
  /**
   * The widths this browser was told by a drag, by the column's **own** id —
   * `<roleId>-final` for a folded phase — or absent where nothing has been
   * dragged.
   *
   * A fact about the reader rather than about the plan, which is why it is
   * here rather than a second parameter: every consumer of {@link frameLayout}
   * already carries this object, so a resized column reaches the `<col>`, the
   * table minimum, the folded minimum and the pinned offsets together or not
   * at all.
   *
   * Read by {@link widthFor}, by {@link frameLayout}'s flexible arm and by
   * {@link flexibleCellStyle} — the two places a flexible column's override
   * lives that the width table cannot answer for — and by nothing else. It is
   * **not** clamped on the way through: a width outside the range a drag can
   * produce is refused where it is read out of storage
   * (`rememberedWidthOverrides` in `wbs-table.tsx`), and clamping here as well
   * would make that refusal a check that cannot fail.
   */
  columnWidthOverrides?: Map<string, number>;
}

/**
 * One column of a resolved frame, with the width it resolves to and the width
 * its `<col>` declares — two readings of one resolution, not two systems.
 *
 * They differ for exactly one column in one state: a {@link FLEXIBLE_COLUMNS}
 * member carrying an override. Its `width` is the override — what the table
 * minimum counts — while its `colWidth` stays `undefined`, and the dragged
 * width reaches the browser as the table's **own** width instead
 * ({@link tableWidthStyle}): with every other column sized and the table
 * exactly as wide as their sum plus the override, fixed layout hands the
 * flexible column exactly the override and the viewport keeps the slack.
 * Expressing the override on the Name cells against a `width: 100%` table was
 * the design tried first, and Chromium refused it: it took the cell's width
 * and then distributed the viewport's excess across **every** sized column,
 * moving Number off its measured 93px envelope (`Expected: 93 / Received:
 * 103.484375`, CI `pixels` run 31430669282, 2026-08-10) — so that branch is
 * deleted, not kept as config. `e2e/layout.spec.ts` measures the consequence
 * in a browser either way.
 */
export interface ResolvedColumn {
  id: string;
  /**
   * px the layout resolved — the override for a dragged flexible column — or
   * `undefined` for a flexible member nobody has dragged.
   */
  width: number | undefined;
  /**
   * px the `<col>` declares, or `undefined` where the `<colgroup>` must stay
   * silent: every {@link FLEXIBLE_COLUMNS} member, dragged or not.
   */
  colWidth: number | undefined;
}

/**
 * Where one pinned column sits, and how wide it is held — or `undefined` where
 * the `<colgroup>` decides that.
 */
export interface PinnedGeometry {
  left: number;
  width: number | undefined;
}

/**
 * Every width one render of the table declares, resolved together.
 *
 * The object that replaced five consumers each doing their own arithmetic: the
 * `<colgroup>`, the table's own `min-width`, the folded minimum the Phases
 * dialog quotes, the offsets the pinned columns are held at, and the browser
 * gate's equation. A width that changes changes all five, because there is
 * only one of them.
 */
export interface FrameLayout {
  /** The leaf columns handed in, in that order, each with the width it declares. */
  columns: readonly ResolvedColumn[];
  /** The narrowest the whole table may be laid out, in px. */
  minWidth: number;
  /**
   * The widest the whole table lays itself out at unasked, in px — every fixed
   * column at its declared width and the flexible one at {@link FLEXIBLE_CAP}.
   *
   * The same sum as {@link minWidth} with the other end of the flexible
   * column's range in it, and computed from the same resolved columns for the
   * reason this interface exists: a cap summed from one list while the
   * `<colgroup>` declared another is the two-width-systems fault one column
   * along. With a drag in force the two are equal — the override is the
   * column's width at both ends.
   */
  maxWidth: number;
  /** The {@link PINNED_COLUMN_IDS} that are on screen in this state, and where they are held. */
  pinned: ReadonlyMap<string, PinnedGeometry>;
}

/**
 * The widest day the Start and End columns undertake to show whole, as the
 * string a browser measures.
 *
 * Unlike {@link NUMBER_ENVELOPE} this one really is a maximum rather than an
 * undertaking, and it is written out so it can be **checked** against the
 * formatter rather than trusted: `shortIsoDate` prints a day, an abbreviated
 * month from a fixed twelve-name table, and the year whenever that year is not
 * the reader's own, so the set of strings these columns can hold is finite and
 * `e2e/layout.spec.ts`'s `is as wide as the widest day the formatter can
 * print` measures every one of them and asserts this is the widest.
 *
 * The trailing marker is End's, not a decoration: an unestimated row's End
 * carries it after the day, and a marker that wraps makes its row two lines
 * tall exactly as a wrapped date does. Start is laid out at the same width —
 * the two ends of one span are read against each other, and the wider of the
 * two decides the pair.
 *
 * `20 May` rather than any other day because the browser said so: the twelve
 * month names and every real day of a year were measured in a Start cell, and
 * this came back joint widest. **Joint**, and the test says so rather than
 * pinning this exact string: several days measure identically in this font —
 * `10 May 2027 ?` is the same width to the pixel — so what is asserted is that
 * no day the formatter prints is wider than this one.
 */
export const DAY_ENVELOPE = '20 May 2027 ?';

/**
 * How wide the Start and End columns are laid out, in px.
 *
 * What Chromium measures {@link DAY_ENVELOPE} to need in a Start cell, 105.86,
 * plus the 8px of padding the declared width includes — rounded up, because a
 * column half a pixel short of its own envelope wraps.
 *
 * It was 52 until `column-rebalance`, and 52 was measured against a workday
 * offset rather than against a date: Dany's screenshot of 2026-08-09 has
 * `29 Sep` on two lines and `29 Sep 2027` on three. The `title` still carries
 * the full `YYYY-MM-DD`, so the shortening costs nothing and the widening buys
 * a row that is one line tall.
 *
 * **114 → 98 in `capacity-ui`**, and it is the re-measurement
 * `spreadsheet-geometry` left open rather than a preference: 114 was picked in
 * a 16px grid, that change took the body type to 13px, and the same envelope
 * was then measured at 94.02px in Chromium on h2puni (86.02 of text and 8 of
 * chrome) — recorded in `e2e/layout.spec.ts` beside the assertion, with the
 * columns deliberately left over-wide because narrowing them was that change's
 * non-goal. This change is what needs the room: the In-parallel column is 32px
 * and the folded table has none to spare at 1280, so the 32 comes out of the
 * 40px of measured slack across these two rather than out of a column that has
 * none. `is as wide as the widest day the formatter can print` is the browser
 * that judges it, and it clears the envelope by 3.98px.
 */
const DATE_COLUMN_WIDTH = 98;

/**
 * Every column whose width is the same on every plan, by fixed id, in px.
 *
 * The constants half of the width table. The other half is
 * {@link PLAN_WIDTHS}, and the two are read together by {@link widthFor}; the
 * split is what this change is for — until 2026-08-09 there was no second half
 * and a width could not depend on the plan at all.
 *
 * These numbers are the compaction Dany asked for on 2026-08-08 ("compact
 * every column as far as it will go"), and every one of them is a figure the
 * browser gate measures rather than a preference: the table has to fit a
 * 1280px laptop with two roles folded. `name` is deliberately absent — see
 * {@link FLEXIBLE_COLUMNS}.
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
  // {@link NUMBER_ENVELOPE} says what this number is sized to hold, and
  // `e2e/layout.spec.ts`'s `the Number column fits its envelope` is the
  // browser that picked it. It is not a guess at the longest number — there is
  // no longest number.
  //
  // 169 → 93 in `column-rebalance`, because the envelope itself shrank: it was
  // eleven characters at the deepest indent, which is a row almost no plan
  // has, and it is two levels of number at a two-level row's indent now.
  // Chromium measures 92.5625px of that — 12px of indent, a 12.5px expander, a
  // 20px lock, five characters of number and the cell's 8px of padding.
  //
  // **93 → 105 in `number-column-widen`.** The envelope's *contract* did not
  // move — still `NUMBER_ENVELOPE_LEVELS`' two levels — but `table-width-budget`
  // (#62) found what the contract's own slack was hiding: read character by
  // character, `010.1.1.1.1` and `010.1.1.1.1.1` both draw `010.1.1.1.`, so a
  // row and its own child read as the same number at depth 5. One
  // `INDENT_STEP` (12px) buys the column back to depth 6/7 — Dany's call,
  // 2026-08-16, the reversible one of the two design.md D4 offered: eliding
  // from the head holds at every depth but changes how every clipped number
  // in the product reads, so it stays available as a later change rather than
  // being smuggled into this one. Affordable: two folded phases at 1280 go
  // 1219 → 1231 against a 1248px frame, 12 of the 29px of measured slack.
  ['number', 105],
  ['depends', 110],
  // A priority, and priorities are short: 48px holds four digits and the 8px of padding
  // the declared width includes, which is a scale running past a thousand. The
  // header is `Prio` for the same reason `Not bef.` is abbreviated — a
  // 10px all-caps `PRIORITY` wraps to two lines in this column and makes the
  // whole header row two lines tall.
  ['priority', 48],
  ['team', 120],
  // The tag cell. 120 like the team's, because it holds the same kind of thing
  // — a name somebody typed, or several — and a narrower one would clip
  // `regulatory` on the plans most likely to use it.
  //
  // **It is deliberately NOT in {@link FIXED_COLUMNS}, and that is this
  // change's answer to the width budget.** The folded table has 29px of slack
  // at 1280 (`layout.spec.ts`, measured 2026-08-14) and this column costs 120,
  // so a column on screen in every state would blow the budget by 91px and put
  // a scrollbar under every two-phase plan on a 1280 laptop.
  //
  // What it is exempted **for**, named as the rule requires: this column is
  // rendered only where the deployment has a tag vocabulary at all — one or
  // more rows in `tag`. A deployment that has never made a tag has the table it
  // had yesterday, to the pixel, and `foldedTableMinWidth` answers the same
  // number it did before this change. A deployment that has made one has opted
  // into the dimension, and its readers can see what the extra width bought.
  //
  // That is also why tags are created on the directory page and not in this
  // cell (the proposal's own non-goal): the first tag cannot be made in a
  // column that does not exist until the first tag is made.
  ['tag', 120],
  // The service cell, 120 like the tag's and the team's, and **exempted from
  // {@link FIXED_COLUMNS} on exactly the tag column's terms** — read its entry
  // above for the measurement, because this column does not repeat it, it
  // spends it a second time.
  //
  // What this one is exempted **for**, named as the rule requires: it is
  // rendered only where the directory has a service at all. A deployment that
  // has never made one has the table it had before `service-split`, to the
  // pixel, and `foldedTableMinWidth` answers the number it answered then —
  // asserted in `table-frame.test.ts`, not assumed.
  //
  // The cost is stated rather than hidden: a deployment carrying **both** tags
  // and services is 240px past the folded floor, not 120. Two exemptions is
  // the most this budget can hold, and a fourth dimension would have to take a
  // column away rather than add one.
  ['service', 120],
  // People at once, and this is the tightest column in the table: `∥` for a
  // heading and three digits of value, right-aligned. 32px is 24px of glyph
  // room plus the 8px of padding the declared width includes — enough for
  // `999` at the grid's 13px type. The ceiling is 1000, and a four-digit
  // parallelism is a number nobody plans with: it renders clipped and its
  // `title` says it whole, which is the same bargain the Number column makes
  // with a deep row.
  //
  // It is 32 and not the 48 the plan drew because the table has 1280px to fit
  // with two roles folded and C0 measured a 48px column overflowing it by
  // 19px. See `openspec/changes/capacity-ui/design.md`.
  ['in-parallel', 32],
  ['final-total', 52],
  // Both date columns at one width; see {@link DAY_ENVELOPE} for what that
  // width holds and which browser picked it.
  ['start', DATE_COLUMN_WIDTH],
  ['finish', DATE_COLUMN_WIDTH],
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
 * The earliest-start column's width where at least one row in the project sets
 * a day, in px.
 *
 * A short date and nothing else — `1 Jun`, or `1 Jun 2027` off the current
 * year. It was 146 until 2026-08-09 because it held a native date input at
 * rest on every row, and an unconstrained `input[type=date]` asks Chromium for
 * 138px. The editor is mounted for the cell being edited now, and it escapes
 * the cell rather than sizing it — see {@link DATE_EDITOR_WIDTH}.
 */
const NOT_BEFORE_WITH_DAYS = 84;

/**
 * The earliest-start column's width where no row in the project sets a day, in
 * px — an em-dash on every row, and a heading that abbreviates.
 */
const NOT_BEFORE_EMPTY = 56;

/**
 * How wide the date editor is laid out while it is open, in px.
 *
 * The one number in this file the repository does not get to choose: it is
 * what Chromium lays an unconstrained `input[type=date]` out at in the table's
 * font — the separators, the spinner and the picker icon — measured rather
 * than argued with. `e2e/layout.spec.ts`'s `the editor is never narrower than
 * this browser's own unconstrained field` is the assertion it moves with.
 *
 * Wider than the column it opens in, deliberately. A column that grew while
 * somebody was typing would move every cell under them, so the editor leaves
 * the cell instead — through the same clip exemption the dependency listbox and
 * the notes preview use (`opensAPopover` in `wbs-table.tsx`).
 */
export const DATE_EDITOR_WIDTH = 138;

/**
 * Every column whose width is a fact about the plan, by fixed id.
 *
 * A function of {@link FrameLayoutState} rather than a number, so what a width
 * may depend on is stated in one place and read in one place. The
 * earliest-start column is the only one of them; the reader's own overrides are
 * the other half of the same state, and they outrank whatever this resolves —
 * see {@link widthFor}.
 */
const PLAN_WIDTHS = new Map<string, (state: FrameLayoutState) => number>([
  ['not-before', (state) => (state.hasAnyNotBefore ? NOT_BEFORE_WITH_DAYS : NOT_BEFORE_EMPTY)],
]);

/**
 * Every fixed column this table renders, whatever the plan — the two halves of
 * the width table together.
 *
 * Enumerated from the maps rather than written out a second time: the folded
 * minimum the Phases dialog quotes is "every fixed column, plus Name, plus one
 * folded column per phase", and a column added to either map but missing here
 * would be a number describing a narrower table than the one on screen.
 */
/**
 * The columns that are on screen **in every state of the table**, which is what
 * the folded budget is measured over.
 *
 * `tag` and `service` are excluded and they are the only exclusions: see their
 * entries in {@link COLUMN_WIDTHS} for what each exemption buys and what it
 * costs. Both still have a declared width there, because a column that is
 * sometimes on screen still has to lay out when it is — what it must not do is
 * be counted in the floor of a table that is not showing it.
 */
export const CONDITIONAL_COLUMNS: readonly string[] = ['tag', 'service'];

export const FIXED_COLUMNS: readonly string[] = [
  ...COLUMN_WIDTHS.keys(),
  ...PLAN_WIDTHS.keys(),
].filter((id) => !CONDITIONAL_COLUMNS.includes(id));

/**
 * The columns with no declared width, which take what the fixed ones leave.
 *
 * A table that fits the window is a table with one column that is not a
 * number: everything else is a figure, a date or a control of a known size,
 * and the name is the sentence that should have the rest. So the `<colgroup>`
 * emits no `<col width>` for these — a dragged one included, whose width rides
 * on its cells instead (see {@link ResolvedColumn.colWidth}) — and
 * `table-layout: fixed` hands the remainder to them.
 *
 * A set, not a sentinel width. {@link widthFor} keeps throwing on a flexible
 * column with no override, because a flexible column and an unsized one look
 * identical to a caller that gets a plausible number back — and the caller
 * that must not get one is the pinned-offset arithmetic. Membership here is
 * the question to ask instead.
 */
export const FLEXIBLE_COLUMNS: ReadonlySet<string> = new Set(['name']);

/**
 * The narrowest a flexible column is allowed to become, in px.
 *
 * It is what {@link frameLayout} budgets for the Name column, and it is on the
 * cell as well: below this the table stops shrinking and the frame scrolls
 * instead, with the pinned columns holding the left edge. 200px is about
 * twenty-five characters of the page's font — a phrase rather than a word.
 */
export const FLEXIBLE_FLOOR = 200;

/**
 * The widest a flexible column is budgeted at before the table stops growing,
 * in px — the other end of {@link FLEXIBLE_FLOOR}.
 *
 * Dany's ask on 2026-08-08 was "the Name column half as wide". Half of what it
 * had at 1512 is about 420px, and 420 is also about fifty characters of the
 * grid's own type — a sentence, where the floor is a phrase. Past it a wider
 * window buys the reader nothing: names are short, and the extra was spent on
 * a column of white space that pushed the dates further from the names they
 * belong to.
 *
 * **A cap on the flexible column is a cap on the table**, which is why it is
 * spent here rather than as a `max-width` on the Name cells.
 * `table-layout: fixed` gives a cell no vote on its column's width — the same
 * reason {@link flexibleCellStyle} declares a floor and never a width — so the
 * only place this can be honoured is the `<table>`'s own width, through
 * {@link FrameLayout.maxWidth} and {@link tableWidthStyle}. A cell `max-width`
 * would have been the second width authority `column-widths-drag` exists to
 * prevent.
 *
 * A **drag outranks it**: an override is a reader saying what they want this
 * column to be, and {@link WIDEST_COLUMN} is that answer's own ceiling. The
 * cap is what an *unasked* table settles at.
 */
export const FLEXIBLE_CAP = 420;

/**
 * The widths of a role's columns, which have no fixed ids: a role is created at
 * runtime and its columns are named `<roleId>-final`, `<roleId>-<point>` and
 * `<roleId>-assignee`. Sized by suffix, because the role half of the id is
 * whatever the project called it.
 *
 * The folded column is the one that grew: it shows the figure *and* who is
 * doing the work (`4.8 · Kat`) since the assignee stopped folding away with
 * the trio. The three point boxes hold a number of days and are sized for one.
 *
 * 52 → 44 for the point boxes in `spreadsheet-geometry`, and the heading is
 * what paid for it: `optimistic` wants 84px and read `optimi` in a 52px
 * column, so the width was never the word's — it was three boxes each holding
 * a number of days. At `o · r · p` the heading asks for nothing and 44px is
 * five characters of the grid's 13px type, which is a number of days with a
 * decimal in it. The word itself is still in the heading's `title` and in its
 * accessible name.
 */
const ROLE_FINAL_WIDTH = 96;
const ROLE_POINT_WIDTH = 44;
const ROLE_ASSIGNEE_WIDTH = 120;

/** An id the width table has never heard of — a typo, or a new column nobody sized. */
export class UnknownColumnError extends Error {
  constructor(columnId: string) {
    super(
      `No declared width for column "${columnId}". Every rendered column ` +
        `must be in COLUMN_WIDTHS or PLAN_WIDTHS or use a role suffix — an unlisted ` +
        `one would silently get a wrong width, which is the overlap bug all over again.`,
    );
    this.name = 'UnknownColumnError';
  }
}

/**
 * How wide the column with this id is laid out for this plan **before** the
 * reader has said otherwise, in px.
 *
 * The width table's own answer, which is what a {@link Layout reset} returns a
 * column to and what {@link floorFor} takes the narrower of. Everything that
 * lays the table out wants {@link widthFor} instead — this one cannot see an
 * override, which is exactly why the reset can be "the width resolved now"
 * rather than a snapshot.
 *
 * @throws {UnknownColumnError} when nothing declares a width for that id, a
 * {@link FLEXIBLE_COLUMNS} member included. See {@link widthFor}.
 */
export function defaultWidthFor(columnId: string, state: FrameLayoutState): number {
  const declared = COLUMN_WIDTHS.get(columnId);
  if (declared !== undefined) return declared;
  const fromPlan = PLAN_WIDTHS.get(columnId);
  if (fromPlan !== undefined) return fromPlan(state);
  if (columnId.includes('-')) {
    if (columnId.endsWith('-final')) return ROLE_FINAL_WIDTH;
    if (columnId.endsWith('-assignee')) return ROLE_ASSIGNEE_WIDTH;
    const point = columnId.slice(columnId.lastIndexOf('-') + 1);
    if ((POINTS as readonly string[]).includes(point)) return ROLE_POINT_WIDTH;
  }
  throw new UnknownColumnError(columnId);
}

/**
 * How wide the column with this id is laid out for this plan and this reader,
 * in px — the override where there is one, and the width table's own answer
 * where there is not.
 *
 * A {@link FLEXIBLE_COLUMNS} member resolves its override **before** the width
 * table is consulted — the table has no row for it by design — and with no
 * override this still throws for it exactly as for a typo. That is the point:
 * a sentinel would let the pinned-offset arithmetic add a number the browser
 * never uses. Until `name-column-drag` an override naming the flexible column
 * threw too; the delta spec records the supersession.
 *
 * For every other column the default is resolved **first**, so an override
 * naming a column nothing sizes throws rather than sizing it.
 *
 * The override is taken as it stands rather than clamped; see
 * {@link FrameLayoutState.columnWidthOverrides} for why that matters.
 *
 * Prefer {@link frameLayout}: this answers about one column, and every consumer
 * in the app needs the whole frame resolved together.
 *
 * @throws {UnknownColumnError} when nothing declares a width for that id.
 * Unknown is not OK here: a column that fell through to a default would be laid
 * out at one width while the pinned offsets were summed from another, and the
 * two disagreeing is exactly the overlap this module exists to make impossible.
 */
export function widthFor(columnId: string, state: FrameLayoutState): number {
  const override = state.columnWidthOverrides?.get(columnId);
  // Proof: this arm deleted so a dragged flexible column fell through to the
  // width table, `resolves a dragged width for the flexible column, and a
  // floor of its own` failed on `UnknownColumnError: No declared width for
  // column "name"` with the override in force. Watched, 2026-08-10.
  if (FLEXIBLE_COLUMNS.has(columnId) && override !== undefined) return override;
  const resolved = defaultWidthFor(columnId, state);
  return override ?? resolved;
}

/**
 * The widest any column may be laid out, in px, whether it got there by a drag
 * or out of storage.
 *
 * **One constant read by both**, and that is the whole of why it is exported:
 * a drag that could produce a width the stored-width check would refuse is a
 * column that silently returns to its default on the next reload, and the two
 * numbers would have to be kept in step by hand forever.
 *
 * 600 is three times {@link FLEXIBLE_FLOOR} and most of a 900px window. It
 * bounds a gesture that got away — a pointer that kept going after the reader
 * stopped looking — without bounding a real preference: the widest column the
 * table declares today is Team's 120px, so a reader who wants five times that
 * still has it.
 */
export const WIDEST_COLUMN = 600;

/**
 * The narrowest any column may be dragged, in px, before its own default is
 * taken into account.
 *
 * A cell that can still be aimed at with a pointer. Columns whose default is
 * already narrower than this — the drag handle's 24px — stop at their default
 * instead; see {@link floorFor}.
 */
const NARROWEST_COLUMN = 36;

/**
 * The narrowest this column may be dragged, in px.
 *
 * The narrower of {@link NARROWEST_COLUMN} and the column's own resolved
 * default, because a floor above a column's default would make the first touch
 * of its handle widen it. Read from the **default** rather than from the width
 * in force: a floor that moved with the override would let a column be walked
 * down one drag at a time.
 *
 * A {@link FLEXIBLE_COLUMNS} member takes an explicit arm answering
 * {@link FLEXIBLE_FLOOR} — the same constant {@link flexibleCellStyle} puts on
 * the cell and {@link frameLayout} budgets in the minimum, because the floors
 * disagreeing is the two-width-systems fault this module exists to prevent.
 * Deliberately not the `min(default, NARROWEST_COLUMN)` path, which would
 * resolve 36 for a column whose cell declares it may never shrink past 200.
 * This arm was the recorded injected fault of `column-widths-drag`'s negative
 * "refuses the flexible column a width and a floor alike"; `name-column-drag`
 * retires that negative by name and adopts the arm as the behaviour.
 *
 * @throws {UnknownColumnError} through {@link defaultWidthFor}, for a typo —
 * an id nothing sizes still has no width to have a floor under.
 */
export function floorFor(columnId: string, state: FrameLayoutState): number {
  // Proof: this arm deleted, `resolves a dragged width for the flexible
  // column, and a floor of its own` and `has a floor that does not move with
  // the plan…` (table-frame.test.ts) both failed on `UnknownColumnError: No
  // declared width for column "name"` out of the floor lookup — and with it
  // gone, every stored `name` width would be refused at mount and every Name
  // drag would throw out of the clamp. Watched, 2026-08-10.
  if (FLEXIBLE_COLUMNS.has(columnId)) return FLEXIBLE_FLOOR;
  return Math.min(defaultWidthFor(columnId, state), NARROWEST_COLUMN);
}

/**
 * `width` brought inside the range this column may be laid out at, in px.
 *
 * What a drag writes, and the shape the stored-width check accepts: the check
 * reads {@link floorFor} and {@link WIDEST_COLUMN} rather than repeating the
 * arithmetic, so no drag can produce a width a reload would reject. The
 * flexible column clamps like any other, to its own
 * [{@link FLEXIBLE_FLOOR}, {@link WIDEST_COLUMN}].
 *
 * @throws {UnknownColumnError} through {@link floorFor}, for an id nothing
 * sizes.
 */
export function clampColumnWidth(columnId: string, width: number, state: FrameLayoutState): number {
  return Math.min(Math.max(width, floorFor(columnId, state)), WIDEST_COLUMN);
}

/**
 * Whether this id names a column the frame layout can put a width on at all.
 *
 * The question a width read out of storage is asked first: an id nothing sizes
 * would throw out of the render that laid it out, and a preference about a
 * column that does not exist must not be able to take the table down.
 *
 * A role's column for a phase the project no longer holds answers `true` and
 * is then never looked at — the harmlessness a remembered expansion's deleted
 * row ids already have. A {@link FLEXIBLE_COLUMNS} member answers `true` since
 * `name-column-drag`: a dragged Name is stored like any other column, and the
 * range check beside this filter judges its entry against Name's own bounds.
 */
export function sizableColumn(columnId: string, state: FrameLayoutState): boolean {
  // Proof: this arm deleted, `says which ids can be sized at all…` failed on
  // `expected false to be true` — and on the storage production path, `lays a
  // remembered Name width on the table itself, and leaves its <col> silent`
  // (wbs-table.test.tsx) failed on `expected '200px' to be '300px'`: the
  // stored entry silently dropped by the filter that reads this, the table
  // opening as if nothing had been dragged. Both watched, 2026-08-10.
  if (FLEXIBLE_COLUMNS.has(columnId)) return true;
  try {
    defaultWidthFor(columnId, state);
    return true;
  } catch (error) {
    // The one modeled condition this function exists to answer about, caught
    // to answer it and nothing else: anything else thrown out of the width
    // table is a fault and goes on up.
    if (error instanceof UnknownColumnError) return false;
    throw error;
  }
}

/**
 * The columns held at the left edge while the table is scrolled sideways, in
 * order from that edge.
 *
 * Contiguity from the edge is not a preference: `position: sticky; left` pins a
 * cell at a fixed offset, so a pinned column with an unpinned one in front of it
 * would hang over whatever scrolled through the gap. That is why "Depends on"
 * sits to the right of Name rather than between it and Number —
 * `openspec/changes/sticky-table-frame/proposal.md` has the reversal written
 * down.
 *
 * Ids and no widths since 2026-08-09: a width is a fact about the plan being
 * drawn, so the offsets are resolved per render by {@link frameLayout} from the
 * same numbers that render's `<colgroup>` declares. Two lists of widths is one
 * list too many, and a list frozen at module load is worse — it cannot see the
 * plan at all.
 *
 * Name being last is load-bearing: it is flexible, so no offset is ever a sum
 * that includes it. {@link frameLayout} throws rather than assumes that.
 */
export const PINNED_COLUMN_IDS: readonly string[] = ['drag', 'number', 'name'];

/**
 * Every width one render declares, resolved from the columns on screen and the
 * plan being drawn.
 *
 * One call per render, read by the `<colgroup>`, the table's `min-width`, the
 * pinned cells and the Phases dialog alike. Before this existed the same
 * arithmetic lived in five places and the pinned offsets were prefix sums
 * computed **once when the module loaded** — which is why no width could depend
 * on the plan, and why `not-before` could not be two widths.
 *
 * `leafIds` is the columns being laid out, in the order they are laid out.
 * `state` is every fact a width may depend on; see {@link FrameLayoutState}.
 *
 * @throws {UnknownColumnError} for a leaf id nothing sizes. A column that fell
 * through to a default would be laid out at one width while the offsets in
 * front of it were summed from another.
 * @throws {Error} when a pinned column sits behind a flexible one. A sticky
 * offset is the sum of the widths in front of it and a flexible column has none
 * to add, so the sum would be right at exactly one window size.
 */
export function frameLayout(leafIds: readonly string[], state: FrameLayoutState): FrameLayout {
  const columns: ResolvedColumn[] = leafIds.map((id) => {
    if (!FLEXIBLE_COLUMNS.has(id)) {
      const width = widthFor(id, state);
      return { id, width, colWidth: width };
    }
    // A flexible column resolves its override where one is in force, and its
    // `<col>` stays silent either way — see {@link ResolvedColumn.colWidth}
    // for the excess-width design that hangs on that difference.
    const override = state.columnWidthOverrides?.get(id);
    // Proof: `colWidth` handed the override, `lays out, adds up, folds and
    // pins a dragged Name from the one number it resolved` failed on
    // `expected 300 to be undefined` — a sized `<col name>` — and `still
    // refuses a column pinned behind the flexible one, override or not`
    // failed on `expected [Function] to throw an error` beside it, the
    // refusal blinded by the same number. Watched, 2026-08-10. The browser
    // consequence — excess distributed across every column, Number off its
    // 93px envelope — is `e2e/layout.spec.ts`'s to watch.
    return { id, width: override, colWidth: undefined };
  });
  return {
    columns,
    // The flexible floor is budgeted only while nothing overrides it: a
    // dragged Name enters the minimum at its dragged width, which is how the
    // frame starts scrolling at the width the reader actually asked for.
    // Proof: the flexible arm made to count `FLEXIBLE_FLOOR` regardless of the
    // override, `lays out, adds up, folds and pins a dragged Name from the one
    // number it resolved` failed on `expected 1007 to be 1107` — the folded
    // minimum a hundred pixels short of the table on screen. Watched,
    // 2026-08-10.
    minWidth: columns.reduce((total, column) => total + (column.width ?? FLEXIBLE_FLOOR), 0),
    // The same sum with the flexible column at the other end of its range, and
    // a dragged one at the width it was dragged to: an override is a reader's
    // own answer and outranks the cap, exactly as it outranks the floor above.
    //
    // Proof: `FLEXIBLE_CAP` swapped for `FLEXIBLE_FLOOR` here, `caps the
    // table at the fixed columns plus the Name cap` failed on `expected 200 to
    // be 420`. Watched on h2puni, 2026-08-12 (fault F1).
    maxWidth: columns.reduce((total, column) => total + (column.width ?? FLEXIBLE_CAP), 0),
    pinned: pinnedGeometryFor(columns, PINNED_COLUMN_IDS),
  };
}

/**
 * Where each of `pinnedIds` is held, given the widths one resolution declared.
 *
 * Exported for one reason, stated so it is not mistaken for an API: the order
 * of the pinned columns is a module constant, so the refusal below could
 * otherwise never be watched failing — there is no way to declare a fourth
 * pinned column from a test. {@link frameLayout} calls exactly this, with
 * {@link PINNED_COLUMN_IDS}; nothing in the app calls it directly.
 *
 * @throws {Error} when a pinned column sits behind a flexible one.
 */
export function pinnedGeometryFor(
  columns: readonly ResolvedColumn[],
  pinnedIds: readonly string[],
): ReadonlyMap<string, PinnedGeometry> {
  const pinned = new Map<string, PinnedGeometry>();
  let left = 0;
  /** The flexible pinned column already passed, which is what lets the refusal name both of them. */
  let flexibleBefore: string | null = null;
  for (const id of pinnedIds) {
    const resolved = columns.find((column) => column.id === id);
    // A pinned column this call is not laying out is simply not pinned in it.
    // Nothing in the app takes one away; `foldedTableMinWidth` resolves the
    // fixed set in its own order and the tests resolve partial lists, and a
    // throw here would make asking about either impossible.
    if (resolved === undefined) continue;
    if (flexibleBefore !== null) {
      // Unknown is not OK, and this is the shape of the unknown: a flexible
      // column's `<col>` is unsized so it absorbs whatever the frame leaves
      // over — above the table minimum it is laid out wider than any override
      // says — and every column pinned after one would be held at an offset
      // that is right at exactly one window size. Name is last today; this is
      // what stops a fourth pinned column being added behind it in silence.
      //
      // Proof: this branch deleted, `refuses a column pinned behind a flexible
      // one` failed on `expected [Function] to throw an error` — `depends`
      // declared as a fourth pinned column resolved to `{ left: 193, width:
      // 110 }`, a plausible offset with Name's missing width counted as
      // nothing. Watched, 2026-08-09.
      throw new Error(
        `${flexibleBefore} has no <col> width for an offset to sum, so ${id} cannot be pinned after it — ` +
          `a sticky offset is a sum of the widths in front of it and a flexible column absorbs the frame's excess.`,
      );
    }
    // The `<col>`'s width, not the resolved one: what a pinned cell declares
    // must be exactly what the `<colgroup>` declares, and a dragged flexible
    // column deliberately declares nothing on either — its override reaches
    // the browser as the table's own width ({@link tableWidthStyle}). A cell
    // `width` for it was the first design, and Chromium answered it by
    // distributing the viewport's excess across every sized column; see
    // {@link ResolvedColumn.colWidth}.
    pinned.set(id, { left, width: resolved.colWidth });
    // Keyed on flexibility rather than on the width being missing: a dragged
    // flexible column has a width, and it is still not a number an offset may
    // be summed from.
    // Proof: keyed back on `resolved.width === undefined`, `still refuses a
    // column pinned behind the flexible one, override or not` failed on
    // `expected [Function] to throw an error` — `depends` pinned behind a
    // dragged Name at an offset summed from the override, which the browser
    // outgrows the moment the viewport has slack. Watched, 2026-08-10.
    if (resolved.colWidth === undefined) flexibleBefore = id;
    else left += resolved.colWidth;
  }
  return pinned;
}

/**
 * The narrowest the table can be laid out with these phases, all folded, in px
 * — the number the Phases dialog quotes before somebody adds another one.
 *
 * The phases' **real** ids, not a count. Every width resolves per column id, so
 * a figure summed from stand-in ids would answer about columns that do not
 * exist while the table lays out the ones that do: an override is stored under
 * the exact column id and a `phase0-final` could never carry one.
 *
 * Every column in {@link FIXED_COLUMNS} is on screen in every state of this
 * table — the drag handle, the number, Depends on, the team, the total, the
 * not-before date, Start, Finish, Slack and the ⋯ menu, none of them
 * conditional — so the folded floor is that set, plus Name's
 * {@link FLEXIBLE_FLOOR}, plus one folded column per phase.
 *
 * **`tag` is not among them**, by construction rather than by omission — see
 * {@link CONDITIONAL_COLUMNS}. A deployment with no tags lays out at exactly
 * the number this function answered before that column existed, which is what
 * makes the budget test's figures still true.
 *
 * Derived through {@link frameLayout} rather than as arithmetic of its own,
 * and that is the whole point of it living here rather than as a sentence in
 * the dialog: a column that changes width changes this number in the same
 * commit. `phases-dialog.test.tsx` pins the quoted figure against what a real
 * `WbsTable` render of the same phases declares as its `min-width`.
 *
 * @throws {UnknownColumnError} through {@link frameLayout}, for the same
 * reason it does.
 */
export function foldedTableMinWidth(roleIds: readonly string[], state: FrameLayoutState): number {
  return frameLayout(
    [
      ...FIXED_COLUMNS,
      ...FLEXIBLE_COLUMNS,
      // The folded column of each phase, named exactly as the table names it.
      ...roleIds.map((roleId) => `${roleId}-final`),
    ],
    state,
  ).minWidth;
}

/**
 * How many levels the Number column indents a row before it stops.
 *
 * **4 → 2 in `table-mechanics`, and the reason is the sentence
 * {@link NUMBER_ENVELOPE} already carried**: "a row at `DEEPEST_INDENT` spends
 * 48px of a 93px column on its indent and another 32 on its expander and lock,
 * so what is left is a few pixels of number and a `title`." The UI audit of
 * 2026-08-12 followed that to where it stops being a bargain and starts being
 * a bug: `050.1.1.1` and `050.1.1.1.1` both drew as `050.1`, so two different
 * rows were the same row to read, and the indent that was supposed to say
 * which was which is *capped* — both drew at the same 48px.
 *
 * Nothing is lost by stopping earlier, because the steps are not thrown away:
 * the Name cell carries `hierarchyIndentFor(depth) − numberIndentFor(depth)`,
 * so the outline a reader's eye adds up across the two cells is exactly what
 * it was at every depth. What changes is which cell draws it — and the column
 * whose whole job is a number gets 24px of its width back.
 *
 * Not zero. The first two levels are where the Number column is the leading
 * edge of the outline, and a flush column of numbers under a flush column of
 * names reads as a list rather than as a tree.
 */
export const DEEPEST_INDENT = 2;

const INDENT_STEP = 12;

/**
 * How much of the Number cell the disclosure caret owns, in px — reserved on
 * every row, including the ones that have no caret to put in it.
 *
 * Held open rather than collapsed, because the caret used to sit inline: a row
 * with children printed its number a caret's width right of a childless sibling
 * at the same depth, and a column of figures that does not line up is the one
 * thing a column of figures is for. `e2e/layout.spec.ts`'s `lines up the number
 * of a parent and a childless sibling` is the browser that says so.
 *
 * It costs the column nothing. The measured 92.5625px `{@link COLUMN_WIDTHS}`
 * started from (105px since `number-column-widen`) was measured with an
 * expander present — "12px of indent, a 12.5px expander, a 20px lock, five
 * characters of number and the cell's 8px of padding" — so this reserves what
 * the envelope was already sized around.
 */
export const CARET_GUTTER_PX = 12;

/**
 * The Number cell's indent for a row `depth` levels down, in px — capped, and
 * only the Number cell's.
 *
 * The cap is what keeps the pinned columns from overlapping. Number is held to a
 * declared width, and an indent that kept growing would push the number itself
 * past that width — where Name, pinned at the sum of the widths in front of it,
 * would paint straight over it once the table is scrolled sideways. Past
 * {@link DEEPEST_INDENT} levels a row stops moving right; the number printed in
 * the cell still says how deep it is.
 *
 * The step is 12px rather than 16, and since `column-rebalance` that matters
 * more rather than less: the column is sized to {@link NUMBER_ENVELOPE}'s two
 * levels, so at the envelope's own depth the number keeps the larger half of
 * the column and every level after that is spent on white space. A step of 16
 * would take 64px of a 105px column at the deepest indent and leave little of
 * the number at all. {@link DEEPEST_INDENT} is where that same argument was
 * finally taken to its conclusion — two levels of white space, not four.
 *
 * A row deeper than the cap is not stuck at it on every surface: the Name cell
 * carries `hierarchyIndentFor(depth) − numberIndentFor(depth)` on top of this,
 * so the outline keeps stepping right where the Number column has stopped.
 * {@link hierarchyIndentFor} is the uncapped half of that pair.
 */
export const numberIndentFor = (depth: number): number =>
  Math.min(depth, DEEPEST_INDENT) * INDENT_STEP;

/**
 * The full indent a row `depth` levels down stands at, in px — uncapped.
 *
 * The other half of the split this module's cap forced: {@link numberIndentFor}
 * guards the Number column's declared width and draws every level past
 * {@link DEEPEST_INDENT} identically, which left a depth-5 row invisible under
 * its depth-4 parent. Surfaces with no 93px column to protect take this one
 * whole — the Gantt panel's label rail — and the Name cell carries the
 * **difference** between the two (zero until the cap, one step per level past
 * it; Name is the flexible column, with no envelope to blow). The quantity a
 * reader's eye adds up across Number and Name is therefore this function, at
 * every depth. The mobile cards take neither raw: a 390px card caps at its own
 * {@link CARD_DEEPEST_INDENT}, through {@link cardIndentFor}.
 *
 * Proof: `numberIndentFor`'s `Math.min(depth, DEEPEST_INDENT)` cap put on this
 * function — `keeps the hierarchy indent growing past the Number cap, one step
 * per level to depth 6` failed on `expected +0 to be 12` (the depth-5 step),
 * with `hands the Name cell exactly the share the Number cell's cap withheld`
 * on the same figure and the card-cap case on `expected 60 to be 48`. Watched,
 * 2026-08-10.
 */
export const hierarchyIndentFor = (depth: number): number => depth * INDENT_STEP;

/**
 * Where the mobile cards stop indenting: two levels past the Number column's
 * {@link DEEPEST_INDENT}, because a 390px card cannot spend 72px-and-growing of
 * its width on margin. Stated here rather than discovered at a viewport.
 */
export const CARD_DEEPEST_INDENT = 6;

/**
 * The mobile card's indent for a row `depth` levels down, in px.
 *
 * The cards' own cap over {@link hierarchyIndentFor}'s step: deeper than the
 * Number column's, because a card has no pinned neighbour to overlap — but not
 * uncapped, because the margin comes out of a phone's 390px. Past
 * {@link CARD_DEEPEST_INDENT} a card stops moving right; its number still says
 * how deep it is.
 */
export const cardIndentFor = (depth: number): number =>
  Math.min(depth, CARD_DEEPEST_INDENT) * INDENT_STEP;

/**
 * The widest number the Number column undertakes to show whole, as the string a
 * browser measures.
 *
 * **There is no longest work item number**, which is why this is an envelope
 * rather than a maximum. be-01's `deriveNumbers` widens a sibling label with
 * the size of its group, adds a dotted segment for every level of depth, and
 * appends a digit each time a work item is inserted against a frozen anchor
 * that leaves no natural label free — and that last one has no bound at all. A
 * column sized to the longest number on the plan would move every row in the
 * table the moment one deep row was inserted.
 *
 * So the column undertakes {@link NUMBER_ENVELOPE_LEVELS} levels: a root
 * label's agreed three characters, plus one dotted single-character segment
 * for each level after the first. Drawn at the indent a row of that depth is
 * drawn at, beside the expander and the frozen-number lock, that is what
 * `e2e/layout.spec.ts`'s `the Number column fits its envelope` measures — and
 * `COLUMN_WIDTHS`'s figure is asserted against the measurement rather than read
 * off the markup.
 *
 * Anything longer is clipped with the whole number in the cell's `title`: the
 * same bargain the short dates make. The envelope was eleven characters at the
 * deepest indent until `column-rebalance`, and it sized the column for a row
 * almost no plan has.
 *
 * **What the column shows whole is not what it undertakes to.** This figure is
 * the *contract* — what the width is picked against, and what may not regress.
 * Since `table-mechanics` reclaimed the two capped indent steps and set the
 * number's own type, five levels of a leaf row fit inside the same 93px as
 * well; that is slack rather than a promise, because it depends on how many
 * digits a sibling group has taken and on whether the row carries an expander
 * and a lock. `e2e/layout.spec.ts`'s `two rows a level apart read as two
 * different numbers` is what holds the slack down, and it names the depth it
 * measures.
 */
/** How many dotted levels of number the column shows whole; see {@link NUMBER_ENVELOPE}. */
const NUMBER_ENVELOPE_LEVELS = 2;

export const NUMBER_ENVELOPE = `010${'.1'.repeat(NUMBER_ENVELOPE_LEVELS - 1)}`;

/**
 * The colour a sticky cell paints itself, as the slot rather than the shade.
 *
 * `--cell-bg` is set per row by `styles.css` — banded, hovered, a drop target —
 * and read here, which is the only way those states can reach a pinned cell at
 * all: this declaration is an *inline* style and an inline style outranks every
 * layer, so a `tr:hover` rule could never repaint one from the outside.
 *
 * The fallback is load-bearing rather than tidy. An undefined custom property
 * makes `background` invalid at computed-value time, and an invalid background
 * is `transparent` — which is the row scrolling straight through the pinned
 * block again, silently. Naming the opaque default here means deleting the
 * stylesheet's grid layer costs the banding and nothing else.
 */
const HEADER_BACKGROUND = 'var(--cell-bg, var(--muted))';
const ROW_BACKGROUND = 'var(--cell-bg, var(--background))';

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
 * the notes preview, a picker's list, the date editor — sits in a
 * `position: relative` wrapper span that is **inside** the `<td>`, so the
 * `<td>`'s own clip cuts it to the cell rectangle no matter how the wrapper is
 * styled. The columns carrying those popovers therefore spread this and then
 * override `overflow` to `visible`; the exception, which columns it covers, and
 * what still contains those cells are written out at `opensAPopover` in
 * `wbs-table.tsx`.
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
 * What one cell carries because its column is pinned in this layout, or nothing
 * when it is not.
 *
 * The layout is passed in rather than read from a module-level map, which is
 * the change that made a width able to depend on the plan: the offset a cell is
 * held at is a sum of the widths the *same* resolution declared for the columns
 * in front of it.
 *
 * The background is not decoration. A sticky cell keeps its place while the rest
 * of its row scrolls behind it, and a transparent one shows that row straight
 * through itself — two sets of numbers on top of each other and no way to tell
 * which is which. `box-sizing` is the same kind of load-bearing: the declared
 * width has to include the cell's own padding, or every column is a couple of
 * pixels wider than the offset computed from it and the pinned edge drifts.
 */
export function pinnedCellStyle(
  layout: FrameLayout,
  columnId: string,
  part: 'header' | 'body',
): CSSProperties | undefined {
  const pinned = layout.pinned.get(columnId);
  if (pinned === undefined) return undefined;
  return {
    position: 'sticky',
    left: pinned.left,
    // Only where there is one to declare. A flexible column's width is the
    // table-width arithmetic's to decide — dragged or not — and a fixed
    // `width` here would be a second opinion about it: the two-width-systems
    // bug, one column along, and for a dragged Name the exact declaration
    // Chromium answered by re-distributing the viewport's excess (see
    // {@link ResolvedColumn.colWidth}).
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
 * The floor, on the cell as well as in {@link frameLayout} — and with an
 * override in force, the override **is** the floor. A `min-width` and never a
 * `width`: the dragged width itself reaches the browser as the table's own
 * width ({@link tableWidthStyle}), and a cell `width` was the design Chromium
 * refused (see {@link ResolvedColumn.colWidth}). The table's own widths are
 * what really hold this — under `table-layout: fixed` a cell does not get a
 * vote on its column's width — and this is the belt that says so where a
 * reader of the markup is looking.
 */
export function flexibleCellStyle(
  columnId: string,
  state: FrameLayoutState,
): CSSProperties | undefined {
  if (!FLEXIBLE_COLUMNS.has(columnId)) return undefined;
  // Proof: the override dropped from this floor, `lays out, adds up, folds
  // and pins a dragged Name from the one number it resolved` failed on
  // `expected { minWidth: 200 } to deeply equal { minWidth: 300 }` — and on
  // the rendered production path, `lays a remembered Name width on the table
  // itself, and leaves its <col> silent` (wbs-table.test.tsx) failed on
  // `expected '200px' to be '300px'`, the header Name cell's own min-width.
  // Both watched, 2026-08-10.
  return { minWidth: state.columnWidthOverrides?.get(columnId) ?? FLEXIBLE_FLOOR };
}

/**
 * The width the `<table>` itself declares for this layout — the one line the
 * excess-width measurement decided.
 *
 * At rest the table is `min(100%, maxWidth)` with the resolved minimum as its
 * floor: every fixed column takes its declared px and the flexible column
 * absorbs whatever the viewport leaves, which is what makes the table fit the
 * window instead of the window having to fit the table — until that remainder
 * passes {@link FLEXIBLE_CAP}, where the table stops growing and the window
 * keeps the rest. It was a flat `100%` until `spreadsheet-geometry`; the cap
 * is the whole of what that change put here.
 *
 * With a **flexible override** in force the table declares its own width as
 * the resolved sum instead, so every column stands at exactly its resolved
 * width — Name at the override — and the viewport, not the table, keeps the
 * slack. That is the branch the browser picked, and the losing one is deleted
 * rather than kept as config: expressing the override as a `width` on the Name
 * cells against a `width: 100%` table had Chromium distribute the viewport's
 * excess across **every** sized column instead, moving Number off the 93px
 * envelope its own browser test picked.
 *
 * Proof: exactly that — this arm absent (the table left at `width: 100%` with
 * a Name override in force), `keeps every other column on its envelope while
 * Name holds a dragged width` (`e2e/layout.spec.ts`) failed on `Expected: 93 /
 * Received: 103.484375` for the Number column, with every jsdom test green
 * beside it. Watched in CI's `pixels` job, run 31430669282, 2026-08-10. The
 * jsdom half — the string this declares — is `wbs-table.test.tsx`'s `lays a
 * remembered Name width on the table itself, and leaves its <col> silent`.
 */
export function tableWidthStyle(layout: FrameLayout): CSSProperties {
  const flexibleOverridden = layout.columns.some(
    (column) => column.colWidth === undefined && column.width !== undefined,
  );
  return {
    // Proof of the jsdom half: this arm stubbed to a flat '100%', `lays a
    // remembered Name width on the table itself, and leaves its <col> silent`
    // (wbs-table.test.tsx) failed on `expected '100%' to be '1595px'`.
    // Watched, 2026-08-10. The browser half is the JSDoc above.
    // `min(100%, max)` and not a `maxWidth` beside the `width`: the two say
    // the same thing to a browser, and one declaration is what keeps a reader
    // of the markup from having to resolve two. The frame is what the 100% is
    // a percentage of, so the table takes the window until the Name column
    // reaches {@link FLEXIBLE_CAP} and stops there, leaving the slack to the
    // right of the last column rather than inside the Name cells.
    width: flexibleOverridden
      ? `${String(layout.minWidth)}px`
      : `min(100%, ${String(layout.maxWidth)}px)`,
    minWidth: layout.minWidth,
  };
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
 * **It takes the remainder of the window, and it is told so rather than sent
 * to guess.** Until `H header-fits-a-row` the height was `calc(100vh - 16rem)`,
 * and the `16rem` was a guess at the chrome above: the page padding, the
 * heading, the signed-in line, the project picker and this toolbar. A guess is
 * wrong in both directions and it was wrong in both — the page scrolled
 * vertically at 1280×800 with the frame stopping 112px short of the window, and
 * a wider toolbar would have gone the other way. The whole chrome is now one
 * bar, and the layout says what it costs instead of this file estimating it:
 * the flex declaration is what hands this element the remainder.
 *
 * That works only while the whole chain is a column flex whose top is fixed to
 * the viewport — `app.tsx`'s `h-full` wrapper against the `html`/`body`/`#root`
 * height chain in `styles.css`, `ProjectPage`'s `<main>`, `WbsTable`'s
 * `<section>`, each `flex-1` with `min-h-0`. Break any link and
 * this basis has nothing to be a fraction of: the item falls back to its
 * content height and the frame stops being the thing that scrolls. The
 * declaration is asserted in `table-frame.test.ts` and the effect — the frame
 * ending at the bottom of the window, and the height it wins — in
 * `e2e/header.spec.ts`, because only a browser can tell those two apart.
 *
 * **`0 1 auto` rather than `1 1 0%`, since `unified-scroll-docking`: as tall as
 * it needs, never taller than it has.** A basis of `0%` grew this frame to the
 * whole remainder whatever was in it, so a four-row plan put 508px of nothing
 * between its last row and a chart docked to the bottom of the window — the
 * audit's own measurement, 2026-08-11. A basis of `auto` is the content's own
 * height, and `flex-shrink: 1` is the half that keeps the guarantee above: a
 * plan taller than the window still shrinks this frame to exactly the remainder
 * and still scrolls inside it, because this is the only shrinkable item in the
 * column — the toolbar, the height handle and the panel are all `shrink-0`.
 * `flex-grow: 0` is deliberate and is the whole change: nothing left over is
 * spent on a frame that has no rows to put in it.
 *
 * `minHeight` is still the floor, and a window too short for it still leaves the
 * page scrolling; that is the honest fallback rather than rows below a fold
 * nothing can reach. It is also now a floor on a **short plan** — three rows
 * and their picker room come to less than 20rem — which is the one state where
 * this frame is still taller than what it holds, by at most a few rows.
 *
 * The bottom padding is room for the pickers to open into. They are absolutely
 * positioned inside their cells at `top: 100%` and up to 200px tall, and a
 * scroll container clips to its padding box — without the padding a picker on
 * the last row would need the frame scrolled before it could be read. The notes
 * preview is taller than this (320px) and still can.
 *
 * It is also the whole of what stands between the last row and the chart on a
 * short plan now, and it stays: the clipping it exists for is worst in exactly
 * that state, where the frame ends a few pixels under the last row and there is
 * white space below it that the picker is not allowed to reach into.
 */
export const TABLE_FRAME: CSSProperties = {
  overflow: 'auto',
  flex: '0 1 auto',
  minHeight: '20rem',
  paddingBottom: '13rem',
};
