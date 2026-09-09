import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

import { DAY_PX } from './gantt-panel';
import type * as TableFrameModule from './table-frame';
import {
  DATE_EDITOR_WIDTH,
  DEEPEST_INDENT,
  FLEXIBLE_CAP,
  FLEXIBLE_FLOOR,
  frameLayout,
  type FrameLayoutState,
} from './table-frame';
import { widthFromDrag } from './use-plan-layout';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

/** The two elements a table cell can be, since a wrapping cell is a textarea. */
const isCell = (node: unknown): node is HTMLInputElement | HTMLTextAreaElement =>
  node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

/**
 * How many `<td>`/`<th>` renders the table has performed, counted through
 * {@link flexibleCellStyle} — every body cell and heading computes its flexible
 * width exactly once per render (wbs-table.tsx's `<td>`/`<th>` style spreads),
 * so the count divided by the column count is "how many rows rendered".
 *
 * The pointed-row probes read this to assert render isolation: pointing a row
 * must re-render the rows whose light changed and nothing else. jsdom can see
 * nothing else that distinguishes "memo held" from "memo silently vacuous" —
 * React reuses the DOM nodes either way.
 *
 * The mock is call-through: every other test sees the real module unchanged.
 */
const cellStyleCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./table-frame', async (importOriginal) => {
  const real = await importOriginal<typeof TableFrameModule>();
  return {
    ...real,
    flexibleCellStyle: (...args: Parameters<typeof real.flexibleCellStyle>) => {
      cellStyleCalls.count += 1;
      return real.flexibleCellStyle(...args);
    },
  };
});

/**
 * A plan where no row sets an earliest start, which is what every plan built
 * by these helpers is unless it says otherwise.
 */
const UNDATED: FrameLayoutState = { hasAnyNotBefore: false };

/** And one where somebody has, which is 28px wider. */
const DATED: FrameLayoutState = { hasAnyNotBefore: true };

const numbersOnScreen = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-number]')?.textContent ?? '');

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

/** Opens one row's ⋯ menu, the way a pointer does. */
const openRowMenu = (number: string) => {
  click(`Actions for ${number}`);
};

const typeName = (number: string, value: string) => {
  fireEvent.change(screen.getByLabelText(`Name of ${number}`), { target: { value } });
};

/**
 * Ctrl+N in a named row's Name cell: a new work item below it.
 *
 * Keys are fired at a named row rather than at `document.activeElement`.
 * Focus is a real behaviour and gets its own assertion, but using it to steer
 * these tests would make every one of them fail for the same reason if focus
 * broke — and none of them would say which behaviour was actually wrong.
 *
 * This was `pressEnter` until `command-keys`. Enter in a name is now the
 * browser's own newline — a work item's notes are written under its name in
 * that box — and the tests that only ever used Enter as scaffolding to *get* a
 * second row moved to the chord that makes one. What Enter does instead has
 * its own tests in `the command chords`.
 */
const pressNewItem = (number: string) => {
  fireEvent.keyDown(screen.getByLabelText(`Name of ${number}`), {
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
  });
};

/**
 * Opens a step's folded columns — the trio and the assignee. Folded is the
 * default, so every test that types an estimate or assigns someone does this
 * first, exactly as a person would.
 */
const unfoldStep = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Unfold ${name} estimates` }));
};

const pressTab = (number: string, shiftKey = false) => {
  fireEvent.keyDown(screen.getByLabelText(`Name of ${number}`), { key: 'Tab', shiftKey });
};

// The table remembers each project's open branches in localStorage, so one
// test's collapsing would arrive as the next test's starting shape.
beforeEach(() => {
  localStorage.clear();
});

/**
 * Every column on screen, for a describe whose tests read the Teams or
 * Services cells: both are hidden by default since `configurable-columns`, and
 * those tests are about the cells, not about the default column set. Stored as
 * the reader would have stored it — an empty hide-list — under both project ids
 * the file renders. The tests that ARE about the default never call this.
 */
const showEveryColumn = (): void => {
  for (const projectId of ['p1', 'p2']) {
    localStorage.setItem(`wbs.hiddenColumns.${projectId}`, '[]');
  }
};

const typeIntoDate = (label: string, day: string): void => {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: day } });
  fireEvent.blur(box);
};

/**
 * Opens one row's earliest-start editor, the way a reader does.
 *
 * The cell is text at rest since `T2 compact-columns` — the editor is mounted
 * for the cell being edited and for no other — so every date typed into a row
 * has to be typed into an editor that was opened first. Enter is the keyboard's
 * way in; a click is the pointer's.
 */
const openNotBefore = (number: string): HTMLInputElement => {
  const cell = screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
  fireEvent.keyDown(cell, { key: 'Enter' });
  return screen.getByLabelText<HTMLInputElement>(`Earliest start for ${number}`);
};

/** The `<tr>` whose number cell reads `number`. */
const rowFor = (number: string): HTMLElement => {
  const found = screen
    .getAllByRole('row')
    .find((tr) => tr.querySelector('[data-number]')?.textContent === number);
  if (found === undefined) throw new Error(`no row numbered ${number}`);
  return found;
};

/** Three named root rows: `010 Strip`, `020 Sand`, `030 Paint`. */
async function threeRoots() {
  // Dev's columns take part in the keyboard grid below, so they are open.
  // These layout mechanics deliberately exercise the refs-shown geometry while
  // retaining the original hidden Teams/Services/Types baseline.
  for (const projectId of ['p1', 'p2']) {
    const key = `wbs.hiddenColumns.${projectId}`;
    if (localStorage.getItem(key) === null) {
      // `deadline` with them since `work-item-deadline` 9.1: it ships hidden
      // for the same reason `type` does, and a baseline that showed it would
      // put 84px into every width figure below.
      localStorage.setItem(key, JSON.stringify(['team', 'service', 'type', 'deadline']));
    }
  }

  const api = fakeApi();
  render(<WbsTable projectId="p1" api={api} />);
  // Named, not left blank. Blank names made an ordering assertion compare three
  // empty strings against three empty strings, which passes for any order.
  for (const [number, name] of [
    ['010', 'Strip'],
    ['020', 'Sand'],
    ['030', 'Paint'],
  ]) {
    click('Add work item');
    await screen.findByLabelText(`Name of ${number}`);
    typeName(number, name);
    fireEvent.blur(screen.getByLabelText(`Name of ${number}`));
    await waitFor(() => {
      expect(screen.getByLabelText(`Name of ${number}`)).toHaveProperty('value', name);
    });
    if (number === '010') {
      api.linkTo(api.rows[0]?.id ?? '', [
        { systemId: 'github', url: 'https://example.test/layout' },
      ]);
    }
  }
  unfoldStep('Dev');
  return api;
}

describe('the frame the table scrolls inside', () => {
  /**
   * jsdom lays nothing out, so nothing here can watch a column actually stay
   * put. What it can watch is every rule that makes it stay put arriving on
   * the element it has to be on — which is where all three of these went
   * wrong while this was being written. Whether the result reads well at 1280
   * pixels is Dany's screen's to say; `verify.md` says so out loud.
   */
  itDom('scrolls the table rather than the page', async () => {
    await threeRoots();

    const frame = screen.getByRole('table').parentElement;

    expect(frame?.dataset['tableFrame']).toBeDefined();
    // Both axes: `overflow-x: auto` forces the other one to compute to `auto`
    // regardless, and the bound on the height is what makes this box the
    // scrollport the heading below sticks to.
    expect(frame?.style.overflow).toBe('auto');
    // That bound was `max-height: calc(100vh - 16rem)` until `H
    // header-fits-a-row`; it is now `flex-shrink: 1` inside a column that is
    // one window tall, so a plan past the remainder is shrunk to it rather than
    // measured against an estimate of the chrome. Same claim — this box is
    // bounded and therefore scrolls — read off the property that now carries
    // it. Since `unified-scroll-docking` it does not grow past its own rows
    // either. What a browser makes of both is `e2e/header.spec.ts`'s and
    // `e2e/plan-surface.spec.ts`'s; jsdom lays nothing out.
    expect(frame?.style.flex).toBe('0 1 auto');
    // And the flex basis is the only opinion about it: a `max-height` back
    // beside it would be the estimate again, disagreeing with the layout the
    // first time the header changed.
    expect(frame?.style.maxHeight).toBe('');
  });

  itDom('keeps the column headings against the top of the frame', async () => {
    await threeRoots();

    const headers = screen.getAllByRole('columnheader');

    expect(headers.length).toBeGreaterThan(6);
    for (const header of headers) {
      expect(header.style.position).toBe('sticky');
      expect(header.style.top).toBe('0px');
      // Transparent, the heading would have rows sliding through it.
      expect(header.style.background).not.toBe('');
    }
  });

  itDom('pins the handle, the number and the name, and nothing past them', async () => {
    await threeRoots();

    const cells = [...rowFor('020').querySelectorAll('td')];

    // Each offset is the sum of the widths in front of it — 24, then 24+105,
    // then 129+40 since `external-refs` put the ref column between `#` and
    // Name. Four pinned columns now, and the fourth is pinned because it had to
    // be: an unpinned column between two pinned ones scrolls under the second.
    expect(cells.slice(0, 4).map((td) => [td.style.position, td.style.left])).toEqual([
      ['sticky', '0px'],
      ['sticky', '24px'],
      ['sticky', '129px'],
      ['sticky', '169px'],
    ]);
    // Pinned and still flexible: the pin places the Name cell and the colgroup
    // sizes it, and a `width` here would be the second opinion that put a
    // pinned Name over "Depends on" in the first place.
    // Proof: `pinnedCellStyle` made to declare `width: pinned.width ?? 360`
    // again, this failed on `expected '360px' to be ''`. Watched, 2026-08-08.
    expect(cells[3]?.style.width).toBe('');
    expect(cells[1]?.style.width).toBe('105px');
    expect(cells[2]?.style.width).toBe('40px');
    // And the floor that keeps it readable while the frame is scrolling.
    expect(cells[3]?.style.minWidth).toBe('200px');
    // Opaque, or the row scrolling behind a pinned cell shows through it.
    for (const pinned of cells.slice(0, 4)) expect(pinned.style.background).not.toBe('');
    // "Depends on" is the fifth column now, and it scrolls away like the rest.
    expect(cells[4]?.style.position).toBe('');
  });

  itDom('pins the same three columns in the heading, over everything else', async () => {
    await threeRoots();

    const headers = screen.getAllByRole('columnheader');

    // Sticky on both axes at once: scrolled right *and* down, the Number
    // heading is the one cell that has to stay in its corner.
    expect(headers[1]?.style.left).toBe('24px');
    expect(headers[1]?.style.top).toBe('0px');
    // And it crosses both of the others, so it paints over both.
    const [pinnedBodyCell] = [...rowFor('020').querySelectorAll('td')].slice(1);
    expect(Number(headers[1]?.style.zIndex)).toBeGreaterThan(Number(headers[6]?.style.zIndex));
    expect(Number(headers[1]?.style.zIndex)).toBeGreaterThan(Number(pinnedBodyCell.style.zIndex));
  });
});

