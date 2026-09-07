import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import type * as TableFrameModule from './table-frame';
import { WbsTable } from './wbs-table';

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

const numbersOnScreen = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-number]')?.textContent ?? '');

/** What the toast stack is saying, newest first. */
const toastTexts = (): string[] =>
  [...document.querySelectorAll('[data-toast-text]')].map((node) => node.textContent);

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

/** Opens one row's ⋯ menu, the way a pointer does. */
const openRowMenu = (number: string) => {
  click(`Actions for ${number}`);
};

/**
 * Opens the toolbar's `Freeze #` menu and takes one of its two items.
 *
 * `Freeze numbering` and `Unfreeze all` were two buttons on the bar until
 * `plan-toolbar-controls`; they are the items of one menu now, so every case
 * that took either of them opens the menu first. Each such case is listed
 * individually in that change's `verify.md` — a test that changed shape is a
 * place the "same behaviour" claim is asserted rather than observed.
 *
 * The item names are unqualified, which is only unambiguous because a row's ⋯
 * calls its own item `Unfreeze` rather than `Unfreeze all`.
 */
const takeFreezeAction = (label: string) => {
  click('Freeze #');
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};

const typeName = (number: string, value: string) => {
  fireEvent.change(screen.getByLabelText(`Name of ${number}`), { target: { value } });
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

/** Pins a row's geometry so a drop can be aimed at a zone jsdom cannot lay out. */
const withHeight = (element: HTMLElement, top: number, height: number): HTMLElement => {
  element.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  return element;
};

/**
 * jsdom has no `DragEvent`, so `fireEvent.dragOver(el, {clientY})` degrades to a
 * plain `Event` and the coordinate is silently dropped — which made the first
 * version of these tests pass on a zone nobody aimed at. A `MouseEvent` named
 * `dragover` carries it, and React dispatches on the type either way.
 */
const dragEvent = (type: string, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientY });

const dragOnto = (from: string, to: string, clientY: number) => {
  fireEvent.dragStart(screen.getByLabelText(`Reorder ${from}`));
  const target = rowFor(to);
  fireEvent(target, dragEvent('dragover', clientY));
  fireEvent(target, dragEvent('drop', clientY));
};

/** Three named root rows: `010 Strip`, `020 Sand`, `030 Paint`. */
async function threeRoots() {
  // Dev's columns take part in the keyboard grid below, so they are open.

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
  }
  unfoldStep('Dev');
  return api;
}

const namesOnScreen = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((tr) => {
      const input = tr.querySelector('[data-name-input]');
      // Thrown rather than defaulted: a row without a name cell means the
      // markup changed, and an empty string here would quietly pass an
      // ordering assertion that is no longer looking at anything.
      if (!isCell(input)) throw new Error('a row has no name cell');
      return input.value;
    });

