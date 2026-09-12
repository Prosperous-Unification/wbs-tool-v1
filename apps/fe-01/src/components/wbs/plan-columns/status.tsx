import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { StatusCell } from '../status-cell';
import { column } from './column';

/** Builds the Status column against the stable live cell contract. */
export function createStatusColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'status',
    // Every row, a parent included: choosing Done on a parent speaks for every
    // leaf beneath it (`WorkItemService.setStatus`), which is the one row-level
    // write in this table that a parent takes.
    meta: { isEditable: () => true },
    header: () => <span>Status</span>,
    cell: ({ row }) => (
      <StatusCell
        cellKey={cellKey(row.original.id, 'status')}
        rowNumber={row.original.number}
        rowId={row.original.id}
        status={row.original.status}
        choose={(status) => {
          live.current.setStatus(row.original.id, status);
        }}
        onGridKey={(event) => {
          live.current.onAltMove(event, row.original, 'status');
          live.current.onCommandKey(event, row.original, 'status');
          live.current.onTabKey(event, row.original.id, 'status');
          live.current.onArrowKey(event, row.original.id, 'status');
        }}
      />
    ),
  });
}
