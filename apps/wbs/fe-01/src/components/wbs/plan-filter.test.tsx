import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectApi, WorkItemView } from '@/lib/wbs-api';
import { DEV, fakeProjectApi as fakeApi, QA } from '@/testing/fake-project-api';

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

/** The `<tr>` whose number cell reads `number`. */
const rowFor = (number: string): HTMLElement => {
  const found = screen
    .getAllByRole('row')
    .find((tr) => tr.querySelector('[data-number]')?.textContent === number);
  if (found === undefined) throw new Error(`no row numbered ${number}`);
  return found;
};

describe('finding a work item in the tree', () => {
  /**
   * A plan with a match three levels down and a branch with nothing in it.
   *
   * ```
   * 010     Strip the walls
   *  010.1   Sockets
   *   010.1.1 Back boxes
   *  010.2   Skirting
   * 020     Paint
   *  020.1   Undercoat
   * ```
   */
  async function decorating(): Promise<ProjectApi & { rows: WorkItemView[] }> {
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
    await api.createWorkItem('p1', { parentId: sockets.id, afterId: null, name: 'Back boxes' });
    await api.createWorkItem('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    await api.createWorkItem('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });
    return api;
  }

  const EVERY_ROW = ['010', '010.1', '010.1.1', '010.2', '020', '020.1'];

  /** Renders the plan above and waits for it to be on screen. */
  async function shownPlan(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = await decorating();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
    return api;
  }

  const findBox = () => screen.getByLabelText<HTMLInputElement>('Find');

  const find = (typed: string) => {
    fireEvent.change(findBox(), { target: { value: typed } });
  };

  itDom('a project switch cannot show or apply the previous project’s query', async () => {
    const api = await decorating();
    const view = render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
    find('skirting');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.2']);
    });

    view.rerender(<WbsTable projectId="p2" api={api} />);

    expect(findBox().value).toBe('');
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
  });

  itDom('keeps the rows that place a match, and drops everything else', async () => {
    await shownPlan();

    find('back boxes');

    // `010` and `010.1` are context: without them the hit reads as a root of a
    // plan it is three levels inside.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
  });

  itDom('reveals a match inside a branch the reader had closed', async () => {
    await shownPlan();
    click('Collapse 010.1');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);

    find('back boxes');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
  });

  itDom('marks the row that matched, so the rows around it read as context', async () => {
    await shownPlan();

    find('back boxes');

    const hit = screen.getByLabelText('Name of 010.1.1');
    expect(hit.dataset['match']).toBe('true');
    expect(hit.style.background).not.toBe('');
    const ancestor = screen.getByLabelText('Name of 010.1');
    expect(ancestor.dataset['match']).toBeUndefined();
    expect(ancestor.style.background).toBe('');
  });

  itDom('shows the whole subtree under a matched parent', async () => {
    await shownPlan();

    find('strip');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    // Only the row whose own name matched is a hit; the three under it are
    // there because their parent is.
    expect(screen.getByLabelText('Name of 010').dataset['match']).toBe('true');
    expect(screen.getByLabelText('Name of 010.1').dataset['match']).toBeUndefined();
  });

  itDom('shows an empty table and says so when nothing matches', async () => {
    await shownPlan();

    find('plumbing');

    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText(/No matches for/).textContent).toContain('plumbing');
  });

  itDom('counts what is on screen against the whole plan', async () => {
    await shownPlan();

    find('back boxes');

    expect(screen.getByText('3 of 6 rows')).toBeDefined();
  });

  itDom('clearing the search puts the reader’s own collapse back', async () => {
    await shownPlan();
    click('Collapse 010.1');
    click('Collapse 020');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020']);

    find('back boxes');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    // Escape, which is how a search is left.
    fireEvent.keyDown(findBox(), { key: 'Escape' });

    expect(findBox().value).toBe('');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020']);
  });

  itDom('the expansion controls stand down while a search is on', async () => {
    await shownPlan();

    find('back boxes');

    // A triangle here would either lie about what the search opened or close a
    // branch holding the hit.
    expect(screen.queryByRole('button', { name: 'Collapse 010' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled();
  });

  itDom('the Find box is not a cell of the keyboard grid', async () => {
    await shownPlan();

    const box = findBox();
    expect(box.getAttribute('data-cell')).toBeNull();
    expect(box.closest('table')).toBeNull();
  });

  itDom('the arrows walk the rows a search left on screen', async () => {
    await shownPlan();
    find('skirting');
    expect(numbersOnScreen()).toEqual(['010', '010.2']);

    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.focus();
    name.setSelectionRange(name.value.length, name.value.length);
    fireEvent.keyDown(name, { key: 'ArrowDown' });

    // Not `010.1`: it is not on screen, so it is not in the grid the keys read
    // out of the committed DOM.
    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010.2'));
  });

  itDom('re-derives from the rows that came back, so a renamed row can leave', async () => {
    const api = await shownPlan();
    find('skirting');
    expect(numbersOnScreen()).toEqual(['010', '010.2']);

    const name = screen.getByLabelText('Name of 010.2');
    fireEvent.change(name, { target: { value: 'Trim' } });
    fireEvent.blur(name);

    // A row edited out of the match set disappears from the narrowed view.
    // Deliberate: the alternative is a table showing a row that no longer
    // answers the question on screen above it.
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    expect(api.rows.map((row) => row.name)).toContain('Trim');
    expect(screen.getByText('0 of 6 rows')).toBeDefined();
  });

  itDom('collapses every branch and opens them all again', async () => {
    await shownPlan();

    click('Collapse all');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    click('Expand all');
    expect(numbersOnScreen()).toEqual(EVERY_ROW);
  });

  itDom('remembers a collapsed branch across a remount', async () => {
    const api = await shownPlan();
    click('Collapse 010.1');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2', '020', '020.1']);
    });
  });

  itDom('remembers each project separately', async () => {
    const api = await shownPlan();
    click('Collapse all');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    cleanup();
    render(<WbsTable projectId="p2" api={api} />);

    // A different project has its own memory, and no memory means everything
    // open — not the shape the last project was left in.
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(EVERY_ROW);
    });
  });

  itDom('drops a remembered expansion that is not one, rather than obeying it', async () => {
    // localStorage is user-editable, so what comes back is a claim. A table
    // that cannot be opened until somebody clears storage by hand is a worse
    // answer than forgetting which triangles were pointing down.
    localStorage.setItem('wbs.expanded.p1', 'not json at all');

    await shownPlan();

    expect(localStorage.getItem('wbs.expanded.p1')).toBe('true');
  });
});

