import { SETTABLE_STATUSES, type SettableStatus, type WorkItemStatus } from '@wbs/domain/progress';
import { type KeyboardEvent, useEffect, useState } from 'react';

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
 * and 28px holds one character. The word is said by the fact card and on the
 * picker's lines. No `title`: the browser drew its grey tooltip beside the
 * fact card, two boxes for one word (Dany, 2026-09-13: "remove the system grey
 * hint"), and a combobox takes no `aria-description` per `jsx-a11y`.
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

/**
 * What each status says about the row, for the cell's project fact.
 *
 * The status word comes first, because the cell itself is a glyph: `○ ◐ ✓`
 * is legible once learnt, and the card is where a reader learns it. Dany,
 * 2026-09-13: "hint pop-up must show the full name of the status or even write
 * status: unknown".
 */
const STATUS_WORDS: Readonly<Record<WorkItemStatus, string>> = {
  unknown: `Status: ${STATUS_LABEL.unknown}. Nobody has said where this work has got to.`,
  in_progress: `Status: ${STATUS_LABEL.in_progress}. Its steps disagree — one has finished, or one has said nothing — so the row is part-way through. Set it per step, or choose Done for all of it.`,
  done: `Status: ${STATUS_LABEL.done}. Every step of this work item says finished. The chart draws it over its fact span, the row is tinted, and its name is struck through.`,
};

export interface StatusCellProps {
  cellKey: string;
  rowNumber: string;
  rowId: string;
  status: WorkItemStatus;
  choose: (status: SettableStatus) => void;
  onGridKey: (event: KeyboardEvent<HTMLInputElement>) => void;
  /**
   * The list opened or closed. The column writes this into the cell-card
   * store so {@link PlanCell} lifts the pinned `<td>` while the list is on
   * screen — see the class note.
   */
  onOpenChange: (open: boolean) => void;
}

/**
 * The Status cell: the row's status as one glyph, and a two-line list to set it.
 *
 * The glyph is the box's `value`; the word is said by its fact card —
 * `Status: Unknown. …` — and the row is its `aria-label` (`Status of 010`) — the
 * handle every keyboard walk, browser proof and hint already finds the cell by,
 * kept stable when the cell stopped reading a word (`status-at-a-glance` D4).
 * `data-status-value` carries the status itself for anything that has to
 * assert on it rather than read a glyph.
 *
 * **The list has to be lifted out of the pinned layer.** This cell is pinned
 * since `status-at-a-glance`, and a pinned cell is sticky *with a z-index*,
 * which makes it a stacking context: the list's own `zIndex: 15` counts only
 * inside the cell, and the next row's pinned cells — later in the DOM, at the
 * same layer — paint over it. The Name and Links cards have the same problem
 * and the same answer: the cell says its card is open through the cell-card
 * store and `PlanCell` raises the `<td>` to `POPOVER_ROW_LAYER`. This list is
 * opened by a click rather than a hover, so it reports through
 * {@link StatusCellProps.onOpenChange} and the column writes the store's
 * **keyboard** reading — the list is only ever open while the box holds the
 * focus (the wrapper's `onBlur` closes it), so that is the truthful one.
 * Dany, 2026-09-13: "i cannot see the status dropdown when i try to change
 * the status" — the browser proof that passed had one row, so nothing sat
 * below the list to cover it.
 *
 * The priority cell's shape without its typing: there is nothing to type here,
 * so the box is a closed combobox that opens its list on a click or a plain
 * Enter and takes a line with a click or the list's own keys. `In progress` is
 * shown when the fold says so and is **not** on the list — it is a step's
 * statement and a row reads it only off the fold (`SETTABLE_STATUSES` in
 * `@wbs/domain`).
 *
 * The box is an `<input type="button">`. An input, and not `readOnly`, for the
 * deadline cell's reason: `editableGrid` walks `[data-cell]:not([readonly])`,
 * and a read-only box would fall out of the keyboard grid. A button, because a
 * text box draws a caret on a click and has its glyph selected by `focusCellAt`
 * on a Tab arrival — Dany, 2026-09-13: "interacting with status column puts a
 * cursor in it as if it is editable text field - i just want the drop-down, it
 * must not add cursor". A button supports no selection at all, so the grid
 * focuses it the way it does a date cell, and `caretOf` reads it as a box with
 * no text in the arrows' way. The glyph is its `value`, which a button shows as
 * its label; there is no `onChange` because nothing can be typed into it.
 */
export function StatusCell({
  cellKey,
  rowNumber,
  rowId,
  status,
  choose,
  onGridKey,
  onOpenChange,
}: StatusCellProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange(open);
  }, [onOpenChange, open]);
  const listId = `status-options-${rowId}`;
  return (
    <span
      style={{ position: 'relative', display: 'block', minWidth: 0 }}
      onBlur={() => {
        setOpen(false);
      }}
    >
      <input
        // Proof: `type` dropped so the box was a text input again, and `is a
        // button with no caret: neither a click nor the grid selects the glyph`
        // failed on `expected 'text' to be 'button'`, then on `selectionStart`
        // reading 0 where a button reads null. Watched 2026-09-13.
        type="button"
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
        data-fact-lead={STATUS_LABEL[status]}
        data-fact-tone={status === 'done' ? 'done' : undefined}
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
