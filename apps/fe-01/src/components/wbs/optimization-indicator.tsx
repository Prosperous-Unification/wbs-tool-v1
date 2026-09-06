import type { PlanOptimizationView } from '@/lib/wbs-api';

export interface OptimizationIndicatorProps {
  readonly optimization: PlanOptimizationView;
  readonly workItemName: (id: string) => string;
}

function days(value: number): string {
  const shown = Math.round(Math.abs(value) * 10) / 10;
  return `${String(shown)} ${shown === 1 ? 'day' : 'days'}`;
}

function comparisonWords(comparison: NonNullable<PlanOptimizationView['comparison']>): string {
  if (comparison.deltaDays < 0) {
    return `Earlier project deadline by ${days(comparison.deltaDays)}`;
  }
  if (comparison.deltaDays > 0) {
    return `Later project deadline by ${days(comparison.deltaDays)}`;
  }
  return comparison.sameOrder
    ? 'Same project deadline and same order'
    : 'Same project deadline and reordered';
}

/** One current-state sentence for the optimized schedule selected by the project. */
export function OptimizationIndicator({ optimization, workItemName }: OptimizationIndicatorProps) {
  if (!optimization.enabled || optimization.engine === 'fast') return null;
  const variant = optimization.variants[optimization.objective];

  if (optimization.displayed !== 'fast') {
    if (
      optimization.displayed !== optimization.objective ||
      variant.state !== 'ready' ||
      optimization.comparison === undefined
    ) {
      throw new Error('optimized plan read has an inconsistent displayed comparison');
    }
    return (
      <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
        {comparisonWords(optimization.comparison)}
      </p>
    );
  }

  if (variant.state === 'ready') {
    throw new Error('ready optimized plan read displays Fast');
  }
  if (variant.state === 'failed' || variant.state === 'corrupt') {
    return (
      <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
        Optimization unavailable · Retry
      </p>
    );
  }
  if (variant.state === 'plan-infeasible') {
    const count = variant.items.length;
    return (
      <details className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
        <summary>
          <span role="status">
            Plan infeasible · {String(count)} Work item deadline{count === 1 ? '' : 's'}
          </span>
          <span className="text-muted-foreground ml-2">Show affected work items</span>
        </summary>
        <ul className="mt-2 list-disc pl-5">
          {variant.items.map((item) => (
            <li key={`${item.ownerWorkItemId}:${item.boundWorkItemId}`}>
              {workItemName(item.ownerWorkItemId)} → {workItemName(item.boundWorkItemId)} · Work
              item deadline day {String(item.effectiveDeadlineOffset)}
            </li>
          ))}
        </ul>
      </details>
    );
  }

  return (
    <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
      Optimizing…
    </p>
  );
}