describe('the widths the table is laid out by', () => {
  /**
   * jsdom lays nothing out, so none of this can watch a column stop short of
   * its neighbour. What it can watch is the one thing that made the overlap
   * possible — more than one opinion about how wide a column is — being gone
   * from the markup: one declared width per column, the table adding up to the
   * same total, and no control inside a cell asking for a width of its own.
   */
  itDom('declares every rendered column once, in the order they are rendered', async () => {
    await threeRoots();

    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    const headerCells = screen.getAllByRole('columnheader');

    expect(cols.length).toBe(headerCells.length);
    // In order, not merely in the same number: the pinned offsets are the
    // running total of the first columns' widths, so a colgroup that declared
    // the same widths in another order would lay Name out somewhere other than
    // the 196px it is pinned at. These are the numbers the pin test asserts.
    // Proof: the colgroup rendered from a reversed id list, this failed on
    // `['110px','260px','90px']` against `['28px','168px','360px']`. Watched,
    // 2026-08-07.
    //
    // Name is the third and it declares nothing at all: it is the one column
    // that takes what the others leave, which is what makes the table fit the
    // window instead of the other way round.
    // Proof: the colgroup made to declare `360` for a flexible column, this
    // failed on `expected ['24px','93px','360px'] to deeply equal
    // ['24px','93px','']`. Watched, 2026-08-08, when this column was 169px.
    expect(cols.slice(0, 4).map((col) => col.style.width)).toEqual(['24px', '105px', '40px', '']);
    for (const [at, col] of cols.entries()) {
      expect(col.style.width === '').toBe(at === 3);
    }
  });

  itDom('names every cell with the column it belongs to, in both halves of the table', async () => {
    await threeRoots();

    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    const named = (cells: Element[]) => cells.map((cell) => cell.getAttribute('data-column'));

    // The browser layout gate measures these boxes and compares them against
    // the declared widths; a rectangle with no column name attached is a
    // failure that cannot say which column moved. Asserted here because that
    // gate needs a browser and this suite is the only thing the repo gate runs.
    // Proof: `data-column` dropped from the `td`, this failed with a row of
    // `null`s against the header's names. Watched, 2026-08-07.
    expect(named(screen.getAllByRole('columnheader'))).toEqual(
      named([...rowFor('020').querySelectorAll('td')]),
    );
    expect(named(screen.getAllByRole('columnheader')).length).toBe(cols.length);
    for (const name of named(screen.getAllByRole('columnheader'))) expect(name).not.toBe(null);
  });

  itDom('is as wide as the frame, and never narrower than its own equation', async () => {
    await threeRoots();

    const table = screen.getByRole('table');
    const columnIds = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');

    // `fixed`, or the browser sizes the columns from their content and the
    // declared widths become decoration — which is the auto layout half of the
    // overlap.
    expect(table.style.tableLayout).toBe('fixed');
    // The frame's width, and the equation as the floor under it. A declared
    // total is what this replaces: it made the window fit the table.
    // Proof: the `<table>` put back to a declared total —
    // `width: tableMinWidth(leafColumnIds)` with no `minWidth` — this failed
    // on `expected '1420px' to be '100%'`. Watched, 2026-08-08, when this read
    // a flat `100%`; `spreadsheet-geometry` put the Name cap in the same
    // declaration and the frame's 100% is still the first term of it.
    expect(table.style.width).toBe(
      `min(100%, ${String(frameLayout(columnIds, UNDATED).maxWidth)}px)`,
    );
    expect(table.style.minWidth).toBe(`${String(frameLayout(columnIds, UNDATED).minWidth)}px`);
    // Not a constant, which is the point of computing it per render: this
    // plan has Dev unfolded and QA folded, so the floor is the 855px of fixed
    // columns (827 → 839 → 879 in `number-column-widen` and then
    // `external-refs`, 879 → 855 on 2026-08-31) — nobody has dated a row, so
    // `not-before` is at its narrow 56 — plus 348 for the open step, 96 for
    // the closed one and Name's 200. Folded it would be 1247, and both open
    // 1751 — the difference is what `unfolding-may-scroll` decided to spend
    // the frame's scrollbar on.
    expect(table.style.minWidth).toBe('1499px');
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(screen.getByRole('table').style.minWidth).toBe('1247px');
  });

  itDom('says nothing in a number cell that is showing the whole number', async () => {
    // The Number column is sized to a stated envelope — eleven characters at
    // the deepest indent — because there is no longest work item number to
    // size it to. A number past that envelope is clipped rather than allowed to
    // widen a column every row in the table would then move with, so the whole
    // of it lives in the cell's `data-fact` and the card is the only way to
    // read it. `e2e/layout.spec.ts` is what watches the clipping; jsdom lays
    // nothing out.
    //
    // **A root's number is not that case**, and until `hint-press-cancels` this
    // cell carried its own number whatever the number was — a card that said
    // `020` over a cell showing `020`, on every row a cursor crossed. Dany,
    // 2026-09-01: "also remove tooltips from # cells; why it needed?"
    //
    // The other half of the rule — a number past the envelope still carries the
    // whole of it — is `gives the number cell words only when the number does
    // not fit`, which has to nest rows to make one and so lives with the tests
    // that type a breakdown.
    await threeRoots();

    expect(
      rowFor('020').querySelector('[data-number]')?.parentElement?.getAttribute('data-fact'),
    ).toBeNull();
  });

  itDom('declares exactly the widths the resolved layout holds for this state', async () => {
    // The `<colgroup>` and the table's minimum read one `frameLayout` call per
    // render, so a column that resolves differently cannot reach one of them
    // and miss the other. Asserted against the resolution rather than against
    // literals, because the literals are `table-frame.test.ts`'s job and this
    // one is about the wiring.
    // Proof: the `<colgroup>` left mapping `leafColumnIds` through a
    // `widthFor(id, { hasAnyNotBefore: true })` of its own while the table's
    // `min-width` read the layout, this failed on `expected [ '24px', …(12) ]
    // to deeply equal [ '24px', …(12) ]` with `not-before` at 84px against the
    // layout's 56px. Watched, 2026-08-09.
    await threeRoots();

    const columnIds = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const layout = frameLayout(columnIds, UNDATED);

    expect(
      [...document.querySelectorAll<HTMLElement>('colgroup col')].map((col) => col.style.width),
    ).toEqual(
      layout.columns.map((column) =>
        column.colWidth === undefined ? '' : `${String(column.colWidth)}px`,
      ),
    );
    expect(screen.getByRole('table').style.minWidth).toBe(`${String(layout.minWidth)}px`);
  });

  itDom('changes a width without rebuilding a single cell of the table', async () => {
    // The landmine this whole seam is built around (LLM_README #1): `columns`
    // may depend on `steps` and `unfoldedSteps` and nothing else. `flexRender`
    // renders every `cell` as a component *type*, so a width threaded through
    // a column definition — and the `frameState` dependency that would have to
    // come with it — gives every cell a new type and React unmounts and
    // remounts the lot, taking the focus and the half-typed value with it.
    //
    // Delivered as somebody else's edit, which is the gesture that makes the
    // claim: the width really does change — `not-before` goes 56 → 84 the
    // moment any row in the project sets a day — and the reader whose focus
    // must survive it is not the one who caused it.
    //
    // Proof: `frameState` added to the `columns` dependency array, this failed
    // on `expected <body /> to be <textarea …>` — the focus on the body and the
    // half-typed name gone. Watched, 2026-08-09.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    const before = screen.getByRole('table').style.minWidth;

    name.focus();
    fireEvent.change(name, { target: { value: 'Strip the old wir' } });

    const dated = api.rows.at(0);
    if (dated === undefined) throw new Error('the plan has no row to date');
    dated.startNoEarlierThan = '2026-08-12';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole('table').style.minWidth).not.toBe(before);
    });
    expect(screen.getByRole('table').style.minWidth).toBe(
      `${String(
        frameLayout(
          screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-column') ?? ''),
          DATED,
        ).minWidth,
      )}px`,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('gives every cell the chrome its declared width is measured with', async () => {
    await threeRoots();

    const cells = [
      ...screen.getAllByRole('columnheader'),
      ...rowFor('020').querySelectorAll<HTMLElement>('td'),
    ];

    expect(cells.length).toBeGreaterThan(12);
    for (const cell of cells) {
      // Or the padding is width the offsets never counted.
      expect(cell.style.boxSizing).toBe('border-box');
      // The backstop: whatever a cell ends up holding, it stops at the cell.
      // The body cells holding a popover are exempt — the test below is where
      // that exception is pinned, and it is restated here so this loop cannot
      // be read as "every cell clips".
      //
      // `clip` and not `hidden` since `reference-cell-popover`: a hidden box is
      // a scroll container and a clipped one is not, which is what stops a
      // browser scrolling a cell to reveal a list that opened inside it. See
      // {@link CELL}.
      const column = cell.dataset['column'] ?? '';
      const exempt =
        cell.tagName === 'TD' &&
        // `not-before` since `T2 compact-columns`: its date editor is wider
        // than the column and leaves the cell rather than sizing it.
        // `priority` since `priority-bands`: the Prio cell opens the five band
        // lines over a 48px column, which is now the narrowest clip in the table.
        // `tag` and `service` since `reference-cell-popover`: each renders a
        // `CreatablePicker`, exactly as `team` does, and their absence from
        // this set was the 2026-08-29 report — a Tags cell that scrolled
        // itself to show the list it had opened, drawing its own strip above
        // its own row.
        ([
          'depends',
          'name',
          // `refs` since `external-refs`: the ref cell's hover card is the whole
          // list of links hanging off a 40px column.
          'refs',
          'team',
          'tag',
          'service',
          'actions',
          'not-before',
          'priority',
          // `start` since `start-date-hover-card`: the sentence explaining a
          // row's day is a `HoverCard` rather than a native `title`, and a card
          // is absolutely positioned inside a 52px cell.
          'start',
        ].includes(column) ||
          column.endsWith('-assignee') ||
          // A folded step's cell opens the `@` people picker over a 96px
          // column, which is the narrowest clip in the table.
          column.endsWith('-final'));
      // `clip`, not `hidden`: a hidden box is a scroll container the browser
      // may scroll to reveal what opened inside it, and a clip box has no
      // scrollport at all. See {@link CELL}.
      expect(cell.style.overflow).toBe(exempt ? 'visible' : 'clip');
    }
  });

  itDom('lets no control in a cell assert a width of its own', async () => {
    await threeRoots();
    // With an editor open, so the one deliberate exception below is a case this
    // really walks rather than a branch nothing reaches.
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    openNotBefore('010');

    const controls = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'tbody input:not([type=checkbox]), tbody textarea',
      ),
    ];

    // The name, the dependency box, the service/team picker, the folded
    // estimate, the three points, the assignee picker, the date.
    expect(controls.length).toBeGreaterThan(6);
    for (const control of controls) {
      // The one exception, and it is the point of this change rather than a
      // hole in the rule: an open date editor is `DATE_EDITOR_WIDTH` wide in a
      // column of 84px or 56, because that is what a browser lays an
      // unconstrained `input[type=date]` out at and a column that grew to fit
      // one would move every cell under the person typing. It leaves the cell
      // through `opensAPopover`'s exemption instead. Nothing else in the table
      // may ask for a width.
      if (control.getAttribute('type') === 'date') {
        expect(control.style.width).toBe(`${String(DATE_EDITOR_WIDTH)}px`);
        continue;
      }
      // The reason box is the second half of that same editor, not a second
      // exception: absolutely positioned under the date, at the date's width
      // because a box narrower than the day it explains reads as a different
      // control. It is out of the flow, so it moves no cell and grows no
      // column — the thing the rule is actually about. In the flow it would
      // have to be `100%` like everything else.
      if (control.hasAttribute('data-not-before-reason')) {
        expect(control.style.width).toBe(`${String(DATE_EDITOR_WIDTH)}px`);
        expect(control.style.position).toBe('absolute');
        continue;
      }
      // A control that asks for `22em` is a second opinion about how wide its
      // column is, and the one the browser takes when it is the wider of the
      // two.
      expect(['100%', 'auto', '']).toContain(control.style.width);
      // `size` is the same claim in an attribute: an input sized for 14
      // characters is as wide as 14 characters of the page's font.
      expect(control.getAttribute('size')).toBeNull();
    }
  });

  itDom('does not clip the cells whose popovers open over the rows', async () => {
    // The team picker is one of those cells, and hidden by default.
    showEveryColumn();
    // The CSS rule, spelled out because the first version of this test
    // asserted its opposite and called the wrong thing a proof: an absolutely
    // positioned box escapes an `overflow: hidden` ancestor only when its
    // containing block — its nearest *positioned* ancestor — is **outside**
    // that clipper. Every popover in this table sits in a `position: relative`
    // wrapper span that is *inside* the `<td>`, so the `<td>` cuts it to the
    // cell rectangle however the wrapper is styled. The invariant is therefore
    // about the cells, not the wrappers: the cells that hold a popover do not
    // clip, and their neighbours do.
    //
    // Proof: the `opensAPopover` exception removed from the `<td>` style in
    // `wbs-table.tsx`, this failed on
    // `expected 'hidden' to be 'visible' // Object.is equality`. Watched,
    // 2026-08-07.
    await threeRoots();
    fireEvent.focus(screen.getByLabelText('Add a dependency to 020'));

    const cellOf = (columnId: string): HTMLElement => {
      const cell = rowFor('020').querySelector<HTMLElement>(`td[data-column="${columnId}"]`);
      // Thrown rather than asserted away: a missing cell would otherwise read
      // as `undefined` overflow and quietly satisfy nothing.
      if (cell === null) throw new Error(`row 020 has no ${columnId} cell`);
      return cell;
    };

    openRowMenu('020');
    const openList = screen.getByRole('listbox');
    const openMenu = screen.getByRole('menu');
    const nameBox = screen.getByLabelText('Name of 020');
    const teamBox = screen.getByLabelText('Service or team for 020');
    // The cells the popovers are really in. Without this the overflow
    // assertions below would go on passing about columns the popovers had
    // moved out of.
    expect(openList.closest('td')).toBe(cellOf('depends'));
    expect(nameBox.closest('td')).toBe(cellOf('name'));
    expect(teamBox.closest('td')).toBe(cellOf('team'));
    expect(openMenu.closest('td')).toBe(cellOf('actions'));

    expect(cellOf('depends').style.overflow).toBe('visible');
    // The Name cell, which holds the notes and the rendered preview that hangs
    // off them — the cell that used to clip is the one the popover moved into.
    // Proof: `'name'` removed from `POPOVER_COLUMNS`, this failed on
    // `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('name').style.overflow).toBe('visible');
    // The row's actions menu is the same absolutely positioned box in the same
    // kind of wrapper, in a cell 40px wide and one line high — the narrowest
    // clip in the table.
    // Proof: `'actions'` removed from `POPOVER_COLUMNS`, this failed on
    // `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('actions').style.overflow).toBe('visible');
    // The service/team box and every assignee box are `CreatablePicker`s, and
    // a picker's list is the same absolutely positioned popover in the same
    // kind of wrapper. Their columns are named `<stepId>-assignee` at runtime,
    // so they are found rather than written out.
    expect(cellOf('team').style.overflow).toBe('visible');
    const assigneeCells = [
      ...rowFor('020').querySelectorAll<HTMLElement>('td[data-column$="-assignee"]'),
    ];
    // Or an empty list would satisfy the loop below without a picker column
    // being rendered at all. One here: this plan has two steps and the second
    // is folded, and a folded step shows one estimate box and no assignee.
    expect(assigneeCells.length).toBeGreaterThan(0);
    for (const cell of assigneeCells) expect(cell.style.overflow).toBe('visible');

    // A folded step's cell: `@` opens the people picker there, over a column
    // 96px wide. `final-total` is not one of these — it ends in `total`, and
    // it still clips, which is what says the suffix match is a match and not a
    // blanket.
    // Proof: the `-final` suffix dropped from `opensAPopover`, this and
    // `gives every cell the chrome its declared width is measured with` both
    // failed on `expected 'hidden' to be 'visible'`. Watched, 2026-08-08.
    expect(cellOf('step-qa-final').style.overflow).toBe('visible');
    expect(cellOf('final-total').style.overflow).toBe('clip');

    // The other two reference cells, and their absence from `POPOVER_COLUMNS`
    // was the 2026-08-29 Tags report: all three render a `CreatablePicker`,
    // only `team` was listed, and a Tags cell's open list made its `<td>` 94px
    // of content in a 26px row — which Chromium answered by scrolling the cell
    // 22px, drawing the strip above its own row with the `+` off screen.
    // Proof: `'tag'` removed from `POPOVER_COLUMNS`, this failed on
    // `expected 'clip' to be 'visible'`; `'service'` removed, the line after
    // it failed the same way. Watched, 2026-08-29.
    expect(cellOf('tag').style.overflow).toBe('visible');
    expect(cellOf('service').style.overflow).toBe('visible');

    // Still an exception. If the backstop had simply been dropped everywhere,
    // every assertion above would pass and this one would not.
    //
    // `clip`, not `hidden` — see {@link CELL}. A clipped cell is not a scroll
    // container, so no browser can scroll it to show what opened inside it.
    expect(cellOf('float').style.overflow).toBe('clip');

    // And the wrappers are still the positioned ancestors — which is what
    // decides *where* each popover opens. `top: 100%` against a static wrapper
    // would be measured from whatever ancestor is positioned instead.
    for (const wrapper of [openList.parentElement, nameBox.parentElement]) {
      expect(wrapper?.tagName).toBe('SPAN');
      expect(wrapper?.style.position).toBe('relative');
    }
  });
});