describe('narrowing the plan by facet', () => {
  beforeEach(showEveryColumn);

  /**
   * The `finding a work item in the tree` plan, with facts on it:
   *
   * ```
   * 010     Strip the walls   Billing, Ada on Dev, priority 10 (Critical)
   *  010.1   Sockets
   *   010.1.1 Back boxes      Wiring
   *  010.2   Skirting
   * 020     Paint             Dev and QA estimated
   *  020.1   Undercoat
   * ```
   *
   * Two teams and two people in the directory rather than one each, because the
   * question a facet control gets wrong is which of them it offers: the
   * directory holds every team in the deployment and this is one plan.
   */
  // The fake's own type rather than `ProjectApi & { rows }`: `labelWithTag` is
  // one of the writes this fixture models directly, and a narrowed return type
  // would hide it from the tag facet's case.
  async function aFacetedPlan(): Promise<ReturnType<typeof fakeApi>> {
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
    const back = await api.createWorkItem('p1', {
      parentId: sockets.id,
      afterId: null,
      name: 'Back boxes',
    });
    await api.createWorkItem('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    await api.createWorkItem('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });

    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    // Only one of the two is on the plan, which is what the control must offer.
    await api.patchWorkItem(strip.id, { serviceTeamId: billing.id });
    await api.patchWorkItem(back.id, { serviceTeamId: wiring.id });
    const ada = await api.addPerson('Ada', []);
    await api.addPerson('Bo', []);
    await api.assignPerson(strip.id, DEV.id, ada.id);
    await api.patchWorkItem(strip.id, { priority: 10 });
    await api.setEstimate(paint.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.setEstimate(paint.id, QA.id, { optimistic: 1, realistic: 2, pessimistic: 3 });

    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };

  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  const find = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Find'), {
      target: { value: typed },
    });
  };

  itDom('narrows to the rows carrying a team, and keeps the rows that place them', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Team Wiring');

    // `010` and `010.1` are context, exactly as they are under a typed name:
    // a hit three levels down with no ancestry is a tree lying about itself.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);
    expect(screen.getByLabelText('Name of 010.1.1').dataset['match']).toBe('true');
    expect(screen.getByLabelText('Name of 010.1').dataset['match']).toBeUndefined();
  });

  itDom('does not bring the subtree a typed name would bring', async () => {
    // R10 §4 and §9's Q2, Dany 2026-08-17: `Strip` means the branch, and
    // `assignee = Ada` means the rows Ada is on. The same row matched both
    // ways, and only one of them is a request for the work underneath.
    //
    // Ada and not `Team Billing`, which is what this was first written with and
    // is the wrong facet to ask the question through: the team facet reads the
    // **effective** team, so `010.1` and `010.2` carry Billing on their own
    // account by inheritance and stay on screen for a reason that has nothing
    // to do with rule 3. An assignee does not inherit — `row.assignees` is the
    // row's own — so what is left when Ada is ticked is rule 3 and nothing else.
    await aFacetedPlan();
    find('strip');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);

    find('');
    openFilters();
    tick('Assignee Ada');

    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('keeps the rows that inherit a ticked team, which is not rule 3', async () => {
    // The other half of the pair above, and the trap §8.5 names: a leaf drawing
    // its slots from an ancestor's pool is that team's work, so it answers the
    // facet itself. `010.1.1` is out because it carries a team of its own —
    // most-specific-wins, `effectiveTeamsOf`'s rule, not the filter's.
    await aFacetedPlan();
    openFilters();

    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
  });

  itDom('keeps a row that inherits a ticked tag while stating tags of its own', async () => {
    // The team case above with the rule ADR 0008 reversed. `010.1.1` carries a
    // team of its own and is therefore **out** of `Team Billing`; the same row
    // tagged `Ready` is still `Risk`, because a tag says what kind of thing the
    // work is and a child of a risky parent is risky. The two facets sitting
    // next to each other in one panel and answering by two rules is the whole
    // of what this change did, and this is where a reader can see it.
    //
    // Proof: `accumulate` in `effective-tag.ts` reduced to its stated half —
    // the override this change replaces — and this failed on
    // `expected [ '010' ] to deeply equal [ '010', '010.1' ]`. Watched
    // 2026-08-30.
    //
    // Its own fixture rather than `aFacetedPlan`, which carries no tags: a Tag
    // group appearing in the panel would change what every other case in this
    // describe is counting.
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
    await api.createWorkItem('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    const risk = await api.addTag('Risk');
    const ready = await api.addTag('Ready');
    api.labelWithTag(strip.id, [risk.id]);
    api.labelWithTag(sockets.id, [ready.id]);
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '020']);
    });
    openFilters();

    tick('Tag Risk');

    expect(numbersOnScreen()).toEqual(['010', '010.1']);
  });

  itDom('drops the subtree the moment a facet joins a name that was bringing one', async () => {
    await aFacetedPlan();
    find('strip');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);

    openFilters();
    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('takes a person on any step, a band by its name, and a step’s estimate', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Assignee Ada');
    expect(numbersOnScreen()).toEqual(['010']);
    tick('Assignee Ada');

    tick('Priority Critical');
    expect(numbersOnScreen()).toEqual(['010']);
    tick('Priority Critical');

    tick('Estimated for QA');
    expect(numbersOnScreen()).toEqual(['020']);
  });

  itDom('takes only the rows answering every facet ticked', async () => {
    await aFacetedPlan();
    openFilters();

    tick('Team Billing');
    tick('Estimated for Dev');

    // `010` is Billing's and has no estimate; `020` has both estimates and no
    // team. Nothing answers both, and the table says so rather than showing a
    // plan that looks emptied.
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText('0 of 6 rows')).toBeInTheDocument();
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
  });

  itDom('offers only the teams and the people this plan carries', async () => {
    // The directory holds `Wiring` **and** `Billing`, `Ada` **and** `Bo`; a
    // checkbox for a value no row has is a filter whose only answer is an
    // empty table.
    await aFacetedPlan();
    openFilters();

    expect(screen.getByLabelText('Team Billing')).toBeInTheDocument();
    expect(screen.getByLabelText('Team Wiring')).toBeInTheDocument();
    expect(screen.getByLabelText('Assignee Ada')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assignee Bo')).toBeNull();
    // Nobody has been given `Low`, so the ladder's other four rungs are not
    // offered either.
    expect(screen.getByLabelText('Priority Critical')).toBeInTheDocument();
    expect(screen.queryByLabelText('Priority Low')).toBeNull();
  });

  itDom('says how many facets are ticked, and clears them all in one', async () => {
    await aFacetedPlan();
    openFilters();
    tick('Team Billing');
    tick('Priority Critical');
    expect(screen.getByText('Filters (2)')).toBeInTheDocument();

    click('Clear filters');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    expect(screen.getByText('Filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  itDom('leaves the Find box alone when the ticks are cleared', async () => {
    // Two gestures, and each undoes its own half: Escape empties the box, and
    // this unticks the boxes. One control undoing the other's work is how a
    // reader loses a query they were still using.
    await aFacetedPlan();
    find('paint');
    openFilters();
    tick('Estimated for QA');

    click('Clear filters');

    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('paint');
    // `020.1 Undercoat` back with it, and that is the second thing this proves:
    // with the ticks gone the filter is a typed name again, so rule 3 is in
    // force again and `Paint` brings the work it is a heading for.
    expect(numbersOnScreen()).toEqual(['020', '020.1']);
  });

  itDom('stands the expansion controls down while a facet is on with nothing typed', async () => {
    // The controls read one flag, and until R10 that flag was the query alone:
    // a facet-only filter would have left `Collapse all` live over an
    // expansion the filter owns, and the triangles on rows the filter opened.
    await aFacetedPlan();
    openFilters();

    tick('Team Wiring');

    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Collapse 010' })).toBeNull();
  });

  itDom('narrows the chart with the table, because they are one list', async () => {
    // The half of Dany's sentence that reads like the hard part — "must affect
    // the gantt chart to only show what matches with the filter" — and it costs
    // nothing, because `shownRows` is what the panel is drawn from and a facet
    // narrows the same list a name already did (`gantt-panel.test.tsx`'s
    // `draws exactly the rows a search narrowed the plan to`, watched
    // 2026-08-09). Asserted here anyway: "for free" is a claim about a seam,
    // and a seam nothing holds is how the next change quietly re-routes it.
    await aFacetedPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    openFilters();
    tick('Team Wiring');

    expect(
      [...document.querySelectorAll('[data-gantt-label]')].map((label) => label.textContent),
    ).toEqual(['010 - Strip the walls', '010.1 - Sockets', '010.1.1 - Back boxes']);
  });

  itDom('keeps offering a ticked team after the last row carrying it has gone', async () => {
    // The tree refetches on everybody's edit, so the row a tick is aimed at can
    // leave while the tick is still in force. Dropping the box then would
    // narrow the plan to nothing with nothing on screen to untick.
    await aFacetedPlan();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    takeRowAction('010.1.1', 'Delete');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    expect(screen.getByLabelText('Team Wiring')).toBeChecked();
  });

  itDom('is empty on the next load, because an ad-hoc filter is not remembered', async () => {
    // R10 §9's Q6, Dany 2026-08-17: the plan you open is the whole plan. A
    // filter restored from a session nobody remembers setting is the "my rows
    // are gone" report, and it is the likeliest thing this change could break.
    const api = await aFacetedPlan();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1']);

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    openFilters();
    expect(screen.getByLabelText('Team Wiring')).not.toBeChecked();
  });
});

describe('narrowing the plan by service, and by the two mismatch signals', () => {
  beforeEach(showEveryColumn);

  /**
   * The faceted plan again with the third dimension on it, and the directory
   * facts the two signals are asked against:
   *
   * ```
   * 010     Strip the walls   team Billing, service Checkout, Ada on Dev
   *  010.1   Sockets          inherits both
   *   010.1.1 Back boxes      team Wiring, inherits Checkout
   *  010.2   Skirting         inherits both
   * 020     Paint             nothing
   *  020.1   Undercoat        nothing
   * ```
   *
   * `Wiring` owns `Checkout` and `Billing` owns nothing, so `010` is built by a
   * non-owner and `010.1.1` — the row whose own team is the owner — is not.
   * Ada belongs to `Wiring` and is on `010`, whose effective team is `Billing`,
   * so she is assigned outside it. Both facts are deliberately **not** true of
   * every row: a signal that flagged the whole plan would pass a test that only
   * counted flags.
   *
   * Two services in the directory and one on the plan, the same trap the team
   * facet's fixture sets: the control must offer what the plan carries, not
   * what the deployment knows about.
   */
  async function aServicedPlan(): Promise<
    ReturnType<typeof fakeApi> & {
      checkout: string;
      ledger: string;
      strip: string;
      billing: string;
      wiring: string;
    }
  > {
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
    const back = await api.createWorkItem('p1', {
      parentId: sockets.id,
      afterId: null,
      name: 'Back boxes',
    });
    await api.createWorkItem('p1', { parentId: strip.id, afterId: sockets.id, name: 'Skirting' });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    await api.createWorkItem('p1', { parentId: paint.id, afterId: null, name: 'Undercoat' });

    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    await api.patchWorkItem(strip.id, { serviceTeamId: billing.id });
    await api.patchWorkItem(back.id, { serviceTeamId: wiring.id });

    const checkout = await api.addService('Checkout');
    // In the directory and on no row — what the facet must not offer. One case
    // below puts it on `Strip` as a **second** service, and does so itself
    // rather than here, so every other case keeps the unlabelled `Ledger` this
    // fixture exists to offer.
    const ledger = await api.addService('Ledger');
    api.labelWithService(strip.id, [checkout.id]);

    const ada = await api.addPerson('Ada', [wiring.id]);
    await api.assignPerson(strip.id, DEV.id, ada.id);

    return Object.assign(api, {
      checkout: checkout.id,
      // The unlabelled service and the labelled row, handed back so the
      // two-service case can state its own labelling without this fixture
      // carrying it for every other case.
      ledger: ledger.id,
      strip: strip.id,
      billing: billing.id,
      wiring: wiring.id,
    });
  }

  /** Draw it, and wait for the six rows the fixture builds. */
  async function shown(api: ProjectApi): Promise<void> {
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    fireEvent.click(screen.getByText(/^Filters/));
  }

  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  itDom(
    'offers the services the plan carries, by name, and not the rest of the directory',
    async () => {
      const api = await aServicedPlan();
      await shown(api);

      expect(screen.getByLabelText('Service Checkout')).toBeInTheDocument();
      // `Ledger` is in the directory and on nothing here. Offering it would be a
      // box that provably empties the table — `optionsFor`'s whole argument.
      expect(screen.queryByLabelText('Service Ledger')).toBeNull();
    },
  );

  itDom('finds a row by the second service it delivers, which is task 10.2', async () => {
    // **The case 10.2's watched red drives, and it is the only one that can.**
    // Every other service case on this surface states one service per row, and a
    // row with one member reads identically through a set and through the
    // singleton fold the store used to force — so a fold left in would pass all
    // of them.
    //
    // `Strip` delivers `Checkout` **and** `Ledger`. Ticking `Ledger` must find
    // it. Injected on h2puni and watched red, chunk 15: the deleted `.map` in
    // `wbs-table.tsx` restored as `serviceIds.slice(0, 1)` — **1 fail, this
    // case, 1558 pass**. It failed one step earlier than written above:
    // `Unable to find a label with the text of: Service Ledger`. The facet is
    // built from the effective reading, so a fold does not merely narrow to
    // nothing — the second service never becomes a facet value at all, and the
    // box a user would tick is not on screen.
    const api = await aServicedPlan();
    api.labelWithService(api.strip, [api.checkout, api.ledger]);
    await shown(api);

    tick('Service Ledger');

    // The whole branch, because the three rows under `Strip` inherit both of its
    // services — the set is inherited whole, not by its first member.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
  });

  itDom('keeps the rows that inherit a ticked service, which is task 6.2', async () => {
    // **The case 6.2's watched red drives.** Only `010` states `Checkout`; the
    // three rows under it answer to it through `effectiveServicesOf`, and
    // `020`/`020.1` do not. Point the predicate at `row.serviceIds` — the row's
    // own stated set, a column until task 10.2 — instead of the effective reading and this drops to
    // `['010']`, which is why the fault could not be observed until a control
    // existed to tick. Injected on h2puni and watched red, chunk 9.
    const api = await aServicedPlan();
    await shown(api);

    tick('Service Checkout');

    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    expect(screen.getByLabelText('Name of 010.2').dataset['match']).toBe('true');
  });

  itDom(
    'stands both signal boxes down, with the reason, while the directory says nothing',
    async () => {
      // The design's first risk. A deployment ships with an empty ownership map
      // and nobody in a team, and in that state both signals answer `false` for
      // every row — which is "nobody has said", not "nothing is wrong". An
      // enabled box answering the second question is how a reader concludes the
      // feature is broken.
      const api = fakeApi();
      await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip the walls' });
      render(<WbsTable projectId="p1" api={api} />);
      await waitFor(() => {
        expect(numbersOnScreen()).toEqual(['010']);
      });
      fireEvent.click(screen.getByText(/^Filters/));

      const owner = screen.getByLabelText('Built by non-owner only');
      const outside = screen.getByLabelText('Assigned outside the team only');
      expect(owner).toBeDisabled();
      expect(outside).toBeDisabled();
      // Followed by hand rather than through `toHaveAccessibleDescription`:
      // jest-dom computes that through `dom-accessibility-api`, and a matcher
      // that quietly answers `''` on both boxes would pass this test in either
      // state. `describedBy` fails loudly instead — a missing attribute or a
      // dangling id throws here rather than reading as an empty description.
      const describedBy = (box: HTMLElement): string => {
        const id = box.getAttribute('aria-describedby');
        expect(id).toBeTruthy();
        const said = document.getElementById(id!);
        expect(said).not.toBeNull();
        return said?.textContent ?? '';
      };
      expect(describedBy(owner)).toMatch(/No team owns a service yet/);
      expect(describedBy(outside)).toMatch(/Nobody belongs to a team yet/);
      // Mouse readers get the same sentence, and it is the only place a hint
      // fits at this panel width.
      expect(owner.closest('label')).toHaveAttribute(
        'data-fact',
        expect.stringMatching(/No team owns/),
      );
    },
  );

  itDom('takes teams from a be-01 that has never heard of services', async () => {
    // The blue/green window, and this one is not hypothetical: three fixtures
    // in this repo already answer `listTeams` with `{ id, name }`, and the
    // first version of `ownershipKnown` threw `Cannot read properties of
    // undefined (reading 'length')` on all of them — a white screen for the
    // length of a deploy, in the render, not in a test-only shape.
    const api = await aServicedPlan();
    const older: ProjectApi = {
      ...api,
      listTeams: () =>
        Promise.resolve([
          { id: api.billing, name: 'Billing' },
          { id: api.wiring, name: 'Wiring' },
        ]),
    };
    await shown(older);

    // Drawn at all is most of the claim; the box is down because a server that
    // has never heard of services cannot have been told who owns one.
    expect(screen.getByLabelText('Built by non-owner only')).toBeDisabled();
  });

  itDom('narrows to the rows a non-owner is building, and not to every labelled row', async () => {
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    await shown(api);

    tick('Built by non-owner only');

    // `010.1.1` carries `Wiring` itself and `Wiring` owns `Checkout`, so the
    // row nearest the fault is the one **not** flagged. Without it in the
    // fixture this assertion would pass over a signal that flagged everything
    // wearing a service — chunk 5's over-broad-usage lesson, one dimension on.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);
  });

  itDom('narrows to the rows somebody outside the team is on', async () => {
    const api = await aServicedPlan();
    await shown(api);

    tick('Assigned outside the team only');

    // Ada is in `Wiring` and `010`'s effective team is `Billing`. The rows
    // under it inherit the team but not the assignee — `row.assignees` is the
    // row's own — so one row answers, not the branch.
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('marks the service cell of a row a non-owner is building, and says why', async () => {
    // **Task 7.2's first marker.** The facet cases above prove the rule; this
    // proves it reaches the cell it is about, with the sentence on it. A mark
    // that cannot say why is a mystery rather than a signal — 7.2's own words,
    // and the reason the whole string is asserted rather than its presence.
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    await shown(api);

    const said =
      'Built by a non-owner: Billing does not own Checkout.' +
      ' Nothing is blocked — the plan is recording this, not refusing it.';
    const mark = rowFor('010').querySelector('[data-mismatch="service"]');
    expect(mark?.getAttribute('data-fact')).toBe(said);
    // The same sentence to a reader with no pointer. `role="img"` and a label
    // rather than a `title` alone, which reaches a mouse only.
    expect(mark?.getAttribute('aria-label')).toBe(said);
    expect(mark?.getAttribute('role')).toBe('img');
    // `010.1.1` states `Wiring` itself, and `Wiring` owns `Checkout`: the row
    // nearest the fault is the one **not** marked. Without it this case would
    // pass over a marker that landed on every row wearing a service — chunk
    // 5's over-broad-usage lesson, on a third surface.
    expect(rowFor('010.1.1').querySelector('[data-mismatch="service"]')).toBeNull();
    // And it is the **effective** reading: `010.1` states no service of its own
    // and is marked, because what it inherits is what it is delivering.
    expect(rowFor('010.1').querySelector('[data-mismatch="service"]')).not.toBeNull();
  });

  itDom('names every offending service, and only the offending ones', async () => {
    // **The case the scope change needs and the only one that can drive it.**
    // Three services on the row, one of them owned: a sentence built from the
    // row's whole set names `Checkout` — which the team *does* own — and a
    // sentence taking the first offender names `Ledger` and drops `Search`.
    // Every other marker case here has one service, and one service reads
    // identically through either fault.
    const api = await aServicedPlan();
    const search = await api.addService('Search');
    api.labelWithService(api.strip, [api.checkout, api.ledger, search.id]);
    api.ownService(api.billing, api.checkout);
    await shown(api);

    const said = rowFor('010')
      .querySelector('[data-mismatch="service"]')
      ?.getAttribute('data-fact');
    expect(said).toContain('Billing does not own Ledger and Search.');
    // Said out loud, because it is half the claim: the owned service is not in
    // the sentence, so a reader is sent to the two that need looking at.
    expect(said).not.toContain('Checkout');
  });

  itDom('marks the assignee on a folded step, which is where every plan starts', async () => {
    // **Task 7.2's second marker, on the surface that is on screen by default.**
    // `unfoldedSteps` starts empty, so a marker living only in the unfolded `by`
    // column would be absent from every plan nobody has unfolded — the same
    // hiding this cell already refuses for a complaint.
    const api = await aServicedPlan();
    await shown(api);

    const said =
      'Assigned outside the team: Ada is not in Billing.' +
      ' Nothing is blocked — the plan is recording this, not refusing it.';
    const final = rowFor('010').querySelector('[data-final="step-dev"]');
    const mark = final?.querySelector('[data-mismatch="assignee"]');
    expect(mark?.getAttribute('aria-label')).toBe(said);
    // **No native `title` here**, unlike the service cell's mark: this cell's
    // one hint is its card, and a tooltip raced it over the same pixels
    // (2026-08-09). So the sentence moves to the card rather than being
    // dropped, and both halves of that are asserted.
    expect(mark?.getAttribute('data-fact')).toBeNull();
    fireEvent.mouseEnter(final as HTMLElement);
    expect(screen.getByRole('tooltip').textContent).toContain('Ada is not in Billing');
    // The team is inherited down the branch and the assignee is not, so the
    // rows under `010` carry no mark. Absence flagging nothing, on screen.
    expect(rowFor('010.1').querySelector('[data-mismatch="assignee"]')).toBeNull();
  });

  itDom('keeps the assignee mark when the step is unfolded, with its own sentence', async () => {
    // The other half of the same claim: unfolding moves the assignee into a
    // column of its own, and a marker that lived only on the folded cell would
    // vanish exactly when somebody looked closer.
    const api = await aServicedPlan();
    await shown(api);

    fireEvent.click(screen.getByRole('button', { name: 'Unfold Dev estimates' }));

    const cell = screen.getByLabelText('Dev assignee for 010').closest('td');
    const mark = cell?.querySelector('[data-mismatch="assignee"]');
    // A `title` here, where the folded cell has none: this column has no card
    // to fight, so the pointer gets the sentence the way the service cell's
    // does.
    expect(mark?.getAttribute('data-fact')).toContain('Ada is not in Billing');
  });

  itDom(
    'answers a pointer at every mark, by title or by the card that owns the hover',
    async () => {
      // **The case the three above cannot state between them.** Each of them
      // pins one mark's own attributes, so the pair drifting apart reads as two
      // green tests: 2026-08-22's cloud walk counted `title` in the DOM, found
      // the service mark carrying one and both assignee marks carrying `null`,
      // and filed it as one mark saying nothing to a pointer.
      //
      // It is not saying nothing — it is saying it through the card, because the
      // mark sits inside the cell whose hover opens that card. So the promise
      // worth asserting is the **outcome**, not the attribute: hover a mark, get
      // its sentence. Written over `querySelectorAll` rather than over two named
      // marks, so a third mark added anywhere on this row has to answer it too.
      //
      // Proof, three faults watched on h2puni 2026-08-22, one per way the pair
      // can drift. `title` dropped from the uncarded arm: `expected null to be
      // 'Built by a non-owner: Billing does no…'`. The card's sentence removed
      // (`folded-step-card.tsx`, the `doing?.outside` block): `expected 'Dev for
      // 010No estimate yetAdaDays as …' to contain 'Assigned outside the team:
      // Ada is not…'`. A `title` put back on the carded arm, which is the race
      // 2026-08-09 ended: `expected 'Assigned outside the team: Ada is not…' to
      // be null`. Three for three.
      const api = await aServicedPlan();
      api.ownService(api.wiring, api.checkout);
      await shown(api);

      const marks = [...rowFor('010').querySelectorAll('[data-mismatch]')];
      // Said out loud and by kind, because every assertion below is inside the
      // loop: a render that stopped drawing the marks would otherwise pass this
      // by having nothing left to check. One service mark, and two assignee
      // marks — Ada named on Dev and assumed onto QA.
      expect(marks.map((mark) => mark.getAttribute('data-mismatch')).sort()).toEqual([
        'assignee',
        'assignee',
        'service',
      ]);

      for (const mark of marks) {
        const note = mark.getAttribute('aria-label') ?? '';
        // The sentence exists at all before either route is asked about it.
        expect(note).toContain('Nothing is blocked — the plan is recording this, not refusing it.');
        const owner = mark.closest('[data-final]');
        if (owner === null) {
          // Nothing else owns this hover, so the mark carries the sentence
          // itself — and carries the **same** one, not a shorter cousin of it.
          expect(mark.getAttribute('data-fact')).toBe(note);
          continue;
        }
        // A card owns the hover. Both halves: no `title` to race it, and the
        // sentence really is on the card the same hover opens.
        expect(mark.getAttribute('data-fact')).toBeNull();
        fireEvent.mouseEnter(owner);
        expect(screen.getByRole('tooltip').textContent).toContain(note);
        fireEvent.mouseLeave(owner);
      }
    },
  );

  itDom('marks the step nobody named, where the assumption puts them on it', async () => {
    // **The surface every other assignee case here walks straight past.** Ada is
    // named on Dev alone, so `doesEveryStep` puts her on QA as an assumption,
    // and a step the plan says she is doing is work assigned to her.
    //
    // Written during chunk 17's injection round, which is also how the branch
    // that used to serve it got deleted: `assigneeOn` carried a special arm for
    // the assumed case, F4 forced it off, and every case stayed green — because
    // an assumption is the row's own single stated assignee, so the ordinary
    // path had been answering it all along. The arm went; this case stays,
    // because nothing else asserts an assumed step is marked at all.
    const api = await aServicedPlan();
    await shown(api);

    const qa = rowFor('010').querySelector('[data-final="step-qa"]');
    const mark = qa?.querySelector('[data-mismatch="assignee"]');
    // The same sentence as the named step beside it. A step the plan says she
    // is doing is work assigned to her, and a marker that went quiet exactly
    // where nobody has looked at the assignment would be quiet where it is most
    // needed.
    expect(mark?.getAttribute('aria-label')).toContain('Ada is not in Billing');
  });

  itDom('leaves a ticked signal live after somebody empties the map under it', async () => {
    // Ticked wins. Somebody in the directory clears the last owned service
    // while this reader is filtered by the signal: the map arrives empty on the
    // next refetch and the box would go down with the tick still in force — a
    // filter nobody can leave, an empty table and a greyed-out control that
    // emptied it. It stays live so it can be turned off, and turning it off
    // puts the plan back.
    const api = await aServicedPlan();
    api.ownService(api.wiring, api.checkout);
    let notify: () => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
    });
    fireEvent.click(screen.getByText(/^Filters/));

    tick('Built by non-owner only');
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.2']);

    // Somebody else's directory edit, arriving the way every other one does.
    api.disownService(api.wiring, api.checkout);
    notify();
    await waitFor(() => {
      expect(screen.getByLabelText('Built by non-owner only')).toBeChecked();
    });

    const owner = screen.getByLabelText('Built by non-owner only');
    expect(owner).not.toBeDisabled();
    // **And the answer went the other way, which is the finding.** An empty
    // ownership map does not make the signal quiet: `builtByNonOwner` asks
    // whether one of the row's teams owns the service, and with nobody owning
    // anything the answer is "no" for every labelled row. Four of the six here
    // — the whole branch under `010`, `010.1.1` included, because `Wiring` has
    // just stopped owning `Checkout` too. That is the marker-on-most-of-a-plan
    // failure `label-mismatch.ts` argues against, arriving through the
    // directory rather than through the rule, and it is the real reason the box
    // is stood down while the map is empty.
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2']);
    fireEvent.click(owner);
    expect(numbersOnScreen()).toEqual(['010', '010.1', '010.1.1', '010.2', '020', '020.1']);
  });
});

describe('saved views, per browser', () => {
  beforeEach(showEveryColumn);

  /**
   * Where this browser remembers `p1`'s saved views — the key F4 writes.
   */
  const KEY = 'wbs.views.p1';

  /**
   * ```
   * 010  Strip the walls   Billing
   * 020  Paint
   * ```
   *
   * One team on one row, which is enough to ask what a saved view stores and
   * what happens once the team it named is gone.
   */
  async function aPlanWithATeam(): Promise<ProjectApi & { rows: WorkItemView[] }> {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    await api.createWorkItem('p1', { parentId: null, afterId: strip.id, name: 'Paint' });
    const billing = await api.addTeam('Billing');
    await api.patchWorkItem(strip.id, { serviceTeamId: billing.id });

    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };
  const openViews = () => {
    fireEvent.click(screen.getByText(/^Views/));
  };
  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };
  const find = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Find'), {
      target: { value: typed },
    });
  };
  const nameTheView = (typed: string) => {
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name this view'), {
      target: { value: typed },
    });
  };

  itDom('offers no Save while nothing is filtered', async () => {
    // A view of the whole plan has nothing to be picked back to, since
    // opening the project already shows it — the same bargain `Clear
    // filters` makes over in `FilterFacets`.
    await aPlanWithATeam();
    openViews();

    nameTheView('Everything');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('remembers a view once something is actually filtered', async () => {
    await aPlanWithATeam();
    openFilters();
    tick('Team Billing');
    openViews();
    nameTheView('Billing only');
    click('Save');

    expect(screen.getByText('Views (1)')).toBeInTheDocument();
    expect(screen.getByText('Billing only')).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as {
      name: string;
      criteria: unknown;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Billing only');
    expect(stored[0].criteria).toMatchObject({ query: '', teamIds: [expect.any(String)] });
  });

  itDom('applies a saved view: the Find box and the ticks together, in one gesture', async () => {
    await aPlanWithATeam();
    find('paint');
    openFilters();
    tick('Team Billing');
    // `020` (Paint) answers the name but not the team, so nothing is on
    // screen — proving the saved criteria really is both halves together.
    expect(numbersOnScreen()).toEqual([]);
    openViews();
    nameTheView('Nothing');
    click('Save');

    // Leave the view for the whole plan, the same as a reader who moved on:
    // clear the box and untick the box the save just read. Both panels are
    // already open, so nothing here re-toggles either `<details>`.
    find('');
    tick('Team Billing');
    expect(numbersOnScreen()).toEqual(['010', '020']);

    fireEvent.click(screen.getByText('Nothing'));

    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('paint');
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByLabelText('Team Billing')).toBeChecked();
  });

  itDom('deletes a saved view, and forgets it in storage too', async () => {
    await aPlanWithATeam();
    find('strip');
    openViews();
    nameTheView('Strip');
    click('Save');
    expect(screen.getByText('Views (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete view Strip' }));

    expect(screen.queryByText('Strip')).toBeNull();
    expect(screen.getByText('Views')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([]);
  });

  itDom('never writes a view merely by typing or ticking — only Save does', async () => {
    // The regression this change must not cause: an ad-hoc filter (R10 §9's
    // Q6) is a different state to `savedViews`, and F4 must not blur them —
    // ticking a box must not silently start a view nobody named.
    await aPlanWithATeam();
    find('strip');
    openFilters();
    tick('Team Billing');

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  itDom('is gone on the next load if never saved, but a saved view survives it', async () => {
    const api = await aPlanWithATeam();
    find('strip');
    openViews();
    nameTheView('Strip');
    click('Save');
    find('');

    cleanup();
    render(<WbsTable projectId="p1" api={api} />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });

    // The ad-hoc half is gone, exactly as Q6 requires.
    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('');
    // The named half is not — that is the whole point of F4.
    openViews();
    expect(screen.getByText('Strip')).toBeInTheDocument();
  });

  itDom('drops a hand-edited store that is not a list, and offers no views', async () => {
    localStorage.setItem(KEY, '{"not": "a list"}');
    await aPlanWithATeam();

    openViews();
    expect(screen.getByText('No saved views yet.')).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /** The hidden-columns store, which a saved view writes when it carries columns. */
  const HIDDEN_KEY = 'wbs.hiddenColumns.p1';
  const RESET_MARKER = 'wbs.linksResetShown.p1';
  const columnsOnScreen = (): string[] =>
    screen.getAllByRole('columnheader').map((th) => th.getAttribute('data-column') ?? '');
  const toggleColumn = (label: string) => {
    fireEvent.click(screen.getByText('Columns'));
    const panel = document.querySelector<HTMLElement>('[data-columns-panel]');
    if (panel === null) throw new Error('the Columns control opened no panel');
    fireEvent.click(within(panel).getByLabelText(label));
  };

  itDom('remembers the columns on screen with the filter, and puts them back with it', async () => {
    // `configurable-columns`: a view is *how one reader is looking at a plan*,
    // and which columns are on screen is part of that look. Saved with Depends
    // on hidden; shown again; picked — and hidden again, in storage too.
    await aPlanWithATeam();
    toggleColumn('Depends on');
    expect(columnsOnScreen()).not.toContain('depends');
    find('strip');
    openViews();
    nameTheView('Narrow');
    click('Save');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as { hiddenColumnIds?: unknown }[];
    expect(stored[0]?.hiddenColumnIds).toEqual(['depends']);

    toggleColumn('Depends on');
    expect(columnsOnScreen()).toContain('depends');
    find('');
    localStorage.setItem(RESET_MARKER, 'true');

    fireEvent.click(screen.getByText('Narrow'));
    expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('strip');
    expect(columnsOnScreen()).not.toContain('depends');
    expect(localStorage.getItem(HIDDEN_KEY)).toBe(JSON.stringify(['depends']));
    expect(localStorage.getItem(RESET_MARKER)).toBeNull();

    localStorage.removeItem(HIDDEN_KEY);
    cleanup();
    render(<WbsTable projectId="p1" api={fakeApi()} />);
    await waitFor(() => {
      expect(columnsOnScreen()).not.toContain('refs');
    });
  });

  itDom(
    'leaves the columns alone when picking a view saved before column sets existed',
    async () => {
      localStorage.setItem(
        KEY,
        JSON.stringify([
          {
            id: 'old',
            name: 'Older',
            criteria: {
              query: 'strip',
              teamIds: [],
              assigneeIds: [],
              priorityBands: [],
              estimatedStepIds: [],
              unestimated: false,
              critical: false,
            },
          },
        ]),
      );
      await aPlanWithATeam();
      toggleColumn('Priority');
      expect(columnsOnScreen()).not.toContain('priority');
      localStorage.setItem(RESET_MARKER, 'true');

      openViews();
      fireEvent.click(screen.getByText('Older'));
      expect(screen.getByLabelText<HTMLInputElement>('Find').value).toBe('strip');
      expect(columnsOnScreen()).not.toContain('priority');
      expect(localStorage.getItem(HIDDEN_KEY)).toBe(JSON.stringify(['priority']));
      expect(localStorage.getItem(RESET_MARKER)).toBe('true');
    },
  );

  itDom(
    'drops a view whose column set is not a list of strings, and keeps the one beside it',
    async () => {
      // Proof: `isAbsentOrStringArray(claimed['hiddenColumnIds'])` dropped from
      // `isSavedView`, this failed on `expected 'Views (2)' …` — the malformed
      // view offered, to be applied as a column set the table cannot read.
      // Watched, 2026-08-28.
      const criteria = {
        query: 'x',
        teamIds: [],
        assigneeIds: [],
        priorityBands: [],
        estimatedStepIds: [],
        unestimated: false,
        critical: false,
      };
      localStorage.setItem(
        KEY,
        JSON.stringify([
          { id: 'a', name: 'Good', criteria, hiddenColumnIds: ['depends'] },
          { id: 'b', name: 'Bad', criteria, hiddenColumnIds: 3 },
        ]),
      );
      await aPlanWithATeam();
      openViews();
      expect(screen.getByText('Views (1)')).toBeInTheDocument();
      expect(screen.getByText('Good')).toBeInTheDocument();
      expect(screen.queryByText('Bad')).toBeNull();
    },
  );

  itDom('drops one unusable saved view and keeps the rest', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: 'a',
          name: 'Good',
          criteria: {
            query: 'x',
            teamIds: [],
            assigneeIds: [],
            priorityBands: [],
            estimatedStepIds: [],
            unestimated: false,
            critical: false,
          },
        },
        {
          id: 'b',
          name: '',
          criteria: {
            query: '',
            teamIds: [],
            assigneeIds: [],
            priorityBands: [],
            estimatedStepIds: [],
            unestimated: false,
            critical: false,
          },
        },
        { id: 'c', criteria: {} },
      ]),
    );
    await aPlanWithATeam();

    openViews();
    expect(screen.getByText('Views (1)')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
  });

  itDom('a view naming a team since deleted narrows to nothing, not to a crash', async () => {
    // Stands in for the team the view named being removed from the directory
    // outright, the same as the row it labelled having its team cleared
    // underneath it: the id in the stored criteria answers to nothing on
    // this plan from the first render on.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: 'ghost',
          name: 'Ghost team',
          criteria: {
            query: '',
            teamIds: ['team-does-not-exist'],
            assigneeIds: [],
            priorityBands: [],
            estimatedStepIds: [],
            unestimated: false,
            critical: false,
          },
        },
      ]),
    );

    await aPlanWithATeam();
    openViews();
    fireEvent.click(screen.getByText('Ghost team'));

    // Empty means empty — the same answer any other facet gives when nothing
    // on the plan carries the value asked for. No crash, no fallback to the
    // whole table.
    expect(numbersOnScreen()).toEqual([]);
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
    openFilters();
    expect(screen.getByLabelText('Team a team this plan has not loaded')).toBeChecked();
  });
});

