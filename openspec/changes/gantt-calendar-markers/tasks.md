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
      Negative: `index(calendar_marker_project_date, ...)` replaced with
      `uniqueIndex(...)`, watched failing the same-date insert with a constraint
      error. Named exactly, because Drizzle's `IndexBuilder` has **no**
      `.unique()` method and "a `unique()` added to the index" would not compile
      (round-5 Sol review, Important 6). "Deliberately not
      unique" is the one property of this table nothing else in the change can
      observe, and a round-trip test passes with the uniqueness in place.
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
- [ ] 2.2a The migration ships its `down.sql` — `AGENTS.md` §Migrations:
      "**Every migration ships a `down.sql` beside its `migration.sql`.** The
      migration lint fails without one, and `readMigrationFolders` refuses to
      run a rollback it cannot complete." Every existing folder under
      `apps/be-01/drizzle/` carries one (verified); this change's did not, and
      2.2 named only the forward file (round-4 Sol review, Minor 18) — test:
      the migration suite applied forward then rolled back with
      `migrate-down-cli.ts --to=<the previous migration>`, asserting
      `calendar_marker` is gone and the rest of the schema is unchanged.
      Negative: `down.sql` deleted, watched failing the migration lint; and a
      second with an **empty** `down.sql`, watched failing the roll-back case
      with the table still present — an empty file satisfies "a file exists"
      and is the failure the lint alone does not catch. The lint deliberately
      does not enforce additive-only on `down.sql`: reversing an additive
      change is destructive by definition, which is why it is a separate file.
- [ ] 2.3 Stamp collision check — run `duplicateMigrationStamps` from
      `migrate-down.ts` over the folder set including the new one and assert it
      reports none. Negative: the new folder restamped to
      `20260904020000`, watched failing. A stamp that collides silently
      reverses nothing, which is a failure with no error message.

## 3. Automatic colour

**Dependency order, which is not file order here: 3.2 lands before 3.1.** The
palette and the two contrast bars are a measured result, and 3.1's pinned
vectors are computed from them; the numbering follows the reader's order — what
the colour function _is_, then what it draws from — and the dependency is stated
in both slices rather than implied by position.

- [ ] 3.1 `automaticColor(markerId)` — `palette[fnv1a32(id) mod palette.length]`
      over the palette slice 3.2 lands, in a new
      `libs/domain/src/marker-color.ts`. **3.2 runs first:** the pinned vectors
      below are computed from the landed palette and the named hash, and cannot
      be written before either exists. Test:
      `libs/domain/src/marker-color.test.ts`.
      **Pinned vectors first, because the two obvious assertions are both
      vacuous.** "The same id twice gives the same colour" and "deleting the
      first of three leaves the other two unchanged" are BOTH satisfied by
      `const automaticColor = () => palette[0]`, so neither can fail and the
      slice as first written proved nothing. The test therefore carries a table
      of **four literal UUIDs with the exact hex each must return** under
      32-bit FNV-1a mod 8 against 3.2's palette, at least two of them different,
      written into the test as data — a constant implementation fails on the
      first row. Record the four vectors in `verify.md` beside the palette.
      Negatives, three, each watched failing:
      (a) a module-level `let seen = 0` inside `marker-color.ts` returning
      `palette[seen++ % palette.length]` — compilable, because it changes no
      signature, and order-derived exactly as the requirement forbids; watched
      failing on a case that colours `[id1, id2, id3]` and then `[id2, id3]` and
      asserts `id2` unchanged. The earlier wording — "keyed on an index passed
      in by the caller" — could not be built at all: `automaticColor(markerId)`
      takes one string, and widening it to take an index is a different function
      rather than a fault in this one;
      (b) the hash taken over the marker's **name** instead of its id — fails a
      rename-stability case, which is the fault the pinned vectors alone would
      miss because a name-keyed hash is still deterministic;
      (c) the hash taken over the **date** — fails a case with two markers on
      one date asserting their colours differ, which is the identity a stacked
      band exists to distinguish.
      **(b) and (c) are injected at the CALLER, not in `marker-color.ts`, and
      their cases live in the be-01 create/rename tests from 4.x** —
      `automaticColor(markerId: string)` never sees a name or a date, so a
      mutation inside it that read either would not compile, and
      `marker-color.test.ts` has no marker entity to rename. The compilable
      mutation is the call site passing `marker.name` (or `marker.date`) where
      it passes `marker.id`, which typechecks because both are strings — and
      that is exactly why it is the fault worth watching. Only (a) belongs in
      the domain unit test.
      `Proof:` comment naming the four vectors' source (they are recorded, not
      computed at test time — a vector recomputed by the code under test is the
      code agreeing with itself).