describe('the outline past the Number cap', () => {
  /**
   * The next number a new sibling of `number` gets: its last segment stepped
   * by one. What {@link pressNewItem} makes on a nested row, spelled once.
   */
  const siblingOf = (number: string): string =>
    number.replace(/(\d+)$/, (last) => String(Number(last) + 1));

  /**
   * jsdom lays nothing out, so what is watched here is the arithmetic arriving
   * on the two elements that share it: the Number cell keeps
   * `numberIndentFor`'s capped padding, and the Name cell's wrapper carries
   * exactly the share the cap withheld — zero until the cap, one step per
   * level past it. The browser measurement that the two **add up** to a strictly
   * deeper outline at every level is `e2e/layout.spec.ts`'s deep-plan fixture.
   */
  itDom('hands the Name cell the share of the indent the Number cap withheld', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await screen.findByLabelText('Name of 020');
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    // One level per round: a sibling of the deepest row, Tab'd under it. Six
    // levels, two past `DEEPEST_INDENT` — the two the cap used to flatten.
    let deepest = '010.1';
    while (deepest.split('.').length < 7) {
      pressNewItem(deepest);
      const sibling = siblingOf(deepest);
      await screen.findByLabelText(`Name of ${sibling}`);
      pressTab(sibling);
      deepest = `${deepest}.1`;
      await screen.findByLabelText(`Name of ${deepest}`);
    }

    const indents = (number: string): { number: string; name: string } => {
      // Found through `data-number`, which every row carries, and **not**
      // through `data-fact`: since `hint-press-cancels` the number cell holds
      // words only where the column clips them, so a `span[data-fact="010"]`
      // oracle would find nothing for the shallow rows this walks.
      const numberSpan = rowFor(number).querySelector('[data-number]')?.parentElement ?? null;
      // The cell's own span, which is the `<td>`'s only child — not the
      // textarea's nearest one. Since `markdown-work-item-names` the box sits
      // inside a positioned wrapper of its own, so that the rendered reading of
      // the name can be laid over it (`cell-input.tsx`), and that wrapper
      // carries no indent.
      const nameWrapper = screen
        .getByLabelText(`Name of ${number}`)
        .closest('td')?.firstElementChild;
      if (numberSpan === null || !(nameWrapper instanceof HTMLElement)) {
        throw new Error(`no indent-carrying cells on screen for ${number}`);
      }
      return { number: numberSpan.style.paddingLeft, name: nameWrapper.style.paddingLeft };
    };

    /** `010` with `depth` levels of `.1` under it — the row built above. */
    const at = (depth: number): string => ['010', ...Array<string>(depth).fill('1')].join('.');

    // Below the cap the Number cell does all the indenting and the Name cell
    // none of it — the rendered table is unchanged there.
    //
    // Read off {@link DEEPEST_INDENT} rather than off the four pixel literals
    // this held until `table-mechanics`: they were the arithmetic of a cap of
    // 4, so moving the cap to 2 to unclip the number would have been a test
    // edit either way. Written against the cap, the relation is what is pinned
    // and the next move of the cap is free.
    const capped = `${String(DEEPEST_INDENT * 12)}px`;
    expect(indents(at(1))).toEqual({ number: '12px', name: '0px' });
    expect(indents(at(DEEPEST_INDENT))).toEqual({ number: capped, name: '0px' });
    // Past the cap the Number cell stays put and the Name cell steps: the sum
    // grows by one step at every level, which is the whole of `deep-indent`.
    for (const past of [1, 2, 3, 4]) {
      expect(indents(at(DEEPEST_INDENT + past))).toEqual({
        number: capped,
        name: `${String(12 * past)}px`,
      });
    }
  });
});

