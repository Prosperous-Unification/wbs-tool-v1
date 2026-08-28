import { describe, expect, it } from 'vitest';

import {
  CARD_DEEPEST_INDENT,
  cardIndentFor,
  CELL,
  clampColumnWidth,
  DATE_EDITOR_WIDTH,
  DAY_ENVELOPE,
  DEEPEST_INDENT,
  DEFAULT_COLUMN_SET,
  DEFAULT_HIDDEN_COLUMNS,
  FIXED_COLUMNS,
  FLEXIBLE_CAP,
  FLEXIBLE_COLUMNS,
  FLEXIBLE_FLOOR,
  flexibleCellStyle,
  floorFor,
  foldedTableMinWidth,
  frameLayout,
  type FrameLayoutState,
  hideableColumnIds,
  hierarchyIndentFor,
  NUMBER_ENVELOPE,
  numberIndentFor,
  PINNED_COLUMN_IDS,
  pinnedCellStyle,
  pinnedGeometryFor,
  POPOVER_ROW_LAYER,
  ROW_CONTROLS,
  sizableColumn,
  STICKY_HEADER_CELL,
  TABLE_FRAME,
  tableWidthStyle,
  UnknownColumnError,
  WIDEST_COLUMN,
  widthFor,
} from './table-frame';

/** A plan where somebody has set an earliest start, which is the wider of the two states. */
const DATED: FrameLayoutState = { hasAnyNotBefore: true };
/** A plan where nobody has. */
const UNDATED: FrameLayoutState = { hasAnyNotBefore: false };

/** Every column of the default column set, in the order the table renders them. */
const RENDERED = [
  'drag',
  'number',
  'name',
  'depends',
  'priority',
  'tag',
  'in-parallel',
  'final-total',
  'not-before',
  'start',
  'finish',
  'float',
  'actions',
];

/** The widths one layout declares, by column id, for reading an assertion off. */
const declared = (
  ids: readonly string[],
  state: FrameLayoutState,
): Record<string, number | undefined> =>
  Object.fromEntries(frameLayout(ids, state).columns.map((column) => [column.id, column.width]));