- [ ] 3.2 The palette itself, **and it lands before 3.1** — eight named hex
      entries, written into `marker-color.ts` as a literal, each clearing
      **3:1** against **every backdrop of `design.md` §6's enumerated set** —
      not against `--background` alone (round-5 Sol review, Important 8) —
      and carrying a label colour clearing **4.5:1** against its own fill
      (1.4.3). The body rule crosses four area fills that the base
      background does not account for: the weekend column
      `fill-muted-foreground/10` (`gantt-panel.tsx:2883`), the zebra band
      `fill-muted/40` (`:2903`), the pointed row's light `fill-(--grid-dep-lit)`
      (`:3983`) and today's column `fill-sky-500/15` (`:2950`). Three are
      translucent tints; **the pointed row's light is opaque** —
      `color-mix(in oklab, var(--ring) 20%, var(--background))`
      (`styles.css:259`) over two opaque inputs (`--ring` at `:118` light,
      `:149` dark) — so it _replaces_ what is beneath it rather than
      compositing over it, and treating all four as tints was this section's
      own first-draft error. Paint order is weekend, zebra, pointed, today, so
      the set is the **8** composites of the three tints without the pointed
      light, plus the **2** with it (which erase the weekend and zebra beneath
      and take only the optional today tint on top) — **10 per theme** over
      `--background` (`apps/fe-01/src/styles.css:100` light, `:131` dark — WCAG
      1.4.11, the non-text bar these are): **20 backdrops per
      entry**. The eight values and all 20 measured ratios each go into
      `verify.md`: they are a measured result, which is why `design.md` names
      the bars and the backdrops and leaves the hexes to this slice.
      Test: `libs/domain/src/marker-color.test.ts`, `expect(PALETTE).toHaveLength(8)`
      **first**, then a table case over every entry × every backdrop asserting
      both ratios. The backdrops are **computed, not pasted**: the test
      composites the three tints over each base with the standard source-over
      formula, takes the resolved `--grid-dep-lit` as an opaque surface in its
      own right, and asserts `expect(backdrops).toHaveLength(10)` per theme, so
      a fill dropped from the set fails on a count rather than
      silently shrinking the bar. **Three of the four fills are read from
      `styles.css` and the fourth is not**, which the first draft of this slice
      got wrong (Gemini round-6 Important 5): `--muted-foreground`, `--muted`
      and `--grid-dep-lit` are custom properties in
      `apps/fe-01/src/styles.css`, the same way the two bases are, so a theme
      change that darkened a band breaks this test rather than the chart — but
      `sky-500` is a **built-in Tailwind palette colour** (`#0ea5e9`) and
      appears zero times in `styles.css`, so today's tint is taken from
      Tailwind's palette and the literal is recorded in `verify.md` beside the
      ratios. The length assertion is not decoration: without it the
      ratio loop passes over an empty or one-entry palette, and the
      `palette.length` divisor in 3.1 would then make a constant function its
      own vectors could not distinguish from a correct one. Negative: one of the eight entries
      **replaced** — never appended — with a colour below 3:1 in dark, watched
      failing on the ratio assertion. Appending a ninth would trip
      `toHaveLength(8)` first and the run would never reach the ratio loop, so
      the observed failure would be an array length and not a contrast: a
      negative that fails earlier than the line it names proves nothing about
      that line. **Second negative, for the backdrop set and not for the
      palette:** the composite loop replaced by the two bases alone, watched
      failing `toHaveLength(10)` — and then, with the loop restored, an entry
      replaced by a colour that clears 3:1 against bare dark `--background` and
      fails it over the dark **weekend + today** composite, watched failing on
      that backdrop while the bare-base assertion stays green. That second half
      is the only thing that proves the widened set is load-bearing; without it
      a 20-backdrop loop whose extra 18 rows never bind is 18 rows of
      decoration. Eight rather than "a fixed palette": a count the
      test can iterate is checkable, an adjective is not.
- [ ] 3.3 `validateCustomColor(hex)` refusing a colour below the **3:1** bar
      **over the same 20 backdrops 3.2 measures**, and **naming the failing backdrop
      and the failing ratio** — the theme alone no longer identifies it, since
      a colour can clear bare dark and fail dark-over-weekend, and a refusal
      that said only "dark" would send the user hunting a fill it never named.
      Test: same file, a colour that clears 3:1 in light and fails it in dark,
      asserting the refusal names the dark base and `3:1`; and a second that
      clears every base and fails only over a composite, asserting the refusal
      names that composite.
      **There is no third case, and there cannot be: the 4.5:1 label bar is
      unfailable.** The ink is black or white, whichever contrasts more, and the
      two contrasts multiply to exactly 21 for every fill luminance, so the
      better is never below `sqrt(21) ≈ 4.583` (round-5 Sol review, Important 7,
      which made the ink a total function with no refusal arm). A test case for
      a colour "whose label contrast fails 4.5:1" could not be written, and this
      slice carried one until the round-6 Gemini review named it (Critical 2).
      **So this validator refuses on the 3:1 bar only**, and 3.2 is where the
      4.5:1 bar is asserted — as a property that holds for every entry, not as
      a refusal anything can trip.
      Negative: the validator returning `true` unconditionally, watched failing.
