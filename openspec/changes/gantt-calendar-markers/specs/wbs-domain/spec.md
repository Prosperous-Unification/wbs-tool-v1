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

The projection SHALL be **the entire schedule response with `seq` deleted**, and
SHALL NOT be an enumerated list of fields. Two rounds of review each named a set
of schedule-bearing fields and each set was short — the round-4 answer listed
every work item's whole `schedule` and every slice and still omitted
`workItems[].dates`, which the payload carries separately from `schedule`, and
the scheduling inputs the same read returns (`teamCapacities`, `priorityBands`,
`estimateMethod`, `pertWeights`, `estimateRounding`, `depReach`, `startDate`,
`projectRevision`) (round-5 Sol review). A list maintained by hand against a
growing payload will be short again at the next field, so the contract is the
complement: `seq` is the single exclusion, it is excluded because a marker
broadcast advances it by design, and the comparison SHALL assert alongside the
equality that `seq` did advance — which proves the deletion removed a moving
field rather than masking a stale one.

#### Scenario: the schedule projection is identical with markers and without

- **WHEN** a project's schedule is requested, then five markers are added on
  dates inside its span, then the schedule is requested again
- **THEN** the whole response body with `seq` deleted is identical, while `seq`
  itself has advanced

#### Scenario: a marker is not a work item

- **WHEN** a marker is created on a project
- **THEN** the project's work-item count and rows are unchanged, and the domain
  scheduler's call site gains no argument

The scheduler's isolation SHALL additionally be verified as a **reach in the
other direction**: a schedule read SHALL issue no SQL statement naming
`calendar_marker`. The call-site and source assertions above cannot see this —
the scheduler's six arguments are built in the service that calls it, not in the
engine, so marker-derived data folded into an ordering or resource input leaves
the call at six arguments and the engine's source marker-free.

#### Scenario: a schedule read never reaches the marker table

- **WHEN** the schedule is read for a project that has markers
- **THEN** no SQL statement issued by that read names `calendar_marker`

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

An **undated** cell SHALL be a keyboard-operable control announcing an
unavailable state. It SHALL carry `role="button"`, `tabIndex={0}`,
`aria-disabled="true"`, the same Enter and Space handlers, and an accessible
name naming its position and the missing project start date. Activating it —
by pointer, Enter or Space — SHALL emit the refusal below into a live region.

`aria-disabled` rather than the `disabled` attribute, and this is the whole
point: a genuinely disabled control is removed from the tab order, and a user
who cannot reach it is never told why it does nothing. An earlier draft gave
the undated cell no role, no tab stop and no key handler and _also_ required
the refusal to be announced in a live region — which cannot both be true,
because the only element that fires the refusal was unreachable by the users
the live region exists for (corrected after the round-4 Sol review).

It SHALL NOT carry `aria-haspopup` or `aria-expanded`: no sheet opens.

#### Scenario: the keyboard reaches the refusal

- **WHEN** an undated plan is rendered, a cell is focused and Enter is pressed,
  and again with Space
- **THEN** the cell carries `role="button"`, `tabIndex={0}` and
  `aria-disabled="true"`, no sheet opens in either case, and the refusal text
  appears in the live region in both

#### Scenario: the keyboard opens the day sheet

- **WHEN** a dated cell is focused and Enter is pressed, and again with Space
- **THEN** the day sheet opens in both cases

#### Scenario: the cell announces its date

- **WHEN** a dated cell with two markers is focused
- **THEN** its accessible name names that cell's date and reports two markers

#### Scenario: undated cells are focusable but announce themselves unavailable

- **WHEN** a plan with no start date is rendered
- **THEN** every axis cell is focusable and carries `role="button"` and
  `aria-disabled="true"`, each is reachable by role **and** by an accessible
  name that names both its workday position and the missing project start
  date, and none carries `aria-haspopup` or `aria-expanded`

### Requirement: An undated plan refuses the click and says why

Clicking a cell that carries no date SHALL be refused with a visible message
naming the missing project start date as the reason. A plan with no start date
is drawn on `workdayAxis`, whose cells carry `date: null` and therefore emit
**no** `data-axis-date`.

