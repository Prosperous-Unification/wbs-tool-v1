# Design — Gantt calendar markers

Written because the shape is not obvious in three places: the chart has two
axes and only one of them has dates, the overlay has to survive a 7× zoom
range, and "this cannot affect the schedule" has to be structural rather than
a rule someone remembers.

Read with `proposal.md` and `specs/wbs-domain/spec.md`. Rationale that belongs
in an ADR is linked, not restated.

## 1. The undated plan — the decision that shapes everything else

`gantt-panel.tsx:2713` picks the axis:

```
startDate === null ? workdayAxis(placed.horizon) : calendarAxis(startDate, placed.horizon)
```

`workdayAxis` sets `date: null` on every cell, and the `<span>` at `:3871` (its `data-axis-date` spread is `:3879`)
emits `data-axis-date` **only** when `day.date !== null`. So the DOM already
states the fact this feature turns on: a cell either is a date or is not one.

Three options were real:

| option                                            | why not                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hide** the marker affordance on an undated plan | The user sees no difference between "not supported here" and "not implemented". Silent absence is the least debuggable failure this product has.                                                 |
| **Synthesise** a date from the workday number     | Requires inventing a project start date. The stored date would then be a date the axis can never show back, and every later dated render would move it. This is R5's "default the unknown away". |
| **Refuse, with a reason** ✔                       | The click lands, nothing is written, and the message names the missing project start date — which is also the fix.                                                                               |

**Chosen: refuse with a reason.** The refusal is a product statement, not an
error path, so it is a message on the cell surface and not a thrown exception.

