import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  REFERENCE_SET_LINE_HEIGHT,
  type ReferenceSetAdapter,
  referenceSetLines,
  ReferenceSetSheet,
  ReferenceSetStrip,
} from './reference-set-field';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const entries = [
  { id: 'team-1', name: 'Platform' },
  { id: 'team-2', name: 'QA' },
  { id: 'team-3', name: 'Release' },
];

function adapter(overrides: Partial<ReferenceSetAdapter> = {}): ReferenceSetAdapter {
  return {
    kind: 'team',
    entries,
    ownIds: ['team-1'],
    inheritedLabel: 'Core',
    replace: vi.fn().mockResolvedValue('landed'),
    create: vi.fn().mockResolvedValue('landed'),
    ...overrides,
  };
}

describe('ReferenceSetStrip', () => {
  itDom('renders one leading add path and own chips, and no line of its own', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);

    expect(screen.getAllByRole('button', { name: 'Add a team' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add a team' }).tabIndex).toBe(-1);
    expect(document.querySelectorAll('[data-creatable-add]')).toHaveLength(0);
    expect(screen.getByText('Platform')).toBeInTheDocument();
    // Inherited context is the surface's to draw, and a table cell draws it in
    // its placeholder: the sheet's `Inherited:` line is `ReferenceSetSheet`'s.
    expect(document.querySelectorAll('[data-reference-inherited]')).toHaveLength(0);
  });

  itDom('omits selected entries and adds the chosen id to the whole own set', async () => {
    const model = adapter();
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    fireEvent.focus(box);
    expect(screen.queryByRole('option', { name: 'Platform' })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(model.replace).toHaveBeenCalledWith(['team-1', 'team-2']);
    });
  });

  itDom('retains a refused choice and blocks a pending double take', async () => {
    let answer!: (value: 'landed' | 'refused' | 'unsent') => void;
    const pending = new Promise<'landed' | 'refused' | 'unsent'>((resolve) => {
      answer = resolve;
    });
    const model = adapter({ replace: vi.fn().mockReturnValue(pending) });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Q' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(model.replace).toHaveBeenCalledTimes(1);
    // **Read-only and busy, not disabled**, since 2026-08-31. The claim is the
    // same one this line always made — the box refuses what is typed into it
    // while the write travels — and the reason the spelling changed is that a
    // `disabled` box drops the focus it holds and the panel around it never
    // hears about it (`creatable-picker.tsx`, and `e2e/reference-cell-panel
    // .spec.ts` in a browser, which is the only place that fault is visible).
    expect(box).toHaveAttribute('readonly');
    expect(box).toHaveAttribute('aria-busy', 'true');
    expect(box).not.toBeDisabled();
    expect(box).toHaveValue('Q');

    await act(async () => {
      answer('refused');
      await pending;
    });
    expect(box).not.toHaveAttribute('readonly');
    expect(box).not.toBeDisabled();
    expect(box).toHaveValue('Q');
  });

  itDom('creates against the current whole set and preserves refused members', async () => {
    const model = adapter({ create: vi.fn().mockResolvedValue('refused') });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'New team' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(model.create).toHaveBeenCalledWith('New team', ['team-1']);
    });
    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(box).toHaveValue('New team');
  });

  itDom('removes one member and disables only that chip while the write is pending', async () => {
    let answer!: (value: 'landed' | 'refused' | 'unsent') => void;
    const pending = new Promise<'landed' | 'refused' | 'unsent'>((resolve) => {
      answer = resolve;
    });
    const model = adapter({ replace: vi.fn().mockReturnValue(pending) });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const remove = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Remove Platform team',
    });
    fireEvent.click(remove);
    expect(remove).toBeDisabled();
    expect(model.replace).toHaveBeenCalledWith([]);

    await act(async () => {
      answer('refused');
      await pending;
    });
    expect(remove).not.toBeDisabled();
    expect(screen.getByText('Platform')).toBeInTheDocument();
  });

  itDom('blocks a second remove while the first whole-set write is pending', async () => {
    let answer!: (value: 'landed' | 'refused' | 'unsent') => void;
    const pending = new Promise<'landed' | 'refused' | 'unsent'>((resolve) => {
      answer = resolve;
    });
    const model = adapter({
      ownIds: ['team-1', 'team-2'],
      replace: vi.fn().mockReturnValue(pending),
    });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Platform team' }));
    const second = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove QA team' });
    expect(second).toBeDisabled();
    fireEvent.click(second);
    expect(model.replace).toHaveBeenCalledOnce();
    expect(model.replace).toHaveBeenCalledWith(['team-2']);

    await act(async () => {
      answer('landed');
      await pending;
    });
  });

  itDom('adds against the projected set after a removal lands before props refresh', async () => {
    let answer!: (value: 'landed' | 'refused' | 'unsent') => void;
    const pending = new Promise<'landed' | 'refused' | 'unsent'>((resolve) => {
      answer = resolve;
    });
    const replace = vi.fn().mockReturnValueOnce(pending).mockResolvedValue('landed');
    const model = adapter({ ownIds: ['team-1', 'team-2'], replace });
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Platform team' }));
    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    expect(box).toHaveAttribute('readonly');
    expect(box).not.toBeDisabled();

    await act(async () => {
      answer('landed');
      await pending;
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Release' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(replace).toHaveBeenLastCalledWith(['team-2', 'team-3']);
    });
  });

  itDom('the leading plus focuses the adjacent keyboard path', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a team' }));
    expect(screen.getByRole('combobox', { name: 'Teams' })).toHaveFocus();
  });

  itDom('forwards the table keyboard path through its combobox', () => {
    const calls: string[] = [];
    render(
      <ReferenceSetStrip
        label="Teams"
        adapter={adapter()}
        gridCell={{
          dataCell: 'row-1::team',
          onTabKey: (event) => calls.push(`tab:${event.key}`),
          onCommandKey: (event) => calls.push(`command:${event.key}`),
          onAltMove: (event) => calls.push(`alt:${event.key}`),
        }}
      />,
    );

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    expect(box.dataset['cell']).toBe('row-1::team');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(calls).toEqual(['tab:Tab']);
  });
});

