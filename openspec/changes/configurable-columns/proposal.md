<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

The Tags and Services columns exist only once the directory holds a tag or a
service, so a fresh deployment shows neither. Which columns a plan shows is
decided by data nobody chose it through, and a reader has no say at all.

## What Changes

**Which columns are on screen**

- From: a fixed set, plus Tags and Services when the directory has one.
- To: a **default column set**, the same on every deployment — today's fixed
  columns plus Tags, less Teams and Services — and a **Columns** control where
  a reader hides or shows any column except Number, Name and the row's
  controls, a whole role at a time.
- Impact: non-breaking; the folded width the 1280px budget measures is unmoved
  (Teams off pays for Tags on).

**The toolbar at a laptop width**

- From: five export buttons on the row; a thirteenth control wraps it to three
  rows at 1280.
- To: one **Export** menu for the five, glyph Undo/Redo, a narrower Find box;
  two rows at 1280, measured.
- Impact: non-breaking; every action keeps its name and behaviour.

**Remembering the choice**

- From: nothing to remember.
- To: hidden columns are held per project, per browser, beside the widths;
  **layout reset** forgets them; a **saved view** may carry a column set, and
  older views leave the columns alone.
- Impact: non-breaking; one optional field on the saved-views store.

## Non-Goals

Phone cards, exports, the Gantt panel and hover cards are unchanged: they are
not columns. No server-side or shared column set. No column reordering. Folding
a role stays in the Phases dialog.

## Constraints

`holds the folded budget at 1280` MUST keep passing unchanged (1219px against a
1248px frame). Stored hidden columns are a claim read at the boundary, as widths
and views are. The `columns` memo may depend on the hidden set as it does on
`unfoldedRoles` — one remount per toggle. No be-01 change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wbs-domain`: which columns the table shows and who decides; layout reset
  and saved views carry the column set; the export actions move into one menu.

## Domain Terms

Column set; Default column set; Hidden column; Layout reset (widened).

## Decisions Recorded

None — reversible, and the width arithmetic left one answer.

## Impact

`fe-01` only: `table-frame.ts`, `wbs-table.tsx`, `phases-dialog.tsx`,
`wbs-table.test.tsx`, `table-frame.test.ts`, `phases-dialog.test.tsx`,
`e2e/layout.spec.ts`. `CONTEXT.md`.