This is hard to reverse (it defines what a marker's date _means_), surprising
(a visible-but-refused control is not the default UI instinct), and had real
alternatives — so it gets an ADR, filed by tasks slice 1. Do not restate the
table above in it; the ADR carries the decision and this file carries the
implementation shape.

**Guard against the silent regression:** a future change that gave every
project a start date would make this branch unreachable and the refusal
untestable. The negative test therefore asserts on `workdayAxis` output
directly, not only through the panel.

## 2. Layers — why the rule goes behind the bars

Today and weekend are **axis and grid** (`gantt-panel.tsx:2968`, the day rule
drawn `stroke-border` when heavy and `stroke-border/40` otherwise). Critical
path is on the **bars** (`barClasses` at `:725`, applied at `:3335`). They are
different layers,
so a marker confined to the header band contends with today and weekend only.

Drawing a rule down the body is what makes a marker useful — it is how a
reader sees which bars cross the date — and it is also what puts the marker
into the bar layer's argument. Painting the rule **behind** the bars settles
that argument: nothing is drawn over a bar, so bar fill
and the critical-path stroke keep full contrast, and the rule stays legible in
the gaps between bars, which is where a date is actually traced. Paint order is
the whole mechanism; there is no z-index to tune.

It settles the argument with the **bars**, and only with them. §2.1 is the rest
of the ordering, which "behind the bars" leaves open.

**Consequence for the existing tests:** at 28px per day no bar coordinate or
class changes, so the panel's existing pixel assertions stay green. A marker
test that had to edit one of them would mean the layering was wrong.

### 2.1 "Behind the bars" is not a slot — this is

**Corrected after the Sol planning review.** "Behind the bars" orders the marker
against one of the things the body paints and leaves the rest undecided. The
body's marks are emitted in source order across two memos, `marksUnderLight`
(`gantt-panel.tsx:2868`) and `marksOverLight` (`:2927`), with the pointed row's
light between them at `:3983`; paint order in SVG **is** source order, so the
slot is a line number and nothing else:

| #     | mark                             | attribute                    | where                          |
| ----- | -------------------------------- | ---------------------------- | ------------------------------ |
| 1     | weekend columns                  | `data-gantt-weekend`         | `gantt-panel.tsx:2883`, under  |
| 2     | zebra row bands                  | `data-gantt-band`            | `:2903`, under                 |
| 3     | the pointed row's light          | `data-gantt-row-lit`         | `:3983`, between the two memos |
| 4     | today's tinted column            | `data-gantt-today`           | `:2950`, over                  |
| 5     | gridlines                        | `data-gantt-gridline`        | `:2968`, over                  |
| 6     | today's leading edge             | `data-gantt-today-edge`      | `:2993`, over                  |
| **7** | **the marker rule**              | **`data-gantt-marker-rule`** | **new, immediately after 6**   |
| 8     | row hit lines                    | `data-gantt-row-line`        | `:3032`                        |
| 9     | capacity links, brackets, carets | `data-gantt-capacity-link`   | `:3238` and neighbours         |
| 10    | bar rectangles                   | `data-gantt-bar`             | `:3283`, `barClasses` `:3335`  |
| 11    | priority caps                    | `data-priority-cap`          | `:3472`, **after** the bars    |
| 12    | zero-duration ticks              | `data-gantt-tick`            | `:3509`, after the caps        |
| 13    | on-bar labels                    | `data-gantt-bar-label`       | `:3591`, last                  |

**Rows 2, 3 and 8–13 were wrong until the round-4 Sol review and are now read
off the source, not off a docstring.** The zebra bands carry
`data-gantt-band` at `:2903` (the table said "—" at `:2898`); the pointed row's
light is at `:3983`; the row hit lines carry `data-gantt-row-line` at `:3032`;
and — the one that matters for a "behind the bars" claim — **the bars are not
last**. The rectangles land at `:3283`, and priority caps (`:3472`),
zero-duration ticks (`:3509`) and on-bar labels (`:3591`) all paint _after_
them. `:3511` was cited as the bars' own line; it is inside the tick block.

Rows 4–13 follow `marksOverLight`'s docstring (`:2915-2918`) — _"today's column
and edge, the gridlines, the row lines, the brackets and ticks, the dependency
and hand-off lines, the not-before carets and the bars"_ — but the docstring
stops at "the bars" and the code does not, which is exactly how "bars last" got
into this table. The marker rule precedes **every** family from 8 down, so
nothing in the bar layer or above it is affected by the new slot.

**The rule needs no pointer behaviour of its own.** It sits at 7, under the row
hit lines at 8, whose own docstring explains that they are deliberately not
`pointer-events: none` because a surface under them would be dead in stripes.
Nothing above the rule is removed and nothing below it is exposed, so row
pointing is unchanged — and the rule carries `pointer-events: none` regardless,
because the interaction surface for a marker is the axis chip and never the
decoration in the body.

**Over the today edge, not under it.** A marker on today has to be visible: the
user just placed it, and §1 names silent absence as the least debuggable failure
this product has. Drawing it under a `stroke-sky-500` hairline of the same
offset would hide it exactly there. The reverse costs nothing, because **today
is marked twice** — a full-day tinted column (`fill-sky-500/15`) plus the 1px
edge — and a 1px marker rule cannot cover a column a whole day wide. So today
stays findable and the marker is visible, which is not true the other way round.

**Over the weekend columns for the same reason and for free:** the weekend band
is a fill drawn first, at position 1, so anything after it is over it already.

**Under the bars, which is the requirement §2 argues.** Slots 8, 9 and 10 are
untouched, so no bar coordinate, fill or critical-path stroke changes.

## 3. The zoom ladder is the binding constraint on labels

`gantt-panel.tsx:69-72` gives three rungs: **28 / 12 / 4** px per day — about
13, 30 and 91 days on a 390px phone. `AXIS_NUMBER_PX` is **14**, and
`axisNumberShown` prints a cell's own number only when `dayPx >= 14` or the
cell is `heavy`.

So at two of the three rungs a day cell cannot hold text at all. **Any
treatment that puts the marker's name in the day cell disappears on a phone
showing a quarter.** The name therefore lives in the chip's hover/tap list at
every rung; the chip itself degrades to a coloured tick at 4px.

**Density.** At 4px, many rules become a smear. The threshold is a named
constant — `MARKER_RULE_MAX_PER_100PX = 6` — checked against
`occupiedDatesInViewport / viewportWidthPx * 100` with `>`, and **above** it the
rules are dropped and the chips kept (treatment A as the 4-rung fallback). A
named constant with a pixel assertion is testable; "looks busy" is not.

Two corrections the round-4 Sol review forced, both of which followed from
counting the wrong thing. **The count is rule positions, not markers.** The body
draws one rule per _occupied date_, in the colour of that date's **first**
marker by `(created_at, id)` — per-marker rules on a shared date would be
coincident, so which colour survived would be an accident of iteration order,
which is why the first is named — so seven markers on one date are one rule and
must not trip a
threshold about smear. And **the window is the viewport, normalised to 100px**,
not a sliding scan — a sliding window's answer depends on where it starts.
Suppression runs at the 4px rung only: at 28px a 100px window spans 3.6 days
and holds at most 4 rules, so the threshold is unreachable; at 12px it spans
8.3 days and holds up to 9, so it _is_ reachable — the earlier "unreachable at
both wider rungs" was arithmetic that had not been done — and suppression is
withheld there deliberately, because nine rules at one per ≥12px are separate
lines, not a wash.

**A second constant, for the band rather than the body.**
`MARKER_BAND_MAX_PER_CELL` is how many chips one axis cell shows before it
collapses to `+N`: **3** at 28px, **2** at 12px, **1** at 4px. It is a ladder
and not one number because a four-pixel cell cannot hold three chips, so any
single value is wrong at one end of the zoom range. `MARKER_RULE_MAX_PER_100PX`
governs the rules down the body and is a different question with a different
answer.

**Why 6 — and it is an AVERAGE density, not a minimum separation.** 100px holds
25 days at the 4px rung, so six rules across it average one per ~16px, about the
spacing the gridline's own heavy/light ladder reads at. **Six occupied dates may
still be consecutive and 4px apart**, and the threshold does not forbid that
(round-5 Sol review, Important 5, which was right that the earlier wording read
as a guaranteed four clear days between neighbours — it is not one). The
threshold is a product judgement about how much ink the body carries before the
rules stop reading as separate marks, expressed as the density measure below so
it is testable at all; it is not an invariant about any pair. A local
minimum-separation rule would be a different mechanism — a sliding window over
adjacent positions — and is deliberately not what this is, because the failure
being avoided is a wash across the chart rather than two lines touching. Suppression is scoped to the **4px rung only**. At 28px a 100px
window spans 3.6 days and holds at most four rule positions, so the threshold is
unreachable by construction. At 12px it spans 8.3 days and holds up to **nine**,
so it _is_ reachable — an earlier draft said 8 and called it unreachable, which
was arithmetic that had not been done — and suppression is withheld there
deliberately, because nine rules at one per ≥12px are separate lines rather than
a wash. The rung scope is the code's one condition; reachability is not.

## 4. Geometry — the seam is `todayOffset`, not `CalendarScale`

**Corrected after the Sol planning review.** An earlier draft of this section
said a marker's x comes from `CalendarScale`. It cannot: `CalendarScale` is
`{ startOf, endOf }`, both `(workday: number) => number`
(`gantt-geometry.ts:864-880`) — **workday offsets in, calendar-day offsets
out**. A marker's date is already on the output side of that conversion, so
there is nothing for it to feed in.

The right seam is the one `todayOffset` (`gantt-panel.tsx:872`) already is,
and its own docstring states this design rule for us:

> **Read off the axis rather than computed a second time** … the gridlines,
> the weekend bands and the day cells are all `axis[k].offset`, so a marker
> that looks its own offset up in the same array cannot drift from the lines
> it is drawn between. A parallel `calendarDaysBetween(origin, today)` would
> be a second scale agreeing with the first only for as long as nobody touched
> either.

So: a marker finds its `offset` by locating its `IsoDate` in the rendered
`AxisDay[]`, exactly as today does. `todayOffset` is generalised to
`axisOffsetOf(axis, date)` and today becomes its first caller, so there is one
lookup rather than two that can disagree. A date not present in the axis
returns null and draws nothing, which is also the out-of-horizon behaviour the
spec requires — one mechanism, not two.

The principle survives the correction intact and is the same one
`gantt-calendar-axis` was written to enforce: **a marker must not compute its
own offset.** Only the named seam changes.

## 5. Persistence, modelled on `saved_plan`

`saved_plan` (migration `20260903190000`) is the current template for a
project-scoped child table, and the parts that transfer are the parts that are
about the blue/green swap rather than tidiness:

- `projectId: text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' })`.
  The cascade is load-bearing: the outgoing release knows nothing of this
  table, and its plain `DELETE FROM project` must not hit a constraint it
  cannot see and answer 500 for the length of the swap.
- Additive forward migration only. Nothing existing is altered; no row is
  rewritten.
- The stamp must be numerically later than every folder on main.
  `duplicateMigrationStamps` in `migrate-down.ts` is the mechanical check — a
  colliding stamp silently reverses nothing.

Shape:

```
calendar_marker(
  id            text primary key,
  project_id    text not null references project(id) on delete cascade,
  date          text not null,          -- IsoDate, no time component
  name          text not null,
  color         text,                   -- null = automatic, derived from id
  created_at    integer not null
)
index calendar_marker_project_date on calendar_marker(project_id, date)
```

`color` is **nullable and means "automatic"**, rather than materialising the
derived value at insert. Materialising would freeze today's palette into
storage: a palette change would then have to migrate rows, and a marker whose
colour was never chosen would be indistinguishable from one that was.

**Nullable in the column, never null in the response.** The nullability stops
at the repository: every route in the table below resolves it on the way out,
`color: row.color ?? automaticColor(row.id)`, so `spec.md`'s "a marker SHALL
consist of a project, an `IsoDate`, a name, and a colour" holds for every
marker the API returns and no client has to know the palette. This was implied
rather than stated, and it is load-bearing twice over: it is what makes 3.1's
two caller-injected faults observable through the API at all — a response that
returned `null` would leave the rename-stability and same-date-distinctness
cases nothing to read (round-7 Gemini review, Minor 2).

`date` is `text`, matching how the rest of the schema stores an `IsoDate`, and
is indexed with `project_id` because "this project's markers, by date" is the
only read.

**The routes**, project-scoped like the rest of be-01's project surface:

| verb     | path                                           | body                          | answers                                                 |
| -------- | ---------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `GET`    | `/api/projects/:id/calendar-markers`           | —                             | the project's markers, ordered `(date, created_at, id)` |
| `POST`   | `/api/projects/:id/calendar-markers`           | `{ id?, date, name, color? }` | the created marker                                      |
| `PATCH`  | `/api/projects/:id/calendar-markers/:markerId` | `{ name?, color? }`           | the updated marker                                      |
| `DELETE` | `/api/projects/:id/calendar-markers/:markerId` | —                             | no content                                              |

**The first parameter is `:id`, not the `:projectId` that would read better**,
and this is a startup crash rather than a style point (Gemini round-5 Critical
3, verified). `memoirist` keys a path parameter **by position**;
`projectController` already registered `/api/projects/:id`, so a second name at
that position throws at `composeGeneralHandler` when the app builds. It is the
same constraint `saved-plan.controller.ts:137-143` records for
`/projects/:id/saved-plans`, and `work-item.controller.ts:827` follows it too.
The name is the router's to choose; only the JSDoc can say which id it is.

Rename and recolour are one `PATCH` rather than two verbs: they are the same
row's two mutable fields, and a `PATCH` that carried both would otherwise have
no route. `id` is optional on create (§6.1) and `color` is optional throughout,
`null` meaning automatic (above). Refusals take the project surface's refusal
envelope with a **typed 4xx**, never a throw: an inbound body is untrusted data
at the boundary, and answering a malformed date with a 500 blames the server for
the client's mistake. **The status is per-failure, not per-surface** —
`statusForRefusal(reason, otherwise)` (`refusal-status.ts:22-47`) shares only
four arms and takes each route's own default as its second argument, so "the
existing shape" names nothing on its own. The eight-row code/status/field table
is in the spec's write requirement; the marker routes' `otherwise` is **422**.

`id` is a v4 UUID **supplied by the composer** — see §6.1 for why, and for the
`clock.newId()` fallback that keeps every other caller of the port unchanged. It
also gives the list a total order: `(date, created_at)` is not one, because two
markers created inside the same millisecond tie and the list would then be free
to swap them between renders. The read is ordered `(date, created_at, id)`.

## 6. Colour determinism

Automatic colour is `palette[hash(marker.id) mod palette.length]` over a fixed
accessible palette. **From the id, not from insertion order or count** —
order-derived colour changes every earlier marker when one is deleted, which
is a visible bug with no error message.

No deterministic entity palette exists in the repo today (`libs/domain` and the
WBS components have only UI chrome and theming), so the palette is new work
and needs its own contrast evidence against every backdrop enumerated below.

**The bar is two numbers, not an adjective.** A marker is two things at once,
so it clears two WCAG thresholds: **3:1** for the chip fill and the body rule
against the chart background (1.4.11, the non-text bar these are), and
**4.5:1** for the chip's label text against its own fill (1.4.3). The palette
is eight named entries so a test can iterate it; "a fixed accessible palette"
is not something an assertion can count.

**The backgrounds are named, not "both themes" — and there are more than two.**
The base is `--background` in `apps/fe-01/src/styles.css` — `oklch(1 0 0)` at
`:100` for light and `oklch(0.129 0.042 264.695)` at `:131` for dark. The test
reads those two values, so a theme change that broke the palette breaks the
test rather than the chart.

**But the body rule is not drawn on `--background`.** It sits at slot 7 of
§2.1's paint order, over four **area fills** that the base background alone
does not account for (round-5 Sol review, Important 8 — making the rule opaque
closed the alpha question and left this one, and the document read as if it had
closed both):

| fill              | class                      | attribute              | class line |
| ----------------- | -------------------------- | ---------------------- | ---------- |
| weekend column    | `fill-muted-foreground/10` | `gantt-panel.tsx:2883` | `:2888`    |
| zebra row band    | `fill-muted/40`            | `:2903`                | `:2908`    |
| pointed row light | `fill-(--grid-dep-lit)`    | `:3983`                | `:3988`    |
| today's column    | `fill-sky-500/15`          | `:2950`                | `:2955`    |

**Three of the four are translucent tints; the pointed row's light is not.**
`--grid-dep-lit` is `color-mix(in oklab, var(--ring) 20%, var(--background))`
(`styles.css:259`, class at `gantt-panel.tsx:3988`) over two opaque inputs
(`--ring` at `styles.css:118` light, `:149` dark), so it is an **opaque** colour that already resolves per theme — it
_replaces_ what is under it rather than compositing over it. That changes the
count, and the first draft of this section got it wrong by treating all four as
tints.

The four can co-occur at one `(x, row)` — today can fall on a Saturday, any row
can be pointed, every other row is banded — and paint order is weekend, zebra,
pointed, today. So:

- **pointed row absent:** base, then optional weekend, zebra and today tints —
  2 × 2 × 2 = **8** composites.
- **pointed row present:** its opaque light erases the weekend and zebra beneath
  it, leaving only the optional today tint on top — **2** composites.

**10 backdrops per theme, 20 in all — not 2, and not the 16/32 this section
first claimed.** The 3:1 bar is measured against every one of them.

**Gridlines (slot 5) and today's leading edge (slot 6) are deliberately
excluded, and this is the exclusion rather than an omission.** Both are 1px
strokes at a single `x`, not area fills. The marker rule is itself 1px at that
same `x` and paints after them, so it covers such a stroke exactly; what a
reader's eye compares the rule against is the pixels _beside_ it, and those are
area fills. A rule sharing a gridline's `x` is therefore a legibility question
already answered by the four rows above.

**Whether 20 backdrops is satisfiable is a measurement, not a promise.** Three
of the fills are low-alpha tints, so a palette entry clearing 3:1 against the
base will very likely clear it against those composites — and "very likely" is
the adjective this section refuses, which is doubly true of the pointed row's
light, an opaque 20% mix toward `--ring` that is a genuinely different surface.
Slice 3.2 measures all 20 and records them;
an entry that fails one is replaced before it lands. The alternative considered
and rejected was a background-coloured **casing** under the rule — a 3px stroke
in `--background` beneath the 1px marker stroke, which would make the base the
only backdrop by construction. It is rejected because at the 4px rung a 3px
casing consumes most of a day cell, erasing the weekend and today shading a
reader navigates by, to buy an assurance the measurement gives for free.

**The chip's own bar is measured against fewer — two, not four.** The chip sits
in the **HTML** axis header band, not the body SVG, so none of the body's four
fills is behind it. The header cell paints exactly one background of its own:
`bg-muted-foreground/10` on a weekend (`gantt-panel.tsx:3910`). Today gets
`font-semibold text-sky-600` there (`:3915`) and **no background at all** — the
`fill-sky-500/15` tint is a `<rect>` in the body SVG (`:2955`) and cannot sit
behind a header chip. So the chip's backdrop set is base and base-over-weekend:
**2 per theme, 4 in all.** An earlier draft of this section counted today into
it and got 4 per theme (round-6 Sol review, Important 6). Giving the header its
own today background would be a new visual treatment and is deliberately not
proposed here.

**The hash is named too:** 32-bit **FNV-1a** over the id's UTF-8 bytes, taken
`mod 8`. Any stable function would satisfy "deterministic", which is why naming
one is what makes the pinned vectors of slice 3.1 reproducible at all — two
implementations of "some hash" produce two different correct-looking tables.

**The eight hex values are deliberately not fixed here.** They are the
deliverable of slice **3.2**, which must land them as a literal in
`marker-color.ts` and record them, with their measured ratios against all 20
backdrops above, in `verify.md`. Writing eight unmeasured hexes into a design
document would be asserting an accessibility result nobody had computed —
exactly the adjective this section refuses, one level down. Slice 3.1's four
pinned vectors are then computed **from that landed palette and that hash** and
recorded as data; they cannot be written before 3.2, which is why 3.2 now runs
first.

A custom colour is validated against **the 3:1 bar over every backdrop
enumerated above**, **at submit, in be-01**, and refused with the failing
backdrop and ratio named — the backdrop rather than the theme, because a colour
can clear bare dark and fail dark-over-weekend. **The 4.5:1 label bar is not a
refusal**, because nothing can fail it: the ink is black or white, whichever
contrasts more, and the two contrasts multiply to exactly 21 for every fill, so
the better is never below `sqrt(21)`. It is asserted as a property of the ink
function, not enforced as a rejection. Validating in the
composer alone refuses the colour only for clients that ask nicely; validating
at render instead would leave an unreadable marker stored and blame the
reader's theme. So the validator has **three** call sites — the create handler,
the recolour handler and the composer — and task 3.4 gives each one its own
injected fault, because two of them being wired proves nothing about the third.

### 6.1 The id has to exist before the colour does — so the client issues it

**Raised by the Sol planning review, and it is a real ordering problem.** The
brief's flow is _"enter a name, accept an automatically assigned colour or
choose one"_, so the composer shows a colour **before submit**. But the
automatic colour is `palette[hash(id) mod 8]`, and the house pattern issues ids
at backend write time. `newId` is a port on `Clock`, declared at `clock.ts:34`
and defaulted to `crypto.randomUUID()` at `:47`; `directory.service.ts:203,313`
reach it as `this.clock.newId()`. `SavedPlanService` is **not** a `Clock` caller
and is not an example of this port — it declares its own
`SavedPlanServiceOptions.newId: () => string` (`saved-plan.service.ts:288-294`)
and calls `this.opts.newId()` at `:681`. Two rounds of review corrected this
citation; it is left spelled out so a third does not have to. At composer time there is no id, so there is
nothing to hash and the swatch would be a guess the create could contradict.

Four options were real:

| option                                                                        | why not                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Preview nothing** — the swatch is a neutral "automatic" token until created | Honest, and the cheapest. But it deletes the half of Dany's flow that says _accept_ an assigned colour: the first sight of the hue is after submit, when accepting or rejecting it costs a second round trip. |
| **Server-reserved id** — a reservation call when the composer opens           | A new endpoint, a round trip on every day click including the many that are changes of mind, and an orphan-reservation lifecycle to own. New surface bought with nothing.                                     |
| **Hash something the client already knows** — `(projectId, date, name)`       | A rename would recolour the marker, which is a visible surprise with no error message, and it makes colour carry content rather than identity — the thing §6 rejects order-derived colour for.                |
| **Client-issued id** ✔                                                        | The composer generates the `id`, so `automaticColor(id)` is exact before submit and provably equal to the created marker's colour.                                                                            |

**Chosen: the composer issues the id.** The create body carries `id`, and
`clock.newId()` stays the fallback for a body that omits one, so the port and
every other caller are untouched. Two consequences that are requirements, not
notes:

- **A colliding id is refused, not merged.** The primary key conflict answers a
  refusal with no row written, and the composer retries with a fresh id. Ids are
  v4 UUIDs, so a collision is a bug or an attack and never traffic.
- **The proof is that the preview and the creation agree, and it takes two
  slices.** The client half is 3.5: the swatch rendered before submit equals the
  colour of the chip rendered after, faulted by the composer generating a fresh
  UUID at submit. The server half is 4.4: a create carrying an `id` stores that
  exact id, faulted by **the server ignoring the supplied `id` and calling
  `clock.newId()`**. This document named only the server fault while 3.5 requires
  a front-end one, so the server fault was owed by neither slice until round 12
  (Sol review, Minor); it is now 4.4's, named there. Without both, the assertion
  passes against a composer that previews the right colour by luck one time in
  eight.

### 6.2 The click surface is a control, so it has a control's contract

**Raised by the Sol planning review.** §1 makes a dated axis cell clickable, and
that cell is the existing `<span>` at `gantt-panel.tsx:3871` (`:3879` is its
`data-axis-date` spread, not the element — §1 above already cites it that way,
and this line said `:3879` for the element until the round-7 self-check). It is
a `<span>`
because until now it was **hover-only** — hover needs no role, no tab stop and
no key handler, and a click does. Adding `onClick` to it without the rest ships
a control no keyboard reaches, which fails WCAG 2.1.1 and hides the whole
feature from anyone not using a pointer.

The contract, on the dated cell only:

- `role="button"` and `tabIndex={0}`, so it is focusable and announced as a
  control.
- **Enter and Space** both open the day sheet, matching the native button
  behaviour the role now promises.
- An accessible name that **names the date**, not the cell — `aria-label` of the
  form `Markers on Wednesday 19 August 2026`, with the count when markers exist.
  A row of tab stops all announced "button" is a worse experience than no tab
  stop at all.
- A visible focus ring — **an authored one that replaces a default the cell
  does have.** This app never imports Tailwind's preflight (`styles.css:52-53`
  imports `theme.css` and `utilities.css` and nothing else) and its scoped
  reset touches `outline` only inside `[data-grid]` (`:912-917`), so the moment
  the span takes `tabIndex={0}` Chromium gives it a user-agent outline. The
  ring follows the house pattern — `focus-visible:outline-none` plus
  `focus-visible:ring-*` (`button.tsx:34`, `input.tsx:29`,
  `gantt-panel.tsx:4240`) — which suppresses that UA outline and paints the
  token ring in its place. Task 9.2a's negative depends on this being stated
  correctly: with the default misdescribed as absent, the obvious fault
  ("remove the `focus-visible` classes") restores the UA outline and proves
  nothing.