- [ ] 3.4 `validateCustomColor` wired into **both** write paths — the be-01
      create/recolour handlers and the composer — test: the controller test
      from 4.1 posts a sub-bar colour straight to the API, bypassing the
      composer, and asserts refusal with no row; `gantt-panel.test.tsx` asserts
      the composer refuses before submitting. **Both server write paths, and
      that means two cases and two faults.** Create: a sub-bar colour posted to
      `POST`, refused with no row; negative, the create-path call removed,
      watched writing the row while the UI test stays green. **Recolour:** a
      stored marker sent a syntactically **valid** hex that is below 3:1 in dark
      via `PATCH`, refused with the row byte-identical afterwards; negative, only
      the recolour-path call removed, watched writing the colour. A malformed
      hex does not cover this — it is refused by shape validation, so a recolour
      handler with no contrast check ships green past it, which is the gap the
      round-3 Sol review found. A validator unit-tested but never called on one
      of its two paths is the shape 3.1–3.3 would otherwise ship.
- [ ] 3.5 The composer issues the id, so the previewed colour is the created
      one — the composer generates a v4 UUID, renders `automaticColor(id)` as
      the swatch, and sends that `id` in the create body — test:
      `gantt-panel.test.tsx`, read the swatch's colour before submit and the
      created chip's colour after, and assert they are equal. Negative, and it
      must be a **front-end** fault: the composer generating a fresh UUID at
      submit instead of sending the one its preview was derived from, watched
      failing on unequal colours. **Both UUIDs are pinned and are chosen to land
      in different palette buckets**, and the id factory is injected so the test
      names them. A random replacement lands in the same one of eight buckets
      one time in eight, so an unpinned fault is present-and-green on one run in
      eight — a flaky negative is not a negative, and "passes by luck one time
      in eight" was this slice's own admission before the round-3 Sol review
      named it. Assert the exact id on the outgoing request too, so the test
      fails for the reason it is about. The server-side half of this guarantee cannot
      be observed here — `gantt-panel.test.tsx` runs in jsdom against the fake
      API and executes no be-01 code, so a fault injected into the controller
      leaves it green — and it is slice 4.4's, not this one's. Without a fault
      the assertion passes by luck one time in eight, which is the palette's own
      cardinality and not a test. See `design.md` §6.1 for why the other three
      options lost.

## 4. The API

- [ ] 4.1 `apps/be-01/src/controller/calendar-marker.controller.ts` — list,
      create, rename, recolour, delete, scoped to one project — test:
      `apps/be-01/src/controller/calendar-marker.controller.db.test.ts`, the
      five verbs round-tripped, list ordered by **`(date, created_at, id)`**,
      and a create with an out-of-horizon date accepted and returned. The third
      key is the slice's point: two markers created against a fixed clock tie on
      `(date, created_at)`, and a tie lets the order change between two reads of
      unchanged data. **The two ids are fixed in the reverse of their lexical
      order and inserted in that reverse order**, and the test asserts the
      explicit lexical sequence — not merely that two reads agree. Two reads of
      a tied pair can both come back in insertion order with `id` dropped from
      the `ORDER BY`, so an equality-of-two-reads assertion passes with the key
      gone whenever insertion order happens to match; that flakiness is the
      whole finding. Test: a fixed clock, two markers on one date with those
      ids, the list read twice, the exact sequence asserted both times.
      Negative: the `id` key dropped from the real `ORDER BY`, watched failing
      against SQLite rather than a stub — the tie-break is the database's, so a
      fake repository proves nothing about it.
- [ ] 4.2 Write permission — every mutation refused for a read-only actor with
      the same status the project's other writes use — test: same file, a
      read-only actor against each of the four mutations, asserting the status
      and that no row was written. Negative: the permission check removed from
      the create path, watched failing on the create case. A permission test
      that only checks the happy path is not a permission test.
- [ ] 4.3 A create whose `date` is not an `IsoDate` is refused with a typed
      422 rather than being coerced — test: same file, `2026-9-17`, `2026-09-17T00:00:00Z` and
      `not-a-date` each rejected. Negative: the validator replaced with a
      truthiness check, watched failing on the timestamp case, which is the one
      a truthiness check lets through. **Refused with a typed 4xx, not thrown.**
      A request body is untrusted data at the boundary, so this is the modelled
      path the repo's Elysia rule names — a throw here answers a client-side
      mistake with a 500. R5's "malformed trusted data throws" governs data
      already inside the trust boundary and does not reach an inbound body.
- [ ] 4.3a No instant is converted **on the client**, which is the only layer
      that can convert one — test: `gantt-panel.test.tsx` under a faked
      `TZ=Pacific/Auckland` at an instant whose UTC date is the day before,
      click the cell whose `data-axis-date` is `2026-08-19`, and assert the
      **outgoing create body** carries `date: '2026-08-19'`. Negative: the click
      handler routed through
      `new Date(day.date + 'T00:00:00').toISOString().slice(0, 10)`, watched
      failing with `2026-08-18` in the request — a **local**-midnight
      construction, which is the fault. `new Date('2026-08-19')` on its own is
      not: ECMAScript parses a date-only string as UTC, so that round-trip
      returns `2026-08-19` under any `TZ` and the negative would have been green
      (round-5 Sol review, Important 9).
      **This moved down a layer after the round-4 Sol review**, which was right
      that the round-3 version proved nothing. That version posted the literal
      string `'2026-08-19'` to the controller under a non-UTC `TZ` and asserted
      the same string came back — but be-01 stores the text it is given, so the
      assertion holds whatever the client does, and the fault the requirement
      is about (a `Date` round-trip turning the clicked day into its UTC
      neighbour) is entirely client-side and never reached. The server half is
      already covered: 4.3 rejects `2026-09-17T00:00:00Z`, so no instant can
      enter storage as a date at all.
