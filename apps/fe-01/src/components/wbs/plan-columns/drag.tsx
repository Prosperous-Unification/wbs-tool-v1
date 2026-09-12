import type { PlanLive } from '../plan-live';
import { column } from './column';

/** Builds the drag column family against the stable live cell contract. */
export function createDragColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'drag',
    header: () => <span aria-label="Reorder" />,
    cell: ({ row }) => {
      // No frozen state here since ADR 0023. This handle used to carry
      // `aria-disabled` and a `data-fact` reading "Frozen — unfreeze this row
      // before moving it", because be-01 refused the move; a frozen work item
      // moves like any other now, and the number travels with it.
      return (
        <span
          draggable
          role="button"
          tabIndex={-1}
          aria-label={`Reorder ${row.original.number}`}
          data-hint="Drag to move this row"
          style={{ cursor: 'grab' }}
          onDragStart={() => {
            live.current.setDragging(row.original.id);
          }}
          onDragEnd={() => {
            live.current.setDragging(null);
            live.current.setDropHint(null);
          }}
        >
          ⠿
        </span>
      );
    },
  });
}
