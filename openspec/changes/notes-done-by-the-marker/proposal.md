<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-12: _"can you move the done btn to be near the note icon? it makes more sense to me
since it is near the place that is being edited"_.

`notes-editor-done` put the Done button inside the preview card. `notes-preview-unify` then made the
editing preview the same card the marker opens, which hangs diagonally off the row — so Done rode
off to the side, away from the box being edited.

## What Changes

- **Done moves into the Name cell**, top-right, just left of the `≡` notes marker — by the box, not
  on the card. It is rendered by `WrittenNotesPanel` (which alone knows the box is being written in),
  as a sibling of the preview card and a child of the cell's positioned wrapper, so it costs no
  render of the cell and lands in the marker's own corner.
- **The preview card loses its Done button**, which leaves the editing card and the hover card
  byte-identical — the `notes-preview-unify` identity is now exact.

## Non-goals

- No change to what Done does (press saves and closes, as Escape does), or to the `≡` marker.
- No change to the preview's size, content or placement.

## Constraints

- Done stays out of the tab order (a Tab to it would take the panel away under the focus); Escape is
  the keyboard's way out.
- It is rendered from `WrittenNotesPanel`, not the cell, so the uncontrolled box is not re-rendered
  as it is typed in.