/**
 * Every node a reader can see saying `needle`: an element's own drawn text, or
 * a box's placeholder or value.
 *
 * Accessible names and `title` tooltips are deliberately not counted. The
 * duplicate this exists to catch is a **second visible node** — an
 * `Inherited: Core` span beside a `↳ Core` placeholder reads as one name to
 * the accessibility tree and as two lines to the eye, and a count of names
 * cannot see it (4b.3).
 */
function drawnSayings(root: HTMLElement, needle: string): string[] {
  return [...root.querySelectorAll<HTMLElement>('*')].flatMap((node) => {
    if (node instanceof HTMLInputElement) {
      return [node.placeholder, node.value].filter((said) => said.includes(needle));
    }
    const drawn = [...node.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent ?? '')
      .join('');
    return drawn.includes(needle) ? [drawn] : [];
  });
}

/** The rendered strip, or a failure that says the render never made one. */
function strip(within: ParentNode = document): HTMLElement {
  const found = within.querySelector<HTMLElement>('[data-reference-strip]');
  if (found === null) throw new Error('no reference strip was rendered');
  return found;
}

function chipsOf(within: ParentNode = document): HTMLElement {
  const found = strip(within).querySelector<HTMLElement>('[data-reference-chips]');
  if (found === null) throw new Error('the strip rendered no chip group');
  return found;
}

/** The line the strip stands on, which keeps its height while the strip floats. */
function anchorOf(within: ParentNode = document): HTMLElement {
  const found = within.querySelector<HTMLElement>('[data-reference-anchor]');
  if (found === null) throw new Error('the strip rendered no anchor');
  return found;
}

