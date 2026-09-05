## ADDED Requirements

### Requirement: A calendar marker annotates an absolute date and is not work

A project SHALL be able to carry named markers on absolute calendar dates. A
marker SHALL consist of a project, an `IsoDate`, a name, and a colour.

A marker SHALL NOT be a `work_item` row, SHALL NOT appear in the dependency
graph, capacity, levelling, priority bands or the critical path, and SHALL NOT
be reachable from `libs/domain/src/schedule.ts`. The engine's input type SHALL
gain no field for it: the guarantee is structural, not a promise kept by
discipline.

Markers SHALL NOT be captured into a saved plan. A saved plan is the plan's
own numbers copied by value; an annotation drawn over them is not one of them,
and a restore that resurrected deleted markers would be inventing state.

The proof SHALL compare a **canonical projection of the schedule-bearing
fields**, not the whole response body. `GET /projects/:id/work-items` spreads
`tree()`, which carries the project's event `seq`
(`work-item.service.ts:1147-1159`), and every marker mutation advances that
sequence by design — so whole-body equality is guaranteed to fail for a reason
that has nothing to do with the schedule. A test that compared whole bodies
would fail honestly and mean nothing.

#### Scenario: the schedule projection is identical with markers and without

- **WHEN** a project's schedule is requested, then five markers are added on
  dates inside its span, then the schedule is requested again
- **THEN** the canonical projection — every work item's start, finish and
  critical-path flag, in a fixed order — is identical, while `seq` has
  advanced

#### Scenario: a marker is not a work item

- **WHEN** a marker is created on a project
- **THEN** the project's work-item count is unchanged, and the marker's id
  matches no `work_item` row

#### Scenario: markers stay out of a saved plan

- **WHEN** a project with markers is captured into a saved plan
- **THEN** the captured input bytes contain no marker, and the capture's
  `input_sha256` equals that of the same project with every marker deleted

### Requirement: The header day cell is the marker's interaction surface

Each dated axis cell SHALL accept a click that opens a **day sheet** for that
cell's date. The cell SHALL be the existing axis `<span>` carrying
`data-axis-day` and `data-axis-date`; no SVG hit-testing SHALL be introduced.

The day sheet SHALL list every marker already on that date, each row offering
rename, recolour and delete, and SHALL always offer one **add** action that
opens an empty composer on the same date. A date is not a unique key, so
clicking a populated cell SHALL NOT be an edit of "the" marker: with two
markers on a date there is no such thing, and a sheet that picked one would be
choosing arbitrarily.

On a date with no markers the sheet SHALL open with the composer already open
and its name field focused, so the common case stays one click and a name.

The composer SHALL take the date from the cell's `data-axis-date` and never
recompute it from a pixel offset.

The click SHALL NOT displace the existing hover day-surface: hover opens the
day card, click opens the day sheet.

#### Scenario: clicking an empty dated cell goes straight to a name field

- **WHEN** the axis cell whose `data-axis-date` is `2026-09-17` has no markers
  and is clicked
- **THEN** the day sheet opens reporting `2026-09-17` with the composer already
  open, an empty name field focused, and a colour already chosen

#### Scenario: clicking a populated cell lists what is there and offers another

- **WHEN** markers `Client demo` and `Ops freeze` both exist on `2026-09-17`
  and that cell is clicked
- **THEN** the sheet lists both with their colours, each offering rename,
  recolour and delete, and offers an add action

#### Scenario: a single existing marker is still a list, not an edit

- **WHEN** exactly one marker exists on `2026-09-17` and that cell is clicked
- **THEN** the sheet lists that one marker and still offers the add action, so
  a second marker on that date is reachable in one click

#### Scenario: hover and click do not fight

- **WHEN** the pointer hovers a dated cell and then clicks it
- **THEN** the day surface opens on hover and the composer opens on click, and
  neither closes the other by opening

### Requirement: An undated plan refuses the click and says why

Clicking a cell that carries no date SHALL be refused with a visible message
naming the missing project start date as the reason. A plan with no start date
is drawn on `workdayAxis`, whose cells carry `date: null` and therefore emit
**no** `data-axis-date`.

The cell SHALL NOT be hidden and SHALL NOT be silently inert. A refusal a user
can read is the requirement; an unexplained dead click is a defect.

No marker SHALL be creatable against a workday number. An absolute date has no
position on an axis not made of dates, and synthesising one would put a false
date into storage that the axis could never show back.

#### Scenario: the workday axis refuses

- **WHEN** a project has no start date and a cell of its workday axis is clicked
- **THEN** no composer opens, a message names the missing project start date,
  and no marker is written

#### Scenario: adding a start date enables the same cell

- **WHEN** that project is given a start date and the panel re-renders
- **THEN** the axis is a calendar axis, every cell carries `data-axis-date`,
  and the click opens the composer

### Requirement: Many markers may share a date

A date SHALL NOT be a unique key. Multiple markers on one date SHALL stack in
one axis band and SHALL collapse to a count with a list on hover or tap once
more markers exist than the band can show at the current zoom.

#### Scenario: a second marker on the same date is accepted

- **WHEN** a marker exists on `2026-09-17` and a second is created on the same
  date
- **THEN** both are stored, and the axis cell reports two markers

#### Scenario: overflow collapses to a count

- **WHEN** more markers sit on one date than the band shows at 28px per day
- **THEN** the cell shows a count, and the full list is reachable by hover or tap

### Requirement: Markers are drawn without changing the bar layer

A marker SHALL be drawn as a chip in the axis band anchored to its day, plus a
1px vertical rule of the marker's colour down the chart body drawn **behind**
the bars at reduced opacity.

