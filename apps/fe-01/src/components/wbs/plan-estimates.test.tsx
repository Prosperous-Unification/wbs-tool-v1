import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import { STEP_FINAL_HINT } from './column-hints';
import { initialsOf } from './initials';
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

describe('step columns fold away', () => {
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  const headerTexts = () => screen.getAllByRole('columnheader').map((th) => th.textContent.trim());

  itDom('starts folded: one column per step, the final figure kept', async () => {
    await oneRow();

    // The whole point of the fold: two steps cost ten columns and the dates
    // fell off the screen. The figure a plan is read by stays.
    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
    expect(screen.queryByLabelText('Dev assignee for 010')).toBeNull();
    expect(rowFor('010').querySelector('[data-final="step-dev"]')).not.toBeNull();
    expect(headerTexts()).toContain('Dev ▸');
  });

  itDom('unfolds to the trio and the assignee, and folds back', async () => {
    await oneRow();

    unfoldStep('Dev');

    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByLabelText('Dev assignee for 010')).toBeDefined();
    // The other step stays folded — each opens on its own.
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
  });

  itDom('heads each point with its first letter, and says the whole word twice over', async () => {
    // Superseded, deliberately: this asserted the heading *read* `optimistic`
    // and was clipped to `optimi` by a 52px column, with the whole word in the
    // `title` as the only place a reader could get it. `spreadsheet-geometry`
    // stopped printing a word no column of this table can hold — `optimistic`
    // wants 84px, measured 2026-08-09 — and prints the letter the cells
    // already teach (`o/r/p` is the folded box's own placeholder) at 44px.
    //
    // The word is still reachable in both of the ways it was: in the `title`,
    // and — new here — as the heading's accessible name, which is what a
    // screen reader reads out for the column and what `o` alone would have
    // reduced to a letter.
    //
    // The `title` is the column's hint since `wbs-column-hints` and no longer
    // the bare word, so these three are the one place in the table where a hint
    // opens with the column's name rather than with its effect — the heading is
    // a single letter, and a sentence that never says `optimistic` would leave
    // the reader with nothing to call it.
    await oneRow();

    unfoldStep('Dev');

    for (const point of ['optimistic', 'realistic', 'pessimistic']) {
      expect(headerTitled(point.slice(0, 1)).toLowerCase()).toContain(point);
      expect(screen.getByRole('columnheader', { name: point })).toBeDefined();
    }
  });

  itDom('unfolds each step on its own, and leaves the others open', async () => {
    // **Superseded, by name**: this was `unfolds one step at a time, so the
    // table still fits the window`, and it asserted the accordion — QA open,
    // Dev's three boxes gone. `unfolding-may-scroll` reverses that decision
    // (Dany, 2026-08-08, U3) and adopts its recorded injected fault as the
    // behaviour: `[...current, stepId]` is what the writer does now.
    //
    // The arithmetic it quoted is unchanged and is still pinned in
    // `table-frame.test.ts`: a folded step costs 96px and an unfolded one 348,
    // so two folded need 1199px, one open 1451 and both open 1703 (1219 →
    // 1231 → 1483 → 1735 in `number-column-widen`, 93 → 105 in
    // `COLUMN_WIDTHS`; each 40px larger again in `external-refs`, and each 24
    // back on 2026-08-31 when `depends` paid for that column, 110 → 86), then
    // each 40px narrower when Links joined the initial hide-list and each 8px
    // narrower when the drag column moved from 24px to 16px. What changed at
    // `unfolding-may-scroll` is that the
    // third of those is now reachable, and the frame scrolling is what pays
    // for it — `e2e/layout.spec.ts` measures that half.
    await oneRow();

    unfoldStep('Dev');
    unfoldStep('QA');

    expect(screen.getByLabelText('QA optimistic for 010')).toBeDefined();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByRole('table').style.minWidth).toBe('1703px');

    // Folding one leaves the other open, rather than leaving nothing open.
    fireEvent.click(screen.getByRole('button', { name: 'Fold QA estimates' }));
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
    expect(screen.getByRole('table').style.minWidth).toBe('1451px');

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(screen.queryByLabelText('Dev optimistic for 010')).toBeNull();
    expect(screen.getByRole('table').style.minWidth).toBe('1199px');
  });

  itDom('says what the fold button does, which is no longer hiding the assignee', async () => {
    // The copy is the change: who is doing the work is in the folded cell now,
    // so a button claiming to hide it would be describing the table of a week
    // ago. The second half is superseded with the accordion — it promised that
    // any other step would fold, and none does — and what replaces it is the
    // one thing unfolding can now do that it could not before: make the table
    // wider than the window.
    // Proof: the old copy restored, this failed on `expected 'Dev — show the
    // three-point estimate a…' to contain 'show the three points behind the
    // figu…'`. Watched, 2026-08-08.
    await oneRow();

    const folded = screen.getByRole('button', { name: 'Unfold Dev estimates' });
    expect(folded.getAttribute('data-hint') ?? '').toContain('Click to show the three points');
    expect(folded.getAttribute('data-hint') ?? '').toContain('the table may scroll sideways');
    expect(folded.getAttribute('data-hint') ?? '').not.toContain('any other step folds');
    expect(folded.getAttribute('data-hint') ?? '').not.toContain('assignee');
    // And it opens with the column's own sentence, because this button covers
    // most of its `<th>`: a reader resting on it would otherwise be the one
    // reader in the table who learns nothing about the column under the cursor.
    expect((folded.getAttribute('data-hint') ?? '').startsWith(STEP_FINAL_HINT)).toBe(true);

    unfoldStep('Dev');
    const open = screen.getByRole('button', { name: 'Fold Dev estimates' });
    expect(open.getAttribute('data-hint') ?? '').toContain(
      'Click to fold the three points back into the figure',
    );
    expect(open.getAttribute('data-hint') ?? '').not.toContain('assignee');
  });

  itDom('keeps a typed estimate draft across a fold and back', async () => {
    // Drafts live in the table's state, not in the inputs, precisely so a
    // fold cannot swallow one.
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };
    unfoldStep('Dev');
    const cell = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    unfoldStep('Dev');

    expect(screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010').value).toBe('5');
    expect(sent).toEqual([]);
  });

  itDom('a folded step cannot hide a complaint', async () => {
    await oneRow();
    unfoldStep('Dev');
    const cell = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);

    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    // One point of a trio saves nothing; folded, that fact must still show on
    // the figure the fold leaves behind — the mark on the figure, and the
    // complaint on the cell's one hint, the card. No native `title`: two
    // hints over one cell is the bug this line used to be.
    const final = rowFor('010').querySelector('[data-final="step-dev"]');
    expect(final?.textContent).toContain('!');
    expect(saidBy(final)).toBeNull();
    fireEvent.mouseEnter(final as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
  });
});