- `aria-haspopup="dialog"` and `aria-expanded`, because what opens is a sheet.

**The undated cell keeps the control contract and drops the sheet.** It carries
`role="button"`, `tabIndex={0}`, `aria-disabled="true"` and the same Enter and
Space handlers, and no `aria-haspopup` or `aria-expanded`, because no sheet
opens. Activating it by any means emits §1's refusal into a live region.

An earlier draft made it inert — no role, no tab stop, no key handler — _and_
required that live-region announcement, which cannot both be true: the only
element that fires the refusal was unreachable by exactly the users the live
region exists for. `aria-disabled` rather than `disabled` is the mechanism: a
disabled control leaves the tab order, and a user who cannot reach it is never
told why it does nothing. The "row of identical tab stops" objection above is
answered the same way it is for dated cells — each name is distinct, naming that
cell's workday position and the missing project start date.

## 7. Broadcast

One content-free `calendar_markers_changed` on `ProjectEvent`, added beside
`directory_changed`, `capacity_changed`, `priority_bands_changed` and
`saved_plans_changed` — all four of which `broadcast.ts` documents as
deliberately carrying nothing, because the client re-reads.

Its own type rather than reusing one of the four, for the same reason those
four are separate: the name has to be true.

Per-marker delta events are rejected: markers are few and the read is one
indexed query, so a delta protocol would be new surface bought with nothing.

