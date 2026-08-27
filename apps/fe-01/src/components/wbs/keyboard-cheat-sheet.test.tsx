import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import {
  altStyleOf,
  bindingsFor,
  commandChord,
  KEY_BINDINGS,
  showKeys,
  undoChord,
  WHERE_ORDER,
} from './keyboard-bindings';
import { KeyboardCheatSheet, opensCheatSheet } from './keyboard-cheat-sheet';
import type { PlanRenderer } from './plan-renderer';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** The mapping's key for one binding: unique, and short enough to read in a diff. */
const bindingKey = (where: string, keys: string): string => `${where}: ${keys}`;

/**
 * Which behaviour test proves each binding.
 *
 * This is the derivation, and it is worth being exact about what it derives.
 * The cheat sheet's prose comes from the registry, so the sheet cannot drift
 * from the registry. This table is what keeps the **registry** from drifting
 * from the code: every entry names tests in `wbs-table.test.tsx`, and the
 * check below reads the table and shared-picker suites and fails when a named
 * test is not in either one.
 *
 * Its honesty limit, stated rather than glossed: it proves the named test
 * **exists**, not that the test exercises that binding. A test renamed or
 * deleted breaks the sheet's claim, which is the drift that actually happens;
 * a test rewritten to assert something else does not, and the pairing stays a
 * human review judgement. See `verify.md` for the fault that was watched.
 */