describe('moving between cells with the arrow keys', () => {
  /** Focuses a cell and puts the caret where a test needs it. */
  const focusCell = (
    label: string,
    caret: 'start' | 'end' | 'middle',
  ): HTMLInputElement | HTMLTextAreaElement => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const at =
      caret === 'start'
        ? 0
        : caret === 'end'
          ? input.value.length
          : Math.floor(input.value.length / 2);
    input.setSelectionRange(at, at);
    return input;
  };

  /** Returns whether the browser would still act on the key. */
  const press = (input: HTMLInputElement | HTMLTextAreaElement, key: string): boolean =>
    fireEvent.keyDown(input, { key });

  itDom('moves down a column of estimates', async () => {
    const api = await threeRoots();
    expect(api.rows).toHaveLength(3);

    const first = focusCell('Dev optimistic for 010', 'end');
    press(first, 'ArrowDown');

    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('stays put at the bottom of a column', async () => {
    await threeRoots();

    const last = focusCell('Dev optimistic for 030', 'end');
    press(last, 'ArrowDown');

    expect(document.activeElement).toBe(last);
  });

  itDom('moves along a row once the caret has run out', async () => {
    await threeRoots();

    const name = focusCell('Name of 010', 'end');
    press(name, 'ArrowRight');

    // The cell beside the name, which is every field the row has and not only
    // the ones that are typed into: the pickers and the date joined the grid
    // when Tab was made to reach them.
    expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 010'));
  });

  itDom('leaves the caret alone in the middle of a word', async () => {
    // The rule that has to be right: hijacking this would make the table
    // unusable for the thing it is mainly used for. jsdom does not move a caret
    // for an arrow key, so "the browser still gets it" is asserted through
    // `defaultPrevented` rather than through where the caret ended up.
    await threeRoots();

    const name = focusCell('Name of 010', 'middle');
    const stillTheBrowsers = press(name, 'ArrowRight');

    expect(document.activeElement).toBe(name);
    expect(stillTheBrowsers).toBe(true);
  });

  itDom('takes the key only when it is moving the focus', async () => {
    await threeRoots();

    const first = focusCell('Dev optimistic for 010', 'end');
    expect(press(first, 'ArrowDown')).toBe(false);

    const last = focusCell('Dev optimistic for 030', 'end');
    expect(press(last, 'ArrowDown')).toBe(true);
  });

  itDom('does not stop on the derived number', async () => {
    await threeRoots();

    const name = focusCell('Name of 010', 'start');
    press(name, 'ArrowLeft');

    expect(document.activeElement).toBe(name);
  });

  itDom('keeps ↑ and ↓ in the name until the caret has run out of text', async () => {
    // The Name cell holds the notes under the name, so Up and Down are how
    // that text is walked. They leave the cell from the extremes only —
    // position 0 and the end of the value — which is wrap-proof: a name wraps,
    // so counting logical lines would let go of the key while the caret still
    // had visual lines to climb. `e2e/layout.spec.ts` measures the wrapped case
    // in a browser; jsdom cannot wrap anything.
    await threeRoots();
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 020');
    fireEvent.change(name, { target: { value: 'Sand the frames\nmeasure twice' } });
    name.focus();

    // Mid-text: the browser keeps both keys and the focus does not move.
    name.setSelectionRange(6, 6);
    expect(fireEvent.keyDown(name, { key: 'ArrowUp' })).toBe(true);
    expect(document.activeElement).toBe(name);
    expect(fireEvent.keyDown(name, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(name);

    // At the very start, Up leaves — the second press of a real keyboard,
    // where the first walked the caret up to 0.
    name.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(name, { key: 'ArrowUp' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));

    // And at the very end, Down does.
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
    expect(fireEvent.keyDown(name, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 030'));
  });

  itDom('still walks a column of one-line boxes from any caret position', async () => {
    // The other half of the same rule, and the reason it is a separate test: a
    // gate applied to every cell would break filling an estimate column down
    // forty rows, where Up and Down do nothing to the text at all.
    await threeRoots();
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '345' } });
    box.focus();
    box.setSelectionRange(1, 1);

    expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('skips the children of a collapsed branch', async () => {
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    // `010.1` is off screen; Down has to land on the next row a person can see.
    const name = focusCell('Name of 010', 'end');
    press(name, 'ArrowDown');

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    expect(api.rows).toHaveLength(3);
  });
});

describe('arrow keys — cross-review findings', () => {
  const focus = (label: string, at: 'start' | 'end') => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const pos = at === 'start' ? 0 : input.value.length;
    input.setSelectionRange(pos, pos);
    return input;
  };

  const arrow = (key: string, init: Record<string, unknown> = {}) => {
    const active = document.activeElement;
    if (!isCell(active)) throw new Error('nothing focused');
    fireEvent.keyDown(active, { key, ...init });
    return document.activeElement;
  };

  itDom('arrives with a collapsed caret, not a selection', async () => {
    // agy, high. Arriving cells were selected, and a full selection reads as
    // `hasSelection` — the rule that keeps Shift+Arrow out of the grid — so the
    // next press in the same direction did nothing and crossing a row of
    // populated cells took twice the keys.
    //
    // jsdom does not move a caret for an arrow key, so what is asserted is the
    // caret this code puts there, on the edge the travel came from. Whether the
    // browser then walks it across the value is the browser's own behaviour.
    await threeRoots();
    const typed: readonly (readonly [string, string])[] = [
      ['Dev optimistic for 010', '3'],
      ['Dev realistic for 010', '5'],
    ];
    for (const [label, days] of typed) {
      const box = screen.getByLabelText(label);
      fireEvent.change(box, { target: { value: days } });
      fireEvent.blur(box);
    }
    await waitFor(() => {
      expect(screen.getByLabelText('Dev realistic for 010')).toHaveProperty('value', '5');
    });

    // Between two populated boxes, which is where a caret dropped on the wrong
    // edge is felt: crossing a row of them is what took twice the keys.
    focus('Dev optimistic for 010', 'end');
    const arrived = arrow('ArrowRight');

    expect(arrived).toBe(screen.getByLabelText('Dev realistic for 010'));
    if (!isCell(arrived)) throw new Error('not an editable cell');
    expect(arrived.value).toBe('5');
    expect([arrived.selectionStart, arrived.selectionEnd]).toEqual([0, 0]);

    // And coming back the other way lands on the far edge, for the same reason.
    const back = arrow('ArrowLeft');
    if (!isCell(back)) throw new Error('not an editable cell');
    expect(back).toBe(screen.getByLabelText('Dev optimistic for 010'));
    expect([back.selectionStart, back.selectionEnd]).toEqual([
      back.value.length,
      back.value.length,
    ]);
  });

  itDom('leaves an IME composition to the input', async () => {
    // codex, high. Up and Down pick a candidate while composing; taking them
    // moves the focus out of a half-written word and commits it.
    await threeRoots();
    focus('Name of 010', 'end');

    expect(arrow('ArrowDown', { isComposing: true })).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('leaves a modified arrow to the browser', async () => {
    // Ctrl and Meta only. Alt is the grid's own now — it moves the row rather
    // than the focus, which is `moving rows with alt and the arrows` below.
    await threeRoots();

    for (const modifier of ['ctrlKey', 'metaKey']) {
      focus('Name of 010', 'end');
      expect(arrow('ArrowDown', { [modifier]: true })).toBe(screen.getByLabelText('Name of 010'));
    }
  });

  itDom('never stops on a parent’s rolled-up figures', async () => {
    // Both reviewers. A parent's estimates are sums and read-only; landing there
    // is the same dead keypress the derived number column was excluded for.
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(api.rows.find((r) => r.number === '010')?.rolledUp).toBe(true);

    // Up the column from the child, where the parent's box is the row directly
    // above: it is a sum, so there is nothing above this one to type into and
    // the focus stays where it is.
    //
    // Proof: `:not([readonly])` stripped from `editableGrid`'s selector, this
    // failed with the focus on `Dev optimistic for 010` — the parent's own
    // rolled-up box. Watched, 2026-08-07. The row-wise half of this claim is
    // `Shift+Tab steps over a parent’s read-only estimate boxes`: an arrow
    // cannot reach the trio from the right, because the assignee picker
    // between them is a cell Tab leaves and the arrows do not.
    focus('Dev optimistic for 010.1', 'start');
    expect(arrow('ArrowUp')).toBe(screen.getByLabelText('Dev optimistic for 010.1'));

    // And down the column from the child, past the row below it.
    focus('Dev optimistic for 010.1', 'end');
    expect(arrow('ArrowDown')).toBe(screen.getByLabelText('Dev optimistic for 020'));
  });

  itDom('navigates from every editable cell, not just the ones the first tests used', async () => {
    // codex, medium. The original tests moved from the name and from Dev
    // optimistic only, so removing the handler from the last cell of the row —
    // or from realistic and pessimistic — left them green.
    await threeRoots();
    const columns = [
      'Name of 010',
      'Dev optimistic for 010',
      'Dev realistic for 010',
      'Dev pessimistic for 010',
      'QA estimate for 010',
    ];

    for (const label of columns) {
      // `end` is load-bearing for the Name cell and inert for the rest: the
      // box that holds the notes keeps Down until the caret has run out of
      // text, and an estimate box is one line where it never has any to run
      // out of.
      focus(label, 'end');
      expect(arrow('ArrowDown')).toBe(screen.getByLabelText(label.replace('010', '020')));
    }
  });
});

describe('Tab moves between the fields, from every cell', () => {
  beforeEach(showEveryColumn);

  /** Focuses a cell and puts the caret where a test needs it. */
  const focusCaret = (
    label: string,
    at: 'start' | 'middle' | 'end',
  ): HTMLInputElement | HTMLTextAreaElement => {
    const input = screen.getByLabelText(label);
    // Either element: the Name and Notes cells are textareas so their text
    // wraps, and both carry the selection fields the keyboard code reads.
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const pos =
      at === 'start' ? 0 : at === 'end' ? input.value.length : Math.floor(input.value.length / 2);
    input.setSelectionRange(pos, pos);
    return input;
  };

  /** Presses Tab where the focus is, and says whether the browser still gets the key. */
  const tab = (shiftKey = false): boolean => {
    const active = document.activeElement;
    if (!isCell(active)) throw new Error('nothing focused');
    return fireEvent.keyDown(active, { key: 'Tab', shiftKey });
  };

  /** Each label paired with the one after it, so a walk reads as its own steps. */
  const stepsThrough = (labels: readonly string[]): (readonly [string, string])[] => {
    const steps: (readonly [string, string])[] = [];
    let previous: string | undefined;
    for (const label of labels) {
      if (previous !== undefined) steps.push([previous, label] as const);
      previous = label;
    }
    return steps;
  };

  itDom('Tab moves from an estimate cell to the next editable cell', async () => {
    await threeRoots();

    focusCaret('Dev optimistic for 010', 'end');
    expect(tab()).toBe(false);

    expect(document.activeElement).toBe(screen.getByLabelText('Dev realistic for 010'));
  });

  itDom('Tab in the middle of a name navigates; at caret 0 it still indents', async () => {
    await threeRoots();

    // Mid-text, Tab is what it is in any table: the next field, and the tree
    // is left alone.
    focusCaret('Name of 020', 'middle');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 020'));
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    // At the very start it is still the outliner's indent, which is the one
    // special case this change keeps.
    focusCaret('Name of 020', 'start');
    tab();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });

  itDom(
    'Tab from the depends input closes the picker, discards the typed search, and moves once',
    async () => {
      const api = await threeRoots();
      const added = recordCalls(api, 'addDependency');

      const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
      box.focus();
      fireEvent.change(box, { target: { value: 'Strip' } });
      expect(screen.getByRole('listbox', { name: 'Work items 030 can depend on' })).toBeDefined();

      expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);

      // One cell along, not two: the handler moves the focus and takes the key,
      // so the browser adds no move of its own.
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 030'));
      expect(screen.queryByRole('listbox')).toBeNull();
      // Typed text is a search, not a value. Leaving discards it, which is what
      // leaving this cell has always done.
      expect(added).toEqual([]);
      expect(screen.getByLabelText('Add a dependency to 030')).toHaveProperty('value', '');
    },
  );

  itDom('Shift+Tab from the depends input lands in the name, not on a chip button', async () => {
    await threeRoots();

    const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    box.focus();
    fireEvent.change(box, { target: { value: '010' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop 030 waiting for 010' })).toBeDefined();
    });

    // The chip sits before the input inside this one cell, so the browser's own
    // Shift+Tab would land on its ✕ — a dependency one keystroke from being
    // removed by somebody who only meant to go back a field.
    const again = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    again.focus();
    expect(fireEvent.keyDown(again, { key: 'Tab', shiftKey: true })).toBe(false);

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 030'));
  });

  itDom('walks every field of a row in turn, and on into the next row', async () => {
    // The reason this walks all of them rather than sampling: a handler left
    // off one cell is invisible to a test that starts in another, which is how
    // Tab came to work in the name and nowhere else.
    await threeRoots();

    for (const [from, to] of stepsThrough([
      'Name of 010',
      'Add a dependency to 010',
      'Priority for 010',
      'Service or team for 010',
      'Tags for 010',
      'Services for 010',
      // In table order, between Services and People at once —
      // `work-item-types`. This walk renders every hideable column, Teams
      // included, which is why the Types cell is here despite being hidden by
      // default on a plan nobody has configured.
      'Types for 010',
      'People at once for 010',
      'Dev optimistic for 010',
      'Dev realistic for 010',
      'Dev pessimistic for 010',
      'Dev assignee for 010',
      'QA estimate for 010',
      'Name of 020',
    ])) {
      focusCaret(from, 'end');
      tab();
      expect(document.activeElement).toBe(screen.getByLabelText(to));
    }
  });

  itDom('walks both open steps in turn, and the grid arrows cross between them', async () => {
    // The keyboard's half of `unfolding-may-scroll`: with two steps open the
    // row is eight cells longer than any walk ever asserted, because until
    // that change a second step could not be open at all. The Tab order and
    // the grid's own left/right are the two ways across a row and both are
    // asked here — a handler left off the second step's boxes is invisible to
    // a walk that only ever sees the first one's.
    await threeRoots();
    unfoldStep('QA');

    for (const [from, to] of stepsThrough([
      'Dev pessimistic for 010',
      'Dev assignee for 010',
      'QA optimistic for 010',
      'QA realistic for 010',
      'QA pessimistic for 010',
      'QA assignee for 010',
      'Name of 020',
    ])) {
      focusCaret(from, 'end');
      tab();
      expect(document.activeElement).toBe(screen.getByLabelText(to));
    }

    // And the chord that moves between cells rather than through them: out of
    // the first open step and into the second, then back.
    focusCaret('Dev assignee for 010', 'end');
    fireEvent.keyDown(screen.getByLabelText('Dev assignee for 010'), { key: 'l', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('QA optimistic for 010'));
    fireEvent.keyDown(screen.getByLabelText('QA optimistic for 010'), { key: 'h', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Dev assignee for 010'));
  });

  itDom('steps over the date cells until the plan is on a calendar', async () => {
    // Without a project start date **both** date fields are disabled: a Tab
    // that stopped on one would take the key and land nothing, which is a dead
    // keystroke in the middle of every row. Two of them since
    // `work-item-deadline` 9.1 — the deadline cell is disabled by the same
    // fact and for the same reason, so this walk is the negative control for
    // both at once.
    await threeRoots();
    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').disabled).toBe(
      true,
    );

    // Straight into the next row: both dates are stepped over and they were the
    // last cells of this one, now that the notes are written under the name.
    focusCaret('QA estimate for 010', 'end');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));

    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    focusCaret('QA estimate for 010', 'end');
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));

    // Then the deadline beside it, in the order the columns render: the two
    // days a planner states, and only then the row below.
    expect(fireEvent.keyDown(screen.getByLabelText('Earliest start for 010'), { key: 'Tab' })).toBe(
      false,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Work item deadline for 010'));

    // And out again. A date input is focused rather than selected: it has no
    // text caret to ask for.
    expect(
      fireEvent.keyDown(screen.getByLabelText('Work item deadline for 010'), { key: 'Tab' }),
    ).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
  });

  itDom('the arrows land in a date cell without asking it for a caret it has none of', async () => {
    // `setSelectionRange` throws `InvalidStateError` on a date input, and the
    // arrows have one to land on: the folded QA estimate sits next to it.
    await threeRoots();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    // Watched rather than left to the runner: React re-throws what a handler
    // threw as an uncaught error, which the run reports away from the test that
    // caused it. Collected here, the assertion is this test's own.
    const thrown: unknown[] = [];
    const collect = (event: ErrorEvent) => {
      thrown.push(event.error);
    };
    window.addEventListener('error', collect);
    focusCaret('QA estimate for 010', 'end');
    fireEvent.keyDown(screen.getByLabelText('QA estimate for 010'), { key: 'ArrowRight' });
    window.removeEventListener('error', collect);

    expect(thrown).toEqual([]);
    expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
  });

  itDom('Shift+Tab steps over a parent’s read-only estimate boxes', async () => {
    // A parent's trio is a sum of what is below it: the boxes are on screen to
    // be read and take no typing, so the field before the assignee is the team
    // and the three boxes between them are not stopped in. This is the row-wise
    // half of `never stops on a parent’s rolled-up figures` — an arrow cannot
    // make this trip, because the assignee picker in the way is a cell Tab
    // leaves and the arrows do not.
    //
    // Proof: `:not([readonly])` stripped from `editableGrid`'s selector, this
    // failed with the focus on `Dev pessimistic for 010`. Watched, 2026-08-07.
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(api.rows.find((r) => r.number === '010')?.rolledUp).toBe(true);
    expect(screen.getByLabelText('Dev optimistic for 010')).toHaveProperty('readOnly', true);

    const assignee = screen.getByLabelText('Dev assignee for 010');
    assignee.focus();
    expect(fireEvent.keyDown(assignee, { key: 'Tab', shiftKey: true })).toBe(false);

    // The Types cell: with every column shown it is the last field before the
    // trio (the In-parallel cell is a parent's rolled-up figure too). It was
    // Services until `work-item-types` put a fourth reference column after it.
    expect(document.activeElement).toBe(screen.getByLabelText('Types for 010'));
  });

  itDom('at the edges of the grid the key is left to the browser', async () => {
    // No focus trap. The grid's edges are the first and last editable cells of
    // the whole table, not of a row: Tab at the end of a row walks into the
    // next one, and only past the last cell of the last row is the key left to
    // the browser — which finds that row's own ⋯ button. The actions are
    // reachable at the end of the table and never from the middle of a row,
    // which is what this makes consistent. One stop per row since 2026-08-08,
    // where it used to be two.
    await threeRoots();

    const last = focusCaret('QA estimate for 030', 'end');
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(last);

    const first = focusCaret('Name of 010', 'end');
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});

describe('moving rows with alt and the arrows', () => {
  /**
   * Focuses a cell and puts the caret where the test needs it.
   *
   * `middle` is the position that matters here: it is where Tab navigates and
   * Backspace deletes a character, so a structural key that works there is the
   * whole point of this block.
   */
  const focusAt = (label: string, caret: 'start' | 'middle' | 'end'): HTMLElement => {
    const input = screen.getByLabelText(label);
    if (!isCell(input)) throw new Error(`${label} is not an editable cell`);
    input.focus();
    const at =
      caret === 'start'
        ? 0
        : caret === 'end'
          ? input.value.length
          : Math.floor(input.value.length / 2);
    input.setSelectionRange(at, at);
    return input;
  };

  /** Presses one Alt+arrow, and reports whether the browser would still act on it. */
  const altArrow = (label: string, key: string, caret: 'start' | 'middle' | 'end' = 'middle') =>
    fireEvent.keyDown(focusAt(label, caret), { key, altKey: true });

  /** Records every move asked for, and makes none of them happen. */
  const watchMoves = (api: ProjectApi): unknown[][] => {
    const moved: unknown[][] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    return moved;
  };

  itDom('swaps the row with the sibling below it', async () => {
    const api = await threeRoots();

    // Taken from the browser: on macOS an un-prevented Alt+arrow types a
    // character into the field as well as moving the caret.
    expect(altArrow('Name of 010', 'ArrowDown')).toBe(false);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });
    // Moved, not copied, and still all at the root.
    expect(api.rows).toHaveLength(3);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('swaps the row with the sibling above it', async () => {
    await threeRoots();

    expect(altArrow('Name of 030', 'ArrowUp')).toBe(false);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Paint', 'Sand']);
    });
  });

  itDom('at the first sibling it moves nothing, and still takes the key', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    // No wrap to the other end: running out of siblings is not a request to
    // reparent, nor to jump to the bottom of the group.
    expect(altArrow('Name of 010', 'ArrowUp')).toBe(false);

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    // Nothing to complain about either: a row at the top is not a mistake.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('at the last sibling it moves nothing', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 030', 'ArrowDown')).toBe(false);

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('indents from the middle of the text, where tab would not', async () => {
    // The whole point of the change: Tab restructures only at position zero of
    // the Name cell, so today this caret position means "next cell".
    await threeRoots();

    expect(altArrow('Name of 020', 'ArrowRight')).toBe(false);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('outdents from an estimate box', async () => {
    await threeRoots();
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    expect(altArrow('Dev optimistic for 010.1', 'ArrowLeft', 'end')).toBe(false);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  /**
   * Waits for the table to stop working.
   *
   * `indent` and `outdent` route a dead key through the busy-and-refetch shell
   * anyway, so a test that asserted the instant after the keystroke would be
   * asserting into the middle of a refresh — and the next keystroke would be
   * dropped by the busy rule rather than judged on its own merits.
   */
  const settle = async () => {
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add work item' })).toHaveProperty(
        'disabled',
        false,
      );
    });
  };

  itDom('a root row has nothing to outdent into', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowLeft')).toBe(false);
    await settle();

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('a first sibling has nothing to indent under', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowRight')).toBe(false);
    await settle();

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  /**
   * Drops the focus the way a browser does when React moves the row.
   *
   * jsdom keeps the focus on a node that is detached and reinserted; a browser
   * does not, which is the whole reason the table puts the focus back after a
   * move. Without this line the assertions below pass on a focus that was never
   * lost — a check that cannot fail — and with it they observe the refocus
   * itself. Proof: the refocus removed, both tests pass without this line and
   * fail with it; watched, 2026-08-06.
   */
  const dropTheFocusAsABrowserWould = () => {
    const focused = document.activeElement;
    if (!isCell(focused)) throw new Error('nothing focused to drop');
    focused.blur();
  };

  itDom('lands in the same column after an indent, not back in the name', async () => {
    // The mechanism this proves twice over: `indent` on its own lands the focus
    // in the Name cell, which is right for Enter and Backspace and wrong for a
    // key pressed in an estimate box.
    await threeRoots();

    altArrow('Dev optimistic for 020', 'ArrowRight', 'end');
    dropTheFocusAsABrowserWould();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 010.1'));
    });
  });

  itDom('lands in the same column after a sibling swap', async () => {
    await threeRoots();

    altArrow('Dev pessimistic for 010', 'ArrowDown', 'end');
    dropTheFocusAsABrowserWould();

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });
    // The moved row is `020` now, and the focus is in the box it started in.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev pessimistic for 020'));
    });
  });

  itDom('refuses to move a frozen row and says why', async () => {
    const api = await threeRoots();
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });
    const moved = watchMoves(api);

    expect(altArrow('Name of 010', 'ArrowDown')).toBe(false);

    expect(moved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('frozen');
  });

  itDom('drops a second alt+down while the first is in flight', async () => {
    const api = await threeRoots();
    const asked: unknown[][] = [];
    const finish: (() => void)[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      asked.push(args);
      return new Promise<void>((resolve) => finish.push(resolve));
    };

    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(1);

    // A held key repeats. The second press arrives against a tree that has not
    // come back yet, so it is dropped rather than queued.
    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(1);

    await act(async () => {
      finish[0]?.();
      await Promise.resolve();
    });
    // And once the first has landed, the key works again.
    altArrow('Name of 010', 'ArrowDown');
    expect(asked).toHaveLength(2);
  });

  itDom('a plain arrow is still navigation', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    const name = focusAt('Name of 010', 'end');
    fireEvent.keyDown(name, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    expect(moved).toEqual([]);
  });

  itDom('leaves a composing alt arrow, and one with a second modifier, alone', async () => {
    const api = await threeRoots();
    const moved = watchMoves(api);

    for (const extra of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }]) {
      const name = focusAt('Name of 010', 'middle');
      expect(fireEvent.keyDown(name, { key: 'ArrowDown', altKey: true, ...extra })).toBe(true);
    }

    expect(moved).toEqual([]);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
  });

  itDom('moves the row from the dependency picker, and leaves its bare arrows alone', async () => {
    // **This pin is the reverse of the one it replaces.** `leaves the
    // dependency picker's own alt arrows alone` said the handler lives on the
    // grid cells and this box is not one of them — which made the sheet's "from
    // any cell and any caret position" false in the three cell classes that
    // open a list, and `table-mechanics` reverses it by name. What the picker
    // keeps is the *bare* arrows, which are its highlight's; Alt is not a
    // highlight gesture in any cell of this table.
    const api = await threeRoots();
    const moved = watchMoves(api);

    const picker = screen.getByLabelText('Add a dependency to 020');
    fireEvent.focus(picker);
    fireEvent.keyDown(picker, { key: 'ArrowDown' });

    // The bare arrow moved the list's highlight and nothing else.
    expect(moved).toEqual([]);

    fireEvent.keyDown(picker, { key: 'ArrowDown', altKey: true });

    expect(moved).toEqual([['w2', null, 'w3']]);
  });
});

