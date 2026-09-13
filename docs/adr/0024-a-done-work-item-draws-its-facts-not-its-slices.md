---
status: accepted
---

# A done work item draws its facts, not its slices

A work item whose status is done is drawn on the Gantt panel as **one done bar over its fact
span** — from its fact start, or its first slice's start when it has none, to its fact end —
in place of its slices; the bar never reaches past the fact end whatever the estimate says.
Its status stays **derived from step progress** and is never stored on the row; marking a row
done writes `done` on every step of the project for it. Fact start and fact end are two
**date-only** columns on `work_item`, one pair per work item, held like `deadline` on any row.

`role-progress` (archived 2026-08-30) shipped per-step statements with no face and named this
decision as the one it would not make: _"a stored date that disagrees with the scheduled one
needs a decision about which of the two a chart draws."_ Dany asked for it on 2026-09-12 —
_"no matter the estimate the task does not go longer than fact_end for the gantt chart"_ — for
plans whose timeline keeps moving after some of the work is finished.

**The chart draws the fact and the engine keeps the forecast.** The scheduler does not read
facts or status: successors still wait on the forecast, the Start and End columns keep it, and a
parent's bracket stays be-01's projection. That is the same posture `actual-days` and
`role-progress` took — reporting first, the engine's reading a later change with its own
questions (what a finished predecessor does to a successor's floor, what a done step's
estimate leaves in the totals).

## Considered options

- **A stored row status.** Refused: `role-progress` P3 already argued that a per-item state
  beside per-step statements is a second source of truth about one subject, and the sentence
  it produces — _the row says done and a step on it has said nothing_ — is the one the
  vocabulary exists to prevent. The row's cell writes every step instead, so the fold and the
  cell can never disagree.
- **Per-step fact dates.** Refused: the chart clips a work item, and the planner records when
  a task started and finished, not when Dev handed to QA. The step split of a finished item is
  history the fact has overtaken.
- **A time of day.** Refused: every date on `work_item` is a day with no zone, the calendar
  axis is days, and an instant would let the reader's zone decide which day the work
  finished on. "Now" is the day of the act.
- **Clipping each slice at the fact end.** Refused: a plan that drifted past the fact leaves
  every slice after the end with nothing to clip, and a sequence of slices pushed back to end
  on the fact day is still a picture of a forecast, only a compacted one.
- **A fact-aware projection from be-01.** Deferred: it would move the End column and the
  bracket, which are the forecast; that is the engine's reading, not the drawing's.

## Consequences

Dependency arrows and person links from a done work item leave its done bar, so the
arrow-anchor lookup reads the drawn bar rather than the raw slice. A duplicate copies no fact
(a copy has not happened) and a saved plan holds none (a fact moves no date and is read by
nothing in `libs/domain`). Reversing the drawing rule is cheap; reversing the two columns is a
destructive `down.sql`, and any plan holding facts loses them.
