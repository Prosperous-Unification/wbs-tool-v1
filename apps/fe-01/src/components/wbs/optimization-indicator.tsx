import { addWorkdays, withinDrift } from '@wbs/domain/workday';

import type { PlanOptimizationView } from '@/lib/wbs-api';

import { shortIsoDate } from './short-date';

export interface OptimizationIndicatorProps {
  readonly optimization: PlanOptimizationView;
  readonly stale?: boolean;
  readonly projectStart: string | null;
  readonly today: Date;
  readonly workItemName: (id: string) => string | null;
}

const INDICATOR_CLASS = 'bg-muted mb-3 min-w-0 rounded-md px-3 py-2 text-sm break-words';

function days(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 0.01) return '<0.01 day';
  const shown = Math.round(absolute * 100) / 100;
  return `${String(shown)} ${shown === 1 ? 'day' : 'days'}`;
}

function comparisonWords(comparison: NonNullable<PlanOptimizationView['comparison']>): string {
  if (withinDrift(comparison.deltaDays, 0)) {
    return comparison.sameOrder
      ? 'Same project deadline + same order'
      : 'Same project deadline + reordered';
  }
  if (comparison.deltaDays < 0) {
    return `Earlier project deadline by ${days(comparison.deltaDays)}`;
  }
  return `Later project deadline by ${days(comparison.deltaDays)}`;
}

/** One current-state sentence for the optimized schedule selected by the project. */
export function OptimizationIndicator({
  optimization,
  stale = false,
  projectStart,
  today,
  workItemName,
}: OptimizationIndicatorProps) {
  if (!optimization.enabled || optimization.engine === 'fast') return null;
  const variant = optimization.variants[optimization.objective];
  let statusWords: string;
  let affectedItems: Extract<typeof variant, { state: 'plan-infeasible' }>['items'] | null = null;

  if (optimization.displayed !== 'fast') {
    if (
      optimization.displayed !== optimization.objective ||
      variant.state !== 'ready' ||
      optimization.comparison === undefined
    ) {
      statusWords = 'Schedule comparison unavailable';
    } else {
      statusWords = stale
        ? 'Schedule comparison unavailable while this plan may be stale'
        : comparisonWords(optimization.comparison);
    }
  } else {
    switch (variant.state) {
      case 'ready':
        statusWords = 'Schedule comparison unavailable';
        break;
      case 'failed':
      case 'corrupt':
        statusWords = 'Optimization unavailable · Retry';
        break;
      case 'plan-infeasible': {
        const count = variant.items.length;
        statusWords = `Plan infeasible · ${String(count)} Work item deadline${count === 1 ? '' : 's'}`;
        affectedItems = variant.items;
        break;
      }
      case 'pending':
      case 'retrying':
      case 'idle':
        statusWords = 'Optimizing…';
        break;
      default: {
        const exhaustive: never = variant;
        void exhaustive;
        statusWords = 'Schedule comparison unavailable';
      }
    }

    if (stale) {
      statusWords =
        affectedItems === null
          ? `${statusWords} · This optimization status may be stale`
          : `${statusWords} · This result and affected-item list may be stale`;
    }
  }

  const nameOf = (id: string): string => workItemName(id) ?? 'Work item no longer in this plan';

  return (
    <div className={INDICATOR_CLASS} data-optimization-indicator>
      <p role="status" aria-live="polite" aria-atomic="true">
        {statusWords}
      </p>
      {affectedItems !== null && (
        <details className="mt-2 min-w-0" aria-label="Affected work items">
          <summary className="text-muted-foreground cursor-pointer">
            Show affected work items
          </summary>
          <ul className="mt-2 min-w-0 list-disc pl-5">
            {affectedItems.map((affectedDeadline) => (
              <li key={`${affectedDeadline.ownerWorkItemId}:${affectedDeadline.boundWorkItemId}`}>
                {affectedDeadline.ownerWorkItemId === affectedDeadline.boundWorkItemId
                  ? nameOf(affectedDeadline.boundWorkItemId)
                  : `${nameOf(affectedDeadline.ownerWorkItemId)} → ${nameOf(affectedDeadline.boundWorkItemId)}`}{' '}
                · Work item deadline{' '}
                {projectStart === null
                  ? 'date unavailable'
                  : shortIsoDate(
                      addWorkdays(projectStart, affectedDeadline.effectiveDeadlineOffset),
                      today,
                    )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