The cell SHALL NOT be hidden and SHALL NOT be silently inert. A refusal a user
can read is the requirement; an unexplained dead click is a defect.

No marker SHALL be creatable against a workday number. An absolute date has no
position on an axis not made of dates, and synthesising one would put a false
date into storage that the axis could never show back. The guard is the
`IsoDate` validator on the write path: a workday number is not an `IsoDate`, so
nothing further is needed and no check on the project's start date SHALL be
introduced.

A project with no start date SHALL still accept a marker on a valid `IsoDate`,
and that marker SHALL be stored and returned by the API and simply not drawn —
the same "stored, not drawn" rule a marker outside the horizon gets. The absent
start date is a property of the _axis_, not of the date, and refusing the write
would discard a fact the user is entitled to record before the plan is dated.

#### Scenario: an undated project still stores a real date

- **WHEN** a project with no start date is sent a marker on `2026-08-19`
- **THEN** the marker is stored and returned by the list, and no chip is drawn
  because the axis has no dates to draw it on

#### Scenario: a workday number is refused as a date

- **WHEN** a create for that same project carries `7` as its date
- **THEN** it is refused by the `IsoDate` validator with no row written

#### Scenario: the workday axis refuses

- **WHEN** a project has no start date and a cell of its workday axis is clicked
- **THEN** no composer opens, a message names the missing project start date,
  and the client issues no create request

#### Scenario: adding a start date enables the same cell

- **WHEN** that project is given a start date and the panel re-renders
- **THEN** the axis is a calendar axis, every cell carries `data-axis-date`,
  and the click opens the composer

### Requirement: Many markers may share a date

A date SHALL NOT be a unique key. Multiple markers on one date SHALL stack in
one axis band and SHALL collapse to a count with a list on hover or tap once
more markers exist than the band can show at the current zoom.

That capacity SHALL be a named ladder rather than whatever fits:
`MARKER_BAND_MAX_PER_CELL` is **3** at 28px per day, **2** at 12px and **1** at
4px, and the cell SHALL render `+N` for the markers it did not show. A cell four
pixels wide cannot hold three chips, so one constant across the ladder would be
wrong at one end of it whichever value it took.

#### Scenario: a second marker on the same date is accepted

- **WHEN** a marker exists on `2026-09-17` and a second is created on the same
  date
- **THEN** both are stored, and the axis cell reports two markers

#### Scenario: overflow collapses to a count

- **WHEN** more markers sit on one date than the band shows at 28px per day
- **THEN** the cell shows a count, and the full list is reachable by hover or tap

### Requirement: Markers are drawn without changing the bar layer

A marker SHALL be drawn as a chip in the axis band anchored to its day. The
chart body SHALL carry **one 1px vertical rule per occupied date**, not one per
marker, drawn **behind** the bars, opaque (see the contrast bar below).

**One per date, because per-marker is not drawable.** Markers sharing a date
share an axis offset, so N per-marker rules would be N coincident 1px lines and
only the last in source order would be visible — the design would specify a
colour it cannot show, and which colour won would be an accident of iteration
order. The rule's colour SHALL therefore be the colour of the **first** marker
on that date in the total order below (`created_at` then `id`), which is the
same marker whose chip the band shows first, so the rule always names a chip
the reader can see. At 4px per day the band shows exactly one chip, and it is
that one.

Lane-splitting the day was the alternative and is rejected on the narrow rung:
a 4px cell has no room for two 1px rules and a gap, so a lane rule would have to
degrade to one-per-date at 4px anyway, and a treatment that is two things at
different zooms is worse than a treatment that is one.

Nothing SHALL be drawn over a bar. Bar fill and the critical-path
`stroke-foreground [stroke-width:2]` SHALL keep full contrast.

