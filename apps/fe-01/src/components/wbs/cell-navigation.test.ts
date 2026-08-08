import { describe, expect, it } from 'vitest';

import {
  type Caret,
  type CellRef,
  commandMove,
  type KeyModifiers,
  nextCell,
} from './cell-navigation';

const COLUMNS = ['name', 'dev-optimistic', 'dev-realistic', 'notes'];

/** Every editable cell of these rows, in document order, row by row. */
const gridOf = (rowIds: readonly string[], columns: readonly string[] = COLUMNS): CellRef[] =>
  rowIds.flatMap((rowId) => columns.map((columnId) => ({ rowId, columnId })));

const ROWS = ['strip', 'sockets', 'sand'];
const GRID = gridOf(ROWS);

const at = (rowId: string, columnId: string): CellRef => ({ rowId, columnId });
const FREE: Caret = { atStart: true, atEnd: true, hasSelection: false, multiline: false };
const MIDDLE: Caret = { atStart: false, atEnd: false, hasSelection: false, multiline: false };
const PLAIN: KeyModifiers = {
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

const move = (
  from: CellRef,
  key: string,
  caret: Caret = FREE,
  modifiers: KeyModifiers = PLAIN,
  cells: readonly CellRef[] = GRID,
) => nextCell(cells, from, key, caret, modifiers);

describe('nextCell — up and down', () => {
  it('moves down a column, in the order the rows are shown', () => {
    expect(move(at('strip', 'dev-optimistic'), 'ArrowDown')?.to).toEqual(
      at('sockets', 'dev-optimistic'),
    );
  });

  it('moves up a column', () => {
    expect(move(at('sand', 'notes'), 'ArrowUp')?.to).toEqual(at('sockets', 'notes'));
  });

  it('stays put past the last row', () => {
    expect(move(at('sand', 'name'), 'ArrowDown')).toBeNull();
  });

  it('stays put above the first row', () => {
    expect(move(at('strip', 'name'), 'ArrowUp')).toBeNull();
  });

  it('moves rows whatever the caret is doing in a single-line box', () => {
    // An estimate box and the date are one line, where Up and Down do nothing
    // at all — which is what makes filling a column down forty rows possible.
    expect(move(at('strip', 'name'), 'ArrowDown', MIDDLE)?.to).toEqual(at('sockets', 'name'));
    expect(move(at('sockets', 'name'), 'ArrowUp', MIDDLE)?.to).toEqual(at('strip', 'name'));
  });

  it('follows the cells it was given, which exclude a collapsed branch', () => {
    // `sockets` is a child of `strip`; collapsed, it is not on screen, and Down
    // has to land on the next row a person can actually see.
    const visible = gridOf(['strip', 'sand']);

    expect(move(at('strip', 'name'), 'ArrowDown', FREE, PLAIN, visible)?.to).toEqual(
      at('sand', 'name'),
    );
  });

  it('skips a row whose cell in that column is not editable', () => {
    // A parent's estimates are sums of what is below it and are read-only, so
    // they are not in the list. Stopping there would be a keypress that does
    // nothing, every time a branch has children.
    const ragged = [
      ...COLUMNS.map((columnId) => ({ rowId: 'leaf-a', columnId })),
      { rowId: 'parent', columnId: 'name' },
      { rowId: 'parent', columnId: 'notes' },
      ...COLUMNS.map((columnId) => ({ rowId: 'leaf-b', columnId })),
    ];

    expect(move(at('leaf-a', 'dev-optimistic'), 'ArrowDown', FREE, PLAIN, ragged)?.to).toEqual(
      at('leaf-b', 'dev-optimistic'),
    );
    // The columns that row does have are still reachable.
    expect(move(at('leaf-a', 'name'), 'ArrowDown', FREE, PLAIN, ragged)?.to).toEqual(
      at('parent', 'name'),
    );
  });
});

describe('nextCell — up and down in a box that holds more than one line', () => {
  /** A caret somewhere in the middle of a Name cell holding a name and notes. */
  const INSIDE: Caret = { atStart: false, atEnd: false, hasSelection: false, multiline: true };
  const TOP: Caret = { ...INSIDE, atStart: true };
  const BOTTOM: Caret = { ...INSIDE, atEnd: true };

  it('leaves the key alone anywhere but the very start', () => {
    // The Name cell holds the notes now, so Up is the key that walks up
    // through them. Taking it would make the second line of a note
    // unreachable from the keyboard — and the browser's own Up is what walks
    // a *wrapped* line, which nothing here can measure.
    expect(move(at('sockets', 'name'), 'ArrowUp', INSIDE)).toBeNull();
    expect(move(at('sockets', 'name'), 'ArrowUp', BOTTOM)).toBeNull();
  });

  it('leaves the cell from the very start', () => {
    // One press of Up walks the caret to 0, the next one leaves. No visual-line
    // measurement, and the same answer in jsdom as in a browser.
    expect(move(at('sockets', 'name'), 'ArrowUp', TOP)?.to).toEqual(at('strip', 'name'));
  });

  it('leaves the key alone anywhere but the very end', () => {
    expect(move(at('sockets', 'name'), 'ArrowDown', INSIDE)).toBeNull();
    expect(move(at('sockets', 'name'), 'ArrowDown', TOP)).toBeNull();
  });

  it('leaves the cell from the very end', () => {
    expect(move(at('sockets', 'name'), 'ArrowDown', BOTTOM)?.to).toEqual(at('sand', 'name'));
  });

  it('leaves the key alone when something is selected, at either end', () => {
    // Shift+Up in a note is extending a selection upwards, exactly as
    // Shift+Left is along a line — and a selection that reaches the start
    // reads `atStart` without anybody having asked to leave.
    const selecting: Caret = { ...TOP, atEnd: true, hasSelection: true };

    expect(move(at('sockets', 'name'), 'ArrowUp', selecting)).toBeNull();
    expect(move(at('sockets', 'name'), 'ArrowDown', selecting)).toBeNull();
  });

  it('does not change what left and right do', () => {
    // The horizontal rule was already the caret's: it needs no help from this
    // one, and applying the vertical gate to it would stop Right at the end of
    // the first line.
    expect(move(at('sockets', 'name'), 'ArrowRight', BOTTOM)?.to).toEqual(
      at('sockets', 'dev-optimistic'),
    );
    expect(move(at('sockets', 'name'), 'ArrowRight', INSIDE)).toBeNull();
  });
});

describe('nextCell — left and right', () => {
  it('moves to the next column when the caret is at the end', () => {
    expect(move(at('strip', 'name'), 'ArrowRight', { ...MIDDLE, atEnd: true })?.to).toEqual(
      at('strip', 'dev-optimistic'),
    );
  });

  it('moves to the previous column when the caret is at the start', () => {
    expect(
      move(at('strip', 'dev-realistic'), 'ArrowLeft', { ...MIDDLE, atStart: true })?.to,
    ).toEqual(at('strip', 'dev-optimistic'));
  });

  it('puts the caret on the edge the travel came from', () => {
    // Selecting the arriving value instead made every second press a no-op: a
    // full selection reads as `hasSelection`, so moving right across populated
    // cells took two presses each. Found in review.
    expect(move(at('strip', 'name'), 'ArrowRight', { ...MIDDLE, atEnd: true })?.caretAt).toBe(
      'start',
    );
    expect(move(at('strip', 'notes'), 'ArrowLeft', { ...MIDDLE, atStart: true })?.caretAt).toBe(
      'end',
    );
  });

  it('leaves the key alone when the caret has somewhere to go', () => {
    expect(move(at('strip', 'name'), 'ArrowRight', MIDDLE)).toBeNull();
    expect(move(at('strip', 'notes'), 'ArrowLeft', MIDDLE)).toBeNull();
  });

  it('leaves the key alone when something is selected', () => {
    // Shift+Right is extending a selection, not asking to leave the cell.
    const selecting: Caret = { atStart: true, atEnd: true, hasSelection: true };

    expect(move(at('strip', 'name'), 'ArrowRight', selecting)).toBeNull();
    expect(move(at('strip', 'notes'), 'ArrowLeft', selecting)).toBeNull();
  });

  it('does not wrap to another row', () => {
    expect(move(at('strip', 'notes'), 'ArrowRight')).toBeNull();
    expect(move(at('strip', 'name'), 'ArrowLeft')).toBeNull();
  });
});

describe('nextCell — keys that are not ours', () => {
  it('leaves an IME composition alone', () => {
    // Up and Down pick a candidate during composition. Taking them moves the
    // focus out of a half-written word and commits it.
    const composing: KeyModifiers = { ...PLAIN, isComposing: true };

    expect(move(at('strip', 'name'), 'ArrowDown', FREE, composing)).toBeNull();
    expect(move(at('strip', 'name'), 'ArrowRight', FREE, composing)).toBeNull();
  });

  it('leaves a modified arrow alone', () => {
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(
        move(at('strip', 'name'), 'ArrowDown', FREE, { ...PLAIN, [modifier]: true }),
      ).toBeNull();
    }
  });

  it('ignores keys that are not arrows', () => {
    for (const key of ['Enter', 'Tab', 'a', 'Home', 'End', 'PageDown']) {
      expect(move(at('strip', 'name'), key)).toBeNull();
    }
  });

  it('leaves the key alone for a cell the grid no longer holds', () => {
    // A row deleted by someone else between the render and the keypress. The
    // browser keeps the key; nothing is guessed at.
    expect(move(at('ghost', 'name'), 'ArrowDown')).toBeNull();
    expect(move(at('strip', 'ghost'), 'ArrowDown')).toBeNull();
  });
});

