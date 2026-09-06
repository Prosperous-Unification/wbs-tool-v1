import type { PlanOptimizationView } from '@/lib/wbs-api';

export interface OptimizationIndicatorProps {
  readonly optimization: PlanOptimizationView;
  readonly stale?: boolean;
  readonly workItemName: (id: string) => string;
}

function days(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 0.01) return '<0.01 day';
  const shown = Math.round(absolute * 100) / 100;
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
    ? 'Same project deadline + same order'
    : 'Same project deadline + reordered';
}

/** One current-state sentence for the optimized schedule selected by the project. */
export function OptimizationIndicator({
  optimization,
  stale = false,
  workItemName,
}: OptimizationIndicatorProps) {
  if (!optimization.enabled || optimization.engine === 'fast') return null;
  const variant = optimization.variants[optimization.objective];

  if (optimization.displayed !== 'fast') {
    if (
      optimization.displayed !== optimization.objective ||
      variant.state !== 'ready' ||
      optimization.comparison === undefined
    ) {
      return <p role="status">Schedule comparison unavailable</p>;
    }
    return (
      <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
        {stale
          ? 'Schedule comparison unavailable while this plan may be stale'
          : comparisonWords(optimization.comparison)}
      </p>
    );
  }

  switch (variant.state) {
    case 'ready':
      return <p role="status">Schedule comparison unavailable</p>;
    case 'failed':
    case 'corrupt':
      return (
        <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
          Optimization unavailable · Retry
        </p>
      );
    case 'plan-infeasible': {
      const count = variant.items.length;
      return (
        <div className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
          <p role="status">
            Plan infeasible · {String(count)} Work item deadline{count === 1 ? '' : 's'}
          </p>
          <details>
            <summary className="text-muted-foreground">Show affected work items</summary>
            <ul className="mt-2 list-disc pl-5">
              {variant.items.map((item) => (
                <li key={`${item.ownerWorkItemId}:${item.boundWorkItemId}`}>
                  {item.ownerWorkItemId === item.boundWorkItemId
                    ? workItemName(item.boundWorkItemId)
                    : `${workItemName(item.ownerWorkItemId)} → ${workItemName(item.boundWorkItemId)}`}{' '}
                  · Work item deadline day {String(item.effectiveDeadlineOffset)}
                </li>
              ))}
            </ul>
          </details>
        </div>
      );
    }
    case 'pending':
    case 'retrying':
    case 'idle':
      return (
        <p role="status" className="bg-muted mb-3 rounded-md px-3 py-2 text-sm">
          Optimizing…
        </p>
      );
    default: {
      const exhaustive: never = variant;
      void exhaustive;
      return <p role="status">Schedule comparison unavailable</p>;
    }
  }
}
