<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-10, twice in one afternoon: **"can you please include ALL columns and their
tooltip pop-ups in this left/right schema?"**, and about the notes: **"(1) to be way wider to
the right (2) to also not cover the cells from same row - because i wanna see them for this
item to have full context"**.

Two columns' pop-ups were still standing over the rows they explain. The **hint layer** is one
of them and it is most of the table: `data-hint` and `data-fact` marks are the pop-up for the
drag grip, the row number, Deadline, Finish, Float, In parallel, Not before, Service and the
estimate cells, and every one of those opened _under_ its mark. The **notes preview** is the
other, and it is a different question: a document about a work item is read against that item's
own dates and estimates, so what it must not cover is its **own row**.

## What Changes

- `asidePlacement` places an anchored card beside its mark — right, flipped left where the
  viewport has no room, clamped rather than refused where neither side fits. A hint is a
  sentence about the thing under the pointer, and a reader shown nothing cannot ask again.
- The hint layer takes it **for marks inside the plan's frame only**. A toolbar control's card
  still opens under it: it covers nothing but the header, and a row of small buttons whose
  cards jumped sideways would be worse for it.
- The notes preview opens **below its own row and past its own cell**, as wide as the room to
  the right allows — 882px measured against 260px before, capped by the frame. Its old 24px
  lane pull goes: starting past the cell leaves the `≡` lane of every row below it clear by
  construction.
- `AnchorRect` gains `right`, which is what a card opening beside a mark is placed from.

## Non-goals

- The Gantt's own anchored cards keep opening under their bar. A bar is as wide as the work it
  draws, and a card beside one that fills the chart has nowhere to stand.
- No change to when any card opens or closes, or to what it says.

## Constraints

- `asidePlacement` is pure and unit-tested; that a real mark is measured by it is a browser
  fact.
- The preview's width needs `width: max-content`: shrink-to-fit measures the room between
  `left: 100%` and the **cell's** right edge, which is 4px.