describe('what the filter says it dropped, and what it exports', () => {
  beforeEach(showEveryColumn);

  /**
   * Two roots with a dependency between them, both leaves so both are placed:
   *
   * ```
   * 010  Strip the walls   Billing
   * 020  Paint             Wiring, waits for 010
   * ```
   *
   * A team on each, so one tick keeps one row and hides the other end of the
   * only stored edge on the plan — which is the whole state F3 is about.
   */
  async function twoTeamsOneEdge(): Promise<ProjectApi> {
    const api = fakeApi();
    const strip = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Strip the walls',
    });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    const billing = await api.addTeam('Billing');
    const wiring = await api.addTeam('Wiring');
    await api.patchWorkItem(strip.id, { serviceTeamId: billing.id });
    await api.patchWorkItem(paint.id, { serviceTeamId: wiring.id });
    await api.setEstimate(strip.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.setEstimate(paint.id, DEV.id, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.addDependency(paint.id, strip.id);

    render(<WbsTable projectId="p1" api={api} projectName="Rewire the shed" />);
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    return api;
  }

  const openFilters = () => {
    fireEvent.click(screen.getByText(/^Filters/));
  };
  const tick = (label: string) => {
    fireEvent.click(screen.getByLabelText(label));
  };

  /**
   * What a download was handed and what it was filed as — jsdom implements
   * neither the object URL nor a click that saves, so both are replaced for the
   * length of a test. The same shape `sharing the plan` uses above, written
   * again rather than hoisted: that block's copy is scoped to its own
   * `afterEach`, and one shared stub restored in two places is how a test that
   * passes alone fails in a suite.
   */
  const captureDownloads = (): { blobs: Blob[]; names: string[] } => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    const urls = URL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    urls.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return `blob:on-screen-${String(blobs.length)}`;
    };
    urls.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function capture(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    return { blobs, names };
  };

  /** The bytes of a downloaded blob, through `FileReader` — jsdom's Blob has no `text()`. */
  const readBlobText = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const read = reader.result;
        if (typeof read === 'string') resolve(read);
        else reject(new Error('the downloaded blob read back as something else'));
      };
      reader.onerror = () => {
        reject(new Error('the downloaded blob could not be read'));
      };
      reader.readAsText(blob);
    });

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(HTMLAnchorElement.prototype, 'click');
  });

  /** The chart's sentence about the waits it did not draw, or null. */
  const droppedSentence = (): string | null =>
    document.querySelector('[data-gantt-dropped-links]')?.textContent ?? null;

  itDom(
    'says under the chart that a wait went undrawn, and says it only while filtering',
    async () => {
      await twoTeamsOneEdge();
      fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
      await screen.findByLabelText('Gantt chart');
      expect(droppedSentence()).toBeNull();

      openFilters();
      tick('Team Wiring');

      // `020` is drawn and the row it waits for is not, so the bar sits at a date
      // with nothing on the chart holding it there. R10 §9's Q7: the edge is not
      // pulled back — one edge can drag a whole plan in — it is counted and said.
      expect(numbersOnScreen()).toEqual(['020']);
      expect(droppedSentence()).toBe(
        'Not drawn: 1 wait whose other end this filter is hiding — 1 stored dependency. ' +
          'Clear the filter to see it.',
      );

      tick('Team Wiring');

      expect(droppedSentence()).toBeNull();
    },
  );

  itDom('counts the wait that leaves a shown row for a hidden one', async () => {
    // The direction the chart could not see before F3: `010` is on screen and
    // its **successor** is not, so its bar loses the arrow that left it.
    await twoTeamsOneEdge();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    openFilters();
    tick('Team Billing');

    expect(numbersOnScreen()).toEqual(['010']);
    expect(droppedSentence()).toContain('1 stored dependency');
  });

  itDom('downloads what is on screen, with a header saying what was filtered out', async () => {
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    openFilters();
    tick('Team Wiring');

    click('Download what’s on screen');

    expect(downloads.names).toHaveLength(1);
    // `-on-screen`, off the scope itself: two documents of one plan taken on
    // one day would otherwise land in a folder under the same name, and the
    // one with rows missing is the one nobody can tell apart afterwards.
    expect(downloads.names[0]).toMatch(/^rewire-the-shed-\d{4}-\d{2}-\d{2}-on-screen\.md$/);
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    const text = await readBlobText(file);
    // What it holds, what kept it, and the two things a reader of a partial
    // document cannot work out for themselves: that the figures were not
    // recomputed, and that a Depends on points somewhere this file has not got.
    expect(text).toContain(
      '**Scope:** what one reader had on screen, not the whole plan — 1 of 2 rows, kept by: team Wiring.',
    );
    expect(text).toContain("The figures are the whole plan's schedule unchanged");
    expect(text).toContain(
      '1 Depends on reference points at a work item this document does not hold',
    );
    expect(text).toContain('| Paint |');
    expect(text).not.toContain('| Strip the walls |');
  });

  itDom('downloads the chart as an .svg from the Export menu', async () => {
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');

    click('Download chart as SVG');

    // The same file the panel's own ⇩ writes, which is the whole claim: the
    // menu lends the act rather than owning a second builder.
    expect(downloads.names).toEqual([
      expect.stringMatching(/^gantt-chart-\d{4}-\d{2}-\d{2}\.svg$/),
    ]);
    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    expect(file.type).toBe('image/svg+xml;charset=utf-8');
    expect(await readBlobText(file)).toContain('<svg');
    expect(toastTexts()).toEqual([]);
  });

  itDom('refuses the chart the menu has no drawing of, and says where it is', async () => {
    // The window the fault lives in is the one where the panel is **not**
    // mounted: the file is a clone of the live `<svg>`, so a menu holding a
    // stale downloader would serialize a chart that left the page — or throw
    // inside a click handler, which is a button that does nothing.
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await screen.findByLabelText('Gantt chart');
    fireEvent.click(screen.getByRole('button', { name: 'Gantt' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Gantt chart')).toBeNull();
    });

    click('Download chart as SVG');

    expect(downloads.names).toEqual([]);
    expect(toastTexts()).toEqual([
      'There is no chart on screen to download. Open the Gantt and try again.',
    ]);
  });

  itDom('leaves the four whole-plan exports claiming the whole plan', async () => {
    // R10 §9's Q3, settled 2026-08-17: the export does not follow the filter,
    // and the second action is why it does not have to. A filtered plan
    // downloaded through the old button is still every row, and still says so.
    const downloads = captureDownloads();
    await twoTeamsOneEdge();
    openFilters();
    tick('Team Wiring');
    expect(numbersOnScreen()).toEqual(['020']);

    click('Download CSV');

    const file = downloads.blobs.at(0);
    if (file === undefined) throw new Error('nothing was handed to createObjectURL');
    const text = await readBlobText(file);
    expect(text).toContain('Strip the walls');
    expect(text).toContain('Paint');
    expect(text).not.toContain('Scope');
  });
});
