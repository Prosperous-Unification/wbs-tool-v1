import { useRef } from 'react';

import { useCardOpenOn } from '../cell-card-store';
import { CellInput } from '../cell-input';
import { cellKey } from '../editable-grid';
import { HoverPreview } from '../hover-preview';
import { renderName } from '../inline-markdown';
import { composeNameCell } from '../name-notes';
import { MATCH_TINT } from '../plan-cell-props';
import { useFilterReading } from '../plan-cell-reading-context';
import type { PlanLive } from '../plan-live';
import { hierarchyIndentFor, numberIndentFor } from '../table-frame';
import { WrittenNotesPanel } from '../written-notes-panel';
import { column } from './column';

/** Builds the name column family against the stable live cell contract. */
export function createNameColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'name',
    meta: { isEditable: () => true },
    header: 'Name',
    cell: ({ row }) => {
      // A subscription and not a reading off `live`: this cell is a component,
      // so it can be told about its own card without the table rendering.
      // First, and unconditionally, because it is a hook.
      // `flexRender` builds this with `React.createElement`, so it **is** a
      // component and the hook below is legal; the rule reads the property
      // name `cell` and cannot see the call site.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const cardOpen = useCardOpenOn(live.current.cellCards, cellKey(row.original.id, 'name'));
      // Why this row is on screen, at a glance: a hit is tinted, and every
      // other row in a narrowed table is context — an ancestor placing a
      // hit, or work underneath one. Read through `live` rather than closed
      // over, for the reason the dependency list below gives: `columns`
      // must not depend on anything that changes per keystroke.
      // Proof: hard-coded to false, `marks the row that matched, so the
      // rows around it read as context` and `shows the whole subtree under
      // a matched parent` failed — the second because it is the mark that
      // says the parent is the hit and the subtree is not. Watched,
      // 2026-08-06.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const { matched } = useFilterReading();
      const nameCell = cellKey(row.original.id, 'name');
      // eslint-disable-next-line react-hooks/rules-of-hooks -- as above.
      const nameBox = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
      const hovered = cardOpen;
      return (
        <span
          // `block`, not `inline-block`: a shrink-to-fit wrapper and a
          // `width: 100%` textarea inside it define each other in a circle.
          // It is also the positioned ancestor the preview below is placed
          // against — which decides where the preview opens, not whether it
          // is clipped. The clipper is the `<td>`, and it is what
          // {@link POPOVER_COLUMNS} exempts.
          //
          // And it is what **closes** the preview, while the marker alone
          // opens it. The two halves are deliberately different elements:
          // the preview is the one card that scrolls, so reaching it means
          // putting the pointer on it, and the trip from a 7px glyph at the
          // top right of this cell down to a card hanging off its bottom
          // edge crosses the name box in between. With the leave on the
          // marker that trip unmounted the card before the pointer arrived
          // and a note taller than 320px could never be scrolled (codex
          // round 3, finding 1). This span contains the marker *and* the
          // card, so `mouseleave` on it fires only once the pointer is
          // outside both — no timer, no grace period, and the preview's
          // placement is untouched.
          // Proof: the handler put back on the marker, `keeps the preview
          // open while the pointer crosses the cell to reach it` failed on
          // `expected null not to be null`, and the browser's `scrolls a
          // note taller than the preview once the pointer is on it` on the
          // card being gone. Watched, 2026-08-09.
          onMouseLeave={() => {
            // **Held for a moment rather than closed** — see
            // {@link REACH_FOR_THE_CARD_MS}. The card hangs diagonally off this
            // cell, so the hand going to it leaves this subtree on the way and
            // an immediate clear loses the card under the reaching hand.
            live.current.cellCards.holdHovered(nameCell);
          }}
          style={{
            position: 'relative',
            display: 'block',
            maxWidth: '100%',
            // The share of the indent the Number cell's cap withheld: zero
            // until `DEEPEST_INDENT`, one step per level past it, so the
            // outline the reader's eye adds up across the two cells —
            // `hierarchyIndentFor` — keeps stepping right at every depth.
            // On this cell and not the Number cell because Name is the
            // flexible column: it has no declared width to outgrow and no
            // pinned neighbour to be painted over.
            // Proof: this line put back to `paddingLeft: 0` (the shipped
            // state the cap flattened) — `hands the Name cell the share of
            // the indent the Number cap withheld` failed on `expected
            // { number: '48px', name: '0px' } to deeply equal { number:
            // '48px', name: '12px' }`. Watched, 2026-08-10.
            paddingLeft: hierarchyIndentFor(row.depth) - numberIndentFor(row.depth),
          }}
        >
          <CellInput
            aria-label={`Name of ${row.original.number}`}
            data-name-input={row.original.id}
            data-match={matched ? 'true' : undefined}
            cellKey={cellKey(row.original.id, 'name')}
            // A work item's name is a sentence, not a word, and an input
            // scrolls it out of sight one character at a time. A textarea
            // wraps, and `autoSize` is what stops it wrapping into a line
            // nobody can see: the box is as tall as its name, focused or
            // not. It holds the notes under the name as well, and at rest
            // they take no height at all — `restShowsFirstLineOnly` — so a
            // plan reads as its names. The notes are read by writing in
            // the cell or in the hover preview below; `maxRestRows` does
            // not bind this cell, because a name is shown whole however
            // many lines it wraps onto.
            // Enter is still "new work item" — the table preventDefaults it.
            multiline
            autoSize
            restShowsFirstLineOnly
            // The name's own markdown, read at rest. One component for
            // all four faces — see {@link InlineMarkdown} — and the box
            // under it still holds the raw source, which is what a reader
            // gets back the moment they write in the cell.
            renderFirstLine={renderName}
            rows={1}
            style={{
              // The cell's width, not a width of its own: `22em` was one of
              // the three opinions that produced the overlap, and it is the
              // colgroup's job now.
              width: '100%',
              boxSizing: 'border-box',
              // No `resize` here. It said `vertical` until
              // `table-mechanics`, and an inline property outranks every
              // stylesheet: the grip that put a row out of line with its
              // chart row was written from *this* object, not from
              // Tailwind's preflight, and a rule in `styles.css` could not
              // reach it. `[data-grid] textarea { resize: none }` is where
              // the answer lives now, for this box and any other the grid
              // grows — and it is load-bearing rather than a belt: with
              // this line gone the browser's own default is `both`.
              font: 'inherit',
              ...(matched ? { background: MATCH_TINT } : {}),
            }}
            // A callback ref rather than an effect: it fires exactly when
            // this node is attached, so the focus cannot be lost to a later
            // render arriving before the row does. That race is what
            // Enter-Enter-Enter depends on not losing. It fires on every
            // render rather than only the first, which the id check already
            // tolerated.
            onAttach={(element) => {
              // Held for {@link WrittenNotesPanel}, which listens to this box
              // rather than being told about it — see its own note on why the
              // words do not live up here.
              nameBox.current = element;
              // The Name column only: any other column is a cell this one
              // has no business focusing, and it is landed on from the
              // committed DOM by the effect after a refresh.
              live.current.focusIntent.current.landOnAttached(
                element,
                { rowId: row.original.id, columnId: 'name' },
                live.current.gridElement.current,
              );
            }}
            // Both fields, as one text: the name, and the notes under it.
            // The reverse trip and the rule that a peer's edit is diffed
            // against the baseline rather than against this value are in
            // {@link commitNameCell}.
            value={composeNameCell(row.original.name, row.original.notes)}
            // Returned rather than dropped: what be-01 did with the edit is
            // what tells the box whether the text in it has been saved.
            commit={(typed, baseline) =>
              live.current.commitNameCell(row.original.id, typed, baseline)
            }
            onKeyDown={(e) => {
              live.current.onAltMove(e, row.original, 'name');
              // Before the Name cell's own keys, and before the arrows:
              // Ctrl+Enter is a command here and a plain Enter is a
              // newline the browser writes, and only one handler may
              // answer for the pair.
              live.current.onCommandKey(e, row.original, 'name');
              live.current.onKeyDown(e, row.original);
              live.current.onArrowKey(e, row.original.id, 'name');
            }}
          />
          {row.original.notes.trim() !== '' && (
            // The notes marker: the mark that says this row has notes, and
            // the only thing that opens the preview.
            //
            // The cell itself opened it until 2026-08-09, and Dany's
            // reading of the result is why it does not any more: the Name
            // column is the widest thing on the way to anywhere in this
            // table, and a rendered document over the rows below on every
            // pass of the mouse is disruptive rather than helpful. The
            // compact cards keep the whole cell — see the folded step
            // cell — because a card three lines tall over a 96px cell
            // costs a passing mouse nothing.
            //
            // It is also the "this row has notes" affordance
            // `name-title-body` deliberately left out. That non-goal is
            // superseded and not forgotten: with the notes clipped at rest
            // *and* the trigger no longer the whole cell, an unmarked row
            // would keep its notes from anybody who did not already know
            // they were there.
            //
            // Not a control: no `tabIndex`, no `data-cell`, no click. The
            // keyboard grid is a matrix of cells and a stop inside the Name
            // cell would put a Tab between a name and the next column. Its
            // hover area is its own 12px box and nothing wider, so a click
            // aimed at the box under it lands there everywhere else.
            //
            // It opens the preview and does not close it: the leave belongs
            // to the cell around it, for the reason that span gives.
            //
            // The a11y rule below is right that a non-interactive element
            // should not act; this one does not — its `onMouseDown`
            // forwards the press to the interactive box it sits on, which
            // is the opposite of trapping it.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <span
              role="img"
              aria-label={`Notes on ${row.original.number}`}
              data-notes-marker={row.original.id}
              onMouseEnter={() => {
                live.current.cellCards.arriveOn(nameCell);
              }}
              // **And the marker's leave is what dismisses it**, held for the
              // length of a reach in case the hand is going to the card. Dany,
              // 2026-09-10: _"i need it to go away when i move my mouse away
              // from the preview icon and not directly into the preview"_ — the
              // cell's own leave is too late for that, the cell being the width
              // of the plan's widest column.
              onMouseLeave={() => {
                live.current.cellCards.holdHovered(nameCell);
              }}
              // At 15px the glyph reads as clickable, and a click that
              // did nothing would eat the caret aimed at the name under
              // it. The name box takes it; the marker stays no control —
              // no focus of its own, no tab stop.
              onMouseDown={(pressed) => {
                pressed.preventDefault();
                pressed.currentTarget.parentElement?.querySelector('textarea')?.focus();
              }}
              style={{
                position: 'absolute',
                top: 0,
                right: 1,
                // Ink, not furniture: at 11px muted this was invisible at
                // arm's length, and an affordance nobody sees marks
                // nothing (Dany, 2026-08-09). The padding is hit area —
                // the glyph is the hover target.
                fontSize: 15,
                fontWeight: 700,
                padding: '1px 3px',
                lineHeight: 1,
                color: 'var(--foreground)',
                cursor: 'default',
              }}
            >
              ≡
            </span>
          )}
          {/*
                The rendered reading of this work item, on hover over the marker
                above. A work item with no notes has nothing to reveal — its
                name is shown whole in the cell already, and it has no marker to
                hover. It hangs off the Name cell because that is where the note
                is written; the Notes column it used to hang off does not exist.
              */}
          {hovered && row.original.notes.trim() !== '' && (
            <HoverPreview
              name={row.original.name}
              notes={row.original.notes}
              number={row.original.number}
              // Arriving on the card is the one thing that keeps it — the hand
              // got there. Leaving it is the cell's own `mouseleave`, which
              // holds and then closes.
              onPointerArrives={() => {
                live.current.cellCards.arriveOnCard();
              }}
            />
          )}
          {
            // **The same rendering, beside the box that is being written in.**
            // Dany, 2026-09-10: _"when you click on title cell and note field
            // expands - the right half of the row is a md preview which is same
            // as in the on-hover md preview"_. One component
            // ({@link RenderedNotes}) rather than a second copy: two would
            // drift the first time a mapping is added to either.
            //
            // Live from the box's own text and not from the row — the box is
            // uncontrolled, so `row.original` is the last **save** and the
            // panel is meant to answer the keystroke.
            <WrittenNotesPanel number={row.original.number} box={nameBox} />
          }
        </span>
      );
    },
  });
}
