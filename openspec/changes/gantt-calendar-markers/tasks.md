<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks". A check with no negative test is not done.

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

Every fixture below uses a project starting **Monday 2026-08-10**, the date
`gantt-panel.test.tsx` already seeds, and every marker fixture sits on a date
**past the first weekend** so the calendar offset differs from the workday
number. A marker asserted at workday 3 would land at the same x under either
axis and prove nothing.

Slices 2–4 are be-01 and can land before any fe-01 work; 6–9 are fe-01 and need
only slice 4's endpoint shape. Slice 1 gates nothing but must land first — it
is what the rest is allowed to assume.

## 1. The decision on record

- [ ] 1.1 ADR under `docs/adr/` for **refusing the marker click on an undated
      plan**, carrying the three-option table from `design.md` §1 (hide /
      synthesise a date / refuse with a reason) and the chosen option. Link it
      from the JSDoc on the refusal branch; do not copy its rationale into the
      code comment — R3. No test: an ADR is a document, and a slice that
      claimed a test for it would be the vacuous shape R5 exists to stop.
- [ ] 1.2 `CONTEXT.md`: add **calendar marker** — "a named annotation on an
      absolute calendar date, scoped to one project; not a work item and not
      visible to the scheduler". Glossary terms only, no design detail.

## 2. The table and the migration

- [ ] 2.1 `calendar_marker` in `apps/be-01/src/repository/schema.ts` with the
      columns in `design.md` §5, `project_id` cascading on project delete, and
      the `(project_id, date)` index — test:
      `apps/be-01/src/repository/calendar-marker.db.test.ts`, a round-trip, a
      second marker on the same date accepted (the date is deliberately not
      unique), and `date` stored as the exact `IsoDate` text given.
- [ ] 2.2 The forward migration, stamped later than
      `20260904020000_add_saved_plan_created_by_id` — test: the existing
      migration suite plus a case in
      `apps/be-01/src/repository/calendar-marker-migration.db.test.ts` that
      `DELETE FROM project` on a project with markers succeeds and leaves no
      marker row. Negative for the cascade: the FK written without
      `ON DELETE CASCADE`, watched failing with a constraint error — which is
      exactly the 500 an outgoing blue/green release would answer with for the
      length of a swap, and the reason the cascade is there rather than for
      tidiness. `Proof:` comment naming the omitted clause.
- [ ] 2.3 Stamp collision check — run `duplicateMigrationStamps` from
      `migrate-down.ts` over the folder set including the new one and assert it
      reports none. Negative: the new folder restamped to
      `20260904020000`, watched failing. A stamp that collides silently
      reverses nothing, which is a failure with no error message.

## 3. Automatic colour

- [ ] 3.1 The fixed palette and `automaticColor(markerId)` —
      `palette[hash(id) mod palette.length]`, in a new
      `libs/domain/src/marker-color.ts` — test:
      `libs/domain/src/marker-color.test.ts`.
      **Pinned vectors first, because the two obvious assertions are both
      vacuous.** "The same id twice gives the same colour" and "deleting the
      first of three leaves the other two unchanged" are BOTH satisfied by
      `const automaticColor = () => palette[0]`, so neither can fail and the
      slice as first written proved nothing. The test therefore carries a table
      of **four literal UUIDs with the exact hex each must return**, at least
      two of them different, written into the test as data — a constant
      implementation fails on the first row.
      Negatives, three, each watched failing:
      (a) the function keyed on an index passed in by the caller — fails the
      deletion case;
      (b) the hash taken over the marker's **name** instead of its id — fails a
      rename-stability case, which is the fault the pinned vectors alone would
      miss because a name-keyed hash is still deterministic;
      (c) the hash taken over the **date** — fails a case with two markers on
      one date asserting their colours differ, which is the identity a stacked
      band exists to distinguish.
      `Proof:` comment naming the four vectors' source (they are recorded, not
      computed at test time — a vector recomputed by the code under test is the
      code agreeing with itself).
