import { DateField } from '../date-field';
import { cellKey } from '../editable-grid';
import type { PlanLive } from '../plan-live';
import { shortIsoDate } from '../short-date';
import { DATE_EDITOR_WIDTH } from '../table-frame';
import { column } from './column';

/** Builds the not-before column family against the stable live cell contract. */
export function createNotBeforeColumn({ live }: { live: PlanLive }) {
  return column.display({
    id: 'not-before',
    // Abbreviated, because the column is 84px at its widest and 56 at its
    // narrowest. The sentence it used to be is on the `<th>`
    // (`column-hints.ts`) — the same bargain Days, Start, End and Slack
    // already make.
    header: () => <span>Not bef.</span>,
    cell: ({ row }) => {
      const day = row.original.startNoEarlierThan;
      // The words about that day, or null where nobody has said. Straight
      // off the tree read like the date above it — a draft somebody is
      // half-way through typing is not yet a fact about the plan.
      const reason = row.original.startNoEarlierThanReason;
      // Without a project start date there is no day zero to count from and
      // be-01 ignores the constraint entirely. A rendered disabled state
      // rather than an editor that opens onto nothing: a date that saves
      // and does nothing is worse than a field that will not take one.
      const noCalendar = live.current.startDate === null;
      const editing = live.current.editingNotBefore === row.original.id;
      const open = (): void => {
        if (noCalendar) return;
        live.current.openNotBefore(row.original.id);
      };
      const close = (): void => {
        live.current.closeNotBefore(row.original.id);
      };
      /**
       * Sends the words in the box, and only when they differ from the ones
       * this box last agreed about.
       *
       * `DateField`'s rule, in the one place it cannot be borrowed from: a
       * focus and a blur with nothing typed is not an edit, and sending
       * anyway writes what was on screen when the focus arrived over
       * whatever a peer has done since. What "agreed" means is kept on the
       * node rather than in a ref because this box is rendered by a cell
       * function, not by a component with a lifetime — an Enter that sends
       * and then blurs would otherwise send the same sentence twice.
       */
      const commitReason = (box: HTMLInputElement): void => {
        const agreed = box.dataset['agreed'] ?? reason ?? '';
        if (box.value === agreed) return;
        box.dataset['agreed'] = box.value;
        live.current.setNotBeforeReason(row.original.id, box.value);
      };
      return (
        /*
              The wrapper the editor escapes through. It is `position: relative`
              and **inside** the `<td>`, which is why `opensAPopover` has to
              lift this column's clip for the editor to be visible at all — see
              the note there. At rest it holds a short date and escapes nothing.

              **It is also what decides the editor is one editor.** Since the
              reason box joined the date box, leaving one of them for the other
              is not leaving the editor, and `DateField`'s `onExit` cannot tell
              the difference — it reports the blur, not where the focus went.
              `focusout` bubbles and carries `relatedTarget`, so the question is
              asked once, here, of the panel as a whole: focus still inside is
              not an exit. Proof: this guard inverted to a bare `close()`, `lets
              somebody type the reason the date is there` fails on `expected
              null to not be null` — the panel shuts on the way to the box.
              Watched, 2026-08-18.
            */
        <span
          style={{ position: 'relative', display: 'block' }}
          onBlur={(event) => {
            if (!editing) return;
            const going = event.relatedTarget;
            if (going instanceof Node && event.currentTarget.contains(going)) return;
            close();
          }}
        >
          {editing ? (
            <>
              <DateField
                aria-label={`Earliest start for ${row.original.number}`}
                data-not-before={row.original.id}
                data-cell={cellKey(row.original.id, 'not-before')}
                data-hint="This work item may not start before this day. Its dependencies can still push it later."
                onKeyDown={(e) => {
                  // Enter closes the editor, and it is this cell's job now
                  // rather than `onExit`'s: `onExit` reports a blur as well
                  // as an Enter, and a blur may be somebody reaching for the
                  // reason box under this one. By the time this runs
                  // `DateField` has already sent the day — its own handler
                  // is first, deliberately, so a `Ctrl/⌘ + Enter` that moves
                  // to the next row has saved this one on the way out.
                  if (e.key === 'Enter') close();
                  // The chords and the row moves, and nothing else this cell
                  // does not already own: a native date input keeps its own
                  // arrows for the segment under the caret, which is why
                  // {@link onArrowKey} is absent here. Alt+arrow is not one
                  // of those — {@link altMoveIn} takes it before the segment
                  // stepper sees it, exactly as it does in every other cell.
                  live.current.onAltMove(e, row.original, 'not-before');
                  live.current.onCommandKey(e, row.original, 'not-before');
                  live.current.onTabKey(e, row.original.id, 'not-before');
                }}
                onExit={(how) => {
                  // Escape only. It is the one exit that has already put the
                  // box back to the day the server agreed, so there is
                  // nothing left to send and nowhere else the focus is
                  // going. Every other way out of this panel is the
                  // wrapper's `focusout`, which is the one place that can
                  // see the two boxes as one editor.
                  if (how === 'cancel') close();
                }}
                // Wider than its column, on purpose: {@link DATE_EDITOR_WIDTH}
                // is what this browser lays an unconstrained date input out
                // at, and a column that grew to fit one would move every cell
                // under the person typing. It leaves the cell instead, over
                // the columns beside it, which is what the `z-index` is for.
                style={{
                  position: 'relative',
                  zIndex: 10,
                  width: DATE_EDITOR_WIDTH,
                  boxSizing: 'border-box',
                  font: 'inherit',
                }}
                value={day ?? ''}
                commit={(typed) => {
                  // A date input reports '' when cleared, which is the caller
                  // saying "no constraint" rather than "an empty date".
                  live.current.setNotBefore(row.original.id, typed === '' ? null : typed);
                }}
              />
              {/*
                    Why the date is there, under the date itself.

                    **Absolutely positioned, so the row does not grow.** A second
                    box in the flow would make every cell of this row two lines
                    tall for as long as somebody is typing, and the table's whole
                    geometry is one line per row. It hangs off the wrapper the
                    date editor already escapes through, at the same width, and
                    reaches the reader only because `opensAPopover` lifts this
                    column's clip.

                    No `data-cell`: the grid has one cell here and it is the
                    date. A second box wearing the same key is how the keyboard
                    and the held refusal come to disagree about which box they
                    are talking about — `CellInput`'s note says it, one column
                    over.
                  */}
              <input
                aria-label={`Why ${row.original.number} may not start earlier`}
                data-not-before-reason={row.original.id}
                placeholder="Why? (optional)"
                data-hint="Words about the date beside this, in your own words — a date with no words is still a date. Clearing the date clears these too."
                // No `maxLength`, deliberately. be-01 bounds this at 200
                // (`LONGEST_NOT_BEFORE_REASON`) and refuses a longer one,
                // and a box that quietly stopped taking characters would be
                // this client keeping a rule the server also keeps — two
                // copies of one number, which is how the two come to
                // disagree. {@link setPriority} writes the doctrine down.
                defaultValue={reason ?? ''}
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  zIndex: 10,
                  width: DATE_EDITOR_WIDTH,
                  boxSizing: 'border-box',
                  font: 'inherit',
                  background: 'var(--popover)',
                  color: 'var(--popover-foreground)',
                  border: '1px solid var(--border)',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // Back to what the server agreed, which is what makes
                    // the blur after an Escape harmless — the same rule
                    // {@link DateField} keeps, for the same reason: a box
                    // holding the agreed value has nothing left to commit.
                    e.currentTarget.value = reason ?? '';
                    close();
                    return;
                  }
                  if (e.key === 'Enter') {
                    commitReason(e.currentTarget);
                    close();
                  }
                }}
                onBlur={(e) => {
                  commitReason(e.currentTarget);
                }}
              />
            </>
          ) : (
            /*
                  The day at rest, and still a cell of the keyboard grid: Tab
                  lands here, the arrows land here, and `editableGrid` finds it
                  because it is an `<input>` carrying `data-cell` — which is
                  also why it is not `readOnly`, an attribute that selector
                  deliberately excludes. Nothing is ever typed into it: a
                  keystroke opens the editor instead, which is what `onChange`
                  is doing here.
                */
            <input
              aria-label={`Earliest start for ${row.original.number}`}
              disabled={noCalendar}
              data-not-before={row.original.id}
              data-cell={cellKey(row.original.id, 'not-before')}
              // The reason is **appended** where there is one, never
              // substituted — the same bargain `floorWordsOf` strikes on
              // the bar. What the constraint does is the part a reader
              // cannot work out for themselves; what it is *for* is the
              // part only a planner can say. A cell 84px wide has one
              // `title` and both belong in it.
              data-fact={
                noCalendar
                  ? 'Set the project start date first — without one there are no dates to constrain.'
                  : [
                      day === null ? null : `${day}.`,
                      'This work item may not start before this day. Its dependencies can still push it later.',
                      reason === null || reason.trim() === '' ? null : `Why: ${reason.trim()}`,
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
              // An em-dash for a row that sets no day, which reads as "none"
              // rather than as a cell that failed to load.
              value={day === null ? '—' : shortIsoDate(day, new Date())}
              onChange={open}
              // `click`, not `mousedown`, and a browser is the only thing
              // that can say why. React flushes a discrete update inside
              // the `mousedown` dispatch, so the editor mounted and the at
              // rest input was gone before Chromium performed that event's
              // **default action** — focusing the node it had hit-tested.
              // Focusing a detached node moves the focus to `<body>`, which
              // blurred the editor, which is an exit, which closed it: a
              // click on the cell did nothing at all. jsdom performs no
              // default action and could not see it; found in Chromium by
              // counting `input[type=date]` after a click and getting none.
              // R5 #14/#15, the same fault class. `click` fires after the
              // focus has already moved, so there is nothing left to undo
              // the mount.
              onClick={open}
              onKeyDown={(e) => {
                // A bare Enter opens the editor; a chord is the table's and
                // is left to it, which is why the modifiers are asked about
                // before anything else happens.
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                  e.preventDefault();
                  open();
                  return;
                }
                live.current.onAltMove(e, row.original, 'not-before');
                live.current.onCommandKey(e, row.original, 'not-before');
                live.current.onTabKey(e, row.original.id, 'not-before');
              }}
            />
          )}
        </span>
      );
    },
  });
}
