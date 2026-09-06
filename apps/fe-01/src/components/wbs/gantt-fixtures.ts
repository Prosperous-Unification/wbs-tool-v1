import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';

import type { GanttPlan, GanttRow, GanttSlice } from './gantt-geometry';
import { createPointedRows, type PointedRows } from './pointed-row-store';

/**
 * The plan fixtures every `GanttPanel` suite renders, in one module.
 *
 * They lived inside `gantt-panel.test.tsx` until `gantt-panel.zoned.test.tsx`
 * needed them too, and a test file is the one kind of module a second test file
 * cannot import from: vitest would collect the importer's suites as well, so
 * the zoned run would have executed the whole 7 800-line UTC file under
 * `Pacific/Auckland`. Copying them instead would have left two plan shapes
 * drifting apart across two tiers — the same fault `vite-config.test.ts` exists
 * to catch one directory up. Not a `.test.ts` file, so neither config collects
 * it.
 */

/**
 * A {@link PointedRows} already answering `rowId` — the chart's pointer, which
 * needs no shown-row guard. What every render hands the panel in place of the
 * resolved string the prop used to be.
 */
export const pointedAtRow = (rowId: string | null): PointedRows => {
  const pointed = createPointedRows();
  pointed.pointChart(rowId, 'pointer');
  return pointed;
};

/** A shown row: a leaf over these workdays, unless `extras` says otherwise. */
export const rowAt = (
  id: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttRow> = {},
): GanttRow => ({
  id,
  number: id,
  name: id,
  depth: 0,
  leaf: true,
  schedule: { earliestStart, earliestFinish },
  notBeforeOffset: null,
  priority: null,
  maxParallel: 1,
  // The facts a row is enriched with before the chart is drawn. Absent by
  // default and named by the tests that are about them, so a fixture never has
  // to state a team it is not asking about.
  team: { state: 'none' },
  tags: { own: [], inherited: [] },
  trioByStep: new Map(),
  waitsFor: [],
  ...extras,
});

/** A scheduled slice over these workdays, under the `dev` step. */
export const sliceAt = (
  id: string,
  workItemId: string,
  earliestStart: number,
  earliestFinish: number,
  extras: Partial<GanttSlice> = {},
): GanttSlice => ({
  id,
  workItemId,
  stepId: 'dev',
  personId: null,
  duration: earliestFinish - earliestStart,
  estimated: true,
  earliestStart,
  earliestFinish,
  float: 0,
  critical: false,
  boundBy: 'projectStart',
  resourcePredecessorId: null,
  capacityTeamId: null,
  width: 1,
  effort: earliestFinish - earliestStart,
  capacityPredecessorIds: [],
  lateBy: null,
  ...extras,
});

/**
 * The full tree a fixture's shown rows imply: each row's parent is the
 * nearest shallower row above it — enough for every plan built here, whose
 * predecessors are all shown.
 */
const treeFrom = (rows: readonly GanttRow[]): { id: string; parentId: string | null }[] => {
  const above: { id: string; depth: number }[] = [];
  return rows.map((row) => {
    while (above.length > 0 && above[above.length - 1].depth >= row.depth) above.pop();
    const parentId = above.length > 0 ? above[above.length - 1].id : null;
    above.push({ id: row.id, depth: row.depth });
    return { id: row.id, parentId };
  });
};

export const planOf = (parts: Partial<GanttPlan>): GanttPlan => ({
  rows: [],
  slices: [],
  dependencies: [],
  tree: treeFrom(parts.rows ?? []),
  // Off unless a test is about the sentence a filter's dropped waits earn.
  narrowedByFilter: false,
  steps: [{ id: 'dev', name: 'Dev' }],
  personNames: new Map(),
  teamNames: new Map([['team-platform', 'Platform']]),
  priorityBands: DEFAULT_PRIORITY_BANDS,
  // The default a project takes unless it asks otherwise.
  depReach: 'whole-item',
  ...parts,
});

/**
 * The Monday every calendar fixture begins on.
 *
 * Every coordinate asserted against it is taken at an offset **past the first
 * weekend**, where the calendar number and the workday number differ. An
 * assertion at workday 3 passes unchanged on the axis this change replaced and
 * so proves nothing.
 */
export const MONDAY_START = '2026-08-10';