**"Fully opaque over it" is false of one bar kind, and the guarantee SHALL be
stated as it actually holds** (round-12 Sol review, Important). An **assumed**
bar carries `[fill-opacity:0.35]` by design (`ASSUMED_BAR_CLASSES`,
`gantt-panel.tsx:706`), so a rule painted behind one shows through it exactly as
the gridlines, zebra band and weekend column beneath it already do. That is the
treatment's purpose and this feature SHALL NOT special-case it: masking the rule
under assumed bars alone would give the marker a paint privilege none of the
five existing marks has. So the guarantee is **geometry and class, plus pixels
over opaque bars**: no bar's `x`, `width`, fill class or critical-path stroke
SHALL change, and an **opaque** bar's pixels SHALL be identical with and without
the marker. Over an assumed bar the rule is visible through the translucency,
and **at least one pixel inside that bar's own footprint SHALL differ** from the
same plan without the marker.

**"Any pixel difference is confined to that footprint" was the vacuous form of
that last sentence** (round-13 Sol review, Important; round-14 Gemini review
caught it surviving here after the scenario and slice were fixed). Zero
differing pixels satisfy it, so a rule masked under assumed bars — the one
failure this sentence exists to forbid — passes it; and read over the whole
chart it rejects the correct renderer, whose rule differs everywhere it is
drawn. The requirement, its scenario and slice 9.2b now all say the same thing:
crop to the footprint and require a difference inside it.

**The rule SHALL be 1px on screen at every rung, and that needs a mechanism
rather than a width** (round-12 Sol review, Important). The chart's SVG user
space is days by rows and is stretched non-uniformly to `dayPx`
(`viewBox` days×rows with `preserveAspectRatio="none"`, `gantt-panel.tsx:3940-3943`),
so a stroke of one user unit is **a day wide** — 28, 12 or 4 CSS pixels across
the ladder. Today's leading edge already carries `vectorEffect="non-scaling-stroke"`
for precisely this reason (`gantt-panel.tsx:2984-2995`). The marker rule SHALL
carry `vector-effect: non-scaling-stroke` and SHALL render one CSS pixel wide at
every rung.

**The proof SHALL NOT be `getComputedStyle().strokeWidth`** (round-13 Gemini
review, Critical). `vector-effect` changes how the stroke is transformed at
rasterization and does not rewrite the computed value of `stroke-width`, so that
reading is `1px` with the property present and with it removed — an oracle no
fault can move. The property SHALL be asserted as an **attribute** in the jsdom
tier and the **painted** width measured at more than one rung in the browser
tier, which is the only tier that rasterizes.

**Nor SHALL the browser proof be the rule element's bounding box** (round-14 Sol
review, Critical). The rule is a vertical `<line>` with `x1 === x2`, and this
repository's own browser fixture records that such a line **has no area and is
reported hidden** (`apps/fe-01/e2e/gantt.spec.ts:415-418`, which opens its chart
on the row labels for exactly that reason). A zero-area box cannot carry a
painted stroke width: the correct renderer does not reliably report `1`, and
removing `vector-effect` does not widen the box, because the stroke is painted
outside the geometry the box measures. The browser proof SHALL therefore be
**paint-aware** — the painted width read off the pixels — at more than one rung.

**That width SHALL be bounded rather than exact** (round-15 Gemini review,
Critical). The rule sits at an integer user coordinate and the chart's
horizontal map is `x * dayPx + CHART_PAD_PX` with all three integers
(`gantt-panel.tsx:590`), so a 1 CSS pixel non-scaling stroke is centred **on** a
pixel boundary and rasterizes at partial coverage into the two columns it
straddles — and nothing in the component sets `shape-rendering` to opt out.
"Exactly one painted column" would therefore fail the correct renderer, which is
the same shape of error as the bounding box it replaced. The requirement is a
hairline against a day: **1 or 2 painted columns**, against the 28 and 4 a
scaling stroke paints — bounded on both sides, since "at most 2" is satisfied by
a rule that never paints at all. Telling 1 CSS pixel from 2 is not this proof's
job; the declared width and the mechanism are the jsdom tier's, and **the
declared width SHALL be asserted there** (round-16 review, Critical) — a
`strokeWidth={2}` rule carrying `non-scaling-stroke` paints two columns at every
rung and would otherwise satisfy every check in this design while violating this
requirement.

