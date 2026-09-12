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

/**
 * The glyph each status is drawn as, in the cell and on the column heading.
 *
 * An empty ring, a half ring and a tick: the first two are one shape filling
 * up, the third is the one mark every reader takes for finished. Glyphs and
 * not an icon set because the table draws with text everywhere else (`⠿`, `✕`)
 * and 28px holds one character. The word stays in the cell's `title` and on
 * the picker's lines.
 */
export const STATUS_GLYPH: Readonly<Record<WorkItemStatus, string>> = {
  unknown: '○',
  in_progress: '◐',
  done: '✓',
};

/** The colour each status is said in — the strip's, the tint's and this cell's. */
const STATUS_COLOR: Readonly<Record<WorkItemStatus, string>> = {
  unknown: 'var(--muted-foreground)',
  in_progress: 'var(--status-in-progress)',
  done: 'var(--status-done)',
};

/** What each status says about the row, for the cell's project fact. */
const STATUS_WORDS: Readonly<Record<WorkItemStatus, string>> = {
  unknown: 'Nobody has said where this work has got to.',
  in_progress:
    'Its steps disagree — one has finished, or one has said nothing — so the row is part-way through. Set it per step, or choose Done for all of it.',
  done: 'Every step of this work item says finished. The chart draws it over its fact span, the row is tinted, and its name is struck through.',
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
 * The Status cell: the row's status as one glyph, and a two-line list to set it.
 *
 * The glyph is the box's `value`; the word is its `title` (a combobox takes no
 * `aria-description`, per `jsx-a11y`), and the row is its `aria-label`
 * (`Status of 010`) — the
 * handle every keyboard walk, browser proof and hint already finds the cell by,
 * kept stable when the cell stopped reading a word (`status-at-a-glance` D4).
 * `data-status-value` carries the status itself for anything that has to
 * assert on it rather than read a glyph.
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
        title={STATUS_LABEL[status]}
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
          textAlign: 'center',
          padding: 0,
          color: STATUS_COLOR[status],
        }}
        value={STATUS_GLYPH[status]}
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
