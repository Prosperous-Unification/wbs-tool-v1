import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi, WorkItemView } from '@/lib/wbs-api';
import { DEFAULT_PERT_WEIGHTS_VIEW } from '@/lib/wbs-api';
import { DEV, fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';
import { refusingApi } from '@/testing/refusing-api';
import { planRead, projectListEntry, sliceView, workItemView } from '@/testing/views';

import { cellKey } from './editable-grid';
import type * as TableFrameModule from './table-frame';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

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

describe('dependencies in the table', () => {
  const dependOn = (rowNumber: string, predecessorNumber: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value: predecessorNumber } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  itDom('adds a dependency by the number that is on screen', async () => {
    // Ids are not something anyone can look at. Numbers are what the table
    // shows, so numbers are what it takes.
    const api = await threeRoots();

    dependOn('020', '010');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });
    expect(api.rows).toHaveLength(3);
  });

  itDom('says so when the number typed is not a work item', async () => {
    const api = await threeRoots();
    const added: unknown[] = [];
    api.addDependency = (...args: unknown[]) => {
      added.push(args);
      return Promise.resolve();
    };

    dependOn('020', '999');

    expect(added).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('No work item numbered 999');
  });

  itDom('removes a dependency from the chip that shows it', async () => {
    await threeRoots();
    dependOn('020', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText('Stop 020 waiting for 010'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Stop 020 waiting for 010')).toBeNull();
    });
  });

  /** `threeRoots` plus `040` and `050`, so a row can wait for four others. */
  const fiveRoots = async () => {
    const api = await threeRoots();
    for (const number of ['040', '050']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    return api;
  };

  /** One row's dependency count, or `null` where the cell shows none. */
  const dependsCountOf = (number: string): HTMLElement | null => {
    const found = dependsCellOf(number).querySelector('[data-dep-count]');
    return found instanceof HTMLElement ? found : null;
  };

  const waitFor050 = async (predecessor: string) => {
    dependOn('050', predecessor);
    await waitFor(() => {
      expect(screen.getByLabelText(`Stop 050 waiting for ${predecessor}`)).toBeDefined();
    });
  };

  itDom('counts what a row waits for, where the chips saying it are clipped', async () => {
    // The filed bug, in a fixture: four predecessors, a 110px column, and two
    // chips on screen. The count is the cell's answer to "is that all of
    // them" — asked of the *data*, so it is right whatever the column's width
    // does to the chips, which is why nothing here measures anything.
    await fiveRoots();
    for (const predecessor of ['010', '020', '030', '040']) await waitFor050(predecessor);

    expect(dependsCountOf('050')?.textContent).toBe('4');
  });

  itDom('says nothing where one chip is the whole truth', async () => {
    // A `1` beside a single chip is the cell saying the same thing twice in a
    // column with no room to say anything once.
    await fiveRoots();
    await waitFor050('010');

    expect(dependsCountOf('050')).toBeNull();
  });

  itDom('keeps the count off the line a reader is already told in full', async () => {
    // The cell's sr-only line names every dependency; a count spoken beside it
    // is a third voice saying less.
    //
    // **And the pointer gets nothing here either**, which is what
    // `hints-are-the-page-s-own` changed: the count used to carry the same fact
    // as a `title`, and this cell draws its **own** card over these pixels
    // listing every row it waits for by name. A hint card beside that one is
    // two surfaces on one hover — watched in Chromium as `no card opened on the
    // depends cell · Expected: 1 · Received: 2`, in three of
    // `e2e/hover-cards.spec.ts`'s cases at once.
    await fiveRoots();
    for (const predecessor of ['010', '020', '030', '040']) await waitFor050(predecessor);

    const count = dependsCountOf('050');
    expect(count?.getAttribute('aria-hidden')).toBe('true');
    expect(saidBy(count)).toBeNull();
  });

  /**
   * The depends cell's wrapper for one row: the strip, the box, and the card.
   *
   * Through the `<td>` rather than as the box's parent — since
   * `deps-single-line` the box's parent is the clipping strip, and the strip
   * carries no hover handler; the wrapper above it does.
   */
  const dependsCellOf = (number: string): HTMLElement => {
    const cell = screen.getByLabelText(`Add a dependency to ${number}`).closest('td');
    const found = cell?.firstElementChild;
    if (!(found instanceof HTMLElement)) throw new Error(`no depends cell for ${number}`);
    return found;
  };

  itDom('turns the numbers a row waits for into names, on hover', async () => {
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    dependOn('030', '020');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    });
    // The box the numbers were typed into holds the focus, and a cell being
    // typed in is the picker's — so the pointer has to arrive after it has been
    // left, which is also how a reader gets there.
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));

    const card = screen.getByRole('tooltip');
    expect(card.getAttribute('aria-label')).toBe('What 030 waits for');
    expect(card.textContent).toContain('010 - Strip');
    expect(card.textContent).toContain('020 - Sand');
  });

  itDom('describes the box with what the row waits for, pointer or no pointer', async () => {
    // This cell's card cannot open on the focus the way the folded step cell's
    // does: the focus here already belongs to the dependency picker, which
    // opens on it and offers the rows this one could *start* waiting for — a
    // different list, over the same 110px, and stacking the two is the thing the
    // design ruled out. So the names reach a reader with no pointer as the
    // box's description instead: same list, same wording, off the same
    // `waitingFor` the card is built from, so the two cannot drift.
    //
    // Off-screen rather than absent, because it is the one route to this data
    // for anybody not using a mouse — codex round 3, finding 2.
    //
    // Proof: the `aria-describedby` dropped from the input, this failed on
    // `expected null to be 'depends-w3'`. Watched, 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const box = screen.getByLabelText('Add a dependency to 030');
    const describes = box.getAttribute('aria-describedby');
    expect(describes).not.toBeNull();
    const said = document.getElementById(describes ?? '');
    expect(said?.textContent).toContain('010 - Strip');

    // And a row waiting for nothing describes itself with nothing, rather than
    // with an empty sentence.
    expect(
      screen.getByLabelText('Add a dependency to 020').getAttribute('aria-describedby'),
    ).toBeNull();
  });

  itDom('uses the shared reference tokens and describes all three dependencies', async () => {
    await fiveRoots();
    dependOn('050', '010, 020, 030');
    await waitFor(() => {
      for (const number of ['010', '020', '030']) {
        expect(screen.getByLabelText(`Stop 050 waiting for ${number}`)).toBeDefined();
      }
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 050'));

    const add = screen.getByRole('button', { name: 'Make 050 wait for something' });
    expect(add).toHaveAttribute('data-reference-add');
    expect(add.className).toContain('bg-transparent');
    for (const number of ['010', '020', '030']) {
      const chip = screen.getByRole('button', { name: `Stop 050 waiting for ${number}` });
      expect(chip).toHaveAttribute('data-reference-chip');
      expect(chip.className).toContain('bg-muted');
      expect(chip.className).toContain('border-0');
    }

    const box = screen.getByLabelText('Add a dependency to 050');
    const description = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Waiting for 010 - Strip, 020 - Sand, 030 - Paint');
  });

  itDom('drops the same card a reference cell drops', async () => {
    await fiveRoots();

    /*
      Dany, 2026-09-03: _"can you pls make + ui same on depends on and
      services"_.

      This cell is the one of the five that has no `CreatablePicker`, so its
      list was a copy of that component's panel — and the copy had drifted. The
      shared `PICKER_PANEL_STYLE` is the fix; this is the check that the two
      surfaces stay one card.

      **Measured against the other list rather than against literals.** A case
      asserting `borderRadius: 'var(--radius-md)'` here would pass while the
      reference panel moved to something else, which is the drift it is supposed
      to catch. So both lists are opened, one after the other — they cannot be
      open at once, since either one's blur closes it — and their chrome is
      compared.

      Measured in Chromium first, on the live plan and before the fix: the deps
      list came back `radius: "0px", shadow: "none"` against the reference
      list's `radius: "6px", shadow: "oklch(0 0 0 / 0.12) 0px 4px 12px 0px"`.

      Proof: with `...PICKER_PANEL_STYLE` replaced by the copy it stood in for,
      watched failing on `expected { borderRadius: '', …(6) } to deeply equal
      { …(7) }` (2026-09-03).
    */
    const chrome = (list: HTMLElement) => ({
      borderRadius: list.style.borderRadius,
      boxShadow: list.style.boxShadow,
      border: list.style.border,
      background: list.style.background,
      overflow: list.style.overflow,
      maxHeight: list.style.maxHeight,
      overflowY: list.style.overflowY,
    });
    const openList = (): HTMLElement => {
      const list = document.querySelector<HTMLElement>('ul[role="listbox"]');
      if (list === null) throw new Error('no list opened');
      return list;
    };

    fireEvent.click(screen.getByRole('button', { name: 'Make 050 wait for something' }));
    const deps = chrome(openList());
    fireEvent.blur(screen.getByLabelText('Add a dependency to 050'));

    // Typed, because this suite's directory is empty: with nothing to offer and
    // nothing typed the reference panel has no lines and does not render at all
    // — which is the *other* half of what 2026-09-03 reported. One character
    // gives it the `Add “x”` line, and a card to compare.
    const tags = screen.getByRole('combobox', { name: 'Tags for 050' });
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: 'x' } });
    const reference = chrome(openList());

    // The precondition: a pair of empty strings would satisfy the equality
    // below without either list being a card at all.
    expect(reference.borderRadius).toBe('var(--radius-md)');
    expect(reference.boxShadow).not.toBe('');
    expect(deps).toEqual(reference);
  });

  itDom('closes the deps picker on a second press of its add button', async () => {
    await fiveRoots();

    // Dany, 2026-09-01: "can you make it so that clicking second time on plus
    // sign for tags/deps on/teams/services hides the add UI". This cell has its
    // own `+` and its own picker state rather than a `CreatablePicker`, so it
    // answers the same question in its own words: `picker` is exactly "this
    // cell's picker, or null while it is closed".
    const add = screen.getByRole('button', { name: 'Make 050 wait for something' });
    const box = screen.getByLabelText('Add a dependency to 050');

    // **The listbox and not `getAllByRole('option')`.** Written that way first,
    // both halves of this case passed with the toggle absent: the page carries
    // seven `<option>` elements of its own — `outline`, `step`, `assignee`,
    // `PERT` and the three points — inside the toolbar's `<select>`s, so "some
    // options exist" is true of a page where this cell has never been touched.
    // Measured, not reasoned: the probe printed
    // `optionText= outline|step|assignee|PERT|optimistic|realistic|pessimistic`.
    const listOpen = (): number => document.querySelectorAll('ul[role="listbox"]').length;

    fireEvent.click(add);
    // Asserted rather than assumed: with nothing open the press below would be
    // measuring a list that was never there.
    expect(document.activeElement).toBe(box);
    expect(listOpen()).toBe(1);

    // Proof: the `picker !== null` branch removed from the button's `onClick`,
    // watched failing on `expected <input …(10)></input> not to be <input
    // …(10)></input>` — the second press re-focusing a box that already held
    // the focus, which is no press at all.
    fireEvent.click(add);
    expect(document.activeElement).not.toBe(box);
    expect(listOpen()).toBe(0);
  });

  itDom('opens no card over a row that waits for nothing', async () => {
    // The empty cell is a box and no chips; a card holding an empty list is a
    // box over the row below saying nothing.
    //
    // Proof: the `waitingFor.length > 0` condition dropped, this failed on
    // `expected <div role="tooltip" …/> to be null`. Watched, 2026-08-09.
    await threeRoots();

    fireEvent.mouseEnter(dependsCellOf('020'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('keys the hover by value, so a second enter on one cell renders nothing', () => {
    // The other half of "a hover costs one render of the table" (codex round 3,
    // finding 5), and it is the cheap half: React skips the render entirely when
    // a `useState` is set to the value it already holds, judged by `Object.is`.
    // A key that were an object — `{ rowId, columnId }` — would be a fresh
    // identity on every `mouseenter`, and a pointer resting inside one cell
    // sends those as it moves. This asserts exactly the predicate React uses.
    //
    // Not a rendering test, because jsdom counts no renders: it pins the
    // property the bailout rests on, which is the thing a later change could
    // take away. `verify.md` says so rather than claiming more.
    //
    // Proof: `cellKey` made to return `{ rowId, columnId }`, this failed on
    // `expected { rowId: 'w1', columnId: 'name' } to be { rowId: 'w1',
    // columnId: 'name' } // Object.is equality`. Watched, 2026-08-09.
    expect(cellKey('w1', 'name')).toBe(cellKey('w1', 'name'));
    expect(typeof cellKey('w1', 'name')).toBe('string');
  });

  itDom('writes no hovered cell from a cell that has no card to show', async () => {
    // Every hover boundary in this table costs one render of the whole table —
    // the state lives on the table, which is what keeps `columns` off it. A
    // cell with nothing to open must therefore not pay it, and the assertion
    // that it does not has to watch the *state*, not the card: "no card" is
    // already true of an empty depends cell for a second reason.
    //
    // So the probe is a card open elsewhere. The enter is delivered on its own,
    // without the leave a browser would send first, precisely so the write is
    // the only thing that could close it. codex round 3, finding 5.
    //
    // Proof: the `cardable` guard dropped from the depends cell's
    // `onMouseEnter`, this failed on `expected [] to have a length of 1` — the
    // open card closed by a cell that had nothing to put in its place. Watched,
    // 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.mouseEnter(dependsCellOf('020'));

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('010 - Strip');
  });

  itDom('keeps the cell to the dependency picker while it is open', async () => {
    // Two boxes off the bottom edge of one 110px cell. The list somebody is
    // typing into wins, and it opens on the focus rather than on a keystroke —
    // which is why the guard reads the picker rather than its entries.
    //
    // Proof: the `picker === null` condition dropped, this failed on `expected
    // [ <div role="tooltip" …/> ] to have a length of +0 but got 1` — the card
    // and the list stacked over one cell. Watched, 2026-08-09.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    fireEvent.mouseEnter(dependsCellOf('030'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));

    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  itDom('moves the dependent row’s start to when its predecessor finishes', async () => {
    const api = await threeRoots();
    // All three, typed. The old table nudged the neighbours of whichever box
    // you filled; it no longer edits an estimate nobody typed, so a trio is
    // saved only once it reads sensibly on its own.
    for (const [point, value] of [
      ['optimistic', '0'],
      ['realistic', '4'],
      ['pessimistic', '4'],
    ] as const) {
      const cell = screen.getByLabelText(`Dev ${point} for 010`);
      fireEvent.change(cell, { target: { value } });
      fireEvent.blur(cell);
    }
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']?.realistic).toBe(4);
    });

    dependOn('020', '010');

    await waitFor(() => {
      const row = screen
        .getAllByRole('row')
        .find((tr) => tr.querySelector('[data-number]')?.textContent === '020');
      // `0 / 4 / 4` expects `(0 + 16 + 4) / 6` = 3.33… days. Displayed to one
      // decimal, because a column of `3.3333333333333335` is unreadable — and
      // rounded only here, never in the schedule.
      expect(row?.querySelector('[data-start]')?.textContent).toBe('3.3');
    });
  });

  itDom('marks a row with no estimate rather than showing a bare zero', async () => {
    // A zero that means "instant" and a zero that means "nobody has looked" are
    // the same number and opposite facts.
    await threeRoots();

    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');

    expect(row?.querySelector('[data-finish]')?.textContent).toContain('?');
    // And what the marker means, in the one attribute the cell has — beside
    // the day in full once there is one, rather than instead of it.
    // Proof: the `'No estimate yet'` half dropped from the cell's `title`,
    // this failed on `the given combination of arguments (null and string) is
    // invalid for this assertion` — no `title` on the cell at all, this plan
    // having no start date and so no day to put in it either. Watched,
    // 2026-08-09.
    expect(row?.querySelector('[data-finish]')?.getAttribute('data-fact')).toContain(
      'No estimate yet',
    );
  });

  /**
   * The strip the chips and the box sit in at rest — the clipper
   * `deps-single-line` added — and the wrapper above it, which is still the
   * positioned ancestor the popovers hang from. Reached from the box, thrown
   * rather than defaulted: a missing strip is the change gone, not a cell
   * with nothing to say.
   */
  const stripOf = (number: string): { strip: HTMLElement; wrapper: HTMLElement } => {
    const strip = screen.getByLabelText(`Add a dependency to ${number}`).parentElement;
    if (!(strip instanceof HTMLElement) || !strip.hasAttribute('data-depends-strip')) {
      throw new Error(`the ${number} depends box is not in a strip`);
    }
    const wrapper = strip.parentElement;
    if (!(wrapper instanceof HTMLElement)) throw new Error(`the ${number} strip has no wrapper`);
    return { strip, wrapper };
  };

  /**
   * Row 030 waiting on seven others — the deep-plan fixture's dependency
   * shape, typed as one separated list the way the cell has always taken
   * one. Left at rest on the way out, which is what every claim about the
   * strip's clamp is about.
   */
  const sevenChips = async (): Promise<readonly string[]> => {
    await threeRoots();
    for (const number of ['040', '050', '060', '070', '080']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    const waited = ['010', '020', '040', '050', '060', '070', '080'];
    dependOn('030', waited.join(', '));
    await waitFor(() => {
      for (const number of waited) {
        expect(screen.getByLabelText(`Stop 030 waiting for ${number}`)).toBeDefined();
      }
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    return waited;
  };

  itDom('clamps the chips and the box onto one nowrap line at rest', async () => {
    // jsdom lays nothing out, so what is watched here is the declarations
    // arriving on the strip under the load the change is about — seven chips,
    // the deep-plan fixture's shape: one flex line that does not wrap,
    // clipping what overruns it. That the seven-chip row really is one line
    // tall — and that a clipped chip really is invisible — is Chromium's to
    // prove, in `e2e/deps-cell.spec.ts` (R5 #14–16 fault class).
    //
    // Proof: the strip's rest branch forced to `flexWrap: 'wrap'` — the strip
    // losing nowrap — this failed on `expected 'wrap' to be 'nowrap'`.
    // Watched, 2026-08-10.
    const waited = await sevenChips();

    const { strip, wrapper } = stripOf('030');
    // All seven chips share the strip with the box: the clamp is about the
    // whole crowd, not a token pair.
    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).parentElement).toBe(strip);
    }
    expect(strip.style.display).toBe('flex');
    expect(strip.style.flexWrap).toBe('nowrap');
    expect(strip.style.whiteSpace).toBe('nowrap');
    expect(strip.style.overflow).toBe('hidden');
    // The mask assumes a physical right edge to fade; the strip says which.
    expect(strip.style.direction).toBe('ltr');
    // And the wrapper above it is still the positioned ancestor, with the
    // superseded wrap declaration really gone from it.
    expect(wrapper.style.position).toBe('relative');
    expect(wrapper.style.whiteSpace).toBe('');
  });

  itDom('keeps the truncation fade on the rested strip, and off the open one', async () => {
    // The fade is the *rest* state's truncation cue, by the picker's state
    // and never by a measurement — "fade only when clipped" would need the
    // `scrollWidth` read the `+N` marker was rejected for. It comes off while
    // the picker owns the cell: the strip wraps then, nothing is clipped, and
    // the box spans the full width — a mask there fades the focus ring, the
    // caret and the typed text across the last 14px (codex + agy review,
    // 2026-08-10).
    //
    // Proof, two faults, both watched 2026-08-10: the fade deleted from the
    // strip, this failed at rest on `expected '' to contain
    // 'linear-gradient'`; the fade applied unconditionally, it failed at the
    // assertion below the focus — the picker open — on
    // `expected 'linear-gradient(to right, #000 calc(1…' to be ''`.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const { strip } = stripOf('030');
    expect(strip.style.maskImage).toContain('linear-gradient');

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(strip.style.maskImage).toBe('');
    // While the picker owns the cell the strip wraps as the cell always did,
    // so nothing about typing or the open list changes.
    expect(strip.style.flexWrap).toBe('wrap');
  });

  itDom('keeps clipped chips out of the tab order at rest', async () => {
    // A clipped chip is a native button a sequential Tab or a reader's focus
    // walk could still reach, invisible — and on the way there the browser
    // may scroll the `overflow: hidden` strip to show what it focused,
    // shifting the rested layout. So at rest every ✕ is `tabIndex={-1}`;
    // with the picker open the strip wraps, every chip is on screen, and the
    // buttons are back in the order. The keyboard path to removal is
    // unchanged: the grid's Tab enters the cell at the box, the picker opens
    // on the focus, and the chips are visible and focusable again.
    //
    // Proof: the rest condition dropped — chips always focusable — this
    // failed on `expected +0 to be -1`. Watched, 2026-08-10.
    const waited = await sevenChips();

    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).tabIndex).toBe(-1);
    }

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    // The picker owns the cell now — no listbox to look for, since a row
    // already waiting on everything has no entries to be offered, but the
    // strip wrapping is the open state the flip is tied to.
    const { strip } = stripOf('030');
    expect(strip.style.flexWrap).toBe('wrap');
    for (const number of waited) {
      expect(screen.getByLabelText(`Stop 030 waiting for ${number}`).tabIndex).toBe(0);
    }
  });

  itDom('keeps both popovers out of the clipper', async () => {
    // The strip is an `overflow: hidden` box, and an absolutely positioned
    // popover escapes such a box only when its containing block is outside it
    // — the `<td>` exemption's own rule, one layer down. A listbox or a card
    // that slipped *inside* the strip would be cut to one line however the
    // `<td>` is styled, so both stay children of the wrapper.
    //
    // Proof: the strip's closing tag moved past the listbox — the listbox
    // rendered inside the clipper — this failed on `expected
    // <span …(2)>…(3)</span> to be <span …(1)>…(2)</span>`, the listbox's
    // parent the strip rather than the wrapper. Watched, 2026-08-10.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    const { strip, wrapper } = stripOf('030');
    fireEvent.mouseEnter(wrapper);
    const card = screen.getByRole('tooltip');
    expect(card.parentElement).toBe(wrapper);
    expect(strip.contains(card)).toBe(false);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    const list = screen.getByRole('listbox');
    expect(list.parentElement).toBe(wrapper);
    expect(strip.contains(list)).toBe(false);
  });

  /**
   * The add affordance on one row's deps cell — `dep-add-button`. By its own
   * name, which is deliberately not the box's: two controls in one cell
   * answering to `Add a dependency to 030` would be a reader told the same
   * thing twice.
   */
  const addButtonOf = (number: string): HTMLElement =>
    screen.getByLabelText(`Make ${number} wait for something`);

  itDom('offers an add button at the head of every rested deps cell', async () => {
    // Always on screen and first on the strip's line. First is the load-bearing
    // half: the strip clips its right edge, so a trailing affordance would be
    // cut out of sight in exactly the crowded cell that needs it most. jsdom
    // can watch it arrive at the head of the strip; that the head of a clipping
    // line really is the one place never cut is Chromium's, in
    // `e2e/deps-cell.spec.ts` (R5 #14–16).
    //
    // Proof: the button removed from the strip, this failed on `Unable to find
    // a label with the text of: Make 030 wait for something`. Watched,
    // 2026-08-11.
    await threeRoots();

    const { strip } = stripOf('030');
    const add = addButtonOf('030');
    expect(strip.firstElementChild).toBe(add);
    // Not squeezed away by a crowded line: the cell clips chips, never this.
    expect(add.style.flexShrink).toBe('0');
    // A real button, so a reader's element walk finds it — see the tab-order
    // test below for the one thing it deliberately is not.
    expect(add.tagName).toBe('BUTTON');
  });

  itDom('opens the picker from the add button, on the box the cell already has', async () => {
    // What the button is for: the flow a click in the cell already triggers,
    // reached without knowing the cell holds a box. The click focuses the box
    // and the box's own `onFocus` opens the picker — no second path to the
    // picker, which is why nothing here asserts a new one.
    //
    // Proof: the `onClick` body dropped (the button rendered and inert), this
    // failed on `expected <body><div>…(1)</div></body> to be <input …(10)>
    // </input>` — the focus never left the document body. Watched, 2026-08-11.
    await threeRoots();

    fireEvent.click(addButtonOf('030'));

    const box = screen.getByLabelText('Add a dependency to 030');
    expect(document.activeElement).toBe(box);
    // The picker is open on it: 030 can wait for 010 and 020, so the list has
    // entries to show.
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  itDom('keeps the add button out of the tab order, at rest and with the picker open', async () => {
    // Where the chips flip — `deps-single-line` takes them out at rest and puts
    // them back when the strip wraps — this one never enters. The keyboard has
    // this exact path already and reaches it first: Tab into the cell lands on
    // the box, and the box's focus is what opens the picker. A stop here would
    // cost one Tab per row on every walk through the plan and do nothing at the
    // end of it that the next Tab does not already do.
    //
    // Proof: the chips' condition copied onto it (`picker === null ? -1 :
    // undefined`), this failed on `expected +0 to be -1` at the assertion below
    // the focus. Watched, 2026-08-11.
    await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

    expect(addButtonOf('030').tabIndex).toBe(-1);
    // Both at rest: the chip's -1 is `deps-single-line`'s and is asserted
    // beside this one so the contrast below is between two known states.
    expect(screen.getByLabelText('Stop 030 waiting for 010').tabIndex).toBe(-1);

    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
    expect(stripOf('030').strip.style.flexWrap).toBe('wrap');
    // The chip is back in the order — and the add button is still out of it.
    expect(screen.getByLabelText('Stop 030 waiting for 010').tabIndex).toBe(0);
    expect(addButtonOf('030').tabIndex).toBe(-1);
  });

  itDom('refuses the press the focus, so the box beside it keeps what was typed', async () => {
    // The press must not move the focus: a button that takes it from this
    // cell's *own* box blurs the box, and this box's blur closes the picker and
    // drops the search typed into it. Somebody who types `01` and then reaches
    // for the affordance beside it would lose the search to the control that
    // means "search".
    //
    // jsdom performs no default action at all (R5 #14–15's fault class), so
    // what is watched here is the refusal itself — `preventDefault` on the
    // press — and the typed text surviving it is Chromium's, in
    // `e2e/deps-cell.spec.ts`.
    //
    // Proof: the `preventDefault` dropped from `onMouseDown`, this failed on
    // `expected true to be false` — the press left to the browser, which would
    // have moved the focus onto the button. Watched, 2026-08-11.
    await threeRoots();

    const box = screen.getByLabelText<HTMLInputElement>('Add a dependency to 030');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '01' } });

    // `fireEvent` answers `false` when the event was cancelled, which is the
    // only observation jsdom can make about a default action it never performs.
    expect(fireEvent.mouseDown(addButtonOf('030'))).toBe(false);
    expect(box.value).toBe('01');
  });

  itDom(
    'leaves an empty cell’s open strip on one nowrap line, and a chipped one wrapping',
    async () => {
      // The wrap is for the chips and for nothing else. With `flexWrap: 'wrap'`
      // the box's `width: 100%` claim is a whole flex line, so it cannot share
      // one with the `+` beside it: an empty cell grew a second line the moment
      // somebody clicked into it, taking the listbox down the page with it.
      // Observed in a cloud Chromium on dev at `2b2affec` — 26px at rest,
      // 44.98px open — and the pixels are `e2e/deps-cell.spec.ts`'s to keep;
      // what jsdom watches is the declaration that decides it.
      //
      // Both halves in one check on purpose: `nowrap` everywhere would pass the
      // first assertion and silently undo `deps-single-line`'s open state, which
      // is the fault a chipless-only test could not see.
      //
      // Proof: the chip condition dropped (`picker !== null ? 'wrap' :
      // 'nowrap'`, the branch as it shipped), this failed on `expected 'wrap' to
      // be 'nowrap'`. Watched, 2026-08-11.
      await threeRoots();

      // 030 waits for nothing: the chipless cell the growth was measured on.
      fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));
      expect(screen.getByRole('listbox')).toBeDefined();
      expect(stripOf('030').strip.style.flexWrap).toBe('nowrap');

      // And the crowded cell is untouched — one chip is enough to need the room.
      fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
      dependOn('020', '010');
      await waitFor(() => {
        expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
      });
      expect(stripOf('020').strip.style.flexWrap).toBe('wrap');
    },
  );

  itDom('answers to one name, with no tooltip saying a different one', async () => {
    // The name is `Make 030 wait for something`, chosen so that this control
    // and the box beside it are not two controls under one name. A
    // `title="Add a dependency"` was here as well, which put the control back
    // under two: the tooltip a sighted reader gets and the name a reader's
    // walk announces disagreed, and neither is the other's summary (codex
    // review, 2026-08-11).
    //
    // Proof: `title="Add a dependency"` restored on the button, this failed on
    // `expected 'Add a dependency' to be null`. Watched, 2026-08-11.
    await threeRoots();

    const add = addButtonOf('030');
    expect(saidBy(add)).toBeNull();
    expect(add.getAttribute('aria-label')).toBe('Make 030 wait for something');
  });
});

