import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Days, PersonView, ProjectApi, RoleView, TeamView, WorkItemView } from '@/lib/wbs-api';

import { refusedDraftFor } from './live-editing';
import { WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** jsdom's own default, and the width every other test in this app runs at. */
const LAPTOP = 1024;
/** An iPhone 14's CSS width, which is what `e2e/mobile.spec.ts` measures at. */
const PHONE = 390;

const DEV: RoleView = { id: 'role-dev', name: 'Dev' };
const QA: RoleView = { id: 'role-qa', name: 'QA' };

/**
 * What this fake was asked for and does not do.
 *
 * A throw rather than a silent `undefined`: a card test that reached one of
 * these would be exercising a path nothing here models, and answering it with
 * nothing is the "unknown converted to a default" this repository refuses.
 */
const notImplemented = (what: string): never => {
  throw new Error(`the card tests' fake project API has no ${what}`);
};

/**
 * A `ProjectApi` over an in-memory plan, as small as these tests can be served
 * by.
 *
 * Deliberately **not** `wbs-table.test.tsx`'s: that one is four hundred lines
 * modelling renumbering, undo stacks, phase removal and assumed-assignee flips,
 * and it is that file's spec. Nothing here needs any of it — a card is read
 * from the same tree the table is — and importing a test file to borrow its
 * fixture would run its 289 tests again.
 */
/**
 * A plan on a calendar, in the reader's own year, so the short dates print
 * without one. Built from `new Date()` rather than written out, because "this
 * year" is what decides whether the year is shown at all.
 */
const DATED_PLAN = {
  startsOn: `${String(new Date().getFullYear())}-06-01`,
  endsOn: `${String(new Date().getFullYear())}-06-03`,
} as const;

function fakeApi(options: { refusePatch?: boolean; dated?: boolean } = {}): ProjectApi & {
  patched: { id: string; name?: string; notes?: string }[];
  assignments: string[];
  /**
   * The plan itself, so a test can arrange one before the first render.
   *
   * The cards read the tree and write nothing to the two fields
   * `capacity-ui` put on them — a team label and a parallelism are typed in the
   * table and in the directory, never on a phone — so arranging them through a
   * write path this fake does not have would be modelling a route that does not
   * exist. Handed over instead, and the assertions are about what a card draws.
   */
  rows: WorkItemView[];
  teams: TeamView[];
} {
  const rows: WorkItemView[] = [];
  const roleList: RoleView[] = [{ ...DEV }, { ...QA }];
  const people: PersonView[] = [{ id: 'p1', name: 'Kat', teamIds: [] }];
  const teams: TeamView[] = [];
  const assigned = new Map<string, string>();
  const patched: { id: string; name?: string; notes?: string }[] = [];
  const assignments: string[] = [];
  let next = 0;

  /** The one person this work item is taken to be doing every phase of, if any. */
  const doesEveryPhase = (id: string): string | null => {
    const named = [...assigned.entries()]
      .filter(([key]) => key.startsWith(`${id}::`))
      .map(([, personId]) => personId);
    return named.length === 1 ? (named[0] ?? null) : null;
  };

  const view = (row: WorkItemView): WorkItemView => ({
    ...row,
    doesEveryPhase: doesEveryPhase(row.id),
    assignees: Object.fromEntries(
      roleList.map((role) => [role.id, assigned.get(`${row.id}::${role.id}`)]),
    ),
  });

  return {
    patched,
    assignments,
    rows,
    teams,
    tree: () =>
      Promise.resolve({
        workItems: rows.map(view),
        seq: 0,
        scheduleError: null,
        // Nothing here reads them; they are on the payload, so the fake carries
        // them. One per row, since these tests make no parents.
        slices: rows.map((row) => ({
          id: `${row.id}::${DEV.id}`,
          workItemId: row.id,
          roleId: DEV.id,
          personId: null,
          duration: 0,
          estimated: false,
          earliestStart: 0,
          earliestFinish: 0,
          latestStart: 0,
          latestFinish: 0,
          float: 0,
          critical: false,
          boundBy: 'projectStart' as const,
          resourcePredecessorId: null,
          // One at a time and nothing holding a pool. The cards read neither —
          // a card's parallelism line is the row's stored number — but the
          // payload carries them, so this fake does too.
          width: 1,
          effort: 0,
          capacityPredecessorIds: [],
        })),
        // The same two lists `roles` and `listPeople` answer with, on the read
        // that carried the slices: the chart is drawn from this payload alone.
        roles: roleList.map((role) => ({ ...role })),
        assignedPeople: people.map(({ id, name }) => ({ id, name })),
        // Present and empty, never absent: be-01 always sends it, so a fake that
        // left it out would let `teamsOnThePlan` be handed `undefined` here and
        // never in production. A plan whose teams are unlimited is what `[]` says.
        teamCapacities: [],
        estimateMethod: 'pert' as const,
        startDate: options.dated === true ? DATED_PLAN.startsOn : null,
        projectRevision: 0,
        undoable: false,
        redoable: false,
      }),
    roles: () => Promise.resolve(roleList.map((role) => ({ ...role }))),
    listTeams: () => Promise.resolve(teams.map((team) => ({ ...team }))),
    listPeople: () => Promise.resolve(people.map((person) => ({ ...person }))),
    create: (_projectId: string, input: { parentId: string | null; name?: string }) => {
      next += 1;
      const id = `w${String(next)}`;
      rows.push({
        id,
        parentId: input.parentId,
        revision: 0,
        number: String(rows.length + 1).padStart(2, '0') + '0',
        name: input.name ?? '',
        notes: '',
        frozenNumber: null,
        priority: null,
        // One at a time, be-01's `NOT NULL DEFAULT 1`: never absent, because 1
        // and unset are the same fact.
        maxParallel: 1,
        rolledUp: false,
        estimates: {},
        dependsOn: [],
        finalDays: {},
        finalTotal: 0,
        dates: options.dated === true ? { ...DATED_PLAN } : null,
        startNoEarlierThan: null,
        serviceTeamId: null,
        teamIds: [],
        serviceIds: [],
        assignees: {},
        doesEveryPhase: null,
        schedule: {
          duration: 0,
          estimated: false,
          earliestStart: 0,
          earliestFinish: 0,
          latestStart: 0,
          latestFinish: 0,
          float: 0,
          critical: false,
        },
      });
      return Promise.resolve({ id });
    },
    patch: (id: string, patch: { name?: string; notes?: string }) => {
      if (options.refusePatch === true) return Promise.reject(new Error('forbidden'));
      patched.push({ id, ...patch });
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.notes !== undefined) row.notes = patch.notes;
      return Promise.resolve();
    },
    setEstimate: (id: string, roleId: string, days: Days) => {
      const row = rows.find((each) => each.id === id);
      if (row === undefined) return Promise.reject(new Error('not_found'));
      row.estimates = { ...row.estimates, [roleId]: days };
      const final = (days.optimistic + 4 * days.realistic + days.pessimistic) / 6;
      row.finalDays = { ...row.finalDays, [roleId]: final };
      row.finalTotal = Object.values(row.finalDays).reduce((total, each) => total + each, 0);
      return Promise.resolve();
    },
    assign: (workItemId: string, roleId: string, personId: string | null) => {
      assignments.push(`${workItemId} ${roleId} ${personId ?? '(nobody)'}`);
      if (personId === null) assigned.delete(`${workItemId}::${roleId}`);
      else assigned.set(`${workItemId}::${roleId}`, personId);
      return Promise.resolve();
    },
    addRole: (_projectId: string, name: string) => {
      const role = { id: `role-${name.toLowerCase()}`, name };
      roleList.push(role);
      return Promise.resolve({ ...role });
    },
    listProjects: () => notImplemented('listProjects'),
    createProject: () => notImplemented('createProject'),
    openProject: () => notImplemented('openProject'),
    renameProject: () => notImplemented('renameProject'),
    undo: () => notImplemented('undo'),
    redo: () => notImplemented('redo'),
    setEstimateMethod: () => notImplemented('setEstimateMethod'),
    setStartDate: () => notImplemented('setStartDate'),
    renameRole: () => notImplemented('renameRole'),
    removeRole: () => notImplemented('removeRole'),
    addTeam: () => notImplemented('addTeam'),
    addPerson: () => notImplemented('addPerson'),
    move: () => notImplemented('move'),
    duplicate: () => notImplemented('duplicate'),
    remove: () => notImplemented('remove'),
    clearEstimate: () => notImplemented('clearEstimate'),
    freeze: () => notImplemented('freeze'),
    unfreezeProject: () => notImplemented('unfreezeProject'),
    unfreeze: () => notImplemented('unfreeze'),
    addDependency: () => notImplemented('addDependency'),
    removeDependency: () => notImplemented('removeDependency'),
  };
}

