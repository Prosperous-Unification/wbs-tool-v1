import { DEADLINE_EFFECT_HINT } from '../column-hints';
import { DateField } from '../date-field';
import { DEADLINE_BEFORE_START, deadlineBeforeProjectStart } from '../deadline-impossible';
import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { shortIsoDate } from '../short-date';
import { DATE_EDITOR_WIDTH } from '../table-frame';
import { column } from './column';

const DEADLINE_MARK_PX = 10;

/** Builds the work-item deadline column against the stable live cell contract. */
export function createDeadlineColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'deadline',
    header: () => <span>Due</span>,
    cell: ({ row }) => {
      const day = row.original.deadline;
      const noCalendar = live.current.startDate === null;
      const impossible = deadlineBeforeProjectStart(live.current.startDate, day);
      const impossibleMarkId = impossible ? `deadline-impossible-${row.original.id}` : undefined;
      const editing = live.current.editingDeadline === row.original.id;
      const open = (): void => {
        if (!noCalendar) live.current.openDeadline(row.original.id);
      };
      const close = (): void => {
        live.current.closeDeadline(row.original.id);
      };

      return (
        // The impossible mark stays mounted while the editor is open so its
        // aria-describedby target continues to name why the date is invalid.
        <span style={{ position: 'relative', display: 'block' }}>
          {editing ? (
            <DateField
              aria-label={`Work item deadline for ${row.original.number}`}
              aria-describedby={impossibleMarkId}
              aria-invalid={impossible ? true : undefined}
              data-deadline={row.original.id}
              data-cell={cellKey(row.original.id, 'deadline')}
              data-hint={DEADLINE_EFFECT_HINT}
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
              aria-label={`Work item deadline for ${row.original.number}`}
              aria-describedby={impossibleMarkId}
              aria-invalid={impossible ? true : undefined}
              disabled={noCalendar}
              data-deadline={row.original.id}
              data-cell={cellKey(row.original.id, 'deadline')}
              data-fact={
                noCalendar
                  ? 'Set the project start date first — without one there are no dates to hold a work item deadline against.'
                  : [
                      day === null ? null : `${day}.`,
                      impossible ? DEADLINE_BEFORE_START : DEADLINE_EFFECT_HINT,
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
                paddingRight: impossible ? DEADLINE_MARK_PX : undefined,
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
          )}
          {impossible && (
            <span
              aria-label={`Work item deadline for ${row.original.number} falls before the project's first working day`}
              role="img"
              id={impossibleMarkId}
              data-deadline-impossible={row.original.id}
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: DEADLINE_MARK_PX,
                textAlign: 'right',
                pointerEvents: 'none',
                color: 'var(--destructive)',
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              !
            </span>
          )}
        </span>
      );
    },
  });
}