/**
 * The command chords: one gesture family for structure, one for motion.
 *
 * Every row of the routing matrix in `openspec/changes/command-keys/design.md`
 * is a test in here — chord × cell class, and the cells whose picker is open,
 * where a chord must be inert because the list owns the keyboard.
 */
describe('the command chords', () => {
  beforeEach(showEveryColumn);

  /** A chord as a browser delivers it, aimed at a named box. */
  const chord = (
    box: Element,
    key: string,
    modifiers: { code?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; repeat?: boolean },
  ) =>
    fireEvent.keyDown(box, {
      key,
      code: modifiers.code ?? `Key${key.toUpperCase()}`,
      ctrlKey: modifiers.ctrl ?? false,
      metaKey: modifiers.meta ?? false,
      altKey: modifiers.alt ?? false,
      repeat: modifiers.repeat ?? false,
    });

  const nameOf = (number: string) =>
    screen.getByLabelText<HTMLTextAreaElement>(`Name of ${number}`);
  /** Whatever holds the focus, as a box the helpers above can be aimed at. */
  const focused = (): Element => {
    const active = document.activeElement;
    // Thrown rather than defaulted: a chord test whose focus went nowhere must
    // say so, not fire its next key at the document body and pass.
    if (active === null) throw new Error('nothing has the focus');
    return active;
  };
  /** Ctrl+N, the new-work-item chord, in the box named. */
  const newItem = (box: Element) => chord(box, 'n', { code: 'KeyN', ctrl: true });
  /** Cmd+Enter, the next-or-create chord. */
  const nextOrCreate = (box: Element) => chord(box, 'Enter', { code: 'Enter', meta: true });
  /** Ctrl+D, once. A confirming second press needs {@link releaseD} in between. */
  const armDelete = (box: Element, repeat = false) =>
    chord(box, 'd', { code: 'KeyD', ctrl: true, repeat });
  /** The keyup of D the confirm waits for: a held key can never reach it. */
  const releaseD = (box: Element) => fireEvent.keyUp(box, { key: 'd', code: 'KeyD' });

  /** The sentence an armed row puts on screen, which is only true while it is armed. */
  const armSays = (number: string) => `Ctrl+D again deletes ${number} — its children move up`;

  /** Which row is tinted as armed for deletion, by number. */
  const armedRow = (): string | null => {
    const row = document.querySelector('tr[data-armed="true"]');
    return row === null ? null : (row.querySelector('[data-number]')?.textContent ?? '');
  };

  itDom('Enter in a name is a newline, and makes nothing', async () => {
    // The whole of R1's second half: a note is typed under the name, which
    // needs Enter to mean what it means in every other text box in the world.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');

    const event = createEvent.keyDown(cell, { key: 'Enter', code: 'Enter' });
    fireEvent(cell, event);

    // Not taken: the browser writes the newline. jsdom performs no default
    // action for a synthetic key, so this is the assertion it can make — the
    // real newline is the browser spec's.
    expect(event.defaultPrevented).toBe(false);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(api.rows).toHaveLength(1);
  });

  itDom('Ctrl+N makes a sibling below this row, mid-table, and lands in its name', async () => {
    await threeRoots();

    newItem(nameOf('020'));

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    // Below 020, not at the end: that is what Ctrl+N has over Cmd+Enter.
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', '', 'Paint']);
    expect(document.activeElement).toBe(nameOf('030'));
  });

  itDom('Alt+N is the same chord for the keyboards Ctrl+N never reaches', async () => {
    // macOS turns Alt+N into a dead key, so the letter never arrives — the
    // physical key does, and that is what this is matched on.
    await threeRoots();

    chord(nameOf('020'), 'Dead', { code: 'KeyN', alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(document.activeElement).toBe(nameOf('030'));
  });

  itDom('Ctrl+N works from an estimate cell, and sends what was in it first', async () => {
    const api = await threeRoots();
    const box = screen.getByLabelText('Dev optimistic for 020');
    box.focus();
    fireEvent.change(box, { target: { value: '3' } });

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    // One box of a trio is a draft, not a request — the flush is still the
    // cell's own commit path, and the row below it exists either way.
    expect(document.activeElement).toBe(nameOf('030'));
    expect(api.rows.find((row) => row.number === '020')?.estimates).toEqual({});
  });

  itDom('Cmd+Enter moves to the next row’s name', async () => {
    await threeRoots();
    const cell = nameOf('010');
    cell.focus();

    nextOrCreate(cell);

    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter on the last row makes one and lands in it', async () => {
    await threeRoots();
    const cell = nameOf('030');
    cell.focus();

    nextOrCreate(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(document.activeElement).toBe(nameOf('040'));
  });

  itDom('two Cmd+Enters on the last row make exactly one row', async () => {
    // The chord runs a request and then another; two presses inside that
    // window are one gesture arriving twice, not two work items.
    // Proof: the in-flight gate removed, this failed on `expected [ '010',
    // '020', '030', '040', '050' ] to deeply equal [ '010', '020', '030',
    // '040' ]`. Watched, 2026-08-08.
    const api = await threeRoots();
    const cell = nameOf('030');
    cell.focus();

    nextOrCreate(cell);
    nextOrCreate(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(api.rows).toHaveLength(4);
  });

  itDom('waits for the save to land before it creates anything', async () => {
    // codex #5, and the assertion has to be about *settling* rather than about
    // the order the two calls go out in. Both leave synchronously either way —
    // what an unawaited flush loses is the answer, and with it the right to
    // decide whether to create at all. So the patch is held open and the
    // create must not have happened while it hangs.
    //
    // Proof: the `await` dropped — `const outcome = 'landed'` with the flush
    // fired and forgotten — this failed on `expected [ 'patch', 'create' ] to
    // deeply equal [ 'patch' ]`, a row created against an answer nobody had.
    // Watched, 2026-08-08.
    const api = await threeRoots();
    const asked: string[] = [];
    let letThePatchLand: () => void = () => {
      throw new Error('the patch was never sent');
    };
    const held = new Promise<void>((resolve) => {
      letThePatchLand = resolve;
    });
    const realPatch = api.patchWorkItem.bind(api);
    api.patchWorkItem = async (id: string, patch: Record<string, unknown>) => {
      asked.push('patch');
      await held;
      return realPatch(id, patch);
    };
    const realCreate = api.createWorkItem.bind(api);
    api.createWorkItem = (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      asked.push('create');
      return realCreate(projectId, input);
    };

    const cell = nameOf('030');
    cell.focus();
    fireEvent.change(cell, { target: { value: 'Paint the trim' } });
    nextOrCreate(cell);

    await waitFor(() => {
      expect(asked).toEqual(['patch']);
    });
    // Still nothing created: the chord is waiting to hear what be-01 did.
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    await act(async () => {
      letThePatchLand();
      await held;
    });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(asked).toEqual(['patch', 'create']);
    expect(api.rows.find((row) => row.id === 'w3')?.name).toBe('Paint the trim');
  });

  itDom('a refused save leaves the caret where it was and makes no row', async () => {
    const api = await threeRoots();
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    const cell = nameOf('030');
    cell.focus();
    fireEvent.change(cell, { target: { value: 'Paint the trim' } });
    nextOrCreate(cell);

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(document.activeElement).toBe(cell);
  });

  /**
   * A blur's PATCH held open, the cell refocused unchanged, and the chord
   * pressed while that first request is still out.
   *
   * Rule 5 in `cell-input.tsx` recognizes the second leave as a resubmission
   * of the request already in flight. What it must **not** do is answer the
   * chord with `unsent`: the chord reads that as "nothing to wait for" and
   * moves or creates against an answer nobody has yet.
   *
   * @param at The row whose Name cell is typed in and then chorded from.
   * @returns The fake, the cell, the request log and the two ways to settle
   * the held PATCH.
   */
  async function patchHeldOpen(at: string) {
    const api = await threeRoots();
    const asked: string[] = [];
    let landThePatch: () => void = () => {
      throw new Error('the patch was never sent');
    };
    let refuseThePatch: () => void = () => {
      throw new Error('the patch was never sent');
    };
    const realPatch = api.patchWorkItem.bind(api);
    api.patchWorkItem = (id: string, patch: Record<string, unknown>) => {
      asked.push('patch');
      return new Promise<void>((resolve, reject) => {
        landThePatch = () => {
          void realPatch(id, patch).then(resolve);
        };
        refuseThePatch = () => {
          reject(new Error('forbidden'));
        };
      });
    };
    const realCreate = api.createWorkItem.bind(api);
    api.createWorkItem = (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      asked.push('create');
      return realCreate(projectId, input);
    };

    const cell = nameOf(at);
    cell.focus();
    fireEvent.change(cell, { target: { value: `${cell.value} the trim` } });
    // The blur is what starts the request the chord will have to wait for.
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(asked).toEqual(['patch']);
    });
    // Back in the cell, having typed nothing: the sequence the finding names.
    cell.focus();
    return {
      api,
      asked,
      cell,
      landThePatch: () => {
        landThePatch();
      },
      refuseThePatch: () => {
        refuseThePatch();
      },
    };
  }

  /** Turns of the microtask queue, enough for anything that never waited. */
  const letTheLoopRun = () =>
    act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });

  itDom(
    'a chord waits for the blur’s patch that is still out, and a refusal makes nothing',
    async () => {
      // codex round 2, finding 1. The dedup in rule 5 answered `unsent`
      // immediately, which is the one answer that is not true here: the request
      // *is* out, and the chord's whole contract is that a refused save leaves
      // the caret where it was with nothing created.
      //
      // Proof: `return sent.current.landing` put back as `return unsent()`, this
      // failed on `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]` —
      // a row created against a request nobody had heard back from. Watched,
      // 2026-08-08.
      const { asked, cell, refuseThePatch } = await patchHeldOpen('030');

      nextOrCreate(cell);
      await letTheLoopRun();

      // Nothing while it hangs: no create, and the caret has not moved.
      expect(asked).toEqual(['patch']);
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(document.activeElement).toBe(cell);

      refuseThePatch();
      await waitFor(() => {
        expect(toastTexts()).toContain(
          'That change could not be completed: this plan is not yours to change.',
        );
      });
      await letTheLoopRun();

      // The refusal is the chord's answer as much as the blur's: nothing made,
      // nowhere moved, and the only copy of what was typed still in the box for
      // rule 4 to hold.
      expect(asked).toEqual(['patch']);
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(document.activeElement).toBe(cell);
      expect(cell.value).toBe('Paint the trim');
    },
  );

  itDom('…and moves on once that patch lands', async () => {
    // The other half: waiting is not refusing. When the request the chord
    // joined comes back landed, the move it was holding happens.
    //
    // Proof: the same line put back as `return unsent()`, this failed on
    // `expected <textarea …></textarea> to be <textarea …></textarea>` — the
    // focus already in 020 while the save was still out. Watched, 2026-08-08.
    const { cell, landThePatch } = await patchHeldOpen('010');

    nextOrCreate(cell);
    await letTheLoopRun();

    expect(document.activeElement).toBe(cell);

    landThePatch();

    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(nameOf('010').value).toBe('Strip the trim');
  });

  itDom('Ctrl+H, J, K and L move between cells from a caret no arrow could leave', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    // Mid-text in a box that holds the notes as well: every arrow belongs to
    // the text here, which is exactly what these four are for.
    cell.setSelectionRange(2, 2);

    chord(cell, 'j', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('030'));
    });

    chord(focused(), 'k', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(nameOf('020'));
    });

    // Sideways, in the trio — where every box is a cell of the grid and none
    // of them opens a list. The picker cells are the matrix's own rows below.
    const optimistic = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 020');
    optimistic.focus();
    fireEvent.change(optimistic, { target: { value: '3' } });
    optimistic.setSelectionRange(1, 1);

    chord(optimistic, 'l', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev realistic for 020'));
    });

    chord(focused(), 'h', { ctrl: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(optimistic);
    });
  });

  itDom('a chord at the grid’s edge is consumed rather than leaking to the browser', async () => {
    // Ctrl+H in Chrome is the history. A chord this table advertises must never
    // reach it, edge or no edge — so the key is taken whether or not it moved.
    await threeRoots();
    const cell = nameOf('010');
    cell.focus();

    const event = createEvent.keyDown(cell, { key: 'h', code: 'KeyH', ctrlKey: true });
    fireEvent(cell, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cell);
  });

  itDom('Ctrl+D twice deletes the row, and says Cmd+Z puts it back', async () => {
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain('Ctrl+D again deletes 020 — its children move up');
    });
    expect(armedRow()).toBe('020');

    releaseD(cell);
    armDelete(cell);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    expect(api.rows.map((row) => row.name)).toEqual(['Strip', 'Paint']);
    // The toast names the work item the way the plan does — its number **and**
    // its name (`work-items-named-by-number-and-name`) — so the number and the
    // join are asserted and the fixture's own name is left to the fixture.
    expect(toastTexts()).toContainEqual(
      expect.stringMatching(/^Deleted 020 - .+ — Cmd\+Z restores$/),
    );
    // The row that took its place, as the actions menu's delete does it.
    expect(document.activeElement).toBe(nameOf('020'));
    expect(armedRow()).toBeNull();
  });

  itDom('a held Ctrl+D never deletes, however long it is held', async () => {
    // The repeat guard. A held key arms once and can never confirm: there is
    // no keyup between the presses, and a repeat is not a press.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    for (let press = 0; press < 5; press += 1) armDelete(cell, true);

    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom(
    'a repeat after the confirming press does not arm the row that took its place',
    async () => {
      // What `event.repeat` uniquely buys: the key is still down when the row
      // goes, and the repeats that follow must not arm whatever slid up into it.
      // Proof: the `repeat` guard removed, this failed on `expected '020' to be
      // null` — the row that slid up into the gap armed by a key nobody pressed
      // again. Watched, 2026-08-08.
      const api = await threeRoots();
      const cell = nameOf('020');
      cell.focus();
      armDelete(cell);
      releaseD(cell);
      armDelete(cell);
      await waitFor(() => {
        expect(api.rows).toHaveLength(2);
      });

      armDelete(focused(), true);
      armDelete(focused(), true);

      expect(armedRow()).toBeNull();
    },
  );

  itDom('two presses with no release between them only re-arm', async () => {
    // The keyup guard, on its own. Two keydowns and no keyup is what a held
    // key looks like on a browser that does not set `repeat` — and what two
    // keyboards produce. Dany's rule is that D must be *released* between the
    // presses, so this can never be a delete.
    // Proof: the `dReleased` conjunct dropped from the confirm, this failed on
    // `expected null to be '020'` — one gesture destroying a row, so there was
    // no arm left to find. Watched, 2026-08-08.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    armDelete(cell);

    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
  });

  itDom('arming 020 and pressing Ctrl+D on 030 arms 030 and deletes neither', async () => {
    // Proof: the same-row check dropped, this failed on `expected null to be
    // '030'` — the second press deleting the row the first one had armed
    // rather than arming the one it was actually pressed in. Watched,
    // 2026-08-08.
    const api = await threeRoots();
    armDelete(nameOf('020'));
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    releaseD(nameOf('020'));

    armDelete(nameOf('030'));

    await waitFor(() => {
      expect(armedRow()).toBe('030');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('any other keystroke disarms it, and a modifier on its own does not', async () => {
    // agy #9: holding Control down to press the second D is a `Control`
    // keydown of its own, and disarming on it would make the chord unusable.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    releaseD(cell);

    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
      fireEvent.keyDown(cell, { key, code: key });
    }
    expect(armedRow()).toBe('020');

    fireEvent.keyDown(cell, { key: 'x', code: 'KeyX' });

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    armDelete(cell);
    // Re-armed rather than confirmed: the arm it would have confirmed is gone.
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('the arm toast leaves with the arm, however the arm ends', async () => {
    // The sentence is a promise about one row — "Ctrl+D again deletes 020" —
    // and it was pushed independently of the state that made it true, so it sat
    // on screen for its whole five seconds after the arm had gone. Observed
    // live on 2026-08-09, next to a row that was no longer armed.
    //
    // Proof: `dismissToast` dropped from the armed-state effect's cleanup, this
    // failed on `expected [ 'Ctrl+D again deletes 020 — its children move up' ]
    // not to include 'Ctrl+D again deletes 020 — its children move up'`.
    // Watched, 2026-08-09.
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });

    fireEvent.keyDown(cell, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    expect(toastTexts()).not.toContain(armSays('020'));

    // And again for the other way out, because the arm is a fresh object per
    // press: the toast has to come back and then leave a second time.
    releaseD(cell);
    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });

    fireEvent.focusOut(cell);
    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
    expect(toastTexts()).not.toContain(armSays('020'));
  });

  itDom('the arm toast leaves when the delete it promised happens', async () => {
    // The pair seen together live: `Deleted 050 — Cmd+Z restores` under
    // `Ctrl+D again deletes 050 — its children move up`, one of them about a
    // row that no longer existed.
    const api = await threeRoots();
    const cell = nameOf('020');
    cell.focus();

    armDelete(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(armSays('020'));
    });
    releaseD(cell);
    armDelete(cell);

    await waitFor(() => {
      // The toast names the work item the way the plan does — its number **and**
      // its name (`work-items-named-by-number-and-name`) — so the number and the
      // join are asserted and the fixture's own name is left to the fixture.
      expect(toastTexts()).toContainEqual(
        expect.stringMatching(/^Deleted 020 - .+ — Cmd\+Z restores$/),
      );
    });
    expect(toastTexts()).not.toContain(armSays('020'));
    expect(api.rows).toHaveLength(2);
  });

  itDom('Escape disarms it', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    fireEvent.keyDown(cell, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
  });

  itDom('leaving the cell disarms it, however the focus went', async () => {
    await threeRoots();
    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    // A pointer-driven focus move, which is the one a keydown listener cannot
    // see. `focusout` is what the DOM says about it either way.
    fireEvent.focusOut(cell);

    await waitFor(() => {
      expect(armedRow()).toBeNull();
    });
  });

  itDom('a peer renumbering the armed row disarms it', async () => {
    // The arm holds the row's *id* and the number it promised to delete, and
    // both halves are read back on every refresh: "Ctrl+D again deletes 020"
    // stops being true the moment somebody else makes this row 030. The other
    // branch of the same expression is the row that has gone altogether — a
    // peer's delete — which cannot be asserted through the DOM, because a row
    // that is not rendered carries no tint to look for.
    //
    // Proof: the comparison replaced by `return armed`, this failed on
    // `expected '030' to be null` — a row still tinted, and a second Ctrl+D
    // still live, under a sentence that named a different work item. Watched,
    // 2026-08-08.
    const api = fakeApi();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    render(
      <WbsTable
        projectId="p1"
        api={api}
        subscribe={(_projectId, handlers) => {
          notify = handlers.onChange;
          return { seen: () => undefined, unsubscribe: () => undefined };
        }}
      />,
    );
    for (const number of ['010', '020']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    const cell = nameOf('020');
    cell.focus();
    armDelete(cell);
    await waitFor(() => {
      expect(armedRow()).toBe('020');
    });

    // Their new row, moved above the armed one, which renumbers it to 030.
    const theirs = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Theirs',
    });
    await api.moveWorkItem(theirs.id, null, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
    expect(armedRow()).toBeNull();
    // The sentence goes with the tint: it named 020, and there is no armed 020
    // any more for it to be true about.
    expect(toastTexts()).not.toContain(armSays('020'));
  });

  itDom('a frozen row refuses to arm and says how to unfreeze it', async () => {
    const api = await threeRoots();
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(api.rows[1]?.frozenNumber).toBe('020');
    });

    armDelete(nameOf('020'));

    await waitFor(() => {
      expect(toastTexts()).toContainEqual(
        expect.stringMatching(/^020 - .+ is frozen — unfreeze it first$/),
      );
    });
    expect(armedRow()).toBeNull();
  });

  itDom('a late create does not take the focus back off a cell somebody moved to', async () => {
    // codex's mechanism for the one-off chord leak seen live on 2026-08-09. A
    // structural edit records the cell to focus when its refetch lands, and
    // that intent used to fire whatever the reader had done in the meantime —
    // so a create still in flight yanked the caret out of a folded cell with
    // an open `@` list, closed the list, and the keys still being typed landed
    // in an ordinary cell and made a row.
    //
    // The wanted steals are the ones where the reader never left: Ctrl+N,
    // Alt+N, Cmd+Enter, Duplicate and Delete all still move the caret, and
    // their own tests are what say so.
    //
    // Proof: the staleness check dropped from both consumers, this failed on
    // `expected <textarea …>…</textarea> to be <input …>` — the caret pulled
    // into the new row's name, out of the box that was being typed in.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    let letTheCreateLand: () => void = () => {
      throw new Error('nothing was ever created');
    };
    const realCreate = api.createWorkItem.bind(api);
    api.createWorkItem = async (
      projectId: string,
      input: { parentId: string | null; afterId: string | null },
    ) => {
      await new Promise<void>((resolve) => {
        letTheCreateLand = resolve;
      });
      return realCreate(projectId, input);
    };

    // The command, from the last row so nothing above it is renumbered.
    const from = nameOf('030');
    from.focus();
    newItem(from);
    await waitFor(() => {
      expect(typeof letTheCreateLand).toBe('function');
    });

    // And now the reader goes somewhere else entirely and starts typing a
    // name into a folded step's cell, which opens the people list.
    const folded = screen.getByLabelText<HTMLInputElement>('QA estimate for 010');
    folded.focus();
    fireEvent.focus(folded);
    fireEvent.change(folded, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'QA assignee for 010' });

    await act(async () => {
      letTheCreateLand();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });

    // The row was made — the edit is not what is being refused here — and the
    // caret is still where the person put it, with the list still open under
    // the name they are halfway through.
    expect(api.rows).toHaveLength(4);
    expect(document.activeElement).toBe(folded);
    expect(folded.value).toBe('@Ada');
    expect(screen.getByRole('listbox', { name: 'QA assignee for 010' })).toBeDefined();
  });

  itDom(
    'every chord that makes or destroys a row is inert while the depends list is open',
    async () => {
      // The routing matrix's fourth row, narrowed by `table-mechanics`: an open
      // list still owns the chords that *act on a row*, and Escape is how it is
      // given back. The four motion chords are no longer among them — this box
      // opens its list on focus, so a rule that held only while it was shut held
      // for nobody, and `Ctrl+J and Ctrl+K walk the Depends on column with its
      // list open` is that half.
      const api = await threeRoots();
      const box = screen.getByLabelText('Add a dependency to 020');
      box.focus();
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '010' } });
      await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });

      newItem(box);
      nextOrCreate(box);
      armDelete(box);

      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(armedRow()).toBeNull();
      expect(document.activeElement).toBe(box);
      expect(api.rows).toHaveLength(3);
    },
  );

  itDom('the same chords work in that box once the list is closed', async () => {
    // The other half of the matrix row, and what makes the first half a rule
    // rather than a dead cell: closed, this box is a cell like any other.
    await threeRoots();
    const box = screen.getByLabelText('Add a dependency to 020');
    box.focus();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '010' } });
    await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });
    fireEvent.keyDown(box, { key: 'Escape' });

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
  });

  itDom(
    'every chord that makes or destroys a row is inert while a team picker’s list is open',
    async () => {
      // Narrowed with the depends box's twin above, and for the same reason: the
      // four motion chords leave this cell whether the list is up or not.
      const api = await threeRoots();
      const box = screen.getByLabelText('Service or team for 020');
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: 'Plat' } });
      await screen.findByRole('listbox', { name: 'Service or team for 020' });

      newItem(box);
      armDelete(box);

      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
      expect(armedRow()).toBeNull();
      expect(api.rows).toHaveLength(3);
    },
  );

  itDom('the same chords work in a picker whose list is closed', async () => {
    await threeRoots();
    const box = screen.getByLabelText('Service or team for 020');
    box.focus();

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
  });

  itDom('every chord is inert while the folded cell’s @ list is open', async () => {
    const api = await threeRoots();
    // Folded, which is where the `@` picker lives.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText('Dev estimate for 020');
    box.focus();
    // A name nobody has: the list offers to add them, which is a list.
    fireEvent.change(box, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    newItem(box);
    armDelete(box);

    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(armedRow()).toBeNull();
    expect(api.rows).toHaveLength(3);
  });

  /**
   * The chord as an open list receives it, so what it did there can be read.
   *
   * `createEvent` rather than `fireEvent.keyDown`, because half of "inert"
   * is that the key was **taken**: an open list that ignores Cmd+Enter and
   * lets it through to the browser has not consumed it.
   */
  const chordInto = (box: Element, key: string, modifiers: { meta?: boolean; alt?: boolean }) => {
    const event = createEvent.keyDown(box, {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      metaKey: modifiers.meta ?? false,
      altKey: modifiers.alt ?? false,
    });
    fireEvent(box, event);
    return event;
  };

  /** Every `assign` and `addPerson` the table asked for, in order. */
  const watchPeopleWrites = (api: ProjectApi): string[] => {
    // One array across two methods, because what this is about is the **order**
    // the two arrive in; the projections do the recording and each method's own
    // returned array is not read.
    const written: string[] = [];
    recordCalls(api, 'assignPerson', (id, stepId, personId) =>
      written.push(`assign ${id} ${stepId} ${String(personId)}`),
    );
    recordCalls(api, 'addPerson', (name) => written.push(`addPerson ${name}`));
    return written;
  };

  itDom('Cmd+Enter in an open team picker takes no entry and creates none', async () => {
    // codex round 2, finding 2. The `!open` guard kept the chord away from the
    // table's handler and stopped there: the bare `e.key === 'Enter'` branch
    // underneath reads no modifiers, so the chord went on to choose the first
    // entry — or to create one out of a half-typed search.
    //
    // Proof: the `commandChord` consume guard removed from
    // `creatable-picker.tsx`, this failed on `expected 'team1' to be null` —
    // 020 labelled with a team by a keystroke aimed at the plan. Watched,
    // 2026-08-08.
    const api = await threeRoots();
    // A team on offer, made the way a person makes one: bare Enter still does.
    const first = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'Platform' } });
    fireEvent.keyDown(first, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe('team1');
    });

    const box = screen.getByLabelText('Service or team for 020');
    fireEvent.focus(box);
    // Matches `Platform` without being it, so the list holds both an entry to
    // choose and an `Add “Plat”` to create.
    fireEvent.change(box, { target: { value: 'Plat' } });
    await screen.findByRole('listbox', { name: 'Service or team for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    // No assignment, no entry created, and no work item either.
    expect(api.rows[1]?.serviceTeamId).toBeNull();
    expect(await api.listTeams()).toHaveLength(1);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    // The search is still there to go on typing: consumed is not cleared.
    expect(box).toHaveValue('Plat');
  });

  itDom('creating a second team sends and reloads the whole team set', async () => {
    const api = await threeRoots();
    const patches = recordCalls(api, 'patchWorkItem', (id, patch) => ({ id, patch }));

    const createTeam = async (name: string, expected: readonly string[]): Promise<void> => {
      const box = screen.getByRole('combobox', { name: 'Service or team for 020' });
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: name } });
      fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' });
      await waitFor(() => {
        expect(api.rows[1]?.teamIds).toEqual(expected);
      });
    };

    await createTeam('Platform', ['team1']);
    await createTeam('Release', ['team1', 'team2']);

    // be-01 projects the stable first member for old readers; the set is the
    // source of truth and creating the second member must not replace it.
    expect(api.rows[1]?.serviceTeamId).toBe('team1');
    expect(patches.at(-1)).toMatchObject({
      id: api.rows[1]?.id,
      patch: { teamIds: ['team1', 'team2'] },
    });

    // A refetch is part of every `run`. Querying the rendered row again proves
    // the second write survived that round trip rather than only being the
    // payload observed on the way out. Both members remain reachable as chips;
    // the adjacent box is only the add path and therefore remains empty.
    expect(screen.getByRole('button', { name: 'Remove Platform team' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Release team' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Service or team for 020' })).toHaveValue('');
  });

  itDom('Cmd+Enter in an open assignee picker assigns nobody and adds nobody', async () => {
    // The same component, the other column it is rendered in — and the writes
    // it would have made are recorded rather than inferred.
    //
    // Proof: the same guard removed, this failed on `expected [ 'assign w2
    // step-dev person1' ] to deeply equal []`. Watched, 2026-08-08.
    const api = await threeRoots();
    const first = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: 'Kateryna' } });
    fireEvent.keyDown(first, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Dev assignee for 010')).toHaveValue('Kateryna');
    });
    const written = watchPeopleWrites(api);

    const box = screen.getByLabelText('Dev assignee for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Kat' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(written).toEqual([]);
    expect(await api.listPeople()).toHaveLength(1);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter in the open depends list adds no dependency', async () => {
    // Both of the box's Enter flows are in range here: an entry is highlighted
    // *and* the typed text is a number a person could have meant.
    //
    // Proof: the consume guard removed from the depends `onKeyDown`, this
    // failed on `expected null not to be null` — 020 waiting for 010 on a
    // chord nobody aimed at the list. Watched, 2026-08-08.
    await threeRoots();
    const box = screen.getByLabelText('Add a dependency to 020');
    box.focus();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '010' } });
    await screen.findByRole('listbox', { name: 'Work items 020 can depend on' });
    const highlighted = box.getAttribute('aria-activedescendant');
    expect(highlighted).toBe('dep-option-w1');

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByLabelText('Stop 020 waiting for 010')).toBeNull();
    // Nothing about the list moved either: same search, same highlight.
    expect(box).toHaveValue('010');
    expect(box.getAttribute('aria-activedescendant')).toBe(highlighted);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('Cmd+Enter in the folded cell’s open @ list assigns nobody', async () => {
    // Proof: the consume guard removed from the folded cell's `onKeyDown`,
    // this failed on `expected [ 'assign w2 step-dev person1' ] to deeply
    // equal []`. Watched, 2026-08-08.
    const api = await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const first = await screen.findByLabelText('Dev estimate for 010');
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: '@Kateryna' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-folded-assignee="step-dev"]')).not.toBeNull();
    });
    fireEvent.blur(first);
    const written = watchPeopleWrites(api);

    const box = screen.getByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@Kat' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const event = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(event.defaultPrevented).toBe(true);
    expect(written).toEqual([]);
    expect(await api.listPeople()).toHaveLength(1);
    expect(rowFor('020').querySelector('[data-folded-assignee="step-dev"]')).toBeNull();
    // The mention was not taken out of the box, because nothing was taken.
    expect(box.value).toBe('@Kat');
  });

  itDom('Alt+arrows in the folded cell’s open @ list move no row', async () => {
    // The one open list wired to `onAltMove`, and the finding's second half: a
    // structural move is not something an open people picker may perform.
    //
    // Proof: the consume guard removed, this failed on `expected [ 'Strip',
    // 'Paint', 'Sand' ] to deeply equal [ 'Strip', 'Sand', 'Paint' ]` — the
    // row reordered under a half-typed name search. Watched, 2026-08-08.
    await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@Ada' } });
    await screen.findByRole('listbox', { name: 'Dev assignee for 020' });

    const down = chordInto(box, 'ArrowDown', { alt: true });
    await letTheLoopRun();
    const right = chordInto(box, 'ArrowRight', { alt: true });
    await letTheLoopRun();

    expect(down.defaultPrevented).toBe(true);
    expect(right.defaultPrevented).toBe(true);
    // Neither moved among its siblings nor indented under one.
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(box.value).toBe('@Ada');
  });

  itDom('every chord is inert on a mention that has nobody to offer', async () => {
    // The keyboard's half of agy round 3, finding 7, which round 4 caught: the
    // card learned to read the mention and this branch was still counting the
    // entries. A deployment with nobody in it answers a bare `@` with no
    // entries at all, so `options.length > 0` was false, the `else` handed the
    // keyboard back, and Alt+ArrowDown moved the row while a mention owned the
    // cell — the exact fault round 2 wrote this guard for, through the one hole
    // it left open. The hole predates this change; it is on the merge-base at
    // `75d01a8`, where the same branch counts entries. What is this change's is
    // that the two guards diverged, and so is the fix.
    //
    // Proof: the branch put back to `options.length > 0`, this failed on
    // `expected [ 'Strip', 'Paint', 'Sand' ] to deeply equal [ 'Strip', 'Sand',
    // 'Paint' ]` — the row reordered under a half-typed mention. Watched,
    // 2026-08-09.
    const api = await threeRoots();
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    const box = await screen.findByLabelText<HTMLInputElement>('Dev estimate for 020');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '@' } });

    // Nobody to offer, so no list is drawn — which is the state the old branch
    // read as "no mention here". The mention is open all the same.
    expect(screen.queryByRole('listbox', { name: 'Dev assignee for 020' })).toBeNull();

    const down = chordInto(box, 'ArrowDown', { alt: true });
    await letTheLoopRun();
    const created = chordInto(box, 'Enter', { meta: true });
    await letTheLoopRun();

    expect(down.defaultPrevented).toBe(true);
    expect(created.defaultPrevented).toBe(true);
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
    expect(box.value).toBe('@');
  });

  itDom('every chord is inert while a row’s ⋯ menu is open', async () => {
    const api = await threeRoots();
    openRowMenu('020');
    const item = screen.getByRole('menuitem', { name: 'Duplicate' });

    newItem(item);
    nextOrCreate(item);
    armDelete(item);

    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(armedRow()).toBeNull();
    expect(api.rows).toHaveLength(3);
  });

  itDom('⌘+Z is inert while a row’s ⋯ menu is open, and works again once it closes', async () => {
    // `CONTEXT.md`: the ⋯ menu *"owns the keyboard while it is open"*. The
    // modal path held the page's own chords back and the menu path did not, so
    // ⌘+Z through an open menu ran an undo behind it — the menu stayed open,
    // the toast read `Undid: rename “Roof it”` and a row two down came back
    // off. Observed live twice on 2026-08-09, with `[role="menu"]` asserted in
    // the DOM at the moment of the keypress.
    //
    // Proof: `usePageShortcutsSuspended(open)` pinned to `false` in
    // `ActionsMenu`, this failed on `expected [ 'undo' ] to deeply equal []`.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });
    openRowMenu('020');
    const item = screen.getByRole('menuitem', { name: 'Duplicate' });

    fireEvent.keyDown(item, { key: 'z', ctrlKey: true });

    expect(api.stackCalls).toEqual([]);
    expect(toastTexts()).toEqual([]);
    // Still open: the chord was swallowed, not turned into a dismissal.
    expect(screen.getByRole('menu', { name: 'Actions for 020' })).toBeDefined();

    // And the other half, which is what makes the first half a rule rather than
    // an undo that never worked: Escape closes the menu and the chord is the
    // page's again.
    fireEvent.keyDown(item, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('table'), { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
  });

  itDom('the date cell answers the chords, and keeps its own arrows', async () => {
    const api = await threeRoots();
    typeIntoDate('Project start date', '2026-08-10');
    const box = await screen.findByLabelText('Earliest start for 020');
    await waitFor(() => {
      expect(box).toHaveProperty('disabled', false);
    });
    box.focus();

    newItem(box);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040']);
    });
    expect(api.rows).toHaveLength(4);
  });
});

