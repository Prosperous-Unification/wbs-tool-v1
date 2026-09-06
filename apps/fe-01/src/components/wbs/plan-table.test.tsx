import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { DEV, fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import { hintFor } from './column-hints';
import type * as TableFrameModule from './table-frame';
import { WbsTable } from './wbs-table';

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

/**
 * What the column heading reading `text` says about itself in its `title`.
 *
 * The headings are a word or a mark each, so the sentence saying what the
 * column does to the plan lives in the tooltip rather than in the heading. Read
 * off the `<th>` itself since `wbs-column-hints`, which is where every column's
 * sentence is (`column-hints.ts`) — a descendant `[title]` would find whichever
 * control the heading happens to hold, and on a resizable column that is the
 * drag handle.
 */
const headerTitled = (text: string): string => {
  const header = screen.getAllByRole('columnheader').find((th) => th.textContent.trim() === text);
  if (header === undefined) throw new Error(`no column heading reads ${text}`);
  const hint = header.getAttribute('data-hint');
  if (hint === null) throw new Error(`the ${text} heading says nothing about itself`);
  return hint;
};

/**
 * Types a whole date into a date field and leaves it, which is what saves one.
 *
 * The blur is the commit, and it is not decoration here: {@link DateField}
 * holds everything typed while the box has the focus, because a native date
 * input fires a `change` per completed segment and committing each of them
 * saved a plan starting in year 0002. A test that fires the `change` alone is
 * asserting the browser's fault, not the field's behaviour.
 */
/**
 * Types the year `2026` into an open date box the way Chrome delivers it: a
 * `keydown` for the digit, then the `change` that digit completed — four dates,
 * in years 2, 20, 202 and 2026.
 *
 * The keydowns are not decoration. Since 2026-08-23 `DateField` sends a `change`
 * with **no key behind it** at once, because that is a day picked from the
 * calendar popup (`wbs-gantt-stale-on-start-date`) — so a version of this helper
 * that fired the four changes alone would be asking this table about a gesture
 * nobody performs, and would report the year-`0002` guard broken when it is
 * intact. Which gesture really produces a key is a browser's answer and
 * `e2e/keyboard.spec.ts` holds both halves of it.
 */
const typeYearInto = (box: HTMLInputElement): void => {
  for (const partial of ['0002-08-17', '0020-08-17', '0202-08-17', '2026-08-17']) {
    fireEvent.keyDown(box, { key: partial.slice(3, 4) });
    fireEvent.change(box, { target: { value: partial } });
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

/** Opens a row's earliest-start editor, types a day into it, and leaves. */
const typeIntoNotBefore = (number: string, day: string): void => {
  const editor = openNotBefore(number);
  fireEvent.change(editor, { target: { value: day } });
  fireEvent.blur(editor);
};

/**
 * Whatever a mark would open a card with, of **either** kind, or null for one
 * that has nothing to say.
 *
 * For the cases that assert a cell draws no *second* surface over its own
 * pixels — the Start cell, the folded step's figure and assignee, the depends
 * count and its Add button. Since `tool-hints-wait` such a surface could be
 * written as a hint or as a fact, so a check naming one of the two narrows
 * while the fault it guards widens: the words could come back in the other
 * attribute and every one of those cases would still be green.
 */
const saidBy = (node: Element | null | undefined): string | null =>
  node?.getAttribute('data-hint') ?? node?.getAttribute('data-fact') ?? null;

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

describe('the WBS table', () => {
  itDom('types a three-level breakdown without touching the mouse', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeName('010', 'Strip');

    // Ctrl+N makes a sibling; Tab makes that sibling a child of the row above.
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });

    typeName('010.1', 'Sockets');
    pressNewItem('010.1');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
    });

    pressTab('010.2');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
    });
  });

  itDom('gives the number cell words only when the number does not fit', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const numberCellOf = (number: string): Element => {
      const cell = rowFor(number).querySelector('td[data-column="number"] > span');
      if (cell === null) throw new Error(`no number cell for ${number}`);
      return cell;
    };

    // Dany, 2026-09-01: "also remove tooltips from # cells; why it needed?" —
    // and for `010` the card said `010`, which is what the cell already shows.
    // The words exist for the number the column **clips**, so a number that
    // fits carries none.
    //
    // Proof: the `NUMBER_ENVELOPE` length guard removed — the attribute spread
    // unconditionally — watched failing on `expected '010' to be null`.
    expect(numberCellOf('010').getAttribute('data-fact')).toBeNull();

    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    typeName('010.1', 'Sockets');
    pressNewItem('010.1');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
    });
    pressTab('010.2');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
    });

    // Three levels is one past `NUMBER_ENVELOPE`, which the column's width is
    // picked against — so this is the number `CELL`'s `overflow: hidden` clips,
    // and the card is the only way to read it whole.
    expect(numberCellOf('010.1.1').getAttribute('data-fact')).toBe('010.1.1');
    // And the level that still fits stays silent, which is what says the guard
    // is about the envelope rather than about depth.
    expect(numberCellOf('010.1').getAttribute('data-fact')).toBeNull();
  });

  /**
   * A planner typing out a backlog clicks faster than the round trip, and every
   * click has to become a row.
   *
   * Measured on dev by `wbs-e2e-planning-qa`, with trusted mouse events and the
   * button re-measured before every click: **6 clicks at 350ms produced 3 rows,
   * 4 clicks at 1500ms produced 4** — counted as `tbody tr` after a four-second
   * settle, so not a render race in the counter. The lost clicks are silent:
   * no toast, nothing queued, and the rows the planner thinks they made are
   * simply not there.
   *
   * **be-01 is not the one refusing.** `create` sends `{parentId, afterId,
   * name}` and carries no revision at all, so there is no stale-revision
   * conflict to lose the second write to — the drop happens on this client,
   * which is why this test lives here rather than on the route.
   *
   * The write is held open on purpose rather than left to timing. That is the
   * whole window under test: what a click does while the last one is still
   * being answered.
   */
  itDom('makes a row for every click on Add work item, including the ones mid-write', async () => {
    const api = fakeApi();
    const inFlight: (() => void)[] = [];
    // Everything else answers at once; only the create waits, so the busy
    // window is exactly one call wide and nothing else in the table is slowed.
    const slow: ProjectApi = {
      ...api,
      createWorkItem: async (projectId, input) => {
        await new Promise<void>((resolve) => {
          inFlight.push(resolve);
        });
        return api.createWorkItem(projectId, input);
      },
    };
    render(<WbsTable projectId="p1" api={slow} />);
    await screen.findByRole('button', { name: 'Add work item' });

    for (let i = 0; i < 6; i += 1) click('Add work item');

    // Answering is a loop rather than one release, because a serialised burst
    // sends its next write only once the last is answered — so waiting for a
    // write to appear, answering it, and waiting again is what a network doing
    // its job looks like from here. A client that dropped the other five runs
    // out of writes to answer and leaves the loop early, which is the shape of
    // the failure rather than a timeout.
    for (let answered = 0; answered < 6; answered += 1) {
      try {
        await waitFor(() => {
          expect(inFlight.length).toBeGreaterThan(0);
        });
      } catch {
        break;
      }
      for (const release of inFlight.splice(0)) release();
    }

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020', '030', '040', '050', '060']);
    });
  });

  itDom('keeps an add burst and its refetch inside the project where it started', async () => {
    const first = fakeApi();
    const second = fakeApi();
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const heldFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const forProject = (projectId: string) => (projectId === 'p1' ? first : second);
    const api: ProjectApi = {
      ...first,
      tree: (projectId) => forProject(projectId).tree(projectId),
      steps: (projectId) => forProject(projectId).steps(projectId),
      createWorkItem: async (projectId, input) => {
        calls.push(projectId);
        if (projectId === 'p1') await heldFirst;
        return forProject(projectId).createWorkItem(projectId, input);
      },
    };
    const { rerender } = render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('button', { name: 'Add work item' });

    click('Add work item');
    await waitFor(() => {
      expect(calls).toEqual(['p1']);
    });

    rerender(<WbsTable projectId="p2" api={api} />);
    click('Add work item');
    releaseFirst?.();

    await waitFor(() => {
      expect(calls).toEqual(['p1', 'p2']);
    });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
  });

  itDom('outdents with shift-tab', async () => {
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

    pressTab('010.1', true);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('replaces the slices on every refetch, as it replaces the rows', async () => {
    // The plan's slices arrive on the same read as its rows and are held beside
    // them, so an edit that changes what be-01 placed changes what this holds —
    // in both directions. Counted rather than listed because the ids are
    // opaque; what is asserted is that they are this read's and not the last
    // one's.
    const api = fakeApi();
    const { container } = render(<WbsTable projectId="p1" api={api} />);
    const sliceCount = () =>
      container.querySelector('[data-slice-count]')?.getAttribute('data-slice-count');

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    await waitFor(() => {
      expect(sliceCount()).toBe('1');
    });

    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    await waitFor(() => {
      expect(sliceCount()).toBe('2');
    });

    // Indenting takes one away: 010 has become a parent, and a parent has no
    // work of its own for anybody to place a slice of.
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    await waitFor(() => {
      expect(sliceCount()).toBe('1');
    });
  });

  itDom('no rendered string says Phase or Role', async () => {
    // Every column, because the sweep is about what a reader can be shown and
    // the hidden ones carry headers and hints of their own.
    showEveryColumn();
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeName('010', 'Strip');
    // And the settings surface, opened, because `project-config-modal` moved
    // the steps face off the toolbar and into a panel behind this control. A
    // sweep of the table alone would no longer read the word at all — which is
    // exactly what the anchor at the bottom caught when that change landed.
    click('Project settings');
    await screen.findByRole('dialog', { name: 'Project settings' });

    /*
      The text and the three attributes a reader is read to through: `title` is
      the toolbar's hints, `aria-label` is every cell's name, `placeholder` is
      what an empty box says. The ARIA `role` attribute is deliberately not
      among them — it is a different vocabulary that shares four letters, and
      `steps-not-phases` design D1 keeps it.

      Proof: the steps section's tab label in `project-settings-modal.tsx`
      spelled back to `Phases`. This failed on `expected [ 'text: Phases' ] to
      deeply equal []`. Watched 2026-08-29, and again after the panel split.
    */
    const stale = /\b(phase|phases|role|roles)\b/i;
    const said: string[] = [];
    // Text **node** by text node, not `body.textContent`: that concatenates
    // adjacent elements with no separator, so a toolbar reads
    // `PrioritiesPhasesFilters` and `\bPhases\b` matches nothing at all. The
    // first cut of this sweep did exactly that and could not see the label.
    const words: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      words.push(text);
      if (stale.test(text)) said.push(`text: ${text}`);
    }
    for (const element of document.body.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const attribute of ['data-hint', 'data-fact', 'aria-label', 'placeholder']) {
        const value = element.getAttribute(attribute);
        if (value !== null && stale.test(value)) said.push(`${attribute}="${value}"`);
      }
    }

    expect(said).toEqual([]);
    // And the sweep really walked a drawn plan, so the emptiness above is a
    // reading rather than an empty page: a row is on screen, the word the fault
    // would corrupt is among the strings that were read, and the attributes it
    // was searched through are there to search.
    expect(words).toContain('Steps');
    expect(document.body.querySelectorAll('[title], [aria-label]').length).toBeGreaterThan(10);
  });

  itDom('backspace at the start of the name outdents the row', async () => {
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

    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('backspace anywhere else, or over a selection, stays a backspace', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    typeName('010.1', 'Sockets');

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');

    // Mid-text: an ordinary backspace.
    name.setSelectionRange(3, 3);
    fireEvent.keyDown(name, { key: 'Backspace' });
    // A selection anchored at the start: deleting it, not moving the row.
    name.setSelectionRange(0, 3);
    fireEvent.keyDown(name, { key: 'Backspace' });

    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '010.1']);
  });

  itDom('backspace in an empty root row removes it and puts the focus above', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('a nested empty row outdents on backspace, and is not removed', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    const removed: unknown[] = [];
    api.removeWorkItem = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010.1');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    expect(removed).toEqual([]);
  });

  itDom('anything the item holds vetoes the backspace removal', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    // 010 gets its child first, so the numbering of everything after is settled.
    pressNewItem('010');
    await screen.findByLabelText('Name of 020');
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    // Four more root rows: one per remaining kind of content that must veto.
    for (const upTo of ['020', '030', '040', '050'] as const) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${upTo}`);
    }

    // 030 gets notes, 040 an estimate, 050 a dependency — committed by blur.
    // The notes are typed under an empty first line, so 030 has notes and no
    // name: this test is about a work item whose *only* content is a note, and
    // a name typed above it would veto the removal for the wrong reason.
    const notes = screen.getByLabelText<HTMLInputElement>('Name of 030');
    fireEvent.change(notes, { target: { value: '\nmeasure twice' } });
    fireEvent.blur(notes);
    unfoldStep('Dev');
    // A whole trio on 040 — one point alone is a draft, not an estimate, since
    // the table stopped inventing the other two.
    for (const point of ['optimistic', 'realistic', 'pessimistic'] as const) {
      const estimate = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for 040`);
      fireEvent.change(estimate, { target: { value: '3' } });
      fireEvent.blur(estimate);
    }
    const depends = screen.getByLabelText<HTMLInputElement>('Add a dependency to 050');
    fireEvent.change(depends, { target: { value: '010' } });
    fireEvent.keyDown(depends, { key: 'Enter' });
    fireEvent.blur(depends);
    await waitFor(() => {
      expect(api.rows.find((row) => row.number === '030')?.notes).toBe('measure twice');
    });
    expect(screen.getByLabelText('Name of 030')).toHaveValue('\nmeasure twice');

    const removed: unknown[] = [];
    api.removeWorkItem = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };

    // 020: text typed into the Name and not yet committed is still a name.
    const named = screen.getByLabelText<HTMLInputElement>('Name of 020');
    fireEvent.change(named, { target: { value: 'Sand' } });
    named.setSelectionRange(0, 0);
    fireEvent.keyDown(named, { key: 'Backspace' });

    for (const number of ['010', '030', '040', '050'] as const) {
      const name = screen.getByLabelText<HTMLInputElement>(`Name of ${number}`);
      name.setSelectionRange(0, 0);
      fireEvent.keyDown(name, { key: 'Backspace' });
    }

    expect(removed).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '010.1', '020', '030', '040', '050']);
  });

  itDom('a note that has not been deleted yet still vetoes the removal', async () => {
    // The committed half of "is this work item empty", and the reason the
    // `row.notes` conjunct stays beside `input.value === ''` now that one box
    // holds both fields: emptying the box is not the same as having emptied
    // the work item. Nothing has been sent — the blur that would send it has
    // not happened — so the note is still there for everyone else, and a
    // keystroke reflex must not take the row it belongs to with it.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLInputElement>('Name of 010');
    fireEvent.change(name, { target: { value: '\nmeasure twice' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe('measure twice');
    });

    const removed: unknown[] = [];
    api.removeWorkItem = (...args: unknown[]) => {
      removed.push(args);
      return Promise.resolve();
    };

    // Select it all and delete it, then Backspace once more — one gesture, and
    // the blur that would commit the emptying has not happened.
    const again = screen.getByLabelText<HTMLInputElement>('Name of 010');
    fireEvent.change(again, { target: { value: '' } });
    again.setSelectionRange(0, 0);
    fireEvent.keyDown(again, { key: 'Backspace' });

    expect(removed).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('tab inside the text walks to the next cell instead of indenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldStep('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    name.setSelectionRange(2, 2);
    fireEvent.keyDown(name, { key: 'Tab' });

    // The next field, which is the one beside the name: what a row waits for.
    const next = screen.getByLabelText<HTMLInputElement>('Add a dependency to 020');
    expect(document.activeElement).toBe(next);
    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010', '020']);
  });

  itDom('shift-tab inside the text walks backwards instead of outdenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldStep('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    name.setSelectionRange(2, 2);
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true });

    // The row above's last editable cell — 010 is a leaf and the plan has no
    // start date, so its folded QA estimate. The Notes cell that used to be
    // last is gone: those live under the name now.
    expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 010'));
    expect(moved).toEqual([]);
  });

  itDom('tab over a selection navigates rather than indenting', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    // Unfolded before typing: the fold rebuilds the column set, which
    // remounts every cell, and a name typed but not yet committed would be
    // reset to the server's value — the one cost of folding, paid on an
    // explicit click.
    unfoldStep('Dev');
    typeName('020', 'Sand');

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 020');
    name.focus();
    // Anchored at the start: atStart alone would still indent this.
    name.setSelectionRange(0, 3);
    fireEvent.keyDown(name, { key: 'Tab' });

    expect(document.activeElement).toBe(
      screen.getByLabelText<HTMLInputElement>('Add a dependency to 020'),
    );
    expect(moved).toEqual([]);
  });

  itDom('backspace at the start of a root row moves nothing', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const moved: unknown[] = [];
    api.moveWorkItem = (...args: unknown[]) => {
      moved.push(args);
      return Promise.resolve();
    };
    const name = screen.getByLabelText<HTMLInputElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });

    expect(moved).toEqual([]);
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('shows a parent estimate cell as read-only and a leaf as editable', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');
    unfoldStep('Dev');

    // A parent's figures are sums of what is below it. Typing into them would be
    // either ignored or double-counted, and neither is visible to whoever typed.
    expect(screen.getByLabelText('Dev optimistic for 010')).toHaveProperty('readOnly', true);
    expect(screen.getByLabelText('Dev optimistic for 010.1')).toHaveProperty('readOnly', false);
  });

  itDom('locks a frozen row and offers to unfreeze it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    await screen.findByLabelText('Name of 010');

    takeFreezeAction('Freeze numbering');

    await waitFor(() => {
      expect(screen.getByLabelText('Number is frozen')).toBeDefined();
    });
    openRowMenu('010');
    expect(screen.getByRole('menuitem', { name: 'Unfreeze' })).toBeDefined();
  });
});