describe('the widths this browser has dragged', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.columnWidths.p1';

  /** What the `<colgroup>` declares, by the column each `<col>` belongs to. */
  const laidOut = (): Record<string, string> => {
    const ids = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const cols = [...document.querySelectorAll<HTMLElement>('colgroup col')];
    return Object.fromEntries(ids.map((id, at) => [id, cols[at]?.style.width ?? '(no col)']));
  };

  /** A remembered set of widths, as a hand-edited store would hold it. */
  const storedWidths = (widths: unknown): void => {
    localStorage.setItem(KEY, typeof widths === 'string' ? widths : JSON.stringify(widths));
  };

  /** What is under the key now, which is what a reload would read. */
  const stored = (): string | null => localStorage.getItem(KEY);

  /**
   * One row on p1, and a way to hand the table somebody else's edit.
   *
   * The peer's edit is how the `not-before` column's resolved default is made
   * to move — 56px to 84px the moment any row in the project sets a day — which
   * is the only way to ask whether an override outranks a default that changes.
   */
  async function planWithAPeer() {
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return {
      api,
      dateTheRow: async () => {
        const row = api.rows.at(0);
        if (row === undefined) throw new Error('the plan has no row to date');
        row.startNoEarlierThan = '2026-08-12';
        await act(async () => {
          notify();
          await Promise.resolve();
        });
      },
    };
  }

  itDom('offers a handle on every column, the Name column included', async () => {
    // Until `name-column-drag` this case held the opposite: the Name column
    // was the remainder-absorber and a handle on it was a gesture with
    // nothing to write. A dragged Name writes an override now — the delta
    // spec strikes the old requirement by name — so the handle set is every
    // leaf column, and Name's gesture is the one that starts from a measured
    // width rather than a resolved one.
    await threeRoots();

    const ids = screen
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('data-column') ?? '');
    const handles = [...document.querySelectorAll('thead [data-resize-handle]')].map((handle) =>
      handle.getAttribute('data-resize-handle'),
    );

    expect(handles).toEqual(ids);
    expect(handles).toContain('name');
  });

  itDom('says a mark heading’s word on the handle beside it', async () => {
    // The handle's accessible name is the heading it was rendered with, and
    // this change turned `header: 'Number'` into a node drawing `#`. A node is
    // not a string, so the handle fell through to the column id and the one
    // control that reads a heading said `Resize number` where it had said
    // `Resize Number` — the exact loss `ColumnMeta.spokenHeading` exists to
    // prevent, one call away from the `<th>` that was already told.
    await threeRoots();

    const spoken = new Map(
      [...document.querySelectorAll('thead [data-resize-handle]')].map((handle) => [
        handle.getAttribute('data-resize-handle'),
        handle.getAttribute('aria-label'),
      ]),
    );

    expect(spoken.get('number')).toBe('Resize Number');
    // The columns whose heading is already a word are unmoved by the fallback.
    expect(spoken.get('name')).toBe('Resize Name');
  });

  itDom('works a dragged width out from where the handle was grabbed', () => {
    // The gesture itself is `e2e/layout.spec.ts`'s: jsdom performs no default
    // action for a pointer event and cannot tell a working drag from a
    // half-done one. What it can hold is the arithmetic the gesture writes
    // through — the floor is the column's own where that is narrower, and the
    // ceiling is the one the stored-width check reads.
    expect(widthFromDrag('number', 93, 40, UNDATED)).toBe(133);
    expect(widthFromDrag('number', 93, -1000, UNDATED)).toBe(36);
    expect(widthFromDrag('drag', 24, -50, UNDATED)).toBe(24);
    expect(widthFromDrag('number', 93, 10_000, UNDATED)).toBe(600);
    // The Name column clamps to its own bounds: the flexible floor — the same
    // 200 the cell's `min-width` declares — up to the one shared ceiling. Its
    // `fromWidth` is the one measured number in the gesture, taken from the
    // header cell at pointerdown; jsdom measures every box at 0, so the
    // gesture itself is `e2e/layout.spec.ts`'s.
    expect(widthFromDrag('name', 200, 60, UNDATED)).toBe(260);
    expect(widthFromDrag('name', 300, -1000, UNDATED)).toBe(200);
    expect(widthFromDrag('name', 300, 10_000, UNDATED)).toBe(600);
  });

  itDom(
    'lays a remembered Name width on the table itself, and leaves its <col> silent',
    async () => {
      // The excess-width design, asserted where jsdom can see it: with a Name
      // override in force the table declares its own width as the resolved sum
      // — every column at exactly its resolved width, Name at the override,
      // the viewport keeping the slack — while the `<col>` stays unsized and
      // the Name cells carry the override only as their `min-width` floor. A
      // cell `width` against a `width: 100%` table was the design tried first,
      // and Chromium answered it by distributing the viewport's excess across
      // every sized column: Number measured 103.48 against its 93px envelope
      // (CI `pixels` run 31430669282, 2026-08-10). The distribution is a
      // browser's to prove either way: `e2e/layout.spec.ts` measures Number
      // still on its envelope with a Name override in force.
      storedWidths({ name: 300 });
      await threeRoots();

      const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
      const body = document.querySelector<HTMLElement>('tbody td[data-column="name"]');
      expect(header?.style.width).toBe('');
      expect(header?.style.minWidth).toBe('300px');
      expect(body?.style.width).toBe('');
      expect(body?.style.minWidth).toBe('300px');
      expect(laidOut()['name']).toBe('');
      // The table's own width is the declaration: the resolved sum — the 1499
      // this plan resolves at rest (1471 → 1483 → 1523 in
      // `number-column-widen` and then `external-refs`, and 1523 → 1499 on
      // 2026-08-31), less the 200 floor, plus the 300 override
      // — as its width and its minimum alike, so the frame keeps the slack
      // above it and scrolls below it.
      expect(screen.getByRole('table').style.width).toBe('1599px');
      expect(screen.getByRole('table').style.minWidth).toBe('1599px');
    },
  );

  itDom('lays the Name cap on the table itself, with nothing dragged', async () => {
    // The at-rest half of the same declaration, and the whole of how
    // `FLEXIBLE_CAP` reaches a browser: the table takes the frame until the
    // Name column would pass the cap and stops there, leaving the slack to the
    // right of the last column instead of inside the Name cells.
    //
    // `min(100%, …)` and not a `max-width` beside a `width`, so there is one
    // declaration to read; and on the table rather than on the cells, because
    // `table-layout: fixed` gives a cell no vote on its column's width.
    //
    // Proof: the `min()` in `tableWidthStyle` reverted to a flat `'100%'`,
    // this failed on `expected '100%' to be 'min(100%, 1691px)'`. Watched on
    // h2puni, 2026-08-12 (fault F2).
    await threeRoots();

    const table = screen.getByRole('table');
    const resolved = Number.parseInt(table.style.minWidth, 10);

    expect(resolved).toBeGreaterThan(0);
    // The minimum budgets Name's floor and the cap swaps in the other end of
    // the same range, so the difference between the two is exactly what the
    // Name column is allowed to grow by and nothing else.
    expect(table.style.width).toBe(
      `min(100%, ${String(resolved - FLEXIBLE_FLOOR + FLEXIBLE_CAP)}px)`,
    );
    // And the Name cells still declare a floor and no width: the cap is the
    // table's, or it is a second width authority.
    expect(document.querySelector<HTMLElement>('thead th[data-column="name"]')?.style.width).toBe(
      '',
    );
    expect(laidOut()['name']).toBe('');
  });

  itDom('drops a stored Name width outside Name’s own bounds, each end on its own', async () => {
    // The same claim rules as every other column, read against Name's own
    // range: the flexible floor up to the shared ceiling. A width below 200
    // is one no Name drag can produce — the clamp stops there — so a stored
    // one is a hand-edit, refused exactly as Number's 1e9 is.
    storedWidths({ name: 150, number: 240 });
    await threeRoots();

    const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(header?.style.width).toBe('');
    expect(header?.style.minWidth).toBe('200px');
    // The entry beside it still applies: one bad entry takes only itself.
    expect(laidOut()['number']).toBe('240px');

    cleanup();
    localStorage.clear();
    storedWidths({ name: 1e9 });
    await threeRoots();

    const above = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(above?.style.width).toBe('');
    expect(above?.style.minWidth).toBe('200px');
  });

  itDom('one reset gives Name back to the remainder with the rest', async () => {
    // Reset stays `forgetWidthOverrides`: one key forgotten, never a snapshot
    // written, and Name goes back to being the column with no width at all —
    // the table back to the frame's own 100%.
    storedWidths({ name: 300, number: 140 });
    await threeRoots();
    expect(
      document.querySelector<HTMLElement>('thead th[data-column="name"]')?.style.minWidth,
    ).toBe('300px');
    expect(screen.getByRole('table').style.width).not.toBe('100%');

    click('Reset layout');

    const header = document.querySelector<HTMLElement>('thead th[data-column="name"]');
    expect(header?.style.width).toBe('');
    expect(header?.style.minWidth).toBe('200px');
    expect(laidOut()['number']).toBe('105px');
    expect(screen.getByRole('table').style.width).toMatch(/^min\(100%, \d+px\)$/);
    expect(stored()).toBe(null);
  });

  itDom('lays a remembered width out over the one it would have resolved', async () => {
    storedWidths({ number: 240 });
    await threeRoots();

    expect(laidOut()['number']).toBe('240px');
    // And the pinned column behind it moved with it, which is the whole of why
    // the override lives in the frame layout rather than in the `<colgroup>`.
    expect([...rowFor('020').querySelectorAll('td')][2]?.style.left).toBe(`${String(24 + 240)}px`);
    // Read, not written back: nothing about opening a project changes what is
    // remembered about it.
    expect(stored()).toBe(JSON.stringify({ number: 240 }));
  });

  itDom('applies a width dragged as far right as it goes, on the reload after it', async () => {
    // The two ends of one constant. A drag clamps to `WIDEST_COLUMN` and the
    // stored-width check accepts up to `WIDEST_COLUMN`, so the width a reader
    // stops at is the width that comes back — this seeds exactly what the
    // clamp can produce rather than a number typed here.
    // Proof: the stored-width check given a ceiling of its own at 500, this
    // failed on `expected '93px' to be '600px'` — the width the drag had just
    // produced refused by the reload. Watched, 2026-08-09.
    storedWidths({ number: widthFromDrag('number', 93, 10_000, UNDATED) });
    await threeRoots();

    expect(laidOut()['number']).toBe('600px');
  });

  // localStorage is user-editable, so what comes back is a claim. A table
  // that cannot be opened until somebody clears storage by hand is a worse
  // answer than a table at its defaults, which is the posture the remembered
  // expansion beside it takes.
  // Proof: the `isWidthOverrides` guard deleted, all four go red, and they go
  // red differently — which is the point of one case per value. Watched
  // 2026-08-09 as one looping case, which only ever reached the first value,
  // and re-watched per case 2026-09-08 after the split:
  //   not json at all    TypeError: Cannot convert undefined or null to object
  //                      out of the render that mounts the table, the stored
  //                      text reaching `Object.entries` as `undefined`
  //   [93, 240]          expected '[93, 240]' to be null
  //   {"number":"wide"}  expected '' to be '105px'
  //   "a string"         expected '"a string"' to be null
  // One case per junk value rather than one case looping over four: four mounts
  // under vitest's single 5000ms default made this the first case in the suite
  // to tip on a loaded runner — measured at 2137ms against a 1224ms
  // next-slowest sibling — and a red named the case, never which junk value
  // produced it (TASK-405).
  itDom.each(['not json at all', '[93, 240]', '{"number":"wide"}', '"a string"'])(
    'drops storage that is not a set of column widths, key and all: %s',
    async (junk) => {
      storedWidths(junk);
      await threeRoots();

      expect(laidOut()['number']).toBe('105px');
      expect(stored()).toBe(null);
    },
  );

  itDom(
    'drops an entry naming a column nothing can size, and keeps the one beside it',
    async () => {
      // Proof: the `sizableColumn` check deleted, this failed on
      // `UnknownColumnError: No declared width for column "serviec"` thrown out
      // of the render — the width table asked for a floor for a column that does
      // not exist. Watched, 2026-08-09.
      storedWidths({ number: 240, serviec: 80 });
      await threeRoots();

      expect(laidOut()['number']).toBe('240px');
      expect(Object.keys(laidOut())).not.toContain('serviec');
    },
  );

  itDom('drops a width that is not a finite number, and keeps the one beside it', async () => {
    // `1e999` is JSON a browser parses to `Infinity`, which is the only
    // non-finite width storage can hold — JSON has no `NaN` — and it reaches
    // the `<colgroup>` as a `<col>` with no usable width at all and the table's
    // `min-width` as `NaN`.
    //
    // The **range** check is what refuses it, and this is the second test
    // watching that one line rather than a `Number.isFinite` of its own. That
    // line was written first and its negative watched *passing* with the line
    // deleted — `Infinity` is above every ceiling, exactly as `-Infinity` is
    // below every floor — so the line was removed rather than believed. R5;
    // `wbs-table.tsx`'s `rememberedWidthOverrides` has the note.
    //
    // Proof: the range check deleted, this failed on `expected '' to be '56px'`
    // — the `<col>` left with no width the browser would take, and the table's
    // own `min-width` reading `NaNpx` beside it. Watched, 2026-08-09.
    // Written as the text a hand-edited store holds, not as an object: an
    // `Infinity` put through `JSON.stringify` comes out as `null`, and this has
    // to be the case that survives the whole-key check and is refused per
    // entry.
    storedWidths('{"number":240,"not-before":1e999}');
    await threeRoots();

    expect(laidOut()['number']).toBe('240px');
    expect(laidOut()['not-before']).toBe('56px');
    expect(screen.getByRole('table').style.minWidth).not.toContain('NaN');
  });

  itDom(
    'drops a width outside the range a drag can produce, and keeps the one beside it',
    async () => {
      // Both ends, because a range check is two comparisons and a test that only
      // ever hands it a huge number cannot see the floor go.
      // Proof: the range check deleted, this failed on `expected '1000000000px'
      // to be '93px'` — a column a billion pixels wide laid out from a
      // hand-edited store. Watched, 2026-08-09.
      storedWidths({ number: 1e9, depends: 4, tag: 240 });
      await threeRoots();

      expect(laidOut()['number']).toBe('105px');
      expect(laidOut()['depends']).toBe('86px');
      expect(laidOut()['tag']).toBe('240px');
    },
  );

  itDom('leaves a step this project no longer holds alone', async () => {
    // Never looked at rather than dropped: expansion's deleted row ids are
    // harmless for the same reason, and a width for a column nothing renders
    // costs nothing to keep. The step coming back would find its width waiting.
    storedWidths({ 'step-gone-final': 140, number: 240 });
    await threeRoots();

    expect(laidOut()['number']).toBe('240px');
    expect(stored()).toContain('step-gone-final');
  });

  itDom('freezes a width that would otherwise move with the plan', async () => {
    // The `not-before` column is 56px until any row in the project sets a day
    // and 84px afterwards. A reader who has said how wide they want it has said
    // so about both states.
    // Proof: the precedence reversed in `widthFor`, so a plan width outranks
    // the override, this failed on `expected '56px' to be '110px'` — the
    // remembered width never reaching the column at all, and the two-state
    // default deciding it in both directions. Watched, 2026-08-09.
    storedWidths({ 'not-before': 110 });
    const { dateTheRow } = await planWithAPeer();
    expect(laidOut()['not-before']).toBe('110px');

    await dateTheRow();

    expect(laidOut()['not-before']).toBe('110px');
    // And the default really would have moved, which is what makes the
    // assertion above a freeze rather than a coincidence.
    expect(frameLayout(['not-before'], DATED).minWidth).not.toBe(
      frameLayout(['not-before'], UNDATED).minWidth,
    );
  });

  itDom(
    'resets to the width resolved now, not to the one that held when it was dragged',
    async () => {
      // The whole of what a width reset is: the key is forgotten, not overwritten
      // with a snapshot. The column's default has changed under the override
      // while it was in force, and the reset has to land on the new one.
      // Proof: the reset re-written to store the widths resolved at the moment it
      // was pressed, this failed on `expected '110px' to be '84px'` — the
      // override renamed a default rather than forgotten. Watched, 2026-08-09.
      storedWidths({ 'not-before': 110 });
      const { dateTheRow } = await planWithAPeer();
      await dateTheRow();
      expect(laidOut()['not-before']).toBe('110px');

      click('Reset layout');

      expect(laidOut()['not-before']).toBe('84px');
      expect(stored()).toBe(null);
    },
  );

  itDom('offers the reset only while there is a width to reset', async () => {
    // A control that provably does nothing reads as a broken one.
    // Proof: the `size > 0` condition removed, this failed on `expected
    // <button …(3)></button> to be null` on a project nobody had dragged a
    // column in. Watched, 2026-08-09.
    await threeRoots();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBe(null);

    cleanup();
    localStorage.clear();
    storedWidths({ number: 240 });
    await threeRoots();
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();

    click('Reset layout');
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBe(null);
  });

  itDom('changes a width without rebuilding a single cell of the table', async () => {
    // Landmine #1 again, from the other side. `columns` may depend on `steps`
    // and `unfoldedSteps` and nothing else, so the overrides live beside
    // `expanded` and never enter a column definition: `flexRender` renders each
    // `cell` as a component *type*, and a definition that changed with a width
    // would unmount and remount every cell in the table, taking the focus and
    // the half-typed value with it.
    //
    // Proof: the width overrides added to the `columns` dependency array, this
    // failed on `expected <body><div>…(1)</div></body> to be <textarea
    // …(5)></textarea>` — the caret dropped on the body by the remount, and the
    // half-typed name gone with it. Watched, 2026-08-09.
    storedWidths({ number: 240 });
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    name.focus();
    fireEvent.change(name, { target: { value: 'Strip the old wir' } });

    click('Reset layout');

    expect(laidOut()['number']).toBe('105px');
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('reads the next project’s widths rather than stamping this one’s on it', async () => {
    // This component is not remounted between projects (`project-page.tsx`
    // renders it without a `key`), so the state and the key it is written under
    // have to be swapped together — exactly as the remembered expansion beside
    // it is.
    storedWidths({ number: 240 });
    localStorage.setItem('wbs.columnWidths.p2', JSON.stringify({ number: 300 }));
    const api = fakeApi();
    const { rerender } = render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    expect(laidOut()['number']).toBe('240px');

    rerender(<WbsTable projectId="p2" api={api} />);

    await waitFor(() => {
      expect(laidOut()['number']).toBe('300px');
    });
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ number: 240 }));
  });
});