describe('assigning from a folded step’s cell with @', () => {
  /** One row and two steps, both folded — where a person starts. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  const foldedCell = (step = 'Dev') =>
    screen.getByLabelText<HTMLInputElement>(`${step} estimate for 010`);

  /** Focuses the folded box and puts `text` in it, keystroke by keystroke’s event. */
  const typeInto = (cell: HTMLInputElement, text: string): HTMLInputElement => {
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    return cell;
  };

  /** Records every estimate written, and still performs it. */
  const watchEstimates = (api: ProjectApi) => recordCalls(api, 'setEstimate');

  /** What a folded step's cell says about who is doing the work, or null. */
  const assigneeShown = (step = 'step-dev'): string | null =>
    rowFor('010').querySelector(`[data-folded-assignee="${step}"]`)?.textContent ?? null;

  /** The `@` picker's entries, in the order they are offered. */
  const offered = (step = 'Dev'): (string | null)[] => {
    const list = screen
      .queryAllByRole('listbox')
      .find((box) => box.getAttribute('aria-label') === `${step} assignee for 010`);
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  };

  /** Puts a person on the directory the way a person does: `@name` in a cell. */
  const addPersonThrough = async (step: string, name: string): Promise<void> => {
    fireEvent.keyDown(typeInto(foldedCell(step), `@${name}`), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown(step === 'Dev' ? 'step-dev' : 'step-qa')).toContain(initialsOf(name));
    });
    fireEvent.blur(foldedCell(step));
  };

  itDom('opens the people picker on an @ and filters it by what follows', async () => {
    await oneRow();
    await addPersonThrough('Dev', 'Kateryna');
    await addPersonThrough('QA', 'Ada');

    const cell = foldedCell();
    expect(offered()).toEqual([]);

    // An estimate is not a mention: nothing opens until the `@` is typed.
    typeInto(cell, '2/3/8');
    expect(offered()).toEqual([]);

    fireEvent.change(cell, { target: { value: '2/3/8@' } });
    expect(offered()).toEqual(['Remove Kateryna', 'Kateryna — free agent', 'Ada — free agent']);

    fireEvent.change(cell, { target: { value: '2/3/8@ad' } });
    expect(offered()).toEqual(['Ada — free agent', 'Add “ad”']);
  });

  itDom('points the folded cell’s combobox at the line its Enter takes', async () => {
    // The screen-reader face of the first-line highlight: an open list whose
    // box names no option reads as a choice the keyboard cannot see. Enter
    // takes the first line (`CreatablePicker`'s rule), so that is the line
    // `aria-activedescendant` must name — and both pointers go when the list
    // goes.
    await oneRow();

    const cell = typeInto(foldedCell(), '@Grace');
    const list = screen.getByRole('listbox', { name: 'Dev assignee for 010' });
    const first = list.querySelector('[role="option"]')!;
    expect(cell.getAttribute('aria-controls')).toBe(list.id);
    expect(cell.getAttribute('aria-activedescendant')).toBe(first.id);

    // Enter takes that exact option, and the pick closes the list and takes
    // both pointers with it.
    fireEvent.keyDown(cell, { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· GR');
    });
    expect(cell.getAttribute('aria-controls')).toBeNull();
    expect(cell.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.blur(cell);
  });

  itDom('assigns on Enter and takes the @ back out, leaving the trio alone', async () => {
    // Dany's one gesture: `2/3/8@ka⏎` — trio typed, Kateryna assigned. The box
    // is left holding the trio and nothing else, and the blur that follows
    // sends exactly that.
    const api = await oneRow();
    await addPersonThrough('QA', 'Kateryna');

    const cell = typeInto(foldedCell(), '2/3/8@ka');
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· KA');
    });
    // The mention is gone and the estimate half is untouched.
    expect(cell.value).toBe('2/3/8');
    expect(offered()).toEqual([]);

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
  });

  itDom('never lets the @ half read as an estimate, half-typed or abandoned', async () => {
    // The rule that holds the two apart. `@ka` alone is somebody looking a
    // person up in a cell that was selected on focus — not somebody clearing
    // the estimate that selection replaced — and `4@ka` left behind is the
    // figure this tool computed, not a request for 4/4/4.
    // Proof: the `splitMention` call in `commitCombinedEstimate` replaced by
    // `const estimate = typed`, this failed on `expected '@ka' to be '4'` —
    // the mention committed as a shorthand estimate. Watched, 2026-08-08.
    const api = await oneRow();
    await addPersonThrough('QA', 'Kateryna');
    const written = watchEstimates(api);

    // An estimate to lose.
    const first = foldedCell();
    fireEvent.focus(first);
    fireEvent.change(first, { target: { value: '4' } });
    fireEvent.blur(first);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);

    // A mention typed over the whole selection: no complaint while it is
    // half-typed, and the figure back in the box when the cell is left.
    const cell = typeInto(foldedCell(), '@ka');
    expect(cell.getAttribute('aria-invalid')).toBe('false');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);

    // And a mention abandoned beside the figure the cell was already showing
    // asks be-01 for nothing at all.
    const again = typeInto(foldedCell(), '4@ka');
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(offered()).toEqual([]);
    fireEvent.blur(again);
    await waitFor(() => {
      expect(foldedCell().value).toBe('4');
    });
    expect(written).toHaveLength(1);
  });

  itDom('adds a contributor nobody had, and offers to remove the one assigned', async () => {
    const api = await oneRow();

    const cell = typeInto(foldedCell(), '@Grace');
    expect(offered()).toEqual(['Add “Grace”']);
    fireEvent.keyDown(cell, { key: 'Enter' });

    // The figure and who is doing it, in the one cell that never folds away.
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· GR');
    });
    expect(await api.listPeople()).toEqual([
      { id: 'person1', kind: 'person', name: 'Grace', teamIds: [] },
    ]);

    // A bare `@` offers to take them off again — first, so Enter on it is the
    // gesture that unassigns, and `@gr⏎` never can be.
    const again = typeInto(foldedCell(), '@');
    expect(offered()).toEqual(['Remove Grace', 'Grace — free agent']);
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBeNull();
    });
  });

  itDom('shows the assumed name in grey beside the figure of the other step', async () => {
    // One person on one step is read as doing the others too, and the folded
    // cell is where that is now visible — it used to need the step unfolded.
    await oneRow();

    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· AD');
    });

    const dev = rowFor('010').querySelector('[data-folded-assignee="step-dev"]');
    const qa = rowFor('010').querySelector('[data-folded-assignee="step-qa"]');
    expect(dev?.textContent).toBe('· AD');
    expect(dev?.getAttribute('data-assumed')).toBeNull();
    // Bracketed and grey: a reading of one assignment, not a second one
    // written down.
    expect(qa?.textContent).toBe('· (AD)');
    expect(qa?.getAttribute('data-assumed')).toBe('step-qa');
    // The palette's own muted ink rather than the `#666` it was: `styles.css`
    // re-points every token under `.dark` and a literal is the one shade that
    // would not follow. jsdom hands back the declaration, not a resolved colour.
    expect((qa as HTMLElement | null)?.style.color).toBe('var(--muted-foreground)');
  });

  itDom('says nothing where nobody is assigned and nobody is assumed', async () => {
    await oneRow();

    expect(rowFor('010').querySelector('[data-folded-assignee="step-dev"]')).toBeNull();
  });

  /** The wrapper the folded figure, its assignee and its card all live on. */
  const foldedWrapper = (step = 'step-dev'): HTMLElement => {
    const found = rowFor('010').querySelector(`[data-final="${step}"]`);
    if (found === null) throw new Error(`no folded cell for ${step}`);
    return found as HTMLElement;
  };

  itDom('opens the folded figure into its parts, without asking the server', async () => {
    // The whole of what 96px hides: the step, the trio behind the computed
    // figure, the figure, and who is doing it — read off the row the client
    // already holds, which is what makes a hover free.
    //
    // Proof: the card's `points` fed the folded cell's own value instead of
    // the row's trio (`live.current.combinedValue(...).split('/')`), this
    // failed on `expected 'Devoptimistic 3.7 · realistic — · pes…' to contain
    // 'optimistic 2'`. Watched, 2026-08-09.
    const api = await oneRow();
    await addPersonThrough('Dev', 'Kateryna');
    const cell = typeInto(foldedCell(), '2/3/8');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });

    // Every request from here on, so "no request on hover" is a fact about
    // this hover rather than about a component that never talks to be-01.
    // One array across four methods, so the assertion below is about the
    // requests **in order** rather than four separate silences. The projection
    // is what does the recording here; each method's own returned array is not
    // read.
    const asked: string[] = [];
    for (const method of ['tree', 'listPeople', 'setEstimate', 'assignPerson'] as const) {
      recordCalls(api, method, () => asked.push(method));
    }

    fireEvent.mouseEnter(foldedWrapper());

    const card = screen.getByRole('tooltip');
    // Whose card this is, in the card — not in an `aria-label` on it. It is the
    // box's description as well as its hover, and a label would be read out in
    // place of everything under it; `opens the card on the focus too` is where
    // that pair is watched.
    expect(card.textContent).toContain('Dev for 010');
    expect(card.textContent).toContain('optimistic 2');
    expect(card.textContent).toContain('realistic 3');
    expect(card.textContent).toContain('pessimistic 8');
    // The final figure the cell shows — `(2 + 4×3 + 8) / 6` — and the assignee
    // it can only show four letters of.
    expect(card.textContent).toContain('Final 3.7 days');
    expect(card.textContent).toContain('Kateryna');
    expect(asked, 'the hover asked be-01 for something').toEqual([]);
  });

  itDom('opens the card on the focus too, and points the box at it', async () => {
    // A card that only a pointer can open is half the table's data withheld
    // from anybody who does not use one — codex round 3, finding 2. This cell
    // has a box in it, so the box is the answer: focusing it opens the same
    // card and names it as the box's description, which is what a screen reader
    // reads out after the label.
    //
    // The card carries **no** `aria-label` for exactly that reason. A
    // description is computed by the accessible-name algorithm over the element
    // it points at, and a label wins over contents there — so `aria-label="Dev
    // for 010"` would have replaced the trio it exists to convey with four
    // words. The card says whose it is in its first line instead, where it is
    // both read out and on screen.
    //
    // Proof, two faults watched 2026-08-09. The `onFocus` line dropped: this
    // failed on `Unable to find an accessible element with the role "tooltip"`.
    // The `aria-label` put back on `FoldedStepCard`: on `expected 'Dev for 010'
    // to be null`.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']?.realistic).toBe(3);
    });

    // No pointer has been anywhere near this cell.
    fireEvent.focus(foldedCell());

    const card = screen.getByRole('tooltip');
    expect(card.id, 'a description has to be pointed at, so it needs an id').not.toBe('');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(card.id);
    expect(card.getAttribute('aria-label')).toBeNull();
    expect(card.textContent).toContain('Dev for 010');
    expect(card.textContent).toContain('optimistic 2');

    fireEvent.blur(foldedCell());

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(foldedCell().getAttribute('aria-describedby')).toBeNull();
  });

  itDom('keeps the focused cell’s card when the pointer visits another and leaves', async () => {
    // Round 4, finding 9. The focus and the pointer wrote one state, so a
    // pointer wandering across any other cardable cell and off it again ran the
    // guarded clear and left that state null — while the Dev box still had the
    // focus, still had nothing describing it, and had no reason to fire a focus
    // event ever again. A description that disappears because a mouse went past
    // is worse than one that was never there.
    //
    // Two states now, and one card derived from them: the pointer wins while it
    // is on something, and the focus is what is left when it is not.
    //
    // Proof: `focusedCell` folded back into `hoveredCell`, this failed on
    // `Unable to find an accessible element with the role "tooltip"` — no card
    // at all after the pointer had been and gone. Watched, 2026-08-09.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']?.realistic).toBe(3);
    });

    fireEvent.focus(foldedCell());
    const opened = screen.getByRole('tooltip');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(opened.id);

    // The pointer crosses the QA cell — which has a card of its own, so it owns
    // the screen while it is there — and leaves again.
    fireEvent.mouseEnter(foldedWrapper('step-qa'));
    expect(screen.getByRole('tooltip').textContent).toContain('QA for 010');
    fireEvent.mouseLeave(foldedWrapper('step-qa'));

    const back = screen.getByRole('tooltip');
    expect(back.textContent).toContain('Dev for 010');
    expect(foldedCell().getAttribute('aria-describedby')).toBe(back.id);

    // And the blur is still what ends it, or the card above would be one
    // nothing could close.
    fireEvent.blur(foldedCell());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('reads the trio off the row, not out of the boxes it was typed into', async () => {
    // The case the first round left out. A half-filled trio is never sent, so
    // what was typed stays a draft — and folding the step takes those boxes off
    // screen while the draft outlives them. The card is what the fold leaves
    // behind, and what the fold hid is the estimate this plan is *made of*: the
    // one be-01 holds, the one the figure beside it is computed from, the one
    // every other reader of the plan sees. A card showing 'realistic —' beside
    // 'Final 3.7 days' is a card disagreeing with itself.
    //
    // The draft is not lost by this and is not meant to be: unfolding the step
    // puts it back in the box it was typed into, with its complaint, which is
    // the only place it can be corrected. codex round 3, finding 4.
    //
    // Proof: the card's points read back through `estimateValue`, this failed on
    // `expected 'Devoptimistic 2 · realistic — · pessi…' to contain 'realistic
    // 3'`. Watched, 2026-08-09.
    const api = await oneRow();
    const cell = typeInto(foldedCell(), '2/3/8');
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });

    // Unfold, empty one of the three, and leave it: two boxes filled and one
    // not is a complaint rather than a request, so nothing is sent and what was
    // typed is held.
    click('Unfold Dev estimates');
    const realistic = await screen.findByLabelText<HTMLInputElement>('Dev realistic for 010');
    fireEvent.change(realistic, { target: { value: '' } });
    fireEvent.blur(realistic);
    expect(realistic.value, 'the emptied box did not keep what was typed').toBe('');
    expect(api.rows[0]?.estimates['step-dev']?.realistic, 'the half trio was sent').toBe(3);

    click('Fold Dev estimates');
    fireEvent.mouseEnter(foldedWrapper());

    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('optimistic 2');
    expect(card.textContent).toContain('realistic 3');
    expect(card.textContent).toContain('pessimistic 8');
  });

  itDom('says Final in days, whatever half-typed shorthand the cell is holding', async () => {
    // The same rule one line down, and the reason it is a second test: a box's
    // draft and the folded cell's own shorthand cannot both exist — writing
    // either drops the other — so one test cannot reach both.
    //
    // `Final 8/3/2 days` is what the card said while it read the cell: the
    // refused shorthand, printed where a number of days belongs.
    //
    // Proof: `final` read back through `combinedValue`, this failed on
    // `expected 'Devoptimistic 2 · realistic 3 · pessi…' to contain 'Final 3.7
    // days'`, the card reading `Final 8/3/2 days`. Watched, 2026-08-09.
    const api = await oneRow();
    fireEvent.blur(typeInto(foldedCell(), '2/3/8'));
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']?.realistic).toBe(3);
    });

    // Out of order, so be-01 is never asked and the shorthand stays in the cell
    // with its complaint on it.
    fireEvent.blur(typeInto(foldedCell(), '8/3/2'));
    expect(foldedCell().value).toBe('8/3/2');
    expect(api.rows[0]?.estimates['step-dev']?.optimistic).toBe(2);

    fireEvent.mouseEnter(foldedWrapper());

    expect(screen.getByRole('tooltip').textContent).toContain('Final 3.7 days');
  });

  itDom('says on the card that an assignee is assumed', async () => {
    await oneRow();
    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· AD');
    });
    fireEvent.blur(foldedCell());

    fireEvent.mouseEnter(foldedWrapper('step-qa'));

    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('Ada');
    expect(card.textContent).toContain('assumed');
  });

  itDom('leaves the assignee no title of its own to say it twice', async () => {
    // The name used to be a `title` on the truncated span — one line, a second
    // late, and now the card's job. What stays native is help about an action:
    // the fold/unfold button says what it does.
    //
    // Proof: the `title` put back on the assignee span, this failed on
    // `expected 'Ada' to be null`. Watched, 2026-08-09.
    await oneRow();
    fireEvent.keyDown(typeInto(foldedCell(), '@Ada'), { key: 'Enter' });
    await waitFor(() => {
      expect(assigneeShown('step-dev')).toBe('· AD');
    });

    const shown = rowFor('010').querySelector('[data-folded-assignee="step-dev"]');
    expect(saidBy(shown)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Unfold Dev estimates' }).getAttribute('data-hint'),
    ).toContain('show the three points');
  });

  itDom('keeps the cell to the @ list while that list is open', async () => {
    // Two boxes opening from the bottom edge of one 96px cell, one of them
    // being typed into. The list wins.
    //
    // Proof: the `options.length === 0` condition dropped from the card, this
    // failed on `expected [ <div role="tooltip" …/> ] to have a length of +0
    // but got 1` — the card stacked under the open list over one cell.
    // Watched, 2026-08-09.
    await oneRow();
    await addPersonThrough('Dev', 'Kateryna');

    fireEvent.mouseEnter(foldedWrapper());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    typeInto(foldedCell(), '@ka');

    expect(offered(), 'the @ list is not open, so nothing is being kept out').toContain(
      'Kateryna — free agent',
    );
    expect(screen.queryAllByRole('tooltip')).toHaveLength(0);
  });

  itDom('keeps the cell to a mention that has nobody to offer', async () => {
    // The guard used to read the list rather than the mention, and a mention
    // with an empty list is reachable: a deployment with nobody on it yet
    // answers a bare `@` with no entries at all — no people to match, and no
    // `Add "…"` until something is typed after it. The card then opened over the
    // box being typed in, which is the one place it must never be. agy round 3,
    // finding 7.
    //
    // The probe is a card open on the QA cell, so this watches the *write* as
    // well as the render: without the guard the Dev cell takes the hover, its
    // own card is suppressed by the empty list, and the reader is left with
    // nothing at all.
    //
    // Proof: the guard put back to `options.length === 0`, this failed on
    // `expected 'Dev for 010…' to contain 'QA'`. Watched, 2026-08-09.
    await oneRow();

    typeInto(foldedCell(), '@');
    expect(offered(), 'somebody is on this deployment, so the list is not empty').toEqual([]);
    fireEvent.mouseEnter(foldedWrapper('step-qa'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);

    fireEvent.mouseEnter(foldedWrapper());

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent).toContain('QA');
  });
});