describe('the plan on a calendar', () => {
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('shows day offsets until the project has a start date', async () => {
    await oneRow();

    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('0');
  });

  itDom('shows dates once the project starts on a day, as somebody reads one', async () => {
    // `2026-08-06` in a 52px column, for a reader who already knows what year
    // it is. The whole day stays in the cell's own card and in the
    // `data-start-said` beside it, so the shortening costs nothing.
    // Proof: `printedDay` made to hand back the raw `iso` as its `text`, this
    // failed on `expected '2026-08-06' to be '6 Aug'`. Watched, 2026-08-09.
    const api = await oneRow();

    typeIntoDate('Project start date', '2026-08-06');

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('6 Aug');
    });
    // The day and then what holds it there, the `End` cell's own two-facts
    // shape. This assertion read `toBe('2026-08-06')` until `row-start-floor`
    // put the floor sentence beside it, and the change is why it is spelled out
    // rather than loosened to `toContain`: what a reader is shown on hover is
    // exactly this, dash and all.
    //
    // `data-start-said` and not `title` since `start-date-hover-card`: the cell
    // shows this sentence in its own card, instantly, and carries the string at
    // rest for the two oracles and one e2e fixture that read the day back out of
    // the table. `startCellProps` says the whole of why.
    expect(
      rowFor('010').querySelector('td[data-column="start"]')?.getAttribute('data-start-said'),
    ).toBe('2026-08-06 — Starts with the project');
    expect(rowFor('010').querySelector('[data-finish]')?.textContent).toContain('6 Aug');
    expect(rowFor('010').querySelector('[data-finish]')?.getAttribute('data-fact')).toContain(
      '2026-08-06',
    );
    expect(api.rows.length).toBe(1);
  });

  itDom('carries the year on a day that is not in this one', async () => {
    // The omission is only unambiguous while it is the reader's own year, so a
    // plan that runs into another one says which.
    const today = new Date();
    await oneRow();

    typeIntoDate('Project start date', `${String(today.getFullYear() + 1)}-06-01`);

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe(
        `1 Jun ${String(today.getFullYear() + 1)}`,
      );
    });
  });

  itDom('leaves the workday offsets alone while the plan has no start date', async () => {
    // The fallback this change did not touch: without a project start date
    // there are no dates to shorten, and the columns print day numbers with no
    // fuller day to say anywhere.
    //
    // The floor sentence is there anyway, and that is the point of asserting it
    // here rather than deleting the line: what holds a row's start is a fact
    // about the plan's shape, not about the calendar it has not been put on, so
    // it is the one thing this cell can say on a plan with no dates at all.
    await oneRow();

    expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('0');
    expect(
      rowFor('010').querySelector('td[data-column="start"]')?.getAttribute('data-start-said'),
    ).toBe('Starts with the project');
  });

  itDom(
    'makes the Start cell itself the surface: marked, focusable, and carrying no native tooltip',
    async () => {
      // Two changes, one cell. `wbs-waiting-sentence-hover-target` moved the
      // sentence off a 34×13px `title` on `span[data-start]` — pointer-only,
      // invisible until hover, unreachable from a keyboard — and onto the whole
      // `td[data-column="start"]`. `start-date-hover-card` then took the `title`
      // away entirely: Dany asked for the tooltip to be **instant**, and a
      // native one is the browser's own second-long delay in the platform's own
      // chrome, which no stylesheet reaches.
      await oneRow();

      const cell = rowFor('010').querySelector('td[data-column="start"]');
      // **No `title` anywhere in this cell.** If one came back it would race the
      // card over the same pixels — the folded step cell's own note, a fortnight
      // earlier — and this is the case that reddens.
      // Both attributes, not just the hint: since `tool-hints-wait` a second
      // surface over these pixels could be written as either, and a check that
      // names one of the two narrows while the fault it guards widens.
      expect(saidBy(cell)).toBeNull();
      expect(saidBy(rowFor('010').querySelector('[data-start]'))).toBeNull();
      // The sentence is still there at rest for the oracles that read it: see
      // `startCellProps`.
      expect(cell?.getAttribute('data-start-said')).toBe('Starts with the project');
      // And the cell is on the keyboard, which is what makes the card reachable
      // without a pointer.
      expect(cell?.getAttribute('tabindex')).toBe('0');
      // Something on screen says "there is more to read here", all the time, not
      // only while a pointer is over the cell.
      expect(rowFor('010').querySelector('[data-start]')?.getAttribute('style')).toContain(
        'underline dotted',
      );
    },
  );

  itDom('opens the Start cell’s own card on hover, and on focus, and closes it again', async () => {
    // The instant tooltip, which is a `HoverCard` and not the browser's. The
    // card is what a reader sees; `data-start-said` is what a machine reads, and
    // asserting only the second would be a check that could not see the card
    // fail to render at all.
    await oneRow();

    const cell = rowFor('010').querySelector<HTMLElement>('td[data-column="start"]');
    if (cell === null) throw new Error('the row has no Start cell');
    expect(screen.queryByRole('tooltip', { name: /^Start of 010 - / })).toBeNull();

    // Proof: `onMouseEnter` deleted from `startCellProps`, watched failing here
    // on `Unable to find role="tooltip" and name /^Start of 010 - /`.
    fireEvent.mouseEnter(cell);
    const card = await screen.findByRole('tooltip', { name: /^Start of 010 - / });
    expect(card).toHaveTextContent('Starts with the project');
    // The description the cell points at while the card is open — the keyboard's
    // half of the same fact, and what a `title` used to do for free.
    //
    // Against the card's **own** id rather than against `start-w1`: a literal
    // here would pass with the cell and the card spelling the id two different
    // ways, which is a description that refers to nothing. `startCardId` is the
    // one spelling and this is what says both sites use it.
    //
    // Proof: the `<td>`'s `aria-describedby` given `\`start-${row.number}\``
    // instead, watched failing on `expected 'start-010' to be 'start-w1'`.
    expect(cell.getAttribute('aria-describedby')).toBe(card.getAttribute('id'));
    expect(card.getAttribute('id')).not.toBeNull();

    fireEvent.mouseLeave(cell);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip', { name: /^Start of 010 - / })).toBeNull();
    });

    // And the keyboard path, which is the reason `onFocus` sits beside
    // `onMouseEnter`: a card only a pointer can open is data withheld from
    // anybody who does not use one.
    //
    // Proof: `onFocus` deleted, watched failing on the same `Unable to find
    // role="tooltip" and name /^Start of 010 - /` — reached only after the hover
    // half above it had passed, which is why the two gestures are asserted
    // apart rather than as one "the card opens".
    fireEvent.focus(cell);
    expect(await screen.findByRole('tooltip', { name: /^Start of 010 - / })).toBeVisible();
  });

  itDom('does not mark a Start cell that has no explanation', async () => {
    // A parent has no floor sentence of its own. Without a project calendar it
    // also has no full date, so there is nothing for hover or focus to reveal.
    // The affordance must follow the explanation rather than the column name:
    // making either style unconditional falsely advertises hidden help.
    const api = fakeApi();
    const parent = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Parent',
    });
    await api.createWorkItem('p1', { parentId: parent.id, afterId: null, name: 'Child' });
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');

    const cell = rowFor('010').querySelector<HTMLElement>('td[data-column="start"]');
    const day = cell?.querySelector<HTMLElement>('[data-start]');
    expect(saidBy(cell)).toBeNull();
    expect(cell?.getAttribute('tabindex')).toBeNull();
    expect(cell?.style.cursor).toBe('');
    expect(day?.style.textDecoration).toBe('');
  });

  itDom('says a row is waiting on a dependency where its Start does not look like it', async () => {
    // The fault this whole task is about, in one row pair: `020` waits for
    // `010`, and a reader who compares `020`'s Start against `010`'s End
    // concludes the tool is broken. `dep-waits-on-first-role` is why it is not,
    // and this is the line that says so.
    // Built through the api before the render, the way the picker's fixtures
    // are: the shape is the fixture here, not the thing under test.
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    await api.addDependency(paint.id, strip.id);
    // Five days on `Strip`'s Dev and a **Tuesday** start, so the day this cell
    // names is neither the plan's start date nor a count of calendar days: the
    // fifth working day from Tuesday 1 Sep is Monday 7 Sep.
    await api.setEstimate(strip.id, DEV.id, { optimistic: 5, realistic: 5, pessimistic: 5 });
    // `020` gets an estimate of its own too, so the row under test owns a real
    // slice rather than an empty one. It does not move the day this cell shows,
    // and the assertion below says why.
    await api.setEstimate(paint.id, DEV.id, { optimistic: 2, realistic: 2, pessimistic: 2 });
    await api.setStartDate('p1', '2026-09-01');
    // The clock is pinned for this case alone, and it is the assertion below
    // that needs it: `<WbsTable>` hands `startFloorByRow` a `today` of
    // `new Date()`, and `shortIsoDate` drops a date's year only while it
    // matches the reader's own — so `finishes 7 Sep` becomes `finishes 7 Sep
    // 2026` on the first run of 2027 and this case fails on a calendar page
    // turning rather than on anything in the code. The day is
    // `gantt-geometry.test.ts`'s `calendarOf()`'s, so the two specs pin one
    // reader's today and not two.
    //
    // `shouldAdvanceTime` because everything below it is async RTL: a frozen
    // clock stops `findBy*`'s polling and the render never resolves. Restored
    // in `finally` and not after the expectations, so a red case cannot leave
    // a mocked clock to the ~500 that follow it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    try {
      render(<WbsTable projectId="p1" api={api} />);
      await screen.findByLabelText('Name of 020');

      // The whole title through the real call site, day and sentence, spelled out
      // dash and all for the same reason the calendar case above is: this cell now
      // joins ` — ` twice, and `e2e/gantt.spec.ts:218` splits on it.
      //
      // `finishes 7 Sep` is the part that proves something, and the leading
      // `2026-09-01` is not: this fake gives EVERY row `dates: { startsOn:
      // startDate }` (see `tree()`), so the day in front is a constant and would
      // read `2026-09-01` whatever the row waited for. The day inside the sentence
      // is computed here and nowhere else — five working days from a **Tuesday**
      // start is Monday the 7th, not the 5th — and `<WbsTable>` is the only thing
      // that hands `startFloorByRow` a calendar, so a stubbed or forgotten second
      // argument is invisible to every unit test of the function itself.
      expect(
        rowFor('020').querySelector('td[data-column="start"]')?.getAttribute('data-start-said'),
      ).toBe('2026-09-01 — Waits for Strip (Dev) — finishes 7 Sep');
      // Not the successor's own sentence on the row it waits for: the two cells
      // answer for themselves, which a single shared string would hide.
      expect(
        rowFor('010').querySelector('td[data-column="start"]')?.getAttribute('data-start-said'),
      ).toBe('2026-09-01 — Starts with the project');
    } finally {
      vi.useRealTimers();
    }
  });

  itDom('will not take an earliest start while the plan has no start date', async () => {
    // Without a project start date there is no day zero, so be-01 ignores the
    // constraint entirely. A date that saves and does nothing is worse than a
    // field that will not take one — this shipped and was found on dev.
    await oneRow();

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');

    expect(cell.disabled).toBe(true);
    expect(cell.getAttribute('data-fact') ?? '').toContain('project start date');
    // And the columns say which of the two they are showing.
    // And the column says which of the two it is showing — in its `title`,
    // because the heading itself is one word wide now.
    expect(headerTitled('Start')).toContain('days from the start of the plan');
  });

  itDom('takes one once the plan is on a calendar, and drops the "(day)" wording', async () => {
    await oneRow();

    typeIntoDate('Project start date', '2026-08-06');

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    // Scoped to the column headers: the toolbar has a "Starts" label of its own.
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());
    expect(headers).toContain('Start');
    expect(headerTitled('Start')).not.toContain('days from the start of the plan');
  });

  itDom('gives every heading on screen the sentence its column carries', async () => {
    // The seam, asserted where the columns actually render: `column-hints.ts`
    // has its own unit test for the copy, and this is the one that says the
    // copy reaches the reader — on the `<th>`, for every column the table put
    // on screen, with nothing left saying only what it is called.
    //
    // Read through `hintFor` rather than against a written-out list, because a
    // list here is a second place to add a column to and the whole point of the
    // seam is that there is one.
    await oneRow();

    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(5);
    for (const th of headers) {
      const columnId = th.getAttribute('data-column') ?? '';
      expect(th.getAttribute('data-hint')).toBe(hintFor(columnId, { hasProjectStartDate: false }));
    }
  });

  itDom('holds a date typed one segment at a time, and saves the one that was typed', async () => {
    // The fault, exactly as a browser produces it. A native date input fires a
    // `change` for **every completed segment**, so typing the year `2026` fires
    // four of them and the first three are dates in years 2, 20 and 202. Each
    // was committed, each commit refetched the project, and the controlled box
    // was re-rendered from be-01's answer mid-word — so the year segment reset
    // under the caret and the rest of the digits went nowhere. A plan was saved
    // starting in **year 0002**; observed in Chrome on 2026-08-09.
    //
    // Proof: `commit` moved back onto an `onChange` in `DateField`, this failed
    // on `expected [ '0002-08-17', '0020-08-17', …(2) ] to deeply equal []`,
    // and its `Not before` twin on `expected [ …(4) ] to deeply equal []`.
    // Watched, 2026-08-09.
    const api = await oneRow();
    const sent = recordCalls(api, 'setStartDate', (_projectId, day) => day);

    const box = screen.getByLabelText<HTMLInputElement>('Project start date');
    box.focus();
    typeYearInto(box);

    expect(sent).toEqual([]);

    fireEvent.blur(box);

    await waitFor(() => {
      expect(sent).toEqual(['2026-08-17']);
    });
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-start]')?.textContent).toBe('17 Aug');
    });
  });

  itDom('holds a row’s earliest start the same way, and sends it once', async () => {
    // The same fault in the other date field on the page: `26.08.0002` was
    // typed into a row's `Not before` and saved, on the same pass.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    const box = openNotBefore('010');
    box.focus();
    typeYearInto(box);

    expect(patched).toEqual([]);

    fireEvent.blur(box);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: '2026-08-17' }]);
    });
  });

  itDom('takes Enter as "I have finished typing this date"', async () => {
    // The one way to send a date without leaving the field, so a keyboard is
    // not obliged to Tab out of a box to save what is in it.
    // Proof: the `Enter` branch removed from `DateField`, this failed on
    // `expected [] to deeply equal [ '2026-08-17' ]`. Watched, 2026-08-09.
    const api = await oneRow();
    const sent = recordCalls(api, 'setStartDate', (_projectId, day) => day);

    const box = screen.getByLabelText<HTMLInputElement>('Project start date');
    box.focus();
    fireEvent.change(box, { target: { value: '2026-08-17' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(sent).toEqual(['2026-08-17']);
    });
    // And leaving afterwards sends nothing more: the box and the server agree.
    fireEvent.blur(box);
    await Promise.resolve();
    expect(sent).toEqual(['2026-08-17']);
  });

  itDom('sends a work item’s earliest start, and clears it again', async () => {
    const api = await oneRow();
    // The field only takes a date once the plan is on a calendar.
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    typeIntoNotBefore('010', '2026-08-12');
    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: '2026-08-12' }]);
    });

    // Cleared reads as '' from a date input, and means "no constraint" rather
    // than "an empty date" — and it takes the words about that date with it,
    // because be-01 refuses the pair the other way round. See the test below.
    typeIntoNotBefore('010', '');

    await waitFor(() => {
      expect(patched).toEqual([
        { startNoEarlierThan: '2026-08-12' },
        { startNoEarlierThan: null, startNoEarlierThanReason: null },
      ]);
    });
  });

  itDom('clears the words with the day, in the one request', async () => {
    // The pair rule is be-01's, since `not-before-reason` (#81): a reason with
    // no date to be about is `not_before_reason_needs_a_date`, **400**. So a
    // bare `{ startNoEarlierThan: null }` stops clearing the date on exactly
    // the rows somebody has taken the trouble to explain, and it fails in their
    // face rather than quietly.
    //
    // Proof: `startNoEarlierThanReason: null` dropped from the null arm of
    // `setNotBefore`, this fails on `expected [ { startNoEarlierThan: null } ]
    // to deeply equal [ { startNoEarlierThan: null, startNoEarlierThanReason:
    // null } ]`. Watched, 2026-08-18.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    // A refetch, so the table is showing the explained row rather than the
    // blank one it created.
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
        '12 Sep',
      );
    });

    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    typeIntoNotBefore('010', '');

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThan: null, startNoEarlierThanReason: null }]);
    });
  });

  itDom('takes the words about the date, and does not shut on the way to them', async () => {
    // Two boxes, one editor. `DateField`'s `onExit` reports the blur and not
    // where the focus went, so the cell's wrapper is what asks — `focusout`
    // bubbles and carries `relatedTarget`.
    //
    // Proof: the wrapper's `contains(relatedTarget)` guard replaced by a bare
    // `close()`, this fails on `expected null not to be null` — the panel shuts
    // on the way to the reason box and there is nothing left to type into.
    // Watched, 2026-08-18.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    const editor = openNotBefore('010');
    const reason = screen.getByLabelText<HTMLInputElement>('Why 010 may not start earlier');

    fireEvent.blur(editor, { relatedTarget: reason });

    expect(screen.queryByLabelText('Why 010 may not start earlier')).not.toBeNull();

    // Trimmed on the way out, so there is one spelling of every sentence.
    fireEvent.change(reason, { target: { value: '  waiting on client sign-off  ' } });
    fireEvent.blur(reason);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThanReason: 'waiting on client sign-off' }]);
    });
    // And that blur had nowhere inside the editor to go, so it closed it.
    expect(screen.queryByLabelText('Why 010 may not start earlier')).toBeNull();
  });

  itDom('spells an emptied reason box as “nobody has said”', async () => {
    // `null`, not `''`: one spelling of the absence, which is the same call the
    // Prio cell makes about an emptied number and the one thing be-01 cannot
    // see from a request that omits the field.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
        '12 Sep',
      );
    });

    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    openNotBefore('010');
    const reason = screen.getByLabelText<HTMLInputElement>('Why 010 may not start earlier');
    // The box opens holding what the server said, which is the other half of
    // this: a reader edits the sentence rather than retyping it.
    expect(reason.value).toBe('waiting on client sign-off');
    fireEvent.change(reason, { target: { value: '' } });
    fireEvent.blur(reason);

    await waitFor(() => {
      expect(patched).toEqual([{ startNoEarlierThanReason: null }]);
    });
  });

  itDom('says why the date is there, on the cell at rest', async () => {
    // Appended, never substituted — the same bargain `floorWordsOf` strikes on
    // the bar. What the constraint *does* is the part a reader cannot work out;
    // what it is *for* is the part only a planner can say.
    const api = await oneRow();
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    const explained = api.rows.at(0);
    if (explained === undefined) throw new Error('the plan has no row');
    explained.startNoEarlierThan = '2026-09-12';
    explained.startNoEarlierThanReason = 'waiting on client sign-off';
    click('Add work item');

    await waitFor(() => {
      const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
      expect(cell.getAttribute('data-fact') ?? '').toBe(
        '2026-09-12. This work item may not start before this day. Its dependencies can still push it later. Why: waiting on client sign-off',
      );
    });
    // And a row nobody has explained says exactly what it said before.
    expect(
      screen.getByLabelText<HTMLInputElement>('Earliest start for 020').getAttribute('data-fact') ??
        '',
    ).toBe(
      'This work item may not start before this day. Its dependencies can still push it later.',
    );
  });
});

