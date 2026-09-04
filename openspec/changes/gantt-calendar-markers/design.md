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

`workdayAxis` sets `date: null` on every cell, and the render at `:3879`
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

Today and weekend are **axis and grid** (`gantt-panel.tsx:2972`, the day rule
drawn `stroke-border` when heavy and `stroke-border/40` otherwise). Critical
path is on the **bars** (`barClasses` at `:725`, `bar.critical ?
'stroke-foreground [stroke-width:2]'` at `:3511`). They are different layers,
so a marker confined to the header band contends with today and weekend only.

Drawing a rule down the body is what makes a marker useful — it is how a
reader sees which bars cross the date — and it is also what puts the marker
into the bar layer's argument. Painting the rule **behind** the bars at
reduced opacity settles it without a precedence table: nothing is drawn over a
bar, so bar fill and the critical-path stroke keep full contrast, and the rule
stays legible in the gaps between bars, which is where a date is actually
traced. Paint order is the whole mechanism; there is no z-index to tune.

**Consequence for the existing tests:** at 28px per day no bar coordinate or
class changes, so the panel's existing pixel assertions stay green. A marker
test that had to edit one of them would mean the layering was wrong.

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
constant — `MARKER_RULE_MAX_PER_100PX` — checked against markers within the
viewport, and **above** it the rules are dropped and the chips kept (treatment
A as the 4-rung fallback). A named constant with a pixel assertion is testable;
"looks busy" is not.

## 4. Geometry comes from the existing scale

A marker's x is `CalendarScale`'s reading of its date, the same scale every
other mark uses (`gantt-geometry.ts`, `calendarScale(startDate)`). A marker
must not compute its own offset: two scales drift, which is the exact failure
`gantt-calendar-axis` was written to end.

Concretely: date → calendar-day offset from `addWorkdays(startDate, 0)` →
user-space x, then the same `dayPx` every other mark is stretched by.

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

`date` is `text`, matching how the rest of the schema stores an `IsoDate`, and
is indexed with `project_id` because "this project's markers, by date" is the
only read.

## 6. Colour determinism

Automatic colour is `palette[hash(marker.id) mod palette.length]` over a fixed
accessible palette. **From the id, not from insertion order or count** —
order-derived colour changes every earlier marker when one is deleted, which
is a visible bug with no error message.

No deterministic entity palette exists in the repo today (`libs/domain` and the
WBS components have only UI chrome and theming), so the palette is new work
and needs its own contrast evidence against both themes.

**The bar is two numbers, not an adjective.** A marker is two things at once,
so it clears two WCAG thresholds: **3:1** for the chip fill and the body rule
against the chart background (1.4.11, the non-text bar these are), and
**4.5:1** for the chip's label text against its own fill (1.4.3). The palette
is eight named entries so a test can iterate it; "a fixed accessible palette"
is not something an assertion can count.

A custom colour is validated against both bars in both themes **at submit, in
be-01**, and refused with the failing theme and ratio named. Validating in the
composer alone refuses the colour only for clients that ask nicely; validating
at render instead would leave an unreadable marker stored and blame the
reader's theme.

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

`schedule()` in `libs/domain/src/schedule.ts` takes rows, edges, durations and
`notBefore`. Markers appear in none of them, live in their own table, and are
read only by the panel's overlay. There is no code path from a marker to the
engine, so no scheduler test changes.

**This is asserted, not assumed.** The oracle is the schedule response itself:
capture it, add markers, capture again, compare bytes. Note for anyone
extending this — an earlier draft of this task cited a `fast-golden-corpus`
serializer as the oracle. **No such corpus exists in this repo**; the nearest
thing, `libs/domain/src/schedule-identity.test.ts`, compares the current
engine against a copied older engine and is a different guarantee entirely.
The byte-comparison above is what is actually available.

## Assumptions

Carried from the design interview with what would falsify each. Numbering is
stable; the spec's requirements implement them.

| #   | Assumption                                                                                                        | Falsified by                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Undated plans refuse the click with a reason, rather than hiding it.                                              | Dany wanting markers on undated plans, or a decision to give every project a start date.                       |
| 2   | Many markers per date, one band, collapsing to a count past what fits.                                            | A treatment that cannot express more than one per day at the 4px rung.                                         |
| 3   | Project-scoped child table plus one content-free `calendar_markers_changed`.                                      | A requirement for per-marker deltas, or for markers to outlive their project.                                  |
| 4   | Automatic colour is deterministic from the marker id over a fixed palette; custom colours are contrast-validated. | An accessibility rule the fixed palette cannot meet, or colour needing to carry category rather than identity. |
| 5   | Dates are project-local `IsoDate`s — no time, no per-user timezone.                                               | Markers needing to align with an external calendar's instants (out of scope in the brief).                     |
| 6   | Edit and delete follow project write permission, with no separate marker role.                                    | A need for per-marker ownership.                                                                               |
| 7   | The chip plus a behind-the-bars rule (treatment B), with the rule dropped at 4px above a density threshold.       | Measured smear at 4px below the threshold, which would make chips-only the 4px behaviour at every density.     |

Assumptions 1–6 were opened in the design interview under the 2026-09-03
standing rule that unresolved product choices become documented assumptions
rather than blocking questions. Assumption 7 resolves what AC #1 left open,
and §2 is the argument for it.

**Assumption 6 was narrowed after the Gemini planning review.** Its first half
also claimed "export renders markers as the axis shows them", which the code
falsified: `buildStandaloneGanttSvg` (`gantt-panel.tsx:1738`) nests the live
chart SVG but **rebuilds the axis band from pixel arithmetic** at `:1789`, and
`StandaloneGanttSvgInput` at `:1614` has no marker field. So the export would
have carried the body rule — which rides inside the nested SVG — while
dropping the chip that names it. That is not an assumption anyone can hold; it
is a requirement with a mechanism, and it is now one (spec, "The downloaded
chart carries its markers", tasks 8.6–8.7).
