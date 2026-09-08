import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

import type * as PlanCellPropsModule from './plan-cell-props';
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
});

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
    // Any gesture that renders the table. How many renders it costs is not this
    // case's business — it is read back below rather than assumed, which is why
    // the assertion is a rate and not a pinned number.
    click('Freeze #');

    const renders = cellStyleCalls.count / ((rows + 1) * columns);
    expect(Number.isInteger(renders)).toBe(true);
    expect(renders).toBeGreaterThan(0);
    expect(startSentenceCalls.count).toBe(renders * rows);
  });
});
