## Why

R10 **F4** (`notes/wbs-brief-2026-08-17-r10-filtering.md` §7), built to the
eight answers Dany settled 2026-08-17 (§9, `notes/decisions.md`). F1 (#77)
shipped the seven-facet filter; F3+F5 (#78) made the chart honest about what
it dropped and gave a reader a way to export what is on screen. What is still
missing is the ability to come back to a filter at all: **the ad-hoc filter is
deliberately not remembered across a reload** (Q6) — the plan you open is the
whole plan — so today the only way back to a narrowing is to type and tick it
again from nothing.

Saved views are the deliberate opposite of Q6, not a reversal of it: a view is
named on purpose and picked on purpose, so it cannot be the "my rows are gone"
report an ad-hoc filter surviving a reload would be.

## What Changes

**A named filter, per browser.** `wbs.views.<projectId>` in `localStorage`,
the same per-project-per-browser shape `wbs.columnWidths.<projectId>` and
`wbs.ganttHeight.<projectId>` already use — no be-01 change, no route, no
wire field. A saved view stores exactly one `FilterCriteria` (the Find box's
text plus the six facets) and a name; it does **not** store the expansion or
the column widths, which is out of scope until a saved view has actually been
used (brief §10).

**`Views`, beside `Filters` in the toolbar.** A `<details>` control matching
`FilterFacets`'s own shape: a name box and a `Save` button, offered only while
something is actually being asked of the plan (a view of the whole,
unfiltered plan has nothing to be picked back to — the same bargain `Clear
filters` makes), and a list of what is already saved. Picking one writes the
Find box and the ticks in one gesture, exactly as if a reader had typed and
ticked it themselves; `narrowTree` is still the only thing that reads what a
filter leaves behind, so nothing here holds a narrowed tree of its own.

**Validated at the boundary, the same posture as every other stored
preference here.** Storage that is not an array is dropped whole; a single
saved view that is not usable (missing fields, wrong types, a blank name) is
dropped on its own and the rest still apply — never write-back on read.

**A view naming a team, a person or a phase this project no longer holds is
not repaired or deleted.** Applying it ticks a facet box the panel already
knows how to draw for a value no row carries (`optionsFor`'s existing
fallback, "a team this plan has not loaded"), and narrowing by it answers
empty — the same "empty means empty" rule any other facet with nothing left
to match gets.

## Non-goals

No sharing, no URL, no server storage (Q4). No remembering the expansion or
the column widths inside a view (brief §10). No repairing or pruning a
saved view whose criteria name something since deleted. No change to F2 (the
filter control's placement on a phone) — untouched, still the brief's own
last open piece. **No be-01 change**: no migration, no route, no wire field,
empty `schedule.ts` diff.