- [ ] 3.2 The palette itself — **eight named hex entries, written into
      `marker-color.ts` as a literal**, each clearing **3:1** against both
      themes' chart background (WCAG 1.4.11, the non-text bar these are) and
      carrying a label colour clearing **4.5:1** against its own fill (1.4.3).
      Test: `libs/domain/src/marker-color.test.ts`, `expect(PALETTE).toHaveLength(8)`
      **first**, then a table case over every entry asserting both ratios in
      light and dark. The length assertion is not decoration: without it the
      ratio loop passes over an empty or one-entry palette, and the
      `palette.length` divisor in 3.1 would then make a constant function its
      own vectors could not distinguish from a correct one. Negative: one
      deliberately-failing colour appended to the palette fixture, watched
      failing, and removed. Eight rather than "a fixed palette": a count the
      test can iterate is checkable, an adjective is not.
- [ ] 3.3 `validateCustomColor(hex)` refusing a colour below either bar and
      **naming the failing theme and the failing ratio** — test: same file, a
      colour that clears 3:1 in light and fails it in dark, asserting the
      refusal names dark and `3:1`; a second whose label contrast fails 4.5:1.
      Negative: the validator returning `true` unconditionally, watched failing.
- [ ] 3.4 `validateCustomColor` wired into **both** write paths — the be-01
      create/recolour handlers and the composer — test: the controller test
      from 4.1 posts a sub-bar colour straight to the API, bypassing the
      composer, and asserts refusal with no row; `gantt-panel.test.tsx` asserts
      the composer refuses before submitting. Negative: the server-side call
      removed, watched writing the row while the UI test stayed green. A
      validator unit-tested but never called is the shape 3.1–3.3 would
      otherwise ship: green tests over a guard on no production path.
- [ ] 3.5 The composer issues the id, so the previewed colour is the created
      one — the composer generates a v4 UUID, renders `automaticColor(id)` as
      the swatch, and sends that `id` in the create body — test:
      `gantt-panel.test.tsx`, read the swatch's colour before submit and the
      created chip's colour after, and assert they are equal. Negative: the
      server ignoring the supplied `id` and calling `clock.newId()`, watched
      failing on unequal colours. Without that fault the assertion passes by
      luck one time in eight, which is the palette's own cardinality and not a
      test. See `design.md` §6.1 for why the other three options lost.

## 4. The API

- [ ] 4.1 `apps/be-01/src/controller/calendar-marker.controller.ts` — list,
      create, rename, recolour, delete, scoped to one project — test:
      `apps/be-01/src/controller/calendar-marker.controller.db.test.ts`, the
      five verbs round-tripped, list ordered by **`(date, created_at, id)`**,
      and a create with an out-of-horizon date accepted and returned. The third
      key is the slice's point: two markers created against a fixed clock tie on
      `(date, created_at)`, and a tie lets the order change between two reads of
      unchanged data. Test it as such — a fixed clock, two markers on one date,
      the list read twice, the order asserted equal and asserted to be id order.
      Negative: the `id` key dropped from the `ORDER BY`, watched failing on the
      tied pair. Ordering asserted only over distinct timestamps cannot fail.
- [ ] 4.2 Write permission — every mutation refused for a read-only actor with
      the same status the project's other writes use — test: same file, a
      read-only actor against each of the four mutations, asserting the status
      and that no row was written. Negative: the permission check removed from
      the create path, watched failing on the create case. A permission test
      that only checks the happy path is not a permission test.
- [ ] 4.3 A create whose `date` is not an `IsoDate` throws rather than being
      coerced — test: same file, `2026-9-17`, `2026-09-17T00:00:00Z` and
      `not-a-date` each rejected. Negative: the validator replaced with a
      truthiness check, watched failing on the timestamp case, which is the one
      a truthiness check lets through. R5: malformed trusted data throws. Same
      file, one more case: a create issued from a process at `TZ=Pacific/Auckland`
      at an instant whose UTC date is the day before, asserting the stored date
      is the one submitted. The whole timezone requirement is "no instant is
      converted anywhere on the path", and a test run only at UTC cannot observe
      a conversion that is the identity there.
- [ ] 4.4 The client-supplied `id`, its fallback and its collision — test: same
      file, three cases: a create carrying an `id` stores that exact id; a create
      omitting `id` is issued one by `Clock.newId()` (asserted through the fake
      clock the suite already injects); a create repeating an existing id is
      refused with no row added and the existing marker's name, date and colour
      unchanged. Negative for the last: the insert written as an upsert, watched
      overwriting the existing row. A duplicate-id test that only asserts an
      error status passes against an upsert that already destroyed the row.
