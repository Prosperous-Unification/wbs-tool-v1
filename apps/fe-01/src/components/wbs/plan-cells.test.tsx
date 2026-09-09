import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi } from '@/lib/wbs-api';
import { DEV, fakeProjectApi as fakeApi, QA } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import { refusedDraftFor } from './live-editing';
import type * as TableFrameModule from './table-frame';
import { POPOVER_ROW_LAYER } from './table-frame';
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

/** What the toast stack is saying, newest first. */
const toastTexts = (): string[] =>
  [...document.querySelectorAll('[data-toast-text]')].map((node) => node.textContent);

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
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

/**
 * The one mark whose **project fact** matches `words`.
 *
 * `getByTitle`'s replacement, and it has one: this app draws its own cards and
 * carries their words in an attribute rather than in a `title` — see
 * `HintLayer`, and `hints-are-the-page-s-own` for why a browser tooltip is not
 * one. `data-fact` and not `data-hint` because the words this is asked for are
 * about the reader's own row: since `tool-hints-wait` the two attributes are
 * separate, and searching the wrong one finds nothing at all. A `hinted`
 * sibling over `data-hint` belongs here the day a case wants one.
 */
const facted = (words: RegExp): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('[data-fact]')].filter((node) =>
    words.test(node.getAttribute('data-fact') ?? ''),
  );
  if (found.length === 0) throw new Error(`nothing states ${String(words)}`);
  if (found.length > 1) throw new Error(`${String(found.length)} things state ${String(words)}`);
  return found[0];
};

/** The `<tr>` whose number cell reads `number`. */
const rowFor = (number: string): HTMLElement => {
  const found = screen
    .getAllByRole('row')
    .find((tr) => tr.querySelector('[data-number]')?.textContent === number);
  if (found === undefined) throw new Error(`no row numbered ${number}`);
  return found;
};

describe('teams and assignees', () => {
  beforeEach(showEveryColumn);

  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    // Dev only, and QA deliberately left folded: the folded cell is where the
    // every-step assumption is read, beside the figure. A second unfold
    // would have folded this one until `unfolding-may-scroll`; it would leave
    // both open now, and this fixture wants one of each.
    unfoldStep('Dev');
    return api;
  }

  /** The entries a creatable picker is offering, scoped to its own listbox. */
  const offeredIn = (label: string) => {
    const list = screen
      .queryAllByRole('listbox')
      .find((box) => box.getAttribute('aria-label') === label);
    return list === undefined
      ? []
      : [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  };

  itDom('reads the team out of the set, not the column beside it', async () => {
    // The switch this change is: `work_item_team` is the read, and
    // `serviceTeamId` is a second copy be-01 keeps written for one release so
    // that the outgoing fe-01 bundle still works mid-swap. Every other test
    // here has both written and agreeing, so none of them can tell which one
    // this cell is reading — this one states them apart, which is also what
    // R2-4's payload looks like once the column becomes the derived copy.
    //
    // Proof: `effectiveTeamLabelOf`'s own-set arm pointed back at
    // `row.serviceTeamId`, and this failed on `expected 'Platform — inherited
    // from 010 (unname…' to be null` — the cell telling a reader it inherits
    // its team from itself — 1 failed / 425 passed; watched 2026-08-14. The
    // chip assertion alone stays green under that fault, because the chip is a
    // second read of the same set: which arm answered is the part only the
    // title can say.
    const api = await oneRow();
    await api.addTeam('Platform');
    const [row] = api.rows;
    row.teamIds = ['team1'];
    row.serviceTeamId = null;
    // A refresh the component will take: adding a row is the cheapest.
    click('Add work item');
    await screen.findByLabelText('Name of 020');

    const box = screen.getByLabelText<HTMLInputElement>('Service or team for 010');
    // As a chip. The box beside it is the add path and stays empty whatever
    // the set holds — 4b.4, where a `restingValue` repeating the sole member
    // drew `Platform ✕ Platform` in one 120px cell.
    expect(screen.getByRole('button', { name: 'Remove Platform team' })).toBeInTheDocument();
    expect(box.value).toBe('');
    // And it is the row's **own** team, not one it is told it inherits: the
    // two arms of `effectiveTeamLabelOf` read different things, and only the
    // second one leaves a title on the cell.
    expect(box.getAttribute('data-fact')).toBeNull();
  });

  itDom('adds a team by typing a name the list does not have', async () => {
    const api = await oneRow();
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Platform' } });
    expect(offeredIn(label)).toEqual(['Add “Platform”']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe('team1');
    });
  });

  itDom('offers an existing team rather than adding a second one', async () => {
    const api = await oneRow();
    await api.addTeam('Platform');
    // Added behind the component's back, so a refresh has to bring it in —
    // adding a row is the cheapest one to trigger.
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'plat' } });

    // A partial match offers the team *and* the chance to add a team actually
    // called `plat` — both are things somebody might mean.
    expect(offeredIn(label)).toEqual(['Platform', 'Add “plat”']);

    // The exact name offers no "Add": that is how a list grows a second
    // `Platform`, and be-01 is idempotent by name because it will be tried
    // from two browsers at once anyway.
    fireEvent.change(picker, { target: { value: 'Platform' } });
    expect(offeredIn(label)).toEqual(['Platform']);
  });

  /**
   * `wbs-team-picker-substitutes`, finding 2 of the 2026-08-22 planning QA:
   * typed `QA` into a new plan's team cell, pressed Enter, got
   * `claire qa billing`.
   *
   * The shared directory is not the fault — `service_team`'s own comment says
   * every project draws from one list on purpose, so a team somebody else made
   * belongs on offer. The fault is that Enter took it: a name typed in full
   * lost to a name it merely sits inside, with nothing on screen distinguishing
   * "made the team I named" from "joined one that is already carrying four
   * other plans' load". The knock-on is a schedule levelled against capacity
   * the planner never chose.
   */
  itDom('creates the name typed rather than joining one that merely contains it', async () => {
    const api = await oneRow();
    await api.addTeam('claire qa billing');
    // Added behind the component's back, so a refresh has to bring it in.
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'QA' } });

    // The order *is* the fix: the first line is the line Enter takes, so the
    // new team stands above the name that happens to contain those letters —
    // which is still offered, because joining it is a thing somebody might
    // mean, just not the thing they said.
    expect(offeredIn(label)).toEqual(['Add “QA”', 'claire qa billing']);
    // And the box says which line that is, for a reader who cannot see it.
    expect(picker.getAttribute('aria-activedescendant')).toBe(
      screen.getByText('Add “QA”').getAttribute('id'),
    );

    fireEvent.keyDown(picker, { key: 'Enter' });
    // The created team lands as this row's chip; the box it was typed into is
    // the add path and empties again (4b.4).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove QA team' })).toBeInTheDocument();
    });
    // The stranger's team is untouched and still there: nothing was renamed
    // and nothing was joined.
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['claire qa billing', 'QA']);
  });

  /**
   * The case that makes the reorder a rule rather than "Enter always creates".
   *
   * A leading match is autocomplete and has to keep winning, or every planner
   * half-way through spelling `Platform` gets a second team called `plat` —
   * which is the exact duplicate-directory harm the `Add` line is guarded
   * against in the first place.
   */
  itDom('still takes the team it is half-way through spelling', async () => {
    const api = await oneRow();
    const platform = await api.addTeam('Platform');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'plat' } });
    expect(offeredIn(label)).toEqual(['Platform', 'Add “plat”']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(platform.id);
    });
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['Platform']);
  });

  /**
   * The other half of the QA report — typed `Backend`, got `backend` — and it
   * is the one thing in that finding which is right. An exact match case aside
   * is the team, and joining it is what stops the directory growing a second
   * spelling of one name. Pinned because the ranking above sorts on the same
   * comparison and could lose it.
   */
  itDom('joins the team already spelled that way in another case', async () => {
    const api = await oneRow();
    const backend = await api.addTeam('backend');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    const label = 'Service or team for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Backend' } });
    expect(offeredIn(label)).toEqual(['backend']);
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(backend.id);
    });
    expect((await api.listTeams()).map((team) => team.name)).toEqual(['backend']);
  });

  itDom('assigns a person who is in no team as a free agent', async () => {
    const api = await oneRow();
    const label = 'Dev assignee for 010';

    const picker = screen.getByLabelText(label);
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Ada' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe('Ada');
    });
    const people = await api.listPeople();
    // `kind` is on the wire and was missing from the fixture until 2026-09-02,
    // so these three assertions described a person be-01 never sends.
    expect(people).toEqual([{ id: 'person1', kind: 'person', name: 'Ada', teamIds: [] }]);
  });

  itDom('joins a new person to the work item’s team', async () => {
    const api = await oneRow();
    const team = await api.addTeam('Billing');
    await api.patchWorkItem('w1', { serviceTeamId: team.id });
    // The tree has to come back carrying the team before the assignee picker
    // can act on it.
    const teamPicker = screen.getByLabelText('Service or team for 010');
    fireEvent.focus(teamPicker);
    fireEvent.change(teamPicker, { target: { value: 'Billing' } });
    fireEvent.keyDown(teamPicker, { key: 'Enter' });
    await waitFor(() => {
      expect(api.rows[0]?.serviceTeamId).toBe(team.id);
    });

    const picker = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Grace' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(async () => {
      expect(await api.listPeople()).toContainEqual({
        id: 'person1',
        kind: 'person',
        name: 'Grace',
        teamIds: [team.id],
      });
    });
  });

  itDom('says the single assignee is doing the other step too', async () => {
    await oneRow();

    const picker = screen.getByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Ada' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Dev assignee for 010').value).toBe('Ada');
    });
    // The QA cell is empty and says who is assumed to be covering it — which
    // is a reading of one assignment, not a second one written down.
    expect(rowFor('010').querySelector('[data-assumed]')?.textContent).toBe('· (AD)');
  });
});