**The EFFECTIVE width SHALL be asserted too, in the browser** (round-17 review,
Critical). The presentation attribute is the bottom of the SVG cascade, so an
inline `style={{ strokeWidth: 2 }}` leaves the attribute reading `1`, passes
every jsdom equality, and still paints two columns inside the bound above. The
browser tier SHALL therefore assert a computed `stroke-width` of `1px`. That is
**not** a return to the oracle this section rejects: computed style cannot see
`vector-effect`, which is why it fails as proof of the _mechanism_; it reports
the width the cascade resolved to, in user units, which is the one job it is
admitted for. It is blind to the `viewBox` exactly as the attribute is — a rule
with no `vector-effect` still computes to `1px` while rasterizing a day wide —
so it adds cascade coverage to the attribute equality and nothing else. The
painted columns remain the only assertion that reads the screen.

**Three assertions still do not bound the rule, because two of them read a
queried element rather than the painted one** (round-18 review, Critical). The
rule SHALL therefore be a `<line>` element, asserted as such, and SHALL be
opaque, asserted as such. Without the first, a `<g>` carrying the marker
attribute and a declared width of 1 satisfies both width assertions while the
`<line>` inside it paints at 2. Without the second, a `strokeOpacity` of `0.4`
satisfies all three — a translucent hairline still differs from the baseline in
one or two columns — while violating the opacity requirement below, which had
no scenario of its own until this round.

**"Behind the bars" SHALL NOT be the whole ordering.** The body paints six
marks before any bar, and the marker rule SHALL take one named slot among them:
after the weekend columns (`data-gantt-weekend`), the zebra row bands, the
pointed row's light (`data-gantt-row-lit`), today's tinted column
(`data-gantt-today`), the gridlines (`data-gantt-gridline`) and today's leading
edge (`data-gantt-today-edge`), and before the row hit lines, the dependency
marks and every bar. Paint order in SVG is source order, so the slot is a
position in `marksOverLight` and not a `z-index`.

The rule SHALL carry `pointer-events: none`. A marker's interaction surface is
the axis chip; nothing in the body may take a pointer away from the row hit
lines, which are deliberately not `pointer-events: none` themselves.

A marker on today's date SHALL therefore draw **over** today's leading edge.
Today SHALL remain findable because it is marked twice — a tinted column a whole
day wide as well as the 1px edge — and a 1px rule cannot cover the column. The
reverse order would hide a marker the user had just placed on today, which is
the silent absence this design refuses elsewhere.

At 4px per day the rules SHALL be suppressed when the density defined below
exceeds `MARKER_RULE_MAX_PER_100PX`, leaving the chips alone. That constant
SHALL be **6** and SHALL be named in code with a pixel assertion over it: 100px
holds 25 days at that rung, so six rules is one per ~16px and seven would put
two inside one heavy-gridline week.

**Density SHALL be counted over rule positions, and the window SHALL be the
viewport.** The measure is `occupiedDatesInViewport / viewportWidthPx * 100`,
compared with `>` — strictly exceeding 6 suppresses, exactly 6 draws. Two
things this makes explicit, both of which an earlier draft got wrong by
counting _markers_ over an unnamed window: seven markers on a single date are
one rule position and SHALL NOT suppress anything, and the window is
viewport-normalised rather than a sliding 100px scan, so the answer does not
depend on where the scan starts.

Suppression SHALL apply at the 4px rung only, and the reason is arithmetic
rather than symmetry. At 28px per day a 100px window spans 3.6 days, so it can
hold at most 4 rule positions and the threshold is genuinely **unreachable**. At
12px it spans 8.3 days and can hold **9**, so the threshold _is_ reachable
there — the earlier claim that both wide rungs were unreachable was false — and
suppression is nonetheless withheld, because at 12px nine rules are one per
≥12px and do not smear. The threshold exists to stop 1px lines merging into a
wash, and at 12px they do not merge.

A marker SHALL find its day by locating its `IsoDate` in the rendered
`AxisDay[]`, through the same generalised lookup today uses
(`todayOffset`, `gantt-panel.tsx:872`). A marker SHALL NOT compute its own
offset from a date, and SHALL NOT read `CalendarScale` — that interface takes
a **workday** number and returns a calendar offset, so an absolute date is
already past it.