describe('picking dependencies from a list', () => {
  const depInput = (rowNumber: string) => screen.getByLabelText(`Add a dependency to ${rowNumber}`);
  /**
   * The Depends on list's entries, scoped to that listbox.
   *
   * Not a bare `getAllByRole('option')`: the toolbar's estimate-method
   * `<select>` contributes four options of its own, and a query across the
   * whole page would read the picker's list as starting with `PERT`.
   */
  const optionTexts = () => {
    const list = screen.queryAllByRole('listbox').find((box) => box.id.startsWith('dep-options-'));
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  itDom('offers every other row as `number - name`, while the cell is focused', async () => {
    await threeRoots();
    fireEvent.focus(depInput('020'));

    // The separator is the assertion, not decoration around it: a bare space
    // ran `010` into a name and the two halves read as one word.
    //
    // Proof: the option's `{entry.number} - {entry.name}` cut back to
    // `{entry.name}` — the number gone from the label a person picks by.
    // **Eleven** tests failed, `11 failed | 290 passed`: this one on `expected
    // [ 'Strip', 'Paint' ] to deeply equal [ '010 - Strip', '030 - Paint' ]`,
    // `narrows the list by the number too` on `expected [ 'Strip' ] to deeply
    // equal [ '010 - Strip' ]`, and nine more — the rest of this describe and
    // every greyed-row test, three of them on `Unable to find an accessible
    // element with the role "option" and name "010 - Strip"`. Watched,
    // 2026-08-09.
    expect(optionTexts()).toEqual(['010 - Strip', '030 - Paint']);
  });

  itDom('narrows the list by name as letters are typed', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pai' } });
    expect(optionTexts()).toEqual(['030 - Paint']);
  });

  itDom('narrows the list by the number too, which is what is on the chips', async () => {
    // The other half of `pickerEntries`'s filter, and the half a person reaches
    // for: the chips in this cell say `010 ✕` and the Number column says `010`,
    // so `010` is what gets typed. Both halves need a test — a filter over the
    // name alone passes the one above and fails here.
    //
    // Proof: `row.number.toLowerCase().includes(wanted) ||` dropped from
    // `pickerEntries` — this test failed on `expected [] to deeply equal [ '010
    // - Strip' ]`, typing a number having narrowed the list to nothing at all.
    // **Six** failed in that run, `6 failed | 306 passed`: `pickerEntries >
    // filters by number substring` and one more in `dep-picker.test.ts`, and
    // three of the command chords, which reach the open list by typing a
    // number into it. Watched, 2026-08-09.
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '010' } });
    expect(optionTexts()).toEqual(['010 - Strip']);
  });

  itDom('adds the clicked entry and keeps the list open for the next pick', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('option', { name: '010 - Strip' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
    });
    // Still open, cleared, and no longer offering what was just taken.
    expect(optionTexts()).toEqual(['030 - Paint']);
    expect(input).toHaveProperty('value', '');
  });

  itDom('Enter adds the entry the typing narrowed to', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pa' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });

  itDom('arrows move the highlight and Enter takes it', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });

  itDom('Enter with nothing typed and nothing highlighted adds nothing', async () => {
    const api = await threeRoots();
    const added: unknown[] = [];
    api.addDependency = (...args: unknown[]) => {
      added.push(args);
      return Promise.resolve();
    };
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(added).toEqual([]);
  });

  itDom('Escape closes the list', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    expect(optionTexts()).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(optionTexts()).toEqual([]);
  });

  itDom('leaving the cell closes the list', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    expect(optionTexts()).toHaveLength(2);
    fireEvent.blur(input);
    expect(optionTexts()).toEqual([]);
  });

  itDom('pressing the mouse on an option does not steal the focus', async () => {
    // In a real browser an unprevented mousedown blurs the input, the blur
    // closes the list, and the click lands on nothing. jsdom fires no blur on
    // its own, so the observable here is the prevention itself.
    await threeRoots();
    fireEvent.focus(depInput('020'));
    const option = screen.getByRole('option', { name: '010 - Strip' });
    const press = createEvent.mouseDown(option);
    fireEvent(option, press);
    expect(press.defaultPrevented).toBe(true);
  });

  itDom('pressing the mouse on the list itself does not steal the focus either', async () => {
    // The list scrolls past ~10 entries, and a scrollbar drag is a mousedown
    // on the ul, not on any option. Unprevented, it blurred the input and the
    // list unmounted under the pointer — cross review #6.
    await threeRoots();
    fireEvent.focus(depInput('020'));
    const list = screen.getByRole('listbox');
    const press = createEvent.mouseDown(list);
    fireEvent(list, press);
    expect(press.defaultPrevented).toBe(true);
  });

  itDom('the highlight follows its row when a peer edit reshuffles the list', async () => {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    const sand = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Sand',
    });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: sand.id,
      name: 'Paint',
    });
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    const input = await screen.findByLabelText('Add a dependency to 020');

    // Highlight Paint by hand: Down to Strip, Down again to Paint.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint.id}`);

    // A peer inserts a row between Strip and Sand. By index the highlight
    // would now sit on the newcomer; it must stay on Paint.
    await api.createWorkItem('p1', { parentId: null, afterId: strip.id, name: 'Wedge' });
    notify();
    await waitFor(() => {
      expect(optionTexts()).toHaveLength(3);
    });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint.id}`);

    fireEvent.keyDown(input, { key: 'Enter' });
    // After the insert the rows renumbered: Sand is 030 and Paint 040. The
    // chip is the read the user gets, and it names the row the highlight was
    // on — not the one that took its index. (`api.rows` keeps a static
    // dependsOn; edges only materialize through tree(), so the chip is also
    // the honest assertion.)
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 040')).toBeDefined();
    });
  });

  itDom('a typed list of numbers still lands as several dependencies', async () => {
    await threeRoots();
    const input = depInput('020');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '010, 030' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
      expect(screen.getByLabelText('Stop 020 waiting for 030')).toBeDefined();
    });
  });
});

describe('the picker marks what be-01 would refuse', () => {
  /**
   * ```
   * 010    Strip
   *   010.1  Sand
   * 020    Paint
   * ```
   * Built through the api before the render rather than through the table's own
   * keyboard: the shape is the fixture here, not the thing under test.
   */
  const nested = async (
    edges: readonly (readonly ['strip' | 'sand' | 'paint', 'strip' | 'sand' | 'paint'])[] = [],
  ) => {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    const sand = await api.createWorkItem('p1', {
      parentId: strip.id,
      afterId: null,
      name: 'Sand',
    });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    const idOf = { strip: strip.id, sand: sand.id, paint: paint.id };
    for (const [predecessor, successor] of edges) {
      await api.addDependency(idOf[successor], idOf[predecessor]);
    }
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await screen.findByLabelText('Add a dependency to 010.1');
    return {
      api,
      ...idOf,
      notify: () => {
        notify();
      },
    };
  };

  const optionTexts = () => {
    const list = screen.queryAllByRole('listbox').find((box) => box.id.startsWith('dep-options-'));
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  const openPicker = (rowNumber: string) => {
    const input = screen.getByLabelText<HTMLInputElement>(`Add a dependency to ${rowNumber}`);
    fireEvent.focus(input);
    return input;
  };

  /** Every call to `addDependency`, so "nothing was picked" is an observation. */
  const watchAdds = (api: ProjectApi) => recordCalls(api, 'addDependency');

  itDom('greys the row this one sits inside, and says so', async () => {
    await nested();
    openPicker('010.1');
    expect(optionTexts()).toEqual(['010 - Strip — contains this row', '020 - Paint']);
    const refused = screen.getByRole('option', { name: '010 - Strip — contains this row' });
    expect(refused.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: '020 - Paint' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  itDom('greys the row that sits inside this one', async () => {
    await nested();
    openPicker('010');
    expect(optionTexts()).toEqual(['010.1 - Sand — inside this row', '020 - Paint']);
  });

  itDom('greys the row that would loop, through the tree', async () => {
    // `020 Paint` waits for `010.1 Sand`. Sand waiting for Paint is the loop —
    // and so is `010 Strip` waiting for Paint, because Strip's only leaf is
    // Sand and that is the graph be-01 orders.
    await nested([['sand', 'paint']]);

    openPicker('010.1');
    expect(optionTexts()).toEqual(['010 - Strip — contains this row', '020 - Paint — would loop']);

    fireEvent.blur(screen.getByLabelText('Add a dependency to 010.1'));
    openPicker('010');
    expect(optionTexts()).toEqual(['010.1 - Sand — inside this row', '020 - Paint — would loop']);
  });

  itDom('clicking a greyed row adds nothing', async () => {
    const { api } = await nested();
    const added = watchAdds(api);
    openPicker('010.1');

    fireEvent.click(screen.getByRole('option', { name: '010 - Strip — contains this row' }));

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 010')).toBeNull();
  });

  itDom('the arrows step over a greyed row', async () => {
    const { paint } = await nested();
    const input = openPicker('010.1');

    // One press. Down from nothing enters at the top of the list, and the top
    // of this list is refused, so the first thing it may land on is `020`.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);

    // And back up again: still nothing above `020` to reach.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);
  });

  itDom('drops a highlight that a peer’s edit has just made a loop', async () => {
    // The graph moves under an open list. Nothing here is cached, so the mark
    // is re-derived from the tree that arrived — and the entry the highlight
    // was sitting on stops being pickable the moment it stops being writable.
    const { api, sand, paint, notify } = await nested();
    const input = openPicker('010.1');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(`dep-option-${paint}`);

    await api.addDependency(paint, sand);
    notify();
    await waitFor(() => {
      expect(optionTexts()).toContain('020 - Paint — would loop');
    });
    // Watched from here, so the peer's own edit above is not mistaken for one
    // this cell made.
    const added = watchAdds(api);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 020')).toBeNull();
  });

  itDom('Enter takes nothing when the typing narrowed to a greyed row alone', async () => {
    const { api } = await nested();
    const added = watchAdds(api);
    const input = openPicker('010.1');

    fireEvent.change(input, { target: { value: 'strip' } });
    expect(optionTexts()).toEqual(['010 - Strip — contains this row']);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(added).toEqual([]);
    expect(screen.queryByLabelText('Stop 010.1 waiting for 010')).toBeNull();
  });
});

describe('dependencies in the table — cross-review findings', () => {
  /**
   * A tree read with a schedule this component did not compute.
   *
   * The `fakeApi` above works out its own miniature schedule, which makes the
   * date tests a proof about the fake. Both reviewers said so. This returns
   * fixed, distinctive numbers instead: what is asserted is that the table
   * renders what be-01 sent, which is the only part of this the table owns.
   */
  const apiReturning = (
    scheduleError: 'cycle' | null,
    schedule: Partial<WorkItemView['schedule']> = {},
  ): ProjectApi =>
    refusingApi({
      listProjects: () =>
        Promise.resolve([projectListEntry({ name: 'P', createdAt: 1_780_000_000_000 })]),
      createProject: (name: string) => Promise.resolve({ id: 'p1', name, restricted: false }),
      openProject: () => Promise.resolve(),
      setEstimateMethod: () => Promise.resolve(),
      setStartDate: () => Promise.resolve(),
      listTeams: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listWorkItemTypes: () => Promise.resolve([]),
      listServices: () => Promise.resolve([]),
      listExternalSystems: () => Promise.resolve([]),
      addTeam: () => Promise.reject(new Error('not_in_these_tests')),
      listPeople: () => Promise.resolve([]),
      // The table reads the calendar markers on mount, alongside the plan, so a
      // double that stands in for a project has to answer it: unstated, this api
      // refuses on purpose and the refusal arrives as a toast over every case in
      // this file. Empty is what these projects have.
      listCalendarMarkers: () => Promise.resolve([]),
      addPerson: () => Promise.reject(new Error('not_in_these_tests')),
      assignPerson: () => Promise.resolve(),
      renameProject: () => Promise.resolve(),
      duplicateWorkItem: () => Promise.reject(new Error('not_in_these_tests')),
      steps: () => Promise.resolve([DEV]),
      addStep: () => Promise.reject(new Error('not_in_these_tests')),
      renameStep: () => Promise.reject(new Error('not_in_these_tests')),
      removeStep: () => Promise.reject(new Error('not_in_these_tests')),
      tree: () =>
        Promise.resolve(
          planRead({
            seq: 0,
            scheduleError,
            // A cycle takes the slices with the dates: there is no schedule to have
            // placed any.
            slices:
              scheduleError !== null
                ? []
                : [
                    sliceView({
                      id: `w1::${DEV.id}`,
                      workItemId: 'w1',
                      stepId: DEV.id,
                      personId: null,
                      duration: 7,
                      estimated: true,
                      earliestStart: 11,
                      earliestFinish: 18,
                      latestStart: 13,
                      latestFinish: 20,
                      float: 2,
                      critical: false,
                      boundBy: 'projectStart' as const,
                      resourcePredecessorId: null,
                      width: 1,
                      effort: 7,
                      capacityPredecessorIds: [],
                      ...schedule,
                    }),
                  ],
            steps: [DEV],
            assignedPeople: [],
            // Present and empty, never absent: be-01 always sends it, so a fake that
            // left it out would let `teamsOnThePlan` be handed `undefined` here and
            // never in production. A plan whose teams are unlimited is what `[]` says.
            teamCapacities: [],
            priorityBands: [...DEFAULT_PRIORITY_BANDS],
            estimateMethod: 'pert' as const,
            depReach: 'whole-item' as const,
            pertWeights: DEFAULT_PERT_WEIGHTS_VIEW,
            estimateRounding: 'ceil' as const,
            workItems: [
              workItemView({
                id: 'w1',
                parentId: null,
                revision: 0,
                number: '010',
                name: 'Strip',
                notes: '',
                frozenNumber: null,
                priority: null,
                rolledUp: false,
                estimates: {},
                dependsOn: [],
                finalDays: {},
                finalTotal: 0,
                startNoEarlierThan: null,
                startNoEarlierThanReason: null,
                serviceTeamId: null,
                teamIds: [],
                assignees: {},
                doesEveryStep: null,
                dates: null,
                schedule: {
                  duration: 7,
                  estimated: true,
                  earliestStart: 11,
                  earliestFinish: 18,
                  latestStart: 13,
                  latestFinish: 20,
                  float: 2,
                  critical: false,
                  ...schedule,
                },
              }),
            ],
            undoable: false,
            redoable: false,
          }),
        ),
      createWorkItem: () => Promise.resolve({ id: 'w2' }),
      patchWorkItem: () => Promise.resolve(),
      moveWorkItem: () => Promise.resolve(),
      removeWorkItem: () => Promise.resolve(),
      setEstimate: () => Promise.resolve(),
      clearEstimate: () => Promise.resolve(),
      freezeProject: () => Promise.resolve(),
      unfreezeProject: () => Promise.resolve(),
      unfreezeWorkItem: () => Promise.resolve(),
      addDependency: () => Promise.resolve(),
      removeDependency: () => Promise.resolve(),
      undo: () => Promise.reject(new Error('not_in_these_tests')),
      redo: () => Promise.reject(new Error('not_in_these_tests')),
    });

  const cells = async () => {
    const row = await waitFor(() => {
      const found = screen
        .getAllByRole('row')
        .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
      if (found === undefined) throw new Error('no row yet');
      return found;
    });
    return {
      start: row.querySelector('[data-start]')?.textContent,
      finish: row.querySelector('[data-finish]')?.textContent,
      float: row.querySelector('[data-float]')?.textContent,
    };
  };

  itDom('shows the schedule be-01 sent, not one it worked out itself', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null)} />);

    expect(await cells()).toEqual({ start: '11', finish: '18', float: '2' });
  });

  itDom('names a critical row rather than printing its zero', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null, { float: 0, critical: true })} />);

    // One word, which is what the 56px column can hold now that the word is a
    // tag rather than a figure — and what `plan-export.ts` has always printed.
    expect((await cells()).float).toBe('critical');
  });

  itDom('explains a slack figure in its hover title', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null)} />);

    await cells();
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('data-fact')).toBe(
      'This work item can slip 2 workdays before the plan finishes later.',
    );
  });

  itDom('explains what critical means in the hover title', async () => {
    render(<WbsTable projectId="p1" api={apiReturning(null, { float: 0, critical: true })} />);

    await cells();
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('data-fact')).toBe(
      'On the critical path: any delay here moves the whole plan’s finish.',
    );
  });

  itDom('shows dashes rather than zeroes when there is no schedule', async () => {
    // agy, medium. A cycle sends every row the same zeroed schedule, and
    // printing those reads as "everything happens on day zero" — a confident
    // wrong answer, next to a banner saying no dates could be worked out.
    render(<WbsTable projectId="p1" api={apiReturning('cycle')} />);

    expect(await cells()).toEqual({ start: '—', finish: '—', float: '—' });
    expect(screen.getByRole('alert').textContent).toContain('run in a circle');
    const row = screen
      .getAllByRole('row')
      .find((tr) => tr.querySelector('[data-number]')?.textContent === '010');
    expect(row?.querySelector('[data-float]')?.getAttribute('data-fact')).toBe(
      'No schedule could be worked out, so there is no slack to show.',
    );
  });
});

describe('hovering a dependency lights the rows it names', () => {
  const dependOn = (rowNumber: string, predecessorNumber: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value: predecessorNumber } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  /**
   * The Depends on cell itself — the `<td>`, and not the wrapper inside it.
   *
   * It was `cell.firstElementChild` until 2026-08-14, because that is where
   * the cell-level enter and leave lived. They are on the cell now: a wrapper
   * stands inside the cell's padding box, and at the column's resolved 110px
   * the pills fill the wrapper edge to edge, so the gesture the spec names —
   * "the pointer is in this cell" — had nowhere left to be made from.
   * `openspec/changes/table-width-budget/design.md` D2 has the measurement.
   *
   * Proof: the handlers left on the wrapper with this helper already pointing
   * at the `<td>` — which is the fault, spelt as the state before the fix —
   * and all five cases in this block failed together, the first of them on
   * `lights every dependency’s row from the cell, and no other row:
   * expected [] to deeply equal [ '010', '020' ]`. Watched on h2puni,
   * 2026-08-14 (fault F7).
   */
  const hoverTargetOf = (number: string): HTMLElement => {
    const cell = screen.getByLabelText(`Add a dependency to ${number}`).closest('td');
    if (!(cell instanceof HTMLElement)) throw new Error(`no depends cell for ${number}`);
    return cell;
  };

  /** The numbers of every row the table has lit, in document order. */
  const litNumbers = (): string[] =>
    [...document.querySelectorAll('tr[data-dep-lit]')].map((tr) => {
      const number = tr.querySelector('[data-number]')?.textContent;
      if (number == null) throw new Error('a lit row has no number cell');
      return number;
    });

  /** Three roots where 030 waits for 010 and 020, at rest. */
  async function planWhere030Waits() {
    const api = await threeRoots();
    dependOn('030', '010');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    dependOn('030', '020');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    return api;
  }

  /** A rectangle the layout would have measured, on a node jsdom measures as nothing. */
  const measureAs = (
    node: Element,
    box: { left: number; top: number; right: number; bottom: number },
  ) => {
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => ({}),
    });
  };

  itDom(
    'leaves the open card alone when the row beneath it is entered through its padding',
    async () => {
      // The card's padding is passive on purpose — a click through it reaches the
      // row beneath — so a pointer crossing that padding on its way to a card
      // line is, to the browser, a pointer entering the row beneath. If that row
      // has a Depends on cell with something to say, its own `onMouseEnter` would
      // take the card over, and the reader who was about to read 020's list is
      // looking at 030's. The bridge is what decides whether the card stays; an
      // enter that lands where the bridge holds the card is the padding being
      // crossed, not a cell being pointed at, and writes nothing.
      //
      // Found in Chrome, 2026-08-29, on a plan where the row beneath had
      // dependencies of its own: the card switched rows on the way to it. It read
      // as "the card closes for rows with fewer than three dependencies", which
      // was the height at which the card happened to stop covering such a row.
      //
      // jsdom lays nothing out, so the geometry the guard reads is declared here;
      // `e2e/deps-cell.spec.ts`'s `holds the card while the pointer crosses its
      // padding over the row beneath` is the browser hit-testing the same band.
      await threeRoots();
      dependOn('020', '010');
      await waitFor(() => {
        expect(screen.getByLabelText('Stop 020 waiting for 010')).toBeDefined();
      });
      dependOn('030', '020');
      await waitFor(() => {
        expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
      });
      fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));

      const owner = hoverTargetOf('020');
      fireEvent.mouseEnter(owner);
      expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('What 020 waits for');
      expect(litNumbers()).toEqual(['010']);

      // The cell, and the card's one line 7px below its bottom edge: the band
      // between the two is the padding, and it stands over 030's cell.
      measureAs(owner, { left: 100, top: 100, right: 210, bottom: 126 });
      measureAs(screen.getByTestId('depends-card-target'), {
        left: 110,
        top: 133,
        right: 360,
        bottom: 151,
      });
      const beneath = hoverTargetOf('030');
      const inThePadding = { clientX: 150, clientY: 129 };

      fireEvent.mouseEnter(beneath, inThePadding);
      expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('What 020 waits for');
      expect(litNumbers()).toEqual(['010']);

      // The pill under the same padding: its narrowing enter is a hover on the
      // row beneath as well, and would light 030's own dependency instead.
      fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 020'), inThePadding);
      expect(litNumbers()).toEqual(['010']);

      // And the same enter from where no card stands is a cell being pointed at,
      // which is what keeps the guard from being a card that can never be left.
      fireEvent.mouseEnter(beneath, { clientX: 150, clientY: 400 });
      expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('What 030 waits for');
      expect(litNumbers()).toEqual(['020']);
    },
  );

  itDom('takes the pointer on the cell itself, not on a wrapper inside it', async () => {
    // The move, said outright rather than left implicit in a helper. jsdom
    // cannot see *why* it matters — whether a pill covers the place the
    // handler answered from is a hit-testing fact and jsdom lays nothing out
    // (R5 #14–16) — but it can see **where** the handler is, which is the half
    // that is a fact about the markup. `e2e/deps-cell.spec.ts`'s `lights the
    // whole set from a crowded cell at its default width` is the other half.
    //
    // An enter reaches the element entered **and its ancestors**, never its
    // descendants — which is what makes this discriminating in one direction
    // and vacuous in the other. Entering the `<td>` cannot reach a handler on
    // the wrapper inside it, so this assertion is exactly the move; entering
    // the wrapper still reaches a handler on the `<td>`, so the mirror of it
    // would pass either way and is deliberately not written.
    await planWhere030Waits();
    const cell = hoverTargetOf('030');
    expect(cell.tagName).toBe('TD');
    // And the wrapper is really a different element, or the two names above
    // are one element and this test is about nothing.
    expect(cell.firstElementChild).not.toBe(cell);
    expect(cell.firstElementChild?.tagName).toBe('SPAN');

    fireEvent.mouseEnter(cell);
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(cell);
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    });
    expect(litNumbers()).toEqual([]);
  });

  itDom('lights every dependency’s row from the cell, and no other row', async () => {
    await planWhere030Waits();
    expect(litNumbers()).toEqual([]);

    fireEvent.mouseEnter(hoverTargetOf('030'));

    // 010 and 020 — the rows 030 waits for — and pointedly not 030 itself:
    // deriving the lit set from the hovered row's own id is the wrong-id
    // fault this assertion exists to catch.
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(hoverTargetOf('030'));
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    });
    expect(litNumbers()).toEqual([]);
  });

  itDom(
    'keeps the card mounted across passive padding and lets the bridge clear outside',
    async () => {
      await planWhere030Waits();
      const owner = hoverTargetOf('030');
      fireEvent.mouseEnter(owner);
      expect(litNumbers()).toEqual(['010', '020']);

      // Passive card padding hit-tests the table underneath, so the owner sees a
      // non-null related target before the pointer reaches a card row. The leave
      // must not synchronously remove the row targets the pointer is travelling
      // towards.
      fireEvent.mouseLeave(owner, { relatedTarget: screen.getByLabelText('Name of 020') });
      expect(screen.getByRole('tooltip')).toBeDefined();
      expect(litNumbers()).toEqual(['010', '020']);

      act(() => {
        document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(litNumbers()).toEqual([]);
    },
  );

  itDom('narrows to the pill’s row, and widens again when the pill is left', async () => {
    await planWhere030Waits();
    fireEvent.mouseEnter(hoverTargetOf('030'));
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual(['010']);

    // Off the pill but still in the cell: back to the whole waited-for set,
    // not stuck on the one pill and not cleared. `relatedTarget` names where
    // the pointer went — jsdom's default of null reads as leaving the whole
    // cell, which fires the wrapper's leave too and would make this pass for
    // the wrong reason.
    fireEvent.mouseLeave(screen.getByLabelText('Stop 030 waiting for 010'), {
      relatedTarget: screen.getByLabelText('Add a dependency to 030'),
    });
    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.mouseLeave(hoverTargetOf('030'));
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    });
    expect(litNumbers()).toEqual([]);
  });

  itDom(
    'widens back to the remaining dependencies when a pill is deleted under the pointer',
    async () => {
      await planWhere030Waits();
      fireEvent.mouseEnter(hoverTargetOf('030'));
      fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));
      expect(litNumbers()).toEqual(['010']);

      // The ✕ *is* the pill, and that is the whole of the fault: the click
      // unmounts the element the pointer is on, so no `mouseleave` of its own
      // can ever arrive to say the pointer left it. Nothing else moves here —
      // no leave is fired, no hover is re-entered — because nothing else moves
      // in the browser either. The pointer is exactly where it was.
      fireEvent.click(screen.getByLabelText('Stop 030 waiting for 010'));
      await waitFor(() => {
        expect(screen.queryByLabelText('Stop 030 waiting for 010')).toBeNull();
      });

      // The cut edge's row is dark and the remaining dependency's is lit: the
      // light widened to the cell, because the cell is where the pointer still
      // is. Both ends of the fix answer to this one assertion, with a red of
      // their own: with the chip's widen dropped the light goes out altogether
      // (`expected [] to deeply equal ['020']`), and with `depLit`'s check of
      // `pillId` against the cell dropped as well it stays on the deleted edge
      // (`expected ['010'] to deeply equal ['020']`).
      expect(litNumbers()).toEqual(['020']);
    },
  );

  itDom('lights the rows a cell waits for while its box holds the focus', async () => {
    await planWhere030Waits();
    expect(litNumbers()).toEqual([]);

    // The keyboard's half of the light. Tab through the plan lands on this box
    // — `deps-single-line` keeps the chips out of the rested tab order, so the
    // box is where a Tab arrives — and the rows this row waits for light with
    // no pointer anywhere near them.
    //
    // `fireEvent.focus` and not `.focus()`: React reads focus through
    // `focusin`, which is what this dispatches, and it is wrapped in `act` so
    // the render it causes has landed by the assertion below. A bare `.focus()`
    // moves `document.activeElement` and leaves the state update unflushed —
    // watched, `expected [] to deeply equal ['010', '020']`. That a real Tab
    // reaches this box and really paints is the browser's to say, in
    // `e2e/hover-cards.spec.ts`.
    fireEvent.focus(screen.getByLabelText('Add a dependency to 030'));

    expect(litNumbers()).toEqual(['010', '020']);

    fireEvent.blur(screen.getByLabelText('Add a dependency to 030'));
    expect(litNumbers()).toEqual([]);
  });

  itDom('narrows to a focused pill, and clears when the focus leaves it', async () => {
    await planWhere030Waits();
    const box = screen.getByLabelText('Add a dependency to 030');
    fireEvent.focus(box);
    expect(litNumbers()).toEqual(['010', '020']);

    // The chips are focusable while the picker owns the cell — the `tabIndex`
    // −1 above is the *rested* strip's, where a clipped chip would be a button
    // focused off screen — so this is a focus that can really be carried, and
    // it narrows exactly as a hovered pill does. Box first, then chip, in the
    // order a browser fires them: the old element's blur lands before the new
    // one's focus, which is why the box's blur cannot clear what the chip's
    // focus is about to write.
    fireEvent.blur(box);
    fireEvent.focus(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual(['010']);

    // A blur clears where a mouseleave widens, and the asymmetry is the point:
    // a leave means the pointer is still in the cell and the wrapper's own
    // leave is what clears, but a blur means nothing of the sort. Widening here
    // would leave the cell lit with nobody in it once the focus walked out of
    // the plan from a chip.
    fireEvent.blur(screen.getByLabelText('Stop 030 waiting for 010'));
    expect(litNumbers()).toEqual([]);
  });

  itDom('emphasises the pill’s entry in the card as a background, not bold', async () => {
    await planWhere030Waits();
    fireEvent.mouseEnter(hoverTargetOf('030'));
    const card = screen.getByRole('tooltip');
    const entryOf = (text: string): HTMLElement => {
      const found = [...card.querySelectorAll('div')].find((line) => line.textContent === text);
      if (!(found instanceof HTMLElement)) throw new Error(`no card entry reading ${text}`);
      return found;
    };
    // From the cell's input area no entry is emphasised — the whole list is.
    expect(entryOf('010 - Strip').style.background).toBe('');
    expect(entryOf('020 - Sand').style.background).toBe('');

    fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));

    // The same tint the lit rows use, as a background swatch — emphasis by
    // weight would make one line read as a heading over the others. The card's
    // surface token, not the grid's: the same dose of the same ink into the
    // surface this line sits on, which is what keeps the emphasis moving the
    // same perceptual direction in both places (`styles.css`, and the browser
    // proof in `e2e/hover-cards.spec.ts` that walks both palettes).
    expect(entryOf('010 - Strip').style.background).toBe('var(--card-dep-lit)');
    expect(entryOf('010 - Strip').style.fontWeight).toBe('');
    expect(entryOf('020 - Sand').style.background).toBe('');

    // To the input area, not out of the cell (`relatedTarget`, as above): the
    // card stays open and no entry is singled out any more.
    fireEvent.mouseLeave(screen.getByLabelText('Stop 030 waiting for 010'), {
      relatedTarget: screen.getByLabelText('Add a dependency to 030'),
    });
    expect(entryOf('010 - Strip').style.background).toBe('');
  });

  itDom('a collapsed dependency has no row to light, and the card still names it', async () => {
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
    typeName('010.1', 'Sand the keel');
    fireEvent.blur(screen.getByLabelText('Name of 010.1'));
    // The rename is in flight and `Add work item` is disabled while it is;
    // settled first, or the click lands on a busy button and does nothing.
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 010.1')).toHaveProperty('value', 'Sand the keel');
    });
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    dependOn('020', '010.1');
    await waitFor(() => {
      expect(screen.getByLabelText('Stop 020 waiting for 010.1')).toBeDefined();
    });
    fireEvent.blur(screen.getByLabelText('Add a dependency to 020'));

    // The probe proven live before the branch closes (R5 #16, `D
    // directory-page`): the same hover lights 010.1 while its row is shown.
    fireEvent.mouseEnter(hoverTargetOf('020'));
    expect(litNumbers()).toEqual(['010.1']);
    fireEvent.mouseLeave(hoverTargetOf('020'));

    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    fireEvent.mouseEnter(hoverTargetOf('020'));

    // No shown row is 010.1, so nothing is lit — the parent 010 must not be
    // lit in its place — and the card still names the hidden dependency.
    expect(litNumbers()).toEqual([]);
    expect(screen.getByRole('tooltip').textContent).toContain('010.1 - Sand the keel');
  });

  itDom('lights rows without remounting the cells under a half-typed name', async () => {
    // The landmine: `columns` may depend on `steps` and `unfoldedSteps` and
    // nothing else. A `columns` that rebuilt on `depHover` would hand every
    // cell a new component type on the first hover, and React would remount
    // the lot — dropping the focus to the body and the half-typed name with
    // it. The lit rows are asserted first so this cannot pass vacuously on a
    // hover that wrote nothing.
    //
    // Proof: `depHover` added to the `columns` memo's dependency list, this
    // failed on `expected <textarea …(5)></textarea> to be <textarea
    // …(5)></textarea>` — the same-labelled box a different node, the cell
    // remounted under the typist. Watched, 2026-08-10.
    await planWhere030Waits();
    const input = screen.getByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    fireEvent.mouseEnter(hoverTargetOf('030'));

    expect(litNumbers()).toEqual(['010', '020']);
    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('narrowing to a pill re-renders the row whose light moved and nothing else', async () => {
    // The whole point of `dep-light-store.ts`. `depHover` was a `useState` at
    // the top of `WbsTable` until 2026-09-02, so a pointer crossing a chip
    // re-rendered every row, every cell and the Gantt — the cells read their
    // live state through `live.current` and rely on every parent render
    // reaching every cell, which is exactly what makes a memo impossible here
    // and a store the only address the light can live at.
    //
    // The measurement is taken **inside** an open card rather than across the
    // card's own open: entering the cell mounts the hover card, which is React
    // state either way and would swamp the reading. Pointer already in the
    // cell, moving onto a pill narrows the lit set from both entries to one, so
    // exactly one row's light moves.
    //
    // Proof: `updateHover` routed back through a `WbsTable` `useState` (the
    // shape this replaced), this failed on `expected 4 to be less than or
    // equal to 2` — the three rows and the heading, re-rendered to move one
    // row's light. Watched 2026-09-02.
    await planWhere030Waits();
    fireEvent.mouseEnter(hoverTargetOf('030'));
    expect(litNumbers()).toEqual(['010', '020']);

    const columnCount = document.querySelectorAll('thead th').length;
    const before = cellStyleCalls.count;
    fireEvent.mouseEnter(screen.getByLabelText('Stop 030 waiting for 010'));
    // The light really moved, or the count below is about nothing.
    expect(litNumbers()).toEqual(['010']);

    const rendered = (cellStyleCalls.count - before) / columnCount;
    expect(rendered).toBeLessThanOrEqual(2);
  });
});