describe('the priority cell', () => {
  /** Two empty root rows, and the api the table is driving. */
  async function twoRows() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    return api;
  }

  /** Every PATCH the table sends, still performed. */
  const watchPatches = (api: ProjectApi): unknown[] =>
    recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

  const priorityCell = (number: string): HTMLInputElement =>
    screen.getByLabelText<HTMLInputElement>(`Priority for ${number}`);

  /** Types into the cell and leaves it, which is when a `CellInput` commits. */
  const typeIntoPriority = (number: string, text: string): void => {
    const cell = priorityCell(number);
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    fireEvent.blur(cell);
  };

  /** This row's priority cell as the refusal map keys it — `rowId::priority`. */
  const priorityCellKey = (number: string): string => {
    const key = priorityCell(number).dataset['cell'];
    // The box is a `CellInput`, which requires a `cellKey` and renders it as
    // `data-cell`. A cell without one is a bug in the wiring, not a state.
    if (key === undefined) throw new Error(`The priority cell of ${number} carries no data-cell.`);
    return key;
  };

  itDom('is blank on every row of a plan nobody has given priorities', async () => {
    // No placeholder and no em-dash. A priority is a scale, and a hint on every
    // empty cell of every row is a wall of grey saying nothing — Dany's
    // compaction, 2026-08-08.
    await twoRows();

    for (const number of ['010', '020']) {
      expect(priorityCell(number).value).toBe('');
      expect(priorityCell(number).placeholder).toBe('');
    }
  });

  itDom('sends what was typed and shows what came back', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '2');

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 2 }]);
    });
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('2');
    });
  });

  itDom('clears the priority when the cell is emptied, rather than sending a zero', async () => {
    // `Number('')` is 0, and 0 is a priority be-01 refuses. An emptied box is the
    // one reading this client makes on its own.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '3');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 3 }]);
    });

    typeIntoPriority('010', '');

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 3 }, { priority: null }]);
    });
  });

  itDom('sends a number be-01 will refuse rather than deciding for it', async () => {
    // `0`, `-1` and `1.5` go out and come back refused, exactly as a bad name
    // does. The rule about what a priority may be is be-01's, and a second copy of
    // it here is a rule that can quietly disagree with the one that counts.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '0');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 0 }]);
    });

    typeIntoPriority('020', '1.5');
    await waitFor(() => {
      expect(patched).toEqual([{ priority: 0 }, { priority: 1.5 }]);
    });
  });

  itDom('says so, and sends nothing, when what was typed is not a number at all', async () => {
    // The one refusal this client makes alone, and only because it cannot ask:
    // JSON has no literal for `NaN`, so a request carrying one arrives as
    // `null` — which is the request that clears a priority. Silently clearing
    // somebody's priority because they typed a letter is the fault this avoids.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', 'urgent');

    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(patched).toEqual([]);
  });

  itDom(
    'says so, and sends nothing, when what was typed is a number too big to be one',
    async () => {
      // `1e999` is the trap the same guard already has to survive on a stored
      // column width (`rememberedWidthOverrides`, `wbs-table.tsx`): `Number` reads
      // it as `Infinity`, which is not `NaN` and would pass a `Number.isNaN`
      // check — and JSON has no literal for `Infinity` either, so the request
      // arrives at be-01 as `{"priority":null}`, which is the request that
      // **clears** a priority. Somebody's priority silently wiped by a typo is
      // the fault this refuses; the guard is `Number.isFinite`, not `isNaN`.
      //
      // The patch is recorded as the wire sees it — through `JSON.stringify` —
      // because `Infinity` in a JS object is not the value that arrives, and a
      // test watching the object alone cannot see the loss.
      const api = await twoRows();
      // Copied on the way past, because the fake is free to mutate the object
      // it was handed and the assertion below is about what left the browser.
      const onTheWire = recordCalls(api, 'patchWorkItem', (_id, patch): unknown =>
        JSON.parse(JSON.stringify(patch)),
      );

      typeIntoPriority('010', '1e999');

      await waitFor(() => {
        expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
      });
      expect(onTheWire).toEqual([]);
    },
  );

  itDom('sends what was typed on Enter, without waiting for the cell to be left', async () => {
    // Enter is the keystroke a number goes in with, and until this it sent
    // nothing at all: the dates under the plan sat still until the reader
    // happened to click elsewhere. Observed live on dev, Group D, 2026-08-11.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '1' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(patched).toEqual([{ priority: 1 }]);
    });
    // The caret stays where it is. Moving on is the chord's — Ctrl/⌘ + Enter
    // saves and lands in the next row — and a bare Enter that also moved would
    // be a second chord wearing the first one's key.
    expect(document.activeElement).toBe(priorityCell('010'));
  });

  itDom('sends one request for a priority entered with Enter and then left', async () => {
    // Rule 5 of `LiveField`: `shown` has not advanced while the request is out,
    // so the blur that follows an Enter looks exactly like a fresh edit unless
    // the submission already recorded is what answers it. Two patches here
    // would be two journal entries and two Ctrl/⌘ + Zs for one typed number.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '4' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(priorityCell('010').value).toBe('4');
    });
    expect(patched).toEqual([{ priority: 4 }]);
  });

  itDom('leaves Ctrl/⌘ + Enter to the chord, which saves and moves on', async () => {
    // The modifier guard on the bare-Enter branch, and the negative that says
    // it can fail: without it the branch consumes the chord, so a save that
    // was supposed to land in the next row leaves the caret in Prio.
    // Proof: the four modifier tests dropped from that branch, this failed on
    // `expected <input aria-label="Priority for 010" …> to be <textarea
    // aria-label="Name of 020" …>`. Watched, 2026-08-11.
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = priorityCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2' } });
    fireEvent.keyDown(cell, { key: 'Enter', code: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(patched).toEqual([{ priority: 2 }]);
  });

  itDom('shows the draft just refused, not the one refused before it', async () => {
    // A refusal is held so the only copy of what somebody typed is not lost
    // (`LiveField`, rule 4) — and what has to be held is the *newest* of them.
    // Typing over a refused draft and being refused again put the previous
    // draft back on screen: the number on the row was one nobody had typed for
    // several seconds. Observed live on dev, Group D, 2026-08-11.
    await twoRows();

    typeIntoPriority('010', '1e999');
    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(priorityCell('010').value).toBe('1e999');

    typeIntoPriority('010', 'urgent');

    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBe('urgent');
    });
    expect(priorityCell('010').value).toBe('urgent');

    // Emptying the box is how a draft is abandoned rather than retried, and it
    // is what keeps this test's refusal out of the next one's map.
    typeIntoPriority('010', '');
    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBeUndefined();
    });
  });

  itDom('draws the number in its band’s colour and names the band in the title', async () => {
    // Dany, 2026-08-13: "ui must display differently for different priorities".
    // The cell's **ink**, not a background: the column is 48px of right-aligned
    // digits between two bordered cells, and a filled swatch there reads as a
    // selection. The colour is `priorityBandStyleOf`'s, which is the same one the
    // chart's cap, the cards' chip and the export's column resolve through.
    //
    // Proof: the `color: paint?.ink` line deleted from `PriorityCell`, and this
    // failed on `expected '' not to be ''` — a Critical row and a Lowest row
    // drawn in one ink. Watched 2026-08-14.
    await twoRows();
    typeIntoPriority('010', '5');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('5');
    });
    typeIntoPriority('020', '90');
    await waitFor(() => {
      expect(priorityCell('020').value).toBe('90');
    });

    const critical = priorityCell('010').style.color;
    const lowest = priorityCell('020').style.color;
    expect(critical).not.toBe('');
    expect(lowest).not.toBe('');
    expect(critical).not.toBe(lowest);
    // And the name is in the hover text, because a colour alone is a fact only a
    // reader who already knows the ladder can read.
    expect(priorityCell('010').getAttribute('data-fact') ?? '').toContain('Critical — priority 5');
    expect(priorityCell('020').getAttribute('data-fact') ?? '').toContain('Lowest — priority 90');
  });

  itDom('leaves an unprioritised cell the table’s own ink and offers no band', async () => {
    // The bargain every face makes with an unranked row: nothing at all rather
    // than a grey chip reading `—`.
    await twoRows();

    expect(priorityCell('010').style.color).toBe('');
    expect(priorityCell('010').getAttribute('data-hint') ?? '').toContain(
      'Blank means nobody has said',
    );
  });

  itDom('opens the five bands on a click, and taking one writes the number it says', async () => {
    // Dany's "select priority by labels", as the picker. The line carries the
    // number as well as the name because taking it **stores** that number, and a
    // picker that hid what it was about to write would leave the reader unable to
    // predict the digits that appear in the box.
    const api = await twoRows();
    const patched = watchPatches(api);

    fireEvent.click(priorityCell('010'));
    const list = screen.getByRole('listbox', { name: 'Priority bands for 010' });
    expect([...list.querySelectorAll('[role="option"]')].map((each) => each.textContent)).toEqual([
      'Critical — 10',
      'High — 30',
      'Medium — 50',
      'Low — 70',
      'Lowest — 90',
    ]);

    fireEvent.click(screen.getByText('High'));
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('30');
    });
    // One request and one journal entry, through the same `setPriority` a typed
    // number reaches — which is what makes the two languages round-trip into each
    // other rather than into two histories.
    expect(patched).toEqual([{ priority: 30 }]);
  });

  itDom('does not open the band list merely because the caret landed here', async () => {
    // The one place this departs from `CreatablePicker`, and it is a departure
    // with a mechanical reason as well as a taste one: opening on focus is a
    // `setState` during the focus that lands in this box, so `CellInput`'s inline
    // `ref` runs again, `LiveField.takeNode` re-attaches, and a refusal held for
    // this cell is written back over the draft somebody is part-way through.
    //
    // Proof: the `onClick` moved onto the wrapper's `onFocus`, and three cases in
    // this describe went red — `sends what was typed on Enter` with no request at
    // all, and `sends one request for a priority entered with Enter and then
    // left` holding a previous case's refused `1e999`. Watched 2026-08-14.
    await twoRows();

    fireEvent.focus(priorityCell('010'));

    expect(screen.queryByRole('listbox', { name: 'Priority bands for 010' })).toBeNull();
  });

  itDom('takes a band’s name typed into the box, and stores the number it writes', async () => {
    // The keyboard's way to the same five lines, and the reason the grid needs no
    // chord for the picker: `high` in this box is 30. Case-insensitive and
    // trimmed, because a name typed by hand is not a name copied out of a list.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoPriority('010', '  MEDIUM ');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('50');
    });

    expect(patched).toEqual([{ priority: 50 }]);
    // And it round-trips: the number that was stored resolves back to the band
    // whose name was typed.
    expect(priorityCell('010').getAttribute('data-fact') ?? '').toContain('Medium — priority 50');
  });

  itDom('still refuses a word that is no band’s name, rather than clearing the row', async () => {
    // `Number('urgent')` is `NaN` and `NaN` on the wire is `null`, which is the
    // clear — so a typo would silently unprioritise the row. `priorityTyped`
    // deliberately hands anything it does not recognise straight back to
    // `setPriority`, which has refused it out loud since `priority-column`.
    const api = await twoRows();
    typeIntoPriority('010', '7');
    await waitFor(() => {
      expect(priorityCell('010').value).toBe('7');
    });
    const patched = watchPatches(api);

    typeIntoPriority('010', 'urgent');
    await waitFor(() => {
      expect(screen.getByText(/A priority is a whole number from 1 upward\./)).toBeDefined();
    });
    expect(patched).toEqual([]);

    // As above: the draft is abandoned so this test's refusal does not reach the
    // next one's map.
    typeIntoPriority('010', '');
    await waitFor(() => {
      expect(refusedDraftFor(priorityCellKey('010'))).toBeUndefined();
    });
  });
});

