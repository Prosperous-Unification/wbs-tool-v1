# design — `mermaid-export`

Everything below was measured against **Mermaid 11.16.1**'s own gantt grammar
and database, not read off its documentation. The harness and its output are in
`verify.md` under "The parser is the oracle".

Eleven things here are decisions rather than transcription.

## D1 — Mermaid `gantt` is the target, and it is weaker than our chart

The brief named it and it is the right answer, but the honest half of this
change is the accounting, so here it is in full.

**Survives the trip.** Work item number, name and outline (the number *is* the
outline; the diagram is flat exactly as the exported table is) · role · assignee
· team · priority · start and finish as real dates on a real axis · weekends,
because `excludes weekends` and because every date is a working day or the
morning after one · the critical path, as Mermaid's own `crit` · the parallel
width a slice actually ran at · that a slice is unestimated, as a milestone.

**Cannot be drawn at all.**

| Fact | Why Mermaid has no channel | What this export does |
| --- | --- | --- |
| Dependency arrows | The gantt syntax draws none. `after` *positions* a task; it is not an edge, and using it would replace be-01's dates with Mermaid's arithmetic | listed in the legend, one line per edge |
| Capacity floors and person hand-offs | The chart draws a coloured line per wait; a gantt has no line between tasks | listed in the legend, in the chart's own `floorWords` verbatim |
| Start-no-earlier-than carets | No mark for "cannot begin before here" | listed in the legend, with the date |
| Slack on a non-critical row | `crit` is a boolean; there is no float channel | named in the legend's closing sentence |
| One colour per assignee | Per-task colour needs CSS classes the gantt renderer does not take | assignee is in the task name instead; loss named |
| People-at-once asked for vs given | Two numbers, one bar | the *given* width is in the task name; the asked-for one is named as lost |
| Parent rows' spans | The chart has drawn no mark on a parent since `gantt-declutter` — so this is parity, not a loss | section titles carry the numbers |
| The estimate trio | Hover text | named as lost; the table has it |
| The Detail switch's dashed marks and `?` | A control, not a document | named as lost |

**The failure mode this is written against** is a picture that *looks*
complete. That is why the losses are stated twice — D6.

## D2 — one export, and it is the diagram; the table already exists

The brief asked whether to ship a gantt **plus, or versus**, a Markdown table of
the same rows. The premise has already moved: `planToMarkdown` shipped with
`share-the-plan` and the toolbar's **Copy as Markdown** is exactly that table,
every field, every row. So the live question is only whether the new export
**bundles** it.

**It does not.** With three roles that table is twenty columns wide; glued under
a diagram in a README it renders as a horizontally-scrolling slab that buries
the picture somebody pasted the block for. Two buttons, one document each: this
one carries the *shape* and loses fields, its neighbour carries every field and
loses the shape.

What makes that safe rather than a silent hole is that the legend **names the
neighbouring button by its label**, in the same sentence that admits the loss.
A reader who needs a field is one click away and is told so.

_Refused:_ bundling both into one payload (above). _Refused:_ replacing
`Copy as Markdown` with a combined export — it would change a shipped behaviour
that is not in scope and would make the table unobtainable on its own.

## D3 — the whole plan, not the drawing

`ganttPlan` is built from `shownRows`; the export builds its own from every row
of the tree. Word for word `planForExport`'s reason: a collapse and a search are
how *this* reader is looking at the plan, and an export carrying either hands
somebody else a plan with rows missing and nothing saying so.

The cost is one extracted function, `ganttRowOf`, so the panel and the export
map a row the same way. Two copies of that map would be two answers to "what
does a bar say about this row", and the export's would be the one nobody looks
at.

## D4 — the clipboard, not a download

Matching what is already there rather than inventing a third habit: the two
Markdown-shaped exports copy, and only the spreadsheet one downloads, because a
spreadsheet needs a file and a document needs a paste. The same two modeled
clipboard failures are reported in the same words.

_Refused:_ downloading a `.md`. A pasted diagram is the use case Dany described,
and a file adds a step to it.

## D5 — sections are work items, tasks are role slices

Mermaid has exactly one grouping channel. Spending it on assignees — the
chart's *colour* channel — would scatter one work item's roles down the diagram
and leave the reader unable to see a row at all. Spending it on top-level
parents would put forty tasks in one band. So a section is a row and a task is
a bar, which is what the chart's own y-axis is, and the two read as one picture.

Parents contribute no task, matching the chart since `gantt-declutter`.

## D6 — the losses are written twice, and the empty list is written too

A `%%` comment survives a copy and is what the next reader of the *source* sees.
It is invisible in a rendered diagram, and the render is exactly where "looks
complete" happens. So the same losses are also a Markdown legend under the
fence.

