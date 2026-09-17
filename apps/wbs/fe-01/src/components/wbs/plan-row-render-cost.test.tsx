import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV, fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

import type * as InlineMarkdownModule from './inline-markdown';
import type * as PlanCellPropsModule from './plan-cell-props';
import type * as PlanIndexesModule from './plan-indexes';
import type * as PlanSpanModule from './plan-span';
import type * as TableFrameModule from './table-frame';
import { WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

/**
 * How many `<td>`/`<th>` render boundaries performed their layout work,
 * counted through {@link flexibleCellStyle}. Heading styles are resolved only
 * when layout changes; body cells have their own memo boundary, so this
 * detects an unrelated body cell escaping it.
 */
const cellStyleCalls = vi.hoisted(() => ({ count: 0 }));

/** How many times the Start sentence was worked out from scratch. */
const startSentenceCalls = vi.hoisted(() => ({ count: 0 }));

/** How many times one row's two printed days were worked out. */
const spanCalls = vi.hoisted(() => ({ count: 0 }));

/** How many Name cell bodies reached their first-line renderer. */
const nameCellRenders = vi.hoisted(() => ({ count: 0 }));

/** How many times each index over the whole plan was rebuilt. */
const indexBuilds = vi.hoisted(() => ({ rowsById: 0, assignedSteps: 0, byId: 0 }));

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

vi.mock('./plan-span', async (importOriginal) => {
  const real = await importOriginal<typeof PlanSpanModule>();
  return {
    ...real,
    spanOfRow: (...args: Parameters<typeof real.spanOfRow>) => {
      spanCalls.count += 1;
      return real.spanOfRow(...args);
    },
  };
});

vi.mock('./inline-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof InlineMarkdownModule>();
  return {
    ...real,
    renderName: (...args: Parameters<typeof real.renderName>) => {
      nameCellRenders.count += 1;
      return real.renderName(...args);
    },
  };
});

vi.mock('./plan-indexes', async (importOriginal) => {
  const real = await importOriginal<typeof PlanIndexesModule>();
  return {
    ...real,
    indexRowsById: (...args: Parameters<typeof real.indexRowsById>) => {
      indexBuilds.rowsById += 1;
      return real.indexRowsById(...args);
    },
    assignedSteps: (...args: Parameters<typeof real.assignedSteps>) => {
      indexBuilds.assignedSteps += 1;
      return real.assignedSteps(...args);
    },
    indexById: (...args: Parameters<typeof real.indexById>) => {
      indexBuilds.byId += 1;
      return real.indexById(...args);
    },
  };
});

