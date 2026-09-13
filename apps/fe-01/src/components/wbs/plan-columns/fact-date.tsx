import { DateField } from '../date-field';
import { cellKey } from '../editable-grid';
import type { PlanLive, PlanLiveValues } from '../plan-live';
import type { PlanRenderRow } from '../plan-render-rows';
import { shortIsoDate } from '../short-date';
import { DATE_EDITOR_WIDTH } from '../table-frame';
import { column } from './column';

/** Which of the two facts a column is, and where it reads and writes it. */
interface FactDateColumn {
  id: 'fact-start' | 'fact-end';
  heading: string;
  /** The reader-facing noun, `Fact start` / `Fact end` — the cell's accessible name. */
  noun: string;
  /** What the column's rest state says about a row nobody has recorded on. */
  hint: string;
  dayOf: (row: PlanRenderRow) => string | null;
  editing: (row: PlanRenderRow) => boolean;
  open: (live: PlanLiveValues, rowId: string) => void;
  close: (live: PlanLiveValues, rowId: string) => void;
  set: (live: PlanLiveValues, rowId: string, day: string | null) => void;
}

/**
 * The deadline cell's two states — the short date at rest, the date editor when
 * opened — for a fact that is a record rather than a constraint.
 *
 * No calendar is required and no impossible mark exists: a fact is an absolute
 * day the work happened on, true on a plan with no start date as on one with,
 * and there is nothing for it to be before. Editable on a parent as on a leaf:
 * facts are held like `deadline`, per row and never folded.
 */
function createFactDateColumn(which: FactDateColumn, live: PlanLive) {
  return column.display({
    id: which.id,
    meta: { isEditable: () => true },
    header: () => <span>{which.heading}</span>,
    cell: ({ row }) => {
      const day = which.dayOf(row.original);
      const editing = which.editing(row.original);
      const label = `${which.noun} of ${row.original.number}`;
      const close = (): void => {
        which.close(live.current, row.original.id);
      };
      const open = (): void => {
        which.open(live.current, row.original.id);
      };
      return editing ? (
        <DateField
          aria-label={label}
          data-cell={cellKey(row.original.id, which.id)}
          data-hint={which.hint}
          onKeyDown={(event) => {
            if (event.key === 'Enter') close();
            live.current.onAltMove(event, row.original, which.id);
            live.current.onCommandKey(event, row.original, which.id);
            live.current.onTabKey(event, row.original.id, which.id);
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
            which.set(live.current, row.original.id, typed === '' ? null : typed);
          }}
        />
      ) : (
        <input
          aria-label={label}
          data-cell={cellKey(row.original.id, which.id)}
          data-fact={day === null ? which.hint : `${day}. ${which.hint}`}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: 'inherit',
            background: 'transparent',
            border: 'none',
            cursor: 'text',
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
            live.current.onAltMove(event, row.original, which.id);
            live.current.onCommandKey(event, row.original, which.id);
            live.current.onTabKey(event, row.original.id, which.id);
          }}
        />
      );
    },
  });
}

/** Builds the Fact start column against the stable live cell contract. */
export function createFactStartColumn({ live }: { live: PlanLive }) {
  return createFactDateColumn(
    {
      id: 'fact-start',
      heading: 'Fact start',
      noun: 'Fact start',
      hint: 'The day work on this item actually began. A record beside the forecast: it moves no date.',
      dayOf: (row) => row.factStart,
      editing: (row) => row.readings.editingFactStart,
      open: (values, rowId) => {
        values.openFactStart(rowId);
      },
      close: (values, rowId) => {
        values.closeFactStart(rowId);
      },
      set: (values, rowId, day) => {
        values.setFactStart(rowId, day);
      },
    },
    live,
  );
}

/** Builds the Fact end column against the stable live cell contract. */
export function createFactEndColumn({ live }: { live: PlanLive }) {
  return createFactDateColumn(
    {
      id: 'fact-end',
      heading: 'Fact end',
      noun: 'Fact end',
      hint: 'The day work on this item actually finished. Filled with today when the row is marked done; a done row’s bar stops here.',
      dayOf: (row) => row.factEnd,
      editing: (row) => row.readings.editingFactEnd,
      open: (values, rowId) => {
        values.openFactEnd(rowId);
      },
      close: (values, rowId) => {
        values.closeFactEnd(rowId);
      },
      set: (values, rowId, day) => {
        values.setFactEnd(rowId, day);
      },
    },
    live,
  );
}