describe('adding several dependencies at once', () => {
  const typeDeps = (rowNumber: string, value: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  itDom('adds every number in one comma-separated list', async () => {
    // A row that waits for three things is ordinary. Typing it three times was
    // not. Asked for on 2026-08-06.
    const api = await threeRoots();
    const added = recordCalls(api, 'addDependency');

    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
    expect(added).toHaveLength(2);
  });

  itDom('takes spaces as readily as commas', async () => {
    await threeRoots();

    typeDeps('030', '010 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByLabelText('Stop 030 waiting for 020')).toBeDefined();
  });

  itDom('keeps the good numbers when one in the list is a typo', async () => {
    // Discarding a correct entry because of the one beside it is how a field
    // stops being used.
    await threeRoots();

    typeDeps('030', '010, 999');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByRole('alert').textContent).toContain('No work item numbered 999');
  });

  itDom('names every dependency the server refused, and keeps the rest', async () => {
    const api = await threeRoots();
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      const number = api.rows.find((r) => r.id === predecessorId)?.number;
      if (number === '020') return Promise.reject(new Error('cycle'));
      return real(id, predecessorId);
    };

    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.getByRole('alert').textContent).toContain('020 (cycle)');
    expect(screen.queryByLabelText('Stop 030 waiting for 020')).toBeNull();
  });

  itDom('still takes a single number, which is most of the typing', async () => {
    await threeRoots();

    typeDeps('030', '010');

    await waitFor(() => {
      expect(screen.getByLabelText('Stop 030 waiting for 010')).toBeDefined();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
