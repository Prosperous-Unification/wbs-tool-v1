<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

`status-at-a-glance` put status on every surface; Dany read the result on his plan and asked
for seven adjustments (2026-09-13, with screenshots): the done bar's tick sits on its label
and is white where the table is green; the done tint is a shade too strong; a finished
predecessor is unmarked in the Depends card and picker; the Status column runs into Links
with no rule between them; the Columns control lists Status where it used to render; and
the status card says `Unknown`/`Done` in the same weight as the rest.

## What Changes

**Chart.** A done bar wears a green outline and its tick is the same green — the table's
`--status-done`, as a hex the exported SVG can carry. The label leaves the tick's width
free at its right end, so the ellipsis lands before the mark. A done bar's outline outranks
the critical ring.

**Table.** The done tint drops from 12% to 7%. The Status column draws the right-edge rule
the other pinned columns draw. The Columns control lists `Status` after `Links`, where it
renders.

**Dependencies.** Every line of the Depends card and of the picker list carries a 3px left
border; a done predecessor's is `--status-done`, the rest are transparent so the text lines
up. Entries carry the predecessor's `status`.

**Status card.** The fact's lead word (`Unknown`, `In progress`, `Done`) is drawn bold, and
`Done` in `--status-done`, through two optional mark attributes the hint layer reads:
`data-fact-lead` and `data-fact-tone`.

## Non-Goals

No new statuses, no change to what a done bar spans, no change to the strip or the
completion prompt, no tone but `done`.

## Constraints

`styles.css` moves no pixel: the rule is a `box-shadow`, the tint a colour. The SVG's colours
are hex literals. The Columns control follows `hideableColumnIds`, whose one rule is table
order.

## Capabilities

### Modified Capabilities

- `wbs-domain`: the done bar's outline, tick and label; the done tint; the Status rule and
  Columns order; done predecessors marked; the status card's lead word.

## Domain Terms

None new.

## Decisions Recorded

None: every choice here is a shade, a width or a place, and each is cheap to reverse.

## Impact

`fe-01` only.
