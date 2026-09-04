import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView, SavedPlanSideRef } from '../../lib/saved-plan-api';
import type { SavedPlanComparisonState } from './saved-plan-compare';
import { SavedPlanComparison, SavedPlanSidePicker, sideLabel } from './saved-plan-compare';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const row = (over: Partial<SavedPlanListEntryView> = {}): SavedPlanListEntryView => ({
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
  ...over,
});

const SAVED: SavedPlanSideRef = { saved: 'sp1' };

const ready = (over: Partial<Extract<SavedPlanComparisonState, { kind: 'ready' }>> = {}) =>
  ({
    kind: 'ready',
    left: SAVED,
    right: 'current',
    diff: { input: [], schedule: [] },
    schedules: { left: { kind: 'present' }, right: { kind: 'present' } },
    rows: [row()],
    ...over,
  }) satisfies SavedPlanComparisonState;

describe('the side pickers', () => {
  itDom('offers the live plan first and then the shelf', () => {
    render(
      <SavedPlanSidePicker
        label="Left"
        value="current"
        rows={[row(), row({ id: 'sp2', name: 'after' })]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'the current plan',
      'before the re-plan',
      'after',
    ]);
  });

  itDom('hands back a side reference, not the raw string', () => {
    // The picker's value is a string because a `<select>` has no other kind.
    // Everything downstream takes `SavedPlanSideRef`, so the conversion belongs
    // here rather than at each of the two call sites — where one of them would
    // eventually forget and pass `'sp1'` as if it were `'current'`.
    const onChange = vi.fn();
    render(
      <SavedPlanSidePicker label="Right" value="current" rows={[row()]} onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sp1' } });
    expect(onChange).toHaveBeenCalledWith({ saved: 'sp1' });
  });

  itDom('names a saved side by its name and the live one by neither', () => {
    expect(sideLabel(SAVED, [row()])).toBe('before the re-plan');
    expect(sideLabel('current', [row()])).toBe('the current plan');
    // A side the shelf no longer carries falls back to its id rather than to
    // `undefined` — the heading still says WHICH plan is missing.
    expect(sideLabel({ saved: 'sp9' }, [row()])).toBe('sp9');
  });
});

describe('what a comparison renders', () => {
  itDom('declines two pickers on the same plan instead of erroring', () => {
    render(<SavedPlanComparison state={{ kind: 'refused', reason: 'same_side' }} />);
    expect(screen.getByText('Pick two different plans to compare.')).toBeTruthy();
    // Not an alert: no retry changes this, and `role="alert"` would interrupt a
    // screen reader for a choice the reader is in the middle of making.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  itDom('says nothing changed rather than drawing an empty panel', () => {
    render(<SavedPlanComparison state={ready()} />);
    expect(screen.getByText('No differences.')).toBeTruthy();
  });

  itDom('gives each absent side its own sentence', () => {
    // 8.3's requirement, end to end: the saved side reports a save that
    // happened without dates, the live side reports a plan that cannot be
    // scheduled. Same `absentReason`, two different facts.
    render(
      <SavedPlanComparison
        state={ready({
          schedules: {
            left: { kind: 'absent', reason: 'infeasible' },
            right: { kind: 'absent', reason: 'infeasible' },
          },
        })}
      />,
    );
    expect(screen.getByText('no schedule was saved (infeasible)')).toBeTruthy();
    expect(screen.getByText('the live plan cannot be scheduled (infeasible)')).toBeTruthy();
  });

  itDom('says nothing at all about a side that has its schedule', () => {
    render(<SavedPlanComparison state={ready()} />);
    expect(document.querySelectorAll('.saved-plan-compare__absent')).toHaveLength(0);
  });

  itDom('keeps the two halves apart and renders each in category order', () => {
    render(
      <SavedPlanComparison
        state={ready({
          diff: {
            input: [
              { category: 'notes', path: 'workItems[w1].notes', left: 'a', right: 'b' },
              { category: 'added', path: 'workItems[w2]', left: null, right: {} },
            ],
            schedule: [{ category: 'dates', path: 'schedule.body.start', left: 1, right: 2 }],
          },
        })}
      />,
    );
    const plan = screen.getByLabelText('The plan');
    expect([...plan.querySelectorAll('h5')].map((heading) => heading.textContent)).toEqual([
      'added',
      'notes',
    ]);
    // The schedule difference is in the OTHER section. Concatenating the halves
    // would put a changed start date under the same heading as a changed note,
    // which is the distinction this panel exists to make.
    //
    // Negative, MEASURED on h2puni at caf9678e and reverted with dirty=0
    // re-asserted: render `[...diff.input, ...diff.schedule]` as one half and
    // this file is 8 pass / 1 fail — this case, `[ 'added', 'dates', 'notes' ]`
    // where `[ 'added', 'notes' ]` was expected. The `dates` heading is the
    // schedule difference, arriving in the plan's own list.
    expect(plan.textContent).not.toContain('schedule.body.start');
    expect(screen.getByLabelText('The schedule').textContent).toContain('schedule.body.start');
  });

  itDom('says what each difference went from and to, not just where it was', () => {
    // I6. The panel used to render `difference.path` alone, so a rename read
    // `workItems[w1].name` and an estimate change named a field without either
    // number — the server computed both sides and the surface threw them away.
    //
    // Literal expected text rather than a call to `diffValueWords`: a case that
    // recomputes the thing it is checking goes green whatever the renderer does
    // (F-06's fault, on this same file).
    render(
      <SavedPlanComparison
        state={ready({
          diff: {
            input: [
              {
                category: 'renamed',
                path: 'workItems[w1].name',
                left: 'Design',
                right: 'Design v2',
              },
              { category: 'estimates', path: 'workItems[w1].estimateDays', left: 3, right: 5.5 },
              { category: 'added', path: 'workItems[w2]', left: undefined, right: { id: 'w2' } },
            ],
            schedule: [],
          },
        })}
      />,
    );
    const lines = [...screen.getByLabelText('The plan').querySelectorAll('li')].map(
      (item) => item.textContent,
    );
    expect(lines).toEqual([
      'workItems[w2] absent → 1 field',
      'workItems[w1].name "Design" → "Design v2"',
      'workItems[w1].estimateDays 3 → 5.5',
    ]);
  });

  itDom('keeps the arrow out of the values it separates', () => {
    // A stored string containing the separator must still read as one value.
    // If the line were formatted as a single string, nothing downstream could
    // tell this note's own arrow from the one between the sides.
    render(
      <SavedPlanComparison
        state={ready({
          diff: {
            input: [{ category: 'notes', path: 'workItems[w1].notes', left: 'a → b', right: 'c' }],
            schedule: [],
          },
        })}
      />,
    );
    expect(
      [...document.querySelectorAll('.saved-plan-compare__value')].map((node) => node.textContent),
    ).toEqual(['"a → b"', '"c"']);
  });

  itDom('draws no heading for a half with nothing in it', () => {
    render(
      <SavedPlanComparison
        state={ready({
          diff: {
            input: [{ category: 'notes', path: 'workItems[w1].notes', left: 'a', right: 'b' }],
            schedule: [],
          },
        })}
      />,
    );
    expect(screen.queryByLabelText('The schedule')).toBeNull();
    expect(screen.getByLabelText('The plan')).toBeTruthy();
  });
});