describe('commandMove — the four chords, which the caret has no say in', () => {
  /** A caret in the middle of a multiline box: everything an arrow is stopped by. */
  const STUCK: Caret = { atStart: false, atEnd: false, hasSelection: true, multiline: true };

  it('walks the grid the way the arrows do', () => {
    expect(commandMove(GRID, at('strip', 'dev-optimistic'), 'down')?.to).toEqual(
      at('sockets', 'dev-optimistic'),
    );
    expect(commandMove(GRID, at('sand', 'notes'), 'up')?.to).toEqual(at('sockets', 'notes'));
    expect(commandMove(GRID, at('strip', 'name'), 'right')?.to).toEqual(
      at('strip', 'dev-optimistic'),
    );
    expect(commandMove(GRID, at('strip', 'dev-optimistic'), 'left')?.to).toEqual(
      at('strip', 'name'),
    );
  });

  it('moves from a caret no arrow could leave, which is the whole of the chord', () => {
    // Mid-word, mid-note, over a selection: an arrow belongs to the text in
    // every one of those and the chord belongs to the grid in all of them.
    // Proof: the caret handed to `nextCell` narrowed to what the cell really
    // holds — `STUCK` passed straight through — and this failed on all four
    // directions at once. Watched, 2026-08-08.
    for (const direction of ['left', 'down', 'up', 'right'] as const) {
      expect(commandMove(GRID, at('sockets', 'dev-realistic'), direction)).not.toBeNull();
    }
    // And the same caret through the arrows, which is what it is being
    // contrasted with: the text keeps every one of them.
    expect(move(at('sockets', 'dev-realistic'), 'ArrowLeft', STUCK)).toBeNull();
    expect(move(at('sockets', 'name'), 'ArrowUp', STUCK)).toBeNull();
  });

  it('keeps the arrows’ skip rules, so a ragged row is stepped over', () => {
    // A parent's rolled-up figures are read-only and so are not in the grid at
    // all: moving down a column looks for the next row that actually has it.
    const ragged = [
      ...gridOf(['strip'], COLUMNS),
      ...gridOf(['parent'], ['name']),
      ...gridOf(['sand'], COLUMNS),
    ];

    expect(commandMove(ragged, at('strip', 'dev-realistic'), 'down')?.to).toEqual(
      at('sand', 'dev-realistic'),
    );
  });

  it('stops at the grid’s edges rather than wrapping round', () => {
    expect(commandMove(GRID, at('strip', 'name'), 'up')).toBeNull();
    expect(commandMove(GRID, at('sand', 'notes'), 'down')).toBeNull();
    expect(commandMove(GRID, at('strip', 'name'), 'left')).toBeNull();
    expect(commandMove(GRID, at('sand', 'notes'), 'right')).toBeNull();
  });

  it('leaves the key alone for a cell the grid no longer holds', () => {
    expect(commandMove(GRID, at('ghost', 'name'), 'down')).toBeNull();
  });
});
