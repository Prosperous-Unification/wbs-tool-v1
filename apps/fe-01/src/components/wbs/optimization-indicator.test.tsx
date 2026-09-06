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

const draw = (optimization: PlanOptimizationView): void => {
  render(
    <OptimizationIndicator
      optimization={optimization}
      workItemName={(id) => (id === 'parent' ? 'Launch' : 'Migration')}
    />,
  );
};

describe('schedule comparison indicator', () => {
  itDom.each([
    [-2, true, 'Earlier project deadline by 2 days'],
    [3, false, 'Later project deadline by 3 days'],
    [0, false, 'Same project deadline and reordered'],
    [0, true, 'Same project deadline and same order'],
  ] as const)('names comparison %s/%s against Fast', (deltaDays, sameOrder, words) => {
    draw({ ...READY, comparison: { deltaDays, sameOrder } });
    expect(screen.getByRole('status')).toHaveTextContent(words);
    expect(screen.queryByText(/Work item deadline/)).toBeNull();
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
    },
  );

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
    fireEvent.click(screen.getByText('Show affected work items'));
    expect(screen.getByText('Launch → Migration · Work item deadline day 4')).toBeInTheDocument();
  });

  itDom('says nothing when Fast is the project selection', () => {
    draw({ ...READY, engine: 'fast', displayed: 'fast', comparison: undefined });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
