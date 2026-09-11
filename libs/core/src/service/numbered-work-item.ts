import type { IsoDate, Scheduled, StepState, WorkItemState } from '@wbs/domain';

import type { LabelledWorkItem } from '../ports/work-item-store';

/** Three durations in days, summed or held directly. */
export interface Days {
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

/**
 * A work item as a reader sees it: the stored row, the number derived for it and
 * its estimates by step — its own if it is a leaf, its descendants' sums if not.
 */
export interface NumberedWorkItem extends LabelledWorkItem {
  /**
   * How many times this work item has been written to, including writes to its
   * estimates, assignments and dependencies.
   *
   * Redeclared from {@link WorkItem} only to say what it means **for a reader**,
   * which is the reason it is on the wire at all: hold it alongside the row you
   * read, and a later write can ask to land only if the row has not moved
   * since. Nothing asks that yet — conditional undo and write preconditions are
   * the changes that will.
   *
   * It does **not** move when `number` does. A create anywhere above renumbers
   * rows nobody wrote to, and a revision that tracked the derived number would
   * be a project-wide counter with a work item's name on it.
   *
   * A created work item is 0. One created as the first child of a work item
   * that held estimates is 1: the handoff of those estimates down to it is a
   * second write, to a row that then genuinely holds something it did not
   * before.
   */
  revision: number;
  number: string;
  estimates: Record<string, Days>;
  /** True when the estimates above are sums and therefore not editable here. */
  rolledUp: boolean;
  /**
   * The days **recorded** against this row, by step — its own if it is a leaf,
   * the sum of its descendants' if it is not.
   *
   * A step nobody has recorded days for is absent, and an empty object means
   * nobody has recorded anything on this row. Neither is a zero: a face that
   * renders a missing key as `0` is saying somebody stated the work took no
   * time. Reported and never planned with — it reaches no scheduling function.
   */
  actuals: Record<string, number>;
  /**
   * Where each step's work on this row has got to — its own if it is a leaf,
   * `agree` across its descendants' if it is not.
   *
   * **A step reading `not_started` is absent from this object**, exactly as an
   * unestimated step is absent from `estimates`: the absence of a statement is
   * how "nobody has said" is spelled everywhere in this tool, including on the
   * wire.
   */
  progress: Record<string, StepState>;
  /**
   * The row's own reading, derived from its steps and never stored: `done` when
   * every step with work on it says so, `not_started` when none has said
   * anything, and `in_progress` for every disagreement between — including the
   * one that matters most, one step finished and another silent. See
   * `rollUpWorkItemStates`.
   */
  state: WorkItemState;
  /**
   * The figures that are not days: **metric first, then step**, its own if it is
   * a leaf and the sum of its descendants' if it is not.
   *
   * Nested rather than flat because the primary key is a triple and a flat
   * `Record<string, number>` would have to spell the other two into one string —
   * `token_actual:step-dev` — which every reader would then have to take apart
   * again. Metric outermost because that is the axis a reader picks first: a
   * column of tokens and a column of hours are two columns, and the steps inside
   * each are the same steps.
   *
   * **A metric nobody has recorded anywhere below is absent, not `{}`.** The
   * distinction is the one this whole table is built on, one level up from where
   * `estimates` and `actuals` make it: an empty object under `hours_actual` says
   * "somebody looked at the hours on this row" and absence says nobody has. So a
   * work item nobody has recorded anything against is `{}` here — no metrics at
   * all — rather than three empty objects, and a face rendering a missing metric
   * as `0` is inventing a statement.
   *
   * Absence is per metric and per step both: a pair holding a `token_actual` and
   * nothing else puts that pair under `token_actual` and leaves it out of
   * `hours_actual` entirely. See {@link rollUpMeasures}.
   *
   * Reported and never planned with, exactly as `actuals` is: it reaches no
   * scheduling function. R6's rule, one table over.
   */
  measures: Record<string, Record<string, number>>;
  /** The work items this one waits for, as written — either end may be a parent. */
  dependsOn: string[];
  /**
   * The one number this row is planned with, per step, and their sum.
   *
   * Computed here rather than on the client, from the same {@link finalDays}
   * the schedule's durations come from. Two implementations of "the final
   * estimate" is how a table comes to disagree with the dates printed beside
   * it, and this figure sits in the next column along from those dates.
   *
   * A step with no estimate anywhere below is absent, exactly as `estimates`
   * is: absent and zero mean opposite things.
   */
  finalDays: Record<string, number>;
  /** Every step's final figure, summed — the row's whole planning duration. */
  finalTotal: number;
  /**
   * When this can happen, in whole days from the project's day zero.
   *
   * `estimates` above is **effort** and this is **span**, and for a parent they
   * are different numbers: two independent children of 3 and 4 days are 7 days
   * of work inside a 4-day branch. Both are true and neither substitutes.
   */
  schedule: Scheduled;
  /**
   * When this happens on a calendar, or null while the project has no start
   * date.
   *
   * Working days only: weekends are skipped, so a five-day task starting on a
   * Thursday ends on the following Wednesday. Public holidays are not modelled
   * — they differ by country, company and year, and inventing them would put
   * dates in a plan nobody can account for.
   *
   * `endsOn` is the day the work item is still being worked on, not the day
   * after: a one-day task starting Monday ends Monday.
   */
  dates: { startsOn: IsoDate; endsOn: IsoDate } | null;
  /**
   * Who is doing this work, by step id.
   *
   * A step with nobody assigned is absent rather than null. When exactly one
   * step is assigned, `doesEveryStep` names that person: Dany's "when just
   * one is assigned it is assumed they do both dev and QA". It is reported as
   * a reading of the assignments rather than written as a second row, so
   * nobody is recorded against work they were never given, and assigning the
   * other step simply stops the assumption.
   */
  assignees: Record<string, string>;
  doesEveryStep: string | null;
}
