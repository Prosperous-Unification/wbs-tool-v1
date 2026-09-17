import { useCardOpenOn } from '../cell-card-store';
import { cellKey } from '../editable-grid';
import { HoverCard } from '../hover-card';
import { startCardId } from '../plan-cell-props';
import { useStartSentence } from '../plan-cell-reading-context';
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
      // A subscription and not a reading off `live`: this cell is a component,
      // so it can be told about its own card without the table rendering.
      // First, and unconditionally, because it is a hook.
      // `flexRender` builds this with `React.createElement`, so it **is** a
      // component and the hook below is legal; the rule reads the property
      // name `cell` and cannot see the call site.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const cardOpen = useCardOpenOn(live.current.cellCards, cellKey(row.original.id, 'start'));
      const { start } = row.original.readings;
      // eslint-disable-next-line react-hooks/rules-of-hooks -- TanStack flexRender invokes this cell as a React component.
      const said = useStartSentence();
      // The open card is the cell store's own mutable reading.
      const carded = said !== null && cardOpen;
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
              // Beside the cell, on the side with the room: a card standing
              // under it covers the rows below, and a plan is read down a
              // column. Dany, 2026-09-10: _"I still want to see what is up and
              // down from it for context"_. See {@link sidewaysPlacement}.
            >
              {said}
            </HoverCard>
          )}
        </span>
      );
    },
  });
}