describe('the resolved frame layout', () => {
  it('answers the colgroup, the minimum and the pinned offsets from one resolution', () => {
    // The five consumers this replaced each did their own arithmetic and the
    // pinned offsets were prefix sums frozen at module load, which is why no
    // width could depend on the plan. One object, three answers, one call.
    const layout = frameLayout([...RENDERED, 'r1-final', 'r2-final'], DATED);

    expect(layout.columns.map((column) => column.id)).toEqual([
      ...RENDERED,
      'r1-final',
      'r2-final',
    ]);
    // Name declares nothing: it is the column that takes what the others leave.
    expect(layout.columns.find((column) => column.id === 'name')?.width).toBeUndefined();
    expect(layout.columns.find((column) => column.id === 'number')?.width).toBe(105);
    // 867px of fixed columns with a dated `not-before`, plus Name's 200px
    // floor, plus a folded column for each of two phases. 855 → 867 in
    // `number-column-widen` (93 → 105 in `COLUMN_WIDTHS`).
    expect(layout.minWidth).toBe(867 + FLEXIBLE_FLOOR + 2 * 96);
  });

  it('holds every pinned column at the sum of the widths the same call declared', () => {
    // The offsets are the whole of why this is a module rather than three
    // numbers in the markup: a pinned column lands beside the one in front of
    // it only if it is offset by exactly that column's width — the width this
    // render is using, not one a module-load map remembered.
    //
    // Said as a property of the resolution rather than as three numbers, so it
    // holds in a state nobody wrote a case for: whatever each pinned column
    // resolves to, the one behind it starts where that one ends. The three
    // numbers themselves are the test below.
    // Proof: `pinnedGeometryFor` made to add `ROLE_FINAL_WIDTH` instead of the
    // resolved width, this failed on `expected { left: 96, width: 100 } to
    // deeply equal { left: 24, width: 100 }`. Watched, 2026-08-09.
    for (const state of [DATED, UNDATED]) {
      const layout = frameLayout(RENDERED, state);
      let running = 0;
      for (const id of PINNED_COLUMN_IDS) {
        const resolved = layout.columns.find((column) => column.id === id);
        expect(layout.pinned.get(id)).toEqual({ left: running, width: resolved?.colWidth });
        if (resolved?.colWidth === undefined) {
          // Only the last pinned column may be flexible; see the refusal below.
          expect(id).toBe(PINNED_COLUMN_IDS.at(-1));
          continue;
        }
        running += resolved.colWidth;
      }
    }
  });

  it('starts at the left edge and stacks each column after the last', () => {
    const { pinned } = frameLayout(RENDERED, DATED);

    expect(pinned.get('drag')).toEqual({ left: 0, width: 24 });
    expect(pinned.get('number')).toEqual({ left: 24, width: 105 });
    // Name is pinned at the sum of the two fixed columns in front of it and has
    // no width of its own — the `<colgroup>` decides that, and the browser gate
    // measures this offset at a viewport too narrow to hold the table.
    expect(pinned.get('name')).toEqual({ left: 129, width: undefined });
    // And nothing else is pinned at all. "Depends on" is the one this matters
    // for: it used to sit between Number and Name.
    expect(pinned.get('depends')).toBeUndefined();
    expect(pinnedCellStyle(frameLayout(RENDERED, DATED), 'depends', 'body')).toBeUndefined();
  });

  it('refuses an id nothing sizes, rather than handing back a plausible width', () => {
    // A default here is the overlap bug all over again: a column nobody sized
    // would be laid out at one width and offset from another, silently. The
    // throw used to fire when the module *loaded*; it has to fire per call now,
    // because the answer depends on the plan.
    //
    // Proof: `widthFor`'s `throw new UnknownColumnError(columnId)` replaced by
    // `return Number.NaN`, this failed on `expected [Function] to throw an
    // error` — and, watched in the same run, `frameLayout([...RENDERED,
    // 'serviec'], DATED)` handed back `{ id: 'serviec', width: NaN }` for that
    // `<col>` and a `minWidth` of `NaN`, a table declared narrower than it lays
    // out by a column nobody can see. Watched, 2026-08-09.
    expect(() => frameLayout([...RENDERED, 'serviec'], DATED)).toThrow(UnknownColumnError);
    // A typo carrying a dash must not fall through the role suffixes either.
    expect(() => frameLayout(['role-dev-realsitic'], DATED)).toThrow(UnknownColumnError);
    // And the width that is missing is missing from the sum as well, which is
    // the second half of the same fault: the assertion above only sees the
    // throw, so the sum is stated here as the thing the throw is protecting.
    expect(frameLayout(['drag', 'number'], DATED).minWidth).toBe(129);
  });

  it('refuses a column pinned behind a flexible one', () => {
    // A sticky offset is a sum of the widths in front of it and a flexible
    // column has none — so an offset summed past one is right at exactly one
    // window size. Name is the last pinned column today, and this is what stops
    // a fourth being added behind it in silence.
    //
    // Asked of `pinnedGeometryFor` rather than of `frameLayout`, because the
    // pinned order is a module constant and there is no other way to declare a
    // fourth pinned column: it is the same function `frameLayout` calls, with
    // the one input a test cannot otherwise vary.
    //
    // Proof: the `flexibleBefore !== null` branch deleted, this failed on
    // `expected [Function] to throw an error` — `depends` resolved to `{ left:
    // 193, width: 110 }`, a plausible offset with Name's missing width counted
    // as nothing. Watched, 2026-08-09.
    const { columns } = frameLayout(RENDERED, DATED);

    expect(() => pinnedGeometryFor(columns, [...PINNED_COLUMN_IDS, 'depends'])).toThrow(
      /cannot be pinned after it/,
    );
    // And the order the table really uses is not one of those, which is what
    // makes the refusal a guard rather than a description of today's markup.
    expect(() => pinnedGeometryFor(columns, PINNED_COLUMN_IDS)).not.toThrow();
  });

  it('has a width for every fixed column the table renders', () => {
    for (const column of frameLayout(RENDERED, DATED).columns) {
      if (FLEXIBLE_COLUMNS.has(column.id)) {
        expect(column.width).toBeUndefined();
        continue;
      }
      expect(column.width).toBeGreaterThan(0);
    }
    // A role's columns are named for a role that only exists at runtime, so
    // they are sized by suffix. One per literal in `POINTS`.
    expect(
      declared(
        ['r1-final', 'r1-optimistic', 'r1-realistic', 'r1-pessimistic', 'r1-assignee'],
        DATED,
      ),
    ).toEqual({
      'r1-final': 96,
      'r1-optimistic': 44,
      'r1-realistic': 44,
      'r1-pessimistic': 44,
      'r1-assignee': 120,
    });
  });

  it('leaves the Name column to the layout, and asks nobody for its width', () => {
    // The one column that is a sentence rather than a figure takes whatever
    // the others leave; a declared width on it is the thing that made this
    // table 500px wider than a laptop.
    // Proof: `['name', 360]` put back in `COLUMN_WIDTHS` and `name` taken out
    // of `FLEXIBLE_COLUMNS`, this failed on `expected false to be true`.
    // Watched, 2026-08-08.
    expect(FLEXIBLE_COLUMNS.has('name')).toBe(true);
    expect(() => widthFor('name', DATED)).toThrow(UnknownColumnError);
    // And the floor it may not shrink past is on the cell as well as in the
    // table's minimum.
    expect(flexibleCellStyle('name', DATED)).toEqual({ minWidth: FLEXIBLE_FLOOR });
    expect(flexibleCellStyle('depends', DATED)).toBeUndefined();
  });

  it('has no width for a Notes column, because there is no Notes column', () => {
    // The notes are typed under the name, in the Name cell. A width left
    // behind here would be 260px of table nothing renders — and, worse, a
    // colgroup that still had a `<col>` for it would shift every pinned offset
    // after it.
    // Proof: `['notes', 260]` put back in `COLUMN_WIDTHS`, this failed on
    // `expected [Function] to throw an error`. Watched, 2026-08-08.
    expect(() => widthFor('notes', DATED)).toThrow(UnknownColumnError);
    expect(FIXED_COLUMNS).not.toContain('notes');
  });

  it('compacts every fixed column to the figure it actually holds', () => {
    // The v1.1 compaction plus this change's two narrowings, pinned as
    // literals because the equations below are only true while these are. Each
    // one is a number of days, a date, a handle or a glyph — nothing here holds
    // a sentence.
    // Proof: run against the pre-compaction widths, this failed on
    // `expected { drag: 28, number: 168, …(8) } to deeply equal
    // { drag: 24, number: 100, …(8) }`. Watched, 2026-08-08.
    expect(
      declared(
        RENDERED.filter((id) => !FLEXIBLE_COLUMNS.has(id)),
        DATED,
      ),
    ).toEqual({
      drag: 24,
      number: 105,
      depends: 110,
      priority: 48,
      tag: 120,
      'in-parallel': 32,
      'final-total': 52,
      'not-before': 84,
      start: 98,
      finish: 98,
      float: 56,
      actions: 40,
    });
  });
});

