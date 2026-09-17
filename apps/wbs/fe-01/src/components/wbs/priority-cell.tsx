import { type KeyboardEvent, type ReactNode, useState } from 'react';

import type { PriorityBandView } from '@/lib/wbs-api';

import { CellInput } from './cell-input';
import { PickerList } from './creatable-picker';
import type { CellElement } from './editable-grid';
import type { SendEdit } from './live-editing';
import { priorityBandStyleOf } from './priority-band-style';
import { PRIORITY_GLYPH_ROOM_PX, PriorityChevron } from './priority-chevron';

/**
 * What was typed, with a band's own name turned into the number it writes.
 *
 * **Two languages, one box.** Dany, 2026-08-13: _"I want to be able to easily
 * select priority by labels or input a number manually"_. A typed number is the
 * number; a typed band name — case-insensitive, trimmed — is that band's own
 * default value. Both arrive at the same `setPriority` and both round-trip: the
 * number is stored, the cell reads it back, and it resolves to the band whose
 * name was typed. `openspec/changes/priority-bands/design.md` D6.
 *
 * A label is resolved **before** the number, and the order is not arbitrary: a
 * project that renames a band to `7` would otherwise have a name nobody could
 * type. Nothing stops a project doing that, and this is the one line that decides
 * which of the two it means — the label wins, because a name is what somebody
 * chose to type and a number they can still write as the band's own value.
 *
 * Anything else comes back **verbatim**, and deliberately: text that is neither a
 * number nor a name is `setPriority`'s to refuse out loud, with the toast it has
 * refused `1e999` with since `priority-column`. Answering `null` here would put a
 * second refusal path beside that one, and the two would eventually disagree
 * about which typos clear a priority — `Number('urgent')` is `NaN`, `NaN` on the
 * wire is `null`, and `null` is the clear.
 */
export function priorityTyped(bands: readonly PriorityBandView[], typed: string): string {
  const wanted = typed.trim().toLowerCase();
  if (wanted === '') return '';
  const named = bands.find((band) => band.label.trim().toLowerCase() === wanted);
  if (named !== undefined) return String(named.defaultValue);
  return typed;
}