A date absent from the rendered axis SHALL return no offset and draw nothing.

**The viewport scopes the density measure and nothing else.** An unsuppressed
occupied date SHALL carry its rule whether or not it is scrolled into view: the
chart is one full-width SVG inside an overflow scrollport, and the export clones
it, so a renderer that virtualized rules to the visible interval would drop them
from the downloaded chart while every viewport-scoped count still agreed
(round-11 Sol review, Important). There SHALL therefore be no viewport
virtualization of rule elements, and the guarantee SHALL be proved by an
assertion over the unfiltered horizon rather than by any count the visible
interval bounds.

#### Scenario: the bar layer is untouched at the widest zoom

- **WHEN** a marker is added crossing an existing bar at 28px per day
- **THEN** every bar's `x`, `width` and critical-path stroke are unchanged from
  the same plan without the marker

#### Scenario: the rule sits behind the bars

- **WHEN** a marker's rule crosses a bar
- **THEN** the rule element precedes the bar element in paint order, the bar's
  geometry, fill class and critical-path stroke are unchanged, and an opaque
  bar's pixels are identical with and without the marker

#### Scenario: an assumed bar keeps its deliberate translucency

- **WHEN** a marker's rule crosses an assumed bar
- **THEN** the bar still carries `[fill-opacity:0.35]`, the rule still precedes
  it in paint order, and at least one pixel inside that bar's footprint differs
  from the same plan without the marker

#### Scenario: the rule is an opaque 1px line at every rung of the zoom ladder

- **WHEN** the same marker is rendered at 28px, at 12px and at 4px per day —
  every rung, since a fault conditioned on one of them would otherwise reach no
  rasterized assertion, and the two ends are what make the mechanism visible,
  because one rung alone cannot tell a non-scaling stroke from a width that
  happens to equal that rung's day pixels
- **THEN** its rule is a `<line>` element, declares a stroke width of 1,
  resolves to a computed `stroke-width` of `1px`, computes `stroke-opacity` and
  `opacity` of `1`, carries `vector-effect: non-scaling-stroke`, and the run of
  columns **that element alone** paints — the same clip taken with it visible
  and with it hidden — is 1 or 2 CSS pixels wide at both rungs, a hairline
  rather than the 28 and 4 a scaling stroke would paint
- **AND** the chart body with that element hidden is **pixel-identical** to the
  chart body with no marker at all, so that no second rule primitive — stacked
  on it, abutting it, or drawn in another row band — can supply ink the marker
  is credited with while the assertions read only the tagged one
- **AND** the rule spans the body rather than the sampled band: its `y1` is the
  top of the chart's user space and its `y2` is the bottom
- **AND** the rule's `stroke` resolves to a colour carrying no alpha, and every
  element from the rule up to the chart `<svg>` computes an `opacity` of `1`,
  since neither `stroke-opacity` on the rule nor `opacity` on the rule can see
  an alpha in the colour or an `opacity` on an ancestor

#### Scenario: dense markers drop the rule at the tightest zoom

- **WHEN** the occupied dates within the viewport exceed the density threshold
  at 4px per day
- **THEN** no rules are drawn, and every chip remains

#### Scenario: an off-screen unsuppressed date still carries its rule

- **WHEN** a plan at 4px per day holds occupied dates inside and outside the
  viewport and the density measure is below the threshold
- **THEN** every unsuppressed occupied date in the horizon carries a rule,
  including the dates scrolled out of view

#### Scenario: many markers on one date are one rule position

- **WHEN** seven markers sit on a single date at 4px per day
- **THEN** one rule is drawn in the first marker's colour, the density threshold
  is not reached, and the band shows one chip with `+6`

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

**A chip is a position and a colour, not a name.** On screen the name lives in
the chip's hover list, and at 4px the chip is a coloured tick; a downloaded
file has no pointer and no 4px exemption. So the export SHALL also carry a
**legend**: one row per marker, its swatch, its `date` and its `name`, in the
list's `(date, created_at, id)` order, at every rung. Every marker name SHALL
appear as text in the exported markup. A tooltip mechanism does not satisfy
this — it is the hover answer again, and it is invisible in a printed page or
a rasterised copy, which is what a downloaded chart is for.

