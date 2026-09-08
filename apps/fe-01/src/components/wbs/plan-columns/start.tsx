import { cellKey } from '../editable-grid';
import { HoverCard } from '../hover-card';
import { startCardId } from '../plan-cell-props';
import type { PlanLive } from '../plan-live';
import { rowWords } from '../work-item-words';
import { column } from './column';

/** Builds the start column family against the stable live cell contract. */
export function createStartColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'start',
    // A bare `2.5` under "Start" reads as a date that failed to load, and
    // the header used to say which of the two it was — in 52px it cannot,
    // so the distinction moved into the cell's own hover card. The column
    // is a figure either way and the cell shows which kind it is.
    header: () => <span>Start</span>,
    cell: ({ row }) => {
      const start = live.current.spanOf(row.original).start;
      const said = live.current.startSentence(row.original);
      // The open card is a mutable reading under the PlanLive contract.
      const carded = said !== null && live.current.openCard === cellKey(row.original.id, 'start');
      return (
        // The positioned ancestor the card opens from, `display: block` so
        // the figure still fills the cell. The pointer handlers are on the
        // `<td>` and not here — see {@link startCellProps}, and the
        // `wbs-waiting-sentence-hover-target` reasoning it carries: the
        // whole cell is the target rather than a 34×13px span inside it.
        <span style={{ position: 'relative', display: 'block' }}>
          <span
            data-start
            // The on-screen mark that there is something to read, which a
            // tooltip of any kind shows nothing of until a pointer
            // happens to stop on the cell.
            style={said === null ? undefined : { textDecoration: 'underline dotted' }}
          >
            {start.text}
          </span>
          {carded && (
            <HoverCard
              id={startCardId(row.original.id)}
              label={`Start of ${rowWords(row.original.number, row.original.name)}`}
            >
              {said}
            </HoverCard>
          )}
        </span>
      );
    },
  });
}