describe('the In-parallel cell', () => {
  /** Two empty root rows, and the api the table is driving. */
  async function twoRows() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    return api;
  }

  /** Every PATCH the table sends, still performed. */
  const watchPatches = (api: ProjectApi): unknown[] =>
    recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

  const parallelCell = (number: string): HTMLInputElement =>
    screen.getByLabelText<HTMLInputElement>(`People at once for ${number}`);

  /** Types into the cell and leaves it, which is when a `CellInput` commits. */
  const typeIntoParallel = (number: string, text: string): void => {
    const cell = parallelCell(number);
    fireEvent.focus(cell);
    fireEvent.change(cell, { target: { value: text } });
    fireEvent.blur(cell);
  };

  itDom('is blank on every row of a plan nobody has widened', async () => {
    // Blank and not `1`, which is what the column stores for every row of every
    // plan: a column of ones down the table is furniture, and the Prio column
    // one place back makes the same bargain for the same reason.
    await twoRows();

    for (const number of ['010', '020']) {
      expect(parallelCell(number).value).toBe('');
    }
  });

  itDom('sends what was typed and shows what came back', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '3');

    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 3 }]);
    });
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });
    // And the row beside it is untouched — one cell's write is one row's.
    expect(parallelCell('020').value).toBe('');
  });

  itDom(
    'resets to one at a time when the cell is emptied, rather than sending a zero',
    async () => {
      // `Number('')` is 0, and a width of 0 is a duration of `Infinity` — the
      // fault `capacity-write-paths` refuses 400 and `capacity-engine` throws on.
      // An emptied box plainly means one at a time, and `null` is how be-01
      // spells that.
      const api = await twoRows();
      const patched = watchPatches(api);

      typeIntoParallel('010', '4');
      await waitFor(() => {
        expect(patched).toEqual([{ maxParallel: 4 }]);
      });

      typeIntoParallel('010', '');
      await waitFor(() => {
        expect(patched).toEqual([{ maxParallel: 4 }, { maxParallel: null }]);
      });
      // Back to blank, because 1 renders as nothing.
      await waitFor(() => {
        expect(parallelCell('010').value).toBe('');
      });
    },
  );

  itDom('sends a number be-01 will refuse rather than deciding for it', async () => {
    // The rule about what a parallelism may be lives at be-01's boundary
    // (`capacity-write-paths`), and a second copy here is a rule free to
    // disagree with it — the Prio cell's own bargain, one column back.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '0');
    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 0 }]);
    });

    typeIntoParallel('010', '1001');
    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 0 }, { maxParallel: 1001 }]);
    });
  });

  /**
   * Two rows over an api that answers every parallelism with one of be-01's
   * own words — the half of "send it and let be-01 answer" that nothing in this
   * file exercised: the test above asserts only that the number was **sent**.
   */
  async function twoRowsRefusing(code: string): Promise<void> {
    const api = fakeApi();
    const perform = api.patchWorkItem.bind(api);
    api.patchWorkItem = (id: string, patch: Record<string, unknown>) =>
      'maxParallel' in patch ? Promise.reject(new Error(code)) : perform(id, patch);
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
  }

  itDom('says what a parallelism may be when be-01 refuses one', async () => {
    // Proof: the `maxParallel_must_be_a_whole_number_from_1` entry struck from
    // `REFUSAL_SENTENCES`, so the grammatical fallback carries the code. This
    // failed on `expected [ 'That change could not be completed
    // (maxParallel_must_be_a_whole_number_from_1).' ] to contain 'People at
    // once is a whole number of 1 or more…'` — the wire code in the corner of
    // the screen, which is the defect `not_found` and `http_500` were fixed for
    // on 2026-08-09 and the sibling size box avoids one screen away. Watched
    // 2026-08-13.
    await twoRowsRefusing('maxParallel_must_be_a_whole_number_from_1');

    typeIntoParallel('010', '0');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'People at once is a whole number of 1 or more. Empty the cell for one at a time.',
      );
    });
  });

  itDom('reads the ceiling out of be-01’s own word for it', async () => {
    // The limit is spelled into the code from be-01's `MOST_PEOPLE_AT_ONCE`, so
    // the sentence is built from what arrived rather than from a second copy of
    // 1000 here — `wbs-api.ts`'s bargain for the size box, for its reason.
    //
    // Proof: the prefix arm deleted. This failed on `expected [ 'That change
    // could not be completed (maxParallel_must_be_at_most_1000).' ] to contain
    // 'People at once is at most 1000.'`. Watched 2026-08-13.
    await twoRowsRefusing('maxParallel_must_be_at_most_1000');

    typeIntoParallel('010', '1001');

    await waitFor(() => {
      expect(toastTexts()).toContain('People at once is at most 1000.');
    });
  });

  itDom('says why a parent’s parallelism was refused, in the tree’s words', async () => {
    // `has_children` is be-01's, and it is only reachable through this cell:
    // the cell is read-only on every parent, so this is the row that gained a
    // child while the draft was open.
    //
    // Proof: the `has_children` entry struck. This failed on `expected [ 'That
    // change could not be completed (has_children).' ] to contain 'A row with
    // work under it…'`. Watched 2026-08-13.
    await twoRowsRefusing('has_children');

    typeIntoParallel('010', '3');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'A row with work under it runs no people of its own — set People at once on the rows beneath it.',
      );
    });
  });

  itDom('refuses a draft JSON cannot carry, rather than silently resetting the row', async () => {
    // `Number('1e999')` is `Infinity`, which `JSON.stringify` writes as `null`
    // — and `null` here is the **reset to one at a time**. A typed `1e999`
    // reaching be-01 would quietly put a widened row back to 1 while looking
    // like a refusal.
    //
    // Proof: the `Number.isFinite` guard deleted, watched failing on `Unable to
    // find an element with the text: /People at once is a whole number from 1
    // to 1000./` — nothing refused, and the `expect(patched).toEqual([])` below
    // it is what says where the draft went instead. Watched 2026-08-13.
    const api = await twoRows();
    const patched = watchPatches(api);

    typeIntoParallel('010', '1e999');

    await waitFor(() => {
      expect(screen.getByText(/People at once is a whole number from 1 to 1000\./)).toBeDefined();
    });
    expect(patched).toEqual([]);

    // Abandoning the draft keeps this test's refusal out of the next one's map.
    typeIntoParallel('010', '');
  });

  itDom('sends on Enter, without waiting for the cell to be left', async () => {
    const api = await twoRows();
    const patched = watchPatches(api);

    const cell = parallelCell('010');
    cell.focus();
    fireEvent.change(cell, { target: { value: '2' } });
    fireEvent.keyDown(cell, { key: 'Enter' });

    await waitFor(() => {
      expect(patched).toEqual([{ maxParallel: 2 }]);
    });
    expect(document.activeElement).toBe(parallelCell('010'));
  });

  itDom('is printed and not editable on a row with children', async () => {
    // A parent holds no slices of its own, so `slicesOf` skips it and a number
    // on it schedules nothing — be-01 answers 400 `has_children`. The cell is
    // read-only rather than offering an edit that is refused, and it still
    // shows the inert number a leaf was given before it gained a child, which
    // is the state `capacity-write-paths` deliberately leaves standing.
    await twoRows();
    typeIntoParallel('010', '3');
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });

    // 020 goes under 010, which makes 010 a parent.
    pressTab('020');
    await waitFor(() => {
      expect(screen.queryByLabelText('Name of 010.1')).not.toBeNull();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('People at once for 010')).toBeNull();
    });
    const printed = facted(/holds no work of its own/);
    expect(printed.textContent).toBe('3');
  });

  itDom('says a number is not applied where one person is named on the work', async () => {
    // C1's D3: one human cannot work beside themselves, so a named assignee
    // collapses the item to width 1 whatever the column says. The number is
    // still stored and applies the moment the assignment goes, so it is shown
    // and qualified rather than hidden.
    await twoRows();
    typeIntoParallel('010', '3');
    await waitFor(() => {
      expect(parallelCell('010').value).toBe('3');
    });
    expect(parallelCell('010').getAttribute('data-fact') ?? '').toContain('effort is compressed');

    // The assignee box lives in the unfolded step, which is where somebody
    // names a person on the work.
    unfoldStep('Dev');
    const picker = await screen.findByLabelText('Dev assignee for 010');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Kat' } });
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(parallelCell('010').getAttribute('data-fact') ?? '').toContain(
        'one at a time whatever this says',
      );
    });
    // Still 3 on screen: it is what is stored, and it is what comes back the
    // day the assignment goes.
    expect(parallelCell('010').value).toBe('3');
  });

  itDom(
    'says a number is not applied where two different people are named on two different steps',
    async () => {
      // be-01's `widthFor` collapses **per slice**: a step with its own named
      // assignee runs at width 1 on that slice alone. Two steps, two different
      // people, is two slices each individually collapsed — `doesEveryStep`
      // is `null` here (it only fires for exactly one named step project-wide
      // on the row), so the row-level reading this cell used to lean on cannot
      // see it, and a `3` sits there doing nothing while looking editable.
      const api = await twoRows();
      const [row] = api.rows;
      const trio = { optimistic: 1, realistic: 2, pessimistic: 3 };
      row.estimates = { [DEV.id]: trio, [QA.id]: trio };

      typeIntoParallel('010', '3');
      await waitFor(() => {
        expect(parallelCell('010').value).toBe('3');
      });
      expect(parallelCell('010').getAttribute('data-fact') ?? '').toContain('effort is compressed');

      unfoldStep('Dev');
      const dev = await screen.findByLabelText('Dev assignee for 010');
      fireEvent.focus(dev);
      fireEvent.change(dev, { target: { value: 'Ada' } });
      fireEvent.keyDown(dev, { key: 'Enter' });
      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('Dev assignee for 010').value).toBe('Ada');
      });

      unfoldStep('QA');
      const qa = await screen.findByLabelText('QA assignee for 010');
      fireEvent.focus(qa);
      fireEvent.change(qa, { target: { value: 'Bo' } });
      fireEvent.keyDown(qa, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('QA assignee for 010').value).toBe('Bo');
      });

      // Proof: `everySliceNamed` reverted to `doesEveryStep !== null` alone,
      // this failed on `expected '3 people at once…' to contain 'one at a
      // time whatever this says'` — un-muted with both steps individually
      // named and neither slice free to run more than one at once. Watched
      // 2026-08-14.
      await waitFor(() => {
        expect(parallelCell('010').getAttribute('data-fact') ?? '').toContain(
          'one at a time whatever this says',
        );
      });
      expect(parallelCell('010').value).toBe('3');
    },
  );
});

describe('the earliest-start cell', () => {
  /** One empty root row on a plan that is on a calendar, so the cell will open. */
  async function datedPlan() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    click('Add work item');
    await screen.findByLabelText('Name of 020');
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });
    return api;
  }

  /** Every date editor on the page, which is what "one at a time" is counted from. */
  const editorsOnScreen = () => [...document.querySelectorAll('input[type="date"][data-cell]')];

  itDom('is the short date as text, with no editor in it', async () => {
    // 146px of column was a native date input on every row. The cell is the
    // day now, and the editor is mounted only for the cell being edited —
    // which is the whole of how the column fits in 84px.
    // Proof: the `editing` branch inverted so the editor is what is rendered at
    // rest, this failed on `expected '2026-06-01' to be '1 Jun'` — the cell
    // holding a native date input again. **Nineteen** tests failed in that run:
    // `reads as an em-dash where the row sets no day` on `expected '' to be
    // '—'`, `mounts one editor at a time` on `expected 2 to be 1`, and the Tab
    // and arrow walks all over the table. Watched, 2026-08-09.
    const api = await datedPlan();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.startNoEarlierThan = '2026-06-01';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe('1 Jun');
    });

    expect(editorsOnScreen()).toEqual([]);
    // And the whole day is a hover away, the same bargain Start and End make.
    expect(
      screen.getByLabelText('Earliest start for 010').getAttribute('data-fact') ?? '',
    ).toContain('2026-06-01');
  });

  itDom('reads as an em-dash where the row sets no day', async () => {
    await datedPlan();

    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe('—');
  });

  itDom('mounts one editor at a time, on the cell that asked for it', async () => {
    // Two rows, two cells, one editor: opening the second closes the first,
    // because a column this narrow can hold exactly one 138px box and only
    // by hanging it over its neighbours.
    await datedPlan();

    openNotBefore('010');
    expect(editorsOnScreen().length).toBe(1);

    openNotBefore('020');

    expect(editorsOnScreen().length).toBe(1);
    expect(editorsOnScreen()[0]?.getAttribute('data-not-before')).toBe(
      screen.getByLabelText('Name of 020').getAttribute('data-cell')?.split('::')[0],
    );
  });

  itDom('offers no editor at all while the plan has no start date', async () => {
    // Without a project start date there is no day zero to count from and
    // be-01 ignores the constraint entirely, so the cell is a rendered
    // disabled state that says why — not an editor that opens onto nothing.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
    expect(cell.disabled).toBe(true);
    expect(cell.getAttribute('data-fact') ?? '').toContain('project start date');

    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.mouseDown(cell);

    expect(editorsOnScreen()).toEqual([]);
  });

  itDom('gives the focus back to the cell on every way out', async () => {
    // A keyboard is where it was rather than at the top of the page. Asserted
    // per exit route, because the three take three different paths out of the
    // editor and only one of them sends anything.
    // Proof: the focus-return effect's `focusCellAt` removed, this failed on
    // `expected <body /> to be <input …>` for the Enter route, and the Escape
    // and blur routes with it. Watched, 2026-08-09.
    await datedPlan();

    for (const leave of [
      (box: HTMLInputElement) => fireEvent.keyDown(box, { key: 'Enter' }),
      (box: HTMLInputElement) => fireEvent.keyDown(box, { key: 'Escape' }),
      (box: HTMLInputElement) => fireEvent.blur(box),
    ]) {
      const editor = openNotBefore('010');
      expect(document.activeElement).toBe(editor);

      leave(editor);

      expect(editorsOnScreen()).toEqual([]);
      expect(document.activeElement).toBe(screen.getByLabelText('Earliest start for 010'));
      // And the cell it came back to is still a cell of the keyboard grid, on
      // the terms it always had: Tab is the table's from here.
      expect(screen.getByLabelText('Earliest start for 010').dataset['cell']).toContain(
        '::not-before',
      );
    }
  });

  itDom('leaves the Tab handling exactly where it was', async () => {
    // The cell is text now and it is still a cell: Tab from the step before
    // it lands here, and Tab from here goes on to the next row.
    await datedPlan();

    const cell = screen.getByLabelText<HTMLInputElement>('Earliest start for 010');
    cell.focus();

    expect(fireEvent.keyDown(cell, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
  });

  itDom('never writes a peer’s day over one being typed', async () => {
    // The grid's refused-draft rule, in the one cell that had no draft to hold
    // until now: a refetch that lands while a day is half-typed leaves the box
    // alone, exactly as it does for a half-typed name.
    // A whole day rather than a truncated one, because a date input refuses to
    // hold a value it cannot parse — `value` reads back `''` — and the box
    // would then be empty for a reason that has nothing to do with the guard.
    // Proof: `DateField`'s `document.activeElement` guard removed from its
    // effect, this failed on `expected '2026-09-09' to be '2026-08-17'`.
    // Watched, 2026-08-09.
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
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').disabled).toBe(
        false,
      );
    });

    const editor = openNotBefore('010');
    editor.focus();
    fireEvent.change(editor, { target: { value: '2026-08-17' } });

    const peer = api.rows.at(0);
    if (peer === undefined) throw new Error('the plan has no row');
    peer.startNoEarlierThan = '2026-09-09';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 010').value).toBe(
      '2026-08-17',
    );
  });
});

