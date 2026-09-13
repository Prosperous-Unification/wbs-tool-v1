import { showDay } from '../plan-number-format';
import { column } from './column';

/** Builds the final-total column family against the stable live cell contract. */
export function createFinalTotalColumn() {
  return column.display({
    id: 'final-total',
    // One word, because the column is 52px wide: it holds a number of days
    // and the steps beside it hold days too. The sentence it used to be is
    // on the `<th>` (`column-hints.ts`), where every column's is.
    header: () => <span>Days</span>,
    cell: ({ row }) => (
      <span data-final-total style={{ fontWeight: 600 }}>
        {showDay(row.original.finalTotal)}
      </span>
    ),
  });
}
