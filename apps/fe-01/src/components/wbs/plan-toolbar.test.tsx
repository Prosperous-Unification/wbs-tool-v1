import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

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

/** What the toast stack is saying, newest first. */
const toastTexts = (): string[] =>
  [...document.querySelectorAll('[data-toast-text]')].map((node) => node.textContent);

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
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

// The table remembers each project's open branches in localStorage, so one
// test's collapsing would arrive as the next test's starting shape.
beforeEach(() => {
  localStorage.clear();
});

const typeIntoDate = (label: string, day: string): void => {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: day } });
  fireEvent.blur(box);
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

describe('the plan toolbar’s controls', () => {
  /** Every control on the toolbar row, by the name a reader is told it has. */
  const toolbarControlNames = (): string[] => {
    const toolbar = document.querySelector<HTMLElement>('[data-toolbar]');
    if (toolbar === null) throw new Error('the table rendered no toolbar');
    return within(toolbar)
      .getAllByRole('button')
      .map((control) => control.getAttribute('aria-label') ?? control.textContent.trim());
  };

  itDom('one control offers both writes', async () => {
    // The spec's first scenario, and the shape of the argument for it: a plan
    // may be **partly** frozen — a row's own ⋯ unfreezes one row — so the two
    // writes are not a toggle and must not be offered as one. One control, two
    // items, both always there.
    //
    // Proof: `Unfreeze all` put back on the bar as a second `<Button>` beside
    // the menu, this failed on `expected [ 'Freeze #', 'Unfreeze all' ] to
    // deeply equal [ 'Freeze #' ]`. Watched, 2026-08-29.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('button', { name: 'Add work item' });

    expect(toolbarControlNames().filter((name) => /freeze/i.test(name))).toEqual(['Freeze #']);

    click('Freeze #');

    expect(screen.getByRole('menuitem', { name: 'Freeze numbering' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Unfreeze all' })).toBeDefined();
    // Neither is refused on a plan in no particular state: `Unfreeze all` with
    // nothing frozen is a no-op write, which is what it was as a button.
    for (const label of ['Freeze numbering', 'Unfreeze all']) {
      expect(screen.getByRole('menuitem', { name: label }).getAttribute('aria-disabled')).toBe(
        'false',
      );
    }
  });

  itDom('takes each of the two writes when its item is taken', async () => {
    // The writes themselves, once, at the new entry point — the eight cases
    // re-pointed through `takeFreezeAction` say what freezing *does* to a row,
    // and this one says the menu is wired to the two calls at all.
    const api = fakeApi();
    const asked: string[] = [];
    api.freezeProject = () => {
      asked.push('freeze');
      return Promise.resolve();
    };
    api.unfreezeProject = () => {
      asked.push('unfreeze-all');
      return Promise.resolve();
    };
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('button', { name: 'Add work item' });

    takeFreezeAction('Freeze numbering');
    await waitFor(() => {
      expect(asked).toEqual(['freeze']);
    });

    takeFreezeAction('Unfreeze all');
    await waitFor(() => {
      expect(asked).toEqual(['freeze', 'unfreeze-all']);
    });
  });

  itDom('⌘+Z is inert while the freeze menu is open, and works again once it closes', async () => {
    // The freeze menu joining the inert-while-open set, which for a **toolbar**
    // menu is the page's own chords and nothing else: `onCommandKey` is wired
    // to cells, and a menu item is not a cell, so a Ctrl+N fired at one could
    // never have reached the plan and a test that fired it there could not
    // fail. What can reach past an open menu is the page-level chord, and this
    // is it — the same fault `⌘+Z is inert while a row’s ⋯ menu is open`
    // watched on 2026-08-09, one menu along.
    //
    // Proof: `usePageShortcutsSuspended(open)` pinned to `false` in
    // `MenuControl`, this failed on `expected [ 'undo' ] to deeply equal []`.
    // Watched, 2026-08-29.
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });
    click('Freeze #');
    const item = screen.getByRole('menuitem', { name: 'Freeze numbering' });

    fireEvent.keyDown(item, { key: 'z', ctrlKey: true });

    expect(api.stackCalls).toEqual([]);
    // Still open: the chord was swallowed, not turned into a dismissal.
    expect(screen.getByRole('menu', { name: 'Freeze #' })).toBeDefined();

    fireEvent.keyDown(item, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('table'), { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
  });

  itDom('the controls are found by the names they always had', async () => {
    // The expand/collapse pair as icon buttons. The names are the thing that
    // did **not** change, and the proof that they held is the eight existing
    // `Expand all`/`Collapse all` cases elsewhere in this file passing
    // unchanged — this one adds only the half those cannot see: that the words
    // are no longer on the face of the button.
    //
    // Proof: `aria-label` dropped from `Collapse all`, this failed on `Unable
    // to find role="button" and name "Collapse all"` — and four cases that
    // were not touched at all failed with it, which is the half that matters:
    // `the expansion controls stand down while a search is on`, `collapses
    // every branch and opens them all again`, `remembers each project
    // separately`, and `stands the expansion controls down while a facet is on
    // with nothing typed`. Two more in `plan-cards.test.tsx`. Watched,
    // 2026-08-29.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    const collapse = await screen.findByRole('button', { name: 'Collapse all' });
    const expand = screen.getByRole('button', { name: 'Expand all' });

    expect(collapse.textContent).toBe('');
    expect(expand.textContent).toBe('');
    expect(collapse.querySelector('svg')).not.toBeNull();
    expect(expand.querySelector('svg')).not.toBeNull();
    // The hover words stay, which is the sighted reader's half of the name.
    expect(collapse.getAttribute('data-hint')).toBe('Close every branch');
    expect(expand.getAttribute('data-hint')).toBe('Open every branch');
    // Two shapes, not one rotated: a plan-wide control and a row's `▾`/`▸` must
    // not be the same drawing with two meanings.
    expect(collapse.querySelector('svg')?.innerHTML).not.toBe(
      expand.querySelector('svg')?.innerHTML,
    );
  });

  itDom('the cheat sheet control carries a drawn icon', async () => {
    // `⌨` (U+2328) has no colour presentation on macOS and renders as a
    // hairline outline in the UI font at button size — the control's meaning
    // was carried entirely by a codepoint whose rendering the app does not
    // control.
    //
    // Proof: `⌨` put back as the button's child beside the icon, this failed on
    // `expected '⌨' to be ''`. Watched, 2026-08-29.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    const control = await screen.findByRole('button', { name: 'Keyboard shortcuts' });

    expect(control.textContent).toBe('');
    const drawn = control.querySelector('svg');
    expect(drawn).not.toBeNull();
    expect(drawn?.getAttribute('aria-hidden')).toBe('true');
    expect(drawn?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('sharing the plan', () => {
  /**
   * Puts a clipboard on `navigator` for one test.
   *
   * jsdom ships none, which is the same shape as an http page in a real
   * browser — so the absent case below needs no stub at all, and the two
   * present cases need this one.
   */
  const stubClipboard = (writeText: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  };

  /**
   * What `URL.createObjectURL` was handed, and what an anchor was told to
   * download.
   *
   * jsdom implements neither the object URL nor a download, so both are
   * replaced for the length of a test and put back after. The blob is kept
   * rather than only counted: the file's first bytes are the assertion.
   */
  const captureDownloads = (): { blobs: Blob[]; names: string[]; revoked: string[] } => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    const revoked: string[] = [];
    // jsdom defines neither, so this is an assignment rather than a spy.
    const urls = URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    urls.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:plan-${String(blobs.length)}`;
    };
    urls.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    HTMLAnchorElement.prototype.click = function capture(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    return { blobs, names, revoked };
  };

  /**
   * The bytes of a blob, through `FileReader`.
   *
   * jsdom's `Blob` has no `text()`, and the bytes are what is wanted anyway:
   * `readAsText` strips a leading byte-order mark per spec, so a text read
   * could not tell a file that carries one from a file that does not.
   */
  const readBlobBytes = (blob: Blob): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const read = reader.result;
        if (read instanceof ArrayBuffer) resolve(new Uint8Array(read));
        else reject(new Error('the downloaded blob read back as something else'));
      };
      reader.onerror = () => {
        reject(new Error('the downloaded blob could not be read'));
      };
      reader.readAsArrayBuffer(blob);
    });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
  });

  /** One named, estimated row, so an export has something to disagree about. */
  const onePlannedRow = async (): Promise<ReturnType<typeof fakeApi>> => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeName('010', 'Strip, sand & paint');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip, sand & paint');
    });
    return api;
  };

  itDom('offers all six ways of taking the plan out of the tool, in one Export menu', async () => {
    // `configurable-columns` measured the toolbar at 1280: 683px of five rare
    // actions on one row, and a Columns control pushed it to three rows. The
    // five live behind one `Export` summary now — the same `<details>` the
    // Filters and Views controls are — so the row holds what a reader does
    // often and the exports are one click further. jsdom cannot see a closed
    // `<details>` hide its children, so what is asserted is where they live:
    // inside the menu, in this order, and nowhere else on the toolbar.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    expect(await screen.findByRole('button', { name: 'Copy as Markdown' })).toBeInTheDocument();
    const menu = document.querySelector<HTMLElement>('[data-toolbar] details[data-export]');
    if (menu === null) throw new Error('no Export menu on the toolbar');
    expect(menu.querySelector('summary')?.textContent).toBe('Export');
    expect([...menu.querySelectorAll('button')].map((button) => button.textContent.trim())).toEqual(
      [
        'Copy as Markdown',
        'Copy as Mermaid',
        'Download CSV',
        'Download as Markdown',
        'Download chart as SVG',
        'Download what’s on screen',
      ],
    );
    // Proof: the `<details>` replaced by a plain `<div>` around the five, this
    // failed on `no Export menu on the toolbar`. Watched, 2026-08-28.
  });

  itDom('draws Undo and Redo as glyphs that still answer to their names', async () => {
    // 55px of word each where a 33px glyph does the job the ⌨ beside them
    // already proved; the name stays on the control for a reader who cannot see
    // the glyph and for the tests that click it by name.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(undo.textContent).toBe('↶');
    expect(redo.textContent).toBe('↷');
    expect(undo.getAttribute('data-hint')).toContain('Ctrl/⌘ + Z');
    expect(redo.getAttribute('data-hint')).toContain('Ctrl/⌘ + Shift + Z');
  });

  itDom('copies the whole plan, header first, and says it did', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied as Markdown.']);
    });
    const [markdown] = copied;
    expect(markdown).toContain('**Project:** Rewire the shed');
    expect(markdown).toContain('**Final figures:** PERT');
    expect(markdown).toContain('| Strip, sand & paint |');
    // An info toast, so no alert role: nothing was refused.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('says so when the clipboard refuses the write', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('refused the clipboard')]);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('says so when the page has no clipboard at all', async () => {
    // No stub: jsdom has none, which is what an http page has.
    await onePlannedRow();

    click('Copy as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('no clipboard')]);
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('copies the chart as a Mermaid gantt, and says it did', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();
    typeIntoDate('Project start date', '2026-08-03');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    click('Copy as Mermaid');

    await waitFor(() => {
      expect(toastTexts()).toEqual(['Copied as Mermaid.']);
    });
    const [diagram] = copied;
    expect(diagram).toContain('gantt');
    expect(diagram).toContain('dateFormat');
    // An info toast, so no alert role: nothing was refused.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('says so when there is no diagram to draw, and copies nothing', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await onePlannedRow();

    click('Copy as Mermaid');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('not on a calendar')]);
    });
    expect(copied).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  itDom('downloads a CSV named after the project and the day, and lets the URL go', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();

    click('Download CSV');

    expect(downloads.names).toHaveLength(1);
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(downloads.revoked).toEqual(['blob:plan-1']);
    // `.at`, not `[0]`: the index signature would hand back a `Blob` whatever
    // is in the array, and the guard below would then be checking nothing.
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    expect(file.type).toBe('text/csv;charset=utf-8');
    const bytes = await readBlobBytes(file);
    // The byte-order mark first, or Excel on Windows reads the em dashes and
    // every non-ASCII name as the system codepage.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Project,Rewire the shed');
    // The name holds a comma, so it is quoted rather than splitting the row.
    expect(text).toContain('"Strip, sand & paint"');
    expect(text).toContain('\r\n');
  });

  itDom('carries a work item deadline from the plan read into the downloaded CSV', async () => {
    // Proof: replacing `planForExport`'s rows with copies whose deadline was
    // null made this fail on `expected … to contain '2026-09-30'`; the CSV kept
    // the deadline header but its one production-row cell was empty.
    const downloads = captureDownloads();
    const api = fakeApi();
    const row = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Deadline row',
    });
    await api.patchWorkItem(row.id, { deadline: '2026-09-30' });
    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    await screen.findByLabelText('Name of 010');

    click('Download CSV');

    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    const text = new TextDecoder().decode(await readBlobBytes(file));
    expect(text).toContain('Work item deadline');
    expect(text).toContain('2026-09-30');
  });

  itDom('downloads the bundled Markdown document, the fence and the table together', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();
    typeIntoDate('Project start date', '2026-08-03');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    click('Download as Markdown');

    expect(downloads.names).toHaveLength(1);
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}\.md$/);
    expect(downloads.revoked).toEqual(['blob:plan-1']);
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    expect(file.type).toBe('text/markdown;charset=utf-8');
    const text = new TextDecoder().decode(await readBlobBytes(file));
    expect(text).toContain('```mermaid');
    expect(text).toContain('gantt');
    expect(text).toContain('| Strip, sand & paint |');
    // Q6 of the R7 brief: which rows are in this document, since the chart on
    // screen and this document do not agree.
    expect(text).toContain('the whole plan, not what is on screen');
  });

  itDom('says so when there is nothing to bundle, and downloads nothing', async () => {
    const downloads = captureDownloads();
    await onePlannedRow();

    click('Download as Markdown');

    await waitFor(() => {
      expect(toastTexts()).toEqual([expect.stringContaining('not on a calendar')]);
    });
    expect(downloads.names).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  describe('the lane the Mermaid exports are grouped into', () => {
    /** Where this browser's one answer lives — not per project, unlike the four layout keys. */
    const KEY = 'wbs.mermaidSectionMode';

    /** The picker, or a thrown error rather than a null the assertions walk into. */
    const lanes = (): HTMLSelectElement =>
      screen.getByLabelText<HTMLSelectElement>('Mermaid lanes');

    /**
     * One named row on a calendar, which is the least a fence can be drawn of.
     *
     * The start date is what the two Mermaid exports refuse without, so every
     * test below that reads a fence needs it — `NOT_ON_A_CALENDAR` otherwise,
     * and a refusal carries no `section` line to assert about.
     */
    const plannedRowOnACalendar = async (): Promise<void> => {
      await onePlannedRow();
      typeIntoDate('Project start date', '2026-08-03');
      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
          false,
        );
      });
    };

    itDom('offers the three lanes inside the Export menu, and opens on outline', async () => {
      const api = fakeApi();
      render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
      // Proof: reading synchronously while the initial tree was still loading
      // failed here with `Unable to find a label with the text of: Mermaid lanes`.
      // Export becomes available only after the successful tree read it exports.
      const picker = await screen.findByLabelText<HTMLSelectElement>('Mermaid lanes');
      expect([...picker.options].map((option) => option.value)).toEqual([
        'outline',
        'step',
        'assignee',
      ]);
      expect(picker.value).toBe('outline');
      // Where it lives is the whole reason it is a `<select>` in a panel rather
      // than three buttons on the bar: the Export `<details>`'s panel is
      // `absolute`, so a control in it costs the folded toolbar's 1600px budget
      // (`e2e/layout.spec.ts`) nothing at all.
      //
      // Proof: the `<label>` moved out of the `<details>` and onto the toolbar
      // beside it — `1 failed | 7 passed` on `AssertionError: expected null to
      // be <select …(2)>…(3)</select>`, the picker no longer inside the Export
      // menu. Watched, 2026-08-30.
      expect(
        document.querySelector('[data-toolbar] details[data-export] [data-export-panel] select'),
      ).toBe(picker);
    });

    itDom('copies the fence grouped by step when the picker says step', async () => {
      const copied: string[] = [];
      stubClipboard((text) => {
        copied.push(text);
        return Promise.resolve();
      });
      await plannedRowOnACalendar();

      fireEvent.change(lanes(), { target: { value: 'step' } });
      click('Copy as Mermaid');

      await waitFor(() => {
        expect(toastTexts()).toEqual(['Copied as Mermaid.']);
      });
      const [diagram] = copied;
      // The row's one slice is estimated under `Dev`, so the two lanes name the
      // fence's sections differently and the assertion can tell them apart —
      // which is what a `toContain('section')` could not.
      //
      // Proof: `copyAsMermaid`'s call site reverted to
      // `planToMermaid(planForExport())`, the shape M3 shipped with —
      // `3 failed | 5 passed`, this one on `AssertionError: expected 'gantt\n
      // title Rewire the shed\n …' to contain 'section Dev'`, with the two
      // other fence readers below it. Watched, 2026-08-30.
      expect(diagram).toContain('section Dev');
      expect(diagram).not.toContain('section 010 Strip, sand & paint');
    });

    itDom('copies the fence grouped by assignee when the picker says assignee', async () => {
      const copied: string[] = [];
      stubClipboard((text) => {
        copied.push(text);
        return Promise.resolve();
      });
      await plannedRowOnACalendar();

      fireEvent.change(lanes(), { target: { value: 'assignee' } });
      click('Copy as Mermaid');

      await waitFor(() => {
        expect(toastTexts()).toEqual(['Copied as Mermaid.']);
      });
      const [diagram] = copied;
      // Nobody is on this row, and the absent case is the one worth asserting:
      // it is a section of its own rather than a dropped bar.
      expect(diagram).toContain('section unassigned');
      expect(diagram).not.toContain('section 010 Strip, sand & paint');
    });

    itDom('bundles the downloaded document in the same lane', async () => {
      const downloads = captureDownloads();
      await plannedRowOnACalendar();

      fireEvent.change(lanes(), { target: { value: 'step' } });
      click('Download as Markdown');

      const file = downloads.blobs.at(0);
      if (file === undefined) throw new Error('nothing was handed to createObjectURL');
      const text = new TextDecoder().decode(await readBlobBytes(file));
      // One picker for both exports: a fence that leaves as a file and a fence
      // that leaves on the clipboard are the same document.
      //
      // Proof: `downloadMermaidDocument`'s call site reverted to
      // `planToMermaidDocument(plan)` — `1 failed | 7 passed`, on
      // `AssertionError: expected '**Project:** Rewire the shed\n**Final…' to
      // contain 'section Dev'`, and it is the only one of the eight that moves:
      // the clipboard readers go through the other call site. Watched,
      // 2026-08-30.
      expect(text).toContain('section Dev');
      expect(text).not.toContain('section 010 Strip, sand & paint');
    });

    itDom('writes the lane that was picked, and nothing before it is', async () => {
      await plannedRowOnACalendar();
      // Opening a plan must not write to it, the rule every remembered answer
      // in this file keeps.
      expect(localStorage.getItem(KEY)).toBeNull();

      fireEvent.change(lanes(), { target: { value: 'assignee' } });

      expect(localStorage.getItem(KEY)).toBe(JSON.stringify('assignee'));
    });

    itDom('opens on the remembered lane, and exports in it', async () => {
      const copied: string[] = [];
      stubClipboard((text) => {
        copied.push(text);
        return Promise.resolve();
      });
      localStorage.setItem(KEY, JSON.stringify('step'));
      await plannedRowOnACalendar();

      expect(lanes().value).toBe('step');
      click('Copy as Mermaid');

      await waitFor(() => {
        expect(toastTexts()).toEqual(['Copied as Mermaid.']);
      });
      // The stored answer reaches the document and not merely the control: a
      // picker reading `step` over a fence still grouped by outline is the
      // whole feature failing quietly, the same claim the day-scale rung makes.
      expect(copied[0]).toContain('section Dev');
      expect(localStorage.getItem(KEY)).toBe(JSON.stringify('step'));
    });

    itDom('refuses a remembered lane this app does not offer, and drops the key', async () => {
      // A string, and JSON, and not one of the three: `sectionOf` has no branch
      // for it and the picker has no option for it, so a fence exported under
      // it would be a document no control could get back to.
      localStorage.setItem(KEY, JSON.stringify('assignees'));
      await plannedRowOnACalendar();

      // The dropped key is the assertion that discriminates. The picker's own
      // value does not: a `<select>` whose `value` matches no `<option>` falls
      // back to its first, so it reads `outline` with the refusal in place and
      // with it deleted alike — watched doing exactly that.
      expect(lanes().value).toBe('outline');
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    itDom('refuses remembered lanes that are not JSON at all, and drops the key', async () => {
      localStorage.setItem(KEY, '{not json');
      await plannedRowOnACalendar();

      expect(lanes().value).toBe('outline');
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });
});

describe('the project’s settings behind one control', () => {
  /**
   * `project-config-modal` slice 3.1: the three project-level dialogs — teams,
   * priorities, steps — are one modal behind one toolbar control, and the
   * three separate triggers are gone.
   *
   * Proof: a `<Button>Teams</Button>` left mounted in `toolbarControls` beside
   * the new control, and this failed on `expected null not to be … <button>`
   * — the "no separate control" half; watched 2026-08-30.
   */
  itDom('one control opens every project setting, and no separate control remains', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const toolbar = document.querySelector('[data-toolbar]');
    if (toolbar === null) throw new Error('the plan has no toolbar');
    const named = (name: string): HTMLElement[] =>
      [...toolbar.querySelectorAll('button')].filter(
        (button) => (button.getAttribute('aria-label') ?? button.textContent.trim()) === name,
      );
    expect(named('Project settings')).toHaveLength(1);
    expect(named('Teams')).toHaveLength(0);
    expect(named('Priorities')).toHaveLength(0);
    expect(named('Steps')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(
      [...dialog.querySelectorAll('[role="tab"]')].map((each) => each.textContent.trim()),
    ).toEqual(['Teams', 'Priorities', 'Steps', 'Estimating', 'Optimization']);
  });
});
