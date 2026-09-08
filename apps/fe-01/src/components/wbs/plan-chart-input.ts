import type { Row } from '@tanstack/react-table';
import { workdaysBetween } from '@wbs/domain/workday';
import type * as React from 'react';
import { useCallback, useMemo } from 'react';

import type { PriorityBandView, TeamView } from '@/lib/wbs-api';

import {
  type GanttPlan,
  type ServiceTeamLabel,
  startFloorByRow,
  type TagLabel,
} from './gantt-geometry';
import type { PlanTableFeatures } from './plan-columns/column';
import { showDay } from './plan-number-format';
import { printedDay } from './short-date';
import type { ChartRead } from './use-plan-read';
import { type TreeRow } from './wbs-rows';

/**
 * What the Gantt is drawn from: the rows on screen, their labels, and the
 * floor each bar's start is measured against.
 *
 * Memoised because it is rebuilt from the whole plan and the chart re-renders
 * on every pointer move across it — the reason the memo exists is the pointer,
 * not the size of the plan.
 */
export function usePlanChartInput({
  shownRows,
  startDate,
  effectiveTeamLabelOf,
  effectiveTagLabelOf,
  namedInTheTree,
  chartRead,
  flat,
  filtering,
  teams,
  priorityBands,
  startFloor,
}: {
  shownRows: Row<PlanTableFeatures, TreeRow>[];
  startDate: string | null;
  effectiveTeamLabelOf: (row: TreeRow) => ServiceTeamLabel;
  effectiveTagLabelOf: (row: TreeRow) => TagLabel;
  namedInTheTree: Map<string, string>;
  chartRead: ChartRead;
  flat: TreeRow[];
  filtering: boolean;
  teams: TeamView[];
  priorityBands: PriorityBandView[];
  startFloor: React.RefObject<ReadonlyMap<string, string>>;
}) {
  /**
   * What the Gantt panel draws, from the rows the renderer is drawing.
   *
   * **`shownRows`, not the row model**, and that is the whole of the mirroring:
   * the chart is the same list in the same order with the same branches open,
   * because it is the same list. The expansion is already the model's answer —
   * a collapsed branch's children are not in it — and the filter above is the
   * search's, which nothing else applies.
   *
   * Proof, twice, because one edit could not reach both halves. Fed
   * `table.getRowModel().rows`, the search's narrowing is lost and the
   * expansion's is not: `draws exactly the rows a search narrowed the plan to`
   * failed on four labels where the plan shows three, and `leaves a collapsed
   * branch's children off the chart` went on passing. Fed `flat` — every row of
   * the tree — that second test failed too, on four labels where the plan shows
   * two. Both watched, 2026-08-09.
   *
   * Built outside the column registry; its readers use the stable contract in
   * `plan-live.ts` rather than making chart inputs rebuild column definitions.
   */
  const ganttPlan: GanttPlan = useMemo<GanttPlan>(
    () => ({
      rows: shownRows.map((row) => ({
        id: row.id,
        // The Number column's own number, not a second derivation of it: the
        // chart's labels read `010 - Strip` because that is how the plan is
        // spoken about.
        number: row.original.number,
        name: row.original.name,
        depth: row.depth,
        // A leaf of the plan as drawn, which is a row with nothing under it —
        // the same question `getSubRows` answers for the table model.
        leaf: row.subRows.length === 0,
        schedule: {
          earliestStart: row.original.schedule.earliestStart,
          earliestFinish: row.original.schedule.earliestFinish,
        },
        notBeforeOffset: notBeforeOffsetOf(startDate, row.original.startNoEarlierThan),
        // The words about that date, for the floor sentence to append where the
        // not-before is the floor that actually binds this bar. Read on **every**
        // row rather than only the floored ones: which floor binds is
        // `floorWordsOf`'s answer, computed from the schedule, and a chart row
        // that carried the reason only where this side already thought it
        // mattered would be two places deciding one thing.
        notBeforeReason: row.original.startNoEarlierThanReason,
        // Straight off the tree read, like the trio beside it: what a bar says is
        // a fact about the plan the chart was drawn from, not about a draft
        // somebody is half-way through typing into the column.
        priority: row.original.priority,
        maxParallel: row.original.maxParallel,
        // The **effective** team, which is the pool be-01 scheduled this row's
        // slices against — not the label the row carries, which may be none at
        // all. A chart drawn from the stored label alone cannot say whose people
        // a bar is waiting for.
        team: effectiveTeamLabelOf(row.original),
        // The **effective** tags, for the team's reason one line up and for none
        // of its consequences: an inherited tag has to be sayable on the bar of a
        // row that names no tag, and that is the whole of what this field does.
        // Nothing on the chart is placed from it — see {@link GanttRow.tags}.
        tags: effectiveTagLabelOf(row.original),
        // The trio the plan holds for each step on this row, straight off the
        // tree read — the drafts a reader is half-way through typing are not
        // facts about the schedule the chart was drawn from.
        trioByStep: new Map(Object.entries(row.original.estimates)),
        waitsFor: row.original.dependsOn.map(
          // A predecessor the tree does not hold at all is the same modeled
          // absence `personFloorWords` already has words for, and it is said the
          // same way rather than left as a bare id.
          (predecessorId) => namedInTheTree.get(predecessorId) ?? 'work that is not shown',
        ),
      })),
      slices: chartRead.slices,
      // The full tree, ids and parents alone — `flat` and not `shownRows`, for
      // `namedInTheTree`'s reason: a dependency arrow's anchor is selected from
      // the predecessor's leaves' slices, and a collapsed branch's leaves are
      // exactly the rows the shown set has dropped (design.md D6).
      tree: flat.map((row) => ({ id: row.id, parentId: row.parentId })),
      // Why the rows above are the length they are, which the list itself cannot
      // say: `isFiltering`'s one answer, the same one the count beside the Find
      // box and the empty-answer sentence read, so the chart's account of what it
      // did not draw cannot disagree with the table's account of what it kept.
      narrowedByFilter: filtering,
      // **Every** stored dependency of the plan, `flat` and not `shownRows` since
      // F3. An edge whose ends are not both on screen is dropped by `layOutGantt`
      // and counted there, so the arrows drawn are the same ones as before — what
      // the widening adds is the edge that leaves a shown row for a hidden one,
      // which never reached the loop while this list was built from the
      // successors on screen, and so could not be counted or said.
      dependencies: flat.flatMap((row) =>
        row.dependsOn.map((predecessorId) => ({ predecessorId, successorId: row.id })),
      ),
      // All three off {@link chartRead}, which is one payload. **Not** `steps`
      // and `people`: those are the separate reads the pickers and the steps
      // dialog are about, and a slice checked against a step list from another
      // moment is the skew `layOutGantt` throws on.
      steps: chartRead.steps,
      personNames: new Map(chartRead.people.map((person) => [person.id, person.name])),
      teamNames: new Map(teams.map((team) => [team.id, team.name])),
      // The ladder the chart names its priorities with. Off the same state the
      // table's cells read, so a bar's cap and its row's digits are one colour.
      priorityBands,
      // Off the chart read for `roles`' reason exactly: the arrow leaves the
      // slice this names, and a reach out of step with the slices beside it
      // draws an arrow the engine never placed.
      depReach: chartRead.depReach,
    }),
    // Every value the object above reads. The three label readings and
    // `namedInTheTree` are `useCallback`/`useMemo` now precisely so this list can
    // hold: a closure rebuilt each render would make this memo a fresh object
    // every time and buy nothing.
    [
      shownRows,
      flat,
      chartRead,
      startDate,
      teams,
      priorityBands,
      filtering,
      namedInTheTree,
      effectiveTeamLabelOf,
      effectiveTagLabelOf,
    ],
  );

  // The `Start` column's sentences, off the same payload the chart is drawn
  // from and therefore off the same rows: a row narrowed away by the search has
  // no cell to explain, and one on a collapsed branch has none either.
  //
  // Assigned here rather than where the ref is declared because this is the
  // first line at which `ganttPlan` exists, and it is read out of the returned
  // tree — every cell renders after this statement has run.
  // The calendar is the second argument and not an optional one: a
  // dependency-floored row says *when* its wait clears, and a plan with no
  // start date has no day to say — `null` is that plan, stated rather than
  // defaulted into silence. `today` is the browser's, and it decides only
  // whether the year is printed (`shortIsoDate`).
  //
  // Memoised on the plan it reads. It ran on **every** render — six index builds
  // and a walk of every leaf, whether or not the chart was open — to supply one
  // hover sentence. `today` is taken as a day rather than a `Date` so it can be
  // a dependency at all: it decides only whether the year is printed, and a
  // fresh `Date` each render would make this memo a no-op.
  // The browser's own day as a plain `YYYY-MM-DD`, which is all the floor
  // sentence uses it for.
  const todayForFloor = new Date().toISOString().slice(0, 10);

  startFloor.current = useMemo(
    () =>
      startFloorByRow(
        ganttPlan,
        startDate === null ? null : { startDate, today: new Date(todayForFloor) },
      ),
    [ganttPlan, startDate, todayForFloor],
  );
  return { ganttPlan };
}