Every legend bullet is printed even when its list is empty, with words saying
the plan holds none of that fact. A bullet that vanished with its list would
leave a reader unable to tell "this plan has no dependencies" from "this
document dropped them" — which is the whole failure again, one level down.

## D7 — dates: always a calendar, synthetic when the plan has none

Mermaid's gantt has one axis and it is a calendar. `dateFormat X` (unix
seconds) with `axisFormat %d` would draw day numbers, and it makes every reader's
renderer agree about a format almost nothing uses; the dates then read as 1970 in
anything that does not. So a plan with no start date is pinned to **2000-01-03**,
a Monday, and says so in the comment block and in the legend.

_Refused:_ refusing to export at all without a start date — that makes the button
dead on exactly the plans still being shaped.

Every mark goes through one placement: `placeOnCalendar`, called once, read by
the tasks and by the not-before list alike. The origin is
`addWorkdays(startDate, 0)` and not the start date itself, so a project starting
on a weekend begins on the Monday — the normalisation the Start column already
makes. A not-before flag's date comes off the **placed** `x` and never off the
geometry's `offset`, which is a workday number: workday 8 of a plan starting
Monday 1 June is Thursday the 11th, and the raw offset read as a calendar day is
Tuesday the 9th. That was a real fault in this change, watched failing (verify.md
R1).

## D8 — fractions round outward; a span of no days is a milestone

A slice runs `effort / width` workdays and can be fractional; Mermaid's day is
atomic. A start floors and a finish ceils, so no bar is drawn shorter than the
work in it, and the rule is stated in the comment block.

A bar with no span is a milestone rather than a rectangle of no width, and the
two reasons are kept apart in the task name: `not estimated` and `0 days`.

**Never** `ASSUMED_UNESTIMATED_WORKDAYS`. The chart draws that two-day guess
dashed and with a `?` beside it; Mermaid has neither, so two solid days here
would be an estimate this tool invented inside somebody else's document.

## D9 — the wait sentences are quoted, not re-derived

The legend's wait lines are `GanttBar.floorWords` verbatim — the words the bar
shows on hover — so the document and the chart cannot say two different things
about one wait.

**The cost, recorded rather than fixed.** `layOutGantt` builds those sentences
from `row.name` alone, so a line reads `020 Fit · Dev — Waits for Platform to
free 2 people — after Lift the boards (Dev)`: the line's own row is numbered and
the predecessor inside the quote is not. Two rows sharing a name are ambiguous
there. Fixing it means changing the chart's hover text, which is a shared face
and out of this change's scope; it is pinned by a test so the asymmetry cannot
drift unnoticed.

Same shape, deliberately: a colon in a work item name is escaped in the diagram
(D10) and left alone in the legend, because the legend is Markdown and Markdown
does not care.

## D10 — escaping: only the colon, and only because Mermaid moves the split

Measured, not assumed. Mermaid splits a task line on its **first** colon:
`Dev: build :t1, 2026-06-01, 2026-06-04` reads back as
`{task: 'Dev', id: 'build :t1'}` — the diagram does not fail, it quietly means
something else. So `:` becomes `-` in every phrase that stands left of the
colon, and newlines are collapsed.

**Nothing else is touched.** A comma, a `#`, a `%`, a `;`, a `<`, an em dash and
a middle dot all read back verbatim through the same parser; escaping them would
export names nobody typed.

An **empty** name is a parse error rather than a nameless bar, so an unnamed row
gets the tree's own `(unnamed)`.

## D11 — determinism, and no guard that cannot be watched fail

No clock, no randomness, no iteration over anything keyed by object identity.
Task ids are `t1` upward in layout order — not the slice's own id, which would
carry be-01's keys into a document a person reads, and not a name, which would
collide the moment two rows share a role. Pinned by a test that exports the same
plan twice and compares strings.

Two places index a row by id or by index (`dependencyLines`, `notBeforeLines`).
Both are written as **skips**, not throws: `layOutGantt` builds `labels`,
`arrows` and `notBeforeFlags` in one pass over one `rows` list, so the missing
arm is unreachable, and AGENTS.md R5 is explicit that a check whose failure can
never be observed is a claim rather than a gate. `notBeforeLines` walks the
labels rather than the flags precisely so no index lookup is needed at all.

The one genuinely new guard in the UI **is** watchable and is watched: React does
not catch what an event handler throws, so `layOutGantt`'s `GanttDataError` — a
peer's edit landing between two reads — would be a button that does nothing at
all. It is caught and reported in the fault panel's own words, and only it: any
other throw is a fault this component has no reading of, and swallowing it into a
toast would file a bug under "could not copy".
