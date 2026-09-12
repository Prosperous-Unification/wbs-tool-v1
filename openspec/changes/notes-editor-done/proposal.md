<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-12: _"when editing the md note of work item i want (1) so that ESC key hides the
notes editor (edits are saved) (2) to add a non-intrusive neat small 'Done' button that you can
press to hide the editor of markdown"_.

The Name box is one textarea for the name and the notes under it. Clicking into it opens the
editor — the box grows to its text and the rendered notes stand beside it — and the only way out
is to leave it: Tab, Enter, a click elsewhere. Leaving is the save. Escape did nothing there, and
there was nothing to press.

## What Changes

- **Escape leaves the box.** The blur is the one commit path this table has, so the edit is saved
  exactly as a Tab saves it, and the box collapses to its one-line rest because it is no longer
  focused. The keyboard goes nowhere, as after a click away. No abandon path is added; Cmd+Z stays
  the undo.
- **A Done button** in the top-right corner of the rendered-notes panel: small, muted, the one
  thing in that panel that takes the pointer. A press does what Escape does. It exists while the
  panel does — while the note has text — and is pointer-only: a Tab to it would blur the box and
  take the panel away, so `tabIndex={-1}`, and Escape is the keyboard's way.
- **The glossary's Edit exit** gains the Name box's case: Escape commits there, because a
  paragraph of markdown is not something to throw away on a stray key. The keyboard cheat sheet
  lists Escape for the Name cell.

## Non-goals

- No Cancel or Discard control, and no change to how any other field answers Escape.
- No change to where the panel stands or what it renders.

## Constraints

- The panel keeps `pointer-events: none`; only the button opts back in, and a browser proves the
  button is what the pointer lands on at its own centre.
- The panel's text stays the panel's state (`cards-open-diagonally` 3.2); the button reads the box
  through the ref the panel already holds and adds no state above it.