- [ ] 4.4 The client-supplied `id`, its fallback and its collision — test: same
      file, three cases: a create carrying an `id` stores that exact id; a create
      omitting `id` is issued one by `Clock.newId()` (asserted through the fake
      clock the suite already injects); a create repeating an existing id is
      refused with no row added and the existing marker's name, date and colour
      unchanged. Negative for the last: the insert written as an upsert, watched
      overwriting the existing row. A duplicate-id test that only asserts an
      error status passes against an upsert that already destroyed the row.
- [ ] 4.5 Refusals name their field and apply nothing — test: same file, one
      case per row of the spec's eight-row refusal table — including both
      `name` boundaries, an empty string and `MARKER_NAME_MAX + 1 = 121` code
      points, with a 120-point name accepted so the cap is tested at its value
      and not merely well past it — each asserting the
      **exact status and reason code** for that failure and the failing field
      named, and that the stored marker is byte-identical to before the call.
      **Not "the project's existing refusal shape"**, which names nothing:
      `statusForRefusal(reason, otherwise)` (`refusal-status.ts:22-47`) shares
      four arms and takes each route's own default as `otherwise`, so a marker
      route with no stated default is unspecified (round-4 Sol review, Minor
      17). The marker routes' default is 422; `taken` is 409, `not_found` 404
      and `forbidden` 403 through the shared arms. Second negative: the marker
      routes' `otherwise` changed from 422 to 400, watched failing only the
      `malformed` and `contrast` rows while the three shared-arm rows stay
      green — which is what proves the table tests the default rather than the
      shared ladder.
      Negative: the rename writing before validating, watched leaving the new
      name behind after a refused call. "Refused" and "unchanged" are two claims
      and the second is the one a partial write breaks.