function searchOf(within: ParentNode = document): HTMLElement {
  const found = strip(within).querySelector<HTMLElement>('[data-reference-search]');
  if (found === null) throw new Error('the strip rendered no search holder');
  return found;
}

describe('the add button closes what it opened', () => {
  /*
    Dany, 2026-09-01: "can you make it so that clicking second time on plus sign
    for tags/deps on/teams/services hides the add UI". The `+` opened the picker
    and had no other state, so a second press was a no-op the reader cannot tell
    from a dead control — and the way out was a click somewhere else or Escape,
    neither of which is where the hand already is.
  */

  itDom('closes the list on a second press', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    const add = screen.getByRole('button', { name: 'Add a team' });

    fireEvent.click(add);
    // Asserted rather than assumed: with nothing open the press below would be
    // measuring a list that was never there.
    expect(box.getAttribute('aria-expanded')).toBe('true');

    // Proof: the `aria-expanded` branch removed from the button's `onClick`,
    // watched failing on `expected 'true' to be 'false'`.
    fireEvent.click(add);
    expect(box.getAttribute('aria-expanded')).toBe('false');
  });

  /*
    **This one has no negative of its own, and says so.** Removing the toggle
    branch leaves it green — the `+` opens on every press, which is what it
    asserts. The fault it exists for is the opposite one: a toggle that latches
    closed, or a `blur()` the cell never recovers from. Injecting *that* means
    writing the broken toggle, which is not a line anybody would delete by
    accident, so what this case really buys is the round trip being closed at
    all. Written down rather than dressed up as a proof it does not have.
  */
  itDom('opens it again on the press after that', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter()} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    const add = screen.getByRole('button', { name: 'Add a team' });

    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);

    expect(box.getAttribute('aria-expanded')).toBe('true');
  });

  itDom('closes an add UI that never had a list to close', () => {
    /*
      **The Types column, and every cell whose directory is still empty.**

      Dany, 2026-09-03: _"clicking on + on types column i cannot click it again
      to remove the adding type UI; i want same UI as for services, teams"_.

      `aria-expanded` is `typed !== null && options.length > 0`, so a directory
      with nothing in it and nothing typed has **no list** — the box is open for
      searching, the panel is on screen, and the attribute says `false`. The
      toggle read that attribute, took it for "closed", and opened what was
      already open: on a plan where nobody has made a work item type yet, the
      `+` could not put the cell back. Teams and Services toggle because a
      deployment has teams and services in it.

      The predicate is the **search** — `typed !== null`, which the box carries
      as `data-searching` — and the two states that matter stay apart: this
      one, where the search is open with no lines under it, and the moment
      after a take, where the search is closed and the box still holds the
      focus (`picker-reopens-on-click`, the case below).

      Proof: with the predicate back to `aria-expanded === 'true'`, watched
      failing on `expected <input aria-label="Types" …(7)></input> not to be
      <input aria-label="Types" …(7)></input>` — the box still held the focus
      after the second press (2026-09-03).
    */
    render(
      <ReferenceSetStrip
        label="Types"
        adapter={adapter({ kind: 'type', entries: [], ownIds: [], inheritedLabel: undefined })}
      />,
    );

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Types' });
    const add = screen.getByRole('button', { name: 'Add a type' });
    const searching = () => document.querySelector<HTMLElement>('[data-reference-search]');

    fireEvent.click(add);
    // The add UI is open — and the attribute a reader cannot see says it is not,
    // which is the whole fault.
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute('aria-expanded')).toBe('false');
    expect(searching()?.style.minWidth).toBe('72px');

    fireEvent.click(add);

    expect(document.activeElement).not.toBe(box);
    // Read as a number: React writes the unitless `0`, jsdom 30 reads it back
    // as `0px`, and the claim is the width, not the spelling.
    expect(parseFloat(searching()?.style.minWidth ?? 'NaN')).toBe(0);
  });

  itDom('still opens the press after a value is taken', async () => {
    const model = adapter();
    render(<ReferenceSetStrip label="Teams" adapter={model} />);

    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Teams' });
    const add = screen.getByRole('button', { name: 'Add a team' });

    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(model.replace).toHaveBeenCalled();
    });

    // **The state `picker-reopens-on-click` exists for**: the take leaves the
    // focus on the box and closes the list, so "the focus is in this cell" is
    // true and "the list is open" is not. A toggle written against the focus
    // would close the cell here, which is the opposite of what that change
    // fixed — and is why the predicate is `aria-expanded`.
    await waitFor(() => {
      expect(box.getAttribute('aria-expanded')).toBe('false');
    });

    fireEvent.click(add);
    expect(box.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the reference strip on one rest line', () => {
  const crowded = () => adapter({ ownIds: ['team-1', 'team-2', 'team-3'] });

  itDom('rests every flex container of a crowded cell on one line', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    // Both, singly. One `nowrap` beside one `wrap` still wraps, so a check
    // that reads either container alone passes with the bug in the other.
    expect(getComputedStyle(strip()).flexWrap).toBe('nowrap');
    expect(getComputedStyle(chipsOf()).flexWrap).toBe('nowrap');
  });

  itDom('wraps both containers only while a crowded cell is edited', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    expect(getComputedStyle(strip()).flexWrap).toBe('wrap');
    expect(getComputedStyle(chipsOf()).flexWrap).toBe('wrap');
  });

  itDom('keeps an empty cell on one line while it is edited', () => {
    render(<ReferenceSetStrip label="Teams" adapter={adapter({ ownIds: [] })} />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    expect(getComputedStyle(strip()).flexWrap).toBe('nowrap');
  });

  itDom('leaves the whole rest line to the chips until the box is entered', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    expect(parseFloat(getComputedStyle(searchOf()).minWidth)).toBe(0);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    expect(parseFloat(getComputedStyle(searchOf()).minWidth)).toBe(72);
  });

  itDom('fades and clips the rest line, and does neither while editing', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    expect(strip().style.overflow).toBe('hidden');
    // Read back as a property rather than matched against the constant's
    // text: jsdom 30 re-spells `#000` as `rgb(0, 0, 0)` on the way in.
    expect(strip().style.maskImage).toContain('linear-gradient(to left');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    // The picker's list opens inside this element. A clip or a mask at that
    // moment cuts the directory somebody has just opened — the Depends-on
    // cell's own rule, and why both belong to rest alone.
    expect(strip().style.overflow).toBe('visible');
    expect(strip().style.maskImage).toBe('');
  });

  itDom('leaves the flow while it is edited, on a line the anchor keeps', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    // At rest the strip *is* the cell's line: in the flow, no paint of its own.
    expect(strip().style.position).toBe('');
    expect(strip().style.background).toBe('');
    // And the anchor holds that line whether or not the strip is standing in
    // it — which is what stops the row shrinking when the panel opens.
    expect(anchorOf().style.minHeight).toBe(`${String(REFERENCE_SET_LINE_HEIGHT)}px`);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));

    // Out of the flow, so the wrap above cannot grow the cell it is in; opaque
    // and above the rows, so the wrapped chips are readable rather than merely
    // present. Both halves, because either alone is the screenshot Dany sent:
    // in-flow chips grow the row, transparent chips draw over the row below.
    //
    // Proof, two faults, both watched 2026-08-29. The `position: 'absolute'`
    // removed, `three tags open the cell without moving a row` in
    // `e2e/reference-cells.spec.ts` failed in Chromium on the row's height,
    // and this failed on `expected '' to be 'absolute'`; the panel's paint
    // removed, this failed on `expected '' to be 'var(--popover)'`. jsdom
    // computes no layout, so the height half of that pair can only be a
    // browser's (`AGENTS.md`, R5 #14/#15).
    expect(strip().style.position).toBe('absolute');
    expect(strip().style.background).toBe('var(--popover)');
    expect(strip().style.zIndex).not.toBe('');
    // Still on the anchor's line, not somewhere else on the page.
    expect(strip().parentElement).toBe(anchorOf());
  });

  itDom('keeps the add button first in the strip, open or shut', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    const first = () => strip().firstElementChild;
    expect(first()?.getAttribute('data-reference-add')).toBe('');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    // The `+` vanishing from a cell full of chips is the third of the
    // 2026-08-29 screenshots — it was scrolled out of a cell the browser had
    // scrolled, not removed, and the cell cannot scroll any more (`CELL`).
    // This says the panel does not reorder it either.
    expect(first()?.getAttribute('data-reference-add')).toBe('');
  });

  itDom('keeps a clipped chip out of the tab order and the focus off its press', () => {
    render(<ReferenceSetStrip label="Teams" adapter={crowded()} />);

    const remove = screen.getByRole('button', { name: 'Remove Platform team' });
    expect(remove.tabIndex).toBe(-1);
    // `fireEvent` answers false when the handler called `preventDefault`. The
    // press must not focus this button: focus is what wraps the strip, and in
    // Chromium the wrap moved the ✕ out from under the pointer between
    // `mousedown` and `mouseup`, so no click ever landed.
    expect(fireEvent.mouseDown(remove)).toBe(false);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Teams' }));
    expect(screen.getByRole('button', { name: 'Remove Platform team' }).tabIndex).toBe(0);
  });

  itDom('draws an inherited set once, in the box it is shown but not stored in', () => {
    render(
      <ReferenceSetStrip
        label="Teams"
        adapter={adapter({ ownIds: [], inheritedLabel: 'Core' })}
        placeholder="↳ Core"
      />,
    );

    expect(drawnSayings(strip(), 'Core')).toEqual(['↳ Core']);
  });

  itDom('draws what it carries beside what it states, and only the second removably', () => {
    // ADR 0008's cell, in the state the 2026-08-29 report is about: `Platform`
    // written on this row, `Core` still in force from `010`. Both are on screen,
    // the inherited one wears the `↳` and — the assertion that matters — it has
    // no ✕ at all. A tag comes off where it was written.
    //
    // Proof, two faults, both watched 2026-08-30. The `inherited.map(…)` block
    // emptied and this failed on `expected [] to deeply equal [ '↳ Core' ]` —
    // the accumulation drawn as nothing at all, which is the report with the fix
    // half-applied. And a `<button aria-label={`Remove ${entry.name}
    // ${adapter.kind}`}>` added inside the inherited chip: it failed on
    // `expected [ <button …(4)></button>, …(1) ] to have a length of 1 but got
    // 2`, a ✕ offering to take a word off the row that did not write it.
    render(
      <ReferenceSetStrip
        label="Teams"
        adapter={adapter({
          ownIds: ['team-1'],
          inheritedLabel: undefined,
          inheritedEntries: [{ id: 'team-9', name: 'Core', fromRow: '010 Hull' }],
        })}
        placeholder="add"
      />,
    );

    expect(drawnSayings(strip(), 'Platform')).toEqual(['Platform']);
    expect(drawnSayings(strip(), 'Core')).toEqual(['↳ Core']);
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove Platform team' })).toBeInTheDocument();
    expect(
      document.querySelector('[data-reference-inherited-chip="team-9"]')?.getAttribute('data-fact'),
    ).toBe('Core — inherited from 010 Hull. Remove it there.');
  });

  itDom('drops an inherited member the row has since stated, so it is drawn once', () => {
    // The window the sheet leaves open: it re-projects `ownIds` the moment a
    // write lands, and the tree read that would drop the tag from the inherited
    // list arrives after it. Without the filter the cell draws `Core` twice —
    // once as the row's own chip and once as the ancestor's — for as long as
    // that window is open.
    //
    // Proof: the `.filter((entry) => !ownIds.includes(entry.id))` on `inherited`
    // deleted, and this failed on `expected [ 'Platform', '↳ Platform' ] to
    // deeply equal [ 'Platform' ]`. Watched 2026-08-30.
    render(
      <ReferenceSetStrip
        label="Teams"
        adapter={adapter({
          ownIds: ['team-1'],
          inheritedLabel: undefined,
          inheritedEntries: [{ id: 'team-1', name: 'Platform', fromRow: '010 Hull' }],
        })}
        placeholder="add"
      />,
    );

    expect(drawnSayings(strip(), 'Platform')).toEqual(['Platform']);
  });

  itDom('draws the sole own member once, as its chip', () => {
    render(
      <ReferenceSetStrip
        label="Teams"
        adapter={adapter({ ownIds: ['team-1'], inheritedLabel: undefined })}
        placeholder="add"
      />,
    );

    expect(drawnSayings(strip(), 'Platform')).toEqual(['Platform']);
  });
});

