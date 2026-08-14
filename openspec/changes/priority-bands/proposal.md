<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

A priority is an integer and nothing on any screen says what it means. Dany,
2026-08-13, verbatim:

> they are numeric but I want labels assigned to them; like 1-20 are critical,
> 21-40 are high, 41-60 are medium, 61-80 are low, 81-further is lowest; and by
> default critical sets to 10, high to 30, medium to 50, low to 70, lowest to 90;
> I described the default setting, but all this needs to be configurable by
> project; I want to be able to easily select priority by labels or input a
> number manually; ui must display differently for different priorities

Four asks in one sentence: a vocabulary, a per-project one, an input that takes
either language, and a plan that looks different where the priorities differ.

## What Changes

**A project's priority numbers get names.** New table
`project_priority_band(project_id, rank, starts_at, label, default_value)`, five
rungs keyed on the rung. A band is a **start value** and the next band's start
ends it, so the ladder is contiguous and exhaustive by construction and every
number resolves to exactly one label.

**The migration seeds every existing project, and the read never needs it to
have.** A project holding no rows reads as `DEFAULT_PRIORITY_BANDS` — a constant
in the source, not a global anybody types — so a project made before the
migration and one made after it read the same ladder.

**One write, one whole ladder.** `PUT /api/projects/:id/priority-bands` takes
five bands and validates them together, because contiguity is a fact about the
five and not about any one.

**A `Priorities` dialog beside `Teams`**, which is where per-project
configuration goes since C5.

**The Prio cell speaks both languages.** A typed number is the number; a typed
band name, or a line taken from the list a click opens, is that band's own
default. Both round-trip.

**One function decides how a band looks** — `priorityBandStyleOf` — read by the
table's cell, the chart's bar cap, the plan cards' chip and the export's new
`Priority band` column.

**No date moves.** The leveller reads `work_item.priority` and that integer
alone. Asserted, not asserted about.

## Non-goals

Adding or removing a rung. Undo for a ladder. Re-numbering work items when a
band is re-cut. Choosing the five colours — Dany will revisit them once he can
see them.
