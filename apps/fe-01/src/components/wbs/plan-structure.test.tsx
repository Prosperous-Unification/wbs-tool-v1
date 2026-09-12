import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import type * as TableFrameModule from './table-frame';
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

/**
 * Opens a row's ⋯ menu and takes one of its items.
 *
 * The items are named plainly — `Duplicate`, not `Duplicate 010` — which is
 * only unambiguous because one menu is open at a time. That rule is the subject
 * of `opening one row’s menu closes the one already open`; if it broke, every
 * use of this helper would fail on two elements with the same name.
 */
const takeRowAction = (number: string, label: string) => {
  openRowMenu(number);
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
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

describe('duplicating a branch', () => {
  /** A one-row project, already loaded, so the button has something to copy. */
  async function shownRow(api: ProjectApi): Promise<void> {
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  itDom('copies the branch and lands the caret in the copy’s name', async () => {
    const api = fakeApi();
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    await api.createWorkItem('p1', {
      parentId: api.rows[0]?.id ?? null,
      afterId: null,
      name: 'Sockets',
    });
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020', '020.1']);
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Strip (copy)');
    expect(screen.getByLabelText('Name of 020.1')).toHaveProperty('value', 'Sockets');
    // Proof: with the `focusNext` write removed from `duplicateRow`, this
    // failed with the focus left on the Duplicate button. Watched 2026-08-07,
    // and again on 2026-08-08 once the button became the ⋯ the menu returns
    // the focus to.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
  });

  itDom('offers Duplicate on a frozen row, which cannot be moved', async () => {
    // Freezing stops a row moving, not a row being copied — the copy gets no
    // frozen number of its own, so nothing that left the tool is duplicated.
    const api = fakeApi();
    await shownRow(api);

    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getByLabelText('Number is frozen')).toBeDefined();
    });

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('says why a duplication was refused, and copies nothing', async () => {
    const api = fakeApi();
    await shownRow({
      ...api,
      duplicateWorkItem: () => Promise.reject(new Error('too_large')),
    });

    takeRowAction('010', 'Duplicate');

    await waitFor(() => {
      expect(toastTexts()).toContain('That change could not be completed (too_large).');
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });
});

describe('the row actions menu', () => {
  /** Three root rows, named, already on screen. */
  async function threeRows(api: ProjectApi): Promise<void> {
    for (const name of ['Strip', 'Sand', 'Paint']) {
      await api.createWorkItem('p1', { parentId: null, afterId: null, name });
    }
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 030');
  }

  itDom('offers Duplicate and Delete on an ordinary row', async () => {
    const api = fakeApi();
    await threeRows(api);

    openRowMenu('020');

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Duplicate',
      'Delete',
    ]);
    expect(screen.getByRole('button', { name: 'Actions for 020' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  itDom('opening one row’s menu closes the one already open', async () => {
    // One menu at a time, and it is not decoration: two open menus are two
    // `Duplicate` items with the same accessible name, which is ambiguous to a
    // screen reader and to `getByRole` alike.
    // Proof: the cell's `open` widened to `openMenuRowId !== null`, so every
    // row's menu opened at once: **11 tests failed**, this one on `Found
    // multiple elements with the role "menuitem" and name "Duplicate"`.
    // Watched, 2026-08-08.
    const api = fakeApi();
    await threeRows(api);

    openRowMenu('010');
    openRowMenu('020');

    expect(screen.getByRole('button', { name: 'Actions for 010' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeDefined();
  });

  itDom('promotes the children of a parent it deletes', async () => {
    const api = fakeApi();
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    await api.createWorkItem('p1', {
      parentId: api.rows[0]?.id ?? null,
      afterId: null,
      name: 'Sockets',
    });
    await api.createWorkItem('p1', {
      parentId: null,
      afterId: api.rows[0]?.id ?? null,
      name: 'Sand',
    });
    const removed = recordCalls(api, 'removeWorkItem');
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010.1');

    takeRowAction('010', 'Delete');

    await waitFor(() => {
      expect(removed).toHaveLength(1);
    });
    // The rule the two buttons had and this menu keeps: a branch's children
    // move up rather than being deleted with the row above them.
    expect(removed[0]?.[1]).toEqual({ strategy: 'promote' });
  });

  itDom('sends no strategy for a leaf, which has nothing to promote', async () => {
    const api = fakeApi();
    const removed = recordCalls(api, 'removeWorkItem', (_id, options) => options);
    await threeRows(api);

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(removed).toHaveLength(1);
    });
    expect(removed[0]).toEqual({ strategy: undefined });
  });

  itDom('lands the caret in the next sibling’s name after a delete', async () => {
    const api = fakeApi();
    await threeRows(api);

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // 030 was renumbered 020 by the delete: the row that took its place, which
    // is where typing carries on.
    // Proof: the `focusNext` write removed from `deleteRow`, this and the
    // last-row test below both failed on `expected <body>…</body> to be
    // <textarea …>` — the deleted row took the ⋯ button the focus had been
    // given back to with it, so there was nothing left holding it. Watched,
    // 2026-08-08.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Paint');
  });

  itDom('lands the caret in the row above when the last row is deleted', async () => {
    const api = fakeApi();
    await threeRows(api);

    takeRowAction('030', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Proof: `?? above` dropped, leaving only the next sibling, this failed
    // alone on `expected <body>…</body> to be <textarea …>` — the last row has
    // no sibling below it. Watched, 2026-08-08.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Sand');
  });

  itDom('says why a delete was refused, moves the focus nowhere and deletes nothing', async () => {
    const api = fakeApi();
    await threeRows({ ...api, removeWorkItem: () => Promise.reject(new Error('forbidden')) });

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    // Proof: `focusNext` assigned before the `await` rather than after it, this
    // failed on `expected <textarea …> to be <button …>` — the caret in the
    // name of a row nobody deleted. Watched, 2026-08-08.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for 020' }));
  });

  itDom('gives the focus back to the ⋯ button after unfreezing', async () => {
    const api = fakeApi();
    await threeRows(api);
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    takeRowAction('020', 'Unfreeze');

    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(2);
    });
    // Nothing was created or removed, so nothing claims the caret: the menu's
    // own rule — closes, and gives the focus back where it came from — is the
    // whole answer here.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for 020' }));
  });

  itDom('keeps Delete on a frozen row, refused and saying why', async () => {
    // It used to be absent, and absent explains nothing: a reader who saw
    // Delete on this menu a minute ago had nothing on screen telling them the
    // freeze is what took it away. Present, refused, and carrying the reason —
    // the same answer the drag handle gives on a frozen row.
    const api = fakeApi();
    await threeRows(api);
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    openRowMenu('020');

    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('data-fact')).toBe('Frozen — unfreeze this row before deleting it');
    expect(screen.getByRole('menuitem', { name: 'Unfreeze' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeDefined();

    // And it really is refused. The item carries the real `deleteRow`, so this
    // is the whole guard: with `refusedBecause` unread in `takeAction` the row
    // goes.
    // Proof: the `refusedBecause` line removed from `takeAction`, this failed
    // on `expected [ { id: 'w1', …(16) }, …(1) ] to have a length of 3 but got
    // 2`. Watched, 2026-08-09.
    fireEvent.click(remove);
    await Promise.resolve();
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
    expect(api.rows).toHaveLength(3);
    // The menu stays open, because the sentence saying why is on the item.
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDefined();
  });
});

describe('collapsing a branch', () => {
  itDom('hides the children of a collapsed parent and brings them back', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    unfoldStep('Dev');

    click('Collapse 010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    // The parent is still there and still shows its rolled-up figures; only the
    // work beneath it is folded away.
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();

    click('Expand 010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
  });

  itDom('offers no expander on a leaf', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');

    expect(screen.queryByLabelText('Collapse 010')).toBeNull();
    expect(screen.queryByLabelText('Expand 010')).toBeNull();
  });
});

describe('dragging a row', () => {
  itDom('makes the dragged row a child of the row it is dropped into', async () => {
    await threeRoots();
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);

    // The middle half of the row is "into". jsdom lays nothing out, so the
    // geometry is pinned; the arithmetic itself is `zoneFor`'s own test.
    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 20);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
  });

  itDom('puts the row above the target when dropped on its top quarter', async () => {
    const api = await threeRoots();
    expect(namesOnScreen()).toEqual(['Strip', 'Sand', 'Paint']);

    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 2);

    await waitFor(() => {
      expect(namesOnScreen()).toEqual(['Paint', 'Strip', 'Sand']);
    });
    // Moved, not copied: the same three rows, still at the root.
    expect(api.rows).toHaveLength(3);
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('drags a frozen row like any other, and keeps its number', async () => {
    // The inverse of the case that stood here until ADR 0023, and the one that
    // had to drag for real: an earlier version fired a `drop` with no
    // `dragstart`, so `dropOn` returned on its null check and the frozen rule
    // was never reached — deleting that rule left it passing. Both reviewers
    // found it. It still drags for real; what changed is the answer.
    const api = await threeRoots();
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });
    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    // The handle carries no refusal now, and says what it is for.
    const handle = screen.getByLabelText('Reorder 030');
    expect(handle.getAttribute('data-fact')).toBeNull();
    expect(handle.getAttribute('aria-disabled')).toBeNull();
    expect(handle.getAttribute('data-hint')).toContain('Drag');

    withHeight(rowFor('010'), 0, 40);
    dragOnto('030', '010', 20);

    await waitFor(() => {
      expect(moved).toHaveLength(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('refuses a drop inside the dragged row’s own subtree, with the reason', async () => {
    const api = await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    withHeight(rowFor('010.1'), 0, 40);
    dragOnto('010', '010.1', 20);

    expect(moved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('inside itself');
  });

  itDom('sends nothing when a row is dropped where it already is', async () => {
    const api = await threeRoots();
    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    // The bottom quarter of the row directly above it.
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 38);

    expect(moved).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the drag handle as assistive technology meets it', () => {
  itDom('is a control with a step and a name, not a decorated span', async () => {
    // It was a bare `<span aria-label="Reorder">` with no `role` and no
    // `tabindex` — a label on nothing, which is what a screen reader is handed.
    // ⌥+arrows are the keyboard route to reordering, so the handle is
    // deliberately out of the tab order; what it is not allowed to be is
    // stepless.
    await threeRoots();

    const handle = screen.getByLabelText('Reorder 020');

    expect(handle.getAttribute('role')).toBe('button');
    expect(handle.getAttribute('tabindex')).toBe('-1');
    expect(handle.getAttribute('data-hint')).toBe('Drag to move this row');
    expect(handle).toHaveProperty('draggable', true);
  });

  itDom('offers a frozen row the same grip as any other', async () => {
    // Until ADR 0023 this asserted `aria-disabled="true"` and a `data-fact`
    // reading "Frozen — unfreeze this row before moving it". be-01 refused the
    // move then, and a handle that looked usable and was not would have been
    // the worse half of that. Neither is true now.
    await threeRoots();
    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(screen.getAllByLabelText('Number is frozen')).toHaveLength(3);
    });

    const handle = screen.getByLabelText('Reorder 020');

    expect(handle.getAttribute('aria-disabled')).toBeNull();
    expect(handle.getAttribute('data-fact')).toBeNull();
    expect(handle.getAttribute('data-hint')).toBe('Drag to move this row');
  });
});

describe('what a drag shows while it is happening', () => {
  itDom('marks the row and the zone the drop would land in', async () => {
    // The marker is not decoration: the drop uses the zone the last dragover
    // worked out, so what is drawn and what happens are the same decision.
    await threeRoots();
    withHeight(rowFor('010'), 0, 40);

    fireEvent.dragStart(screen.getByLabelText('Reorder 030'));
    fireEvent(rowFor('010'), dragEvent('dragover', 2));
    expect(rowFor('010').getAttribute('data-drop')).toBe('above');

    fireEvent(rowFor('010'), dragEvent('dragover', 20));
    expect(rowFor('010').getAttribute('data-drop')).toBe('into');

    fireEvent.dragLeave(rowFor('010'));
    expect(rowFor('010').getAttribute('data-drop')).toBeNull();
  });

  itDom('opens a collapsed branch it is dropped into', async () => {
    // A row dropped into a closed branch is a row nobody can see, which reads
    // as a move that did nothing.
    await threeRoots();
    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    withHeight(rowFor('010'), 0, 40);
    dragOnto('020', '010', 20);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
    });
  });
});

describe('a drag interrupted by someone else', () => {
  itDom('is cancelled rather than left holding a row nobody picked up', async () => {
    // The browser does not reliably fire `dragend` on a source node replaced
    // mid-gesture, so `dragging` could stay set forever — after which moving the
    // pointer over the table drew drop markers and a click moved a row nobody
    // had picked up. And planning against the newest tree turns "below 010" into
    // a different move than the one that was on screen at pickup.
    const api = await threeRoots();
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    // Re-render with a subscription so a peer edit can be delivered.
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByLabelText(/^Reorder 0/)).toHaveLength(6);
    });

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };

    fireEvent.dragStart(screen.getAllByLabelText('Reorder 030')[1]);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    // The drop that follows belongs to a gesture that no longer exists.
    const target = withHeight(screen.getAllByRole('row').at(-1)!, 0, 40);
    fireEvent(target, dragEvent('dragover', 20));
    fireEvent(target, dragEvent('drop', 20));

    expect(moved).toEqual([]);
    // Said in a toast, and an `info` one: nobody's request was refused and
    // nothing was lost, so this is context that may take itself off again —
    // not a failure waiting to be dismissed.
    expect(toastTexts().at(-1)).toContain('changed while you were dragging');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