describe('the day scale this browser picked for this project', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttDayPx.p1';

  const openTheChart = async (): Promise<HTMLSelectElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const control = document.querySelector<HTMLSelectElement>('[data-gantt-day-scale]');
    if (control === null) throw new Error('no day-scale control rendered');
    return control;
  };

  itDom('opens the chart at the remembered rung, and the axis with it', async () => {
    localStorage.setItem(KEY, '4');
    const control = await openTheChart();
    expect(control.value).toBe('4');
    // The stored rung reaches the drawing and not merely the control: a scale
    // the select agrees with while the chart stays at 28 is the whole feature
    // failing quietly.
    const cell = document.querySelector<HTMLElement>('[data-axis-day="0"]');
    expect(cell?.style.width).toBe('4px');
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    localStorage.setItem(KEY, '12');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('12');
  });

  itDom('writes the rung that was picked', async () => {
    const control = await openTheChart();
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.change(control, { target: { value: '12' } });
    expect(localStorage.getItem(KEY)).toBe('12');
    expect(document.querySelector<HTMLElement>('[data-axis-day="0"]')?.style.width).toBe('12px');
  });

  itDom('refuses a width that is not one of the rungs, and drops the key', async () => {
    // Discrete and not a range, which is where this parts from the height
    // beside it: 9 is between two rungs and inside every plausible bound, and a
    // chart opened at it is one no control can return to a rung.
    localStorage.setItem(KEY, '9');
    const control = await openTheChart();
    expect(control.value).toBe(String(DAY_PX));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses storage that is not a number at all, and drops the key', async () => {
    localStorage.setItem(KEY, 'wide please');
    const control = await openTheChart();
    expect(control.value).toBe(String(DAY_PX));
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('the row names this browser left shown for this project', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttLabels.p1';

  const openTheChart = async (): Promise<HTMLButtonElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const control = document.querySelector<HTMLButtonElement>('[data-gantt-labels-toggle]');
    if (control === null) throw new Error('no names control rendered');
    return control;
  };

  itDom('opens the chart with the column collapsed where it was left that way', async () => {
    localStorage.setItem(KEY, 'false');
    const control = await openTheChart();
    expect(control.getAttribute('aria-pressed')).toBe('false');
    // The stored answer reaches the drawing and not merely the control, for the
    // rung's reason one describe up.
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(0);
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    localStorage.setItem(KEY, 'false');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('false');
  });

  itDom('writes the answer that was picked, and it is the false one', async () => {
    // `false` is the interesting write and the reason the read is a `typeof`
    // test rather than a `??`: the collapsed state is the one somebody bothers
    // to ask for, and a nullish default would eat it on every reopen.
    const control = await openTheChart();
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.click(control);
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(0);
  });

  itDom('refuses storage that is not a boolean, and drops the key', async () => {
    localStorage.setItem(KEY, '"no thanks"');
    const control = await openTheChart();
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('a collapsed column alone offers the reset, and the reset brings it back', async () => {
    // The fourth clause of the reset's condition, measured the way the height
    // half was: with nothing else touched, so the offer can only be coming from
    // this. A reset that forgot three of four would leave the chart looking
    // reset while the names stayed gone.
    const control = await openTheChart();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();

    fireEvent.click(control);
    const reset = screen.getByRole('button', { name: 'Reset layout' });
    fireEvent.click(reset);

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.querySelectorAll('[data-gantt-labels]')).toHaveLength(1);
  });
});

describe('the chart height this browser has dragged', () => {
  /** Where the key lives for the project every test in here opens. */
  const KEY = 'wbs.ganttHeight.p1';

  const openTheChart = async (): Promise<HTMLElement> => {
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    const panel = document.querySelector('[data-gantt-panel]');
    if (!(panel instanceof HTMLElement)) throw new Error('no gantt panel rendered');
    return panel;
  };

  itDom('opens the chart at the remembered height', async () => {
    localStorage.setItem(KEY, '500');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('500px');
  });

  itDom('opening a project does not change what is remembered about it', async () => {
    // The write happens when a drag is let go of and at no other time; a
    // sanitize-and-write-back on read would quietly rewrite a preference the
    // reader never touched.
    localStorage.setItem(KEY, '500');
    await openTheChart();
    expect(localStorage.getItem(KEY)).toBe('500');
  });

  itDom('refuses storage that is not a number, and drops the key', async () => {
    // localStorage is user-editable, so what comes back is a claim.
    localStorage.setItem(KEY, 'not a number at all');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(panel.classList.contains('max-h-[40vh]')).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses a height below the floor, and drops the key', async () => {
    localStorage.setItem(KEY, '10');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('refuses a height above the ceiling, and drops the key', async () => {
    // `1e999` parses to Infinity, which is above the ceiling exactly as any
    // huge finite number is — the range check is the only line either needs
    // (T1's finiteness lesson).
    localStorage.setItem(KEY, '99999');
    const panel = await openTheChart();
    expect(panel.style.height).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /**
   * jsdom has no pointer capture, so the call the real gesture depends on is
   * filled in before the drag is driven. What these tests can see is the
   * wiring — the height following the pointer, the commit, the fallback; the
   * browser's own half (capture, hit-testing, a real from-height) is
   * `e2e/gantt.spec.ts`'s.
   */
  const grabbable = (): HTMLElement => {
    const handle = screen.getByRole('separator', { name: 'Resize the Gantt chart' });
    handle.setPointerCapture = () => undefined;
    return handle;
  };

  // A hand-built event, because jsdom's PointerEvent takes neither the
  // `pointerId` nor the `clientY` an init dictionary hands it — the axis
  // hover's `axisPointer` (gantt-panel.test.tsx) is the same shape for the
  // same reason.
  const heightPointer = (
    name: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    pointerId: number,
    clientY: number,
  ): Event => {
    const grab = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(grab, 'pointerId', { value: pointerId });
    Object.defineProperty(grab, 'clientY', { value: clientY });
    return grab;
  };

  itDom('follows the pointer while dragged, and remembers where it was let go', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 7, 550));

    // Up 50px is 50px taller, and nothing is written while the drag is in
    // flight — the write is the release's alone.
    expect(panel.style.height).toBe('450px');
    expect(localStorage.getItem(KEY)).toBe('400');

    fireEvent(handle, heightPointer('pointerup', 7, 500));

    expect(panel.style.height).toBe('500px');
    expect(localStorage.getItem(KEY)).toBe('500');
  });

  itDom('a cancelled gesture falls back to the height last let go at', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 7, 500));
    expect(panel.style.height).toBe('500px');

    fireEvent(handle, heightPointer('pointercancel', 7, 500));

    expect(panel.style.height).toBe('400px');
    expect(localStorage.getItem(KEY)).toBe('400');
  });

  itDom('another pointer’s move is not this drag', async () => {
    localStorage.setItem(KEY, '400');
    const panel = await openTheChart();
    const handle = grabbable();

    fireEvent(handle, heightPointer('pointerdown', 7, 600));
    fireEvent(handle, heightPointer('pointermove', 8, 100));

    expect(panel.style.height).toBe('400px');
  });

  itDom(
    'a height override alone offers the reset, and pressing it forgets the height',
    async () => {
      localStorage.setItem(KEY, '500');
      const panel = await openTheChart();
      expect(panel.style.height).toBe('500px');

      click('Reset layout');

      expect(panel.style.height).toBe('');
      expect(panel.classList.contains('max-h-[40vh]')).toBe(true);
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    },
  );

  itDom('one reset forgets the widths and the height together', async () => {
    localStorage.setItem(KEY, '500');
    localStorage.setItem('wbs.columnWidths.p1', JSON.stringify({ number: 240 }));
    await openTheChart();

    click('Reset layout');

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('wbs.columnWidths.p1')).toBeNull();
  });

  itDom('the reset sits in the toolbar row, not on a line of its own', async () => {
    // The control joins the toolbar's own flex row — never `toolbarControls`,
    // the array the Plan actions sheet renders (plan-cards.test.tsx holds that
    // side) — and the line of its own between toolbar and table is gone.
    localStorage.setItem(KEY, '500');
    await openTheChart();

    const reset = screen.getByRole('button', { name: 'Reset layout' });
    expect(reset.parentElement?.hasAttribute('data-toolbar')).toBe(true);
    expect(document.querySelector('[data-width-controls]')).toBeNull();
  });
});

