import { cellKey } from '../editable-grid';
import { isoToday } from '../gantt-panel';
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
    // One glyph for a 28px column — the word would not fit — with the word as
    // the heading's accessible name, so the Columns control, the hint and a
    // screen reader all still say `Status`.
    header: () => (
      <span role="img" aria-label="Status" title="Status">
        ○
      </span>
    ),
    cell: ({ row }) => (
      <StatusCell
        cellKey={cellKey(row.original.id, 'status')}
        rowNumber={row.original.number}
        rowId={row.original.id}
        status={row.original.status}
        choose={(status) => {
          // `Done` is asked about before it is written — the completion prompt
          // holds the day and sends the command on confirm; `Unknown` is sent
          // at once, with the reader's day be-01 reads nothing from.
          // Proof: this branch collapsed to a direct `setStatus`, and
          // `choosing Done opens the completion prompt and sends nothing until
          // it is confirmed` fails on `Unable to find an accessible element
          // with the role "dialog" and name "Mark 010 done"` — the row marked
          // done with nobody asked; watched 2026-09-13.
          if (status === 'done') {
            live.current.openCompletionPrompt(row.original.id);
            return;
          }
          void live.current.setStatus(row.original.id, status, isoToday(new Date()));
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