describe('the keyboard cheat sheet', () => {
  /** The sheet, or null while it is closed. */
  const sheet = (): HTMLElement | null =>
    screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });

  /** The sheet, or a thrown error rather than a null the assertions walk into. */
  const openSheet = (): HTMLElement => {
    const open = sheet();
    if (open === null) throw new Error('the cheat sheet is not open');
    return open;
  };

  /** The area outside the dialog, which closes it when it is clicked. */
  const backdrop = (): Element => {
    const found = document.querySelector('[data-cheat-sheet-backdrop]');
    if (found === null) throw new Error('the cheat sheet has no backdrop');
    return found;
  };

  itDom('opens the sheet when ? is pressed outside a cell', async () => {
    await threeRoots();
    expect(sheet()).toBeNull();

    // At the table itself: a keystroke landing on the page rather than in a
    // box somebody is typing into.
    fireEvent.keyDown(screen.getByRole('table'), { key: '?' });

    expect(openSheet().getAttribute('aria-modal')).toBe('true');
    // One of the registry's groups, so this is asserting the sheet rendered
    // the bindings rather than an empty box. What is in each group is
    // `keyboard-cheat-sheet.test.tsx`'s business.
    expect(screen.getByRole('heading', { name: 'Moving rows' })).toBeDefined();
  });

  itDom('a question mark typed into a name stays a question mark', async () => {
    await threeRoots();

    const stillTheBrowsers = fireEvent.keyDown(screen.getByLabelText('Name of 010'), { key: '?' });

    // Nothing opened, and the keystroke was left to the field that wanted it.
    expect(sheet()).toBeNull();
    expect(stillTheBrowsers).toBe(true);
  });

  itDom('closes on Escape and gives the focus back to what had it', async () => {
    await threeRoots();
    const opener = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    // jsdom does not focus a clicked button; a browser does, and where the
    // focus goes back to is what this test is about.
    opener.focus();
    click('Keyboard shortcuts');
    expect(openSheet().contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(openSheet(), { key: 'Escape' });

    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  itDom('gives the focus back to the cell that had it', async () => {
    await threeRoots();
    const name = screen.getByLabelText('Name of 010');
    name.focus();

    // The keystroke lands on the page while the cell holds the focus, which is
    // the only way `?` opens anything from a row: inside the cell it is a
    // question mark.
    fireEvent.keyDown(screen.getByRole('table'), { key: '?' });
    expect(openSheet().contains(document.activeElement)).toBe(true);
    fireEvent.click(backdrop());

    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(name);
  });

  itDom('opens from the toolbar for anyone who was never told about ?', async () => {
    await threeRoots();

    click('Keyboard shortcuts');

    expect(openSheet()).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Keyboard shortcuts' }).getAttribute('data-hint') ?? '',
    ).toBe('Keyboard shortcuts (?)');
  });
});