describe('the work item deadline cell', () => {
  /**
   * One root row on a dated plan with every column shown.
   *
   * `showEveryColumn` because the deadline column is in
   * `INITIAL_HIDDEN_COLUMNS` — it costs 84px the folded budget at 1280 does not
   * have, so a reader turns it on in `Columns`. These tests are about the cell,
   * not about the default column set; `table-frame.test.ts` owns that.
   */
  async function datedPlanWithDeadlineColumn() {
    showEveryColumn();
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    typeIntoDate('Project start date', '2026-08-06');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').disabled).toBe(
        false,
      );
    });
    return api;
  }

  /**
   * The accessible name of the impossible-deadline mark on row 010 — named once
   * so a reworded affordance cannot leave a stale string asserting nothing.
   */
  const IMPOSSIBLE_MARK = "Work item deadline for 010 falls before the project's first working day";

  /** Opens one row's deadline editor the way a reader does — Enter on the cell. */
  const openDeadline = (number: string): HTMLInputElement => {
    fireEvent.keyDown(screen.getByLabelText<HTMLInputElement>(`Work item deadline for ${number}`), {
      key: 'Enter',
    });
    return screen.getByLabelText<HTMLInputElement>(`Work item deadline for ${number}`);
  };

  itDom('labels the column Deadline while the editable cell keeps the deadline id', async () => {
    await datedPlanWithDeadlineColumn();

    // Proof: with the shipped `Due` header this failed at this query after 101/102 cases passed.
    expect(screen.getByRole('columnheader', { name: /^Deadline/ })).toBeVisible();
    expect(screen.getByLabelText('Work item deadline for 010')).toHaveAttribute(
      'data-cell',
      expect.stringMatching(/::deadline$/),
    );
  });

  itDom('is the short date as text at rest, and an em-dash where nobody has said', async () => {
    const api = await datedPlanWithDeadlineColumn();

    expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe('—');

    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-09-30';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '30 Sep',
      );
    });
    // The whole day is a hover away, the same bargain Not before, Start and End
    // make in 84px and 52px.
    expect(
      screen.getByLabelText('Work item deadline for 010').getAttribute('data-fact') ?? '',
    ).toContain('2026-09-30');
  });

  itDom('sends the day as the one field, with no reason beside it', async () => {
    // **The pair rule is not carried across.** The floor one column over sends
    // `startNoEarlierThan` and `startNoEarlierThanReason` together because
    // be-01 refuses a reason with no date; a deadline has no reason column
    // (`work-item-deadline` 1.1), so a request naming one here would be a key
    // about a different constraint — and the `refuseDerivedFields` /
    // `parsePatch` pair on be-01 answers an unknown-shaped patch, not a helpful
    // one. Asserted as the whole patch and not with `toMatchObject`, which is
    // what makes it a negative control.
    const api = await datedPlanWithDeadlineColumn();
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    const editor = openDeadline('010');
    fireEvent.change(editor, { target: { value: '2026-09-30' } });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(patched).toEqual([{ deadline: '2026-09-30' }]);
    });
  });

  itDom('clears with the single field, never the floor cell pair', async () => {
    // Proof this matters: `setNotBefore`'s null arm sends two fields, and a
    // deadline cell copied from it verbatim would send
    // `startNoEarlierThanReason: null` here — quietly taking the words off the
    // row's not-before every time somebody cleared its deadline.
    //
    // Proof, as R5 asks and not only as a reason: that exact fault injected
    // into `use-plan-fields.ts`'s `setDeadline` — `{ deadline: day }` changed to
    // `{ deadline: day, startNoEarlierThanReason: null }` — and this case
    // failed, 2 of 99, with the diff naming the extra key verbatim: expected
    // `[{ "deadline": null }]`, received the same object plus
    // `+ "startNoEarlierThanReason": null`. Watched again after the writer
    // moved into `use-plan-fields.ts`, 1 failed of 1 filtered case, 2026-09-07.
    // `toEqual` on the whole patch is the assertion and `toMatchObject` would
    // not have been: the extra key is exactly what a subset match would have
    // let through.
    const api = await datedPlanWithDeadlineColumn();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-09-30';
    row.startNoEarlierThan = '2026-08-10';
    row.startNoEarlierThanReason = 'the parts arrive then';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '30 Sep',
      );
    });
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    const editor = openDeadline('010');
    // A date input reports '' when it is cleared, which is "no deadline".
    fireEvent.change(editor, { target: { value: '' } });
    fireEvent.blur(editor);

    await waitFor(() => {
      expect(patched).toEqual([{ deadline: null }]);
    });
    expect(row.startNoEarlierThanReason).toBe('the parts arrive then');
  });

  itDom('says so when the project start has moved past a stored deadline', async () => {
    // `work-item-deadline` §2.3: a project whose start date is edited past a
    // stored deadline is **not** retro-rejected — the date the reader typed
    // stays, and be-01 keeps reporting the row late by the whole span. What was
    // missing is that the cell they typed it into said nothing: 9.2's
    // `Late by N workdays` is on the bar and answers "how late", while the
    // question here is "why is this date impossible", and the answer — the
    // project now starts after it — is only visible on the cell.
    //
    // The predicate is `deadlineOffsetOf`, the same function be-01's write
    // boundary calls. That is the opposite of 9.2's guarded mistake: `lateBy`
    // is *how late* and stays be-01's alone, while *whether a stored date falls
    // before day zero* is a different question with one shared implementation.
    const api = await datedPlanWithDeadlineColumn();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-08-10';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '10 Aug',
      );
    });
    // The negative control, and the half that makes the assertion below mean
    // something: a deadline at or after day zero is an ordinary date and the
    // cell marks nothing.
    expect(screen.queryByLabelText(IMPOSSIBLE_MARK)).toBeNull();

    typeIntoDate('Project start date', '2026-09-01');

    await screen.findByLabelText(IMPOSSIBLE_MARK);
    // Not silently dropped: the stored date is still the cell's reading, which
    // is what stops the affordance from being mistaken for a cleared field.
    expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
      '10 Aug',
    );
    expect(
      screen.getByLabelText('Work item deadline for 010').getAttribute('data-fact') ?? '',
    ).toContain("falls before the project's first working day");
  });

  itDom('says the true thing when the two dates a reader can see are equal', async () => {
    // **The trap this case exists for**, found by round 1's OpenAI seat: the
    // predicate is about workdays, not about raw calendar order, and the two
    // part company exactly here. A project starting Saturday 2026-08-08 with a
    // deadline of that same Saturday is impossible — day zero rolls forward to
    // Monday the 10th, the deadline rolls back to Friday the 7th — while the
    // dates on screen are the *same day*. Any wording about "before the project
    // starts" would be a cell contradicting what it is showing, so the sentence
    // and the mark both name the project's **first working day** instead.
    const api = await datedPlanWithDeadlineColumn();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-08-08';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '8 Aug',
      );
    });

    typeIntoDate('Project start date', '2026-08-08');

    await screen.findByLabelText(IMPOSSIBLE_MARK);
    // Both dates read 8 Aug, and nothing the cell says claims otherwise.
    const fact =
      screen.getByLabelText('Work item deadline for 010').getAttribute('data-fact') ?? '';
    expect(fact).toContain("falls before the project's first working day");
    expect(fact).not.toContain('before the project starts');
  });

  /**
   * Puts row 010's deadline at 2026-08-10 and then moves the project start past
   * it, which is the one state the three cases below are about. Returns the
   * grid cell — the `<input>` carrying `data-cell`, the thing keyboard focus
   * actually lands on — rather than the mark beside it.
   */
  async function impossibleDeadlineCell(): Promise<HTMLInputElement> {
    const api = await datedPlanWithDeadlineColumn();
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-08-10';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '10 Aug',
      );
    });
    typeIntoDate('Project start date', '2026-09-01');
    await screen.findByLabelText(IMPOSSIBLE_MARK);
    return screen.getByLabelText<HTMLInputElement>('Work item deadline for 010');
  }

  itDom('describes the focused cell with the mark beside it, not only the row', async () => {
    // **The defect this case exists for**, from TASK-296's review of the
    // shipped diff: the mark is a *sibling* of the cell. Reading the row in
    // browse mode announces it, but the accessible name and description of the
    // cell keyboard focus lands on are computed from that cell alone — so a
    // reader tabbing the editable grid heard `Work item deadline for 010` and
    // the date, and nothing at all about the date being unmeetable. The
    // relationship has to be stated; being adjacent in the DOM is not one.
    const cell = await impossibleDeadlineCell();

    const describedBy = cell.getAttribute('aria-describedby');
    if (describedBy === null) throw new Error('the impossible cell describes itself with nothing');
    // Resolved, not merely present: an `aria-describedby` naming an id that is
    // not in the document is announced as nothing, which is the bug wearing an
    // attribute. `toBe` against the node, so a second element that happened to
    // carry the same words could not satisfy this.
    expect(document.getElementById(describedBy)).toBe(screen.getByLabelText(IMPOSSIBLE_MARK));
    // And the description that id resolves to is the sentence, not the glyph:
    // the mark's own text is `!`, so its accessible name is what carries the
    // meaning and `aria-describedby` is computed from the same name.
    expect(screen.getByLabelText(IMPOSSIBLE_MARK).getAttribute('aria-label')).toBe(IMPOSSIBLE_MARK);
    expect(cell.getAttribute('aria-invalid')).toBe('true');
  });

  itDom('leaves the mark out of the keyboard grid while it describes the cell', async () => {
    // The other half of the fix, and the reason it is asserted rather than
    // assumed: `editableGrid` collects `[data-cell]` descendants, so the
    // cheapest way to relate the mark to the cell — making the mark a cell —
    // would put a stop between Due and Start that a reader cannot type into.
    // `aria-describedby` relates them with no new stop, and this case fails if
    // anyone later reaches for the cheap version.
    await impossibleDeadlineCell();
    const mark = screen.getByLabelText(IMPOSSIBLE_MARK);

    expect(mark.hasAttribute('data-cell')).toBe(false);
    expect(mark.hasAttribute('tabindex')).toBe(false);
    // Out of flow and not a target: the click that opens the editor belongs to
    // the input underneath it.
    expect(mark.style.pointerEvents).toBe('none');
    // Still readable — an `aria-hidden` mark would satisfy every line above and
    // describe nothing, which is the failure mode this line closes.
    expect(mark.hasAttribute('aria-hidden')).toBe(false);
  });

  itDom('leaves an ordinary and an empty deadline cell with no invalid state', async () => {
    // The negative control for both attributes. A cell that always said
    // `aria-invalid` would pass the first case above and be a lie on every
    // other row, and a dangling `aria-describedby` is worse than none.
    const api = await datedPlanWithDeadlineColumn();

    const empty = screen.getByLabelText<HTMLInputElement>('Work item deadline for 010');
    expect(empty.value).toBe('—');
    expect(empty.hasAttribute('aria-invalid')).toBe(false);
    expect(empty.hasAttribute('aria-describedby')).toBe(false);

    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-09-30';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '30 Sep',
      );
    });

    const dated = screen.getByLabelText('Work item deadline for 010');
    expect(dated.hasAttribute('aria-invalid')).toBe(false);
    expect(dated.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByLabelText(IMPOSSIBLE_MARK)).toBeNull();
  });

  itDom('still describes the cell once it is opened to be fixed', async () => {
    // **The defect this case exists for**, from the peer review TASK-308
    // shipped without: the three cases above assert against the input *at
    // rest*, and none of them opens the editor. The editor is a different
    // element — `DateField` replaces the at-rest input — and it carried
    // neither attribute, while the mark itself lived inside the non-editing
    // branch and so was not rendered at all. So the invalid state and its
    // reason both disappeared at exactly the moment the reader had opened the
    // cell in order to act on them.
    //
    // The mobile card had already answered this on its own face:
    // `plan-cards.tsx` puts the sentence inside the open sheet because
    // "`aria-describedby` on the trigger is announced on the way in rather
    // than while the date box has focus". Same requirement, different
    // mechanism — the table's editor replaces the cell in place, so what it
    // needs is for the description to survive the swap.
    await impossibleDeadlineCell();

    const editor = openDeadline('010');
    // The editor and not the at-rest input, asserted rather than assumed:
    // `DateField` is the only one of the two that is `type="date"`, so this
    // line is what stops the whole case from passing against the element the
    // three above already cover.
    expect(editor.type).toBe('date');

    const describedBy = editor.getAttribute('aria-describedby');
    if (describedBy === null) throw new Error('the open editor describes itself with nothing');
    // Resolved to the node, not merely present — the same bar the at-rest case
    // holds, and the one that matters most here: the mark used to be inside
    // the branch this editor replaced, so an `aria-describedby` copied onto
    // the editor without moving the mark would dangle and be announced as
    // nothing.
    expect(document.getElementById(describedBy)).toBe(screen.getByLabelText(IMPOSSIBLE_MARK));
    // And it resolves to the *reason*, not to a bare invalid state: the
    // description a reader hears is the mark's accessible name, which is the
    // whole sentence about the project's first working day.
    expect(document.getElementById(describedBy)?.getAttribute('aria-label')).toBe(IMPOSSIBLE_MARK);
    expect(editor.getAttribute('aria-invalid')).toBe('true');
  });

  itDom('opens an ordinary and an empty deadline cell with no invalid state', async () => {
    // The negative control for the case above, and it is a different one from
    // the at-rest negative control: hoisting the mark out of the ternary makes
    // it easy to render the attributes unconditionally on the editor, which
    // would pass every line of that case and be a lie on every other row. This
    // is what keeps the fix a *state* rather than a constant.
    const api = await datedPlanWithDeadlineColumn();

    const empty = openDeadline('010');
    expect(empty.type).toBe('date');
    expect(empty.hasAttribute('aria-invalid')).toBe(false);
    expect(empty.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.keyDown(empty, { key: 'Escape' });

    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-09-30';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').value).toBe(
        '30 Sep',
      );
    });

    const dated = openDeadline('010');
    expect(dated.type).toBe('date');
    expect(dated.hasAttribute('aria-invalid')).toBe(false);
    expect(dated.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByLabelText(IMPOSSIBLE_MARK)).toBeNull();
  });

  itDom('marks nothing on a project with no start date', async () => {
    // With no day zero there is nothing for a date to fall before — the same
    // reasoning be-01's service applies, and the reason the disabled cell below
    // is the whole of this state rather than a disabled cell wearing a warning.
    showEveryColumn();
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    const row = api.rows.at(0);
    if (row === undefined) throw new Error('the plan has no row');
    row.deadline = '2026-08-10';
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Work item deadline for 010').disabled).toBe(
        true,
      );
    });

    expect(screen.queryByLabelText(IMPOSSIBLE_MARK)).toBeNull();
  });

  itDom('will not open on a project with no start date', async () => {
    // No day zero to resolve a deadline against, so be-01 applies none of them —
    // the same state the floor renders disabled rather than opening an editor
    // onto nothing.
    showEveryColumn();
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    const patched = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    const cell = screen.getByLabelText<HTMLInputElement>('Work item deadline for 010');
    expect(cell.disabled).toBe(true);
    fireEvent.keyDown(cell, { key: 'Enter' });

    expect(document.querySelectorAll('input[type="date"][data-cell]')).toHaveLength(0);
    expect(patched).toEqual([]);
  });
});