describe('the earliest-start column is as narrow as the plan lets it be', () => {
  it('is 84px while any row in the project sets a day, and 56px when none does', () => {
    // A width that is a fact about the plan, which is the whole reason
    // `FrameLayoutState` exists. 146 was what a native date input needed, and
    // the column held one on every row; it holds a short date now.
    // Proof: `PLAN_WIDTHS`'s `not-before` entry replaced by a constant 84,
    // this failed on `expected 84 to be 56`. Watched, 2026-08-09.
    expect(declared(['not-before'], DATED)).toEqual({ 'not-before': 84 });
    expect(declared(['not-before'], UNDATED)).toEqual({ 'not-before': 56 });
  });

  it('moves the whole table by exactly that difference and nothing else', () => {
    // Stated as the difference rather than as two totals, so a second column
    // that quietly took the state into account would show up here.
    const dated = frameLayout(RENDERED, DATED);
    const undated = frameLayout(RENDERED, UNDATED);

    expect(dated.minWidth - undated.minWidth).toBe(84 - 56);
    for (const column of dated.columns) {
      if (column.id === 'not-before') continue;
      expect(undated.columns.find((each) => each.id === column.id)?.width).toBe(column.width);
    }
  });

  it('keeps the editor wider than the column it opens in', () => {
    // The editor escapes its cell rather than sizing it, which is only a
    // sentence worth writing down while the two numbers really do disagree: a
    // column as wide as the editor is a column that never had to escape.
    expect(DATE_EDITOR_WIDTH).toBeGreaterThan(widthFor('not-before', DATED));
  });
});

describe('the width equation the table is laid out by', () => {
  it('adds a table up from its columns, budgeting the floor for the flexible one', () => {
    // The honest width equation, which is the whole of this module: the table
    // is `width: 100%` with this as its minimum, so above it nothing scrolls
    // sideways and below it the pinned columns take over.
    // Proof, both halves: the `FLEXIBLE_COLUMNS` branch in `frameLayout`
    // replaced by `widthFor(id, state)`, this failed on `UnknownColumnError:
    // No declared width for column "name"`; replaced by `0`, on `expected +0
    // to be 200`. Watched, 2026-08-09.
    expect(frameLayout(['drag', 'number'], DATED).minWidth).toBe(24 + 105);
    expect(frameLayout(['name'], DATED).minWidth).toBe(FLEXIBLE_FLOOR);

    // 819px of fixed columns with a dated `not-before`, plus Name's 200px
    // floor. The three states the browser gate measures, computed here so a
    // width change that breaks one of them fails in the repo gate rather than
    // only in a browser: two roles folded fits a 1280 laptop, whose frame
    // measures 1248px.
    //
    // Three folded no longer does, and that is `column-rebalance`'s stated
    // cost: it was 1247 against that 1248 — one pixel inside — and the two
    // date columns took 124px to stop wrapping their days. A three-phase plan
    // scrolls its frame at 1280 now, which is the backstop the pinned columns
    // exist for. One role unfolded has never fitted a 1280 laptop, and two of
    // them fit nothing in the matrix: since `unfolding-may-scroll` that is a
    // state a reader may ask for, and the frame is what scrolls for it.
    //
    // Each figure is 48px larger since `priority-column`: the two-phase plan
    // needs 1247 where it needed 1199, which is one pixel inside that same
    // 1248 — the margin `column-rebalance` left is now spent, and a single row
    // setting an earliest start is what a two-phase plan has left before it
    // scrolls. A plan with no dates on it is 28px narrower again and sits
    // comfortably inside. 48px is the narrowest a four-digit priority fits in.
    //
    // **1247 → 1259 in `number-column-widen`** (93 → 105 in `COLUMN_WIDTHS`,
    // #62's design.md D4: the depth-5/6 Number clip). Still one pixel inside
    // 1248 at the `SEEDED_PLAN`/`UNDATED` state the browser gate measures at —
    // `1259 - 28 = 1231`, 17px of `table-width-budget`'s measured 29px of
    // slack left. `e2e/layout.spec.ts`'s `holds the folded budget at 1280`
    // re-derives this figure rather than repeating it.
    expect(frameLayout([...RENDERED, 'r1-final', 'r2-final'], DATED).minWidth).toBe(1259);
    expect(frameLayout([...RENDERED, 'r1-final', 'r2-final', 'r3-final'], DATED).minWidth).toBe(
      1355,
    );
    expect(
      frameLayout(
        [
          ...RENDERED,
          'r1-final',
          'r1-optimistic',
          'r1-realistic',
          'r1-pessimistic',
          'r1-assignee',
          'r2-final',
        ],
        DATED,
      ).minWidth,
    ).toBe(1511);
  });

  it('caps the table at the fixed columns plus the Name cap', () => {
    // The other end of the same equation, and the reason it is an end of *this*
    // equation rather than a `max-width` on the Name cells: `table-layout:
    // fixed` gives a cell no vote on its column's width, so the only place a
    // cap on the flexible column can be spent is the table's own width.
    //
    // Both ends are summed from the same resolved columns, or the cap would be
    // a second opinion about the widths the `<colgroup>` declares — the fault
    // this module exists to prevent, one column along.
    expect(frameLayout(['drag', 'number'], DATED).maxWidth).toBe(24 + 105);
    expect(frameLayout(['name'], DATED).maxWidth).toBe(FLEXIBLE_CAP);
    // The two-phase plan the browser gate measures: 1259 at the floor, and the
    // same fixed columns with Name at its cap instead.
    expect(frameLayout([...RENDERED, 'r1-final', 'r2-final'], DATED).maxWidth).toBe(
      1259 - FLEXIBLE_FLOOR + FLEXIBLE_CAP,
    );
    // Above the floor and below the widest a drag may reach, or the cap is
    // either not a cap or not reachable.
    expect(FLEXIBLE_CAP).toBeGreaterThan(FLEXIBLE_FLOOR);
    expect(FLEXIBLE_CAP).toBeLessThan(WIDEST_COLUMN);
  });

  it('lays the cap on the table itself, with the minimum still under it', () => {
    // What the `<table>` is told, which is the one declaration the cap reaches
    // the browser through.
    // Proof: the `min()` reverted to a flat `'100%'`, this failed on `expected
    // { width: '100%', minWidth: 1247 } to deeply equal { width: 'min(100%,
    // 1467px)', …(1) }`, with the dragged case's resting half beside it.
    // Watched on h2puni, 2026-08-12 (fault F2).
    const layout = frameLayout([...RENDERED, 'r1-final', 'r2-final'], DATED);
    expect(tableWidthStyle(layout)).toEqual({
      width: `min(100%, ${String(layout.maxWidth)}px)`,
      minWidth: layout.minWidth,
    });
  });

  it('makes the declared width include the cell chrome, and clips what overruns', () => {
    // `border-box` or every column is its padding wider than the offset worked
    // out from it, and the pinned edge drifts by a couple of pixels a column.
    expect(CELL.boxSizing).toBe('border-box');
    // The backstop: a descendant this plan missed cannot paint into the
    // neighbouring column, whatever it asks for.
    expect(CELL.overflow).toBe('hidden');
  });
});

