<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename.
It holds the intent artifact. Approach detail belongs in design.md.
-->

## Why

Teams, Tags, Services and Depends on all edit reference sets, but their cells and
phone sheets now expose different add, selection, removal and overflow behavior.
Teams additionally reads a stored `teamIds[]` through `.at(0)` and writes the
legacy scalar, so the UI cannot express the multiple-team outcome Dany approved
on 2026-08-27. A dependency list can name every predecessor accessibly while its
third visible entry is clipped and its hover card cannot itself be pointed at.

## What Changes

**One interaction family.** The four cells lead with the same quiet `+`, show
compact removable chips, search from the keyboard, use matching accessible
names and open/close rules, and present the corresponding controls in 390×844
bottom sheets. Teams, Tags and Services create directory entries; Depends on
searches project work items and never pretends to create one.

**Teams becomes set-valued end to end.** The row's own `teamIds[]` is edited by
full-replacement writes. Adding or removing one member preserves its siblings.
An empty own set continues to mean unstated and inherits the nearest ancestor's
whole set. Re-enabling several teams also re-enables the already-designed
multi-pool rule: every named team spends slots, the width clamps to the narrowest
stated capacity, and the slice starts where all stated pools have room.

**Dependency overflow becomes reachable.** The anchored full list remains open
while the pointer travels from the Depends-on cell to a listed dependency.
Pointing at one list row narrows the existing tint to that dependency and its
work-item row; empty overlay space remains click-through.

## Non-Goals

No new label dimension, directory redesign, table-wide layout rewrite, explicit
"no inherited label" state, dependency creation, or migration. No redundant tab
stop is added to a list already exposed by the Depends-on combobox description.

## Constraints

Current `work_item_team`, `teamIds[]` reads and `effectiveTeamsOf` remain the
model. PR #156 is the phone baseline. The legacy scalar team patch stays
accepted for one release. Passive hover-card space keeps `pointer-events:none`.
All tests/builds run on h2puni or CI; Chromium proves hit-testing and paint.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wbs-domain`: reference-set editing, multi-team scheduling/writes, and reachable dependency overflow.

## Domain Terms

Team set; Effective team set; Dependency.

## Decisions Recorded

- [ADR 0006 — A multi-team work item spends every named team's pool](../../../docs/adr/0006-multi-team-work-spends-every-named-team-pool.md)

## Impact

`be-01` scheduling, work-item patch/undo/repository paths and `fe-01` table,
cards, wire types, hover card, styles, DOM tests and Chromium specs. No schema or
gateway change.