## 8. Why the identity guarantee is structural

`schedule()` in `libs/domain/src/schedule.ts` takes rows, edges, **slices**,
`notBefore`, pool sizes and dependency reach (`:1802-1842`) — corrected after
the round-3 Sol review, which read the signature; the earlier "rows, edges,
durations and `notBefore`" named a parameter that is not there and omitted three
that are. Markers appear in none of them, live in their own table, and are
read only by the panel's overlay. There is no code path from a marker to the
engine, so no scheduler test changes.

**This is asserted, not assumed.** The oracle is the schedule response itself:
capture it, add markers, capture again, compare — **a canonical projection of
the schedule-bearing fields, not the response bytes.** `GET
/projects/:id/work-items` spreads `tree()`, which carries the project's event
`seq` (`work-item.service.ts:1147-1159`), and every marker mutation advances
that sequence by design, so a whole-body comparison is guaranteed to fail for a
reason that has nothing to do with the schedule: it would fail honestly and mean
nothing.

**The projection is the payload's complement, not a list of fields — and two
rounds of enumerating are the reason.** An earlier draft projected start, finish
and the critical flag: three of the eight fields on `Scheduled`
(`schedule.ts:116-124`) and none of what `tree()` returns beside the rows. The
round-4 answer widened it to every `workItems[].schedule` plus the slices,
`scheduleError` and both waiting counts — **and that was still short**, because
`NumberedWorkItem` carries `dates` _separately_ from `schedule`
(`work-item.service.ts:512-525`: `schedule` is spans in workdays, `dates` is the
calendar those spans land on), and the same read returns `teamCapacities`,
`priorityBands`, `estimateMethod`, `pertWeights`, `estimateRounding`, `depReach`,
`startDate` and `projectRevision` (`:1246-1293`). A list maintained by hand
against a growing payload will be short again at the next field, and that — not
any particular omission — is the defect.