describe('names wrap and notes carry markdown', () => {
  /**
   * The wrapper the marker and the preview live on — the Name `<td>`'s only
   * child, and not the box's nearest span: since `markdown-work-item-names` the
   * textarea sits inside a positioned wrapper of its own, so the rendered
   * reading of the name can be laid over it (`cell-input.tsx`).
   */
  const nameCellOf = (number: string): HTMLElement => {
    const found = screen.getByLabelText(`Name of ${number}`).closest('td')?.firstElementChild;
    if (!(found instanceof HTMLElement)) throw new Error(`name cell for ${number} has no wrapper`);
    return found;
  };

  /** The rendered reading of a Name cell — the box a reader sees while nobody is typing. */
  const renderedNameOf = (number: string): HTMLElement => {
    const box = nameCellOf(number).querySelector('[data-cell-rendered]');
    if (!(box instanceof HTMLElement)) throw new Error(`no rendered name for ${number}`);
    return box;
  };

  /** One row, named `typed` and saved. */
  async function oneRowNamed(typed: string): Promise<HTMLTextAreaElement> {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: typed } });
    cell.blur();
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe(typed);
    });
    return cell;
  }

  /** The one thing on a Name cell that opens its preview. */
  const notesMarkerOf = (number: string): HTMLElement =>
    screen.getByLabelText(`Notes on ${number}`);

  /**
   * One row whose Name cell holds a name and, under it, these notes.
   *
   * Typed as one text through the one box, because that is the only way to
   * write a note now: the Notes column is gone and its content lives under the
   * first line of the name.
   */
  async function oneRowWithNotes(notes: string) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');
    fireEvent.change(cell, { target: { value: `Strip\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe(notes);
    });
    // Both fields, from one box and one request: the name is what was on the
    // first line and nothing else.
    expect(api.rows[0]?.name).toBe('Strip');
    return api;
  }

  /**
   * jsdom does no layout, so `scrollHeight` is 0 for everything. Faking it is
   * what makes the auto-sizing testable at all: the component reads it, and
   * this is the only place its value can come from here.
   */
  const withScrollHeight = (node: HTMLElement, height: number) => {
    Object.defineProperty(node, 'scrollHeight', { value: height, configurable: true });
  };

  /**
   * Proof for the whole of 2.1: `renderFirstLine` taken off the Name column, so
   * the cell is the raw string it was before `markdown-work-item-names`.
   * Watched failing, 2026-08-29, on `Error: no rendered name for 010` in all
   * three of `emphasis in a name is rendered`, `a heading marker in a name is
   * shown, not eaten` and `editing a name shows its source`.
   */
  itDom('emphasis in a name is rendered', async () => {
    const cell = await oneRowNamed('Ship *now*');

    const rendered = renderedNameOf('010');
    expect(rendered.querySelector('em')?.textContent).toBe('now');
    expect(rendered.textContent).toBe('Ship now');
    // The box under it is untouched: it still holds the source, which is what
    // somebody clicking into the cell gets back.
    expect(cell.value).toBe('Ship *now*');
  });

  itDom('a heading marker in a name is shown, not eaten', async () => {
    await oneRowNamed('# not a heading');

    const rendered = renderedNameOf('010');
    expect(rendered.textContent).toBe('# not a heading');
    expect(rendered.querySelector('h1')).toBeNull();
  });

  itDom('editing a name shows its source', async () => {
    const cell = await oneRowNamed('Ship *now*');

    // The swap itself is two `styles.css` rules — the box's ink goes
    // transparent at rest and the rendered box goes away on focus — and jsdom
    // applies no stylesheet, so what is asserted here is the hook they hang
    // off and what each box holds. `e2e/name-markdown.spec.ts` is where the
    // swap is watched.
    expect(cell).toHaveAttribute('data-rendered-at-rest');
    cell.focus();
    expect(document.activeElement).toBe(cell);
    expect(cell.value).toBe('Ship *now*');

    // And the rendered box is furniture, not a control: no name of its own for
    // a screen reader that already has the box, and no tab stop in the grid.
    const rendered = renderedNameOf('010');
    expect(rendered.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.querySelector('[tabindex], a, button')).toBeNull();
  });

  itDom('grows the name box to fit a long name, focus or no focus', async () => {
    // Dany, 2026-08-06: the name "must wrap instead of cutting text". A
    // one-row textarea wraps and then hides everything past the first line,
    // which is the same crop with extra steps.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 60);
    fireEvent.change(name, { target: { value: 'a name long enough to need three lines' } });
    // `name.blur()`, not `fireEvent.blur`: the latter dispatches the event
    // without moving `document.activeElement`, so the component would still
    // read the cell as focused and this test would prove nothing.
    name.blur();

    // Sized from its own content while nobody is in it — the whole point.
    expect(name.style.height).toBe('60px');
    expect(document.activeElement).not.toBe(name);
  });

  itDom('clips the notes at rest and opens the box to write in', async () => {
    // The two halves of the at-rest clamp jsdom can see. The height itself it
    // cannot — `scrollHeight` is 0 here and this test stubs it — so what the
    // box is *as tall as* is proven in `e2e/name-cell.spec.ts` and nowhere
    // else. What is proven here is that the notes are clipped rather than
    // scrollable, which is the difference between hiding them and putting
    // them one wheel-turn away, and that no `maxRestRows` cap binds this cell
    // any more: a name is shown whole however long it is.
    //
    // Proof: `restShowsFirstLineOnly` taken off the Name column — `expected
    // 'auto' to be 'hidden'`; and the cap left on with it — `expected '5.6em'
    // to be 'none'`. Watched, 2026-08-09.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 400);
    fireEvent.change(name, { target: { value: 'Strip\nmeasure twice\nthe fuse box is old' } });
    // `name.blur()`, not `fireEvent.blur`: the latter leaves
    // `document.activeElement` where it was, so the component would still read
    // the cell as focused.
    name.blur();

    expect(name.style.overflowY).toBe('hidden');
    expect(name.style.maxHeight).toBe('none');

    name.focus();

    expect(name.style.overflowY).toBe('auto');
    expect(name.style.maxHeight).toBe('none');
  });

  itDom('gives the name a box that wraps rather than one that scrolls', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010').catch(() => undefined);
    click('Add work item');

    const name = await screen.findByLabelText('Name of 010');

    // A textarea is the wrapping half of this; an input scrolls a long name
    // out of sight one character at a time.
    expect(name.tagName).toBe('TEXTAREA');
  });

  itDom('makes room for a note while it is being written in', async () => {
    // What the deleted Notes column's own `grows while it is being written in,
    // and shrinks after` used to say, asked of the box the note is written in
    // now. In the cell the box follows the text; the clamp is the other half
    // of this and only a browser can measure it.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    name.focus();
    withScrollHeight(name, 20);
    fireEvent.change(name, { target: { value: 'Strip' } });
    expect(name.style.height).toBe('20px');

    withScrollHeight(name, 80);
    fireEvent.change(name, { target: { value: 'Strip\n\n## Risks\n\n- the fuse box is old' } });

    expect(name.style.height).toBe('80px');
  });

  itDom('still holds the whole text in the box it shows one line of', async () => {
    // The clamp changes the box's height and nothing else. It measures the
    // first line by holding only the first line for the length of one
    // `scrollHeight` read, and what everything after that read sees — the
    // blur that follows it, `LiveField`'s diff against its baseline, the next
    // person to click into the cell — has to be the whole composed text
    // again. A clamp that forgot to put it back would send the name over the
    // notes and delete them, from a focus and a blur with nothing typed.
    //
    // Proof: the restore dropped from `resize` — the swapped-in first line
    // left in the box. It failed one line sooner than it was written for, on
    // `expected '' to be 'measure twice'` at the wait below: the blur that
    // sets this test up read the truncated box and deleted the note on the
    // way past. Watched, 2026-08-09.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    withScrollHeight(name, 60);
    fireEvent.change(name, { target: { value: 'Strip\nmeasure twice' } });
    name.blur();
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe('measure twice');
    });

    const patched = recordCalls(api, 'patchWorkItem');

    // A look, not an edit: in and straight out again.
    name.focus();
    name.blur();

    expect(name.value).toBe('Strip\nmeasure twice');
    expect(patched).toEqual([]);
  });

  itDom('renders the markdown on hover over the notes marker', async () => {
    await oneRowWithNotes('## Risks\n\n- the fuse box is *old*');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    // Rendered, not printed: a heading is an element and the emphasis is one
    // too, which is the whole difference between this and the cell beneath it.
    expect(preview.querySelector('h2')?.textContent).toBe('Risks');
    expect(preview.querySelector('li em')?.textContent).toBe('old');
    // The row's own name at the head of it, which is the wiring `hover-preview.test.tsx`
    // cannot see: this column composes the cell's text and holds the two
    // fields apart again for the preview.
    // Proof: the column passing `name=""` — `expected '' to be 'Strip'`.
    // Watched, 2026-08-09.
    expect(preview.querySelector('h1')?.textContent).toBe('Strip');
  });

  itDom('lifts the hovered row above the pinned cells the preview opens over', async () => {
    // The one thing about this preview that no amount of correct CSS on the
    // preview itself could fix, and that only a browser found: the Name cell
    // is pinned, a pinned cell is `position: sticky` **with a z-index**, and
    // that makes it a stacking context — so the preview inside it is trapped
    // there and the next row's pinned Name cell paints straight over it.
    // Proof: observed on h2puni before this existed, with `opensAPopover` and
    // every other rule already right — `opens the notes preview out past the
    // bottom of the name cell` failed on `4px below the name cell is
    // <textarea> in the name column, not the preview`. 2026-08-08.
    await oneRowWithNotes('## Risks');

    const cell = (): HTMLElement => {
      const found = nameCellOf('010').closest('td');
      if (found === null) throw new Error('the name cell is not in a cell');
      return found;
    };
    // At rest it is an ordinary pinned cell, or the lift below would be a
    // rule that was always on and could not be seen to do anything.
    expect(cell().style.zIndex).toBe('1');

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');

    expect(Number(cell().style.zIndex)).toBe(POPOVER_ROW_LAYER);
    fireEvent.mouseLeave(notesMarkerOf('010'));
    expect(cell().style.zIndex).toBe('1');
  });

  itDom('renders a script in a note as the text somebody typed', async () => {
    // Notes are written by one person and read by everyone else on the
    // project. react-markdown is used without rehype-raw precisely so this
    // cannot become markup — watched here rather than asserted in a comment.
    await oneRowWithNotes('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('alert(1)');
  });

  itDom('marks a row that has notes, and only one that has', async () => {
    // The marker is the whole trigger now, so a row wearing one it should not
    // have is a row whose preview opens holding nothing, and a row missing one
    // is a row whose notes cannot be read at all.
    //
    // Proof: the `notes.trim() !== ''` condition on the marker replaced by
    // `true`, this failed on `expected
    // <span aria-label="Notes on 020" …/> to be null`. Watched, 2026-08-09.
    const api = await oneRowWithNotes('## Risks');
    click('Add work item');
    const bare = await screen.findByLabelText('Name of 020');
    fireEvent.change(bare, { target: { value: 'Sand' } });
    fireEvent.blur(bare);
    await waitFor(() => {
      expect(api.rows[1]?.name).toBe('Sand');
    });

    const marker = screen.getByLabelText('Notes on 010');
    expect(marker).toBeDefined();
    // Ink, not furniture: 11px muted was invisible at arm's length. Inline
    // sizes are the production mechanism, so jsdom can hold this one.
    // Proof: the size put back to 11, this failed on `expected '11px' to be
    // '15px'`. Watched, 2026-08-09.
    expect(marker.style.fontSize).toBe('15px');
    expect(marker.style.color).toBe('var(--foreground)');
    expect(screen.queryByLabelText('Notes on 020')).toBeNull();

    // A glyph this visible reads as clickable; the click lands the caret in
    // the name rather than dying on furniture.
    fireEvent.mouseDown(marker);
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
  });

  itDom('shows no popover over a row with no notes', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const name = await screen.findByLabelText('Name of 010');
    // A named row with no note: the hover has a cell and a name to find, and
    // still nothing to render. Hovering an empty row would pass this test
    // against a preview that simply never opened.
    fireEvent.change(name, { target: { value: 'Strip' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });

    fireEvent.mouseEnter(nameCellOf('010'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  itDom('opens nothing from the cell the notes are typed in', async () => {
    // Dany, 2026-08-09: a rendered document over the rows below on every pass
    // of the mouse is too disruptive. The Name column is the widest thing on
    // the way to anywhere in this table, so the preview waits behind its
    // marker — while the folded step cell and the depends cell, which are a
    // few lines over a narrow cell, keep the whole cell as their trigger.
    //
    // Proof: the handlers put back on the cell wrapper, this failed on
    // `expected <div role="tooltip" …/> to be null`. Watched, 2026-08-09.
    await oneRowWithNotes('## Risks');

    fireEvent.mouseEnter(nameCellOf('010'));

    expect(screen.queryByRole('tooltip')).toBeNull();

    // And the marker beside it does open one, or the assertion above would
    // hold for a preview that had simply been deleted.
    fireEvent.mouseEnter(notesMarkerOf('010'));
    expect(await screen.findByRole('tooltip')).toBeDefined();
  });

  itDom('leaves one card open when the pointer walks from row to row', async () => {
    // Two facts in one sequence, both about the single `hoveredCell` state:
    // the second hover replaces the first card rather than adding to it, and
    // the first cell's `mouseleave` — which a browser fires *after* the second
    // cell's `mouseenter` — leaves the second card alone.
    //
    // Proof: the same-cell guard in the marker's `onMouseLeave` replaced by an
    // unconditional `setHoveredCell(null)`, this failed on `Unable to find
    // role="tooltip"` at the last assertion — a card closed by the leave of a
    // cell the pointer had already left. Watched, 2026-08-09.
    const api = await oneRowWithNotes('## Risks');
    click('Add work item');
    const second = await screen.findByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\n## Later' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('## Later');
    });

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');
    fireEvent.mouseEnter(notesMarkerOf('020'));

    const open = screen.getAllByRole('tooltip');
    expect(open).toHaveLength(1);
    expect(open[0]?.getAttribute('aria-label')).toBe('Notes for 020, rendered');

    fireEvent.mouseLeave(notesMarkerOf('010'));

    expect(screen.getByRole('tooltip').getAttribute('aria-label')).toBe('Notes for 020, rendered');
  });

  itDom('reads the whole note in the preview while the box shows the name', async () => {
    // The clamp and the preview are one answer between them: at rest the cell
    // is its name and nothing else, so forty rows fit on a screen, and the
    // hover is where the note is read. Without the preview the clamp would be
    // a note nobody could find.
    await oneRowWithNotes('## Risks\n\n- one\n- two\n- three\n- four\n- five\n- six');

    fireEvent.mouseEnter(notesMarkerOf('010'));

    const preview = await screen.findByRole('tooltip');
    expect(preview.querySelectorAll('li')).toHaveLength(6);
    expect(preview.getAttribute('aria-label')).toBe('Notes for 010, rendered');
  });

  itDom('closes the card when a peer moves the row it is anchored to', async () => {
    // A card is an absolutely positioned child of one cell, and `hoveredCell`
    // is a row id — so a refresh that moves that row moves the card with it,
    // to wherever the row landed, which is not where the pointer is. Nothing
    // reconciled the hover against the tree, so the card teleported and stayed
    // open until the pointer happened to cross another cell. codex round 3,
    // finding 3.
    //
    // A refresh that leaves the row where it was must **not** close it, or the
    // reconciliation would be "close on every refresh" — and a peer typing a
    // name anywhere on this plan refetches, so that would be a card nobody
    // could keep open long enough to read.
    //
    // Proof: `setHoveredCell(hoveredCellAfterRefresh(…))` deleted from
    // `refresh`, this failed on `expected <div role="tooltip" …/> to be null` —
    // the card still open over a row that had moved to the top of the plan.
    // Watched, 2026-08-09.
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
    const second = screen.getByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\nsomething to read' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('something to read');
    });

    fireEvent.mouseEnter(notesMarkerOf('020'));
    await screen.findByRole('tooltip');

    // Somebody else renames the other row. Nothing moved, so the card stays.
    await api.patchWorkItem(api.rows[0]?.id ?? '', { name: 'Renamed by a peer' });
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    expect(screen.queryByRole('tooltip'), 'a plain refresh took the card away').not.toBeNull();

    // And now they move the hovered row to the top of the plan.
    await api.moveWorkItem(api.rows[1]?.id ?? '', null, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  itDom('closes the card when a peer moves the branch the row sits inside', async () => {
    // Round 4, finding 10. Settling on the immediate parent and the position
    // among its siblings answers for the row itself and for nothing above it: a
    // peer moving an **ancestor** takes the whole branch to another part of the
    // plan while the hovered row's own pair reads exactly as it did, so the card
    // travelled with it and stayed open on a line the pointer was never on.
    //
    // The placement is a walk of the tree the table is about to draw — the
    // position in the rendered order — which is the thing that actually moved,
    // and which no ancestor can change without changing.
    //
    // Proof: `placementsOf` put back to counting siblings under a parent, this
    // failed on `expected <div role="tooltip" …/> to be null`. Watched,
    // 2026-08-09.
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
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    const second = screen.getByLabelText('Name of 020');
    fireEvent.change(second, { target: { value: 'Sand\nsomething to read' } });
    fireEvent.blur(second);
    await waitFor(() => {
      expect(api.rows[1]?.notes).toBe('something to read');
    });
    const branch = api.rows[0]?.id ?? '';
    const inside = api.rows[1]?.id ?? '';
    const last = api.rows[2]?.id ?? '';

    // 020 goes under 010, so the hovered row has an ancestor to be moved.
    await api.moveWorkItem(inside, branch, null);
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    const child = api.rows.find((row) => row.id === inside)?.number ?? '';
    expect(child, 'the row did not end up inside a branch').toBe('010.1');

    fireEvent.mouseEnter(notesMarkerOf(child));
    await screen.findByRole('tooltip');

    // The branch moves to the end of the plan. The hovered row is still the
    // first child of the same parent — and it is drawn two lines further down.
    await api.moveWorkItem(branch, null, last);
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  });

  itDom('keeps the preview open while the pointer crosses the cell to reach it', async () => {
    // The preview is the one card that scrolls, and a note taller than 320px
    // can only be read by putting the pointer on it and turning the wheel. The
    // marker is a 7px glyph at the top right of the cell and the card hangs off
    // the cell's bottom edge, so that trip crosses the name box between them —
    // and while the marker owned the `mouseleave`, crossing it unmounted the
    // card before the pointer could arrive. codex round 3, finding 1.
    //
    // The region that holds the card open is therefore the **cell**, which
    // contains both the marker and the card; the marker stays the only thing
    // that opens one.
    //
    // `mouseOut` with a `relatedTarget` rather than `mouseLeave`, and that is
    // the difference between an oracle and a test that cannot fail. React
    // synthesises leave from `mouseout`: given where the pointer went it walks
    // up to the common ancestor of the two and fires leave on that stretch
    // alone — exactly what a browser does. A bare `fireEvent.mouseLeave(marker)`
    // carries no `relatedTarget`, which means "the pointer left the document",
    // and React fires leave on the marker *and* on every ancestor — so it would
    // report this fixed or broken identically. Measured here on 2026-08-09.
    //
    // Proof: the `onMouseLeave` put back on the marker, this failed on
    // `expected null not to be null` at the first assertion — the card gone the
    // moment the pointer left the glyph. Watched, 2026-08-09.
    await oneRowWithNotes('## Risks\n\n- one\n- two\n- three');

    fireEvent.mouseEnter(notesMarkerOf('010'));
    await screen.findByRole('tooltip');

    // Off the glyph, onto the name box under it — still inside the cell.
    fireEvent.mouseOut(notesMarkerOf('010'), {
      relatedTarget: screen.getByLabelText('Name of 010'),
    });

    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // And off the cell altogether, which is what closes it — or the assertion
    // above would hold for a card nothing could ever close.
    fireEvent.mouseOut(nameCellOf('010'), { relatedTarget: document.body });

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('a name and its notes in one box', () => {
  /**
   * One row, named and noted, with every `patch` recorded.
   *
   * The row is set up through the box itself rather than by writing to the
   * fake, so what these tests start from is a state this component can
   * actually produce.
   */
  async function noted(name: string, notes: string) {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: notes === '' ? name : `${name}\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe(name);
    });
    expect(api.rows[0]?.notes).toBe(notes);

    const patched = recordCalls(api, 'patchWorkItem');
    return { api, patched, cell };
  }

  /** Types a whole value into the Name cell and leaves it, the way a person does. */
  const retype = (value: string) => {
    const cell = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    cell.focus();
    fireEvent.change(cell, { target: { value } });
    fireEvent.blur(cell);
  };

  itDom('writes the first line as the name and the rest as the notes', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    const cell = await screen.findByLabelText('Name of 010');

    fireEvent.change(cell, { target: { value: 'Strip\n## Risks\n\n- the fuse box is old' } });
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });
    expect(api.rows[0]?.notes).toBe('## Risks\n\n- the fuse box is old');
  });

  itDom('sends one request for a name and a note typed together', async () => {
    // One request, so one refusal, one journal entry and one Cmd+Z. Two
    // patches would undo as two, which is a name and a note that came from one
    // gesture coming back in two.
    const { patched } = await noted('Strip', 'measure twice');

    retype('Strip the wiring\nmeasure twice, cut once');

    await waitFor(() => {
      expect(patched).toEqual([
        ['w1', { name: 'Strip the wiring', notes: 'measure twice, cut once' }],
      ]);
    });
  });

  itDom('sends only the field that changed', async () => {
    // The subset, not the pair: a patch of both fields is a write to be-01 of
    // a field nobody touched, and the last-writer-wins collision this whole
    // design is trying not to have.
    const { patched } = await noted('Strip', 'measure twice');

    retype('Strip the wiring\nmeasure twice');
    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: 'Strip the wiring' }]]);
    });

    retype('Strip the wiring\nmeasure twice, cut once');
    await waitFor(() => {
      expect(patched).toHaveLength(2);
    });
    expect(patched[1]).toEqual(['w1', { notes: 'measure twice, cut once' }]);
  });

  itDom('does not rewrite a note that was stored with Windows line endings', async () => {
    // Where a `\r` actually reaches this code, which is not the keyboard: a
    // `<textarea>` normalises whatever is assigned to it, so the box can never
    // hold one — but the string this cell renders from is be-01's, and be-01
    // takes what an API client or another front end sent it. The box's value
    // and the server's then differ as text while meaning the same thing, and
    // every focus-and-leave of that row would be a patch nobody typed.
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
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: 'Strip' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.name).toBe('Strip');
    });

    const patched: [string, Record<string, string>][] = [];
    api.patchWorkItem = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return Promise.resolve();
    };
    api.rows[0].notes = 'measure twice\r\ncut once';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    // The box holds the browser's newlines; the server holds Windows's.
    expect(cell.value).toBe('Strip\nmeasure twice\ncut once');

    // Clicked into and out of, nothing typed.
    cell.focus();
    fireEvent.blur(cell);
    await act(async () => {
      await Promise.resolve();
    });

    expect(patched).toEqual([]);
    expect(api.rows[0]?.notes).toBe('measure twice\r\ncut once');
  });

  itDom('renames the work item when the first line is deleted', async () => {
    // The edit this design has to be honest about, watched end to end: one
    // merged field means what it says. Cmd+Z is the way back, and the plan's
    // reviewers chose this over a guard that would make one field behave like
    // two.
    const { api, patched } = await noted('Strip', 'measure twice\nand again');

    retype('measure twice\nand again');

    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: 'measure twice', notes: 'and again' }]]);
    });
    expect(api.rows[0]?.name).toBe('measure twice');
  });

  itDom('commits an unnamed work item when the first line is emptied', async () => {
    // Same rule, no special case: the completeness checker is what reports a
    // work item with no name, and it does.
    const { api, patched } = await noted('Strip', 'measure twice');

    retype('\nmeasure twice');

    await waitFor(() => {
      expect(patched).toEqual([['w1', { name: '' }]]);
    });
    expect(api.rows[0]?.name).toBe('');
    expect(api.rows[0]?.notes).toBe('measure twice');
    expect(screen.getByLabelText('Name of 010')).toHaveValue('\nmeasure twice');
  });

  itDom('sends one request however often the cell is left before it lands', async () => {
    // codex round 1, finding 2. `shown` deliberately stays on the old value
    // until the refetch this commit triggers comes back, so between the blur
    // and that refetch the box and the baseline still disagree — and a second
    // focus-and-leave in that window would send the identical patch again.
    // Two requests are two journal entries and two Cmd+Zs for one gesture,
    // which is the thing one atomic patch was for.
    //
    // Proof: the `sent.current` comparison deleted from `onLeave`, this
    // failed on `expected [ [ 'w1', { …(2) } ], …(1) ] to have a length of 1
    // but got 2` — the same name and note written twice. Watched, 2026-08-08.
    const { api, patched, cell } = await noted('Strip', 'measure twice');
    let land: () => void = () => {
      throw new Error('nothing is in flight');
    };
    api.patchWorkItem = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return new Promise<void>((resolve) => {
        land = resolve;
      });
    };

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the wiring\nmeasure twice, cut once' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    // Clicked back into and out of while the first request is still out.
    cell.focus();
    fireEvent.blur(cell);
    await act(async () => {
      await Promise.resolve();
    });
    expect(patched).toHaveLength(1);

    await act(async () => {
      land();
      await Promise.resolve();
    });
    expect(patched).toHaveLength(1);
  });

  itDom('sends a refused edit again when the cell is left a second time', async () => {
    // The other half of the rule above: an unchanged resubmission is dropped
    // because be-01 already has it, so a resubmission of something be-01
    // refused must not be. Leaving the cell is how a person retries.
    //
    // Proof: the `sent.current = null` on a refusal removed, this failed on
    // `expected [] to deeply equal [ [ 'w1', { …(2) } ] ]` — the retry
    // silently dropped as a duplicate of a request that never landed.
    // Watched, 2026-08-08.
    const { api, patched, cell } = await noted('Strip', 'measure twice');
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    retype('Strip the wiring\nmeasure twice, cut once');
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    api.patchWorkItem = (id: string, patch: Record<string, string>) => {
      patched.push([id, patch]);
      return Promise.resolve();
    };
    cell.focus();
    fireEvent.blur(cell);

    await waitFor(() => {
      expect(patched).toEqual([
        ['w1', { name: 'Strip the wiring', notes: 'measure twice, cut once' }],
      ]);
    });
  });

  itDom('a refused edit changes neither field and says so', async () => {
    // Atomicity is the whole reason the two fields travel in one request: a
    // refusal has to leave the row as it was, not half written.
    const { api } = await noted('Strip', 'measure twice');
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    retype('Strip the wiring\nmeasure twice, cut once');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });
    expect(api.rows[0]?.name).toBe('Strip');
    expect(api.rows[0]?.notes).toBe('measure twice');
  });
});

describe('the tag cell', () => {
  beforeEach(showEveryColumn);

  /**
   * The Tags cell's own strip, which is what carries both kinds of chip.
   *
   * `closest` rather than a query from the row, because the box is the only
   * thing in the cell with an accessible name and the chips hang beside it.
   */
  const TAG_CELL = '[data-reference-set="tag"]';

  /**
   * `010` tagged `Risk` and `Review`, and `010.1` under it stating `Ready`.
   *
   * That is the 2026-08-29 report exactly: before ADR 0008 the child's cell
   * drew `Ready` and nothing else, and the two words its parent put on the work
   * were simply gone from every face.
   */
  async function aTaggedPlan(): Promise<ReturnType<typeof fakeApi>> {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const sockets = await api.createWorkItem('p1', {
      parentId: strip.id,
      afterId: null,
      name: 'Sockets',
    });
    const risk = await api.addTag('Risk');
    const review = await api.addTag('Review');
    const ready = await api.addTag('Ready');
    api.labelWithTag(strip.id, [risk.id, review.id]);
    api.labelWithTag(sockets.id, [ready.id]);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
    return api;
  }

  itDom('keeps an ancestor’s tags on a row that has tags of its own', async () => {
    await aTaggedPlan();

    const cell = screen.getByLabelText('Tags for 010.1').closest<HTMLElement>(TAG_CELL)!;
    // Its own, removable where it was written.
    expect(within(cell).getByText('Ready')).toBeTruthy();
    expect(screen.getByLabelText('Remove Ready from 010.1')).toBeTruthy();
    // What it carries, drawn beside them and told apart by the `↳` and by the
    // attribute — this is the assertion the report is about.
    //
    // Proof: the Tags cell's `inheritedEntries: tagging.inherited` deleted, so
    // the strip is handed nothing to draw, and this failed on `expected [] to
    // deeply equal [ '↳ Risk', '↳ Review' ]`. Watched 2026-08-30.
    expect(
      [...cell.querySelectorAll('[data-reference-inherited-chip]')].map((chip) => chip.textContent),
    ).toEqual(['↳ Risk', '↳ Review']);
    // And **not** removable here. A tag comes off the row that states it.
    expect(screen.queryByLabelText('Remove Risk from 010.1')).toBeNull();
    expect(screen.queryByLabelText('Remove Review from 010.1')).toBeNull();
    // Said once per surface: the box no longer repeats the inherited names in
    // its placeholder ink, because the chips beside it are now saying them.
    expect(screen.getByLabelText('Tags for 010.1')).toHaveAttribute('placeholder', 'add');
    // The parent states both of its own, so it carries nothing.
    const parent = screen.getByLabelText('Tags for 010').closest<HTMLElement>(TAG_CELL)!;
    expect(parent.querySelectorAll('[data-reference-inherited-chip]')).toHaveLength(0);
    expect(screen.getByLabelText('Remove Risk from 010')).toBeTruthy();
  });

  itDom('names the row an inherited tag was written on', async () => {
    // The sentence a reader is owed for a word they cannot take off here. Per
    // chip, because two inherited tags may have been written on two rows.
    await aTaggedPlan();

    const cell = screen.getByLabelText('Tags for 010.1').closest<HTMLElement>(TAG_CELL)!;
    expect(
      [...cell.querySelectorAll('[data-reference-inherited-chip]')].map((chip) =>
        chip.getAttribute('data-fact'),
      ),
    ).toEqual([
      'Risk — inherited from 010 - Strip the walls. Remove it there.',
      'Review — inherited from 010 - Strip the walls. Remove it there.',
    ]);
  });
});

describe('the service cell', () => {
  beforeEach(showEveryColumn);

  /**
   * The fixture the facet cases use, one file down: two services in the
   * directory, `Checkout` on `010`, and three rows under it that state none of
   * their own. That is the whole of what this cell has to say — what a row is,
   * and what it inherits when it says nothing.
   */
  async function aServicedPlan(): Promise<ReturnType<typeof fakeApi> & { checkout: string }> {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.createWorkItem('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const checkout = await api.addService('Checkout');
    await api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id]);
    return Object.assign(api, { checkout: checkout.id });
  }

  const drawn = async (api: ProjectApi): Promise<void> => {
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1']);
    });
  };

  itDom('says what a row is, and what its children inherit when they say nothing', async () => {
    const api = await aServicedPlan();
    await drawn(api);

    // The row's own, as a chip rather than as the picker's value — task 10.4's
    // control change. The box beside the chip is the *add* box and holds
    // nothing, which is what `own.length > 0 ? 'add'` says.
    expect(screen.getByLabelText('Remove Checkout from 010')).toBeTruthy();
    expect(screen.getByLabelText('Services for 010')).toHaveAttribute('placeholder', 'add');
    expect(
      screen.getByLabelText('Services for 010').closest('[data-reference-set="service"]'),
    ).not.toBeNull();
    // The child's, as placeholder ink that is shown and not stored — `↳` for
    // the inheritance, the same glyph and the same bargain the Team cell makes
    // at 120px. Inheritance did not change with the widening: blank still means
    // inherit, and a row with a chip of its own inherits nothing.
    const child = screen.getByLabelText('Services for 010.1');
    expect(child).toHaveValue('');
    expect(child).toHaveAttribute('placeholder', '↳ Checkout');
    // A marker that cannot say where it came from is a mystery, not a signal.
    expect(child).toHaveAttribute(
      'data-fact',
      expect.stringMatching(/Checkout — inherited from 010 - Strip the walls/),
    );
  });

  itDom('adds a service by typing a name the list does not have, and shows the +', async () => {
    const api = await aServicedPlan();
    await drawn(api);

    const picker = screen.getByLabelText('Services for 010');
    // The shared add affordance is on the leading edge, like Depends on's.
    expect(screen.getByRole('button', { name: 'Add a service to 010' })).toBeTruthy();

    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Painting' } });
    // A name not in the directory offers the `+`-plus-search bargain the team
    // cell has: the typed name as an `Add` line, not a silent no-op.
    const list = await screen.findByRole('listbox', { name: 'Services for 010' });
    expect(list.textContent).toContain('Add “Painting”');
    fireEvent.keyDown(picker, { key: 'Enter' });

    await waitFor(() => {
      expect(api.rows[0]?.serviceIds?.length).toBe(2);
    });
    expect((await api.listServices()).map((service) => service.name)).toContain('Painting');
  });

  itDom('shows every service a row states, and takes one off without the rest', async () => {
    // **Task 10.4's own case, and the one a single-select could not pass.** The
    // store has been a set since 10.2 and the cell read `serviceIds[0]` until
    // now, so a row carrying two services showed one of them and any edit sent
    // that one back — the second was invisible on screen and lost on the next
    // choice.
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.createWorkItem('p1', { parentId: strip.id, afterId: null, name: 'Sockets' });
    const checkout = await api.addService('Checkout');
    // `addService` is idempotent by name, so this is the same `Ledger` the
    // shared fixture makes rather than a second one.
    const ledger = await api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id, ledger.id]);

    const patches: unknown[] = [];
    const watched: ProjectApi = {
      ...api,
      patchWorkItem: async (id, patch) => {
        patches.push({ id, patch });
        return api.patchWorkItem(id, patch);
      },
    };
    await drawn(watched);

    // Both on screen, each removable on its own.
    expect(screen.getByLabelText('Remove Checkout from 010')).toBeTruthy();
    expect(screen.getByLabelText('Remove Ledger from 010')).toBeTruthy();

    // Removing one sends **the set as it will stand**, not the member removed —
    // a delta has no inverse the undo journal could carry (task 10.3).
    fireEvent.click(screen.getByLabelText('Remove Checkout from 010'));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({ patch: { serviceIds: [ledger.id] } });
    await waitFor(() => {
      expect(screen.queryByLabelText('Remove Checkout from 010')).toBeNull();
    });
    expect(screen.getByLabelText('Remove Ledger from 010')).toBeTruthy();
  });

  itDom(
    'sends the service the picker chose, and the empty set when the last chip goes',
    async () => {
      const api = await aServicedPlan();
      const patches: unknown[] = [];
      const watched: ProjectApi = {
        ...api,
        patchWorkItem: async (id, patch) => {
          patches.push({ id, patch });
          return api.patchWorkItem(id, patch);
        },
      };
      await drawn(watched);

      // Choosing on the child, which had none: the id goes out, as the whole set
      // it will stand as — one member here because the child had nothing.
      const child = screen.getByLabelText('Services for 010.1');
      fireEvent.change(child, { target: { value: 'Ledger' } });
      fireEvent.click(await screen.findByText('Ledger'));
      await waitFor(() => {
        expect(patches).toHaveLength(1);
      });

      // Taking the last one off the parent, which had one. **`[]`, not an omitted
      // field.** An absent `serviceIds` is "no opinion" to the patch and would
      // leave `Checkout` standing — the cell would appear to clear and the next
      // refetch would put the label back. The empty array is the one spelling of
      // taking the label off since task 10.2; the `null` this asserted was the
      // column's.
      //
      // Through the **chip**, not through a Clear button: since task 10.4 this box
      // holds no value, and `CreatablePicker` draws its ✕ only for a box that
      // does. This case is what found that — written against `Clear Services for
      // 010` it failed on `Unable to find a label with the text of`, which is why
      // the cell passes no `onClear` and says so.
      fireEvent.click(screen.getByLabelText('Remove Checkout from 010'));
      await waitFor(() => {
        expect(patches).toHaveLength(2);
      });
      expect(patches[1]).toMatchObject({ patch: { serviceIds: [] } });
    },
  );
});