const PROVEN_BY = new Map<string, readonly string[]>(
  // A Map, not an object literal: a lookup that misses has to come back
  // `undefined`, and an index signature would hand back a `string[]` for a
  // binding nothing was written for — the vacuous version of this check.
  Object.entries({
    'Editing: Enter': ['Enter in a name is a newline, and makes nothing'],
    'Editing: Enter in Prio': [
      'sends what was typed on Enter, without waiting for the cell to be left',
      'sends one request for a priority entered with Enter and then left',
    ],
    'Editing: Ctrl/⌘ + Enter': [
      'Cmd+Enter moves to the next row’s name',
      'Cmd+Enter on the last row makes one and lands in it',
      'waits for the save to land before it creates anything',
      'a refused save leaves the caret where it was and makes no row',
      'two Cmd+Enters on the last row make exactly one row',
    ],
    'Editing: Ctrl + N / Alt + N': [
      'Ctrl+N makes a sibling below this row, mid-table, and lands in its name',
      'Alt+N is the same chord for the keyboards Ctrl+N never reaches',
      'Ctrl+N works from an estimate cell, and sends what was in it first',
      'types a three-level breakdown without touching the mouse',
      'focuses a newly created row so the next keystroke lands in it',
    ],
    'Editing: Ctrl + H / J / K / L': [
      'Ctrl+H, J, K and L move between cells from a caret no arrow could leave',
      'a chord at the grid’s edge is consumed rather than leaking to the browser',
      'Ctrl+H and Ctrl+L leave the Depends on cell with its list open',
      'Ctrl+J and Ctrl+K walk the Depends on column with its list open',
      'Ctrl+H and Ctrl+L leave the Service/team cell with its list open',
      'Ctrl+J and Ctrl+K walk the Service/team column with its list open',
      'Ctrl+H and Ctrl+L move out of the Not before cell',
      'Ctrl+J and Ctrl+K walk the Not before column',
    ],
    'Editing: Ctrl + D, twice': [
      'Ctrl+D twice deletes the row, and says Cmd+Z puts it back',
      'a held Ctrl+D never deletes, however long it is held',
      'two presses with no release between them only re-arm',
      'arming 020 and pressing Ctrl+D on 030 arms 030 and deletes neither',
      'any other keystroke disarms it, and a modifier on its own does not',
      'a peer renumbering the armed row disarms it',
      'a frozen row refuses to arm and says how to unfreeze it',
    ],
    'Editing: Tab': [
      'types a three-level breakdown without touching the mouse',
      'tab inside the text walks to the next cell instead of indenting',
      'Tab moves from an estimate cell to the next editable cell',
      'Tab in the middle of a name navigates; at caret 0 it still indents',
      'walks every field of a row in turn, and on into the next row',
    ],
    'Editing: Shift + Tab': [
      'outdents with shift-tab',
      'shift-tab inside the text walks backwards instead of outdenting',
      'Shift+Tab from the depends input lands in the name, not on a chip button',
    ],
    'Editing: Backspace': [
      'backspace at the start of the name outdents the row',
      'backspace in an empty root row removes it and puts the focus above',
    ],
    'Editing: ↑ ↓ ← →': [
      'moves down a column of estimates',
      'moves along a row once the caret has run out',
      'leaves the caret alone in the middle of a word',
      'keeps ↑ and ↓ in the name until the caret has run out of text',
      'still walks a column of one-line boxes from any caret position',
    ],
    'Moving rows: Alt + ↑ / Alt + ↓': [
      'swaps the row with the sibling below it',
      'swaps the row with the sibling above it',
      'Alt+↑ and Alt+↓ move the row from the Depends on cell',
      'Alt+↑ and Alt+↓ move the row from the Service/team cell',
      'Alt+↑ and Alt+↓ move the row from the Not before cell',
    ],
    'Moving rows: Alt + →': [
      'indents from the middle of the text, where tab would not',
      'Alt+→ and Alt+← restructure the row from the Depends on cell',
      'Alt+→ and Alt+← restructure the row from the Service/team cell',
      'Alt+→ and Alt+← restructure the row from an assignee cell',
      'Alt+→ and Alt+← restructure the row from the Not before cell',
      'Alt+→ restructures the row from an open Not before editor',
    ],
    'Moving rows: Alt + ←': [
      'outdents from an estimate box',
      'Alt+→ and Alt+← restructure the row from the Depends on cell',
      'Alt+→ and Alt+← restructure the row from the Service/team cell',
      'Alt+→ and Alt+← restructure the row from the Not before cell',
    ],
    'Estimates: 2/3/8': ['sends one estimate for the trio typed into the folded cell'],
    'Estimates: 5': ['takes one number as the estimator saying all three are the same'],
    'Estimates: Empty it': ['clears the stored trio when the cell is emptied'],
    'Pickers: Type': ['narrows the list by name as letters are typed'],
    'Pickers: @': [
      'opens the people picker on an @ and filters it by what follows',
      'assigns on Enter and takes the @ back out, leaving the trio alone',
      'adds a contributor nobody had, and offers to remove the one assigned',
      'never lets the @ half read as an estimate, half-typed or abandoned',
    ],
    'Pickers: ↑ ↓': [
      'arrows move the highlight and Enter takes it',
      'the arrows step over a greyed row',
      'walks the lines with the arrows, and the box says where it is',
    ],
    'Pickers: Enter': [
      'Enter adds the entry the typing narrowed to',
      'adds a team by typing a name the list does not have',
      'offers an existing team rather than adding a second one',
    ],
    'Pickers: Escape': ['Escape closes the list'],
    'Pickers: 010, 020': ['adds every number in one comma-separated list'],
    'Anywhere: ?': [
      'opens the sheet when ? is pressed outside a cell',
      'a question mark typed into a name stays a question mark',
    ],
    'Anywhere: Escape': [
      'closes on Escape and gives the focus back to what had it',
      'clearing the search puts the reader’s own collapse back',
    ],
    'Anywhere: Ctrl/⌘ + Z': [
      'undoes the last change and says what it undid',
      'leaves ctrl-z alone inside a name cell, where the browser owns it',
      'names the change that stood in the way when an undo is refused',
    ],
    'Anywhere: Ctrl/⌘ + Shift + Z': ['redoes what was undone'],
  }),
);

/**
 * The behaviour tests' source, read rather than imported.
 *
 * Importing it would run 200 tests inside this one. The file is next to this
 * one and is required to be there: an unreadable file throws out of
 * `readFileSync` rather than being read as "no tests named", which would be
 * the vacuous version of this whole check.
 */
const behaviourTestSources = ['wbs-table.test.tsx', 'creatable-picker.test.tsx'].map((file) =>
  readFileSync(
    // Joined, not `new URL('./…', import.meta.url)`: Vite rewrites that exact
    // pattern into an asset URL served over http, and the read would be of
    // something that is not this directory.
    join(dirname(fileURLToPath(import.meta.url)), file),
    'utf8',
  ),
);

