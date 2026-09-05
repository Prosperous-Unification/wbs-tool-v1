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

### Requirement: The day cell is a control and carries a control's contract

A dated axis cell SHALL be reachable and operable from the keyboard. It is a
`<span>` today only because it was hover-only until now, and hover needs no role,
no tab stop and no key handler while a click does. Shipping `onClick` on a bare
`<span>` SHALL NOT satisfy this requirement.

The dated cell SHALL carry `role="button"` and `tabIndex={0}`, SHALL open the
day sheet on **Enter** and on **Space**, and SHALL show a visible focus
indicator. It SHALL carry `aria-haspopup="dialog"` and an `aria-expanded` that
tracks the sheet, because a sheet is what opens.

Its accessible name SHALL name the **date** and, when markers exist, their
count. A row of tab stops all announced as "button" is less usable than no tab
stop at all.

An **undated** cell SHALL carry none of this: no role, no tab stop, no key
handler. It is not a control, and the refusal below is for the pointer user who
can still click it. That refusal SHALL be rendered into a live region so it is
announced and not merely drawn.

#### Scenario: the keyboard opens the day sheet

- **WHEN** a dated cell is focused and Enter is pressed, and again with Space
- **THEN** the day sheet opens in both cases

#### Scenario: the cell announces its date

- **WHEN** a dated cell with two markers is focused
- **THEN** its accessible name names that cell's date and reports two markers

#### Scenario: undated cells are not in the tab order

- **WHEN** a plan with no start date is rendered
- **THEN** no axis cell is focusable, and none carries `role="button"`

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
`stroke-foreground [stroke-width:2]` SHALL keep full contrast.

**"Behind the bars" SHALL NOT be the whole ordering.** The body paints five
marks before any bar, and the marker rule SHALL take one named slot among them:
after the weekend columns (`data-gantt-weekend`), the row bands, today's tinted
column (`data-gantt-today`), the gridlines (`data-gantt-gridline`) and today's
leading edge (`data-gantt-today-edge`), and before the row hit lines and every
bar. Paint order in SVG is source order, so the slot is a position in
`marksOverLight` and not a `z-index`.

A marker on today's date SHALL therefore draw **over** today's leading edge.
Today SHALL remain findable because it is marked twice — a tinted column a whole
day wide as well as the 1px edge — and a 1px rule cannot cover the column. The
reverse order would hide a marker the user had just placed on today, which is
the silent absence this design refuses elsewhere.

At 4px per day the rule SHALL be suppressed when the count of markers within
the viewport exceeds `MARKER_RULE_MAX_PER_100PX`, leaving the chip alone. That
constant SHALL be **6** and SHALL be named in code with a pixel assertion over
it: 100px holds 25 days at that rung, so six rules is one per ~16px and seven
would put two inside one heavy-gridline week. At the 12px and 28px rungs 100px
holds fewer than 8 days, so the threshold SHALL be unreachable there and the
rules SHALL always draw.

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

#### Scenario: a marker on today is visible and today is still findable

- **WHEN** a marker is placed on today's date
- **THEN** its rule element follows `data-gantt-today-edge` in paint order, and
  the tinted `data-gantt-today` column is still present at that offset

#### Scenario: a marker on a weekend clears the weekend column

- **WHEN** a marker is placed on a Saturday inside the horizon
- **THEN** its rule element follows that day's `data-gantt-weekend` column in
  paint order, and the weekend column is unchanged from the same plan without
  the marker

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

The palette SHALL hold **eight** entries and the derivation SHALL be
`palette[hash(id) mod 8]`, so distinct ids SHALL yield more than one colour.
"The same id gives the same colour" and "a deletion changes nothing" are both
satisfied by a function that returns one constant, so the requirement SHALL be
proved against **pinned id-to-colour vectors**: named ids whose expected entries
are written down, at least two of them different.

The hash SHALL be taken over the marker's **id and nothing else**. Hashing the
name would recolour a marker when it is renamed; hashing the date would give
every marker on one date the same colour, which is exactly the identity a
stacked band needs to tell apart.

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

#### Scenario: pinned ids land on their pinned colours

- **WHEN** the automatic colour is taken for each of the pinned id vectors
- **THEN** each equals the palette entry written down for it, and at least two
  of the vectors differ from each other

#### Scenario: renaming a marker does not recolour it

- **WHEN** a marker with an automatic colour is renamed
- **THEN** its colour is unchanged

### Requirement: The composer issues the marker id so its colour preview is true