vi.mock('./plan-cell-props', async (importOriginal) => {
  const real = await importOriginal<typeof PlanCellPropsModule>();
  return {
    ...real,
    readStartSentence: (...args: Parameters<typeof real.readStartSentence>) => {
      startSentenceCalls.count += 1;
      return real.readStartSentence(...args);
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  cellStyleCalls.count = 0;
  startSentenceCalls.count = 0;
  spanCalls.count = 0;
  nameCellRenders.count = 0;
  indexBuilds.rowsById = 0;
  indexBuilds.assignedSteps = 0;
  indexBuilds.byId = 0;
});

/** Every column on screen, so the Depends on cell is one of the readers. */
const showEveryColumn = (): void => {
  localStorage.setItem('wbs.hiddenColumns.p1', '[]');
};

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

describe('what one row costs per render', () => {
  itDom('a broad Find rerenders only the cells whose filter reading changed', async () => {
    const api = fakeApi();
    for (const name of ['Road', 'River', 'Rock']) {
      await api.createWorkItem('p1', { parentId: null, afterId: null, name });
    }
    render(<WbsTable projectId="p1" api={api} />);
    await screen.findByLabelText('Name of 030');

    cellStyleCalls.count = 0;
    nameCellRenders.count = 0;
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'R' } });

    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(nameCellRenders.count).toBeGreaterThan(0);
    expect(nameCellRenders.count).toBeLessThanOrEqual(6);
    // React's deferred development pass can render the three Name cells twice.
    // No other body cell may reach its style work.
    expect(cellStyleCalls.count).toBeLessThanOrEqual(6);
  });

  itDom('keeps explicit unchanged cells behind their stable component boundary', async () => {
    // Proof: replacing `memo(PlanCellContentView, ...)` with the view itself
    // failed below on `expected 4 to be +0`: all four Name cells rendered for
    // a toolbar state change that altered no row input. Watched 2026-09-08.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    expect(nameCellRenders.count).toBeGreaterThan(0);
    nameCellRenders.count = 0;
    cellStyleCalls.count = 0;
    click('Freeze #');

    expect(cellStyleCalls.count).toBe(0);
    expect(nameCellRenders.count).toBe(0);
  });

  itDom('opens one cell card without rendering any unrelated row', async () => {
    // Proof: with `WbsTable` subscribed to `cellCards` again, opening this one
    // card failed below on `expected 60 to be +0`. Watched 2026-09-08.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    // The counter is wired before it is used as an absence assertion. A mock
    // that never saw production would otherwise make zero true for free.
    expect(cellStyleCalls.count).toBeGreaterThan(0);
    const final = screen
      .getByLabelText('Name of 010')
      .closest('tr')
      ?.querySelector('[data-final="step-dev"]');
    if (!(final instanceof HTMLElement)) throw new Error('row 010 has no Dev final cell');

    cellStyleCalls.count = 0;
    fireEvent.mouseEnter(final);

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(cellStyleCalls.count).toBe(0);
  });

  itDom('keeps each Start sentence while its span and chart floor stay unchanged', async () => {
    // Three readers ask for it: the `<td>`'s own props, the `cursor: help`
    // decided beside them, and the Start cell itself. Each call allocates a
    // `Date` inside `spanOf` and walks the floor map, so on a 1,000-row plan
    // the difference is two thousand of each per render.
    //
    // Proof: `startSentence`'s `saidByRow` lookup bypassed in `wbs-table.tsx`
    // — the shape this memo replaces — this failed on `expected 9 to be 3`:
    // three sentences worked out per row where there is one. Watched
    // 2026-09-08.
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }

    const columns = document.querySelectorAll('thead th').length;
    const rows = document.querySelectorAll('tbody tr').length;
    expect(rows).toBe(3);
    expect(columns).toBeGreaterThan(0);

    cellStyleCalls.count = 0;
    startSentenceCalls.count = 0;
    spanCalls.count = 0;
    // A toolbar-only gesture changes neither input to a Start sentence.
    click('Freeze #');

    expect(cellStyleCalls.count).toBe(0);
    expect(startSentenceCalls.count).toBe(0);
    // The row projection is unchanged, so its already explicit span and Start
    // sentence are not rebuilt for this toolbar-only render.
    //
    // Proof: adding `freezeMenuOpen` to the row projection's inputs failed
    // below on `expected 3 to be +0`: the menu rebuilt all three spans despite
    // changing no row reading. Watched 2026-09-08.
    expect(spanCalls.count).toBe(0);
  });

  itDom('rebuilds no index over the plan for a gesture that changes no row', async () => {
    // Both indexes answer a question every cell of a column asks — which row an
    // id names, and whether anybody is assigned in a step — and both used to be
    // answered by a scan of `flat` **per call**. That is rows × rows and
    // rows × steps × rows per render; the memo makes it one pass per tree read.
    //
    // Proof, both watched 2026-09-08 with the `useMemo` around each index
    // dropped so it is rebuilt inside the callback it feeds: `expected 1 to be
    // +0` for the row index — one rebuild for the one dependency on screen —
    // and `expected 8 to be +0` for the assigned steps, for a gesture that
    // touched no row at all. The directory index is the third: `teamsById`
    // rebuilt inside `teamNamesOn` failed on `expected 2 to be +0`, one rebuild
    // per assignee on screen.
    showEveryColumn();
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    for (const number of ['010', '020', '030']) {
      click('Add work item');
      await screen.findByLabelText(`Name of ${number}`);
    }
    // A row that waits for another, because the row index is only ever asked
    // about an id somebody holds: with no dependencies at all `dependenciesOf`
    // maps over an empty list and the faulted build inside it is never
    // reached, which would leave the `toBe(0)` below true for the wrong reason.
    const first = api.rows.at(0);
    const third = api.rows.at(2);
    if (first === undefined || third === undefined) throw new Error('the plan has no three rows');
    await api.addDependency(third.id, first.id);
    // And somebody assigned, because the two directory lookups sit behind the
    // markers: `assigneeOn` answers null and `teamNamesOn` is never reached on a
    // plan nobody is named on, which would leave the `byId` count at zero
    // whatever the memo does. Watched: with the team index rebuilt per call and
    // no assignee in the fixture, this case passed.
    const dana = await api.addPerson('Dana', []);
    await api.assignPerson(first.id, DEV.id, dana.id);
    click('Add work item');
    await screen.findByLabelText('Name of 040');

    // The counters are wired: building the plan built each index at least once.
    // Without this the assertion below is satisfied by a mock that never ran.
    expect(indexBuilds.rowsById).toBeGreaterThan(0);
    expect(indexBuilds.assignedSteps).toBeGreaterThan(0);
    expect(indexBuilds.byId).toBeGreaterThan(0);

    indexBuilds.rowsById = 0;
    indexBuilds.assignedSteps = 0;
    indexBuilds.byId = 0;
    cellStyleCalls.count = 0;
    click('Freeze #');

    expect(cellStyleCalls.count).toBe(0);
    expect(indexBuilds.rowsById).toBe(0);
    expect(indexBuilds.assignedSteps).toBe(0);
    expect(indexBuilds.byId).toBe(0);
  });
});
