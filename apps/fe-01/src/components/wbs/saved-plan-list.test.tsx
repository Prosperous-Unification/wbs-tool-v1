import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SavedPlanListEntryView } from '../../lib/saved-plan-api';
import { SAVED_PLANS_UNAVAILABLE, SavedPlanList, scheduleWords } from './saved-plan-list';

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

describe('a node that cannot answer the question', () => {
  it('says so instead of showing an empty shelf', () => {
    // The whole point of 6.4. An old node and a project with nothing saved both
    // have nothing to list, and only one of them is worth telling somebody
    // about — the other invites them to wait for rows that will never arrive.
    render(<SavedPlanList state={{ kind: 'unavailable' }} />);
    expect(screen.getByText(SAVED_PLANS_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('is not an alert, because nothing has gone wrong', () => {
    // A node without the routes is healthy. Rendering it through the error
    // branch would announce a fault to a screen reader and ask for a retry that
    // cannot succeed, so the two branches are separated by their role as well
    // as their words.
    render(<SavedPlanList state={{ kind: 'unavailable' }} />);
    expect(screen.queryByRole('alert')).toBeNull();
    render(<SavedPlanList state={{ kind: 'error', code: 'http_500' }} />);
    expect(screen.getByRole('alert').textContent).toContain('http_500');
  });
});

describe('the shelf', () => {
  it('separates an empty shelf from an unavailable one', () => {
    render(<SavedPlanList state={{ kind: 'ready', rows: [] }} />);
    expect(screen.getByText('No plans saved yet.')).toBeTruthy();
    expect(screen.queryByText(SAVED_PLANS_UNAVAILABLE)).toBeNull();
  });

  it('names each plan, who saved it, and whether its schedule came along', () => {
    render(<SavedPlanList state={{ kind: 'ready', rows: [ROW] }} />);
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('before the re-plan');
    expect(row.textContent).toContain('saved by ada');
    expect(row.textContent).toContain('with its schedule');
  });

  it('holds the instant in `dateTime` rather than in words', () => {
    // The visible text is `toLocaleString`'s and therefore the reader's zone and
    // conventions, which is right and untestable in the same breath. The fact a
    // case can hold steady is the machine-readable attribute, so that is where
    // the assertion goes — and a build that rendered the browser's clock instead
    // of be-01's would move it.
    render(<SavedPlanList state={{ kind: 'ready', rows: [ROW] }} />);
    expect(screen.getByRole('listitem').querySelector('time')?.getAttribute('dateTime')).toBe(
      new Date(1_788_501_600_000).toISOString(),
    );
  });

  it('keeps the order it was handed', () => {
    // be-01 orders the shelf newest first and this component does not re-sort.
    // Sorting here would be a second opinion about "newest" held by a clock that
    // did not write the rows.
    const rows = [ROW, { ...ROW, id: 'sp2', name: 'after the re-plan' }];
    render(<SavedPlanList state={{ kind: 'ready', rows }} />);
    expect(
      screen.getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent),
    ).toEqual(['before the re-plan', 'after the re-plan']);
  });
});

describe('what a row says about its schedule', () => {
  it('names the recorded reason a schedule is missing', () => {
    expect(scheduleWords({ ...ROW, scheduleBytes: null, scheduleAbsentReason: 'infeasible' })).toBe(
      'no schedule was saved (infeasible)',
    );
  });

  it('carries a reason this build has never heard of rather than dropping it', () => {
    // The API layer types this `string` and not a union on purpose, because
    // be-01's column is `text` and its read path passes an unrecognised reason
    // through. A surface that only rendered the labels it knew would turn a plan
    // saved for a reason into a plan saved for no reason.
    expect(
      scheduleWords({ ...ROW, scheduleBytes: null, scheduleAbsentReason: 'from-the-future' }),
    ).toBe('no schedule was saved (from-the-future)');
  });

  it('still says a schedule is absent when no reason was recorded', () => {
    expect(scheduleWords({ ...ROW, scheduleBytes: null, scheduleAbsentReason: null })).toBe(
      'no schedule was saved',
    );
  });

  it('reads a zero-length schedule as a schedule, because `null` is the absence', () => {
    // `0` and `null` are different facts in this column and a truthiness check
    // would merge them. Negative: `row.scheduleBytes !== null` weakened to
    // `row.scheduleBytes` and this is the case that reddens.
    expect(scheduleWords({ ...ROW, scheduleBytes: 0 })).toBe('with its schedule');
  });
});
