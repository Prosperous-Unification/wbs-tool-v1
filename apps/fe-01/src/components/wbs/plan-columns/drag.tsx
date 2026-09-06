import type { PlanLive } from '../plan-live';
import { column } from './column';

/** Builds the drag column family against the stable live cell contract. */
export function createDragColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'drag',
    header: () => <span aria-label="Reorder" />,
    cell: ({ row }) => {
      // A frozen row keeps its handle, and says on it why the handle will
      // not help. Hiding it was the first attempt, and it made the refusal
      // unreachable: nothing could explain the freeze to someone who tried,
      // and the test that claimed to prove the refusal was proving only that
      // the handle was gone. Both reviewers found that test.
      const frozen = row.original.frozenNumber !== null;
      return (
        <span
          draggable
          role="button"
          tabIndex={-1}
          aria-disabled={frozen}
          aria-label={`Reorder ${row.original.number}`}
          // The refusal is about this row and opens at once; what the grip
          // is for is the tool, and waits.
          {...(frozen
            ? { 'data-fact': 'Frozen — unfreeze this row before moving it' }
            : { 'data-hint': 'Drag to move this row' })}
          style={{ cursor: frozen ? 'not-allowed' : 'grab' }}
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