- [ ] 4.5 Refusals name their field and apply nothing — test: same file, an
      empty name on create and on rename, and a malformed colour on recolour,
      each asserting the project's existing refusal shape with the failing field
      named, and that the stored marker is byte-identical to before the call.
      Negative: the rename writing before validating, watched leaving the new
      name behind after a refused call. "Refused" and "unchanged" are two claims
      and the second is the one a partial write breaks.
- [ ] 4.6 Project isolation, and a marker is not a work item — test: same file,
      two seeded projects each with markers: listing one returns none of the
      other's; a rename naming the other project's marker id is refused with
      both rows unchanged; a marker id requested through the work-item routes is
      refused; a work-item id requested through the marker routes is refused.
      Negative: the `project_id` predicate dropped from the list query, watched
      returning the other project's markers. An isolation test written only
      against a single seeded project passes with no predicate at all.

## 5. The schedule identity guarantee

- [ ] 5.1 The schedule response is byte-identical with and without markers —
      test: `apps/be-01/src/controller/calendar-marker-identity.db.test.ts`.
      Capture the schedule for a seeded project, create five markers on dates
      inside its span, capture again, assert equality.
      **Compare a canonical projection, not the response bytes.**
      `GET /projects/:id/work-items` spreads `tree()`, which carries the event
      `seq` (`work-item.service.ts:1147-1159`), and marker broadcasts advance
      it by design — a whole-body comparison is guaranteed to fail for a reason
      that is not the schedule. Project to every work item's start, finish and
      critical-path flag in a fixed order, and assert alongside it that `seq`
      **did** advance, so the test also proves it compared the right thing.
      Negative: **not** "marker dates appended to `notBefore`" — that is not
      compilable, since `notBefore` is `Map<string, number>` keyed by work-item
      id (`work-item.service.ts:1410-1420`) and a marker has no such id.
      Instead, seed one known work item and inject a floor derived from a
      marker's date onto **that id**, watched moving its start and failing the
      projection, then removed. `Proof:` comment naming the seeded id and the
      injected floor. Without a compilable injection this test cannot fail and
      is the sixteenth check again.
- [ ] 5.2 Markers stay out of a saved plan — test:
      `apps/be-01/src/repository/saved-plan-capture.db.test.ts`, a new case:
      capture a project with markers and a copy with none, assert the
      `input_sha256` values are equal. **This assertion passes on `main`
      today** — `saved-plan-capture.ts:47-65` queries a hardcoded table set
      that does not include `calendar_marker`, so equality holds before a line
      of this feature is written, and the check as stated cannot fail. Negative:
      `calendar_marker` added to that hardcoded query and its rows folded into
      the serialized capture payload, watched failing on unequal `input_sha256`,
      then removed. `Proof:` comment naming the added query. Without that
      injection this is 5.1's own trap committed one slice later.

## 6. The click surface

- [ ] 6.1 The dated axis cell accepts a click and opens the composer on that
      cell's `data-axis-date` — test: `gantt-panel.test.tsx`, click the cell
      whose `data-axis-date` is `2026-08-19` (past the first weekend) and
      assert the composer reports that date.
      **The injected fault must be workday arithmetic, not "its own
      arithmetic".** On the Monday-2026-08-10 fixture that cell's `offset` is 9
      and its `workday` is 7, and `addCalendarDays(startDate, 9)` returns
      `2026-08-19` — the correct answer — so a negative that recomputes the
      date from `offset` calendar-wise passes with the fault in. Negative:
      the composer reading `addWorkdays(startDate, day.offset)` (`2026-08-21`),
      watched failing; a second pass reading `day.workday` (`2026-08-17`), also
      watched failing. `Proof:` comment naming both dates.
- [ ] 6.2 Hover and click coexist — test: same file, pointer-over then click on
      one cell, asserting the day surface opened and the composer opened and
      neither closed the other. The existing `showDaySurface` timer is the
      thing at risk.
- [ ] 6.3 The day sheet: clicking a populated cell lists every marker on that
      date with rename, recolour and delete per row, plus an add action — test:
      same file, three cases: two markers on one date (both listed, add
      offered), exactly one marker (still a list, add still offered), and no
      markers (composer already open, name field focused). The one-marker case
      is the point of the slice — an implementation that shortcut a single
      marker straight to edit would pass the two-marker case and make a second
      marker unreachable, which is the conflict this resolves.