/** Sets the width the next render will read, before anything is on screen. */
function widthIs(width: number): void {
  (window as unknown as { innerWidth: number }).innerWidth = width;
}

/** Turns the phone: the width, then the event the page hears about it through. */
function resizeTo(width: number): void {
  act(() => {
    widthIs(width);
    window.dispatchEvent(new Event('resize'));
  });
}

/** Every cell the renderer on screen has drawn a box for, by `data-cell`. */
const cellsOnScreen = (): string[] =>
  [...document.querySelectorAll('[data-cell]')].map((box) => box.getAttribute('data-cell') ?? '');

const openTheSheet = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Plan actions' }));
};

/** Adds one work item through the sheet, which is the only way to on a phone. */
async function addAWorkItem(): Promise<void> {
  openTheSheet();
  fireEvent.click(await screen.findByRole('button', { name: 'Add work item' }));
  await screen.findByLabelText('Name of 010');
}

beforeEach(() => {
  localStorage.clear();
  widthIs(LAPTOP);
});

afterEach(() => {
  cleanup();
  widthIs(LAPTOP);
});

describe('the plan on a phone', () => {
  itDom('indents a card one step per level, and stops at the cards’ own cap', async () => {
    // `cardIndentFor`: deeper than the Number column's cap — a card has no
    // pinned neighbour to overlap, so depth 5 and 6 step right where the table
    // cell's number stops — but not uncapped, because the margin comes out of
    // a 390px phone. The chain is built through the fake before the render:
    // eight rows, each the child of the one before, so the deepest is depth 7
    // — one past the cards' stated cap.
    const api = fakeApi();
    await api.create('p1', { parentId: null });
    for (let parent = 1; parent <= 7; parent += 1) {
      await api.create('p1', { parentId: `w${String(parent)}` });
    }
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByRole('article', { name: 'Work item 080' });

    const cardMargin = (id: string): string => {
      const card = document.querySelector<HTMLElement>(`[data-card="${id}"]`);
      if (card === null) throw new Error(`no card on screen for ${id}`);
      return card.style.marginLeft;
    };

    // Proof: the cards pointed at the uncapped `hierarchyIndentFor` — this
    // failed on `expected '84px' to be '72px'` at depth 7. Watched,
    // 2026-08-10.
    expect(cardMargin('w1')).toBe('0px');
    expect(cardMargin('w5')).toBe('48px');
    // Past the Number column's `DEEPEST_INDENT`, where the capped indent held
    // every deeper card at 48px.
    expect(cardMargin('w6')).toBe('60px');
    expect(cardMargin('w7')).toBe('72px');
    // And the cards' own cap: depth 7 draws at depth 6's margin.
    expect(cardMargin('w8')).toBe('72px');
  });

  itDom('is cards below the breakpoint and the table above it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.getByRole('article', { name: 'Work item 010' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    resizeTo(LAPTOP);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Work item 010' })).toBeNull();
  });

  /**
   * codex #14 / agy #12, the first contract: a card's boxes are the table's
   * cells.
   *
   * They have to be, because `heldRefusals` is keyed by `rowId::columnId` and
   * nothing else — a card that spelled its cells its own way would mount a
   * different {@link import('./live-editing').LiveField} and lose every draft
   * be-01 refused on the way across the breakpoint. The subset is checked as
   * well as the exact list: the cards edit three of the table's cells and must
   * invent none.
   *
   * Proof: the card's `cellKey` prefixed with `card-`, so its boxes are cells
   * of their own. This failed on `expected [ 'w1::card-name', … ] to deeply
   * equal [ 'w1::name', … ]` — and `keeps a draft be-01 refused when the window
   * crosses the breakpoint` failed with it, which is the fault that matters.
   * Watched, 2026-08-09.
   */
  itDom('renders no cell the table has not got one for', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCards = cellsOnScreen();
    resizeTo(LAPTOP);
    const onTheTable = cellsOnScreen();

    expect(onCards).toEqual(['w1::name', 'w1::role-dev-final', 'w1::role-qa-final']);
    for (const cell of onCards) expect(onTheTable).toContain(cell);
  });

  /**
   * The other half of the same contract, and the one `X live-editing-extraction`
   * re-anchored `editable-grid.ts` for (agy #11): the cards are a grid without
   * being a table.
   *
   * The marker is asserted structurally because that is what it is — it is what
   * scopes the vendored components' reset away from the boxes (`styles.css`)
   * and what `gridOf` finds. The **behaviour** it stands for is the test below:
   * a grid that walks.
   */
  itDom('marks the card list as the grid, and it is no table', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const grid = document.querySelector('[data-grid]');
    expect(grid).not.toBeNull();
    expect(grid?.tagName).not.toBe('TABLE');
    expect(grid?.querySelectorAll('[data-cell]')).toHaveLength(3);
  });

  /**
   * The grid walked, on the card DOM: the readiness badge carries the caret to
   * the next leaf nobody has estimated, and it finds that cell by asking
   * `editable-grid.ts` for it (`cellIn`, then `focusCellAt`).
   *
   * This is the assertion that would fail if the cards were a list nothing
   * could walk — the structural one above cannot see that, and neither can the
   * create, which claims its own arrival as the box attaches.
   *
   * Proof: `gridRef` dropped from `PlanCards`, so `gridElement` stays null and
   * the walk has no grid to read. Failed on `expected <body> to be <input
   * data-cell="w1::role-dev-final" …>` — the caret left where it was, on a
   * badge that had said it would take the reader somewhere. Watched,
   * 2026-08-09.
   */
  itDom('carries the caret to an unestimated card when the badge is taken', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    openTheSheet();
    fireEvent.click(await screen.findByRole('button', { name: '1 unestimated' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Dev estimate for 010'));
    });
  });

  /**
   * codex #14's second contract, on the card DOM: a structural edit is a
   * request and a refetch, and something has to put the caret in the row that
   * arrives.
   *
   * On a phone there is exactly one structural edit — Add work item, from the
   * sheet — so this is the whole of it.
   *
   * Proof: `onCloseAutoFocus` removed from the sheet, this failed on `expected
   * <button …(5)></button> to be <textarea …(5)></textarea>` — Radix restores
   * the focus to a modal's trigger **on a timer**, so it lands after the
   * refetch and takes the caret straight back off the new card. Watched,
   * 2026-08-09.
   *
   * What this test does **not** see is the trap itself: jsdom performs none of
   * the `focusin` bookkeeping a real focus scope is made of, so with
   * `closingControlIn` pinned to null the caret still reached the box here while
   * five other tests failed on a sheet left over the plan. The browser is where
   * that half is asserted — `e2e/mobile.spec.ts`.
   */
  itDom('lands the focus in the card of a work item it just created', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    });
  });

  /**
   * codex #14's third contract, and the reason `X live-editing-extraction`
   * exists at all: a draft be-01 refused belongs to the cell, so turning the
   * phone must not take it away.
   *
   * `live-editing.test.tsx` proves this by unmounting one renderer and mounting
   * another by hand. This is the same claim through the **production**
   * breakpoint — one component, one plan, a real `resize` — which is the only
   * version that can see the switch itself put the wrong thing on screen.
   *
   * Proof: `LiveField.takeNode`'s restore deleted, this failed on `expected ''
   * to be 'Strip the wiring'` — the refused name replaced by the server's, by a
   * phone being turned. Watched, 2026-08-09.
   */
  itDom('keeps a draft be-01 refused when the window crosses the breakpoint', async () => {
    const api = fakeApi({ refusePatch: true });
    render(<WbsTable projectId="p1" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add work item' }));
    const onTheTable = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');

    fireEvent.change(onTheTable, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(onTheTable);
    await waitFor(() => {
      expect(refusedDraftFor('w1::name')).toBe('Strip the wiring');
    });

    resizeTo(PHONE);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  /** The other direction, because a phone is turned back. */
  itDom('and carries it back to the table when the window widens again', async () => {
    const api = fakeApi({ refusePatch: true });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onACard = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(onACard, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(onACard);
    await waitFor(() => {
      expect(refusedDraftFor('w1::name')).toBe('Strip the wiring');
    });

    resizeTo(LAPTOP);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  itDom('sends a name typed on a card', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const box = screen.getByLabelText('Name of 010');
    fireEvent.change(box, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(box);

    await waitFor(() => {
      expect(api.patched).toEqual([{ id: 'w1', name: 'Strip the wiring' }]);
    });
  });

  itDom('keeps a card’s notes on show at rest, capped at eight lines', async () => {
    // The card face is the one place a note is readable without editing it: a
    // phone has no hover, so the preview the table sends people to does not
    // exist here. That is why the table's Name cell clamps to its first line
    // at rest (`restShowsFirstLineOnly`) and this one deliberately does not —
    // it caps instead, and the cap has been the only thing standing between a
    // long note and a card the length of the page since `maxRestRows` arrived.
    //
    // Proof: `restShowsFirstLineOnly` passed here too, as the table's Name
    // column passes it — `expected 'none' to be '11.2em'` and `expected
    // 'hidden' to be 'auto'`, the note clipped away on the one face that has
    // nowhere else to show it. Watched, 2026-08-09.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const box = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(box, { target: { value: 'Strip\nmeasure twice, the fuse box is old' } });
    box.blur();

    expect(box.style.maxHeight).toBe('11.2em');
    expect(box.style.overflowY).toBe('auto');
  });

  itDom('prints a span in the very words the table’s columns print', async () => {
    // The parity rule, asserted across the breakpoint rather than against a
    // literal: one plan read on a phone and on a laptop may not disagree about
    // how a day is written. Both renderers are handed the table's own
    // `spanOf`, and this is what says so.
    //
    // Proof: the card's span rendered as `span.start.iso ?? span.start.text`
    // — the raw ISO the cards used to print — this failed on `expected
    // '2026-06-01 → 2026-06-03' to be '1 Jun → 3 Jun'`. Watched, 2026-08-09.
    const api = fakeApi({ dated: true });
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCard = document.querySelector('[data-card-span]');
    expect(onCard?.textContent).toBe('1 Jun → 3 Jun');
    // And the full days are still a hover away, the same bargain the table's
    // cells make.
    expect(onCard?.getAttribute('title')).toBe(`${DATED_PLAN.startsOn} → ${DATED_PLAN.endsOn}`);

    resizeTo(LAPTOP);

    expect(document.querySelector('[data-start]')?.textContent).toBe('1 Jun');
    expect(document.querySelector('[data-finish]')?.textContent).toContain('3 Jun');
  });

  itDom('prints the workday offsets the columns print, on a plan with no start date', async () => {
    // The fallback, on both faces: without a project start date there are no
    // dates to shorten and both renderers count days from day zero.
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const onCard = document.querySelector('[data-card-span]');
    expect(onCard?.textContent).toBe('0 → 0');
    // Nothing fuller to say, so nothing said: a `title` repeating the cell is
    // noise a screen reader has to read out.
    expect(onCard?.getAttribute('title')).toBe(null);

    resizeTo(LAPTOP);

    expect(document.querySelector('[data-start]')?.textContent).toBe('0');
  });

  itDom('offers nothing to drag a card by', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.queryByRole('button', { name: 'Reorder 010' })).toBeNull();
  });
});

describe('a picker open on a card', () => {
  /**
   * codex #14's fourth contract: the open list owns the keyboard.
   *
   * The chords and the alt-arrows are not wired on a card at all — a phone has
   * neither — so what is left to own is Enter and Escape, and both are asserted
   * here rather than assumed from the table's version of this test.
   *
   * Proof: the `Enter` branch removed from the card's figure box, this failed
   * on `expected [] to deeply equal [ 'w1 role-dev p1' ]` — the key reaching
   * the box under the list and assigning nobody. Watched, 2026-08-09.
   */
  itDom('takes Enter for the list rather than the box under it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '4@ka' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(figure, { key: 'Enter' });

    await waitFor(() => {
      expect(api.assignments).toEqual(['w1 role-dev p1']);
    });
    // The mention goes with the pick and the estimate half stays exactly as it
    // was typed: `@ka` was a search, not part of a figure.
    expect(figure.value).toBe('4');
  });

  /**
   * Escape closes the list and strips nothing — what was typed is still on
   * screen to be corrected, which is the answer every picker in this app gives.
   *
   * Proof: the `Escape` branch removed, this failed on `expected <ul role=
   * "listbox" …> to be null` — a list nothing on a phone could close.
   * Watched, 2026-08-09.
   */
  itDom('closes on Escape and leaves what was typed', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    const figure = screen.getByLabelText<HTMLInputElement>('Dev estimate for 010');
    fireEvent.focus(figure);
    fireEvent.change(figure, { target: { value: '4@ka' } });
    fireEvent.keyDown(figure, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(figure.value).toBe('4@ka');
    expect(api.assignments).toEqual([]);
  });
});

describe('the toolbar sheet', () => {
  itDom('holds the toolbar, which is nowhere on the page until it is opened', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Add work item' })).toBeNull();

    openTheSheet();

    expect(await screen.findByRole('button', { name: 'Add work item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  /**
   * Taking a control on the sheet is taking it on the plan behind the sheet,
   * and 390px of screen cannot show both.
   *
   * Proof: `closingControlIn` pinned to null, this failed on `expected <button
   * …(2)></button> to be null` — the sheet still over the plan it had just
   * changed. Four other tests in this file failed with it, all on queries that
   * could not reach a plan Radix had marked `aria-hidden`. Watched, 2026-08-09.
   */
  itDom('closes when a control on it acts on the plan', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();

    expect(screen.queryByRole('button', { name: 'Add work item' })).toBeNull();
  });

  /**
   * The exemption, and the reason it is not a nicety: closing the sheet
   * unmounts the dialog its own trigger was about to open, and a phase change
   * is one of the things a phone most needs the sheet for.
   *
   * Proof, two faults, both watched 2026-08-09. The `aria-haspopup` exemption
   * removed: failed on `Unable to find an accessible element with the role
   * "dialog" and name "Phases"` — the sheet closed on the trigger's own click
   * and took the dialog with it. The surface check removed so a click anywhere
   * closes the sheet: `adds a phase from inside the sheet` failed the same way
   * one click later, on the dialog's own Add.
   */
  itDom('lets the phases dialog open from inside it', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Phases', exact: true }));

    expect(await screen.findByRole('dialog', { name: 'Phases' })).toBeInTheDocument();
  });

  /**
   * And works once it is open, which is the half the exemption above cannot
   * prove on its own.
   *
   * React sends a portal's events up the **React** tree, so every click inside
   * that dialog arrives at the sheet's own capture handler — and a rule that
   * only asked "is this a button" would close the sheet under the dialog,
   * mid-click, on the way to adding a phase.
   *
   * Proof: the `[data-modal-surface]` check removed from `closingControlIn`, this
   * failed on `Unable to find an accessible element with the role "dialog" and
   * name "Phases"` — the sheet closed under the dialog on the way to sending
   * the phase, taking the surface somebody was working on with it. Watched,
   * 2026-08-09, and only after the second assertion below was added: the phase
   * itself still lands, so the first one cannot see this at all.
   */
  itDom('adds a phase from inside the sheet', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await addAWorkItem();
    openTheSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Phases', exact: true }));
    await screen.findByRole('dialog', { name: 'Phases' });

    fireEvent.change(screen.getByLabelText('New phase'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));

    // The new phase reaches the cards behind both surfaces, which is what says
    // the refetch the dialog asked for was not thrown away with them.
    expect(await screen.findByLabelText('Review estimate for 010')).toBeInTheDocument();
    // And the dialog is still there to add a second one. This is the half the
    // line above cannot see: a sheet that closed under it would take the dialog
    // with it *after* the phase had already been sent.
    expect(screen.getByRole('dialog', { name: 'Phases' })).toBeInTheDocument();
  });

  /**
   * `F shadcn-foundation`'s window/chord split, met by this change's own
   * surface: `?` is listened for on `window`, so an open sheet has to hold it
   * back or the cheat sheet opens over the toolbar.
   *
   * Proof: the sheet's body moved out of `ModalContent` into a plain `<div>`,
   * this failed on `expected null not to be null` — the cheat sheet open over
   * the sheet, exactly as it was over `P phases-ui`'s dialog before `Modal`
   * existed. Watched, 2026-08-09.
   */
  /**
   * The other half of the close, and the one that shipped broken: a control
   * that aims the caret nowhere must leave Radix's own restore alone.
   *
   * `onCloseAutoFocus` refused that restore for **every** control, because the
   * flag behind it was set to `true` by any of them. So `Collapse all`, `Gantt`,
   * `Undo` and the exports all closed the sheet and dropped the focus on
   * `<body>` — nothing to type into, nothing to Tab from, on the one renderer
   * where the sheet is the only route to any of them.
   *
   * jsdom is a valid oracle here and only here: Radix's `FocusScope` restore is
   * a `focus()` call on the stored trigger, which jsdom does perform. What it
   * cannot see is the trap around it — `e2e/mobile.spec.ts` presses this same
   * button in Chromium for that.
   *
   * Proof: the assignment put back to the unconditional
   * `sheetControlTakesTheFocus.current = true` that shipped, this failed — alone
   * of the eighteen — on `expected <body style><div>…(1)</div></body> to be
   * <button …(5)></button>`. Watched, 2026-08-09.
   */
  itDom(
    'gives the focus back to the trigger when the control aimed the caret nowhere',
    async () => {
      const api = fakeApi();
      widthIs(PHONE);
      render(<WbsTable projectId="p1" api={api} />);
      await addAWorkItem();

      const trigger = screen.getByRole('button', { name: 'Plan actions' });
      openTheSheet();
      fireEvent.click(await screen.findByRole('button', { name: 'Collapse all' }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });
    },
  );

  /**
   * And the third control that does aim it, which is why the mark is not called
   * `data-lands-in-plan`: the cheat sheet focuses its own panel as it mounts,
   * and Radix's restore arrives on a timer after that.
   *
   * Proof: the `data-takes-the-focus` attribute struck off the `⌨` button, this
   * failed on `expected <button …(5)></button> to be <div role="dialog" …(4)>
   * …(6)</div>` — the focus pulled off a dialog that was still open, leaving
   * its Escape (listened for on the backdrop) with nothing to hear it. Watched,
   * 2026-08-09.
   */
  itDom('leaves the focus on the cheat sheet the sheet opened', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Keyboard shortcuts' }));
    await screen.findByRole('heading', { name: 'Keyboard shortcuts' });

    const panel = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await waitFor(() => {
      expect(document.activeElement).toBe(panel);
    });
  });

  itDom('offers no width control at all, because a card has no columns', async () => {
    /*
     * The placement rule for the width reset, asserted from the side that can
     * see it go wrong. `toolbarControls` is one array rendered in two places —
     * the desktop toolbar row and this sheet — so a control added to it reaches
     * the phone by construction, and the phone is drawing cards. The reset
     * lives in the table renderer's own branch instead, which this renderer
     * never takes.
     *
     * Seeded with a width already in force, or the control would be absent for
     * the wrong reason: on a project nobody has dragged a column in there is
     * nothing to render on either renderer, and the assertion would pass
     * against a reset that was in `toolbarControls` all along.
     *
     * Proof: the reset moved into `toolbarControls`, this failed on `expected
     * <button …(2)></button> to be null` — the control on the sheet at 390px.
     * Watched, 2026-08-09.
     */
    localStorage.setItem('wbs.columnWidths.p1', JSON.stringify({ number: 240 }));
    // And a dragged chart height, so the absence below is about the whole
    // layout reset rather than the widths half of it.
    localStorage.setItem('wbs.ganttHeight.p1', '500');
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();
    // The sheet really is holding the toolbar, which is what makes the absence
    // below a fact about this control rather than about an empty dialog.
    expect(await screen.findByRole('button', { name: 'Add work item' })).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    // And no handle anywhere on the page: the cards have no column edges to
    // grab, and the table that does is not rendered at all.
    expect(document.querySelectorAll('[data-resize-handle]').length).toBe(0);
  });

  itDom('holds the page’s own shortcuts back while it is open', async () => {
    const api = fakeApi();
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument();
    });
    openTheSheet();

    const sheet = await screen.findByRole('dialog', { name: 'Plan actions' });
    fireEvent.keyDown(sheet, { key: '?' });

    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});

describe('what a card says about capacity', () => {
  /**
   * A plan on a phone, arranged before the first render.
   *
   * `arrange` is handed the fake's own rows and teams, which is how a label and
   * a parallelism get onto a plan the cards themselves never write either to.
   */
  async function aPlan(
    arrange: (rows: WorkItemView[], teams: TeamView[], api: ReturnType<typeof fakeApi>) => void,
    howMany = 1,
  ): Promise<void> {
    const api = fakeApi();
    for (let at = 0; at < howMany; at += 1) await api.create('p1', { parentId: null });
    arrange(api.rows, api.teams, api);
    widthIs(PHONE);
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 010');
  }

  const teamOnCard = (): HTMLElement | null => document.querySelector('[data-card-team]');
  const parallelOnCard = (): HTMLElement | null => document.querySelector('[data-card-parallel]');

  itDom('names the team a row carries', async () => {
    await aPlan((rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' });
      // The set, because the set is what the card reads. The column beside it
      // is what a `PATCH` names and what an older release selects.
      rows[0].teamIds = ['t1'];
    });

    expect(teamOnCard()?.textContent).toBe('Billing');
    expect(teamOnCard()?.getAttribute('data-inherited')).toBeNull();
  });

  itDom('marks a team a row only inherits, and names where the label was written', async () => {
    // The card is the only face some readers have, and a leaf under a labelled
    // parent is on that parent's pool: its dates moved for a number written a
    // row above it. A card showing nothing there cannot explain them.
    //
    // Proof: `teamLabel` pointed back at the row's own set — the `teamName`
    // that change replaced, `teamLabelOf(soleTeamOf(row))` — and this failed on
    // `expected undefined to be '↳ Billing'`: the inheriting card drew no team
    // line at all. Watched 2026-08-13.
    await aPlan((rows, teams) => {
      teams.push({ id: 't1', name: 'Billing' });
      const [parent, child] = rows;
      parent.teamIds = ['t1'];
      child.parentId = parent.id;
      parent.rolledUp = true;
    }, 2);

    const cards = [...document.querySelectorAll('[data-card-team]')];
    expect(cards[0]?.textContent).toBe('Billing');
    expect(cards[1]?.textContent).toBe('↳ Billing');
    expect(cards[1]?.getAttribute('data-inherited')).toBe('true');
    expect(cards[1]?.getAttribute('title')).toContain('inherited from');
  });

  itDom('draws no team line at all where nothing above carries a label', async () => {
    await aPlan(() => {
      // Nothing arranged: the plan every project starts as.
    });

    expect(teamOnCard()).toBeNull();
  });

  itDom('says how many people a row runs at, and nothing at one', async () => {
    await aPlan((rows) => {
      rows[0].maxParallel = 3;
    });

    expect(parallelOnCard()?.textContent).toBe('3 at once');
    expect(parallelOnCard()?.getAttribute('data-card-parallel')).toBe('live');
  });

  itDom('leaves the line off a row nobody has widened', async () => {
    await aPlan(() => {
      // `maxParallel` is 1 on every row of every plan nobody has touched, and a
      // line saying "1 at once" under every card is furniture on a 390px
      // screen.
    });

    expect(parallelOnCard()).toBeNull();
  });

  itDom('says a parallelism is not applied where one person is named on the work', async () => {
    // C1's D3 on the phone: one human cannot work beside themselves, so the
    // number is stored and does nothing until the assignment goes.
    await aPlan((rows, _teams, api) => {
      const row = rows[0];
      row.maxParallel = 3;
      // Through the write path, because the fake derives both `assignees` and
      // `doesEveryPhase` from the assignments it holds — a row object with an
      // `assignees` written straight onto it is a shape the tree never sends.
      void api.assign(row.id, DEV.id, 'p1');
    });

    expect(parallelOnCard()?.textContent).toBe('3 at once (not applied)');
    expect(parallelOnCard()?.getAttribute('data-card-parallel')).toBe('inert');
  });

  itDom('says a parallelism on a parent is not applied either', async () => {
    // A parent holds no slices of its own, so the number decides nothing —
    // the same reading the table's cell makes, and it is made from the row
    // rather than from a prop so the two faces cannot drift.
    await aPlan((rows) => {
      const [parent, child] = rows;
      parent.maxParallel = 2;
      child.parentId = parent.id;
      parent.rolledUp = true;
    }, 2);

    expect(parallelOnCard()?.textContent).toBe('2 at once (not applied)');
  });
});
