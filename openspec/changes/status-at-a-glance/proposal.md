<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

`work-item-status-and-facts` gave status a face, but the face is a word in a column hidden by
default: a plan with finished rows looks like one with none. Marking done fills the fact end
silently with today — wrong for a row finished last Thursday. A row taken back from done keeps
the fact end of a finish that did not happen. Dany, 2026-09-13: "a colored strip at the left
edge of the row … a modal that will allow to set the completion date … when moving from done
to other status the fact_end date must reset".

## What Changes

**Status is seen without its column.** Every row carries a **status strip** at its left edge,
before the drag handle: nothing for unknown, one colour for in progress, another for done. A
done row is tinted faintly green across every cell, under the bands and the row lights, and
stays struck through.

**The Status column is a glyph.** It moves after `#` and before Links, pinned with them, one
glyph wide: `○` unknown, `◐` in progress, `✓` done, in the strip's colours. The picker still
offers Unknown and Done in words.

**Done asks for the day.** Choosing Done on a row not yet done opens the **completion
prompt**: a date field holding today, or the fact end the row already holds, and two buttons.
Confirming sends `setStatus` with that day as `on`; cancelling writes nothing. A changed
already-held day follows as a `patch`.

**Leaving done clears the fact end.** `setStatus … unknown` also sets `factEnd: null` on
every work item in scope whose status was done, in the same journal entry.

## Non-Goals

No time of day: ADR 0024 stands. Status stays hidden by default; the strip is the face. No
prompt for Unknown; a per-step statement still leaves the facts alone; the engine reads no
status.

## Constraints

Nothing in `styles.css` moves a pixel: the strip is a `box-shadow`, the tint a colour. The
pinned block stays contiguous, so Status joins `PINNED_COLUMN_IDS` at 28px; hidden, it leaves
the 1280 folded budget alone. `setStatus` keeps its shape.

## Capabilities

### Modified Capabilities

- `wbs-domain`: strip, tint, glyph column, completion prompt, fact end cleared on unknown.

## Domain Terms

Status strip, Completion prompt — new, in `CONTEXT.md`.

## Decisions Recorded

None new: ADR 0024's date-only rule is reused.

## Impact

`libs/core` (`setStatus`), `fe-01`, `e2e/status.spec.ts`, `e2e/layout.spec.ts`.
