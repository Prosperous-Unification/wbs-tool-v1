## Why

Dany, 2026-08-19: _"One more thing I need - on Gantt chart view I want to see
the current date marked"_.

The chart draws a plan's whole span and gives a reader no way to find themselves
in it. Every other question the chart answers is relative — this bar is after
that one, this one is critical — and "how much of this has already happened" is
the one it cannot answer at all. On a plan of any length, finding today means
counting cells from a month caption.

`today` already exists in `gantt-panel.tsx` and is read by two things: the
year-omitting date format, and the hover text. Nothing draws it.

## What Changes

**One column, off the axis the chart already has.** `todayOffset` looks the
reader's date up in the `AxisDay[]` the gridlines and weekend bands are drawn
from, and answers its `offset` or `null`. There is deliberately **no second
scale**: a parallel `calendarDaysBetween(origin, today)` would agree with the
axis only until somebody touched one of them, which is the drift
`calendarAxis`'s own docstring warns about.

**A column and not a hairline.** What is known is which _day_ it is; a 1px rule
at the day's left edge claims an instant. The column is tinted like a weekend —
the same kind of fact, a property of the calendar rather than of any row — with
a line down its leading edge so the boundary stays legible where a bar covers
the tint. Bars draw **over** it: a bar across the edge is work begun and not
finished, which is the sentence the whole feature exists for.

**Null is the answer three ways, and all three draw nothing** (Dany's call,
asked and answered before the build): today before the plan's first drawn day,
today after its last, and a chart with no calendar at all. A marker clamped to a
margin would say the plan starts or ends today. On the workday axis every cell
carries `date: null`, so the lookup finds nothing without needing to know why.

**A weekend needs no arm of its own.** On the calendar axis a Saturday is a cell
two columns wide with the rest, so today falling on one puts the mark in the gap
between Friday's work and Monday's. That is a property of the axis, and it is
asserted rather than assumed.

**`isoToday` is written out and tested.** It is the one place in this panel a
`Date` becomes an `IsoDate`, and `toISOString().slice(0, 10)` is the wrong
spelling: it converts to UTC first. East of Greenwich that names yesterday for
the first hours of every day — three of them in Kyiv, which is the zone this
tool is used in.

**In text as well as in colour.** Today's axis cell takes `aria-current="date"`
and the day's number takes the mark's own ink, bold whether or not it is a
Monday.

## Impact

- **PoC mode**: fe-01 only. No `drizzle/**`, no `service/schedule.ts`, nothing
  in `libs/domain`. See `notes/delivery-modes.md`.
- **Affected specs:** `wbs-domain` — two requirements, what is marked and what
  is deliberately not.
- **Affected code:** `apps/fe-01/src/components/wbs/gantt-panel.tsx` and its
  test file. Nothing else in the repo is touched.
- **Deliberately untouched:** `gantt-geometry.ts`. The marker is a reading of
  the axis, not a mark the geometry places, and putting it there would be the
  second scale this change exists to avoid.

## Non-goals

- **No "today is off to the right" affordance** at the margin when the plan is
  in the past or the future. It is a second thing to explain, and the caption
  above the labels already names the month on screen.
- **No scroll-to-today control.** A reasonable next ask, and a different one: it
  needs a decision about what happens on a plan today is not on, which is the
  case this change deliberately draws nothing for.
- **Nothing reads the marker.** No bar is coloured by whether it is in the past,
  no row is flagged late. Lateness is a real feature and it needs actuals and a
  progress state to mean anything — `role_progress` exists, and this is not that
  change.
