import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { type PlanOptimizationView } from '@/lib/wbs-api';

import { OptimizationIndicator } from './optimization-indicator';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const READY: PlanOptimizationView = {
  enabled: true,
  engine: 'optimized',
  objective: 'pri',
  inputHash: 'hash-a',
  generation: 7,
  contractVersion: '1.5+test',
  budgetMs: 60_000,
  displayed: 'pri',
  variants: { pri: { state: 'ready' }, time: { state: 'idle' } },
  comparison: { deltaDays: 0, sameOrder: true },
};

const draw = (optimization: PlanOptimizationView, stale = false) => {
  return render(
    <OptimizationIndicator
      optimization={optimization}
      stale={stale}
      projectStart="2026-09-07"
      today={new Date(2026, 8, 7)}
      workItemName={(id) => (id === 'parent' ? 'Launch' : 'Migration')}
    />,
  );
};

function expectNoIntrusiveSurface(): void {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
}

describe('schedule comparison indicator', () => {
  itDom.each([
    [-2, true, 'Earlier project deadline by 2 days'],
    [3, false, 'Later project deadline by 3 days'],
    [-1 / 48, true, 'Earlier project deadline by 0.02 days'],
    [-Number.EPSILON, true, 'Same project deadline + same order'],
    [-0.001, true, 'Earlier project deadline by <0.01 day'],
    [0, false, 'Same project deadline + reordered'],
    [0, true, 'Same project deadline + same order'],
  ] as const)('names comparison %s/%s against Fast', (deltaDays, sameOrder, words) => {
    draw({ ...READY, comparison: { deltaDays, sameOrder } });
    expect(screen.getByRole('status')).toHaveTextContent(words);
    expect(screen.queryByText(/Work item deadline/)).toBeNull();
    expectNoIntrusiveSurface();
  });

  itDom('suppresses a comparison while the surrounding plan is known stale', () => {
    render(
      <OptimizationIndicator
        optimization={READY}
        stale
        projectStart="2026-09-07"
        today={new Date(2026, 8, 7)}
        workItemName={(id) => id}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Schedule comparison unavailable while this plan may be stale',
    );
    expect(screen.queryByText(/project deadline/)).toBeNull();
  });

  itDom.each(['pending', 'retrying', 'idle'] as const)(
    'keeps Fast on screen without an old comparison for %s',
    (state) => {
      draw({
        ...READY,
        displayed: 'fast',
        variants: { ...READY.variants, pri: { state } },
        comparison: undefined,
      });
      expect(screen.getByRole('status')).toHaveTextContent('Optimizing…');
      expect(screen.queryByText(/project deadline/)).toBeNull();
      expectNoIntrusiveSurface();
    },
  );

  itDom('qualifies a possibly stale pending status instead of presenting it as current', () => {
    draw(
      {
        ...READY,
        displayed: 'fast',
        variants: { ...READY.variants, pri: { state: 'pending' } },
        comparison: undefined,
      },
      true,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Optimizing… · This optimization status may be stale',
    );
  });

  itDom.each([
    { state: 'failed', reason: 'timeout' } as const,
    { state: 'corrupt', message: 'bad dto' } as const,
  ])('uses one unavailable state for $state without stale comparison', (state) => {
    draw({
      ...READY,
      displayed: 'fast',
      variants: { ...READY.variants, pri: state },
      comparison: undefined,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Optimization unavailable · Retry');
    expect(screen.queryByText(/project deadline/)).toBeNull();
    expectNoIntrusiveSurface();
  });

  itDom('names Work item deadlines separately and lists the offending rows on demand', () => {
    draw({
      ...READY,
      displayed: 'fast',
      variants: {
        ...READY.variants,
        pri: {
          state: 'plan-infeasible',
          items: [
            {
              ownerWorkItemId: 'parent',
              boundWorkItemId: 'leaf',
              effectiveDeadlineOffset: 4,
            },
          ],
        },
      },
      comparison: undefined,
    });

    expect(screen.getByText('Plan infeasible · 1 Work item deadline')).toBeInTheDocument();
    expect(screen.queryByText(/Optimization unavailable/)).toBeNull();
    const disclosure = screen.getByText('Show affected work items');
    expect(disclosure).toHaveAccessibleName('Show affected work items');
    expect(disclosure.closest('details')).toHaveAccessibleName('Affected work items');
    fireEvent.click(disclosure);
    expect(screen.getByText('Launch → Migration · Work item deadline 11 Sep')).toBeVisible();
    expectNoIntrusiveSurface();
    // 9.3, and not covered by the `Optimization unavailable` negative above:
    // that string is the *whole* failed banner, so a Retry offered under any
    // other wording — a bare button, a link, a second sentence — passes it.
    // Re-solving an unchanged input returns the same proof, and the route
    // answers 409 for it (8.7d), so a control here would promise a recovery
    // the server refuses. Asserted **after** the disclosure is open, because a
    // closed `<details>` hides its subtree from the accessibility tree and
    // would make a Retry inside it invisible to both queries.
    expect(screen.queryByText(/retry/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  itDom('does not repeat a leaf name when its own Work item deadline binds', () => {
    draw({
      ...READY,
      displayed: 'fast',
      variants: {
        ...READY.variants,
        pri: {
          state: 'plan-infeasible',
          items: [
            {
              ownerWorkItemId: 'leaf',
              boundWorkItemId: 'leaf',
              effectiveDeadlineOffset: 4,
            },
          ],
        },
      },
      comparison: undefined,
    });
    expect(screen.getByText('Migration · Work item deadline 11 Sep')).toBeInTheDocument();
    expect(screen.queryByText(/Migration → Migration/)).toBeNull();
  });

  itDom('renders an unmeetable deadline without throwing in the plan', () => {
    draw({
      ...READY,
      displayed: 'fast',
      variants: {
        ...READY.variants,
        pri: {
          state: 'plan-infeasible',
          items: [
            {
              ownerWorkItemId: 'leaf',
              boundWorkItemId: 'leaf',
              effectiveDeadlineOffset: -1,
            },
          ],
        },
      },
      comparison: undefined,
    });

    fireEvent.click(screen.getByText('Show affected work items'));
    expect(
      screen.getByText("Migration · Work item deadline before the project's first working day"),
    ).toBeVisible();
  });

  itDom('keeps a missing project start as a safe degraded deadline', () => {
    render(
      <OptimizationIndicator
        optimization={{
          ...READY,
          displayed: 'fast',
          variants: {
            ...READY.variants,
            pri: {
              state: 'plan-infeasible',
              items: [
                {
                  ownerWorkItemId: 'leaf',
                  boundWorkItemId: 'leaf',
                  effectiveDeadlineOffset: 4,
                },
              ],
            },
          },
          comparison: undefined,
        }}
        projectStart={null}
        today={new Date(2026, 8, 7)}
        workItemName={() => 'Migration'}
      />,
    );

    fireEvent.click(screen.getByText('Show affected work items'));
    expect(screen.getByText('Migration · Work item deadline date unavailable')).toBeVisible();
  });

  itDom('qualifies stale infeasibility and never leaks a removed work-item id', () => {
    render(
      <OptimizationIndicator
        optimization={{
          ...READY,
          displayed: 'fast',
          variants: {
            ...READY.variants,
            pri: {
              state: 'plan-infeasible',
              items: [
                {
                  ownerWorkItemId: 'removed-owner-uuid',
                  boundWorkItemId: 'removed-leaf-uuid',
                  effectiveDeadlineOffset: 4,
                },
              ],
            },
          },
          comparison: undefined,
        }}
        stale
        projectStart="2026-09-07"
        today={new Date(2026, 8, 7)}
        workItemName={() => null}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Plan infeasible · 1 Work item deadline · This result and affected-item list may be stale',
    );
    fireEvent.click(screen.getByText('Show affected work items'));
    expect(screen.getByText(/Work item no longer in this plan/)).toBeInTheDocument();
    expect(screen.queryByText(/removed-.*-uuid/)).toBeNull();
  });

  itDom('keeps one live-region node while optimization state changes', () => {
    const view = draw({
      ...READY,
      displayed: 'fast',
      variants: {
        ...READY.variants,
        pri: {
          state: 'plan-infeasible',
          items: [
            {
              ownerWorkItemId: 'leaf',
              boundWorkItemId: 'leaf',
              effectiveDeadlineOffset: 4,
            },
          ],
        },
      },
      comparison: undefined,
    });
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');

    view.rerender(
      <OptimizationIndicator
        optimization={READY}
        projectStart="2026-09-07"
        today={new Date(2026, 8, 7)}
        workItemName={(id) => id}
      />,
    );

    expect(screen.getByRole('status')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent('Same project deadline + same order');
  });

  itDom.each([
    { ...READY, comparison: undefined },
    { ...READY, displayed: 'fast' as const },
  ])(
    'degrades an inconsistent optional optimizer payload without taking down the plan',
    (value) => {
      draw(value);
      expect(screen.getByRole('status')).toHaveTextContent('Schedule comparison unavailable');
      expect(screen.getByRole('status').closest('[data-optimization-indicator]')).toHaveClass(
        'bg-muted',
        'rounded-md',
        'px-3',
        'py-2',
        'text-sm',
      );
    },
  );

  itDom('says nothing when Fast is the project selection', () => {
    draw({ ...READY, engine: 'fast', displayed: 'fast', comparison: undefined });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