So the projection is stated as a complement: **the entire response body with
`seq` deleted.** `seq` is the single exclusion, because `tree()` carries the
project's event `seq` (`work-item.service.ts:1147-1159`) and every marker
mutation advances it by design, so a literal whole-body comparison would fail
honestly and mean nothing. The same test asserts that `seq` **did** advance,
which proves the deletion removed a moving field rather than masking a stale
one. `projectRevision` stays _inside_ the comparison: markers never touch the
project row, so it must not move, and holding it proves that rather than
assuming it.

**And the identity claim is structural, so one assertion is structural too.**
Comparing two captures proves markers did not move _this_ plan; it cannot prove
there is no path from a marker to the engine, because a path that happens to be
a no-op on the fixture passes. The adapter seam is a single call —
`schedule(rows, edges, slices, notBefore, slotsOf, project.depReach)` at
`work-item.service.ts:1458`, six arguments — so two of the three checks are
cheap and exact: assert that call site still passes exactly those six arguments,
and that `libs/domain/src/schedule.ts` contains no import from the marker module
and no occurrence of the marker type. A source-level assertion is unusual and is
justified here because the guarantee being sold _is_ a source-level one.

**Those two are not enough, and the third is what closes it.** The six arguments
are not built in `schedule.ts`; they are built in `WorkItemService.tree()` —
`rows` at `:1298`, `edges` at `:1314`, `slotsOf` at `:1391`, `slices` at `:1400`,
`notBefore` at `:1415`. Marker-derived data folded into `notBefore`, `slices` or
`slotsOf` leaves the call at six arguments and `schedule.ts` marker-free, and
both source assertions stay green. The third check is therefore a **runtime
reach**: drive the schedule read against a project with markers through a
repository opened with drizzle's `logQuery` hook, and assert **no logged
statement names `calendar_marker`**. A source scan is bounded by the file it
scans; a SQL log is transitive, so it holds however many helpers a fold hides
behind. Slice 5.1a carries all three checks, each with its own negative.