- [ ] 6.4 The dated cell becomes a control — `role="button"`, `tabIndex={0}`,
      Enter and Space handlers, a visible focus ring, `aria-haspopup="dialog"`,
      an `aria-expanded` tracking the sheet, and an `aria-label` naming the
      date and the marker count — test: `gantt-panel.test.tsx`, four cases:
      Enter opens the sheet, Space opens the sheet, a cell with two markers has
      an accessible name naming its date and reporting two, and an **undated**
      plan's cells are not focusable and carry no `role`. Negative: the Space
      handler removed, watched failing — a keyboard test written only for Enter
      passes against a `keydown` that forwards every key, and one written only
      for `tabIndex` passes against a focusable element nothing activates. The
      `<span>` is a `<span>` today because it was hover-only; a click without
      this contract ships a control no keyboard reaches (WCAG 2.1.1).
- [ ] 6.5 The refusal is announced, not only drawn — the undated-plan message
      from 7.2 rendered into a live region — test: same file, assert the
      message's container carries the live-region role the app already uses for
      transient status. Negative: the live-region attribute removed, watched
      failing. A message a screen reader never reaches is the silent absence
      `design.md` §1 refuses.

## 7. The undated-plan refusal

- [ ] 7.1 `workdayAxis` cells stay dateless — test: `gantt-panel.test.tsx`, a
      direct assertion on `workdayAxis` output that every cell has
      `date: null`, **not** routed through the panel. Asserted directly so a
      future change that gave every project a start date would break this test
      loudly rather than making the refusal unreachable and untested.
- [ ] 7.2 Clicking an undated plan's cell is refused with a message naming the
      missing project start date, and no composer opens — test: same file, two
      assertions: the refusal message is present **and** names the missing
      start date, and no composer is in the document.
      **A click writes nothing even when it succeeds** — it opens a composer,
      and only a submit writes — so "a marker was written" is not observable
      here and is deliberately not asserted; the storage half of this guarantee
      is 7.4's. Negative: the refusal branch removed, watched failing on both
      remaining halves (a composer opened, and no message was rendered).
- [ ] 7.3 Giving that project a start date turns the same cell live — test:
      same file, re-render with a start date and assert the click opens the
      composer. This is what proves 7.2 refused for the stated reason and not
      because the click handler was never wired: a refusal proved only by "no
      composer appeared" also passes against a cell that is simply inert, which
      is the defect this requirement forbids.
- [ ] 7.4 No marker can reach storage against a workday number — test:
      `apps/be-01/src/controller/calendar-marker.controller.db.test.ts`, a
      create submitted for a project with no start date, asserting refusal and
      no row. Negative: the server-side check removed, watched writing a row.
      The client refusal is a UI affordance; this is the one that holds when
      the request does not come from the panel.

## 8. Drawing

- [ ] 8.0 `axisOffsetOf(axis, date)` — `todayOffset` (`gantt-panel.tsx:841`)
      generalised to any `IsoDate`, with today rewired as its first caller so
      there is one lookup rather than two that can disagree — test:
      `gantt-panel.test.tsx`, a date present in the axis, one absent (null),
      and today's existing assertions still green through the new callee.
      **`CalendarScale` is not the seam:** `startOf`/`endOf` are
      `(workday: number) => number` (`gantt-geometry.ts:864-880`), so an
      absolute date is already past that conversion. Negative: the helper
      reimplemented as `calendarDaysBetween(origin, date)`, watched failing
      against an axis whose first cell was normalised off a weekend start —
      the second-scale drift `todayOffset`'s own docstring warns about.
- [ ] 8.1 The chip in the axis band, placed by `axisOffsetOf` — test:
      `gantt-panel.test.tsx`, a marker on `2026-08-19` asserted at the calendar
      x, not the workday x. Negative: the chip placed by workday number,
      watched failing — this is the drift `gantt-calendar-axis` exists to
      prevent and the fixture is chosen so the two numbers differ.
- [ ] 8.2 The rule takes its named slot in `marksOverLight` — **not merely
      "behind the bars"**, which orders the marker against one of the five marks
      the body paints and leaves the other four undecided. Emitted after
      `data-gantt-today-edge` and before the row hit lines and every bar
      (`design.md` §2.1 carries the full table) — test: `gantt-panel.test.tsx`,
      one assertion over the DOM order of `data-gantt-weekend`,
      `data-gantt-today`, `data-gantt-gridline`, `data-gantt-today-edge`,
      `data-gantt-marker-rule` and the first bar, asserting exactly that
      sequence; plus a bar crossing the rule keeping its `x`, `width` and
      critical-path class **unchanged from the same plan with no marker**.
      Negative: the rule emitted at the top of `marksOverLight`, watched failing
      the sequence while the unchanged-bar half stays green — which is the point,
      because a rule above the gridlines is still behind every bar. The
      unchanged-bar half is the requirement; the sequence is the mechanism, and
      it needs its own assertion because the requirement cannot see it.
