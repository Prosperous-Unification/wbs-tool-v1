import { type Days } from '@/lib/wbs-api';

import { type Point } from './estimate-draft';

export const showDays = (days: Days | undefined, point: Point): string =>
  days === undefined ? '' : String(days[point]);

/** A step's final figure, or nothing at all when no estimate under this row mentions it. */
export const showFinal = (days: number | undefined): string =>
  days === undefined ? '' : showDay(days);

/**
 * A day offset as a person should read it.
 *
 * PERT is `(O + 4R + P) / 6`, so a perfectly ordinary estimate produces
 * `3.3333333333333335` and a column full of those is unreadable. Rounded to one
 * decimal **for display only** — the schedule keeps its fractions, because
 * rounding inside the computation compounds across a chain of forty work items
 * into days that never existed.
 */
export const showDay = (days: number): string => String(Math.round(days * 10) / 10);