- [ ] 4.6 Project isolation, and a marker is not a work item — test: same file,
      two seeded projects each with markers: listing one returns none of the
      other's; a rename naming the other project's marker id is refused with
      both rows unchanged; and — replacing the round-3 cross-route id
      assertions — a **structural** pair: creating, renaming and deleting a
      marker leaves the `work_item` row count and contents unchanged, and
      **no statement issued by any marker route names the `work_item` table**.
      Negative: the `project_id` predicate dropped from the list query, watched
      returning the other project's markers. An isolation test written only
      against a single seeded project passes with no predicate at all. Second
      negative, for the structural half: a `work_item` read added inside the
      marker list handler, watched failing the reach assertion.
      **The structural assertion and its fault have to land in the same place,
      and until the round-5 Sol review (Important 10) they did not.** The
      assertion read the marker _repository_ source for a work-item import
      while the fault was injected in the _handler_ — which can import
      `WorkItemRepository` and read through it with the repository source
      staying clean, so the negative could not fail the assertion and the pair
      proved nothing. The assertion is therefore a **runtime SQL reach**, the
      same oracle 5.1a(c) uses and for the same reason: open the app's
      repository as `openDrizzle(path, { logQuery(query) { statements.push(query) } })`
      (drizzle's own hook, `project.db.test.ts:439-444`), drive create, list,
      rename and delete through the real routes, and assert no logged statement
      names `work_item`. A source scan is bounded by the file it scans; a SQL
      log is transitive and catches the read wherever in the
      controller→service→repository path somebody puts it.
      **Why the id form went:** ids are independent text primary keys and 4.4
      lets the client supply the marker id, so a client can submit an existing
      work item's id and "no marker id resolves through the work-item routes"
      becomes false by construction; the round-3 test passed only because its
      fixture ids matched no row anywhere, which is a test of nothing (round-4
      Sol review).
- [ ] 4.6a The client-supplied `id` must be a UUID v4 — test: same file, a
      create with `id: 'marker-1'` and one with a v1-shaped UUID each refused
      naming the `id` field, with the marker count unchanged after each.
      Negative: the UUID check replaced by a non-empty-string check, watched
      letting `'marker-1'` through and writing a row. This does **not** make the
      id spaces disjoint — nothing does, and the spec says so — it bounds the
      shape of what a client may name.

## 5. The schedule identity guarantee

- [ ] 5.1 The canonical schedule projection is identical with and without
      markers —
      test: `apps/be-01/src/controller/calendar-marker-identity.db.test.ts`.
      Capture the schedule for a seeded project, create five markers on dates
      inside its span, capture again, assert equality.
      **The projection is the whole response body with `seq` deleted — an
      enumerated field list is what went wrong three rounds running.** Rounds 3
      and 4 each named a set of schedule-bearing fields and each set was
      incomplete: the round-4 answer listed every `workItems[].schedule` and the
      slices and still omitted `workItems[].dates`, which `NumberedWorkItem`
      carries **separately from `schedule`** (`work-item.service.ts:512-525` —
      `schedule` is spans in workdays, `dates` is the calendar those spans land
      on, and a regression that moved only the calendar would pass), and still
      omitted the scheduling inputs the same read returns —
      `teamCapacities`, `priorityBands`, `estimateMethod`, `pertWeights`,
      `estimateRounding`, `depReach`, `startDate` and `projectRevision`
      (`:1246-1293`). A list that has to be maintained against a growing
      payload is a list that will be short again at the next field. So:
      **deep-equal the entire `GET /projects/:id/work-items` body, minus one
      deleted key.**
      **`seq` is the single exclusion and it is justified rather than
      asserted.** `tree()` carries the broadcast event `seq`
      (`work-item.service.ts:1147-1159`) and a marker mutation advances it by
      design, so a literal whole-body comparison is guaranteed to fail for a
      reason that is not the schedule. It is deleted from both captures, and the
      test asserts alongside the equality that `seq` **did** advance — which
      proves the deletion removed a moving field rather than masking a stale
      one. Every other field is compared, including the ones nobody thought of
      while writing this line: the claim being sold is "a marker moves nothing
      but `seq`", and that is exactly what a minus-one-key comparison states.
      `projectRevision` is deliberately **inside** the comparison, not outside
      it: markers never touch the project row (`:1293`), so it must not move,
      and holding it proves that rather than assuming it.
      Negative: **not** "marker dates appended to `notBefore`" — that is not
      compilable, since `notBefore` is `Map<string, number>` keyed by work-item
      id (`work-item.service.ts:1410-1420`) and a marker has no such id.
      Instead, seed one known work item and inject a floor derived from a
      marker's date onto **that id**, watched moving its start and failing the
      projection, then removed. `Proof:` comment naming the seeded id and the
      injected floor. Without a compilable injection this test cannot fail and
      is the sixteenth check again.
- [ ] 5.1a The scheduler seam is free of markers **at the seam and at the
      inputs** — test: same file, three assertions, because two equal captures
      cannot prove a path is absent (a path that is a no-op on the fixture
      passes) and a source scan of the engine cannot either.
      (a) The single production call site is
      `schedule(rows, edges, slices, notBefore, slotsOf, project.depReach)` at
      `work-item.service.ts:1458` — assert it still passes exactly those six
      arguments. (b) Assert `libs/domain/src/schedule.ts` contains no import
      from the marker module and no occurrence of the marker type name.
      (c) — **and this is the one that closes the hole (a) and (b) leave open,
      raised by the round-5 Sol review as Critical 1.** The six arguments are
      not built in `schedule.ts`; they are built in `WorkItemService.tree()` —
      `rows` at `:1298`, `edges` at `:1314`, `slotsOf` at `:1391`, `slices` at
      `:1400`, `notBefore` at `:1415`, and `project.depReach` off the project
      row. Marker-derived data can therefore be folded into `notBefore`,
      `slices` or `slotsOf` while the call site still passes **six** arguments
      and `schedule.ts` still contains **no** marker name, and (a) and (b) both
      stay green. So (c) is a **runtime reach assertion, not a source scan**:
      drive `GET /projects/:id/work-items` against a project **with markers**
      through a repository opened as
      `openDrizzle(path, { logQuery(query) { statements.push(query) } })` —
      drizzle's own hook, already used this way for statement counting at
      `project.db.test.ts:439-444` — and assert **no logged statement names
      `calendar_marker`**. A static scan of one file is bounded by that file; a
      SQL log is transitive, so it holds however many helpers the fold is
      hidden behind.
      Negatives, **four — one per check, plus the second input path**. Adding
      (c) in round 6 must not delete (a)'s and (b)'s faults, which is exactly
      what the first draft of this round did (Gemini round-6 Critical 3):
      (i) a seventh argument threaded through the adapter and ignored by the
      engine, watched failing **(a)** while 5.1's whole-body comparison stays
      green — which is the original reason this slice exists;
      (ii) an import of the marker type added to `libs/domain/src/schedule.ts`
      and referenced in a dead local, watched failing **(b)** while (a) and (c)
      stay green;
      (iii) a marker-derived floor written into `notBefore` for a seeded work
      item, read from `calendar_marker` inside `tree()`, watched failing **(c)**
      while (a) stays green;
      (iv) a marker-derived entry folded into `slotsOf` before `slicesOf` is
      called, read from the same table, also watched failing **(c)** — because
      Sol's objection names both an ordering input and a resource input and one
      alone leaves the other path unproven.
      `Proof:` comment naming, for (iii) and (iv), the logged statement each
      was caught by.
- [ ] 5.2 Markers stay out of a saved plan — test:
      `apps/be-01/src/repository/saved-plan-capture.db.test.ts`, a new case:
      capture a project with markers and a copy with none, assert the
      `input_sha256` values are equal. **This assertion passes on `main`
      today** — the capture reads a fixed set of tables that does not include
      `calendar_marker`, so equality holds before a line of this feature is
      written and the check as stated cannot fail. The reads are
      `readPlanInput()` at `saved-plan-capture.ts:162-216`;
      `:47-65` is the `PlanInputReads` interface those reads fill and is not
      where the fault goes (corrected after the round-3 Sol review). Negative:
      a `calendar_marker` read added inside `readPlanInput()` and its rows
      folded into the serialized payload that `input_sha256` is taken over,
      watched failing on unequal hashes, then removed. `Proof:` comment naming
      the added read and the payload field. Without that
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
      thing at risk. Negative: the click handler closing the day surface before
      opening the sheet, watched failing on the surface assertion — without it
      the case passes against an implementation that never opened the surface
      at all.
- [ ] 6.3 The day sheet: clicking a populated cell lists every marker on that
      date with rename, recolour and delete per row, plus an add action — test:
      same file, three cases: two markers on one date (both listed, add
      offered), exactly one marker (still a list, add still offered), and no
      markers (composer already open, name field focused). The one-marker case
      is the point of the slice — an implementation that shortcut a single
      marker straight to edit would pass the two-marker case and make a second
      marker unreachable, which is the conflict this resolves. Negative: the
      one-marker path shortcut straight to that marker's editor, watched failing
      the one-marker case while the two-marker case stays green — which is
      exactly how this defect would ship.
- [ ] 6.4 The dated cell becomes a control — `role="button"`, `tabIndex={0}`,
      Enter and Space handlers, a visible focus ring, `aria-haspopup="dialog"`,
      an `aria-expanded` tracking the sheet, and an `aria-label` naming the
      date and the marker count — test: `gantt-panel.test.tsx`, six cases, and
      the extra two are the ones the round-4 Sol review found unasserted: Enter
      opens the sheet; Space opens the sheet; a cell with two markers has an
      accessible name naming its date and reporting two; the cell carries
      `tabIndex={0}` and `aria-haspopup="dialog"`; `aria-expanded` is `false`
      before the sheet opens and `true` after — **the transition, not the
      attribute**, because an `aria-expanded` hard-coded to either value passes
      a single-state assertion; and the same cell after the sheet closes is
      `false` again. Negative: the Space handler removed, watched failing — a
      keyboard test written only for Enter passes against a `keydown` that
      forwards every key, and one written only for `tabIndex` passes against a
      focusable element nothing activates. The `<span>` is a `<span>` today
      because it was hover-only; a click without this contract ships a control
      no keyboard reaches (WCAG 2.1.1).
      **The visible focus ring is not in this slice** — jsdom computes no
      styles, so a focus-ring assertion here would pass against no ring at all.
      It moves to 9.2a's browser test.
- [ ] 6.4a The **undated** cell is a keyboard-operable control announcing an
      unavailable state — `role="button"`, `tabIndex={0}`,
      `aria-disabled="true"`, the same Enter and Space handlers, an accessible
      name naming the missing project start date, and no `aria-haspopup` or
      `aria-expanded` — test: same file, three cases: the cell is focusable and
      carries `aria-disabled="true"`; Enter on it opens no sheet and puts the
      refusal in the live region; and it carries neither `aria-haspopup` nor
      `aria-expanded`. Negative: `tabIndex` removed from the undated branch,
      watched failing the Enter case, because an unfocusable element never
      receives the key.
      **Why this slice exists:** an earlier draft made the undated cell inert
      (no role, no tab stop, no key handler) _and_ required 6.5's live-region
      announcement — a contradiction, since the only element that fires the
      refusal was unreachable by exactly the users the live region serves. It
      is `aria-disabled`, not `disabled`, because a disabled control leaves the
      tab order and a user who cannot reach it is never told why it is dead.
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
      Negative: `date: null` replaced with
      `date: addWorkdays('2026-01-01', workday)` inside `workdayAxis`, watched
      failing — the plausible "helpful" change that would make every refusal in
      section 7 unreachable while every one of its tests kept passing, because
      a live cell refuses nothing.
      **Named as a fixed synthetic origin and not as "the project's creation
      timestamp", which was not compilable** (round-5 Sol review, Important
      14): `workdayAxis(horizon: number)` takes a number and nothing else
      (`gantt-panel.tsx:1047`), and `GanttProps` carries no creation timestamp
      (`:1993-2117` — and `createdAt` and `creation` each appear **zero** times
      in the whole module, which is the check that settles it rather than a
      reading of one interface), so that fault could only be written by widening two
      interfaces — a different change, not a mutation of this one. A literal
      origin needs no new input and no new import: `addWorkdays` is already
      imported into this module at `:4` for `calendarAxis`, and the mutated
      cell's `date` is non-null, which is what the assertion tests.
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
      Negative: the click handler's dated branch removed so no cell ever opens
      the composer, watched failing here while 7.2's refusal case stays green —
      which is the exact pair that makes this slice load-bearing rather than a
      restatement of 6.1.