export interface PriorityCellProps {
  /** `rowId::priority` — how the grid finds this box. */
  cellKey: string;
  /** The row's number, for the box's accessible name. */
  rowNumber: string;
  /** The row's id, carried as `data-priority` for the tests and the grid. */
  rowId: string;
  /** This plan's ladder — five rungs, most important first. */
  bands: readonly PriorityBandView[];
  /** The priority stored on this row, or null. */
  priority: number | null;
  /** Sends what the box holds — a number, a band's name, or empty to clear. */
  commit: SendEdit;
  /** Sends one band's own default value, which is what taking a line does. */
  choose: (value: number) => void;
  /** Enter: save without waiting to be left. The table's `flushCell`. */
  onEnter: (box: CellElement) => void;
  /** The four motion chords and the four row chords, as the table hands them down. */
  onGridKey: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The Prio cell: a number you type, a band you pick, and a colour that says
 * which.
 *
 * Three of Dany's four sentences about priorities land in this one component —
 * pick by label, type a number, and _"ui must display differently for different
 * priorities"_ — and the fourth (the ladder itself) is the dialog this reads.
 *
 * **A box with a list under it, not a `<select>`.** The column is 48px
 * (`table-frame.ts`), a select brings a control the grid's arrow keys cannot walk
 * through, and the box has to keep taking digits. So it is the shape
 * `CreatablePicker` already established in this table one column along: a
 * `position: relative` wrapper, a real input, and `PickerList` hanging under it —
 * the same list component, so the `mousedown` that must not blur the box, the
 * `z-index` over every sticky layer and the `top: 100%` are one implementation
 * and not three. The `<td>`'s clip is lifted for this column by `opensAPopover`,
 * without which the list is cut off at 48px.
 *
 * **The list opens on a click and not on the focus**, which is the one place this
 * departs from `CreatablePicker`, and it is a departure with two reasons.
 *
 * The first is the reader's: that picker opens on focus because choosing from a
 * list is the whole of what its cell is for, and this cell's common case is
 * typing a digit. The grid is walked with the arrow keys, so a list that appeared
 * every time the caret landed here would be furniture over the rows below on
 * every pass across a row — the objection Dany's compaction made about this
 * column's placeholder, one control along.
 *
 * The second is mechanical and is why this is written down rather than left as
 * taste: opening on focus is a `setState` **during** the focus that lands in this
 * box, so `CellInput`'s inline `ref` callback runs again, `LiveField.takeNode`
 * re-attaches, and a refusal held for this cell is written back over the draft
 * somebody is part-way through typing. Three of this column's existing tests
 * caught it — `sends what was typed on Enter` came back with no request at all
 * and `sends one request for a priority entered with Enter and then left` came
 * back holding the `1e999` a previous case had had refused. Watched 2026-08-14.
 *
 * The keyboard's way to the same five lines is to **type the name**: `high` in
 * this box is 30, which is `priorityTyped` above and needs no list at all. So
 * neither pointer nor keyboard is left without Dany's "select by labels", and
 * neither is made to walk past a popover to type a number.
 *
 * **The list is not filtered.** `CreatablePicker` filters because a directory of
 * teams is unbounded; a ladder is five lines, and filtering them would need this
 * component to read the box's draft — which belongs to {@link CellInput}'s
 * `LiveField` and is deliberately not reachable from outside it.
 *
 * **Nothing about the commit path changes.** The box is the same `CellInput` the
 * column has had since `priority-column`, with the same Enter/flush bargain, the
 * same chords and the same one-request-per-Enter guarantee. A picked line goes
 * out through {@link PriorityCellProps.choose}, which is the same `setPriority`
 * a typed number reaches — so both languages produce one journal entry and one
 * undo.
 */
export function PriorityCell({
  cellKey,
  rowNumber,
  rowId,
  bands,
  priority,
  commit,
  choose,
  onEnter,
  onGridKey,
}: PriorityCellProps) {
  const [open, setOpen] = useState(false);
  const paint = priorityBandStyleOf(bands, priority);
  const listId = `priority-bands-${rowId}`;

  return (
    // The positioned ancestor the list is placed against, and a `display: block`
    // one so the box below still fills the 48px column. `minWidth: 0` for
    // `CreatablePicker`'s reason: an input's default content width is about
    // twenty characters, and a wrapper that refused to shrink below it would push
    // the column out.
    <span
      style={{ position: 'relative', display: 'block', minWidth: 0 }}
      // React's `onBlur` is `focusout`, which bubbles — so the wrapper hears the
      // box's. It has to be here rather than on the box: `CellInput` owns
      // `onBlur` (it is where `LiveField.leave` is called) and does not pass one
      // through, which is the right ownership and not something to route around.
      onBlur={() => {
        setOpen(false);
      }}
    >
      <CellInput
        aria-label={`Priority for ${rowNumber}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        cellKey={cellKey}
        data-priority={rowId}
        // What opens the five lines. A click and not the focus — the reasons are
        // on the component above, and the second of them is a defect this
        // column's own tests found.
        onClick={() => {
          setOpen(true);
        }}
        // Numeric, so a phone offers digits — and `inputMode` rather than
        // `type="number"`: a number input brings spinners this column has no room
        // for, and swallows the arrow keys the grid navigates with. It stays
        // `numeric` now that a band's name can be typed here too, because the
        // number is what nearly every keystroke in this box is and a phone
        // keyboard has a letters key.
        inputMode="numeric"
        // Which attribute is decided per render, because the two branches are
        // about different things: with no band the words are what this column is
        // *for* and wait like any other tool hint, and with one they are this
        // row's own rank and open at once — `FACT_ATTRIBUTE` in `hint.tsx` names
        // the split, and `CardPriorityField` carries the same pair on the card.
        {...(paint === null
          ? {
              'data-hint':
                'How important this work is: 1 upward, smaller first. Type a number or a band’s name. Blank means nobody has said.',
            }
          : {
              'data-fact': `${paint.words}. Smaller is more important; it decides who gets a shared person first.`,
            })}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          font: 'inherit',
          background: 'transparent',
          border: 'none',
          textAlign: 'right',
          // The room the glyph stands in, on the leading edge and out of the
          // flow — see {@link PriorityChevron}. Reserved whether or not a glyph
          // is drawn, so the digits of a prioritised row and an unprioritised one
          // line up down the column; the alternative is every clear and every
          // first priority shifting the whole column by 10px.
          paddingLeft: PRIORITY_GLYPH_ROOM_PX,
          // **The band, in one channel the table has spare.** The cell's ink
          // rather than a background: the Prio column is 48px of right-aligned
          // digits between two bordered cells, and a filled swatch there reads as
          // a selection. Undefined — not a token — where nothing is prioritised,
          // so the cell inherits the table's own ink and an unprioritised plan is
          // a plain column exactly as it was. One resolution, in
          // `priority-band-style.ts`, shared with the chart, the cards and the
          // export.
          color: paint?.ink,
          fontWeight: paint === null ? undefined : 600,
        }}
        onKeyDown={(e) => {
          // Escape closes the list and leaves the box alone, which is
          // `CreatablePicker`'s rule. Before everything, so it is not read as a
          // chord.
          if (e.key === 'Escape') {
            setOpen(false);
            return;
          }
          // Enter saves the number, and this column's own reasons are unchanged
          // from `priority-column`: the Name cell holds real newlines so the rule
          // cannot live in `CellInput`, the modifiers are left to the chord
          // underneath, and it is a flush rather than a direct commit so one
          // Enter is one request and one undo.
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            setOpen(false);
            onEnter(e.currentTarget);
            return;
          }
          onGridKey(e);
        }}
        // Blank at rest for a work item nobody has given a priority — no
        // placeholder, and no em-dash. A priority is a scale, and a column of
        // grey hints down every row of a plan nobody has prioritised is a wall of
        // furniture saying nothing. Dany's compaction, 2026-08-08.
        value={priority === null ? '' : String(priority)}
        commit={commit}
      />
      {/*
        The rung, drawn. After the box in source order and before it in the
        stacking context that matters — it is `position: absolute` with no
        `z-index`, so it paints over the input's transparent background and
        under nothing. `paint === null` is the column's own "blank at rest"
        bargain: a plan nobody has prioritised is a plain column, and a glyph
        on every row of it would be the wall of furniture Dany's compaction
        took out.
      */}
      {paint !== null && <PriorityChevron rank={paint.rank} ink={paint.ink} />}
      {open && (
        <PickerList
          id={listId}
          label={`Priority bands for ${rowNumber}`}
          options={bands.map((band, rank) => ({
            key: `${listId}-${String(rank)}`,
            label: bandLine(bands, band, rank),
            selected: paint !== null && paint.rank === rank,
            take: () => {
              setOpen(false);
              choose(band.defaultValue);
            },
          }))}
        />
      )}
    </span>
  );
}

/**
 * One line of the list: the band's name in its own colour, and the number taking
 * it writes.
 *
 * The number is on the line because taking a line **stores** it, and a picker
 * that hid what it was about to write would leave the reader unable to predict
 * the digits that appear in the box. `pickableLabel`'s shape — name, then detail
 * in grey — reused in spirit rather than by call, because that helper takes a
 * `PickableEntry` with an `id` and a band has none.
 */
function bandLine(
  bands: readonly PriorityBandView[],
  band: PriorityBandView,
  rank: number,
): ReactNode {
  const paint = priorityBandStyleOf(bands, band.defaultValue);
  return (
    <>
      <span style={{ color: paint?.ink, fontWeight: 600 }} data-band-rank={rank}>
        {band.label}
      </span>
      <span style={{ color: 'var(--muted-foreground)' }}> — {band.defaultValue}</span>
    </>
  );
}