describe('the order of the columns', () => {
  itDom('opens with the number, the name, and then what the row waits for', async () => {
    // "Depends on" sat between Number and Name until 2026-08-06, because
    // dependencies belong beside the identity of a row and the numbers in the
    // cell refer to the Number column. They still do, and they still are — the
    // identity of a row is now Number *and* Name, with what it waits for
    // immediately after both.
    //
    // What moved it is the pinned frame below. `position: sticky; left` holds
    // a cell at a fixed offset from the left edge, which only lines up while
    // the pinned columns are contiguous from that edge — so pinning Name, the
    // thing a plan is read by while scrolling out to the dates, meant Name had
    // to come third rather than fourth. Deliberate reversal, written down in
    // `openspec/changes/sticky-table-frame/proposal.md`.
    localStorage.setItem(
      'wbs.hiddenColumns.p1',
      JSON.stringify(['team', 'service', 'type', 'deadline']),
    );
    await threeRoots();

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.trim());

    // `#` rather than `Number` since `spreadsheet-geometry`: the glyph every
    // spreadsheet heads this column with, in a column 93px wide. The word is
    // still the heading's accessible name, which the assertion below is about.
    // `Links` between `#` and Name since `external-refs` — Dany's placement,
    // and the reason the column is pinned: an unpinned one here would scroll
    // under the Name beside it.
    expect(headers.slice(0, 5)).toEqual(['', '#', 'Links', 'Name', 'Depends on']);
    expect(screen.getByRole('columnheader', { name: 'Number' })).toBeDefined();
    // And the schedule stays on the right, where it reads as an outcome of
    // everything to its left rather than as something to fill in.
    // The schedule stays on the right, where it reads as an outcome of
    // everything to its left. "Not before" is the one input among them, and it
    // sits immediately before the dates it constrains.
    // One word each: at 52px a heading has room for a word and the sentence
    // it used to be lives in the `title`.
    // No Notes column: a work item's notes are typed under its name, in the
    // Name cell, and the column they had is gone.
    // `Not bef.`, not `Not before`: the column is 84px at its widest and 56 at
    // its narrowest, and the sentence it used to be is in the heading's
    // `title`.
    // The Work item deadline column is hidden here alongside the other three,
    // which is where this project's reader left it: `work-item-deadline` 9.1
    // ships it in {@link INITIAL_HIDDEN_COLUMNS} because the folded table at
    // 1280 has no 84px to give it. Shown, it sits between `Not bef.` and
    // `Start` — the two days a planner states, then the days be-01 worked out.
    expect(headers.slice(-5)).toEqual(['Not bef.', 'Start', 'End', 'Slack', '']);
    expect(headers).not.toContain('Notes');
  });

  itDom('heads the people-at-once column with a mark, and names it for readers', async () => {
    // The in-parallel column's heading is a two-person SVG, not a word: 32px
    // at a 10px all-caps header holds no word, and the `∥` it replaced read as
    // "parallel" rather than "at once" to anyone not already told. A mark with
    // no text is a column with no name, so the word lives in `spokenHeading`
    // and is announced as the column's accessible name — the same seam the `#`
    // and `o`/`r`/`p` marks already use.
    // Proof: `meta.spokenHeading` removed from the `in-parallel` column, the
    // query below finds no `columnheader` named "People at once".
    await threeRoots();

    expect(screen.getByRole('columnheader', { name: 'People at once' })).toBeDefined();
  });
});