describe('one cell for the whole trio', () => {
  /** The folded step's cell: holds the trio shorthand, takes `o/r/p`. */
  const combinedCell = (number: string, step = 'Dev') =>
    screen.getByLabelText<HTMLInputElement>(`${step} estimate for ${number}`);

  /**
   * The muted figure beside that cell, or null where the cell says it already.
   *
   * By its own attribute rather than by reading the whole cell: the assignee's
   * initials sit in the same box, and a text assertion over both would pass on
   * a figure that had moved into the wrong span.
   */
  const foldedFinal = (number: string, stepId = 'step-dev') =>
    rowFor(number).querySelector(`[data-folded-final="${stepId}"]`);

  /** Types shorthand into the folded cell and leaves it, the way a person does. */
  const typeCombined = (number: string, value: string) => {
    const cell = combinedCell(number);
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
    return cell;
  };

  /** Records every estimate written, and still performs it. */
  const watchWrites = (api: ProjectApi) => recordCalls(api, 'setEstimate');

  /** One row, steps left folded — which is where a person starts. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('sends one estimate for the trio typed into the folded cell', async () => {
    // The dominant loop of an estimating session: no unfolding, one cell, one
    // request. Three separate writes would each be a broadcast and a refetch
    // for everybody else, and the two in the middle would be trios nobody
    // meant to save.
    const api = await oneRow();
    const written = watchWrites(api);

    typeCombined('010', '2/3/8');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
    expect(written).toEqual([['w1', 'step-dev', { optimistic: 2, realistic: 3, pessimistic: 8 }]]);
  });

  itDom('keeps the trio in the cell once the estimate lands', async () => {
    // Dany, 2026-08-29: *"i want to keep seeing the values i've put in"*. Until
    // `estimate-triple-visible` this cell went back to be-01's computed figure
    // — `2/3/10` is PERT 4 — and the three numbers somebody chose left the
    // screen the moment they landed.
    //
    // **The wait is on the figure, not on the box**, and that is the whole of
    // whether this can fail. The box holds what was typed from the keystroke
    // onwards, so a `waitFor` on its value is satisfied at once — with
    // `combinedValue` put back to the final figure it passed, because it never
    // looked again after the round trip that would have replaced `2/3/10` with
    // `4`. The figure beside it appears only once be-01 has answered, so
    // waiting for that puts the assertion in the window the fault lives in
    // (`AGENTS.md`, R5, `D directory-page`).
    //
    // Proof: `combinedValue` put back to `showFinal(row.finalDays[stepId])`,
    // this failed on `expected '4' to be '2/3/10'`. Watched 2026-08-29.
    await oneRow();

    typeCombined('010', '2/3/10');

    await waitFor(() => {
      expect(foldedFinal('010')?.textContent).toBe('· 4');
    });
    expect(combinedCell('010').value).toBe('2/3/10');
  });

  itDom('stands the derived figure beside the trio it came from', async () => {
    // The other half of the same sentence — *"and let 2.3 estimate be added to
    // total days"*. The figure the project's estimate method makes of the trio
    // is still on screen, and still the number the row's total days is made of.
    await oneRow();

    typeCombined('010', '2/3/10');

    await waitFor(() => {
      expect(foldedFinal('010')?.textContent).toBe('· 4');
    });
    // The plan's own total, unchanged by any of this: one step, one leaf.
    expect(rowFor('010').querySelector('[data-final-total]')?.textContent).toBe('4');
  });

  itDom('says a flat trio once', async () => {
    // `5` stores `5/5/5` and every estimate method answers `5`, so a cell that
    // printed both read `5 · 5` — in 96px shared with an assignee.
    //
    // The wait is on the row's total days, which is the only thing on this row
    // that moves when the estimate lands: the box holds `5` from the keystroke
    // onwards and an unestimated row has no figure beside it either, so both
    // assertions below are satisfied before the round trip and say nothing
    // until it has happened.
    //
    // Proof: `finalSaysMore` widened to `final !== ''`, this failed on
    // `expected <span …(2)></span> to be null` — the cell reading `5 · 5`.
    // Watched 2026-08-29.
    await oneRow();

    typeCombined('010', '5');

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final-total]')?.textContent).toBe('5');
    });
    expect(combinedCell('010').value).toBe('5');
    expect(foldedFinal('010')).toBeNull();
  });

  itDom('keeps the stored figure beside a cell holding a refused entry', async () => {
    // The figure is what be-01 holds, not what the box beside it is holding —
    // {@link FoldedStepCard}'s rule for the same two fields. A figure derived
    // from the draft would stand a number beside `9/9/` claiming to be its
    // answer, and there is no answer: `9/9/` is not an estimate.
    //
    // **Refused and left**, not typed and still open: the folded cell writes no
    // draft on a keystroke (the `@` list is what `onTyped` is for), so a box
    // that has only been typed into leaves `combinedValue` reading the stored
    // trio and a draft-derived figure indistinguishable from this one. The
    // window the fault lives in opens on the blur that holds the refusal.
    //
    // Proof: the figure computed from `combinedValue`'s text instead — the
    // live-preview shape — this failed on `expected '· ' to be '· 4'` with the
    // cell holding `9/9/`. Watched 2026-08-29.
    await oneRow();
    typeCombined('010', '2/3/10');
    await waitFor(() => {
      expect(foldedFinal('010')?.textContent).toBe('· 4');
    });

    const cell = typeCombined('010', '9/9/');

    expect(cell.value).toBe('9/9/');
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(foldedFinal('010')?.textContent).toBe('· 4');
  });

  itDom('copies one row’s cell into another and lands the same estimate', async () => {
    // The wart under the complaint: `2.2` was never a legal way to have typed
    // `2/2/3`, so what the cell showed did not describe the estimate it stood
    // for. This is that property on the production path — and it has to be
    // **two rows**, because typing a cell's own value back into itself is a
    // keystroke `LiveField` diffs away as no edit at all, whatever the cell
    // was showing. `estimate-draft.test.ts` holds the round trip as a
    // property; this holds it where a person does it.
    //
    // Proof: `combinedValue` put back to `showFinal(row.finalDays[stepId])`,
    // this failed on `expected { optimistic: 4, realistic: 4, pessimistic: 4 }
    // to deeply equal { optimistic: 2, realistic: 3, pessimistic: 10 }`.
    // Watched 2026-08-29.
    const api = await oneRow();
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    typeCombined('010', '2/3/10');
    await waitFor(() => {
      expect(foldedFinal('010')?.textContent).toBe('· 4');
    });

    typeCombined('020', combinedCell('010').value);

    await waitFor(() => {
      expect(api.rows[1]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 10,
      });
    });
  });

  itDom('takes one number as the estimator saying all three are the same', async () => {
    const api = await oneRow();
    const written = watchWrites(api);

    typeCombined('010', '5');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 5,
        realistic: 5,
        pessimistic: 5,
      });
    });
    expect(written).toHaveLength(1);
  });

  itDom('sends the trio on Enter, without waiting for the cell to be left', async () => {
    // The most-edited box in the product, and until this it was the one cell of
    // the grid where Enter did nothing at all: the name cell takes it, the
    // dependency picker takes it, Prio has taken it since 2026-08-11, and an
    // estimate typed and confirmed sat as a draft with the plan's dates
    // unmoved. Observed live on dev by `wbs-e2e-planning-qa` chunk 3,
    // 2026-08-22: `20/24/30` into `Dev estimate for 040`, Enter, ten seconds of
    // an unchanged DAYS and END, then `8.8 → 26.5 days` the instant the cell
    // was clicked away from.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = combinedCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2/3/8' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(written).toEqual([
        ['w1', 'step-dev', { optimistic: 2, realistic: 3, pessimistic: 8 }],
      ]);
    });
    // The caret stays where it is, exactly as Prio's does: moving on is
    // Ctrl/⌘ + Enter's, and a bare Enter that also moved would be a second
    // chord wearing the first one's key.
    expect(document.activeElement).toBe(combinedCell('010'));
  });

  itDom('sends one request for a trio entered with Enter and then left', async () => {
    // `LiveField` rule 5 across the two callers: the blur that follows an Enter
    // finds `shown` no further on than the submission already recorded, and
    // sends nothing. Two patches here would be two broadcasts, two refetches
    // and two Ctrl/⌘ + Zs for one trio.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = combinedCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2/3/8' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);

    await waitFor(() => {
      // `2/3/8` is PERT 3.7, which is none of the three numbers typed — the
      // figure appearing beside the cell is what says the trio landed, since
      // the cell itself holds the same characters either way.
      expect(foldedFinal('010')?.textContent).toBe('· 3.7');
    });
    expect(written).toHaveLength(1);
  });

  itDom('sends an unfolded point on Enter too', async () => {
    // The same keystroke one column along. The three-box face is the one an
    // estimator opens to argue about a single number, and a number typed and
    // confirmed there was the same silent draft.
    //
    // The first two boxes are left the old way and send nothing — a trio with a
    // box still empty is a complaint, not a request (`trioProblem`) — so the
    // only thing that can produce a write here is Enter in the third.
    const api = await oneRow();
    const written = watchWrites(api);
    click('Unfold Dev estimates');

    const optimistic = await screen.findByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(optimistic, { target: { value: '2' } });
    fireEvent.blur(optimistic);
    const pessimistic = screen.getByLabelText<HTMLInputElement>('Dev pessimistic for 010');
    fireEvent.change(pessimistic, { target: { value: '8' } });
    fireEvent.blur(pessimistic);
    expect(written, 'a half-filled trio was sent').toEqual([]);

    const realistic = screen.getByLabelText<HTMLInputElement>('Dev realistic for 010');
    realistic.focus();
    fireEvent.change(realistic, { target: { value: '3' } });
    fireEvent.keyDown(realistic, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 8,
      });
    });
  });

  itDom('takes the spaces and the decimals a person types', async () => {
    const api = await oneRow();

    typeCombined('010', ' 0.5 / 1 / 2 ');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 0.5,
        realistic: 1,
        pessimistic: 2,
      });
    });
  });

  itDom('sends nothing for a trio that runs backwards, and says why', async () => {
    // Out of order is a complaint, not a sort. `8/3/2` is either a typo or a
    // person thinking in the other direction, and guessing which is how the
    // old table came to save numbers nobody typed.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = typeCombined('010', '8/3/2');

    expect(written).toEqual([]);
    expect(api.rows[0]?.estimates['step-dev']).toBeUndefined();
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    // The complaint reads off the card, the cell's one hint. 'Must read' and
    // not 'optimistic': the card's help line says 'optimistic' about every
    // cell, so that word can never fail here.
    fireEvent.focus(cell);
    expect(screen.getByRole('tooltip').textContent).toContain('Must read optimistic');
    // What was typed stays typed. Clearing it would take the correction away
    // from the only person who can make it.
    expect(cell.value).toBe('8/3/2');
  });

  itDom('sends nothing for two numbers where three were needed', async () => {
    // `2/3` is a half-typed trio, exactly like two filled boxes and one empty
    // one, and it saves nothing for the same reason: be-01 stores a trio or
    // nothing.
    const api = await oneRow();
    const written = watchWrites(api);

    const cell = typeCombined('010', '2/3');

    expect(written).toEqual([]);
    expect(api.rows[0]?.estimates['step-dev']).toBeUndefined();
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(cell.value).toBe('2/3');
  });

  itDom('keeps a refused entry through somebody else’s refetch', async () => {
    // Drafts live in the table's state rather than in the input, so the refetch
    // every edit triggers cannot swallow a correction half made.
    const api = await oneRow();
    typeCombined('010', '1/2/3/4');

    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const cell = combinedCell('010');
    expect(cell.value).toBe('1/2/3/4');
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(api.rows[0]?.estimates['step-dev']).toBeUndefined();
  });

  itDom('clears the stored trio when the cell is emptied', async () => {
    const api = await oneRow();
    typeCombined('010', '2/3/10');
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toBeDefined();
    });
    const cleared = recordCalls(api, 'clearEstimate');

    typeCombined('010', '');

    await waitFor(() => {
      expect(cleared).toEqual([['w1', 'step-dev']]);
    });
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toBeUndefined();
    });
    expect(combinedCell('010').value).toBe('');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('asks for nothing when a cell with no estimate is emptied', async () => {
    // Tabbing through an unestimated plan must not post a deletion per step
    // per row. A space is what a person leaves behind after select-all.
    const api = await oneRow();
    const cleared: unknown[] = [];
    api.clearEstimate = (...args: unknown[]) => {
      cleared.push(args);
      return Promise.resolve();
    };
    const written = watchWrites(api);

    typeCombined('010', ' ');

    expect(cleared).toEqual([]);
    expect(written).toEqual([]);
  });

  itDom('gives way to the three boxes when the step is unfolded', async () => {
    // Two editors for one trio side by side is two places to disagree. The
    // combined cell is the folded step's; unfolded, the boxes are.
    await oneRow();
    expect(combinedCell('010')).toBeDefined();

    unfoldStep('Dev');

    expect(screen.queryByLabelText('Dev estimate for 010')).toBeNull();
    expect(screen.getByLabelText('Dev optimistic for 010')).toBeDefined();
  });

  itDom('leaves a parent’s rolled-up figure to be read, not typed into', async () => {
    const api = await oneRow();
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    typeCombined('010.1', '2/3/10');
    await waitFor(() => {
      expect(api.rows.find((r) => r.id === 'w2')?.estimates['step-dev']).toBeDefined();
    });

    // The parent sums what is below it; there is nothing there to type. Its
    // figure is still shown — read-only text where the leaf has a box.
    expect(screen.queryByLabelText('Dev estimate for 010')).toBeNull();
    expect(rowFor('010').querySelector('[data-final="step-dev"]')).not.toBeNull();
    await waitFor(() => {
      expect(combinedCell('010.1').value).toBe('2/3/10');
    });
  });

  itDom('reads a parent’s roll-up as a trio too', async () => {
    // One column, one reading. A column that printed a trio on a leaf and a
    // bare figure on the row above it would be two readings of one heading —
    // and a parent's trio is the sum of its descendants' per point, so the
    // figure beside it cannot contradict the leaves it is made of.
    //
    // Proof: the parent's cell put back to the figure alone, this failed on
    // `expected '4· 4' to contain '2/3/10'`. Watched 2026-08-29.
    const api = await oneRow();
    pressNewItem('010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    pressTab('020');
    await screen.findByLabelText('Name of 010.1');

    typeCombined('010.1', '2/3/10');
    await waitFor(() => {
      expect(api.rows.find((row) => row.id === 'w2')?.estimates['step-dev']).toBeDefined();
    });

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="step-dev"]')?.textContent).toContain(
        '2/3/10',
      );
    });
    expect(foldedFinal('010')?.textContent).toBe('· 4');
  });

  itDom('is a cell of the keyboard grid, so a column can be typed down', async () => {
    // The whole point of the shorthand is typing estimates for many rows fast,
    // and that is Down, type, Down, type.
    const api = await oneRow();
    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const first = combinedCell('010');
    first.focus();
    first.setSelectionRange(0, 0);
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(combinedCell('020'));
    fireEvent.change(combinedCell('020'), { target: { value: '1/1/1' } });
    fireEvent.blur(combinedCell('020'));
    await waitFor(() => {
      expect(api.rows[1]?.estimates['step-dev']).toEqual({
        optimistic: 1,
        realistic: 1,
        pessimistic: 1,
      });
    });
  });

  itDom('lets a folded entry replace what the boxes were holding', async () => {
    // One row and step has one pending draft, whichever way it was typed. The
    // alternative is two half-typed estimates of one trio and a rule about
    // which of them is real — and this is the case where it shows, because a
    // refused entry is the one that stays.
    const api = await oneRow();
    const written = watchWrites(api);
    unfoldStep('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '7' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    typeCombined('010', '8/3/2');

    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    // The `7` was a draft of this same trio, and the trio has since been typed
    // again — differently, and last. It is not still waiting in a box.
    unfoldStep('Dev');
    const after = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    expect(after.value).toBe('');
    expect(after).toHaveAttribute('aria-invalid', 'false');
    expect(written).toEqual([]);
  });

  itDom('lets a box replace what the folded cell was holding', async () => {
    // The same rule the other way round: the boxes were typed last, so the
    // refused shorthand is gone and the complaint on the folded figure is the
    // boxes' own.
    const api = await oneRow();
    const written = watchWrites(api);
    typeCombined('010', '8/3/2');

    unfoldStep('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '1' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(combinedCell('010').value).toBe('');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.focus(combinedCell('010'));
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
    expect(written).toEqual([]);
  });

  itDom('lets a box win back over a refused folded entry', async () => {
    const api = await oneRow();
    typeCombined('010', '8/3/2');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');

    unfoldStep('Dev');
    for (const [point, value] of [
      ['optimistic', '1'],
      ['realistic', '2'],
      ['pessimistic', '3'],
    ] as const) {
      const box = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for 010`);
      fireEvent.change(box, { target: { value } });
      fireEvent.blur(box);
    }

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      });
    });
    // Folded again, the cell shows what be-01 now holds — not the `8/3/2` that
    // was refused before the boxes said something else.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));
    expect(combinedCell('010').value).toBe('1/2/3');
    expect(foldedFinal('010')?.textContent).toBe('· 2');
    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('marks the folded cell when the boxes hold a trio that saves nothing', async () => {
    // The `!` marker `role-columns-fold` put on the figure now has an input
    // under it, and the complaint has to reach both.
    await oneRow();
    unfoldStep('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dev estimates' }));

    expect(combinedCell('010')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.focus(combinedCell('010'));
    expect(screen.getByRole('tooltip').textContent).toContain('not saved');
    expect(rowFor('010').querySelector('[data-final="step-dev"]')?.textContent).toContain('!');
  });
});

describe('estimates are never edited for you', () => {
  /** Types `value` into one estimate box and leaves it, the way a person does. */
  const typeEstimate = (number: string, point: string, value: string) => {
    const cell = screen.getByLabelText<HTMLInputElement>(`Dev ${point} for ${number}`);
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
    return cell;
  };

  const estimateCell = (number: string, point: string) =>
    screen.getByLabelText<HTMLInputElement>(`Dev ${point} for ${number}`);

  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    unfoldStep('Dev');
    return api;
  }

  itDom('sends nothing, and keeps what was typed, until the trio is complete', async () => {
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };

    typeEstimate('010', 'optimistic', '5');

    // The old table turned this into 5/5/5 and sent it — three numbers from
    // one keystroke, two of which nobody typed.
    expect(sent).toEqual([]);
    expect(estimateCell('010', 'optimistic').value).toBe('5');
    expect(estimateCell('010', 'realistic').value).toBe('');
  });

  itDom('marks the boxes that are still empty rather than filling them', async () => {
    await oneRow();

    typeEstimate('010', 'optimistic', '5');

    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'pessimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic').getAttribute('data-fact') ?? '').toContain('not saved');
    // The box holding a real number is not the mistake.
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('marks both members of a pair that breaks the order, and sends nothing', async () => {
    const api = await oneRow();
    const sent: unknown[] = [];
    api.setEstimate = (...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve();
    };

    typeEstimate('010', 'optimistic', '5');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    expect(sent).toEqual([]);
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'pessimistic')).toHaveAttribute('aria-invalid', 'false');
    // And the numbers are exactly the ones typed — nothing was reordered.
    expect(estimateCell('010', 'optimistic').value).toBe('5');
    expect(estimateCell('010', 'realistic').value).toBe('3');
  });

  itDom('sends the trio, unaltered, once it reads sensibly', async () => {
    const api = await oneRow();

    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 2,
        realistic: 3,
        pessimistic: 10,
      });
    });
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('fixing the broken box sends the trio it was holding back', async () => {
    const api = await oneRow();
    typeEstimate('010', 'optimistic', '5');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    typeEstimate('010', 'realistic', '7');

    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toEqual({
        optimistic: 5,
        realistic: 7,
        pessimistic: 10,
      });
    });
  });

  /** Records every clear the table asks for, and still performs it. */
  const watchClears = (api: ProjectApi) => recordCalls(api, 'clearEstimate');

  /** Types a stored `2 / 3 / 10` for Dev on `010` and waits for be-01 to hold it. */
  async function estimated() {
    const api = await oneRow();
    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toBeDefined();
    });
    return api;
  }

  itDom('clears the stored trio when all three boxes are emptied', async () => {
    // Until now a trio could be overwritten but never taken back off. Emptying
    // the three boxes is the only gesture that says "this row does not need
    // this step", and it used to save nothing at all.
    const api = await estimated();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'realistic', '');
    typeEstimate('010', 'pessimistic', '');

    await waitFor(() => {
      expect(cleared).toEqual([['w1', 'step-dev']]);
    });
    await waitFor(() => {
      expect(api.rows[0]?.estimates['step-dev']).toBeUndefined();
    });
    // The drafts went with it, so the boxes read from the tree again rather
    // than from three empty strings the table is still holding.
    expect(estimateCell('010', 'optimistic').value).toBe('');
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'false');
  });

  itDom('does not clear when only two of the three boxes are emptied', async () => {
    // The half-emptied trio stays exactly what it was before: a complaint. A
    // clear here would be the tool deciding that two blanks mean "delete it",
    // which is the same class of assumption as repairing a trio.
    const api = await estimated();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'realistic', '');

    expect(cleared).toEqual([]);
    expect(api.rows[0]?.estimates['step-dev']).toEqual({
      optimistic: 2,
      realistic: 3,
      pessimistic: 10,
    });
    expect(estimateCell('010', 'optimistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic')).toHaveAttribute('aria-invalid', 'true');
    expect(estimateCell('010', 'realistic').getAttribute('data-fact') ?? '').toContain('not saved');
    expect(estimateCell('010', 'pessimistic').value).toBe('10');
  });

  itDom('asks for nothing when three empty boxes were already empty', async () => {
    // A row nobody estimated is the ordinary state. Tabbing through its boxes
    // must not post a deletion for every step on every row it passes.
    const api = await oneRow();
    const cleared = watchClears(api);

    typeEstimate('010', 'optimistic', '');
    typeEstimate('010', 'pessimistic', '');

    expect(cleared).toEqual([]);
  });

  itDom('shows the final figure be-01 computed, per step and in total', async () => {
    const api = await oneRow();

    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="step-dev"]')?.textContent).toBe('4');
    });
    expect(rowFor('010').querySelector('[data-final-total]')?.textContent).toBe('4');
    expect(api.rows[0]?.estimates['step-dev']?.realistic).toBe(3);
  });

  itDom('follows the project’s chosen method', async () => {
    await oneRow();
    typeEstimate('010', 'optimistic', '2');
    typeEstimate('010', 'realistic', '3');
    typeEstimate('010', 'pessimistic', '10');
    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="step-dev"]')?.textContent).toBe('4');
    });

    fireEvent.change(screen.getByLabelText('Final estimate'), {
      target: { value: 'pessimistic' },
    });

    await waitFor(() => {
      expect(rowFor('010').querySelector('[data-final="step-dev"]')?.textContent).toBe('10');
    });
  });
});