describe('a pinned cell', () => {
  it('gets an opaque background and a layer to paint in', () => {
    // Transparent, a pinned cell shows the row scrolling behind it straight
    // through itself.
    const layout = frameLayout(RENDERED, DATED);
    const body = pinnedCellStyle(layout, 'number', 'body');
    expect(body?.position).toBe('sticky');
    // The offset the layout works out, on the cell that carries it.
    expect(body?.left).toBe(24);
    expect(body?.width).toBe(105);
    const name = pinnedCellStyle(layout, 'name', 'body');
    expect(name?.left).toBe(129);
    // Pinned, and with no width of its own: the `<colgroup>` is the only thing
    // that sizes a flexible column, and a `width` here would be the second
    // opinion that the whole width table exists to prevent.
    // Proof: `pinnedCellStyle` made to declare `width: pinned.width ?? 360`
    // again, this failed on `expected 360 to be undefined`. Watched,
    // 2026-08-08.
    expect(name?.width).toBeUndefined();
    expect(name?.position).toBe('sticky');
    // The row's own colour, with an opaque fallback behind it: the shade is
    // `styles.css`'s to decide per row — banded, hovered, armed — and the
    // fallback is what keeps this cell opaque with that stylesheet deleted.
    expect(body?.background).toBe('var(--cell-bg, var(--background))');
    expect(body?.boxSizing).toBe('border-box');
    expect(body?.zIndex).toBe(1);

    // A pinned header cell is sticky on both axes and crosses everything else,
    // so it is on top of both the header row and the pinned body cells.
    const header = pinnedCellStyle(layout, 'number', 'header');
    expect(header?.background).toBe(STICKY_HEADER_CELL.background);
    expect(header?.zIndex).toBe(4);
    expect(STICKY_HEADER_CELL.zIndex).toBe(3);

    // And the layer a row is lifted to while a popover is open in one of its
    // pinned cells: above the body cells that would otherwise paint over it,
    // below the heading, which stays a heading.
    // Proof: observed in a browser before it existed — `4px below the name
    // cell is <textarea> in the name column, not the preview`, on h2puni,
    // 2026-08-08.
    expect(POPOVER_ROW_LAYER).toBeGreaterThan(Number(body?.zIndex));
    expect(POPOVER_ROW_LAYER).toBeLessThan(Number(STICKY_HEADER_CELL.zIndex));
  });

  it('sticks the heading to the top of the frame', () => {
    expect(STICKY_HEADER_CELL.position).toBe('sticky');
    expect(STICKY_HEADER_CELL.top).toBe(0);
    expect(STICKY_HEADER_CELL.background).not.toBe('transparent');
  });
});