The legend SHALL lie wholly inside the exported `viewBox`, which means the
export SHALL grow its canvas to hold it. `buildStandaloneGanttSvg` fixes
`totalHeight` and paints the background to it before anything else is appended
(`gantt-panel.tsx:1755`, `:1762-1764`, `:1771`), so a legend added without that
growth is text that serializes into the file and appears on no page — which is
the same failure as no legend, wearing a passing test.

#### Scenario: a downloaded chart shows chip and rule together

- **WHEN** a plan with two markers is exported below the density threshold
- **THEN** the SVG contains a chip for each at its day's x, in its colour, **one
  rule per occupied date** carrying that date and that colour, and each rule has
  a chip at the same date in the same colour

#### Scenario: a downloaded chart names its markers at every rung

- **WHEN** a plan with two markers is exported at 28px per day and again at 4px
- **THEN** both markers' names appear as text in the exported markup at both
  rungs

#### Scenario: the legend is readable rather than merely present

- **WHEN** a plan with two markers is exported
- **THEN** the legend carries one row per marker in `(date, created_at, id)`
  order, each row carrying that marker's swatch colour and its `date` beside
  its `name`, and the last row lies wholly inside the exported `viewBox`

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

Storage MAY hold no colour, meaning "automatic", but the API SHALL NOT return
one: every marker in every response SHALL carry a resolved colour, the stored
one where there is one and the automatic one where there is not. A client is
never asked to know the palette, and the two rules above are observable through
the API only because of this.

A user-chosen colour SHALL override the automatic one and SHALL be rejected if
it fails the contrast bar against **any** backdrop it is drawn on. The bar is
two numbers, because a marker is two things:

- **3:1** for the chip fill and the body rule against what is behind them —
  WCAG 1.4.11, the non-text bar, which is what these are.
- **4.5:1** for the chip's label text against the chip fill — WCAG 1.4.3.

**The body rule SHALL be opaque**, and that settles the rule's own colour: a
rule at some reduced opacity is a _different_ colour once composited, and the
opacity was never given a number (round-4 Sol review). Opaque costs nothing the
design wanted — the rule is 1px and already sits behind every bar, so its width
and its paint slot supply the de-emphasis the opacity was for. The chip fill was
always opaque.

**Opacity was only half of it, and the backdrop is the other half.** An opaque
rule still crosses four area fills — the weekend column, the zebra band, the
pointed row's light and today's tint — and a hex clearing 3:1 against the base
background does not thereby clear it over any of those (round-5 Sol review).
Three of the four are translucent tints; **the pointed row's light is opaque**,
a `color-mix(in oklab, var(--ring) 20%, var(--background))` over two opaque
inputs, so it replaces what is beneath it rather than compositing over it. Paint
order is weekend, zebra, pointed, today, so the rule's backdrop set SHALL be the
**8** composites of the three tints over `--background` plus the **2** in which
the pointed light stands as its own surface under the optional today tint —
**10 per theme, 20 in all** — and every palette entry and every accepted custom
colour SHALL clear 3:1 against all of them. Gridlines and today's leading edge are excluded
by name: both are 1px strokes at a single `x` which the 1px rule covers exactly,
so what a reader compares the rule against is the area fill beside it. The
chip's backdrop set is base and base-over-weekend — **2 per theme, 4 in all**:
the chip sits in the HTML axis band, which paints `bg-muted-foreground/10` on a
weekend cell and gives today an ink change with no background, so none of the
body SVG's four fills is ever behind a chip.

A refusal SHALL name the **backdrop** it failed and not merely the theme, since
a colour can clear the bare dark background and fail dark-over-weekend, and a
message naming only "dark" sends the user hunting a fill it never named.