describe('the key binding registry', () => {
  it('holds bindings, each one filled in', () => {
    expect(KEY_BINDINGS.length).toBeGreaterThan(0);
    for (const binding of KEY_BINDINGS) {
      expect(binding.keys.trim()).not.toBe('');
      expect(binding.does.trim()).not.toBe('');
      expect(WHERE_ORDER).toContain(binding.where);
    }
  });

  it('names every group in WHERE_ORDER, and no empty ones', () => {
    for (const where of WHERE_ORDER) {
      expect(KEY_BINDINGS.filter((binding) => binding.where === where).length).toBeGreaterThan(0);
    }
  });

  it('says, for every binding, which renderers answer it', () => {
    // The field is what makes the sheet renderer-aware without a second list of
    // chords living beside the sheet. An entry with an empty one would be a
    // binding no renderer answers and nothing would ever show it.
    for (const binding of KEY_BINDINGS) {
      expect(binding.renderers.length).toBeGreaterThan(0);
      for (const renderer of binding.renderers) {
        expect(['cards', 'table']).toContain(renderer);
      }
    }
  });

  it('leaves the cards the keys they really answer, and takes away the ones they do not', () => {
    // `PlanCards` wires none of `onTabKey`, `onArrowKey`, `onCommandKey` or
    // `onAltMove`, so every chord and every grid motion is the table's. What a
    // card does answer is the estimate shorthand and the `@` list inside a
    // phase's box, and the window shortcuts — `?` and undo — which are on the
    // window and know nothing about a renderer.
    const cards = bindingsFor('cards').map((binding) => `${binding.where}: ${binding.keys}`);

    expect(cards).not.toContain('Editing: Ctrl/⌘ + Enter');
    expect(cards).not.toContain('Editing: Ctrl + N / Alt + N');
    expect(cards).not.toContain('Moving rows: Alt + →');
    expect(cards).toContain('Estimates: 2/3/8');
    expect(cards).toContain('Pickers: @');
    expect(cards).toContain('Anywhere: Ctrl/⌘ + Z');
    // And the table keeps all of them, which is what says the narrowing is the
    // cards' and not a binding quietly lost for everybody.
    expect(bindingsFor('table')).toHaveLength(KEY_BINDINGS.length);
  });

  it('has one entry per keys-and-where, which is what the mapping is by', () => {
    const keys = KEY_BINDINGS.map((binding) => bindingKey(binding.where, binding.keys));
    expect(keys).toEqual([...new Set(keys)]);
  });
});

