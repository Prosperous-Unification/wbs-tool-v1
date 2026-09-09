import { UNMEETABLE_DEADLINE_OFFSET } from '@wbs/domain/deadline-offsets';
import { addWorkdays, isIsoDate, withinDrift } from '@wbs/domain/workday';

import type { PlanOptimizationView, ScheduleObjectiveView } from '@/lib/wbs-api';

import { DEADLINE_UNREACHABLE_CELL } from './deadline-impossible';
import { shortIsoDate } from './short-date';

/**
 * Every word the optimization cue says, in one module.
 *
 * Moved out of `optimization-indicator.tsx` when the banner became the cue
 * (tasks.md 8b.6) and otherwise unchanged: the copy is what `deadline-copy.ts`'s
 * repository assertion is about — no occurrence of "deadline" here may go
 * unqualified, because a plan has a project deadline and a work item deadline
 * and a bare one cannot say which moved. Two surfaces read these now (the pill's
 * own sentence and its hover card), which is the reason they are not written
 * where either of them is drawn.
 */

/** What a variant is called on a control, where there is room for two words at most. */
export const OBJECTIVE_LABEL: Readonly<Record<ScheduleObjectiveView, string>> = {
  // `Pri` and not `PRI`: three letters in capitals read as an initialism for
  // something, and this one is just the first syllable of "priority" (Dany,
  // 2026-09-08). What each of the three schedules actually **is** is in
  // {@link ALGORITHM_WORDS}, because a label this short can only be a name.
  pri: 'Pri',
  time: 'Time',
};

/**
 * What a variant is called in a sentence.
 *
 * Spelled out rather than `OBJECTIVE_LABEL`'s abbreviation, because a sentence
 * is what a screen reader reads out and "Pri" is not a word. The two are the
 * settings panel's own pair — its radio labels are the short names and its
 * description is these.
 */
export const OBJECTIVE_SENTENCE: Readonly<Record<ScheduleObjectiveView, string>> = {
  pri: 'Priority-first',
  time: 'Finish-first',
};

/** What the unoptimized schedule is called, on a control and in a sentence alike. */
export const FAST_LABEL = 'Fast';

/**
 * What each of the three schedules is, in the words a reader needs to choose
 * between them.
 *
 * On the cue's own card and nowhere else: the pill has room for a name, and a
 * name alone ("Fast", "Pri", "Time") says nothing about what the thing does —
 * which was the complaint (Dany, 2026-09-08). The solver is named because it
 * is the reason two of the three take seconds rather than milliseconds, and
 * because a reader who wants to know why a plan came out as it did needs the
 * name to look anything up.
 */
export const ALGORITHM_WORDS = [
  'Fast places the plan in milliseconds by walking the graph once, and is never claimed optimal.',
  'Time searches for the earliest project deadline it can find.',
  'Pri searches for the schedule that starts higher-priority work sooner, which can finish later.',
  'Time and Pri are both CP-SAT searches from Google OR-Tools, given the budget below.',
].join('\n');

/**
 * What a comparison against a plan that may have moved says instead of a figure.
 *
 * The shipped indicator's own words, and one constant because the sentence and
 * the fact card both say it: a plan whose rows may be behind what be-01 holds
 * has no comparison worth showing, and a wrong figure is worse than none.
 */
export const STALE_WORDS = 'Schedule comparison unavailable while this plan may be stale';

/** A day count without solver-scale float noise, and never a bare `0`. */
export function days(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 0.01) return '<0.01 day';
  const shown = Math.round(absolute * 100) / 100;
  return `${String(shown)} ${shown === 1 ? 'day' : 'days'}`;
}

/**
 * Describe one schedule's finish against another's without exposing solver-scale
 * float noise.
 *
 * `deltaDays` is the subtraction of two figures the plan read sends — negative
 * for the earlier schedule — taken through the shared workday drift, which is
 * what collapses a difference nobody could act on into "same project deadline".
 * The shipped indicator took exactly this decision over exactly this tolerance;
 * only the shape of what it is handed changed (tasks.md 8b.4).
 */
