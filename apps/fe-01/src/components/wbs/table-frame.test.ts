import { describe, expect, it } from 'vitest';

import {
  CELL,
  DEEPEST_INDENT,
  FLEXIBLE_COLUMNS,
  FLEXIBLE_FLOOR,
  flexibleCellStyle,
  indentFor,
  PINNED_COLUMNS,
  pinnedCellStyle,
  pinnedGeometry,
  POPOVER_ROW_LAYER,
  STICKY_HEADER_CELL,
  TABLE_FRAME,
  tableMinWidth,
  UnknownColumnError,
  widthFor,
} from './table-frame';

describe('the width table', () => {
  it('is the same table the pinned offsets are prefix sums of', () => {
    // The overlap this replaces came from two width systems disagreeing: the
    // offsets assumed one set of numbers and the browser laid out another. One
    // table, read by both, is what makes that disagreement unrepresentable.
    // Proof: PINNED_COLUMNS written back out by hand with `number` at 180,
    // this failed on `expected 180 to be 168`. Watched, 2026-08-07.
    let left = 0;
    for (const { id, width } of PINNED_COLUMNS) {
      expect(pinnedGeometry(id)).toEqual({ left, width });
      if (width === undefined) {
        // A flexible column has no declared width to agree with, and asking
        // for one is the mistake this file exists to make loud.
        expect(FLEXIBLE_COLUMNS.has(id)).toBe(true);
        expect(() => widthFor(id)).toThrow(UnknownColumnError);
        continue;
      }
      expect(width).toBe(widthFor(id));
      left += width;
    }
  });

  it('has a width for every fixed column the table renders', () => {
    for (const id of [
      'drag',
      'number',
      'depends',
      'team',
      'final-total',
      'not-before',
      'start',
      'finish',
      'float',
      'actions',
    ]) {
      expect(widthFor(id)).toBeGreaterThan(0);
    }
    // A role's columns are named for a role that only exists at runtime, so
    // they are sized by suffix. One per literal in `POINTS`.
    expect(widthFor('r1-final')).toBeGreaterThan(0);
    expect(widthFor('r1-optimistic')).toBeGreaterThan(0);
    expect(widthFor('r1-realistic')).toBeGreaterThan(0);
    expect(widthFor('r1-pessimistic')).toBeGreaterThan(0);
    expect(widthFor('r1-assignee')).toBeGreaterThan(0);
  });

  it('sizes the actions column for one ⋯ button rather than two labelled ones', () => {
    // 110px was Duplicate and Delete side by side. They are one menu now, and
    // the menu hangs off this cell rather than living in it — so the column is
    // the button's own width, and the 70px it gives back is the first of the
    // ~500 this table has to lose to stop scrolling sideways at 1280.
    // Proof: written against the old 110 and watched failing on `expected 110
    // to be 40`. 2026-08-08.
    expect(widthFor('actions')).toBe(40);
  });

  it('has no width for a Notes column, because there is no Notes column', () => {
    // The notes are typed under the name, in the Name cell. A width left
    // behind here would be 260px of table nothing renders — and, worse, a
    // colgroup that still had a `<col>` for it would shift every pinned offset
    // after it. The throw is what makes leaving one behind impossible rather
    // than merely untidy.
    // Proof: `['notes', 260]` put back in `COLUMN_WIDTHS`, this failed on
    // `expected [Function] to throw an error`. Watched, 2026-08-08.
    expect(() => widthFor('notes')).toThrow(UnknownColumnError);
  });

  it('treats an id it never renders as an error, not a plausible width', () => {
    // A default here is the bug all over again: a column nobody sized would be
    // laid out at one width and offset from another, silently.
    // Proof: the throw replaced with `return 120`, this failed on `expected
    // function to throw an error, but it didn't`. Watched, 2026-08-07.
    expect(() => widthFor('serviec')).toThrow(UnknownColumnError);
    // A typo that happens to carry a dash must not fall through the role
    // suffixes into a width either.
    expect(() => widthFor('role-dev-realsitic')).toThrow(UnknownColumnError);
  });

  it('leaves the Name column to the layout, and asks nobody for its width', () => {
    // The one column that is a sentence rather than a figure takes whatever
    // the others leave; a declared width on it is the thing that made this
    // table 500px wider than a laptop.
    // Proof: `['name', 360]` put back in `COLUMN_WIDTHS` and `name` taken out
    // of `FLEXIBLE_COLUMNS`, this failed on `expected false to be true`.
    // Watched, 2026-08-08.
    expect(FLEXIBLE_COLUMNS.has('name')).toBe(true);
    expect(() => widthFor('name')).toThrow(UnknownColumnError);
    // And the floor it may not shrink past is on the cell as well as in the
    // table's minimum.
    expect(flexibleCellStyle('name')).toEqual({ minWidth: FLEXIBLE_FLOOR });
    expect(flexibleCellStyle('depends')).toBeUndefined();
  });

  it('compacts every fixed column to the figure it actually holds', () => {
    // The v1.1 compaction, pinned as literals because the equation below is
    // only true while these are. Each one is a number of days, a date, a
    // handle or a glyph — nothing here holds a sentence.
    // Proof: run against the pre-compaction widths, this failed on
    // `expected { drag: 28, number: 168, …(8) } to deeply equal
    // { drag: 24, number: 100, …(8) }`. Watched, 2026-08-08.
    expect(
      Object.fromEntries(
        [
          'drag',
          'number',
          'depends',
          'team',
          'final-total',
          'not-before',
          'start',
          'finish',
          'float',
          'actions',
        ].map((id) => [id, widthFor(id)]),
      ),
    ).toEqual({
      drag: 24,
      number: 100,
      depends: 110,
      team: 120,
      'final-total': 52,
      'not-before': 146,
      start: 52,
      finish: 52,
      float: 56,
      actions: 40,
    });
    // A folded role holds `4.8 · Kat` — the figure and who is doing it — which
    // is why it is the one column that grew.
    expect(widthFor('r1-final')).toBe(96);
    expect(widthFor('r1-realistic')).toBe(52);
    expect(widthFor('r1-assignee')).toBe(120);
  });

  it('adds a table up from its columns, budgeting the floor for the flexible one', () => {
    // The honest width equation, which is the whole of this change: the table
    // is `width: 100%` with this as its minimum, so above it nothing scrolls
    // sideways and below it the pinned columns take over.
    // Proof, both halves: the `FLEXIBLE_COLUMNS` branch replaced by
    // `widthFor(id)`, this failed on `UnknownColumnError: No declared width
    // for column "name"`; replaced by `0`, on `expected +0 to be 200`.
    // Watched, 2026-08-08.
    expect(tableMinWidth(['drag', 'number'])).toBe(widthFor('drag') + widthFor('number'));
    expect(tableMinWidth(['name'])).toBe(FLEXIBLE_FLOOR);

    const fixed = [
      'drag',
      'number',
      'name',
      'depends',
      'team',
      'final-total',
      'not-before',
      'start',
      'finish',
      'float',
      'actions',
    ];
    // 752px of fixed columns plus Name's 200px floor. The three states the
    // browser gate measures, computed here so a width change that breaks one
    // of them fails in the repo gate rather than only in a browser:
    // two roles folded fits a 1280 laptop, three folded still does, and one
    // role unfolded does not — which is why unfolding is an accordion.
    expect(tableMinWidth([...fixed, 'r1-final', 'r2-final'])).toBe(1144);
    expect(tableMinWidth([...fixed, 'r1-final', 'r2-final', 'r3-final'])).toBe(1240);
    expect(
      tableMinWidth([
        ...fixed,
        'r1-final',
        'r1-optimistic',
        'r1-realistic',
        'r1-pessimistic',
        'r1-assignee',
        'r2-final',
      ]),
    ).toBe(1420);
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

describe('the pinned columns', () => {
  it('starts at the left edge and stacks each column after the last', () => {
    // The offsets are the whole of why this is a module rather than three
    // numbers in the markup: a pinned column lands beside the one in front of
    // it only if it is offset by exactly that column's width.
    expect(pinnedGeometry('drag')).toEqual({ left: 0, width: 24 });
    expect(pinnedGeometry('number')).toEqual({ left: 24, width: 100 });
    // Name is pinned at the sum of the two fixed columns in front of it and
    // has no width of its own — the `<colgroup>` decides that, and the browser
    // gate measures this offset at a viewport too narrow to hold the table.
    expect(pinnedGeometry('name')).toEqual({ left: 124, width: undefined });
  });

  it('leaves every other column alone', () => {
    // "Depends on" is the one this matters for: it used to sit between Number
    // and Name and now sits after them, unpinned, and it must scroll away
    // like any other column.
    expect(pinnedGeometry('depends')).toBeUndefined();
    expect(pinnedCellStyle('depends', 'body')).toBeUndefined();
    expect(pinnedCellStyle('float', 'header')).toBeUndefined();
  });

  it('runs contiguously from the edge, with no gap between the three', () => {
    // A gap would leave the column after it hanging over whatever scrolled
    // through the hole. Asserted as a property of the list, so adding a fourth
    // pinned column cannot quietly introduce one.
    const rolling = PINNED_COLUMNS.map((column) => pinnedGeometry(column.id));
    expect(rolling[0]?.left).toBe(0);
    for (const [at, column] of rolling.entries()) {
      if (at === 0) continue;
      const before = rolling[at - 1];
      expect(column?.left).toBe((before?.left ?? -1) + (before?.width ?? -1));
    }
    // And only the last of them may be flexible, because every offset after
    // one would be a sum with a number nobody declared in it.
    // Proof: `PINNED_COLUMNS` reordered to `['name', 'number', 'drag']`, the
    // module threw while loading and the whole file reported `Tests no tests`
    // — `name has no declared width, so number cannot be pinned after it`.
    // Watched, 2026-08-08.
    expect(PINNED_COLUMNS.slice(0, -1).map((column) => column.width)).not.toContain(undefined);
  });

  it('gives a pinned cell an opaque background and a layer to paint in', () => {
    // Transparent, a pinned cell shows the row scrolling behind it straight
    // through itself.
    const body = pinnedCellStyle('number', 'body');
    expect(body?.position).toBe('sticky');
    // The offset the geometry works out, on the cell that carries it.
    expect(body?.left).toBe(24);
    expect(body?.width).toBe(100);
    const name = pinnedCellStyle('name', 'body');
    expect(name?.left).toBe(124);
    // Pinned, and with no width of its own: the `<colgroup>` is the only thing
    // that sizes a flexible column, and a `width` here would be the second
    // opinion that the whole width table exists to prevent.
    // Proof: `pinnedCellStyle` made to declare `width: pinned.width ?? 360`
    // again, this failed on `expected 360 to be undefined`. Watched,
    // 2026-08-08.
    expect(name?.width).toBeUndefined();
    expect(name?.position).toBe('sticky');
    expect(body?.background).toBe('#fff');
    expect(body?.boxSizing).toBe('border-box');
    expect(body?.zIndex).toBe(1);

    // A pinned header cell is sticky on both axes and crosses everything else,
    // so it is on top of both the header row and the pinned body cells.
    const header = pinnedCellStyle('number', 'header');
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

describe('the indent in the Number column', () => {
  it('steps one level at a time while the tree is shallow', () => {
    expect(indentFor(0)).toBe(0);
    expect(indentFor(1)).toBe(12);
    expect(indentFor(3)).toBe(36);
  });

  it('stops growing, so the Number column cannot outgrow its declared width', () => {
    // The cap is what keeps Name, pinned at the sum of the widths in front of
    // it, from being painted over the number it is meant to sit beside.
    expect(indentFor(DEEPEST_INDENT)).toBe(indentFor(DEEPEST_INDENT + 1));
    expect(indentFor(40)).toBe(indentFor(DEEPEST_INDENT));
    // And the number keeps the larger half of its own column: the step went to
    // 12px in the same change that took the column from 168 to 100, and a step
    // left at 16 would spend 64 of those 100 on white space.
    // Proof: `INDENT_STEP` put back to 16, this failed on `expected 64 to be
    // less than 50`. Watched, 2026-08-08.
    expect(indentFor(DEEPEST_INDENT)).toBeLessThan(widthFor('number') / 2);
  });
});

describe('the frame the table scrolls inside', () => {
  it('scrolls on both axes and is bounded, or the sticky heading means nothing', () => {
    // `overflow-x: auto` forces the other axis to compute to `auto` anyway, so
    // this element is the scrollport either way — and a scrollport as tall as
    // its own content never scrolls, which would leave `top: 0` sticking to
    // nothing while the page carried the whole frame away.
    expect(TABLE_FRAME.overflow).toBe('auto');
    expect(TABLE_FRAME.maxHeight).toBeDefined();
  });

  it('leaves room under the last row for a picker to open into', () => {
    // The dep and assignee lists are absolutely positioned at `top: 100%` and
    // 200px tall, and a scroll container clips to its padding box.
    expect(TABLE_FRAME.paddingBottom).toBe('13rem');
  });
});
