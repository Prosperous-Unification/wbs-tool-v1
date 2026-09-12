<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-12, four things in one message:

1. **"i don't see the button, i think that the preview md overflowed the screen and it is there"**
2. **"it also overflows the screen which is an issue on it's own"**
3. **"when i edit and see the preview - the notes icon must not trigger another preview pop-up"**
4. **"the preview during editing and the pop-up that will be shown on hover must be identical (in
   size, content)"**

The editing preview was a hand-rolled panel: `position: absolute; left: 100%; width: min(1000px,
55vw)`, with no clamp. On a wide or far-right Name cell it ran off the right of the screen (2),
taking its Done button with it (1). The hover preview, by contrast, goes through `HoverCard`, which
measures the room beside the cell and clamps to it. So the two were different surfaces (4), and the
marker still opened its hover card on top of the editing one (3).

## What Changes

- **The editing preview is the hover preview.** `WrittenNotesPanel` renders `HoverPreview` — the
  same component the marker opens — driven by the box's live text. Placement, width clamp, scroll
  and content are `HoverCard`'s, so the two are identical by construction and the editing one can no
  longer leave the screen. The bespoke panel styling is deleted.
- **Done rides inside that card**, sticky to its top, drawn in a zero-height box so it adds nothing
  to the card's measured size (the hover twin has no Done) and stays reachable while a long note
  scrolls.
- **The marker is inert while the box is being written in.** Its `onMouseEnter` no-ops when this
  row's box is focused, tracked by a ref the panel keeps off the box's own focus/blur — so the `≡`
  opens no second, identical pop-up. Focus also drops any hover card that was already open, so the
  editing card is the only one.

## Non-goals

- No change to what the card renders, or to Escape/Done saving (they are unchanged).
- No change to the hover preview's own trigger or timing.

## Constraints

- The live text stays the panel's own state, off the box's events: holding it in the cell
  re-renders the uncontrolled box per keystroke (`plan-row-render-cost`), and a re-render inside the
  blur puts the last save back into it.
- The editing signal is a ref driven by the box's `focus`/`blur` events, not `document.activeElement`
  — jsdom leaves the active element stale after a dispatched blur.