- [ ] 8.3 `MARKER_RULE_MAX_PER_100PX` and the 4px suppression — the constant is
      **6** (`design.md` §3: 100px is 25 days at that rung, so six is one rule
      per ~16px and seven puts two inside one heavy-gridline week) — test: same
      file, seven markers within 100px of viewport at 4px per day asserted to
      draw no rules and every chip; six asserted to draw six rules; and at 28px
      per day, where 100px holds 3.6 days, the threshold asserted unreachable so
      rules always draw. Negative: the threshold read as `> 0`, watched failing
      on the six-marker case. A boundary constant tested only well above and
      well below its value does not test the value.
- [ ] 8.4 Overflow collapses to a count with the list on hover or tap — test:
      same file at 28px per day, more markers on one date than the band shows.
- [ ] 8.5 A marker outside the current horizon draws nothing and is still
      returned by the API — test: same file plus the controller test from 4.1,
      and the **return trip**: lengthen the plan so the horizon covers that date
      again and assert the chip is drawn at its axis offset. Negative: the
      absent-date branch in `axisOffsetOf` changed to throw, watched failing the
      shortened case. Half of this behaviour is "still stored", which is not
      observable on the panel at all, and half is "drawn again", which a test
      that only shortens the plan never reaches.
- [ ] 8.8 A marker on today and a marker on a weekend — test: same file, two
      cases: a marker on today's date, asserting its rule element **follows**
      `data-gantt-today-edge` and that the `data-gantt-today` tinted column is
      still present at that offset; and a marker on a Saturday, asserting its
      rule follows that day's `data-gantt-weekend` column and the column is
      unchanged from the same plan without the marker. These are the two
      collisions `design.md` §2.1's slot decides, and the today case is the one
      whose opposite ordering would have hidden a marker the user just placed.
- [ ] 8.6 The standalone SVG export carries the chips — `markers` added to
      `StandaloneGanttSvgInput` (`gantt-panel.tsx:1614`) and drawn in the axis
      rebuild at `:1789` — test: same file, export a plan with two markers and
      assert a chip per marker at its day's x in its colour. **The rule needs
      no work and that is the trap:** the body rule lives inside the nested
      live chart SVG and carries over for free, so an export left unchanged
      produces a coloured line with no chip naming it. Negative: `markers`
      passed but the axis-rebuild loop left untouched, watched failing with the
      rule present and no chip — which is exactly the half-exported state.
- [ ] 8.7 The export matches the screen at 4px above the density threshold —
      test: same file, chips present and no rules, matching 8.3's live
      behaviour.

## 9. Live update and end-to-end

- [ ] 9.1 `calendar_markers_changed` on `ProjectEvent` in
      `apps/be-01/src/service/broadcast.ts`, content-free, its own type — test:
      `apps/be-01/src/service/broadcast.test.ts`, one event per mutation across
      create, rename, recolour and delete, each carrying no payload. Negative:
      the delete path left unbroadcast, watched failing.
- [ ] 9.2 `e2e/gantt.spec.ts`: click a day, name a marker, see the chip and the
      rule; reload and see them still there; delete and see them gone. The one
      test that judges pixels — jsdom asserts positions, a browser judges
      appearance.
- [ ] 9.3 A second client re-reads on the event — test:
      `gantt-panel.test.tsx` (or the panel's existing stream harness), mount the
      panel, deliver a `calendar_markers_changed` on the project stream with the
      marker list changed underneath, and assert the new chip appears with no
      remount and no reload. Negative: the panel's handler for that event
      removed, watched failing. 9.1 counts emissions, which is a broadcast into
      an empty room until something acts on it — this slice is the half that
      makes the content-free event design work at all, and it was specified
      backend-side with nothing proving the client side.

## Gate

- [ ] G Record the actual output of `bunx nx run-many -t test lint typecheck`
      in `verify.md`, with the failure-proof table: for every negative named
      above, the fault injected, the test that observed it failing, and the
      result. A check with no observed failure is not done.
