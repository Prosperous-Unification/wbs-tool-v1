import { createColumnHelper, type RowData } from '@tanstack/react-table';

import { type TreeRow } from '../wbs-rows';

export const column = createColumnHelper<TreeRow>();

declare module '@tanstack/react-table' {
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
  // The generic parameters are TanStack's own; this interface is merged into
  // its declaration, so they are named to match rather than used here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    spokenHeading?: string;
  }
}
