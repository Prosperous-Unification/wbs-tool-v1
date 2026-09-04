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
      `libs/domain/src/marker-color.test.ts`: the same id twice gives the same
      colour; three ids created and the first deleted leaves the other two
      unchanged. Negative for determinism: the implementation swapped for one
      keyed on an index passed in by the caller, watched failing the deletion
      case. That negative is the whole slice — a colour function tested only
      for "returns something in the palette" cannot fail.
- [ ] 3.2 The palette itself — **eight named hex entries, written into
      `marker-color.ts` as a literal**, each clearing **3:1** against both
      themes' chart background (WCAG 1.4.11, the non-text bar these are) and
      carrying a label colour clearing **4.5:1** against its own fill (1.4.3).
      Test: `libs/domain/src/marker-color.test.ts`, a table case over every
      entry asserting both ratios in light and dark. Negative: one
      deliberately-failing colour appended to the palette fixture, watched
      failing, and removed — without it the assertion loop passes over an empty
      palette. Eight rather than "a fixed palette": a count the test can iterate
      is checkable, an adjective is not.
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

## 4. The API

- [ ] 4.1 `apps/be-01/src/controller/calendar-marker.controller.ts` — list,
      create, rename, recolour, delete, scoped to one project — test:
      `apps/be-01/src/controller/calendar-marker.controller.db.test.ts`, the
      five verbs round-tripped, list ordered by `(date, created_at)`, and a
      create with an out-of-horizon date accepted and returned.
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
      a truthiness check lets through. R5: malformed trusted data throws.

## 5. The schedule identity guarantee

- [ ] 5.1 The schedule response is byte-identical with and without markers —
      test: `apps/be-01/src/controller/calendar-marker-identity.db.test.ts`.
      Capture the schedule response for a seeded project, create five markers
      on dates inside its span, capture again, assert the two byte strings are
      equal. Negative: a line added to the schedule input assembly that appends
      marker dates to `notBefore`, watched failing — and removed. **Without
      that injection this test cannot fail**, because nothing in the current
      code path connects the two; it would be the sixteenth check all over
      again. `Proof:` comment naming the injected line.
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

- [ ] 8.1 The chip in the axis band, anchored via `CalendarScale` — test:
      `gantt-panel.test.tsx`, a marker on `2026-08-19` asserted at the calendar
      x, not the workday x. Negative: the chip placed by workday number,
      watched failing — this is the drift `gantt-calendar-axis` exists to
      prevent and the fixture is chosen so the two numbers differ.
- [ ] 8.2 The rule down the body, behind the bars — test: same file, assert the
      rule element precedes every bar element in paint order and that a bar
      crossing it keeps its `x`, `width` and critical-path class **unchanged
      from the same plan with no marker**. The unchanged-bar half is the
      requirement; the ordering half is the mechanism.
- [ ] 8.3 `MARKER_RULE_MAX_PER_100PX` and the 4px suppression — test: same
      file, markers above the threshold at 4px per day asserted to draw no
      rules and every chip; below the threshold, rules drawn. Negative: the
      threshold read as `> 0`, watched failing on the below-threshold case.
- [ ] 8.4 Overflow collapses to a count with the list on hover or tap — test:
      same file at 28px per day, more markers on one date than the band shows.
- [ ] 8.5 A marker outside the current horizon draws nothing and is still
      returned by the API — test: same file plus the controller test from 4.1.
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

## Gate

- [ ] G Record the actual output of `bunx nx run-many -t test lint typecheck`
      in `verify.md`, with the failure-proof table: for every negative named
      above, the fault injected, the test that observed it failing, and the
      result. A check with no observed failure is not done.
