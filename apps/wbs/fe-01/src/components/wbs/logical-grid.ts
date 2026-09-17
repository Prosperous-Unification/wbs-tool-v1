import { type CellRef } from './cell-navigation';

/** A visible logical column and the rows on which it accepts editing focus. */
export interface LogicalColumn<TRow> {
  id: string;
  isEditable?: (row: TRow) => boolean;
}

/**
 * Builds the editable grid in reading order without consulting mounted DOM.
 *
 * Rows are already filtered and expanded, columns are already structurally
 * hidden or unfolded, and a missing predicate means the column is read-only.
 */
export function logicalGrid<TRow extends { id: string }>(
  rows: readonly TRow[],
  columns: readonly LogicalColumn<TRow>[],
): CellRef[] {
  return rows.flatMap((row) =>
    columns.flatMap((column) =>
      column.isEditable?.(row) === true ? [{ rowId: row.id, columnId: column.id }] : [],
    ),
  );
}
