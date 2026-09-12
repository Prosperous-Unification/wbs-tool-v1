import { type RefObject, useEffect, useState } from 'react';

import { HoverPreview } from './hover-preview';
import { splitNameCell } from './name-notes';

/**
 * The rendered notes shown beside the Name box while somebody is writing in it —
 * the **same card** the marker shows on hover ({@link HoverPreview}), driven by
 * the box's live text instead of the row's last save.
 *
 * Dany, 2026-09-10: *"when you click on title cell and note field expands - the
 * right half of the row is a md preview which is same as in the on-hover md
 * preview"*; and 2026-09-12: *"the preview during editing and the pop-up that
 * will be shown on hover must be identical (in size, content)"*. It was a
 * hand-rolled panel until then, with its own width (`min(1000px, 55vw)`) and no
 * clamp, so on a wide or far-right Name cell it ran off the screen and took its
 * Done button with it. Rendering {@link HoverPreview} instead hands the
 * placement to {@link HoverCard}, which measures the room beside the cell and
 * clamps to it — the two cards are now one component and cannot drift in size,
 * content, or where they stop.
 *
 * The words come from the box rather than from the row for the reason
 * {@link CellInput} is uncontrolled: `row.original` holds the last save, and a
 * preview a keystroke behind is a preview of the wrong document.
 *
 * Only one of this and the hover preview is ever mounted: the marker's hover is
 * suppressed while this cell's box is focused (`plan-columns/name.tsx`), so the
 * `≡` cannot open a second, identical pop-up over this one. This panel keeps
 * {@link WrittenNotesPanelProps.editingRef} in step with the box's focus so the
 * marker knows when to stay quiet, off the same events it shows from — a ref,
 * so nothing above re-renders, and event-driven rather than
 * `document.activeElement`, which jsdom does not move on a dispatched blur.
 */
export interface WrittenNotesPanelProps {
  number: string;
  /** The Name box this panel renders, held by the cell that owns both. */
  box: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  /** Set true while the box is being written in, for the marker's guard. */
  editingRef: RefObject<boolean>;
}

export function WrittenNotesPanel({ number, box, editingRef }: WrittenNotesPanelProps) {
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
      editingRef.current = true;
      setWritten(node.value);
    };
    const hide = (): void => {
      editingRef.current = false;
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
  }, [box, editingRef]);

  if (written === null) return null;
  const { name, notes } = splitNameCell(written);
  if (notes.trim() === '') return null;
  return (
    <HoverPreview
      name={name}
      notes={notes}
      number={number}
      // The one thing editing adds to the hover card: a press that ends the
      // edit. Blurring the box is the save (`plan-columns/name.tsx`), and it
      // takes this panel away with it.
      onDone={() => box.current?.blur()}
    />
  );
}
