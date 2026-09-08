import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV, fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

import type * as PlanCellPropsModule from './plan-cell-props';
import type * as PlanIndexesModule from './plan-indexes';
import type * as PlanSpanModule from './plan-span';
import type * as TableFrameModule from './table-frame';
import { WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

/**
 * How many `<td>`/`<th>` renders the table has performed, counted through
 * {@link flexibleCellStyle} — every body cell and heading computes its flexible
 * width exactly once per render, so this divided by `(rows + 1) × columns` is
 * how many times the whole table rendered. That is the denominator this file
 * needs: "once per row" is a claim about a render, and a jsdom action costs
 * however many renders it costs.
 */
const cellStyleCalls = vi.hoisted(() => ({ count: 0 }));

/** How many times the Start sentence was worked out from scratch. */
const startSentenceCalls = vi.hoisted(() => ({ count: 0 }));

/** How many times one row's two printed days were worked out. */
const spanCalls = vi.hoisted(() => ({ count: 0 }));

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
  itDom('works the Start sentence out once per row, however many readers ask', async () => {
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
    // Any gesture that renders the table. How many renders it costs is not this
    // case's business — it is read back below rather than assumed, which is why
    // the assertion is a rate and not a pinned number.
    click('Freeze #');

    const renders = cellStyleCalls.count / ((rows + 1) * columns);
    expect(Number.isInteger(renders)).toBe(true);
    expect(renders).toBeGreaterThan(0);
    expect(startSentenceCalls.count).toBe(renders * rows);
    // And the span under it, which the Start cell, the Finish cell and that
    // sentence each used to ask for separately.
    //
    // Proof: `spanOfOnce`'s `spanByRow` lookup bypassed, this failed on
    // `expected 9 to be 3`. Watched 2026-09-08.
    expect(spanCalls.count).toBe(renders * rows);
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

    expect(cellStyleCalls.count).toBeGreaterThan(0);
    expect(indexBuilds.rowsById).toBe(0);
    expect(indexBuilds.assignedSteps).toBe(0);
    expect(indexBuilds.byId).toBe(0);
  });
});