Nothing SHALL be drawn over a bar. Bar fill and the critical-path
`stroke-foreground [stroke-width:2]` SHALL keep full contrast, so no
precedence rule between marker, today, weekend and critical path is needed.

At 4px per day the rule SHALL be suppressed when the count of markers within
the viewport exceeds the density threshold, leaving the chip alone; the
threshold SHALL be a named constant with a pixel assertion, not a judgement.

A marker SHALL find its day by locating its `IsoDate` in the rendered
`AxisDay[]`, through the same generalised lookup today uses
(`todayOffset`, `gantt-panel.tsx:841`). A marker SHALL NOT compute its own
offset from a date, and SHALL NOT read `CalendarScale` — that interface takes
a **workday** number and returns a calendar offset, so an absolute date is
already past it.

A date absent from the rendered axis SHALL return no offset and draw nothing.

#### Scenario: the bar layer is untouched at the widest zoom

- **WHEN** a marker is added crossing an existing bar at 28px per day
- **THEN** every bar's `x`, `width` and critical-path stroke are unchanged from
  the same plan without the marker

#### Scenario: the rule sits behind the bars

- **WHEN** a marker's rule crosses a bar
- **THEN** the rule element precedes the bar element in paint order, and the
  bar is fully opaque over it

#### Scenario: dense markers drop the rule at the tightest zoom

- **WHEN** markers within the viewport exceed the density threshold at 4px per
  day
- **THEN** no rules are drawn, and every chip remains

### Requirement: The downloaded chart carries its markers

The standalone SVG export SHALL draw every marker chip the live axis shows, in
the same colours and at the same day positions.

`buildStandaloneGanttSvg` nests the live chart SVG but **rebuilds the axis
band from pixel arithmetic** (`gantt-panel.tsx:1789`), so without this
requirement the body rule would cross into the download — it lives inside the
nested chart SVG — while the chip that names it would not. A coloured line
with nothing saying what it marks is worse than no line: the reader sees a
date they cannot identify and has no way to find out.

`StandaloneGanttSvgInput` SHALL therefore carry the markers explicitly, the
same way it already carries `dayPx` rather than assuming a rung, and for the
same reason: the two halves of one downloaded file must not be able to
disagree.

#### Scenario: a downloaded chart shows chip and rule together

- **WHEN** a plan with two markers is exported
- **THEN** the SVG contains a chip for each at its day's x, in its colour, and
  each rule has the chip that names it

#### Scenario: the export drops nothing the screen shows

- **WHEN** a plan with markers is exported at 4px per day with rules suppressed
  by the density threshold
- **THEN** the SVG shows the same chips and the same absence of rules as the
  screen

### Requirement: Automatic colour is deterministic from the marker's identity

A new marker SHALL receive a colour derived deterministically from its own id
over a fixed accessible palette, never from insertion order or from the count
of existing markers. Deleting a marker SHALL NOT change the colour of any
other.

A user-chosen colour SHALL override the automatic one and SHALL be rejected if
it fails the contrast bar in **either** theme. The bar is two numbers, because
a marker is two things:

- **3:1** for the chip fill and the body rule against the chart background —
  WCAG 1.4.11, the non-text bar, which is what these are.
- **4.5:1** for the chip's label text against the chip fill — WCAG 1.4.3.

The check SHALL run at submit, in be-01, not only in the composer. A colour
refused only by the UI is refused only for clients that ask nicely.

#### Scenario: the API refuses what the composer would have refused

- **WHEN** a custom colour below 3:1 in dark theme is posted directly to the
  API, bypassing the composer
- **THEN** the write is refused and no row is written

#### Scenario: colour survives a deletion

- **WHEN** three markers are created and the first is deleted
- **THEN** the remaining two keep the colours they had

#### Scenario: the same id yields the same colour

- **WHEN** the same marker id is assigned a colour twice
- **THEN** the two are equal

#### Scenario: an unreadable custom colour is refused

- **WHEN** a custom colour below the contrast bar in dark theme is submitted
- **THEN** the marker is not written and the composer names the failing theme

### Requirement: A marker's date is a project-local calendar date

A marker SHALL store an `IsoDate` with no time component and no per-user
timezone, the same type the calendar axis is built from. A marker is a day on
a chart, not an instant.

A marker whose date falls outside the current horizon SHALL be stored and
SHALL simply not be drawn; it SHALL reappear when the horizon covers it.

#### Scenario: a marker outside the horizon is kept

- **WHEN** a marker is created and the plan later shortens past its date
- **THEN** the marker is still stored and returned by the API, and no chip is
  drawn

#### Scenario: no timezone shift

- **WHEN** a marker on `2026-09-17` is read by a client in any timezone
- **THEN** it reads `2026-09-17`

### Requirement: Markers persist per project and broadcast their change

Markers SHALL live in a project-scoped child table with a `project_id`
foreign key cascading on project delete, added by an additive forward
migration that alters no existing table — blue and green share one SQLite file
through a swap.

Create, rename, recolour and delete SHALL each emit one content-free
`calendar_markers_changed` on `ProjectEvent`, matching the four `*_changed`
members already there; the client re-reads.

Edit and delete SHALL follow the project's existing write permission. No
per-marker role SHALL be introduced.

#### Scenario: deleting the project takes its markers

- **WHEN** a project with markers is deleted
- **THEN** no marker row for it remains, and the delete raises no constraint
  error

#### Scenario: every mutation broadcasts once

- **WHEN** a marker is created, renamed, recoloured and deleted
- **THEN** four `calendar_markers_changed` events are emitted, carrying no
  payload

#### Scenario: a reader cannot write a marker

- **WHEN** an actor with read-only access to the project submits a marker
- **THEN** the write is refused with the same status the project's other writes
  refuse with, and no row is written
