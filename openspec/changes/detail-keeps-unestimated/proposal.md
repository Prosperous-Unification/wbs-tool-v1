<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

The chart's `Detail` switch hides three families of mark: the dependency arrows, the
parent rows' summary brackets, and the bars for slices nobody has estimated. Dany asked for
the third on 2026-08-11 ("remove … unestimated QA bars") and for one button rather than
three on 2026-08-12.

He reversed it on sight on 2026-09-11, looking at his own plan with the switch off:
_"with details disabled you still have to show the unestimated slices"_. Measured there —
twelve of that plan's rows are uncosted, and with `Detail` off those twelve lanes drew
nothing at all. A row on the chart that draws nothing reads as a row with no work rather
than as a row nobody has costed, which is the opposite of what the `?` is for.

## What Changes

**The `Detail` switch answers about two families, not three.** An unestimated slice's
assumed bar — translucent, dashed, carrying a `?` — is drawn whether the switch is on or
off. The arrows and the brackets are unaffected.

The switch's hint text drops its third clause. Marks that hang off an assumed bar follow it:
the hand-off line onto it and its not-before caret are drawn in both states, because their
bar is. A **parent** row still loses its caret with the switch off, because its only mark is
the bracket the switch still hides.

## Non-Goals

No second switch and no per-family state — "all decluttering into one button" stands. No
change to how an assumed bar is drawn, labelled or described. No change to the default the
switch opens in, to the arrows, or to the brackets. Nothing about the table.

## Constraints

`placed.horizon` already reserves the assumed span in both states, so no coordinate moves.
The tests that asserted the old rule are inverted rather than deleted. Two guards lose the
only trigger that was ever demonstrated for them and are recorded rather than quietly kept.

## Capabilities

### Modified Capabilities

- `wbs-domain`: the chart's detail switch no longer hides unestimated slices.

## Domain Terms

none

## Decisions Recorded

none — this reverses a preference, and the ADR bar is decisions that are hard to reverse.

## Impact

`apps/fe-01` only: `gantt-panel.tsx`, `gantt-detail.ts`, their tests and one browser case.
No contract, no migration, no server change.