/**
 * The eight keys that must work from **every** cell, pickers open included.
 *
 * The cheat sheet promises Ctrl+H/J/K/L "between cells" and the Alt+arrows
 * "from any cell and any caret position", both unqualified — and three cell
 * classes answered none of them. Every cell here is asserted in all four
 * directions, once per class, because "the chords are wired" was true of the
 * Name cell and false of these while one sentence covered both.
 *
 * The picker cells are asserted with their list **open**, which is the state
 * a reader is always in: focusing either box opens its list, so a rule that
 * only holds while the list is shut is a rule that never holds. The chords
 * that create and destroy are still the open list's to swallow — that half is
 * `every chord that makes or destroys a row is inert while … is open`.
 */
describe('the chords reach the picker cells and the date cell', () => {
  beforeEach(showEveryColumn);

  const chord = (box: Element, key: string, modifiers: { ctrl?: boolean; alt?: boolean }) =>
    fireEvent.keyDown(box, {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
    });

  /** The Depends on box of one row, with its list open — which is how focus leaves it. */
  const openDepends = async (number: string): Promise<HTMLElement> => {
    const box = screen.getByLabelText(`Add a dependency to ${number}`);
    box.focus();
    fireEvent.focus(box);
    await screen.findByRole('listbox', { name: `Work items ${number} can depend on` });
    return box;
  };

  /**
   * Three roots and one team, which is what makes the Service/team box open on
   * a bare focus: a picker with nothing to offer and nothing typed stays shut,
   * and a plan with no teams in it is not the state this block is about.
   */
  const threeRootsAndATeam = async () => {
    const api = await threeRoots();
    const box = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Platform' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The chip is the landing, not the box: the box beside a stated set is the
    // add path and holds nothing (`reference-set-field.tsx`, 4b.4).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove Platform team' })).toBeInTheDocument();
    });
    fireEvent.blur(box);
    return api;
  };

  /**
   * One row's Service/team box.
   *
   * By role, because an open `CreatablePicker` gives its listbox the same
   * accessible name as its input — two elements answer to `Service or team for
   * 020` while the list is up, and only one of them is the box.
   */
  const teamBox = (number: string): HTMLElement =>
    screen.getByRole('combobox', { name: `Service or team for ${number}` });

  /** The Service/team box of one row, with its list open. */
  const openTeam = async (number: string): Promise<HTMLElement> => {
    const box = teamBox(number);
    box.focus();
    fireEvent.focus(box);
    // A shared set excludes already-selected teams from its offers. Type a
    // fresh name so this helper still proves the grid chords with a list open.
    fireEvent.change(box, { target: { value: 'next team' } });
    await screen.findByRole('listbox', { name: `Service or team for ${number}` });
    return box;
  };

  /** A plan on a calendar, so the earliest-start cells are not disabled. */
  const datedThreeRoots = async () => {
    const api = await threeRoots();
    typeIntoDate('Project start date', '2026-08-10');
    await waitFor(() => {
      expect(screen.getByLabelText('Earliest start for 020')).toHaveProperty('disabled', false);
    });
    return api;
  };

  itDom('Ctrl+H and Ctrl+L leave the Depends on cell with its list open', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });

    const back = await openDepends('020');
    chord(back, 'l', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Depends on column with its list open', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 030'));
    });

    const back = await openDepends('020');
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Add a dependency to 010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Depends on cell', async () => {
    await threeRoots();
    const box = await openDepends('010');

    chord(box, 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    const up = await openDepends('020');
    chord(up, 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Depends on cell', async () => {
    await threeRoots();
    const box = await openDepends('020');

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = await openDepends('010.1');
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Ctrl+H and Ctrl+L leave the Service/team cell with its list open', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Priority for 020'));
    });

    const back = await openTeam('020');
    chord(back, 'l', { ctrl: true });

    // The Tags cell, which stands beside the team when every column is shown:
    // the chord goes to the next cell of the row, whatever that is.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Tags for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Service/team column with its list open', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(teamBox('030'));
    });

    const back = await openTeam('020');
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(teamBox('010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Service/team cell', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('010');

    chord(box, 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    const up = await openTeam('020');
    chord(up, 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Service/team cell', async () => {
    await threeRootsAndATeam();
    const box = await openTeam('020');

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = await openTeam('010.1');
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from an assignee cell', async () => {
    // The third `CreatablePicker` in this table, and the reason the fix is that
    // component's rather than the Service/team column's.
    await threeRoots();
    const box = screen.getByLabelText('Dev assignee for 020');
    box.focus();
    fireEvent.focus(box);

    chord(box, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const out = screen.getByLabelText('Dev assignee for 010.1');
    out.focus();
    fireEvent.focus(out);
    chord(out, 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Ctrl+H and Ctrl+L move out of the Not before cell', async () => {
    await datedThreeRoots();
    const box = screen.getByLabelText('Earliest start for 020');
    box.focus();

    chord(box, 'h', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 020'));
    });
  });

  itDom('Ctrl+J and Ctrl+K walk the Not before column', async () => {
    await datedThreeRoots();
    const box = screen.getByLabelText('Earliest start for 020');
    box.focus();

    chord(box, 'j', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 030'));
    });

    const back = screen.getByLabelText('Earliest start for 020');
    back.focus();
    chord(back, 'k', { ctrl: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
    });
  });

  itDom('Alt+↑ and Alt+↓ move the row from the Not before cell', async () => {
    await datedThreeRoots();

    chord(screen.getByLabelText('Earliest start for 010'), 'ArrowDown', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Sand', 'Strip', 'Paint']);
    });

    chord(screen.getByLabelText('Earliest start for 020'), 'ArrowUp', { alt: true });

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);
    });
  });

  itDom('Alt+→ and Alt+← restructure the row from the Not before cell', async () => {
    await datedThreeRoots();

    chord(screen.getByLabelText('Earliest start for 020'), 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    chord(screen.getByLabelText('Earliest start for 010.1'), 'ArrowLeft', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    });
  });

  itDom('Alt+→ restructures the row from an open Not before editor', async () => {
    // The editor is a different element from the cell at rest, wired through
    // `DateField` — a cell class the at-rest tests above cannot speak for.
    await datedThreeRoots();
    const editor = openNotBefore('020');

    chord(editor, 'ArrowRight', { alt: true });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });
});
