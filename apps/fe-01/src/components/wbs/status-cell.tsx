import { SETTABLE_STATUSES, type SettableStatus, type WorkItemStatus } from '@wbs/domain/progress';
import { type KeyboardEvent, useState } from 'react';

import { STATUS_HINT } from './column-hints';
import { PickerList } from './creatable-picker';

/** The word each status reads as, in the cell and on its list. */
export const STATUS_LABEL: Readonly<Record<WorkItemStatus, string>> = {
  unknown: 'Unknown',
  in_progress: 'In progress',
  done: 'Done',
};

/** What each status says about the row, for the cell's project fact. */
const STATUS_WORDS: Readonly<Record<WorkItemStatus, string>> = {
  unknown: 'Nobody has said where this work has got to.',
  in_progress:
    'Its steps disagree — one has finished, or one has said nothing — so the row is part-way through. Set it per step, or choose Done for all of it.',
  done: 'Every step of this work item says finished. The chart draws it over its fact span, and its name is struck through.',
};

export interface StatusCellProps {
  cellKey: string;
  rowNumber: string;
  rowId: string;
  status: WorkItemStatus;
  choose: (status: SettableStatus) => void;
  onGridKey: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The Status cell: the row's status in a word, and a two-line list to set it.
 *
 * The priority cell's shape without its typing: there is nothing to type here,
 * so the box is a closed combobox that opens its list on a click or a plain
 * Enter and takes a line with a click or the list's own keys. `In progress` is
 * shown when the fold says so and is **not** on the list — it is a step's
 * statement and a row reads it only off the fold (`SETTABLE_STATUSES` in
 * `@wbs/domain`).
 *
 * The box is an `<input>` and not `readOnly`, for the deadline cell's reason:
 * `editableGrid` walks `[data-cell]:not([readonly])`, and a read-only box would
 * fall out of the keyboard grid. `onChange` opens the list instead of writing.
 */
export function StatusCell({
  cellKey,
  rowNumber,
  rowId,
  status,
  choose,
  onGridKey,
}: StatusCellProps) {
  const [open, setOpen] = useState(false);
  const listId = `status-options-${rowId}`;
  return (
    <span
      style={{ position: 'relative', display: 'block', minWidth: 0 }}
      onBlur={() => {
        setOpen(false);
      }}
    >
      <input
        aria-label={`Status of ${rowNumber}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        data-cell={cellKey}
        data-status={rowId}
        data-status-value={status}
        data-hint={STATUS_HINT}
        data-fact={STATUS_WORDS[status]}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          font: 'inherit',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: status === 'done' ? 'var(--muted-foreground)' : undefined,
        }}
        value={STATUS_LABEL[status]}
        onChange={() => {
          setOpen(true);
        }}
        onClick={() => {
          setOpen((was) => !was);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (
            event.key === 'Enter' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
            setOpen((was) => !was);
            return;
          }
          onGridKey(event);
        }}
      />
      {open && (
        <PickerList
          id={listId}
          label={`Status for ${rowNumber}`}
          options={SETTABLE_STATUSES.map((offered) => ({
            key: `${listId}-${offered}`,
            label: STATUS_LABEL[offered],
            selected: offered === status,
            take: () => {
              setOpen(false);
              if (offered !== status) choose(offered);
            },
          }))}
        />
      )}
    </span>
  );
}