The composer SHALL generate the marker's v4 UUID and SHALL send it in the create
request, and the automatic colour it previews SHALL be the colour the created
marker has. A preview the create can contradict is worse than none: it invites
the user to accept a colour they will not get.

be-01 SHALL accept a client-supplied `id` and SHALL fall back to its existing
`Clock.newId()` when the body omits one, so every other caller of that port is
unchanged.

A create whose `id` already exists SHALL be refused with no row written and no
existing marker modified. Ids are v4 UUIDs, so a collision is a defect or an
attack, never ordinary traffic, and merging into the existing row would let a
caller overwrite a marker it cannot otherwise address.

#### Scenario: the previewed colour is the created colour

- **WHEN** the composer opens on a date, previews the automatic colour for its
  generated id, and the marker is submitted
- **THEN** the created marker's chip is that same colour

#### Scenario: an omitted id is issued by the server

- **WHEN** a create arrives with no `id`
- **THEN** the marker is created with a server-issued id

#### Scenario: a duplicate id is refused

- **WHEN** a create repeats the id of an existing marker
- **THEN** the write is refused, no row is added, and the existing marker's
  name, date and colour are unchanged

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

#### Scenario: a marker reappears when the horizon grows back

- **WHEN** the plan is lengthened again so its horizon covers that marker's date
- **THEN** the chip is drawn at that date's axis offset

#### Scenario: no timezone shift

- **WHEN** a marker on `2026-09-17` is read by a client in any timezone
- **THEN** it reads `2026-09-17`

#### Scenario: a date near the UTC day boundary is stored as picked

- **WHEN** a client at UTC+13 creates a marker on the axis cell for
  `2026-09-17`, at a local instant whose UTC date is `2026-09-16`
- **THEN** the stored date is `2026-09-17` — the cell the user clicked — and no
  instant is converted anywhere on the path

#### Scenario: a date is never coerced through a `Date`

- **WHEN** `2026-9-17`, `2026-09-17T00:00:00Z` and `not-a-date` are each
  submitted as a marker's date
- **THEN** each is refused, and no row is written for any of them

### Requirement: Markers persist per project and broadcast their change

Markers SHALL live in a project-scoped child table with a `project_id`
foreign key cascading on project delete, added by an additive forward
migration that alters no existing table — blue and green share one SQLite file
through a swap.

Create, rename, recolour and delete SHALL each emit one content-free
`calendar_markers_changed` on `ProjectEvent`, matching the four `*_changed`
members already there; the client re-reads.

**The re-read is the half that matters and SHALL be proved.** Emitting the event
is not the guarantee — a second client already viewing the project SHALL show the
change without a reload. An event nobody acts on is a broadcast into an empty
room, and it passes every test that only counts emissions.

Markers SHALL be scoped to one project. A read of one project SHALL return none
of another's, and a mutation naming a marker of another project SHALL be refused
with no row changed.

A marker SHALL NOT be addressable as a work item: no marker id SHALL resolve
through the work-item routes, and no work-item id SHALL resolve through the
marker routes.

The list SHALL be **totally** ordered, by `(date, created_at, id)`. `(date,
created_at)` alone ties for two markers created inside the same millisecond, and
a tie leaves the order free to change between reads of unchanged data.

Edit and delete SHALL follow the project's existing write permission. No
per-marker role SHALL be introduced.

A create or update that is refused SHALL answer with the refusal shape the
project's other writes already use, naming which field failed and why, and SHALL
NOT partially apply: after a refused rename the marker SHALL still carry its old
name.

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

#### Scenario: a second client sees the change without reloading

- **WHEN** two clients view one project and the first creates a marker
- **THEN** the second re-reads on `calendar_markers_changed` and shows the new
  chip without a reload

#### Scenario: one project's markers are invisible to another

- **WHEN** two projects each hold markers and one project's markers are listed
- **THEN** only that project's markers are returned, and a rename naming the
  other project's marker is refused with both rows unchanged

#### Scenario: a marker is not addressable as a work item

- **WHEN** a marker's id is requested through the work-item routes, and a work
  item's id through the marker routes
- **THEN** both are refused, and neither resolves to the other kind of row

#### Scenario: same-millisecond markers keep one order

- **WHEN** two markers on one date are created against a fixed clock so their
  `created_at` values are equal, and the list is read twice
- **THEN** both reads return them in the same order, decided by id

#### Scenario: a refused rename changes nothing

- **WHEN** a rename is submitted with an empty name
- **THEN** it is refused with the field named, and the marker still carries its
  previous name