describe('the cheat sheet is cross-checked against the behaviour tests', () => {
  // Proof: `Escape closes the list` renamed to `Escape shuts the list` in the
  // mapping, this failed naming the entry and the missing test; and a
  // `Ctrl + K` binding added to the registry with nothing mapped to it failed
  // with `Anywhere: Ctrl + K names no behaviour test`. Both watched,
  // 2026-08-07.
  it('names, for every binding, a test in the table or shared-picker suite', () => {
    const missing: string[] = [];
    for (const binding of KEY_BINDINGS) {
      const key = bindingKey(binding.where, binding.keys);
      const named = PROVEN_BY.get(key);
      if (named === undefined || named.length === 0) {
        missing.push(`${key} names no behaviour test`);
        continue;
      }
      for (const name of named) {
        // The declaration, not the words: a test name that only appears in a
        // comment or an assertion would pass a bare substring search.
        if (!behaviourTestSources.some((source) => source.includes(`itDom('${name}'`))) {
          missing.push(`${key} names a behaviour test neither suite has: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('maps nothing that is not a binding', () => {
    const registryKeys = new Set(
      KEY_BINDINGS.map((binding) => bindingKey(binding.where, binding.keys)),
    );
    expect([...PROVEN_BY.keys()].filter((key) => !registryKeys.has(key))).toEqual([]);
  });
});

describe('Alt on a Mac and on a PC', () => {
  it('reads a Mac from either the platform or the user agent', () => {
    expect(altStyleOf('MacIntel', '')).toBe('mac');
    expect(altStyleOf(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
  });

  it('reads anything it recognises as not a Mac as a PC', () => {
    expect(altStyleOf('Win32', '')).toBe('pc');
    expect(altStyleOf(undefined, 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('pc');
  });

  it('says so when the browser will not say', () => {
    expect(altStyleOf(undefined, undefined)).toBe('unsure');
    expect(altStyleOf('', 'Mozilla/5.0 (something new)')).toBe('unsure');
  });

  it('labels Alt by that answer, and leaves the rest of the chord alone', () => {
    expect(showKeys('Alt + ↑ / Alt + ↓', 'mac')).toBe('⌥ + ↑ / ⌥ + ↓');
    expect(showKeys('Alt + ↑ / Alt + ↓', 'pc')).toBe('Alt + ↑ / Alt + ↓');
    // Both, rather than a guess: a sheet that says ⌥ to a Windows reader is
    // worse than one that says both and lets them pick their own keyboard.
    expect(showKeys('Alt + →', 'unsure')).toBe('⌥/Alt + →');
    expect(showKeys('Shift + Tab', 'mac')).toBe('Shift + Tab');
  });
});

describe('the cheat sheet overlay', () => {
  /** The sheet behind a control, so opening and closing is a real focus move. */
  function Host({ renderer }: { renderer: PlanRenderer }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </button>
        {open && (
          <KeyboardCheatSheet
            altStyle="pc"
            renderer={renderer}
            onClose={() => {
              setOpen(false);
            }}
          />
        )}
      </>
    );
  }

  /** Opens the sheet from a control that really has the focus first. */
  const openFromControl = (renderer: PlanRenderer = 'table'): HTMLElement => {
    render(<Host renderer={renderer} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    // jsdom does not focus a clicked button; a real browser does, and the
    // element the focus goes back to is the whole point of these tests.
    opener.focus();
    fireEvent.click(opener);
    return opener;
  };

  itDom('is a labelled modal dialog', () => {
    openFromControl();

    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  itDom('renders every binding, under its own group', () => {
    openFromControl();

    for (const where of WHERE_ORDER) {
      expect(screen.getByRole('heading', { name: where })).toBeDefined();
    }
    for (const binding of KEY_BINDINGS) {
      expect(screen.getByText(binding.does)).toBeDefined();
      expect(screen.getAllByText(showKeys(binding.keys, 'pc')).length).toBeGreaterThan(0);
    }
  });

  itDom('promises the cards renderer nothing the cards do not answer', () => {
    // The sheet is reachable from the phone's toolbar sheet, and it promised
    // ⌘+Enter *"saves what is in this cell and moves to the next row's name"*
    // on a renderer where the chord does nothing at all — observed on the card
    // renderer on 2026-08-09, twice, with no request made.
    //
    // Proof: `bindingsFor` changed to return `KEY_BINDINGS` unfiltered, this
    // failed on `expected [ <kbd …(1)></kbd> ] to have a length of +0 but got
    // 1`. Watched, 2026-08-09.
    openFromControl('cards');

    expect(screen.queryAllByText(showKeys('Ctrl/⌘ + Enter', 'pc'))).toHaveLength(0);
    expect(screen.queryAllByText(showKeys('Ctrl + N / Alt + N', 'pc'))).toHaveLength(0);
    // A group with nothing left in it is not a heading with nothing under it.
    expect(screen.queryByRole('heading', { name: 'Moving rows' })).toBeNull();
    // What a card does answer is still there, or this would be a sheet that
    // said nothing rather than one that says the truth.
    expect(screen.getAllByText(showKeys('2/3/8', 'pc')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(showKeys('Ctrl/⌘ + Z', 'pc')).length).toBeGreaterThan(0);
  });

  itDom('keeps every one of them on the table renderer', () => {
    openFromControl('table');

    expect(screen.getAllByText(showKeys('Ctrl/⌘ + Enter', 'pc')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Moving rows' })).toBeDefined();
  });

  itDom('takes the focus on open and gives it back on close', () => {
    const opener = openFromControl();

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  itDom('closes on its ✕', () => {
    const opener = openFromControl();

    fireEvent.click(screen.getByRole('button', { name: 'Close the keyboard shortcuts' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  itDom('closes on a click away from it', () => {
    openFromControl();

    const backdrop = document.querySelector('[data-cheat-sheet-backdrop]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  itDom('stays open when the click lands inside it', () => {
    openFromControl();

    fireEvent.click(screen.getByRole('heading', { name: 'Keyboard shortcuts' }));

    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  itDom('closes on Escape from anywhere on the page, not only from inside it', () => {
    // The audit's fault, 2026-08-12: Escape was a React handler on the
    // backdrop, so it only ever saw a keystroke aimed inside the sheet. Tab
    // put the focus in the table behind — the sheet had no trap — and Escape
    // stopped closing a dialog nothing else on the keyboard could dismiss.
    const opener = openFromControl();
    // The focus somewhere the sheet does not contain, which is exactly where a
    // Tab used to leave it.
    opener.focus();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  itDom('keeps Tab inside the sheet, at both ends of it', () => {
    openFromControl();

    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close the keyboard shortcuts' });

    // Forwards off the last stop: back to the first, rather than on into the
    // table. jsdom performs no default Tab of its own, so what is asserted is
    // that the key was taken *and* the focus placed — the two halves a real
    // browser needs, and `e2e/keyboard.spec.ts` is where the browser says so.
    close.focus();
    const forwards = createEvent.keyDown(close, { key: 'Tab' });
    fireEvent(close, forwards);

    expect(forwards.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Backwards off the panel, which is where the focus lands on open.
    dialog.focus();
    const backwards = createEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    fireEvent(dialog, backwards);

    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  itDom('brings a Tab pressed outside the sheet back into it', () => {
    // The recovery half: a click on the page behind can still move the focus
    // out, and the next Tab is what returns it — without which the trap is a
    // rule that only holds while it has never been broken.
    const opener = openFromControl();
    opener.focus();

    const escaped = createEvent.keyDown(opener, { key: 'Tab' });
    fireEvent(opener, escaped);

    expect(escaped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close the keyboard shortcuts' }),
    );
  });
});

describe('what walks the undo stack', () => {
  /** Ctrl and the letter, as the listener sees it. */
  const chord = { key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };

  itDom('takes Ctrl or Meta, and Shift is which way', () => {
    expect(undoChord(chord, null)).toBe('undo');
    // A browser uppercases the letter when Shift is held.
    expect(undoChord({ ...chord, key: 'Z', shiftKey: true }, null)).toBe('redo');
    expect(undoChord({ ...chord, ctrlKey: false, metaKey: true }, null)).toBe('undo');
  });

  itDom('never inside a box somebody is typing in, where the browser owns it', () => {
    render(
      <>
        <input aria-label="a box" />
        <textarea aria-label="a bigger box" />
      </>,
    );
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);

    expect(undoChord(chord, screen.getByLabelText('a box'))).toBeNull();
    expect(undoChord(chord, screen.getByLabelText('a bigger box'))).toBeNull();
    expect(undoChord(chord, editable)).toBeNull();
    editable.remove();
  });

  itDom('leaves anything that is not the chord alone', () => {
    expect(undoChord({ ...chord, ctrlKey: false }, null)).toBeNull();
    expect(undoChord({ ...chord, altKey: true }, null)).toBeNull();
    expect(undoChord({ ...chord, key: 'y' }, null)).toBeNull();
  });
});

describe('what a command chord is', () => {
  /** No modifier at all, which every case below adds exactly what it needs to. */
  const bare = {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  /** Ctrl and a letter, which is the family Dany chose. */
  const ctrl = (key: string, code: string) => ({ ...bare, key, code, ctrlKey: true });

  itDom('reads Ctrl and h, j, k or l as the four directions', () => {
    expect(commandChord(ctrl('h', 'KeyH'))).toBe('left');
    expect(commandChord(ctrl('j', 'KeyJ'))).toBe('down');
    expect(commandChord(ctrl('k', 'KeyK'))).toBe('up');
    expect(commandChord(ctrl('l', 'KeyL'))).toBe('right');
  });

  itDom('reads Ctrl and n as a new work item, and Ctrl and d as a delete', () => {
    expect(commandChord(ctrl('n', 'KeyN'))).toBe('new-item');
    expect(commandChord(ctrl('d', 'KeyD'))).toBe('delete');
  });

  itDom('reads Alt and n as the same new work item, by the key’s place on the board', () => {
    // macOS turns Alt+N into a dead key — `e.key` is `Dead` and no letter
    // arrives at all — so the physical key is what this chord is matched on.
    // It is the cross-platform half of the pair: Ctrl+N is Chrome's own New
    // Window everywhere except macOS, so on Windows and Linux this is the one
    // that reaches the page.
    expect(commandChord({ ...bare, key: 'Dead', code: 'KeyN', altKey: true })).toBe('new-item');
    expect(commandChord({ ...bare, key: 'n', code: 'KeyN', altKey: true })).toBe('new-item');
    // Alt with anything else is somebody else's chord — the row moves are
    // Alt+arrow, and they must not read as a create.
    expect(commandChord({ ...bare, key: 'ArrowDown', code: 'ArrowDown', altKey: true })).toBeNull();
    // No `code` at all is not a claim to have been Alt+N.
    expect(commandChord({ ...bare, key: 'Dead', altKey: true })).toBeNull();
  });

  itDom('reads Enter with Ctrl or with Cmd as next-or-create, and bare Enter as neither', () => {
    expect(commandChord({ ...bare, key: 'Enter', code: 'Enter', ctrlKey: true })).toBe(
      'next-or-create',
    );
    expect(commandChord({ ...bare, key: 'Enter', code: 'Enter', metaKey: true })).toBe(
      'next-or-create',
    );
    // The whole of change 4's point: a bare Enter in a name is a newline the
    // browser writes, and this predicate must not claim it.
    expect(commandChord({ ...bare, key: 'Enter', code: 'Enter' })).toBeNull();
  });

  itDom('never claims the Cmd variants of the letters', () => {
    // Cmd+H is Hide on macOS and Cmd+N is New Window: neither reaches page JS,
    // which is exactly why the Ctrl family was chosen. Claiming them here
    // would put this predicate's answer at odds with what a browser delivers,
    // and on Linux — where Cmd is the Windows key — would fire the chord off a
    // keystroke nobody meant as one.
    for (const key of ['h', 'j', 'k', 'l', 'n', 'd']) {
      const code = `Key${key.toUpperCase()}`;
      expect(commandChord({ ...bare, key, code, metaKey: true })).toBeNull();
      // Both together is not a licence either.
      expect(commandChord({ ...bare, key, code, ctrlKey: true, metaKey: true })).toBeNull();
    }
  });

  itDom('leaves a chord somebody else has polluted with Shift or Alt alone', () => {
    expect(commandChord({ ...ctrl('h', 'KeyH'), shiftKey: true })).toBeNull();
    expect(commandChord({ ...ctrl('d', 'KeyD'), altKey: true })).toBeNull();
    expect(commandChord({ ...ctrl('n', 'KeyN'), altKey: true })).toBeNull();
    expect(commandChord({ ...bare, key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }))
      // Ctrl+Shift+Enter is nobody's chord here, and Ctrl/⌘+Shift+Z is redo —
      // a predicate loose about Shift is one that answers for both.
      .toBeNull();
    expect(
      commandChord({ ...bare, key: 'Enter', code: 'Enter', ctrlKey: true, altKey: true }),
    ).toBeNull();
  });

  itDom('leaves the letters alone with no modifier at all', () => {
    // Typing `hjkl` into a name is four letters, not four moves.
    for (const key of ['h', 'j', 'k', 'l', 'n', 'd']) {
      expect(commandChord({ ...bare, key, code: `Key${key.toUpperCase()}` })).toBeNull();
    }
    expect(commandChord(ctrl('z', 'KeyZ'))).toBeNull();
  });
});

describe('what opens the sheet', () => {
  /** A question mark with no modifier, as the listener sees it. */
  const question = { key: '?', ctrlKey: false, metaKey: false, altKey: false };

  itDom('a question mark that is not going into a text box', () => {
    render(<p>nothing to type into</p>);

    expect(opensCheatSheet(question, screen.getByText('nothing to type into'))).toBe(true);
    // No target at all — the document itself has the keystroke.
    expect(opensCheatSheet(question, null)).toBe(true);
  });

  itDom('not one going into an input, a textarea or an editable element', () => {
    render(
      <>
        <input aria-label="a box" />
        <textarea aria-label="a bigger box" />
      </>,
    );
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);

    expect(opensCheatSheet(question, screen.getByLabelText('a box'))).toBe(false);
    expect(opensCheatSheet(question, screen.getByLabelText('a bigger box'))).toBe(false);
    // jsdom leaves `isContentEditable` undefined, so the attribute is read as
    // well — in a browser the two say the same thing.
    expect(opensCheatSheet(question, editable)).toBe(false);
    editable.remove();
  });

  itDom('not a question mark somebody else has claimed with a modifier', () => {
    expect(opensCheatSheet({ ...question, ctrlKey: true }, null)).toBe(false);
    expect(opensCheatSheet({ ...question, metaKey: true }, null)).toBe(false);
    expect(opensCheatSheet({ ...question, altKey: true }, null)).toBe(false);
    expect(opensCheatSheet({ ...question, key: 'a' }, null)).toBe(false);
  });
});