describe('the columns a reader has hidden', () => {
  /** Where the hide-list lives for the project every test in here opens. */
  const KEY = 'wbs.hiddenColumns.p1';
  const RESET_MARKER = 'wbs.linksResetShown.p1';

  /** The columns on screen, by id, in table order. */
  const headerIds = (): string[] =>
    screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-column') ?? '');

  /** A remembered hide-list, as a hand-edited store would hold it. */
  const storedHidden = (hidden: unknown): void => {
    localStorage.setItem(KEY, typeof hidden === 'string' ? hidden : JSON.stringify(hidden));
  };

  /** What is under the key now, which is what a reload would read. */
  const stored = (): string | null => localStorage.getItem(KEY);

  async function oneRow(api = fakeApi()) {
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  /** The default column set as this table renders it, read off `table-frame`. */
  const DEFAULT_ON_SCREEN = (stepIds: readonly string[]) => [
    'drag',
    'number',
    'name',
    'depends',
    'priority',
    'tag',
    'in-parallel',
    ...stepIds.map((id) => `${id}-final`),
    'final-total',
    'not-before',
    'start',
    'finish',
    'float',
    'actions',
  ];

  itDom('shows the Tags column on an empty directory, and not Teams or Services', async () => {
    // The negative for the rule this change deletes: until `configurable-
    // columns` the Tags column existed only once the directory held a tag, and
    // Teams was on screen in every state. On main this fails twice over.
    localStorage.removeItem(KEY);
    await oneRow();
    expect(headerIds()).toEqual(DEFAULT_ON_SCREEN(['step-dev', 'step-qa']));
    expect(screen.getByLabelText('Add a tag to 010')).toBeDefined();
    expect(screen.queryByLabelText('Service or team for 010')).toBeNull();
    expect(screen.queryByLabelText('Services for 010')).toBeNull();
  });

  itDom(
    'keeps Links hidden on a first visit even when the project already has a link',
    async () => {
      localStorage.removeItem(KEY);
      const api = fakeApi();
      const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Linked' });
      api.linkTo(row.id, [{ systemId: 'github', url: 'https://example.test/1' }]);
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByLabelText('Name of 010');
      expect(headerIds()).toEqual(DEFAULT_ON_SCREEN(['step-dev', 'step-qa']));
      expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();

      click('Reset layout');
      expect(headerIds()).toContain('refs');
      expect(localStorage.getItem(RESET_MARKER)).toBe('true');
      expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();

      cleanup();
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByLabelText('Name of 010');
      expect(headerIds()).toContain('refs');
    },
  );

  itDom('drops every reset marker except JSON true', async () => {
    for (const claimed of ['false', '"true"', '3', '{}', '{not json']) {
      cleanup();
      localStorage.setItem(RESET_MARKER, claimed);
      await oneRow();
      expect(headerIds()).not.toContain('refs');
      expect(localStorage.getItem(RESET_MARKER)).toBeNull();
    }
  });

  itDom('keeps each project’s reset marker while the selected project changes', async () => {
    localStorage.setItem(RESET_MARKER, 'true');
    const api = fakeApi();
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'One row' });
    const view = render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    expect(headerIds()).toContain('refs');

    view.rerender(<WbsTable projectId="p2" api={api} />);
    await waitFor(() => {
      expect(headerIds()).not.toContain('refs');
    });
    expect(localStorage.getItem(RESET_MARKER)).toBe('true');
    expect(localStorage.getItem('wbs.linksResetShown.p2')).toBeNull();

    view.rerender(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(headerIds()).toContain('refs');
    });
  });

  itDom('offers no reset until the first tree read succeeds, including an empty tree', async () => {
    localStorage.setItem('wbs.columnWidths.p1', JSON.stringify({ number: 240 }));
    const api = fakeApi();
    const empty = await api.tree('p1');
    let release!: (tree: typeof empty) => void;
    const held = new Promise<typeof empty>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(() => held);
    api.tree = read;

    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();

    act(() => {
      release(empty);
    });
    expect(await screen.findByRole('button', { name: 'Reset layout' })).toBeInTheDocument();
    click('Reset layout');
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
  });

  itDom('retains the last successful reset target when a later refresh fails', async () => {
    const api = fakeApi();
    const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Linked' });
    api.linkTo(row.id, [{ systemId: 'github', url: 'https://example.test/held' }]);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    api.tree = () => Promise.reject(new Error('offline'));

    click('Add work item');
    await waitFor(() => {
      expect(document.querySelector('[data-stale-tree]')).not.toBeNull();
    });
    click('Reset layout');
    expect(headerIds()).toContain('refs');
  });

  itDom('changes only the reset target when the first or last link changes', async () => {
    const api = fakeApi();
    const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Linked' });
    api.linkTo(row.id, [{ systemId: 'github', url: 'https://example.test/1' }]);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
    click('Reset layout');
    expect(headerIds()).toContain('refs');

    api.linkTo(row.id, []);
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    expect(headerIds()).toContain('refs');
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();
    click('Reset layout');
    expect(headerIds()).not.toContain('refs');

    api.linkTo(row.id, [{ systemId: 'github', url: 'https://example.test/2' }]);
    click('Add work item');
    await screen.findByLabelText('Name of 030');
    expect(headerIds()).not.toContain('refs');
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();
    click('Reset layout');
    expect(headerIds()).toContain('refs');
  });

  itDom(
    'uses the last landed tree while first-link and last-link reads are in flight',
    async () => {
      const linkedApi = fakeApi();
      const linkedRow = await linkedApi.createWorkItem('p1', {
        parentId: null,
        afterId: null,
        name: 'Linked',
      });
      linkedApi.linkTo(linkedRow.id, [
        { systemId: 'github', url: 'https://example.test/before-removal' },
      ]);
      render(<WbsTable projectId="p1" api={linkedApi} />);
      await screen.findByLabelText('Name of 010');

      const linkedTree = linkedApi.tree.bind(linkedApi);
      linkedApi.linkTo(linkedRow.id, []);
      const withoutLink = await linkedTree('p1');
      let releaseRemoval!: (tree: typeof withoutLink) => void;
      const heldRemoval = new Promise<typeof withoutLink>((resolve) => {
        releaseRemoval = resolve;
      });
      const removalRead = vi.fn(() => heldRemoval);
      linkedApi.tree = removalRead;
      click('Add work item');
      await waitFor(() => {
        expect(removalRead).toHaveBeenCalledTimes(1);
      });

      click('Reset layout');
      expect(headerIds()).toContain('refs');
      linkedApi.tree = linkedTree;
      act(() => {
        releaseRemoval(withoutLink);
      });
      expect(await screen.findByRole('button', { name: 'Reset layout' })).toBeInTheDocument();
      expect(headerIds()).toContain('refs');
      click('Reset layout');
      expect(headerIds()).not.toContain('refs');

      cleanup();
      localStorage.clear();
      const emptyApi = fakeApi();
      const emptyRow = await emptyApi.createWorkItem('p1', {
        parentId: null,
        afterId: null,
        name: 'Unlinked',
      });
      render(<WbsTable projectId="p1" api={emptyApi} />);
      await screen.findByLabelText('Name of 010');
      fireEvent.click(within(openColumns()).getByLabelText('Links'));
      expect(headerIds()).toContain('refs');

      const emptyTree = emptyApi.tree.bind(emptyApi);
      emptyApi.linkTo(emptyRow.id, [{ systemId: 'github', url: 'https://example.test/first' }]);
      const withLink = await emptyTree('p1');
      let releaseAddition!: (tree: typeof withLink) => void;
      const heldAddition = new Promise<typeof withLink>((resolve) => {
        releaseAddition = resolve;
      });
      const additionRead = vi.fn(() => heldAddition);
      emptyApi.tree = additionRead;
      click('Add work item');
      await waitFor(() => {
        expect(additionRead).toHaveBeenCalledTimes(1);
      });

      click('Reset layout');
      expect(headerIds()).not.toContain('refs');
      emptyApi.tree = emptyTree;
      act(() => {
        releaseAddition(withLink);
      });
      expect(await screen.findByRole('button', { name: 'Reset layout' })).toBeInTheDocument();
      expect(headerIds()).not.toContain('refs');
      click('Reset layout');
      expect(headerIds()).toContain('refs');
    },
  );

  itDom('finds a linked descendant in the whole tree after its branch is collapsed', async () => {
    const api = fakeApi();
    const parent = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Parent',
    });
    const child = await api.createWorkItem('p1', {
      parentId: parent.id,
      afterId: null,
      name: 'Linked child',
    });
    api.linkTo(child.id, [{ systemId: 'github', url: 'https://example.test/child' }]);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010.1');
    click('Collapse all');
    expect(screen.queryByLabelText('Name of 010.1')).toBeNull();

    click('Reset layout');
    expect(headerIds()).toContain('refs');
  });

  itDom('lets an explicit column choice replace and clear the reset marker', async () => {
    localStorage.setItem(RESET_MARKER, 'true');
    await oneRow();
    expect(headerIds()).toContain('refs');
    const panel = openColumns();
    fireEvent.click(within(panel).getByLabelText('Priority'));
    expect(localStorage.getItem(RESET_MARKER)).toBeNull();
    expect(stored()).toBe(JSON.stringify(['team', 'service', 'type', 'deadline', 'priority']));
  });

  itDom('keeps a hidden column hidden across a reload', async () => {
    storedHidden(['priority']);
    await oneRow();
    expect(headerIds()).not.toContain('priority');
    expect(headerIds()).toContain('depends');
    cleanup();
    await oneRow();
    expect(headerIds()).not.toContain('priority');
  });

  itDom('clears a store that is not a list of strings and shows the default set', async () => {
    // Proof: the shape check deleted, this failed with `TypeError:
    // storedHiddenColumns.filter is not a function` — the `'4'` handed on as a
    // list; with only the `removeItem` deleted, on `expected '4' to be null`.
    // Watched, 2026-08-28.
    storedHidden('4');
    await oneRow();
    expect(headerIds()).toEqual(DEFAULT_ON_SCREEN(['step-dev', 'step-qa']));
    expect(stored()).toBeNull();
    cleanup();
    storedHidden(['priority', 3]);
    await oneRow();
    expect(headerIds()).toEqual(DEFAULT_ON_SCREEN(['step-dev', 'step-qa']));
    expect(stored()).toBeNull();
  });

  itDom('drops an unknown id on its own and leaves the store as it was', async () => {
    // A hide-list, so a stored list that names only Prio has Teams and
    // Services **on** screen: the defaults are what an absent key means, not
    // what every list starts from.
    const claimed = JSON.stringify(['priority', 'step-nope', 'banana']);
    storedHidden(claimed);
    await oneRow();
    const ids = headerIds();
    expect(ids).not.toContain('priority');
    for (const id of ['depends', 'team', 'tag', 'service', 'step-dev-final', 'step-qa-final']) {
      expect(ids).toContain(id);
    }
    // Not written back on read: opening a project must not change what is
    // remembered about it.
    expect(stored()).toBe(claimed);
    // And the Steps section, which quotes the folded width of the columns on
    // screen, opens: `foldedTableMinWidth` throws on an id it does not know,
    // so the sanitised list — not the stored one — is what reaches it. The
    // panel is mounted the moment the settings modal opens, whichever tab is
    // in front, so the throw would happen on the first click.
    // Proof: `hiddenColumnIds` handed `storedHiddenColumns` unfiltered, this
    // failed with `UnknownColumnError: No declared width for column "step-
    // nope"` on the click below. Watched, 2026-08-28.
    click('Project settings');
    expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    expect(screen.getByLabelText('New step')).toBeVisible();
  });

  itDom('hides a step whole and leaves Days and the dates alone', async () => {
    const api = fakeApi();
    const row = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    await api.setEstimate(row.id, 'step-qa', { optimistic: 2, realistic: 3, pessimistic: 4 });
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    const shown = {
      total: rowFor('010').querySelector('[data-final-total]')?.textContent,
      start: rowFor('010').querySelector('td[data-column="start"]')?.textContent,
    };
    expect(headerIds().filter((id) => id.startsWith('step-qa-'))).toEqual(['step-qa-final']);
    cleanup();

    storedHidden(['step-qa']);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(headerIds().filter((id) => id.startsWith('step-qa-'))).toEqual([]);
    expect(headerIds()).toContain('step-dev-final');
    // The figures are be-01's own and the column only drew them: hidden, they
    // still reach the total and the dates.
    expect(rowFor('010').querySelector('[data-final-total]')?.textContent).toBe(shown.total);
    expect(rowFor('010').querySelector('td[data-column="start"]')?.textContent).toBe(shown.start);
  });

  /** The Columns control's panel, opened; its checkboxes by label, in order. */
  const openColumns = (): HTMLElement => {
    fireEvent.click(screen.getByText('Columns'));
    const panel = document.querySelector<HTMLElement>('[data-columns-panel]');
    if (panel === null) throw new Error('the Columns control opened no panel');
    return panel;
  };
  const offered = (panel: HTMLElement): { label: string; checked: boolean }[] =>
    [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => ({
      label: panel.querySelector(`label[for="${box.id}"]`)?.textContent ?? '(unlabelled)',
      checked: box.checked,
    }));

  itDom('offers every data column and every step, in table order, and no control', async () => {
    await oneRow();
    const panel = openColumns();
    expect(offered(panel)).toEqual([
      // First, where the column is: between `#` and Name, and on by default —
      // a column hidden by default is a feature nobody finds (design D5).
      { label: 'Links', checked: false },
      { label: 'Depends on', checked: true },
      { label: 'Priority', checked: true },
      { label: 'Teams', checked: false },
      { label: 'Tags', checked: true },
      { label: 'Services', checked: false },
      // Unticked like Teams and Services: `work-item-types` put `type` in
      // `DEFAULT_HIDDEN_COLUMNS` so the default table stays the width it was.
      { label: 'Types', checked: false },
      { label: 'People at once', checked: true },
      { label: 'Dev', checked: true },
      { label: 'QA', checked: true },
      { label: 'Days', checked: true },
      { label: 'Not before', checked: true },
      // Unticked for the reason Types is: `work-item-deadline` 9.1 put
      // `deadline` in `INITIAL_HIDDEN_COLUMNS` so the folded table at 1280
      // stays the width it was, and the whole words are here because this
      // control uses the same exact product label as the compact heading.
      // Proof: with `Work item deadline` this one filtered case failed on this entry.
      { label: 'Deadline', checked: false },
      { label: 'Start', checked: true },
      { label: 'End', checked: true },
      { label: 'Slack', checked: true },
    ]);
  });

  itDom(
    'unchecking a column takes it off the table and remembers it; checking puts it back',
    async () => {
      await oneRow();
      const panel = openColumns();
      fireEvent.click(within(panel).getByLabelText('Depends on'));
      expect(headerIds()).not.toContain('depends');
      expect(screen.queryByLabelText('Add a dependency to 010')).toBeNull();
      expect(stored()).toBe(
        JSON.stringify(['refs', 'team', 'service', 'type', 'deadline', 'depends']),
      );

      fireEvent.click(within(panel).getByLabelText('Depends on'));
      expect(headerIds()).toContain('depends');
      expect(stored()).toBe(JSON.stringify(['refs', 'team', 'service', 'type', 'deadline']));
      // Proof: `rememberHiddenColumns` left out of the toggle, this failed on
      // `expected null to be '["team","service","depends"]'`. Watched, 2026-08-28.
    },
  );

  itDom('shows a hidden-by-default column from the control, a whole step too', async () => {
    await oneRow();
    const panel = openColumns();
    fireEvent.click(within(panel).getByLabelText('Teams'));
    expect(headerIds()).toContain('team');
    expect(screen.getByLabelText('Service or team for 010')).toBeDefined();
    fireEvent.click(within(panel).getByLabelText('QA'));
    expect(headerIds().filter((id) => id.startsWith('step-qa-'))).toEqual([]);
    expect(stored()).toBe(JSON.stringify(['refs', 'service', 'type', 'deadline', 'step-qa']));
  });

  itDom('is forgotten by a layout reset, which is offered while a column is hidden', async () => {
    // Forgotten, never frozen: the key goes, and what comes back is whatever
    // the default column set is **now**. The reset is offered on a hidden
    // column alone, with no width dragged — a control that provably does
    // nothing reads as a broken one, and this one has something to do.
    await oneRow();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    const panel = openColumns();
    fireEvent.click(within(panel).getByLabelText('Depends on'));
    expect(headerIds()).not.toContain('depends');

    click('Reset layout');
    expect(headerIds()).toEqual(DEFAULT_ON_SCREEN(['step-dev', 'step-qa']));
    expect(stored()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
  });

  itDom('takes Right from the Name cell to Prio when Depends on is hidden', async () => {
    // A hidden column is absent from the table model, so the grid never
    // declared it: nothing to skip, nothing to land on.
    storedHidden(['depends']);
    await oneRow();
    const name = screen.getByLabelText('Name of 010');
    if (!isCell(name)) throw new Error('Name of 010 is not an editable cell');
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(document.activeElement?.closest('td')?.getAttribute('data-column')).toBe('priority');
  });
});