describe('what the plan is still missing', () => {
  /** The readiness badge, or null when the plan is complete and it is gone. */
  const badge = () => screen.queryByRole('button', { name: /unestimated/ });

  /** The badge, thrown for rather than defaulted: a null here means test setup. */
  const theBadge = (): HTMLElement => {
    const found = badge();
    if (found === null) throw new Error('no readiness badge on screen');
    return found;
  };

  /** Rows with nothing typed into them yet, steps left folded — where a person starts. */
  async function rows(count: number) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030'].slice(0, count)) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    return api;
  }

  /** Estimates one row and step through the folded cell, and waits for it to land. */
  const estimate = async (number: string, step: 'Dev' | 'QA') => {
    const cell = screen.getByLabelText<HTMLInputElement>(`${step} estimate for ${number}`);
    fireEvent.change(cell, { target: { value: '5' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(`${step} estimate for ${number}`).value).toBe(
        '5',
      );
    });
  };

  itDom('counts the leaves that are short, not the steps they are short of', async () => {
    // Two work items to go and fix, three step-sized holes between them. The
    // badge is a number of rows a reader can walk; adding the per-step counts
    // would print a bigger number than there are rows to visit.
    await rows(3);
    await estimate('010', 'Dev');
    await estimate('010', 'QA');
    await estimate('020', 'Dev');

    expect(theBadge().textContent).toBe('2 unestimated');
    expect(theBadge().getAttribute('data-fact')).toBe('1 missing Dev, 2 missing QA');
    // A native button, so Enter and Space activate it without this table
    // binding a key. jsdom does not perform that activation, so it is the
    // element itself that is asserted here.
    expect(theBadge().tagName).toBe('BUTTON');
  });

  itDom('says nothing at all about a plan that is complete', async () => {
    // A complete plan needs no badge. A permanent green tick is a thing to
    // stop seeing, and this one has to be noticed the day it appears.
    await rows(1);
    expect(badge()).not.toBeNull();

    await estimate('010', 'Dev');
    await estimate('010', 'QA');

    expect(badge()).toBeNull();
  });

  itDom('says nothing about a project with no work items in it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add work item' })).toBeDefined();
    });

    expect(badge()).toBeNull();
  });

  itDom('lands the focus in the cell of the first step that leaf is missing', async () => {
    // Per step, not per row: 010 has a Dev estimate and no QA one, so the cell
    // to be standing in is QA's. Sending the focus to Dev would be the tool
    // pointing at the one number that is already there.
    await rows(2);
    await estimate('010', 'Dev');

    fireEvent.click(theBadge());

    expect(document.activeElement).toBe(screen.getByLabelText('QA estimate for 010'));
  });

  itDom('moves on to the next leaf on the next click, and wraps at the end', async () => {
    await rows(2);

    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));

    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 020'));

    // Wraps rather than stopping: the badge is a walk through what is left,
    // and a button that stops working at the end reads as broken.
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
  });

  itDom('starts again from the top when the leaf it was on has been estimated', async () => {
    await rows(3);
    fireEvent.click(theBadge());
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 020'));

    await estimate('020', 'Dev');
    await estimate('020', 'QA');

    // The row the cycle was standing on is no longer in the list. Rather than
    // guess where it used to be, the walk starts over.
    fireEvent.click(theBadge());
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
  });

  itDom('opens a collapsed branch rather than focusing a cell nobody can see', async () => {
    const api = await rows(2);
    pressTab('020');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    click('Collapse 010');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });
    // The parent is a roll-up of the child, so the child is the only gap.
    expect(theBadge().textContent).toBe('1 unestimated');
    expect(api.rows).toHaveLength(2);

    fireEvent.click(theBadge());

    expect(numbersOnScreen()).toEqual(['010', '010.1']);
    expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010.1'));
  });

  itDom('lands in the first box while the step is unfolded, where the trio is typed', async () => {
    // Unfolded, the folded cell is the read-only figure again and the three
    // boxes are the editor — so that is where the walk has to put the caret.
    await rows(1);
    unfoldStep('Dev');

    fireEvent.click(theBadge());

    expect(document.activeElement).toBe(screen.getByLabelText('Dev optimistic for 010'));
  });
});