- [ ] 7.4 No marker can reach storage against a workday number — and the guard
      is the **`IsoDate` validator of 4.3, not a check on the project's start
      date.** A workday number is not an `IsoDate`, so 4.3 already refuses it;
      a `startDate === null` check would refuse something else entirely, and
      wrongly. A marker's date is absolute, so it is storable on a project with
      no start date — it simply has no axis to draw on until one exists, which
      is the same "stored, not drawn" rule an out-of-horizon marker gets. Test:
      `apps/be-01/src/controller/calendar-marker.controller.db.test.ts`, two
      cases against a project with **no start date**: a create carrying the
      workday number `7` as its date is refused with no row, and a create
      carrying `2026-08-19` **succeeds** and is returned by the list. Negative:
      the `IsoDate` validator removed from the create path, watched storing `7`.
      The second case is the point — it is what stops this slice from being
      re-read as "an undated project accepts no markers", which is the
      contradiction the earlier wording carried into `design.md` §1.

## 8. Drawing

- [ ] 8.0 `axisOffsetOf(axis, date)` — `todayOffset` (`gantt-panel.tsx:872`,
      body `axis.find((day) => day.date === today)?.offset ?? null`)
      generalised to any `IsoDate`, with today rewired as its first caller so
      there is one lookup rather than two that can disagree — test:
      `gantt-panel.test.tsx`, a date present in the axis, one absent (null),
      and today's existing assertions still green through the new callee.
      **`CalendarScale` is not the seam:** `startOf`/`endOf` are
      `(workday: number) => number` (`gantt-geometry.ts:864-880`), so an
      absolute date is already past that conversion.
      **The negative needs a hand-made axis, and the round-3 version did not
      have one.** `todayOffset` takes `(axis, today)` and no `origin`, so
      "reimplemented as `calendarDaysBetween(origin, date)`" is not observable
      against the stated seam: on any ordinary axis the stored `offset` equals
      the calendar distance from `axis[0].date`, so both implementations return
      the same number and the mutant passes (found by the round-4 Sol review).
      Negative: build an axis whose matching cell's `offset` differs from
      **both** its array index and its calendar distance from `axis[0].date` —
      e.g. three cells dated `2026-08-10`, `2026-08-11` and `2026-08-12`
      carrying offsets 0, 7 and 9, where looking up the third must give **9**,
      not its index 2 and not its calendar distance 2 —
      then swap the lookup for `calendarDaysBetween(axis[0].date, date)` and
      watch it fail. This is the second-scale drift `todayOffset`'s own
      docstring warns about, made observable.