/**
 * Which workday of the plan a stored "start no earlier than" date holds a row
 * at, or null when there is no such workday to name.
 *
 * Null in two cases and both are modeled absences rather than missing answers:
 * nobody has set a date on the row, or the project is not on a calendar at all
 * — and a plan with no start date has an axis of offsets that a date could not
 * be placed on. The chart draws no not-before flag in either case, which is
 * what the row's own Start column says too.
 *
 * `workdaysBetween` is `libs/domain`'s, imported from the module rather than
 * the lib's index barrel: it is the inverse of the `addWorkdays` be-01 placed
 * the date with, and counting the days here would be a second implementation
 * of the calendar sitting under the columns that print it.
 */
export const notBeforeOffsetOf = (
  startDate: string | null,
  notBefore: string | null,
): number | null =>
  startDate === null || notBefore === null ? null : workdaysBetween(startDate, notBefore);

/**
 * Whether the plan could be scheduled at all, as the one thing the chart and
 * the table both read.
 *
 * A cycle is not a failure to report and retry: it is a plan somebody has to
 * fix, so it draws a sentence where the bars would be.
 */
export function usePlanSchedule({ scheduleError }: { scheduleError: 'cycle' | null }) {
  const hasSchedule = useCallback(() => scheduleError === null, [scheduleError]);

  const showSchedule = useCallback(
    (days: number) => (scheduleError === null ? showDay(days) : '—'),
    [scheduleError],
  );

  /**
   * When a work item happens: real dates once the plan is on a calendar, and
   * day offsets from day zero until then.
   *
   * One function for both figures and both renderers, because the fallback is
   * the interesting half: `dates` is null both while the project has no start
   * date and while the schedule could not be computed at all, and a second copy
   * of that sentence in the card renderer is one edit away from disagreeing
   * with the columns.
   */
  const spanOf = useCallback(
    (row: TreeRow) => {
      // One `today` for both ends of one row, so a render that straddles
      // midnight cannot print a start off this year and a finish off the next.
      const today = new Date();
      return {
        start: printedDay(row.dates?.startsOn ?? null, today, () =>
          showSchedule(row.schedule.earliestStart),
        ),
        finish: printedDay(row.dates?.endsOn ?? null, today, () =>
          showSchedule(row.schedule.earliestFinish),
        ),
      };
    },
    [showSchedule],
  );
  return { hasSchedule, showSchedule, spanOf };
}