export function comparisonWords(deltaDays: number, sameOrder: boolean): string {
  // Proof: the -Number.EPSILON case in `optimization-cue-reading.test.ts` reads
  // "Same project deadline + same order" and fails as "Earlier project deadline
  // · <0.01 day" when this check is replaced by exact zero, while -0.001 stays
  // Earlier.
  if (withinDrift(deltaDays, 0)) {
    return sameOrder ? 'Same project deadline + same order' : 'Same project deadline + reordered';
  }
  if (deltaDays < 0) return `Earlier project deadline by ${days(deltaDays)}`;
  return `Later project deadline by ${days(deltaDays)}`;
}

export interface DeadlineWords {
  readonly text: string;
  readonly isEffectiveWorkday: boolean;
}

/** Render and classify the stored deadline with at most one calendar reconstruction. */
export function deadlineWords(
  projectStart: string | null,
  offset: number,
  today: Date,
): DeadlineWords {
  // Proof: the unmeetable-deadline case throws in render when this branch is
  // removed and -1 reaches addWorkdays.
  // The words are `DEADLINE_UNREACHABLE_CELL`'s and not this file's, for the
  // reason that constant's own docstring gives: "before project start" is
  // false about the case that reaches here. A project starting Saturday with a
  // deadline on the Sunday after it is unmeetable — day zero rolls forward to
  // Monday, the deadline rolls back to Friday — and the sentence would be
  // telling the reader a *later* date came first.
  if (projectStart === null || !isIsoDate(projectStart)) {
    return { text: 'date unavailable', isEffectiveWorkday: false };
  }
  if (offset === UNMEETABLE_DEADLINE_OFFSET) {
    return { text: DEADLINE_UNREACHABLE_CELL, isEffectiveWorkday: false };
  }
  // The DTO refuses these values too, but this is a rendering boundary fed by
  // a plain `number` in the FE mirror. Keep a stale or hand-built payload from
  // turning a fact card into a React render failure.
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { text: 'date unavailable', isEffectiveWorkday: false };
  }
  try {
    const effectiveDeadline = addWorkdays(projectStart, offset);
    if (!isIsoDate(effectiveDeadline)) {
      return { text: 'date unavailable', isEffectiveWorkday: false };
    }
    return { text: shortIsoDate(effectiveDeadline, today), isEffectiveWorkday: true };
  } catch {
    return { text: 'date unavailable', isEffectiveWorkday: false };
  }
}

/**
 * What a variant's state says about itself, or `null` for the two states that
 * are not news.
 *
 * `ready` says nothing here because the comparison beside it is what a ready
 * variant has to say. `idle` says nothing either, unless something has been
 * admitted for this plan — see the case below.
 */
export function variantStateWords(
  state: PlanOptimizationView['variants'][ScheduleObjectiveView],
  admitted: boolean,
): string | null {
  switch (state.state) {
    case 'ready':
      return state.proof === 'incomplete'
        ? 'Search stopped before proving this schedule optimal'
        : null;
    case 'idle':
      // `idle` is "absent at this key with nothing in flight", which is two
      // different situations wearing one word: a variant the cold read is about
      // to admit, and a plan with no solvable work in it at all (no slices, or
      // every slice zero days) — which is also what a **disabled** project
      // reads as. `generation` is what separates them on the wire, so the
      // waiting one says so and the other stays quiet rather than promising a
      // solve that will never be asked for.
      return admitted ? 'Optimizing…' : null;
    case 'pending':
    case 'retrying':
      return 'Optimizing…';
    case 'failed':
    case 'corrupt':
      return 'Optimization unavailable';
    case 'plan-infeasible': {
      const count = state.items.length;
      return `Plan infeasible · ${String(count)} Work item deadline${count === 1 ? '' : 's'}`;
    }
    default: {
      // Named with the underscore the unused-vars policy reads: this binding
      // exists for the `never` check alone.
      const _exhaustive: never = state;
      return null;
    }
  }
}
