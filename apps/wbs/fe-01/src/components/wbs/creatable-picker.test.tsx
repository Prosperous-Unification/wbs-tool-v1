import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CreatablePicker, type CreatablePickerProps } from './creatable-picker';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const ENTRIES = [
  { id: 't1', name: 'Platform' },
  { id: 't2', name: 'claire qa billing' },
  { id: 't3', name: 'QA infra' },
];

/**
 * The grid's three handlers, recorded rather than reimplemented: the table's
 * real ones each check their own keys inside, so a stub that only notes the
 * call is enough to say who a keystroke reached.
 */
function gridStub() {
  const calls: string[] = [];
  return {
    calls,
    gridCell: {
      dataCell: 'service-team-w1',
      onTabKey: (e: { key: string }) => {
        calls.push(`tab:${e.key}`);
      },
      onCommandKey: (e: { key: string }) => {
        calls.push(`command:${e.key}`);
      },
      onAltMove: (e: { key: string }) => {
        calls.push(`alt:${e.key}`);
      },
    },
  };
}

/** The picker with a directory, a spy for each way out, and its box. */
function picker(overrides?: Partial<CreatablePickerProps>) {
  const onChoose = vi.fn();
  const onCreate = vi.fn();
  render(
    <CreatablePicker
      label="Service or team"
      entries={ENTRIES}
      value={null}
      onChoose={onChoose}
      onCreate={onCreate}
      {...overrides}
    />,
  );
  const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Service or team' });
  return { box, onChoose, onCreate };
}

/** Focus opens the list; typing narrows it. */
function openAs(box: HTMLInputElement, typed: string): void {
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: typed } });
}

function options(): HTMLElement[] {
  return screen.getAllByRole('option');
}

/**
 * The one line Enter takes, as the DOM can say it: `data-picker-take` rides
 * the same JSX expression that paints the accent inline, and jsdom's cssstyle
 * drops `var()` values it does not know, so the attribute is the marker a
 * test can read back for "wears the active treatment".
 */
function takeLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-picker-take]');
}