describe('the two indents a depth resolves to', () => {
  it('steps one level at a time while the tree is shallow, and the two agree there', () => {
    // "Shallow" is every depth up to the cap, whatever the cap is: the third
    // literal here was `numberIndentFor(3) === 36`, true of a cap of 4 and a
    // statement about the *other* branch once `table-mechanics` moved it to 2.
    expect(numberIndentFor(0)).toBe(0);
    expect(numberIndentFor(1)).toBe(12);
    expect(DEEPEST_INDENT).toBeGreaterThan(0);
    for (let depth = 0; depth <= DEEPEST_INDENT; depth += 1) {
      expect(numberIndentFor(depth)).toBe(12 * depth);
      expect(hierarchyIndentFor(depth)).toBe(numberIndentFor(depth));
    }
  });

  it('caps the Number indent, so the Number column cannot outgrow its declared width', () => {
    // The cap is what keeps Name, pinned at the sum of the widths in front of
    // it, from being painted over the number it is meant to sit beside.
    expect(numberIndentFor(DEEPEST_INDENT)).toBe(numberIndentFor(DEEPEST_INDENT + 1));
    expect(numberIndentFor(40)).toBe(numberIndentFor(DEEPEST_INDENT));
    // And at the depth the column is sized for, the number keeps the larger
    // half of its own column — which is the depth this assertion has to be
    // made at since `column-rebalance`: the envelope is two levels now, so a
    // row at the deepest indent spends 48px of 105 on white space by design
    // and has its number clipped into its `title`.
    // Proof: `INDENT_STEP` put back to 16, this failed on `expected 16 to be
    // less than 46.5`. Watched, 2026-08-10 — and on `expected 64 to be less
    // than 50` on 2026-08-08, when the assertion was made at the deepest
    // indent and the column was 100px wide.
    expect(numberIndentFor(NUMBER_ENVELOPE.split('.').length - 1)).toBeLessThan(
      widthFor('number', DATED) / 2,
    );
  });

  it('keeps the hierarchy indent growing past the Number cap, one step per level to depth 6', () => {
    // The point of `deep-indent`: every level renders deeper than its parent,
    // where the capped indent drew depth 5 and 6 identically under depth 4.
    // Proof: `numberIndentFor`'s `Math.min(depth, DEEPEST_INDENT)` cap put on
    // `hierarchyIndentFor` — this failed on `expected +0 to be 12` at the
    // depth-5 step, `3 failed | 32 passed`. Watched, 2026-08-10.
    for (let depth = 1; depth <= 6; depth += 1) {
      expect(hierarchyIndentFor(depth) - hierarchyIndentFor(depth - 1)).toBe(12);
    }
    expect(hierarchyIndentFor(6)).toBe(72);
  });

  it("hands the Name cell exactly the share the Number cell's cap withheld", () => {
    // The difference is what the Name cell carries: zero while the Number
    // indent is still moving, one step per level once it has stopped — so the
    // sum the reader's eye adds up (Number's indent plus Name's shift) grows
    // at every level. `e2e/layout.spec.ts` measures that sum in a browser;
    // this is its arithmetic.
    for (const depth of [0, 1, DEEPEST_INDENT]) {
      expect(hierarchyIndentFor(depth) - numberIndentFor(depth)).toBe(0);
    }
    // Stated against the cap rather than against the two depths it happened to
    // be at: `table-mechanics` moved {@link DEEPEST_INDENT} from 4 to 2 and
    // these two literals were the arithmetic of the old one, so the test that
    // holds the *relation* had to be rewritten before it could see the change
    // at all. One step per level past the cap, at every level past the cap.
    for (const past of [1, 2, 3]) {
      const depth = DEEPEST_INDENT + past;
      expect(hierarchyIndentFor(depth) - numberIndentFor(depth)).toBe(12 * past);
    }
  });

  it('caps the card indent at its own stated depth, deeper than the Number cap', () => {
    // A 390px card cannot spend an unbounded margin the way the flexible Name
    // column can spend padding: the cards stop at {@link CARD_DEEPEST_INDENT},
    // stated here rather than discovered at a viewport.
    expect(CARD_DEEPEST_INDENT).toBe(6);
    expect(cardIndentFor(5)).toBe(hierarchyIndentFor(5));
    expect(cardIndentFor(CARD_DEEPEST_INDENT)).toBe(cardIndentFor(CARD_DEEPEST_INDENT + 1));
    expect(cardIndentFor(40)).toBe(cardIndentFor(CARD_DEEPEST_INDENT));
    expect(cardIndentFor(CARD_DEEPEST_INDENT)).toBeGreaterThan(
      numberIndentFor(CARD_DEEPEST_INDENT),
    );
  });

  it('states the envelope the column is sized to, rather than a longest number', () => {
    // Two levels: a root label's three characters, plus one dotted
    // single-character segment. There is no longest work item number to
    // measure instead — an insertion against a frozen anchor appends a digit,
    // unboundedly — and `e2e/layout.spec.ts` is what measures this string in a
    // browser, at the indent a row of this depth is drawn at.
    expect(NUMBER_ENVELOPE).toBe('010.1');
    expect(NUMBER_ENVELOPE.split('.')).toHaveLength(2);
  });

  it('states the widest day the two date columns undertake to hold', () => {
    // The other envelope, and the only one that really is a maximum: the
    // formatter's month names are a fixed table of twelve and its year is four
    // digits, so the set of days this table can print is finite.
    // `e2e/layout.spec.ts`'s `is as wide as the widest day the formatter can
    // print` measures every one of them in a real cell and asserts this is the
    // widest — this file cannot, because jsdom lays out no text at all.
    expect(DAY_ENVELOPE).toBe('20 May 2027 ?');
    // The marker End draws on an unestimated row is inside it, because a
    // marker that wraps is the same failure as a date that wraps.
    expect(DAY_ENVELOPE.endsWith(' ?')).toBe(true);
    // And both columns are laid out at one width, which is what makes the two
    // ends of a span readable against each other.
    expect(widthFor('start', DATED)).toBe(widthFor('finish', DATED));
  });
});

describe('the frame the table scrolls inside', () => {
  it('scrolls on both axes and is bounded, or the sticky heading means nothing', () => {
    // `overflow-x: auto` forces the other axis to compute to `auto` anyway, so
    // this element is the scrollport either way — and a scrollport as tall as
    // its own content never scrolls, which would leave `top: 0` sticking to
    // nothing while the page carried the whole frame away.
    expect(TABLE_FRAME.overflow).toBe('auto');
    // What bounds it is `flex-shrink: 1` inside a parent whose own height is
    // the window's: a plan taller than the remainder is shrunk to exactly the
    // remainder, and this is the only shrinkable item in that column. The
    // declaration this replaces was `maxHeight: calc(100vh - 16rem)` — an
    // estimate of the chrome above, wrong by 112px at 1280×800 in the
    // direction that left the page scrolling.
    //
    // The basis is `auto` since `unified-scroll-docking` and the grow factor is
    // `0`: a frame that grew past its own rows put 508px of nothing between a
    // short plan and the chart docked under it. Growth is what was wrong, not
    // the bound — a basis of `auto` with **no shrink** would be the unbounded
    // case this assertion is really about, and it is the one being ruled out.
    expect(TABLE_FRAME.flex).toBe('0 1 auto');
    // Stated as well as implied: a `maxHeight` back beside the flex basis would
    // be a second opinion about this element's height, and the two would
    // disagree the moment the header changed — which is the whole fault.
    expect(TABLE_FRAME.maxHeight).toBeUndefined();
  });

  it('leaves room under the last row for a picker to open into', () => {
    // The dep and assignee lists are absolutely positioned at `top: 100%` and
    // 200px tall, and a scroll container clips to its padding box.
    expect(TABLE_FRAME.paddingBottom).toBe('13rem');
  });
});