**The validator SHALL measure against every entry of that set, and that is a
separate claim from the set being complete** (round-11 Sol review, Important). A
validator holding the whole table and measuring only the surfaces its test cases
name accepts a colour that fails over any of the other 18, so the guarantee SHALL
be proved by a refusal over a backdrop no other case exercises — the two the
pointed light contributes as its own opaque surface are the entries a validator
that composites tints over `--background` and stops there never builds at all.

**The label ink SHALL be black or white, whichever contrasts more with the chip
fill**, and that choice SHALL be a **total function with no refusal arm**.
Without a named ink algorithm the server could not check a text bar from a fill
colour at all — it does not know what the text will be painted in — but once the
algorithm is named, the 4.5:1 bar is satisfied by every opaque fill and cannot
be failed.

The proof is one line of WCAG arithmetic. Contrast is
`(L1 + 0.05) / (L2 + 0.05)`; black has relative luminance 0 and white 1, so a
fill of luminance `L` scores `(L + 0.05) / 0.05` against black and
`1.05 / (L + 0.05)` against white. **Their product is exactly 21 for every `L`**,
so the larger is never below `sqrt(21) ≈ 4.583` — above 4.5, at the worst case
`L ≈ 0.179` where the two are equal. An earlier draft required a refusal "when
neither black nor white reaches 4.5:1"; no such fill exists, so that arm could
never run and its negative could never fail (round-5 Sol review, Important 7).
The contract is therefore: pick the better ink, record it, and assert in test
that the chosen ink clears 4.5:1 — the 3:1 fill bar remains the only one a
custom colour can fail.

The check SHALL run at submit, in be-01, not only in the composer. A colour
refused only by the UI is refused only for clients that ask nicely. The
composer SHALL run it too, before it sends anything: the server refusal is the
guarantee, and the composer's is the one that tells the user which backdrop
failed while the colour is still in front of them.

#### Scenario: the API refuses what the composer would have refused

- **WHEN** a custom colour below 3:1 against some dark backdrop is posted
  directly to the API, bypassing the composer
- **THEN** the write is refused and no row is written

#### Scenario: the composer does not send a colour it can already refuse

- **WHEN** a custom colour below 3:1 against some dark backdrop is entered in
  the composer and submit is pressed
- **THEN** no create request is sent and the refusal names the failing backdrop

#### Scenario: the label ink is chosen, not fixed

- **WHEN** the ink is taken for the palette's lightest fill and for its darkest
- **THEN** the two answers differ, each is the one of black and white with the
  higher contrast against that fill, and each clears 4.5:1

#### Scenario: the chip paints the ink that was chosen

- **WHEN** a marker whose colour is a light palette entry is drawn in the axis
  band
- **THEN** its label is painted in the ink the chooser returns for that fill

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

- **WHEN** a custom colour below the contrast bar over some backdrop is
  submitted — one below it on the bare dark background, one clearing every bare
  background and failing only over a composite, and one clearing 19 of the 20
  backdrops and failing only over the light pointed-row light under the today
  tint
- **THEN** no marker is written and the composer names the failing backdrop in
  each case

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

**Every mutating route SHALL carry that scope independently, and `DELETE` is the
one that does not share a route with the others.** Rename and recolour are two
bodies through one `PATCH`, so scoping the patch scopes both; the delete is its
own route with its own predicate, and a delete matched on marker id alone
removes another project's row through this project's route while every
rename-based isolation case still passes (round-11 Sol review, Important). The
delete's predicate SHALL name the project as well as the marker.

A marker SHALL NOT be addressable as a work item. The guarantee is that the two
**route families are disjoint**, not that the two id spaces are: a marker route
SHALL read and write only the marker table, and a work-item route SHALL read and
write only the work-item tables. Creating a marker SHALL add no `work_item` row.
The disjointness SHALL be verified as a **reach** — no SQL statement issued by
any marker route names `work_item` — and not as a source-level import check on
the marker repository, which a read placed in the handler satisfies while
reading the table anyway (round-5 Sol review).

