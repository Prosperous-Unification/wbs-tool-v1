import {
  type CellData,
  createColumnHelper,
  createExpandedRowModel,
  type RowData,
  rowExpandingFeature,
  type TableFeatures,
  tableFeatures,
} from '@tanstack/react-table';

import { type TreeRow } from '../wbs-rows';

/**
 * The table's features, named once: rows that expand, and the row model that
 * honours the expansion. TanStack Table 9 builds a table from exactly the
 * features it is handed — nothing else is on the instance or in its types —
 * so this is also the list of what the plan's columns and rows may call.
 */
export const PLAN_TABLE_FEATURES = tableFeatures({
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
});
export type PlanTableFeatures = typeof PLAN_TABLE_FEATURES;

export const column = createColumnHelper<PlanTableFeatures, TreeRow>();

declare module '@tanstack/table-core' {
  /**
   * What a column is called out loud, where that is not what its heading
   * shows.
   *
   * Two columns print a mark rather than a word — `#` for the numbering and
   * `o`/`r`/`p` for the three estimate points — because the words do not fit
   * in 93px and 44px and a clipped word says less than a mark does. A heading
   * a screen reader reads as "hash" or "oh" is a column with no name, so the
   * word is declared here and put on the `<th>` as its `aria-label`.
   *
   * On the definition rather than in a lookup beside the render, so the
   * heading and the word it stands for are written in the same place; on the
   * `<th>` rather than inside it because an `aria-label` on a `<span>` with no
   * role of its own is not reliably part of the cell's accessible name — the
   * fault this went through: `getByRole('columnheader', { name: 'Number' })`
   * found nothing with the label a level down.
   */
  // The generic parameters — variance annotations included — are TanStack's
  // own; this interface is merged into its declaration in `@tanstack/table-core`
  // (what `@tanstack/react-table` re-exports), so they are spelled to match
  // rather than used here.
  /* eslint-disable @typescript-eslint/no-unused-vars -- the merged declaration's own parameters, unused by this member */
  interface ColumnMeta<
    in out TFeatures extends TableFeatures,
    in out TData extends RowData,
    TValue extends CellData = CellData,
  > {
    spokenHeading?: string;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}