describe('how wide the phases make the table', () => {
  it('grows by one folded column per phase, from the same widths the table sums', () => {
    // The sentence the Phases dialog prints, and the phases' own ids rather
    // than a count: every width resolves per column id now, so a figure summed
    // from invented ids would answer about columns that do not exist.
    expect(foldedTableMinWidth(['role-dev', 'role-qa'], DATED)).toBe(1259);
    expect(
      foldedTableMinWidth(['role-dev', 'role-qa', 'role-ops'], DATED) -
        foldedTableMinWidth(['role-dev', 'role-qa'], DATED),
    ).toBe(widthFor('anything-final', DATED));
    // And it answers the narrow state too, which is the fact a count could
    // never carry into it.
    expect(foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED)).toBe(1259 - (84 - 56));
  });

  it('is the fixed columns plus Name plus the phases, with nothing left out', () => {
    // Said as the equation rather than as a total, so a column added to the
    // width table without being rendered — or rendered without being summed —
    // shows up here as a disagreement rather than as a number nobody checks.
    // Proof: the role columns dropped from the sum, `grows by one folded column
    // per phase` failed on `expected 959 to be 1151`. Watched, 2026-08-09.
    expect(foldedTableMinWidth([], DATED)).toBe(
      frameLayout([...DEFAULT_COLUMN_SET, ...FLEXIBLE_COLUMNS], DATED).minWidth,
    );
    // Every column the table really renders is in that set, which is what the
    // equation above is only worth anything while it is true.
    for (const id of RENDERED) expect([...DEFAULT_COLUMN_SET, ...FLEXIBLE_COLUMNS]).toContain(id);
  });

  it('has no phases to be wide for at all, and still declares a table', () => {
    // A project may hold none — `R1`'s spec says the seeded pair is data rather
    // than a limit — and the dialog still has a number to print.
    expect(foldedTableMinWidth([], DATED)).toBe(1067);
  });

  it('hides Teams and Services by default, shows Tags, and the folded figures do not move', () => {
    // `configurable-columns`: the default column set is the same on every
    // deployment, whatever its directory holds. Teams off pays for Tags on —
    // both 120px — so the 1067 pinned above since 2026-08-09 and the 1259 the
    // budget test at 1280 is measured against are the figures they were.
    // The floor first, deliberately: it is the fact, and the membership
    // assertions under it are only why it is true.
    expect(foldedTableMinWidth([], DATED)).toBe(1067);
    expect(foldedTableMinWidth(['role-dev', 'role-qa'], DATED)).toBe(1259);
    expect(DEFAULT_HIDDEN_COLUMNS).toEqual(['team', 'service']);
    expect(DEFAULT_COLUMN_SET).toContain('tag');
    expect(DEFAULT_COLUMN_SET).not.toContain('team');
    expect(DEFAULT_COLUMN_SET).not.toContain('service');
    // Every declared column is still declared — a hidden column has to lay
    // out on the deployments that show it.
    for (const id of ['team', 'tag', 'service']) {
      expect(FIXED_COLUMNS).toContain(id);
      expect(widthFor(id, DATED)).toBe(120);
    }
    // Proof: `tag` put into `DEFAULT_HIDDEN_COLUMNS`, this file failed on
    // `expected 1139 to be 1259` and `expected […] to include 'tag'`; `team`
    // struck from it, on `expected 1187 to be 1067`. Watched, 2026-08-28.
  });

  it('subtracts what the reader has hidden, a whole role included', () => {
    // The Phases dialog quotes the table actually on screen, not the default
    // one: a reader who has hidden Depends on is 110px narrower than the
    // default, and one who has shown Teams is 120px wider.
    expect(foldedTableMinWidth([], DATED, [...DEFAULT_HIDDEN_COLUMNS, 'depends'])).toBe(
      1067 - widthFor('depends', DATED),
    );
    expect(foldedTableMinWidth([], DATED, ['service'])).toBe(1067 + widthFor('team', DATED));
    // A hidden role takes its folded column with it, and nothing else.
    expect(
      foldedTableMinWidth(['role-dev', 'role-qa'], DATED, [...DEFAULT_HIDDEN_COLUMNS, 'role-qa']),
    ).toBe(foldedTableMinWidth(['role-dev'], DATED));
    // Proof: the hidden list ignored, the first line failed on `expected 1067
    // to be 957`. Watched, 2026-08-28.
  });

  it('offers every data column and every role to hide, and none of the row’s controls', () => {
    // What the Columns control lists, in the order the table renders them: the
    // drag handle, Number, Name and the ⋯ menu are the row's controls and are
    // never offered — a table with no Name column is not a narrower table, it
    // is no table. A role is one entry, by its bare id, and sits where its
    // columns do.
    expect(hideableColumnIds(['role-dev', 'role-qa'])).toEqual([
      'depends',
      'priority',
      'team',
      'tag',
      'service',
      'in-parallel',
      'role-dev',
      'role-qa',
      'final-total',
      'not-before',
      'start',
      'finish',
      'float',
    ]);
    // And the list is the whole width table less the controls, so a column
    // added to the width table without a place in this order fails here.
    expect(ROW_CONTROLS).toEqual(['drag', 'number', 'name', 'actions']);
    expect([...hideableColumnIds([])].sort()).toEqual(
      FIXED_COLUMNS.filter((id) => !ROW_CONTROLS.includes(id)).sort(),
    );
    // Proof: `name` put at the head of the list, this failed on `expected
    // [ Array(14) ] to deeply equal [ Array(13) ]`; `float` dropped from it, on
    // the same shape the other way. Watched, 2026-08-28.
  });

  it('refuses a hidden id that is neither a column nor a role of this plan', () => {
    // Storage is validated at its boundary and drops unknown ids on their own;
    // an unknown id reaching this far is a caller's typo, and a typo silently
    // hiding nothing is the check that cannot fail.
    expect(() => foldedTableMinWidth(['role-dev'], DATED, ['tags'])).toThrow(UnknownColumnError);
    expect(() => foldedTableMinWidth(['role-dev'], DATED, ['role-qa'])).toThrow(UnknownColumnError);
  });
});

