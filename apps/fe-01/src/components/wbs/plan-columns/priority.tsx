import { cellKey } from '../editable-grid';
import { flushCell } from '../live-editing';
import type { PlanLive } from '../plan-live';
import { PriorityCell } from '../priority-cell';
import { column } from './column';

/** Builds the priority column family against the stable live cell contract. */
export function createPriorityColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'priority',
    meta: { isEditable: () => true },
    // `Prio`, not `Priority` and not `PRIORITY`: the column is 48px and the
    // header row is 10px all-caps, in which the full word wraps to two
    // lines and takes the whole header row with it. The sentence is on the
    // `<th>` (`column-hints.ts`), which is the bargain Days, Not bef.,
    // Start, End and Slack already make.
    header: () => <span>Prio</span>,
    cell: ({ row }) => (
      /*
            The box, the band list under it, and the colour the number is drawn
            in — all three in `priority-cell.tsx`, so the one place a band becomes
            a colour is `priority-band-style.ts` and this column has no opinion of
            its own about it.

            The ladder follows the PlanLive contract: a re-cut ladder redraws
            because the rows redraw, while their cell definitions stay mounted.
          */
      <PriorityCell
        cellKey={cellKey(row.original.id, 'priority')}
        rowNumber={row.original.number}
        rowId={row.original.id}
        bands={row.original.readings.priorityBands}
        priority={row.original.priority}
        commit={(typed) => live.current.setPriority(row.original.id, typed)}
        // A picked line is the same write a typed number is — one `patch`,
        // one journal entry, one undo — which is what makes the two languages
        // round-trip into each other rather than into two histories.
        choose={(value) => {
          void live.current.setPriority(row.original.id, String(value));
        }}
        onEnter={(box) => {
          void flushCell(box);
        }}
        onGridKey={(e) => {
          live.current.onAltMove(e, row.original, 'priority');
          live.current.onCommandKey(e, row.original, 'priority');
          live.current.onTabKey(e, row.original.id, 'priority');
          live.current.onArrowKey(e, row.original.id, 'priority');
        }}
      />
    ),
  });
}