The id-space form of this rule was rejected as unsatisfiable, and the reason is
worth keeping (round-4 Sol review). Marker and work-item ids are independent text
primary keys and the client supplies the marker id, so a client may legitimately
submit a string equal to an existing work item's id — at which point "no marker
id resolves through the work-item routes" is false by construction, and a test
using distinct fixture ids passes only because no row anywhere holds the id it
asks for. Disjointness would have to be enforced by a shared allocator or a
cross-table check on every write, which buys nothing: the harm the rule guards
against is a marker reaching work-item code, and route disjointness forbids that
directly.

The client-supplied marker id SHALL be a syntactically valid UUID v4 and SHALL
be refused otherwise, with no row written.

The list SHALL be **totally** ordered, by `(date, created_at, id)`. `(date,
created_at)` alone ties for two markers created inside the same millisecond, and
a tie leaves the order free to change between reads of unchanged data.

Edit and delete SHALL follow the project's existing write permission. No
per-marker role SHALL be introduced.

A create or update that is refused SHALL answer with the project's refusal
envelope, naming which field failed and why, and SHALL NOT partially apply:
after a refused rename the marker SHALL still carry its old name.

**"The project's existing refusal shape" is not one shape**, so each failure
SHALL name its own code, status, field and reason. `statusForRefusal(reason,
otherwise)` (`refusal-status.ts:22-47`) shares four arms across every route and
takes each route's **own default** as its second argument — a malformed step
body is 422, an unparseable batch 400, an undo of an empty stack 409, a patch of
an absent project 404 — so a marker route that said only "the existing shape"
would have specified nothing (round-4 Sol review). The marker routes' default
SHALL be **422**, the malformed-body answer:

| failure                                    | reason      | status | field   |
| ------------------------------------------ | ----------- | ------ | ------- |
| `date` is not an `IsoDate`                 | `malformed` | 422    | `date`  |
| `id` is not a UUID v4                      | `malformed` | 422    | `id`    |
| `color` is not a hex triple                | `malformed` | 422    | `color` |
| `name` is empty or over `MARKER_NAME_MAX`  | `malformed` | 422    | `name`  |
| `color` fails the 3:1 contrast bar         | `contrast`  | 422    | `color` |
| `id` already exists                        | `taken`     | 409    | `id`    |
| the marker is absent, or another project's | `not_found` | 404    | `id`    |
| the caller may not write the project       | `forbidden` | 403    | —       |

`MARKER_NAME_MAX` SHALL be **120** characters, counted in Unicode code points
rather than UTF-16 units so an emoji costs one. 120 rather than 255 because the
name is drawn in a chip in an axis cell and read in a hover list, never in a
paragraph — it is a label, and a cap that admits a sentence invites one. Empty
is refused by the same row: the minimum is 1.

Every row SHALL answer with **exactly** the code, status and field its row
gives. `forbidden` is the one row whose `field` is absent, and that absence is
part of the contract rather than an omission: the refusal is about the caller,
not about a field of the body.

`taken` reaches 409 through the shared `CONFLICTS` set, `not_found` through the
shared 404 arm and `forbidden` through the shared 403 arm; only `malformed` and
`contrast` fall through to the route default, which is why the default has to be
stated. A marker of another project answers `not_found` rather than `forbidden`
— the caller may not learn it exists.

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

#### Scenario: a delete cannot reach across projects

- **WHEN** a delete on one project names a marker belonging to another project
- **THEN** it is refused as `not_found`, that marker's row survives, and the
  deleting project's own markers are unchanged

#### Scenario: the marker routes touch no work-item row

- **WHEN** a marker is created, renamed, recoloured and deleted
- **THEN** the `work_item` row count and contents are unchanged throughout, and
  the marker routes issue no query against a work-item table

#### Scenario: a malformed marker id is refused with no row written

- **WHEN** a create supplies an `id` that is not a valid UUID v4
- **THEN** it is refused naming the `id` field, and the marker count is unchanged

#### Scenario: same-millisecond markers keep one order

- **WHEN** two markers on one date are created against a fixed clock so their
  `created_at` values are equal, and the list is read twice
- **THEN** both reads return them in the same order, decided by id

#### Scenario: a refused rename changes nothing

- **WHEN** a rename is submitted with an empty name
- **THEN** it is refused with the field named, and the marker still carries its
  previous name