- [ ] 8.1 The chip in the axis band, placed by `axisOffsetOf` — test:
      `gantt-panel.test.tsx`, a marker on `2026-08-19` asserted at the calendar
      x, not the workday x. Negative: the chip placed by workday number,
      watched failing — this is the drift `gantt-calendar-axis` exists to
      prevent and the fixture is chosen so the two numbers differ.
- [ ] 8.2 The rule takes its named slot in `marksOverLight` — **not merely
      "behind the bars"**, which orders the marker against one of the five marks
      the body paints and leaves the other four undecided. Emitted after
      `data-gantt-today-edge` and before the row hit lines and every bar
      (`design.md` §2.1 carries the full thirteen-row table) — test:
      `gantt-panel.test.tsx`, one assertion over the DOM order of
      `data-gantt-weekend`, `data-gantt-today`, `data-gantt-gridline`,
      `data-gantt-today-edge`, `data-gantt-marker-rule` and the first
      `data-gantt-bar`, asserting exactly that sequence; a second asserting the
      rule carries `pointer-events: none`; plus a bar crossing the rule keeping
      its `x`, `width` and
      critical-path class **unchanged from the same plan with no marker**.
      Negative: the rule emitted at the top of `marksOverLight`, watched failing
      the sequence while the unchanged-bar half stays green — which is the point,
      because a rule above the gridlines is still behind every bar.
      **Plus the shared-date colour, which nothing else tests:** two markers on
      one date with distinct colours, asserting exactly one rule element at that
      offset and its `stroke` equal to the **first** marker's colour by
      `(created_at, id)`. Negative: the selection inverted to the date's last
      marker, watched failing on the `stroke` while the count of rules stays
      one — the count alone cannot see which colour won. The
      unchanged-bar half is the requirement; the sequence is the mechanism, and
      it needs its own assertion because the requirement cannot see it.
- [ ] 8.3 `MARKER_RULE_MAX_PER_100PX` and the 4px suppression — the constant is
      **6**, and the measure is `occupiedDatesInViewport / viewportWidthPx * 100`
      compared with `>` (`design.md` §3: 100px is 25 days at that rung, so six is
      one rule per ~16px and seven puts two inside one heavy-gridline week) —
      test: same file, four cases at 4px per day. Seven **distinct dates** within
      a 100px viewport asserted to draw no rules and every chip; six distinct
      dates asserted to draw exactly six rules — the boundary, which `>` includes;
      **seven markers all on one date** asserted to draw one rule and no
      suppression, because the count is rule positions and a shared date is one
      position; and at 28px per day, where a 100px window spans 3.6 days and so
      holds at most four rules, the threshold asserted unreachable. Negatives,
      two, because there are two independent ways to get this wrong: the
      threshold read as `>= 6`, watched failing the six-date case; and the
      density counted over markers instead of occupied dates, watched failing
      the seven-markers-one-date case while every other case stays green — which
      is the one the old wording would have shipped.
      **No 12px case asserts unreachability**, deliberately: 100px spans 8.3
      days there and holds up to nine rules, so the threshold is reachable and
      the old claim that it was not was false. Suppression is scoped to the 4px
      rung, and a 12px case asserting "rules always draw" would be asserting the
      rung scope, not the constant.
- [ ] 8.4 Overflow collapses to a count with the list on hover or tap —
      `MARKER_BAND_MAX_PER_CELL` is **3** at 28px, **2** at 12px and **1** at
      4px, and the collapsed cell renders `+N` for the markers it did not show —
      test: same file, one case per rung with one marker more than that rung
      allows, asserting the chips shown, the `+N` text and the full list on
      hover. Negative: the rung ladder replaced by a single constant of 3,
      watched failing at 4px, where three chips do not fit a four-pixel cell.
      A threshold tested at one rung is not a ladder.