Note for anyone extending this — an earlier draft of this task cited a
`fast-golden-corpus` serializer as the oracle. **No such corpus exists in this
repo**; the nearest thing, `libs/domain/src/schedule-identity.test.ts`, compares
the current engine against a copied older engine and is a different guarantee
entirely. The projection above is what is actually available.

## Assumptions

Carried from the design interview with what would falsify each. Numbering is
stable; the spec's requirements implement them.

| #   | Assumption                                                                                                        | Falsified by                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Undated plans refuse the click with a reason, rather than hiding it.                                              | Dany wanting markers on undated plans, or a decision to give every project a start date.                           |
| 2   | Many markers per date, one band, collapsing to a count past what fits.                                            | A treatment that cannot express more than one per day at the 4px rung.                                             |
| 3   | Project-scoped child table plus one content-free `calendar_markers_changed`.                                      | A requirement for per-marker deltas, or for markers to outlive their project.                                      |
| 4   | Automatic colour is deterministic from the marker id over a fixed palette; custom colours are contrast-validated. | An accessibility rule the fixed palette cannot meet, or colour needing to carry category rather than identity.     |
| 5   | Dates are project-local `IsoDate`s — no time, no per-user timezone.                                               | Markers needing to align with an external calendar's instants (out of scope in the brief).                         |
| 6   | Edit and delete follow project write permission, with no separate marker role.                                    | A need for per-marker ownership.                                                                                   |
| 7   | The chip plus a behind-the-bars rule (treatment B), with the rule dropped at 4px above a density threshold.       | Measured smear at 4px below the threshold, which would make chips-only the 4px behaviour at every density.         |
| 8   | The composer issues the marker id so the previewed automatic colour is the created one (§6.1).                    | A rule against client-supplied primary keys, or a decision that no colour is previewed before submit.              |
| 9   | A marker rule on today's date draws over today's leading edge; today stays findable by its tinted column (§2.1).  | Dany reading a marker on today as having erased it, which would make the offset-by-one-pixel treatment right.      |
| 10  | The exported chart carries its legend unconditionally — nobody wants a chart exported _without_ the marker names. | Dany asking for a bare chart, which makes the legend a flag on the export call rather than an unconditional block. |

Assumptions 1–6 were opened in the design interview under the 2026-09-03
standing rule that unresolved product choices become documented assumptions
rather than blocking questions. Assumption 7 resolves what AC #1 left open,
and §2 is the argument for it.

**The export half of the original assumption 6 was split out after the Gemini
planning review, and is now assumption 10** (round-18 Sol review, Minor — the
number was left pointing at the row that today holds the edit/delete permission
rule). As first written it also claimed "export renders markers as the axis
shows them", which the code falsified: `buildStandaloneGanttSvg` (`gantt-panel.tsx:1738`) nests the live
chart SVG but **rebuilds the axis band from pixel arithmetic** at `:1789`, and
`StandaloneGanttSvgInput` at `:1614` has no marker field. So the export would
have carried the body rule — which rides inside the nested SVG — while
dropping the chip that names it. That is not an assumption anyone can hold; it
is a requirement with a mechanism, and it is now one (spec, "The downloaded
chart carries its markers", tasks 8.6–8.7).
