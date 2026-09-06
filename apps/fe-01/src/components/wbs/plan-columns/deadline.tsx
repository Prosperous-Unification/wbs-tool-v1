import { DateField } from '../date-field';
import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { shortIsoDate } from '../short-date';
import { DATE_EDITOR_WIDTH } from '../table-frame';
import { column } from './column';

/** Builds the work-item deadline column against the stable live cell contract. */
export function createDeadlineColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'deadline',
    header: () => <span>Due</span>,
    cell: ({ row }) => {
      const day = row.original.deadline;
      const noCalendar = live.current.startDate === null;
      const editing = live.current.editingDeadline === row.original.id;
      const open = (): void => {
        if (!noCalendar) live.current.openDeadline(row.original.id);
      };
      const close = (): void => {
        live.current.closeDeadline(row.original.id);
      };

      return editing ? (
        <DateField
          aria-label={`Deadline for ${row.original.number}`}
          data-deadline={row.original.id}
          data-cell={cellKey(row.original.id, 'deadline')}
          data-hint="The last day this work item may finish on. It does not move the plan; a plan that misses it says so."
          onKeyDown={(event) => {
            if (event.key === 'Enter') close();
            live.current.onAltMove(event, row.original, 'deadline');
            live.current.onCommandKey(event, row.original, 'deadline');
            live.current.onTabKey(event, row.original.id, 'deadline');
          }}
          onExit={close}
          style={{
            position: 'relative',
            zIndex: 10,
            width: DATE_EDITOR_WIDTH,
            boxSizing: 'border-box',
            font: 'inherit',
          }}
          value={day ?? ''}
          commit={(typed) => {
            live.current.setDeadline(row.original.id, typed === '' ? null : typed);
          }}
        />
      ) : (
        <input
          aria-label={`Deadline for ${row.original.number}`}
          disabled={noCalendar}
          data-deadline={row.original.id}
          data-cell={cellKey(row.original.id, 'deadline')}
          data-fact={
            noCalendar
              ? 'Set the project start date first — without one there are no dates to hold a deadline against.'
              : [
                  day === null ? null : `${day}.`,
                  'The last day this work item may finish on. It does not move the plan; a plan that misses it says so.',
                ]
                  .filter((part) => part !== null)
                  .join(' ')
          }
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            background: 'transparent',
            border: 'none',
            cursor: noCalendar ? 'not-allowed' : 'text',
          }}
          value={day === null ? '—' : shortIsoDate(day, new Date())}
          onChange={open}
          onClick={open}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              open();
              return;
            }
            live.current.onAltMove(event, row.original, 'deadline');
            live.current.onCommandKey(event, row.original, 'deadline');
            live.current.onTabKey(event, row.original.id, 'deadline');
          }}
        />
      );
    },
  });
}