describe('a column this browser has dragged to another width', () => {
  /**
   * The Number column 40px wider than its default, which is the one case every
   * consumer below is asked about.
   *
   * One override and four questions, deliberately: a resized column laid out
   * at one width while an offset is summed from another is the failure this
   * module exists to make impossible, and it is invisible to any test that
   * asks only one of them.
   */
  const NUMBER_DRAGGED: FrameLayoutState = {
    hasAnyNotBefore: true,
    columnWidthOverrides: new Map([['number', 105 + 40]]),
  };

  it('lays out, adds up, folds and pins from the one number it resolved', () => {
    // Proof: `frameLayout`'s pinned arm re-pointed at `defaultWidthFor` instead
    // of the widths it had just resolved, this failed on `expected { left: 24,
    // width: 169 } to deeply equal { left: 24, width: 209 }` — the `<col>` 40px
    // wider with Name still pinned where it was, which is a pinned Name painted
    // over "Depends on" all over again. Watched, 2026-08-09.
    const dragged = frameLayout(RENDERED, NUMBER_DRAGGED);
    const resting = frameLayout(RENDERED, DATED);

    expect(dragged.columns.find((column) => column.id === 'number')?.width).toBe(145);
    expect(dragged.minWidth).toBe(resting.minWidth + 40);
    expect(dragged.pinned.get('number')).toEqual({ left: 24, width: 145 });
    expect(dragged.pinned.get('name')?.left).toBe((resting.pinned.get('name')?.left ?? 0) + 40);
    // The fourth consumer, which is the figure the Phases dialog quotes.
    expect(foldedTableMinWidth(['role-dev'], NUMBER_DRAGGED)).toBe(
      foldedTableMinWidth(['role-dev'], DATED) + 40,
    );
  });

  it('carries a folded phase’s own width under the id the table renders it by', () => {
    // The reason `foldedTableMinWidth` takes real role ids rather than a count:
    // an override is stored under `<roleId>-final`, and a `phase0-final`
    // invented from a length could never carry one. Both answered 96px until
    // this change, which is why nothing measurable told them apart.
    const dragged: FrameLayoutState = {
      hasAnyNotBefore: false,
      columnWidthOverrides: new Map([['role-dev-final', 140]]),
    };

    expect(foldedTableMinWidth(['role-dev', 'role-qa'], dragged)).toBe(
      foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED) + (140 - 96),
    );
    expect(foldedTableMinWidth(['phase0', 'phase1'], dragged)).toBe(
      foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED),
    );
  });

  it('outranks a default that depends on the plan, and freezes it there', () => {
    // `not-before` is 56px or 84px depending on whether any row in the project
    // sets a day. An override on it is the reader saying how wide they want it,
    // and a column that jumped the first time somebody dated a row would be a
    // preference that does not hold.
    const overrides = new Map([['not-before', 110]]);

    expect(
      widthFor('not-before', { hasAnyNotBefore: false, columnWidthOverrides: overrides }),
    ).toBe(110);
    expect(widthFor('not-before', { hasAnyNotBefore: true, columnWidthOverrides: overrides })).toBe(
      110,
    );
    // And nothing else moves with it: one column's override is one column's.
    expect(declared(RENDERED, { ...DATED, columnWidthOverrides: overrides })).toEqual({
      ...declared(RENDERED, DATED),
      'not-before': 110,
    });
  });

  /**
   * The Name column dragged to 300px, which is every consumer's question about
   * the one column whose override and `<col>` width are different answers.
   */
  const NAME_DRAGGED: FrameLayoutState = {
    hasAnyNotBefore: true,
    columnWidthOverrides: new Map([['name', 300]]),
  };

  it('resolves a dragged width for the flexible column, and a floor of its own', () => {
    // Until `name-column-drag` this test was `refuses the flexible column a
    // width and a floor alike, override or not`, and the flexible arm in
    // `floorFor` was that negative's recorded injected fault
    // (`column-widths-drag/verify.md` row 4). The supersession adopts the
    // fault as the behaviour — the delta spec strikes the old requirement by
    // name — so what is proven flips from refusal to the resolved floor:
    // `FLEXIBLE_FLOOR`, the same constant `flexibleCellStyle` declares on the
    // cell, because the two disagreeing is the two-width-systems fault this
    // module exists to prevent. The `min(default, NARROWEST_COLUMN)` path
    // would have said 36.
    expect(widthFor('name', NAME_DRAGGED)).toBe(300);
    expect(floorFor('name', DATED)).toBe(FLEXIBLE_FLOOR);
    expect(clampColumnWidth('name', 100, DATED)).toBe(FLEXIBLE_FLOOR);
    expect(clampColumnWidth('name', 10_000, DATED)).toBe(WIDEST_COLUMN);
    expect(clampColumnWidth('name', 300, DATED)).toBe(300);
    // With no override there is still no width to hand back: a sentinel would
    // let the pinned-offset arithmetic add a number the browser never uses.
    expect(() => widthFor('name', DATED)).toThrow(UnknownColumnError);
  });

  it('lays out, adds up, folds and pins a dragged Name from the one number it resolved', () => {
    // The four-consumer case, extended to the flexible column: the minimum
    // and the folded minimum carry the override, while the `<col>` and the
    // pinned cell deliberately do not — the dragged width reaches the browser
    // as the table's **own** width, so every column stands at exactly its
    // resolved width and the viewport keeps the slack. A cell `width` was the
    // design tried first, and Chromium answered it by distributing the
    // viewport's excess across every sized column — Number measured at 103.48
    // against its 93px envelope (CI `pixels` run 31430669282, 2026-08-10) —
    // so it is deleted, not kept. `e2e/layout.spec.ts` measures the
    // consequence; this asserts the markup contract.
    const draggedName = frameLayout(RENDERED, NAME_DRAGGED);
    const resting = frameLayout(RENDERED, DATED);
    const name = draggedName.columns.find((column) => column.id === 'name');

    expect(name?.width).toBe(300);
    expect(name?.colWidth).toBeUndefined();
    // And a fixed column's two answers are one number, which is what keeps
    // `colWidth` a second reading rather than a second system.
    const number = draggedName.columns.find((column) => column.id === 'number');
    expect(number?.colWidth).toBe(number?.width);
    expect(draggedName.minWidth).toBe(resting.minWidth - FLEXIBLE_FLOOR + 300);
    // The pinned Name cell declares no width, dragged or not: what a cell
    // declares must be exactly what the `<colgroup>` declares, and for Name
    // that is nothing — the table-width arithmetic is what hands it the
    // override.
    expect(draggedName.pinned.get('name')).toEqual({ left: 129, width: undefined });
    // Name is the last pinned column, so no offset in front of it moves.
    expect(draggedName.pinned.get('number')).toEqual(resting.pinned.get('number'));
    expect(foldedTableMinWidth(['role-dev'], NAME_DRAGGED)).toBe(
      foldedTableMinWidth(['role-dev'], DATED) + (300 - FLEXIBLE_FLOOR),
    );
    // The table's own width is where the override reaches the browser: the
    // resolved sum with the override in force, and `min(100%, cap)` without —
    // a drag outranks `FLEXIBLE_CAP` exactly as it outranks the floor, because
    // it is the reader saying what this column should be.
    expect(tableWidthStyle(draggedName)).toEqual({
      width: `${String(draggedName.minWidth)}px`,
      minWidth: draggedName.minWidth,
    });
    expect(tableWidthStyle(resting)).toEqual({
      width: `min(100%, ${String(resting.maxWidth)}px)`,
      minWidth: resting.minWidth,
    });
    // And with the override in force the two ends of the range are the same
    // number: there is no cap left to reach.
    expect(draggedName.maxWidth).toBe(draggedName.minWidth);
    // The cell still carries the override as its floor — the belt, not the
    // declaration.
    expect(flexibleCellStyle('name', NAME_DRAGGED)).toEqual({ minWidth: 300 });
  });

  it('still refuses a column pinned behind the flexible one, override or not', () => {
    // An override gives Name a width, and that width is still not a number an
    // offset may be summed from: the `<col>` is unsized so Name keeps
    // absorbing the viewport's excess, and above the table minimum it is laid
    // out wider than the override says.
    const { columns } = frameLayout(RENDERED, NAME_DRAGGED);

    expect(() => pinnedGeometryFor(columns, [...PINNED_COLUMN_IDS, 'depends'])).toThrow(
      /cannot be pinned after it/,
    );
  });

  it('clamps a drag to this column’s own floor and to the one shared ceiling', () => {
    // Proof: `floorFor` pinned to a flat 36 rather than the narrower of 36 and
    // the column's own default, this failed on `expected 36 to be 24` — the
    // 24px drag-handle column pushed out to 36 by a floor that had never
    // looked at it. Watched, 2026-08-09.
    expect(clampColumnWidth('number', 10, DATED)).toBe(36);
    expect(clampColumnWidth('drag', 10, DATED)).toBe(24);
    expect(clampColumnWidth('drag', 24, DATED)).toBe(24);
    expect(clampColumnWidth('number', 10_000, DATED)).toBe(WIDEST_COLUMN);
    expect(clampColumnWidth('number', 240, DATED)).toBe(240);
    // Where 600 comes from, said as arithmetic rather than as a literal: three
    // times the flexible column's own floor, and most of a 900px window.
    expect(WIDEST_COLUMN).toBe(600);
    expect(WIDEST_COLUMN).toBe(3 * FLEXIBLE_FLOOR);
  });

  it('has a floor that does not move with the plan, which is what lets it be read at mount', () => {
    // `rememberedWidthOverrides` runs before a single row has arrived, so the
    // range it checks a stored width against has to be the range the drag will
    // clamp to later. It is, for every column: the only width that depends on
    // the plan is far above the 36px floor in both of its states.
    for (const id of FIXED_COLUMNS) expect(floorFor(id, DATED)).toBe(floorFor(id, UNDATED));
    expect(floorFor('not-before', DATED)).toBe(36);
    expect(floorFor('drag', DATED)).toBe(24);
    // The flexible column's floor is a constant of its own and moves with
    // nothing at all, which is what lets a stored `name` entry be range-checked
    // at mount like every other.
    expect(floorFor('name', DATED)).toBe(floorFor('name', UNDATED));
    expect(floorFor('name', DATED)).toBe(FLEXIBLE_FLOOR);
  });

  it('says which ids can be sized at all, which is what a stored width is checked against', () => {
    expect(sizableColumn('number', DATED)).toBe(true);
    // A phase this project no longer holds is sizable and simply never asked
    // about — the harmlessness a remembered expansion's deleted row ids have.
    expect(sizableColumn('role-gone-final', DATED)).toBe(true);
    // Sizable since `name-column-drag`: a stored `name` entry survives this
    // filter and is then judged by the range check against Name's own bounds.
    expect(sizableColumn('name', DATED)).toBe(true);
    expect(sizableColumn('serviec', DATED)).toBe(false);
  });
});