- [ ] 8.5 A marker outside the current horizon draws nothing and is still
      returned by the API — test: same file plus the controller test from 4.1,
      and the **return trip**: lengthen the plan so the horizon covers that date
      again and assert the chip is drawn at its axis offset. Negative: the
      absent-date branch in `axisOffsetOf` changed to throw, watched failing the
      shortened case. Half of this behaviour is "still stored", which is not
      observable on the panel at all, and half is "drawn again", which a test
      that only shortens the plan never reaches.
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
      behaviour. Two renderers agreeing is only a guarantee if a test can see
      them disagree.
      **The negative cannot be "the export's own rule-drawing branch made
      unconditional": there is no such branch.** 8.6 says why — the body rule
      lives inside the nested live chart SVG that `buildStandaloneGanttSvg`
      embeds, so it carries over for free and the export never draws one. A
      mutation of code that does not exist is not injectable (Gemini round-5).
      Negative instead: the suppression predicate dropped from the **live**
      chart while the export path is untouched, watched failing this slice with
      rules in the exported markup — because the export copies whatever the live
      chart drew, which is the coupling this slice is about.

- [ ] 8.8 A marker on today and a marker on a weekend — test: same file, two
      cases: a marker on today's date, asserting its rule element **follows**
      `data-gantt-today-edge` and that the `data-gantt-today` tinted column is
      still present at that offset; and a marker on a Saturday, asserting its
      rule follows that day's `data-gantt-weekend` column and the column is
      unchanged from the same plan without the marker. These are the two
      collisions `design.md` §2.1's slot decides, and the today case is the one
      whose opposite ordering would have hidden a marker the user just placed.
      Negative: the rule emitted before `data-gantt-today-edge`, watched failing
      the today case while every other paint assertion stays green.

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
      Negative: the rule's `stroke` bound to the chart background colour,
      watched failing the "see the rule" step while every jsdom position
      assertion in section 8 stays green — an element present at the right `x`
      with the wrong paint is precisely what only a browser catches, and this
      slice had no injected fault at all (round-4 Sol review).
- [ ] 9.2a The **visible focus ring** on a dated axis cell — its own slice, in
      the same file, because sharing 9.2's meant sharing 9.2's negative and the
      negative there mutates the marker rule's stroke, which the focus ring
      cannot observe: the ring had no injected fault of its own (round-5 Sol
      review, Important 16). Test: tab to a dated cell and assert the computed
      focus indicator **as a transition** — read `outline-style`,
      `outline-width` and `box-shadow` off the cell before it is focused and
      again while it holds focus, and assert they differ and that the focused
      reading is not `none`/`0px`. A static "the outline is not none" passes
      against a global reset that outlines everything permanently, which is not
      a focus indicator.
      Negative: the `focus-visible` classes removed from the dated cell,
      watched failing on the two readings being equal — while 9.2's round trip
      and every jsdom assertion in section 6 stay green, since neither can see
      a computed style (jsdom computes none). Kept separate from 9.2's stroke
      mutation on purpose: two guarantees in one slice share whichever fault is
      injected, and the one that shares gets no proof.
- [ ] 9.3 A second client re-reads on the event — **mounting `WbsTable`, not
      `GanttPanel`.** `GanttPanel` has no stream at all; the project stream is
      `WbsTable`'s `subscribe` prop (`wbs-table.tsx:225`) and the scope it
      re-reads comes from `readScopeFor` (`:280`), so a test that mounted the
      panel could not deliver the event.
      **`readScopeFor` needs no arm, and this is the second correction to this
      slice.** Read it: `wbs-table.tsx:280-286` matches `tree_replaced` and the
      three step events and **returns `'all'` for everything else**, and its
      JSDoc says that is deliberate — "a new `ProjectEvent` added in be-01 is
      correct here before anybody edits this". So `calendar_markers_changed`
      already takes the full read, an added arm would be dead code, and the
      round-3 negative ("that arm removed, watched failing") was not a
      compilable mutation: there is no arm to remove and deleting nothing
      changes nothing (found by the round-4 Sol review).
      Test: the existing `WbsTable` stream harness in `gantt-panel.test.tsx`,
      deliver the event with the marker list changed underneath, and assert the
      new chip appears with no remount and no reload. Negative, and it is a real
      one-line mutation: add an arm to `readScopeFor` returning the `'tree'`
      scope for `calendar_markers_changed`, which excludes the marker read,
      watched failing with the stale chip still on screen. That is also
      the realistic future defect, somebody narrowing the new event for speed.
      9.1 counts emissions, which is a broadcast into an empty room until
      something acts on it — this slice is the half that makes the content-free
      event design work at all, and it was specified backend-side with nothing
      proving the client side.

## Gate

- [ ] G Record the actual output of `bunx nx run-many -t test lint typecheck`
      in `verify.md`, with the failure-proof table: for every negative named
      above, the fault injected, the test that observed it failing, and the
      result. A check with no observed failure is not done.