describe('the creatable picker’s active option', () => {
  /**
   * Typing `qa` over that directory ranks three lines — the prefix match, the
   * create, and the name that merely contains it: one of each tier, which is
   * what makes it a walk through all of them.
   */
  const QA_OFFERED = ['QA infra', 'Add “qa”', 'claire qa billing'];

  itDom('opens with exactly one line wearing the active treatment', () => {
    const { box } = picker();
    openAs(box, 'qa');
    expect(options().map((option) => option.textContent)).toEqual(QA_OFFERED);

    // One active line, and it is the top: the ink and the ARIA name the same
    // option before any arrow has moved.
    expect(document.querySelectorAll('[data-picker-take]')).toHaveLength(1);
    expect(takeLine()).toBe(options()[0]);
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  itDom('walks the lines with the arrows, and the box says where it is', () => {
    const { box } = picker();
    openAs(box, 'qa');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    expect(takeLine()).toBe(options()[1]);
    // The marker moved rather than duplicated: the defect this task exists
    // for was a second line looking active while Enter still took the first.
    expect(document.querySelectorAll('[data-picker-take]')).toHaveLength(1);

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(takeLine()).toBe(options()[2]);

    // The floor is a wall, not a trapdoor.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(takeLine()).toBe(options()[2]);
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[2].id);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(takeLine()).toBe(options()[1]);
    // And so is the ceiling.
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(takeLine()).toBe(options()[0]);
  });

  itDom('keeps the bare arrows from the grid and from the caret', () => {
    const stub = gridStub();
    const { box } = picker({ gridCell: stub.gridCell });
    openAs(box, 'qa');

    // `false` is dispatchEvent's word for preventDefault: the caret must not
    // move while the list owns the key.
    expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(takeLine()).toBe(options()[1]);

    expect(fireEvent.keyDown(box, { key: 'ArrowUp' })).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(takeLine()).toBe(options()[0]);
  });

  itDom('still lets Alt+arrow move the row and Ctrl+H/J/K/L out of the cell', () => {
    const stub = gridStub();
    const { box } = picker({ gridCell: stub.gridCell });
    openAs(box, 'qa');

    // Routed before the arrow branch on purpose, exactly as in the component:
    // the row move escapes the open list rather than walking it.
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true });
    expect(stub.calls).toContain('alt:ArrowDown');
    expect(takeLine()).toBe(options()[0]);

    // The table's motion chords are Ctrl+H/J/K/L — vim keys, not arrows — and
    // the list must let them through too.
    fireEvent.keyDown(box, { key: 'l', ctrlKey: true });
    expect(stub.calls).toContain('command:l');
    expect(takeLine()).toBe(options()[0]);

    // A Ctrl+arrow, by contrast, is no chord of this table's: the list owns
    // it exactly as it owns the bare arrow, the same as the depends picker.
    fireEvent.keyDown(box, { key: 'ArrowDown', ctrlKey: true });
    expect(takeLine()).toBe(options()[1]);
  });

  itDom('Enter takes the line the arrows walked to', () => {
    const { box, onChoose } = picker();
    openAs(box, 'qa');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onChoose).toHaveBeenCalledWith('t2');
    // And the list is gone with the pick.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  itDom('Enter makes the new team when the create line is the active one', () => {
    const { box, onCreate, onChoose } = picker();
    openAs(box, 'qa');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onCreate).toHaveBeenCalledWith('qa');
    expect(onChoose).not.toHaveBeenCalled();
  });

  itDom('typing again puts the walk back on top', () => {
    const { box } = picker();
    openAs(box, 'qa');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(takeLine()).toBe(options()[1]);

    fireEvent.change(box, { target: { value: 'qai' } });
    // New search, new ranking: the active line is the top of the new list.
    expect(takeLine()).toBe(options()[0]);
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  itDom('a click still takes the clicked line, wherever the arrows are', () => {
    const { box, onChoose } = picker();
    openAs(box, 'qa');
    fireEvent.keyDown(box, { key: 'ArrowDown' });

    fireEvent.click(options()[2]);
    expect(onChoose).toHaveBeenCalledWith('t2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  itDom('a chord aimed at an open list stays inert', () => {
    const stub = gridStub();
    const { box, onChoose, onCreate } = picker({ gridCell: stub.gridCell });
    openAs(box, 'qa');

    expect(fireEvent.keyDown(box, { key: 'Enter', metaKey: true })).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    // Nothing about the list moved either.
    expect(takeLine()).toBe(options()[0]);
  });

  itDom('Escape closes and the next open starts from the top', () => {
    const { box } = picker();
    openAs(box, 'qa');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.getAttribute('aria-activedescendant')).toBeNull();

    // Still focused; typing reopens.
    fireEvent.change(box, { target: { value: 'qa' } });
    expect(takeLine()).toBe(options()[0]);
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  itDom('shows the chosen entry without competing with the active one', () => {
    // `Platform` already in force: its line carries `aria-selected`, and the
    // active treatment must still be worn by exactly one line — the one Enter
    // takes.
    const { box } = picker({ value: 't1' });
    fireEvent.focus(box);
    const selected = options().find((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toBe('Platform');
    expect(document.querySelectorAll('[data-picker-take]')).toHaveLength(1);
    expect(takeLine()).toBe(options()[0]);
  });
});

describe('reopening a picker that never lost the focus', () => {
  /**
   * The mechanism behind `picker-reopens-on-click`, in the component all four
   * reference cells and both card faces share.
   *
   * The **gesture** is a browser's — a click on a node that already holds the
   * focus fires no focus event, and jsdom will happily dispatch a click and a
   * focus in either order — so it is measured in
   * `e2e/reference-cells.spec.ts`. What is measured here is the rule that fixes
   * it, and the one thing that rule must not do: overwrite a search somebody
   * is part-way through typing.
   */
  itDom('opens the list again when the closed box is clicked', () => {
    const { box } = picker();
    // Focus, then Escape, which is the shape a take leaves behind: the list
    // closed with the box still holding the keyboard. Escape rather than a real
    // take because `closeWhen` and the round trip are the caller's business and
    // the state they arrive at is this one.
    fireEvent.focus(box);
    expect(options()).toHaveLength(ENTRIES.length);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    // Proof: the box's `onClick` deleted, watched failing here on `Unable to
    // find an accessible element with the role "option"` — `options()` is
    // `getAllByRole`, which throws rather than answering an empty list, so the
    // red says "no list at all" and not "a shorter list". The browser case for
    // the same line fails on `clicking the focused add field offered nothing ·
    // Expected: 2 · Received: 0`.
    fireEvent.click(box);
    expect(options()).toHaveLength(ENTRIES.length);
  });

  itDom('leaves a half-typed search alone when the open box is clicked', () => {
    const { box } = picker();
    openAs(box, 'qa');
    const offered = options().map((option) => option.textContent);
    expect(offered).toHaveLength(3);

    // A click to put the caret somewhere in what has been typed. The reopen
    // rule must not read this as "open the list": it would reset `typed` to
    // `''`, widen the list back to the whole directory, and throw away the
    // search — with the box still showing `qa`, because the value it displays
    // is `typed ?? …`.
    //
    // Proof: the `if (typed !== null) return;` guard deleted, watched failing
    // here on `expected [ 'Platform', …(2) ] to deeply equal [ 'QA infra', 'Add
    // “qa”', …(1) ]` — the whole directory back and the search gone.
    fireEvent.click(box);
    expect(options().map((option) => option.textContent)).toEqual(offered);
    expect(box.value).toBe('qa');
  });
});
