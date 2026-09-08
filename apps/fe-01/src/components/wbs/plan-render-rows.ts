import { type PrintedDay } from './short-date';
import { type TreeRow } from './wbs-rows';

/** Immutable values a plan cell renders that are not already carried by its row. */
export interface PlanRowReadings {
  hasSchedule: boolean;
  finish: PrintedDay;
}

/** A tree row with the immutable values computed for the current React render. */
export type RowWithReadings<TReadings> = Omit<TreeRow, 'subRows'> & {
  subRows: RowWithReadings<TReadings>[];
  readings: TReadings;
};

/** The row type owned by the plan table and its stable column components. */
export type PlanRenderRow = RowWithReadings<PlanRowReadings>;

/**
 * Attaches current render values to every row while preserving the tree.
 *
 * The projection is recursive because TanStack asks `subRows` for expansion;
 * leaving children as bare {@link TreeRow}s would make deep cells fall back to
 * mutable table state even though root cells receive explicit readings.
 */
export function attachRowReadings<TReadings>(
  rows: readonly TreeRow[],
  readingsOf: (row: TreeRow) => TReadings,
): RowWithReadings<TReadings>[] {
  return rows.map((row) => ({
    ...row,
    subRows: attachRowReadings(row.subRows, readingsOf),
    readings: readingsOf(row),
  }));
}
