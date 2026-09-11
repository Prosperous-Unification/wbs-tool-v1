import { type RefObject, useEffect, useState } from 'react';

import { RenderedNotes } from './hover-preview';
import { splitNameCell } from './name-notes';

/**
 * The rendered notes, beside the Name box while somebody is writing in it.
 *
 * Dany, 2026-09-10: *"when you click on title cell and note field expands - the
 * right half of the row is a md preview which is same as in the on-hover md
 * preview"*. A note is written in markdown and read as markdown, and the cell
 * that holds it shows the source — so the rendering has to be somewhere, and
 * beside the box is where the room is.
 *
 * **Not a card.** It has no `role="tooltip"`, takes no pointer and never moves:
 * a reader typing has their hands on the keyboard, and a box that fought the
 * caret for the mouse would be a second thing to dismiss. It stands where the
 * hover preview stands — past the cell, level with the box — and is as tall as
 * the box it explains.
 *
 * The words come from the box rather than from the row for the reason
 * {@link CellInput} is uncontrolled: `row.original` holds the last save, and a
 * preview a keystroke behind is a preview of the wrong document.
 */
export function WrittenNotesPanel({
  number,
  box,
}: {
  number: string;
  /** The Name box this panel renders, held by the cell that owns both. */
  box: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  /**
   * What the box holds while it is being written in, or null while it is not.
   *
   * **This component's own state, and that is the point.** The words change on
   * every keystroke, and holding them in the cell would re-render the cell —
   * and with it the uncontrolled box the reader is typing into — sixty times a
   * sentence. `plan-row-render-cost.test.tsx` is the file that says so out
   * loud, and `a chord waits for the blur's patch that is still out` is what
   * broke when the state was one level up: a re-render inside the blur put the
   * old text back in the box.
   *
   * The listeners are the box's own rather than React props for the same
   * reason: `focus`, `input` and `blur` on the node, so nothing above this
   * panel hears them.
   */
  const [written, setWritten] = useState<string | null>(null);
  useEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    const show = (): void => {
      setWritten(node.value);
    };
    const hide = (): void => {
      setWritten(null);
    };
    node.addEventListener('focus', show);
    node.addEventListener('input', show);
    node.addEventListener('blur', hide);
    return () => {
      node.removeEventListener('focus', show);
      node.removeEventListener('input', show);
      node.removeEventListener('blur', hide);
    };
  }, [box]);

  if (written === null) return null;
  const { name, notes } = splitNameCell(written);
  if (notes.trim() === '') return null;
  return (
    <div
      aria-label={`Notes for ${number}, rendered while writing`}
      data-written-notes={number}
      style={{
        position: 'absolute',
        // Past the cell and level with the box: the same diagonal every card in
        // this table takes, minus the row offset — this one explains the box
        // that is open, so it stands beside it rather than under the row.
        left: '100%',
        top: 0,
        // **The right half of the row**, which is what was asked for — a fixed
        // share of the window rather than the words' own width, so the panel is
        // the same shape from one row to the next and a two-line note does not
        // give the reader a 170px box. Shrink-to-fit would do exactly that: it
        // measures the 4px between `left: 100%` and the cell's own right edge.
        width: 'min(1000px, 55vw)',
        maxHeight: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        zIndex: 20,
        background: 'var(--popover)',
        color: 'var(--popover-foreground)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '6px 10px',
        marginLeft: 6,
        textAlign: 'left',
        overflowWrap: 'break-word',
        fontWeight: 400,
        // The caret's, not this panel's: a reader dragging a selection in the
        // box must not have it end here, and a click through to the row behind
        // is what every card in this table already allows.
        pointerEvents: 'none',
      }}
    >
      <RenderedNotes name={name} notes={notes} />
    </div>
  );
}
