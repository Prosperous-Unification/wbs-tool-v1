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

#### Scenario: the schedule is byte-identical with markers and without

- **WHEN** a project's schedule is requested, then five markers are added on
  dates inside its span, then the schedule is requested again
- **THEN** the two responses are byte-identical, including
  `scheduler_algorithm_id` and every start, finish and critical-path flag

#### Scenario: a marker is not a work item

- **WHEN** a marker is created on a project
- **THEN** the project's work-item count is unchanged, and the marker's id
  matches no `work_item` row

#### Scenario: markers stay out of a saved plan

- **WHEN** a project with markers is captured into a saved plan
- **THEN** the captured input bytes contain no marker, and the capture's
  `input_sha256` equals that of the same project with every marker deleted

### Requirement: The header day cell is the marker's interaction surface

Each dated axis cell SHALL accept a click that opens a marker composer for
that cell's date, and SHALL reopen an existing marker on that date for rename,
recolour or delete. The cell SHALL be the existing axis `<span>` carrying
`data-axis-day` and `data-axis-date`; no SVG hit-testing SHALL be introduced.

The composer SHALL take the date from the cell's `data-axis-date` and never
recompute it from a pixel offset.

The click SHALL NOT displace the existing hover day-surface: hover opens the
day card, click opens the composer.

#### Scenario: clicking a dated cell opens the composer on that date

- **WHEN** the axis cell whose `data-axis-date` is `2026-09-17` is clicked
- **THEN** a composer opens reporting `2026-09-17`, with an empty name and a
  colour already chosen

#### Scenario: clicking a cell that already has a marker edits it

- **WHEN** a marker named `Client demo` exists on `2026-09-17` and that cell is
  clicked
- **THEN** the composer opens on the existing marker with its name and colour,
  offering delete

#### Scenario: hover and click do not fight

- **WHEN** the pointer hovers a dated cell and then clicks it
- **THEN** the day surface opens on hover and the composer opens on click, and
  neither closes the other by opening

### Requirement: An undated plan refuses the click and says why

A plan with no start date is drawn on `workdayAxis`, whose cells carry
`date: null` and therefore emit **no** `data-axis-date`. Clicking such a cell
SHALL be refused with a visible message naming the missing project start date
as the reason.

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

Marker geometry SHALL come from the same `CalendarScale` every other mark
reads. A marker SHALL NOT compute its own x.

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

### Requirement: Automatic colour is deterministic from the marker's identity

A new marker SHALL receive a colour derived deterministically from its own id
over a fixed accessible palette, never from insertion order or from the count
of existing markers. Deleting a marker SHALL NOT change the colour of any
other.

A user-chosen colour SHALL override the automatic one and SHALL be rejected if
it fails the contrast bar against either theme's chart background.

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
