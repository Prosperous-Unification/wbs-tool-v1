import { UNMEETABLE_DEADLINE_OFFSET } from '@wbs/domain/deadline-offsets';
import { addWorkdays, withinDrift } from '@wbs/domain/workday';

import type { PlanOptimizationView } from '@/lib/wbs-api';

import { DEADLINE_UNREACHABLE_CELL } from './deadline-impossible';
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

/** Describe an optimized finish relative to Fast without exposing solver-scale float noise. */
function comparisonWords(comparison: NonNullable<PlanOptimizationView['comparison']>): string {
  // Proof: the -Number.EPSILON indicator case fails as "Earlier ... <0.01 day"
  // when this check is replaced by exact zero, while -0.001 remains Earlier.
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

/** Render the stored deadline meaning without sending the legal -1 sentinel to addWorkdays. */
function deadlineWords(projectStart: string | null, offset: number, today: Date): string {
  // Proof: the unmeetable-deadline indicator case throws in render when this
  // branch is removed and -1 reaches addWorkdays.
  // The words are `DEADLINE_UNREACHABLE_CELL`'s and not this file's, for the
  // reason that constant's own docstring gives: "before project start" is
  // false about the case that reaches here. A project starting Saturday with a
  // deadline on the Sunday after it is unmeetable — day zero rolls forward to
  // Monday, the deadline rolls back to Friday — and the sentence would be
  // telling the reader a *later* date came first.
  if (offset === UNMEETABLE_DEADLINE_OFFSET) return DEADLINE_UNREACHABLE_CELL;
  if (projectStart === null || offset < UNMEETABLE_DEADLINE_OFFSET) return 'date unavailable';
  return shortIsoDate(addWorkdays(projectStart, offset), today);
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
                {deadlineWords(projectStart, affectedDeadline.effectiveDeadlineOffset, today)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