describe('ReferenceSetSheet', () => {
  itDom('uses the same set editor inside a labelled phone dialog', () => {
    const close = vi.fn();
    render(<ReferenceSetSheet label="Teams" adapter={adapter()} open onClose={close} />);

    expect(screen.getByRole('dialog', { name: 'Edit Teams' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Teams' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Teams' }));
    expect(close).toHaveBeenCalledOnce();
  });

  itDom('draws the inherited set once, as the roomy line a phone can afford', () => {
    render(
      <ReferenceSetSheet
        label="Teams"
        adapter={adapter({ ownIds: [], inheritedLabel: 'Core from 010' })}
        placeholder="search or add"
        open
        onClose={vi.fn()}
      />,
    );

    const sheet = screen.getByRole('dialog', { name: 'Edit Teams' });
    expect(drawnSayings(sheet, 'Core')).toEqual(['Inherited: Core from 010']);
  });
});

describe('referenceSetLines', () => {
  const carried = { id: 'tag-9', name: 'Risk', fromRow: '010 Compliance' };

  it('puts what the row states ahead of what it carries, and names where each came from', () => {
    expect(referenceSetLines([{ id: 'tag-1', name: 'Ready' }], [carried], undefined)).toEqual([
      { key: 'tag-1', text: 'Ready', stated: true },
      { key: 'tag-9', text: '↳ Risk — from 010 Compliance', stated: false },
    ]);
  });

  it('adds the overriding dimension’s reading only while the row states none of its own', () => {
    // Both arms in one case on purpose: the difference between them **is** the
    // rule, and two cases that each assert one half would both pass against a
    // line that was drawn always or never. `inheritedLabel` describes an
    // ancestor's set that is only in force while this row is silent (ADR 0008),
    // so a row that states a team of its own carries none of it — and a card
    // line saying otherwise would be a claim the cell does not make.
    //
    // Proof: the `own.length === 0 &&` guard dropped, and the second arm failed
    // on `expected [ { key: 'team-1', …(2) }, …(1) ] to deeply equal [ { key:
    // 'team-1', …(2) } ]` with `+ Object { "key": "(inherited)", "stated":
    // false, "text": "↳ Core" }` drawn under a row that states `Platform`.
    // Watched, 2026-08-31.
    expect(referenceSetLines([], [], 'Core')).toEqual([
      { key: '(inherited)', text: '↳ Core', stated: false },
    ]);
    expect(referenceSetLines([{ id: 'team-1', name: 'Platform' }], [], 'Core')).toEqual([
      { key: 'team-1', text: 'Platform', stated: true },
    ]);
  });

  it('has nothing to say about a cell that says nothing', () => {
    expect(referenceSetLines([], [], undefined)).toEqual([]);
  });
});