describe('the links column', () => {
  // These cases exercise Links itself, not whether a first-visit layout hides
  // it. Give them the same explicit reader choice as every other column-specific
  // suite so the contextual default cannot erase the surface under test.
  beforeEach(showEveryColumn);

  /** The seeded vocabulary's ids, as `fakeApi` mints them and be-01 seeds them. */
  const JIRA = 'sys-jira';
  const GH_PR = 'sys-gh-pr';
  const GH_ISSUE = 'sys-gh-issue';
  const CONFLUENCE = 'sys-confluence';
  const SLACK = 'sys-slack';

  /** Two rows: `010` for the links, `020` deliberately with none. */
  async function twoRows(): Promise<ReturnType<typeof fakeApi> & { first: string }> {
    const api = fakeApi();
    const first = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.createWorkItem('p1', { parentId: null, afterId: first.id, name: 'Paint' });
    return Object.assign(api, { first: first.id });
  }

  const drawn = async (api: ProjectApi): Promise<void> => {
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  };

  /** The marks one row's cell draws, by what each stands for. */
  const marksOn = (number: string): string[] => {
    // Scoped to the table rather than to the page: the editor is a dialog named
    // for the same row, so a `getByLabelText` here matches two elements the
    // moment the editor is open — which is exactly when the cases below want to
    // read the marks the round trip left behind.
    const cell = document.querySelector(`table [aria-label="Links for ${number}"]`);
    if (cell === null) throw new Error(`no links cell on ${number}`);
    return [...cell.querySelectorAll<HTMLElement>('[data-ref-mark]')].map(
      (mark) => mark.dataset['refMark'] ?? '',
    );
  };

  itDom('four refs to one system are one mark', async () => {
    // Design D2, and the column's whole reason for existing: it answers *what is
    // this wired to*, not *how many links*. Four GitHub pull requests and one
    // Jira issue is two marks — and the fourth GitHub ref is what makes the
    // fault visible, because one mark per ref and one mark per system agree on
    // every row with one link each.
    //
    // Proof: `refMarksOf` made to return one mark per ref (`refs.map(...)`
    // instead of the family count), this failed on `expected [ 'github',
    // 'github', 'github', …(1) ] to deeply equal [ 'github', 'jira' ]`, and
    // four cases in `external-ref-marks.test.ts` with it. Watched, 2026-08-31.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/1' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/2' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/3' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/4' },
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
    ]);
    await drawn(api);

    expect(marksOn('010')).toEqual(['github', 'jira']);
  });

  itDom('no refs is blank', async () => {
    // Blank and not `—`: the Prio cell's bargain, quoted in design D2. A column
    // of furniture down a plan nobody has wired up says less than a blank does.
    const api = await twoRows();
    await drawn(api);

    expect(marksOn('020')).toEqual([]);
    expect(screen.getByLabelText('Links for 020').textContent).toBe('');
  });

  itDom('collapses a fifth system into one overflow mark', async () => {
    // The column is 40px and holds four marks. A fifth *system* takes the
    // overflow's place rather than a fifth mark, because the one thing this
    // column may not do is depend on its contents for its width.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
      { systemId: CONFLUENCE, url: 'https://acme.atlassian.net/wiki/x' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/1' },
      { systemId: SLACK, url: 'https://acme.slack.com/archives/C1/p1' },
      { systemId: 'sys-unheard-of', url: 'https://example.com/thing' },
    ]);
    await drawn(api);

    expect(marksOn('010')).toEqual(['jira', 'confluence', 'github', 'overflow']);
  });

  itDom('the cell says what it links to, without colour', async () => {
    // Design D3's third channel, and the one that works with no sight of the
    // column at all: the accessible description names each system and says how
    // many links it stands for. Read as the *description* rather than by
    // looking at a dot, which is the point.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/1' },
      { systemId: GH_ISSUE, url: 'https://github.com/o/r/issues/2' },
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
    ]);
    await drawn(api);

    expect(screen.getByLabelText('Links for 010')).toHaveAccessibleDescription(
      '2 GitHub links, 1 Jira link',
    );
    // And nothing at all is said about a row with no links.
    expect(screen.getByLabelText('Links for 020')).toHaveAccessibleDescription('');
  });

  itDom('two marks of one hue are told apart by fill', async () => {
    // The pair the common colour deficiencies collapse first is one blue against
    // a darker blue, so these two are the **same** blue and differ in fill
    // instead — a distinction that survives being printed in grey.
    //
    // Proof: `FAMILY_PAINT.confluence` given `filled: true`, this failed on
    // `expected 'oklch(0.55 0.19 255)' to be 'transparent'`. Watched,
    // 2026-08-31.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
      { systemId: CONFLUENCE, url: 'https://acme.atlassian.net/wiki/x' },
    ]);
    await drawn(api);

    const cell = screen.getByLabelText('Links for 010');
    const jira = cell.querySelector<HTMLElement>('[data-ref-mark="jira"]');
    const confluence = cell.querySelector<HTMLElement>('[data-ref-mark="confluence"]');
    if (jira === null || confluence === null) throw new Error('both marks should be drawn');
    // The fill first, because it is the claim — the assertion an injected
    // "same fill" fault has to stop at.
    expect(confluence.style.background).toBe('transparent');
    expect(jira.style.background).toBe('oklch(0.55 0.19 255)');
    // `'none'` is what jsdom 30 reads back for `border: 'none'`; jsdom 24 read
    // it as `''`. Either way the filled mark carries no stroke.
    expect(jira.style.borderStyle).toBe('none');
    // One hue, stated as an assertion rather than as a comment: if these ever
    // stop being the same colour the fill distinction is no longer the thing
    // being relied on and this test is about something else.
    expect(confluence.style.borderColor).toBe('oklch(0.55 0.19 255)');
  });

  itDom('the card lists every ref and follows one', async () => {
    // The marks say *which systems*; the card is the whole list, and it is the
    // surface a reader clicks a link on. Three refs into **two** systems, so a
    // card built from the marks rather than from the refs is visibly short.
    //
    // Proof: `ExternalRefsCard` made to list one entry per mark (the refs
    // deduplicated by system before the map), this failed on `expected [ <a
    // …(4)></a>, <a …(4)></a> ] to have a length of 3 but got 2`. Watched,
    // 2026-08-31.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/1' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/2' },
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
    ]);
    await drawn(api);

    fireEvent.mouseEnter(screen.getByLabelText('Links for 010'));
    const card = await screen.findByRole('tooltip', { name: 'Where 010 also exists' });
    const links = [...card.querySelectorAll<HTMLAnchorElement>('a[data-refs-card-url]')];
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/2',
      'https://acme.atlassian.net/browse/AB-1',
    ]);
    // A new context, and no referrer: this plan's URL names a project, and
    // `window.opener` is a handle on the page that opened it.
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    }
  });

  itDom('a non-http URL is not a link, on the card or in the editor', async () => {
    // The fault the rule exists for, arranged the way it really arrives: the URL
    // is written **through the store** rather than typed, because be-01 does not
    // refuse a scheme at the write (a reader may override a derived type, so a
    // mismatch has to stay storable) and the renderer is where `javascript:`
    // stops.
    //
    // Proof: `followableHref` made to return the URL unconditionally, this
    // failed on `expected <a data-refs-card-url="ref1" …(3)></a> to be null` —
    // the anchor the first assertion says must not exist. Watched, 2026-08-31.
    const api = await twoRows();
    api.linkTo(api.first, [{ systemId: JIRA, url: 'javascript:alert(1)' }]);
    await drawn(api);

    fireEvent.mouseEnter(screen.getByLabelText('Links for 010'));
    const card = await screen.findByRole('tooltip', { name: 'Where 010 also exists' });
    expect(card.querySelector('a[data-refs-card-url]')).toBeNull();
    expect(card.querySelector('span[data-refs-card-url]')?.textContent).toBe('javascript:alert(1)');

    // And the same URL on the other surface, from the same guard.
    fireEvent.click(screen.getByLabelText('Links for 010'));
    const editor = await screen.findByRole('dialog', { name: 'Links for 010' });
    expect(editor.querySelector('a[data-refs-editor-url]')).toBeNull();
    expect(editor.querySelector('span[data-refs-editor-url]')?.textContent).toBe(
      'javascript:alert(1)',
    );
  });

  itDom('taking the cell opens the editor holding the row’s links', async () => {
    const api = await twoRows();
    api.linkTo(api.first, [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' }]);
    await drawn(api);

    expect(screen.queryByRole('dialog', { name: 'Links for 010' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Links for 010'));
    const editor = await screen.findByRole('dialog', { name: 'Links for 010' });
    expect(within(editor).getByLabelText('URL of link 1')).toHaveValue(
      'https://acme.atlassian.net/browse/AB-1',
    );
    // The stored system, shown and overridable.
    expect(within(editor).getByLabelText('System of link 1')).toHaveValue('jira-issue');
  });

  itDom('adds a ref from a pasted URL, typed by the URL and overridable', async () => {
    const api = await twoRows();
    const patches: unknown[] = [];
    const watched: ProjectApi = {
      ...api,
      patchWorkItem: async (id, patch) => {
        patches.push({ id, patch });
        return api.patchWorkItem(id, patch);
      },
    };
    await drawn(watched);

    fireEvent.click(screen.getByLabelText('Links for 010'));
    const editor = await screen.findByRole('dialog', { name: 'Links for 010' });
    // Nothing to add until there is a URL, and nothing to add a URL no rule
    // claims to until a system is named — the spec's "the ref SHALL NOT be
    // stored until a system is named".
    expect(within(editor).getByRole('button', { name: 'Add link' })).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText('Paste a URL'), {
      target: { value: 'https://example.com/anything' },
    });
    expect(within(editor).getByLabelText('System of the new link')).toHaveValue('');
    expect(within(editor).getByRole('button', { name: 'Add link' })).toBeDisabled();

    // A GitHub pull request types itself, with no reader involved.
    fireEvent.change(within(editor).getByLabelText('Paste a URL'), {
      target: { value: 'https://github.com/o/r/pull/9' },
    });
    expect(within(editor).getByLabelText('System of the new link')).toHaveValue('github-pr');
    fireEvent.click(within(editor).getByRole('button', { name: 'Add link' }));

    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      patch: { externalRefs: [{ systemId: GH_PR, url: 'https://github.com/o/r/pull/9' }] },
    });
  });

  itDom('removes one ref and states the list that is left', async () => {
    // The write is a **replacement**, so a removal is the surviving list sent
    // whole: a patch that named only what went would leave be-01 guessing at a
    // delta, and undo with nothing to restore.
    //
    // Proof: the removal's `onReplace` deleted from the Remove button's
    // `onClick`, this failed on `expected [] to have a length of 1 but got +0`.
    // Watched, 2026-08-31.
    const api = await twoRows();
    api.linkTo(api.first, [
      { systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' },
      { systemId: GH_PR, url: 'https://github.com/o/r/pull/1' },
    ]);
    const patches: { patch: unknown }[] = [];
    const watched: ProjectApi = {
      ...api,
      patchWorkItem: async (id, patch) => {
        patches.push({ patch });
        return api.patchWorkItem(id, patch);
      },
    };
    await drawn(watched);

    fireEvent.click(screen.getByLabelText('Links for 010'));
    const editor = await screen.findByRole('dialog', { name: 'Links for 010' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove link 1' }));

    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      patch: { externalRefs: [{ systemId: GH_PR, url: 'https://github.com/o/r/pull/1' }] },
    });
    // And the cell says so once the round trip has landed — the mark that is
    // left, not the one that went.
    await waitFor(() => {
      expect(marksOn('010')).toEqual(['github']);
    });
  });

  itDom('edits a stored ref’s URL and its system', async () => {
    const api = await twoRows();
    api.linkTo(api.first, [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-1' }]);
    const patches: { patch: unknown }[] = [];
    const watched: ProjectApi = {
      ...api,
      patchWorkItem: async (id, patch) => {
        patches.push({ patch });
        return api.patchWorkItem(id, patch);
      },
    };
    await drawn(watched);

    fireEvent.click(screen.getByLabelText('Links for 010'));
    const editor = await screen.findByRole('dialog', { name: 'Links for 010' });
    const url = within(editor).getByLabelText('URL of link 1');
    fireEvent.change(url, { target: { value: 'https://acme.atlassian.net/browse/AB-2' } });
    fireEvent.blur(url);
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      patch: { externalRefs: [{ systemId: JIRA, url: 'https://acme.atlassian.net/browse/AB-2' }] },
    });

    // And the system, which a reader may always override — the stored value
    // differing from what the deriver would say today is exactly what an
    // override is (design D1).
    fireEvent.change(within(editor).getByLabelText('System of link 1'), {
      target: { value: 'slack-message' },
    });
    await waitFor(() => {
      expect(patches).toHaveLength(2);
    });
    expect(patches[1]).toMatchObject({ patch: { externalRefs: [{ systemId: SLACK }] } });
    await waitFor(() => {
      expect(marksOn('010')).toEqual(['slack']);
    });
  });
});
