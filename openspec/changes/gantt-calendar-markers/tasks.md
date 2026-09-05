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
      `fill-muted-foreground/10` (`gantt-panel.tsx:2888`, on the rect whose
      `data-gantt-weekend` is at `:2883`), the zebra band `fill-muted/40`
      (`:2908`, attribute `:2903`), the pointed row's light
      `fill-(--grid-dep-lit)` (`:3988`, attribute `:3983`) and today's column
      `fill-sky-500/15` (`:2955`, attribute `:2950`) — **the class sits five
      lines below the attribute on each of the four**, and the first draft of
      this slice cited the attribute line for the class. Three are
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
- [ ] 3.2a `labelInk(fill)` — the chooser itself, which nothing above tests
      (round-19 Gemini review, Important). 3.2 asserts that each palette entry
      **carries** a label colour clearing 4.5:1: a literal checked against a
      literal. The requirement is that the ink is **chosen** — "black or white,
      whichever contrasts more with the chip fill", a total function with no
      refusal arm (`spec.md`, the label-ink requirement) — and a chooser
      hard-coded to one of the two agrees with every recorded label on the half
      of the palette that ink happens to win, so 3.2 is green with the algorithm
      absent. Signature: `labelInk(fill: string): '#000000' | '#ffffff'`, in
      `marker-color.ts` beside the palette.
      Test: `libs/domain/src/marker-color.test.ts`, a table over all eight
      entries asserting `labelInk(entry.fill)` equals that entry's **recorded**
      label and is the higher-contrast of the two — one assertion binding the
      two sources of truth 3.2 leaves unrelated — plus both ends of the sRGB
      cube.
      **Totality is the return type plus the crossover case, not an assertion
      that it never throws.** The two contrasts multiply to exactly 21 for every
      fill luminance, so they are equal at `L = sqrt(0.0525) - 0.05 ≈ 0.1791`
      and one is strictly larger everywhere else; the union return has no third
      member, and the crossover is the only input at which a chooser written as
      a strict inequality can fall through both arms. Case: a fill whose
      luminance is within `1e-6` of it, asserting the call returns one of the
      two members and that its ratio still clears 4.5:1.
      Negatives, two. `labelInk` hard-coded to `'#ffffff'`, watched failing on
      the palette's lightest entry — where black wins — while all twenty of
      3.2's ratios stay green, since 3.2 reads the recorded label and never
      calls this function. And the comparison inverted to the **lower** ratio,
      watched failing at both ends of the cube while the crossover case stays
      green: at the crossover the two ratios are equal and either answer passes,
      which is what proves the crossover case is a totality check and not the
      discrimination.
- [ ] 3.3 `validateCustomColor(hex)` refusing a colour below the **3:1** bar
      **over the same 20 backdrops 3.2 measures**, and **naming the failing backdrop
      and the failing ratio** — the theme alone no longer identifies it, since
      a colour can clear bare dark and fail dark-over-weekend, and a refusal
      that said only "dark" would send the user hunting a fill it never named.
      Test: same file, a colour that clears 3:1 in light and fails it in dark,
      asserting the refusal names the dark base and `3:1`; and a second that
      clears every base and fails only over the **dark weekend + today**
      composite — the same surface 3.2's second negative uses — asserting the
      refusal names that composite.
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
      **Third case, and it is the one that makes "the same 20" true rather than
      asserted:** the validator SHALL read its backdrops from a single exported
      `MARKER_BACKDROPS` table in `marker-color.ts` — the same table 3.2
      iterates — and the case asserts that table **is** the derived set: 20
      entries, 10 per theme, each naming its composite and its resolved colour,
      deep-equal to the set §6 derives from `styles.css`. Until now the two
      previous cases exercised one failing base and one failing composite and
      the negative mutated the validator to return `true`, so **a validator that
      checked exactly those two surfaces and skipped the other 18 passed every
      named case** — "the same 20 backdrops 3.2 measures" was maintained by this
      sentence and by nothing executable (round-9 Sol review, Important).
      **Fourth case, because the table case proves the table and not the
      validator.** The deep-equality assertion and its deletion fault both live
      on `MARKER_BACKDROPS` itself, so **a validator that merely imports the
      table and then measures only the two entries the colour cases exercise
      passes all three** — the table is complete, the two named surfaces still
      refuse, and production skips 18 (round-11 Sol review, Important). The
      observer therefore has to be a **validator result** over an entry no other
      case names: a colour that clears 3:1 over 19 of the 20 backdrops and fails
      only over the **light theme's pointed-row light under the today tint**,
      asserted refused with the refusal naming that backdrop. That entry is one
      of the two the pointed light contributes as its own opaque surface, so it
      is a third distinct surface and neither case above can stand in for it —
      and it is the entry a validator that composites the three tints over
      `--background` and stops there never builds at all.
      Negatives, three: the validator returning `true` unconditionally, watched
      failing; **one entry deleted from `MARKER_BACKDROPS`**, watched failing the
      table case — a fault the two colour cases cannot see, because a colour that
      fails over the dark base still fails with 19 entries in the table; and
      **the validator's loop narrowed to the two backdrops the first two cases
      name**, the bare dark base and the dark weekend + today composite, watched
      failing the fourth case alone. That third fault leaves `MARKER_BACKDROPS`
      byte-identical, so the deep-equality case stays green — which is what makes
      it the fault that separates "the table holds 20 entries" from "the
      validator measures against 20", and the deletion fault above cannot
      substitute for it because it moves the table rather than the loop.
- [ ] 3.4 `validateCustomColor` wired into **all three** call sites — the be-01
      create handler, the be-01 recolour handler and the composer — test: the
      controller test from 4.1 posts a sub-bar colour straight to the API,
      bypassing the composer, and asserts refusal with no row;
      `gantt-panel.test.tsx` asserts the composer refuses before submitting.
      **The two server paths are separate cases with separate
      faults.** Create: a sub-bar colour posted to
      `POST`, refused with no row; negative, the create-path call removed,
      watched writing the row while the UI test stays green. **Recolour:** a
      stored marker sent a syntactically **valid** hex that is below 3:1 in dark
      via `PATCH`, refused with the row byte-identical afterwards; negative, only
      the recolour-path call removed, watched writing the colour. A malformed
      hex does not cover this — it is refused by shape validation, so a recolour
      handler with no contrast check ships green past it, which is the gap the
      round-3 Sol review found. A validator unit-tested but never called on one
      of its call sites is the shape 3.1–3.3 would otherwise ship.
      **Three call sites, so three faults: the composer needs its own.** Both
      faults above are be-01 handler removals, so the composer arm of this
      slice was asserted and never proved — `validateCustomColor` can be
      correctly wired on both routes and fully unit-tested while the composer
      never calls it at all, and every negative here would still be watched
      failing (round-6 Sol review, Important 8). Third fault: **only the
      composer call removed**, watched failing on the **outgoing create body**
      carrying the sub-bar colour — same oracle as 4.3a, a fake API that
      records what it was sent. The oracle has to be the request, not the UI:
      with the server calls intact the API refuses the colour either way, so a
      "the user sees a refusal" assertion is green under the fault and only
      "nothing invalid left the client" is not.
      **"Nothing left the client" is not the whole composer contract either**
      (round-12 Sol review, Important). 3.3 proves `validateCustomColor` names
      the failing backdrop, and this slice's only composer oracle is the absent
      request — so **a composer that calls the validator, suppresses the request
      and then renders a generic "invalid colour" passes every named test here
      while violating both composer scenarios**, which require the user to be
      told which fill the colour failed over. Fourth case: submit 3.3's fourth
      colour — the one failing only over the light pointed-row light under the
      today tint — and assert the **rendered** refusal text names that backdrop
      and `3:1`. Fourth fault, and it is a **consumer** fault rather than
      another removal: the composer discarding the validator's backdrop name and
      substituting a fixed string, while still suppressing the request — watched
      failing the new case alone, with the three request-body assertions above
      staying green. The 19-of-20 colour is deliberate: a message naming the
      dark base could be produced by a composer that only knows about themes.
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
      **This slice also houses 3.1's two caller-injected faults, and it has to
      say so** — 3.1(b) and 3.1(c) cannot live in `marker-color.test.ts`
      (`automaticColor(markerId: string)` sees neither a name nor a date), so
      this file carries their cases and this slice is where the implementer
      finds that out (round-7 Gemini review, Minor 1). Two more assertions on
      the round trip, both on markers with **automatic** colours: **rename
      stability** — create, read the colour, rename, read again, assert equal,
      which 3.1(b)'s `marker.name`-for-`marker.id` fault fails; and **same-date
      distinctness** — two markers created on one date, assert their colours
      differ, which 3.1(c)'s `marker.date` fault fails. Neither needs a fault of
      its own here: they are 3.1's oracles, and 3.1 names the mutations.
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
      unchanged. Negatives, two. For the last: the insert written as an upsert,
      watched overwriting the existing row — a duplicate-id test that only
      asserts an error status passes against an upsert that already destroyed
      the row. And for the first, **the server fault `design.md` §6.1 named and
      no slice owned** (round-12 Sol review, Minor): the create ignoring the
      supplied `id` and calling `clock.newId()`, watched failing the exact-id
      case. §6.1 named it while 3.5 requires a **front-end** fault and delegates
      the server half here, so until now it was owed by neither slice and the
      exact-id case was a positive with nothing watching it. It belongs here
      because this is the only file that executes be-01 code.
- [ ] 4.5 Refusals name their field and apply nothing — test: same file, one
      case per row of the spec's eight-row refusal table — including both
      `name` boundaries, an empty string and `MARKER_NAME_MAX + 1 = 121` code
      points, with a 120-point name accepted so the cap is tested at its value
      and not merely well past it, and **both boundary fixtures built from
      astral characters** — each asserting the
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
      **Why astral, and it is the difference between testing the cap and
      testing nothing:** the spec counts `MARKER_NAME_MAX` in Unicode **code
      points** "so an emoji costs one", and ASCII or BMP fixtures cannot tell
      that apart from `name.length` — 120 ASCII characters are 120 UTF-16 units
      too, so the broken implementation accepts and rejects exactly where the
      correct one does and both boundary cases pass (round-7 Sol review,
      Important). The fixtures are therefore **120 and 121 astral characters**
      (a surrogate pair each, so `name.length` reads 240 and 242), and the
      third negative is **code-point counting replaced by `name.length`**,
      watched failing the 120-character **acceptance** case — which is the
      direction that matters: a user is refused a name the spec allows.
      Negative: the rename writing before validating, watched leaving the new
      name behind after a refused call. "Refused" and "unchanged" are two claims
      and the second is the one a partial write breaks.
- [ ] 4.6 Project isolation, and a marker is not a work item — test: same file,
      two seeded projects each with markers: listing one returns none of the
      other's; a rename naming the other project's marker id is refused with
      both rows unchanged; and — replacing the round-3 cross-route id
      assertions — a **structural** pair: creating, renaming, **recolouring**
      and deleting a marker leaves the `work_item` row count and contents
      unchanged, and **no statement issued by any marker route names the
      `work_item` table**. Negative: the `project_id` predicate dropped from the
      list query, watched returning the other project's markers. An isolation
      test written only against a single seeded project passes with no predicate
      at all. **The structural half has two negatives, and they are named
      apart** (round-14 self-review): the **list-handler read** — a `work_item`
      read added inside the marker list handler, watched failing the reach
      assertion — and the **recolour-branch read** described below. Round 13
      added the second while this sentence still called the first "the second
      negative", leaving one label on two faults — and the verb
      list here still said "creating, renaming and deleting" while the drive
      below and `spec.md`'s scenario had both gained recolour, so an implementer
      reading only this sentence would write back the exact hole round 13
      closed.
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
      rename, **recolour** and delete through the real routes, and assert no
      logged statement names `work_item`. A source scan is bounded by the file it
      scans; a SQL log is transitive and catches the read wherever in the
      controller→service→repository path somebody puts it.
      **Recolour is in that list because leaving it out reopened the hole one
      verb down** (round-13 Sol review, Important). Rename and recolour share one
      `PATCH` endpoint, which is what makes the _project scope_ one predicate —
      but they still take body-specific branches inside it, so a `work_item` read
      reached only on the colour branch passes a reach case that drives rename
      and every contrast and round-trip test besides. The structural half's
      **second** negative — the recolour-branch read, as distinct from the
      list-handler read above — is therefore injected **in the recolour branch
      specifically**, and watched failing the reach assertion while the rename
      drive stays green.
      **Why the id form went:** ids are independent text primary keys and 4.4
      lets the client supply the marker id, so a client can submit an existing
      work item's id and "no marker id resolves through the work-item routes"
      becomes false by construction; the round-3 test passed only because its
      fixture ids matched no row anywhere, which is a test of nothing (round-4
      Sol review).
      **Third case, and it covers the only mutating route the two above do not:
      a cross-project DELETE.** Both cases here exercise rename, and rename and
      recolour reach the server as two bodies through one `PATCH` — so scoping
      that patch scopes both, and the delete is left as a separate route with a
      separate predicate that nothing named. **A delete matched on marker id
      alone removes project B's row through project A's route while every case
      above passes** (round-11 Sol review, Important). Case: `DELETE` on project
      A naming project B's marker id, asserting `not_found`, that B's row is
      still returned by B's list, and that A's own markers are unchanged. Third
      negative, and it must be the delete path's own: the `project_id` predicate
      dropped from the **delete** statement only, watched failing this case with
      B's row gone, while the list query, the patch route and both cases above
      stay green — a fault the first negative cannot reach, because it mutates
      the list predicate and the delete never runs through it.
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
      it: nothing in this change writes the project row, so `projectRevision`
      must not move, and holding it inside the comparison is what proves that
      rather than assuming it. **No line citation is attached to that claim**,
      because there is none to attach: `work-item.service.ts:1293` only declares
      `projectRevision: number` and says nothing about which tables a marker
      write touches (round-6 Sol review, Minor 15). It is an invariant this test
      establishes, not a fact read off existing source.
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
      **The three cases prove the rows and the actions are PRESENT and nothing
      invokes them** (round-12 Sol review, Important). Rename and recolour are
      offered here and proved nowhere on the client: 4.1 proves the be-01 routes
      and the browser round trip creates and deletes, so **a sheet whose rename
      and recolour handlers are inert passes every named test in this plan**.
      Two more cases, each driving the action from the sheet: rename a listed
      marker and assert both the new name in the reopened list and the outgoing
      `PATCH` body carrying `{ name }` and nothing else; recolour one and assert
      the chip's new `stroke`/fill and a `PATCH` body carrying `{ color }`. The
      oracle is the fake API's recorded request as well as the DOM, for 3.4's
      reason: a handler that repaints optimistically and sends nothing is green
      on a DOM-only assertion. Negatives, one dead handler at a time: the rename
      action's `onClick` emptied, watched failing the rename case while the
      recolour case, the delete path and all three listing cases stay green; and
      the recolour action's emptied, watched failing only the recolour case. One
      fault for both would not distinguish them, which is the state this slice
      is in now.
      **The add action is the third one that is offered and never used**
      (round-13 Sol review, Important). The requirement says it opens an empty
      composer on the same date; 6.1 reaches a composer by clicking an **empty**
      date, and the three listing cases assert only that the action is offered —
      so a populated sheet with an inert Add handler passes every named case in
      this plan. Sixth case: click Add on a date that already holds a marker and
      assert an empty, focused name field bound to **that** date. Third
      dead-handler fault: the add action's `onClick` emptied alone, watched
      failing that case while rename, recolour, delete, the three listing cases
      and 6.1's empty-date composer all stay green — 6.1 cannot cover it,
      because it never goes through the sheet.
- [ ] 6.4 The dated cell becomes a control — `role="button"`, `tabIndex={0}`,
      Enter and Space handlers, a visible focus ring, `aria-haspopup="dialog"`,
      an `aria-expanded` tracking the sheet, and an `aria-label` naming the
      date and the marker count — test: `gantt-panel.test.tsx`, **seven** cases,
      and the extra three are the ones successive Sol reviews found unasserted:
      Enter
      opens the sheet; Space opens the sheet; a cell with two markers has an
      accessible name naming its date and reporting two; the cell carries
      `tabIndex={0}` and `aria-haspopup="dialog"`; `aria-expanded` is `false`
      before the sheet opens and `true` after — **the transition, not the
      attribute**, because an `aria-expanded` hard-coded to either value passes
      a single-state assertion; the same cell after the sheet closes is
      `false` again; and **the cell is located by `role="button"` and its
      accessible name** rather than by test id, which is the case that makes
      the role an assertion instead of prose.
      Negatives, two: the Space handler removed, watched failing — a
      keyboard test written only for Enter passes against a `keydown` that
      forwards every key, and one written only for `tabIndex` passes against a
      focusable element nothing activates; and **`role="button"` removed from
      the dated branch alone**, watched failing the role-and-name case while
      every other case stays green, because `getByRole` is the only query in
      the slice that can see it. The `<span>` is a `<span>` today
      because it was hover-only; a click without this contract ships a control
      no keyboard reaches (WCAG 2.1.1).
      **The role is asserted here for the same reason it is in 6.4a**, and it
      was missing here for one round longer: a focusable generic `<span>`
      carrying every listed handler and ARIA attribute passed all six previous
      cases while never being announced as a button, because none of them
      queried by role (round-9 Sol review, Important). The dated cell is the
      branch a user actually operates, so the gap mattered more here than on
      the branch that already had it.
      **The visible focus ring is not in this slice** — jsdom computes no
      styles, so a focus-ring assertion here would pass against no ring at all.
      It moves to 9.2a's browser test.
- [ ] 6.4a The **undated** cell is a keyboard-operable control announcing an
      unavailable state — `role="button"`, `tabIndex={0}`,
      `aria-disabled="true"`, the same Enter and Space handlers, an accessible
      name naming the missing project start date, and no `aria-haspopup` or
      `aria-expanded` — test: same file, **five** cases: the cell is focusable
      and carries `role="button"` and `aria-disabled="true"`; **its accessible
      name contains both its workday position and the words naming the missing
      project start date**, located by role and name rather than by test id;
      Enter on it opens no sheet and puts the refusal in the live region;
      **Space on it does the same**; and it carries neither `aria-haspopup` nor
      `aria-expanded`.
      **The role and the name are assertions, not preamble** — an
      implementation with the tab stop and both handlers but a missing or
      generic accessible name, and with no `role="button"` at all, passed every
      case this slice named until now, because none of them looked (round-8 Sol
      review, Important). The name is half the contract: §6's own argument for
      giving these cells a tab stop is that a row of stops all announced
      "button" is worse than no stop, so a generic name is the failure mode the
      contract exists to prevent, not a cosmetic gap.
      **Space is a case here and not only in 6.4**, because this branch is a
      separate one: three cases covering focusability, Enter and ARIA leave a
      defect that ignores Space on the **undated** branch green, while 6.4's
      dated-cell Space test keeps passing and hides it (round-7 Sol review,
      Important). This slice promises "the same Enter and Space handlers" and
      until now proved only one of them.
      Negatives, four: `tabIndex` removed from the undated branch, watched
      failing the Enter case, because an unfocusable element never receives the
      key; **Space removed from the undated branch only**, watched failing the
      Space case while Enter, the ARIA cases and all of 6.4 stay green;
      `role="button"` removed from the undated branch, watched failing the
      role/name case at the point where it locates the cell by role; and the
      `aria-label` replaced by the bare generic string `Day`, watched failing
      the name half while the role, both key cases and both ARIA-absence cases
      stay green — a removal and a generic label are different defects and the
      generic one is the likelier.
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
      `date: null`, **not** routed through the panel.
      **`workdayAxis` must be exported first, and it is not today.** It is a
      module-local `function workdayAxis(horizon: number): AxisDay[]` at
      `gantt-panel.tsx:1047`, so no separate test module can call it and the
      direct assertion as written has no seam (round-6 Sol review, Important
      10). This slice therefore also exports `workdayAxis` and the `AxisDay`
      type. Exporting a pure function for a test is the cheap end of the
      alternatives — the other being to extract an axis-builder module — and the
      directness is the point of the slice: routed through the panel, the same
      assertion goes green the moment some future change gives every project a
      start date, which is exactly the regression it exists to catch. Asserted directly so a
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
      missing project start date, and no composer opens — test: same file, three
      assertions: the refusal message is present **and** names the missing
      start date, no composer is in the document, and **the fake API received no
      create call**.
      **"No marker is written" IS observable here, and the earlier reading that
      it was not is what left the hole** (round-11 Sol review, Minor). The claim
      was that a click only opens a composer and only a submit writes, so the
      storage half belonged to 7.4 — but that argues from the correct
      implementation, which is the one a negative is supposed to break. A click
      path that synthesised an `IsoDate` and posted straight through would leave
      the message rendered, no composer in the document, and this test green;
      7.4 cannot catch it either, because its guard is the `IsoDate` validator
      and a synthesised date is a valid one. The fake API's call log is right
      there in the same fixture, so the assertion costs one line.
      Negative: the refusal branch removed, watched failing on both remaining
      halves (a composer opened, and no message was rendered). Second negative,
      and it is the one the first cannot reach because it leaves the refusal
      branch intact: the refusal path also issuing a create for the clicked cell
      with today's date, watched failing the no-create assertion alone while the
      message and composer assertions stay green.
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
      **Plus the chip's label ink, because 3.2a's chooser otherwise has no call
      site** (round-20 Gemini review, Important). `labelInk` unit-tested and
      never called is the shape 3.4 already refuses for `validateCustomColor`:
      a chip whose label is hard-coded `text-white`, or `text-foreground`,
      passes 3.2, 3.2a, 8.4, 8.6 and 9.2c — the last of which reads the
      **modal** pixel precisely to exclude the glyphs — so nothing in the plan
      sees the algorithm missing from the component. Assert here that the chip's
      label carries `labelInk(marker.color)`. Negative: the label colour
      hard-coded to white, watched failing on a marker whose colour is a light
      palette entry, where `labelInk` returns `#000000`, while 3.2a's own table
      and this slice's placement assertion stay green.
- [ ] 8.2 The rule takes its named slot in `marksOverLight` — **not merely
      "behind the bars"**, which orders the marker against one of the five marks
      the body paints and leaves the other four undecided. Emitted after
      `data-gantt-today-edge` and before the row hit lines and every bar
      (`design.md` §2.1 carries the full thirteen-row table) — test:
      `gantt-panel.test.tsx`, one assertion over the DOM order of
      `data-gantt-weekend`, `data-gantt-today`, `data-gantt-gridline`,
      `data-gantt-today-edge`, `data-gantt-marker-rule`,
      `data-gantt-row-line`, `data-gantt-capacity-link` and the first
      `data-gantt-bar`, asserting exactly that sequence; a second asserting the
      rule carries `pointer-events: none`; plus a bar crossing the rule keeping
      its `x`, `width` and
      critical-path class **unchanged from the same plan with no marker**.
      **The two marks between the rule and the bars are in the sequence for the
      same reason the sequence exists at all.** An earlier draft jumped from
      `data-gantt-marker-rule` straight to the first bar, which leaves slots 8
      and 9 of the thirteen-row table undecided: a rule emitted **after** the
      row hit lines and capacity marks but still before the bars satisfies
      every named assertion while violating the slot this slice is about
      (round-7 Sol review, Important). Skipping them repeats in miniature the
      "behind the bars" error the slice opens by rejecting.
      Negatives, two: the rule emitted at the top of `marksOverLight`, watched
      failing the sequence while the unchanged-bar half stays green — which is
      the point, because a rule above the gridlines is still behind every bar;
      and the rule emitted **immediately before the bars**, after the row hit
      lines and capacity marks, watched failing the sequence while both the
      unchanged-bar half and a "before every bar" assertion stay green.
      **Plus the rule's extent, which nothing else tests** (round-19 Sol review,
      Important): assert `y1` is `0` and `y2` is `rowCount` at this seam. 8.2
      checks paint order, pointer behaviour, the bar attributes, the count and
      the colour, and 8.2a samples one short strip in one empty row band, so a
      rule drawn only through that band — or through the fixture's bars and
      nothing else — passes every one of them while vanishing from the rest of
      the chart. Negative: `y2` truncated to one row, watched failing this
      equality while the order, count, colour and both of 8.2a's tiers stay
      green, since the sampled band is inside the truncation.
      **Plus a watched negative for `pointer-events: none`, which had an
      assertion and no fault** (round-19 Gemini review, Important). Every other
      claim in this slice names a renderer that breaks it; that one was asserted
      bare, so nothing showed it was load-bearing. Negative: the property
      dropped from the rule, watched failing that assertion while the sequence,
      `y1`/`y2`, the shared-date colour, the count and all three bar comparisons
      stay green — not one of them reads it.
      **And the declaration is the whole claim — there is no behavioural half,
      and a round-19 draft of this slice invented one** (round-20 Gemini review,
      Critical). That draft sent a hover case to 9.2c on the reasoning that
      jsdom cannot hit-test, which is true and beside the point: the rule is at
      slot **7** and the row hit lines are at slot **8**
      (`gantt-panel.tsx:3032`, `pointerEvents="fill"` at `:3052`), so in SVG's
      painter's model the hit lines are **over** the rule, not under it.
      Chromium hit-tests front to back and reaches `data-gantt-row-line` first
      whatever the rule carries — so the hover would light the row **with the
      fault in**, and the negative could not fail. `design.md` had already said
      this ("Nothing above the rule is removed and nothing below it is
      exposed"); the draft contradicted its own design document to invent a
      browser case for a property that needs none. `pointer-events: none` on the
      rule is belt-and-braces against a future reorder, which is exactly what a
      declared-property assertion with a watched removal is the right size for.
      **Plus the shared-date colour, which nothing else tests:** two markers on
      one date with distinct colours, asserting exactly one rule element at that
      offset and its `stroke` equal to the **first** marker's colour by
      `(created_at, id)`. Negative: the selection inverted to the date's last
      marker, watched failing on the `stroke` while the count of rules stays
      one — the count alone cannot see which colour won. The
      unchanged-bar half is the requirement; the sequence is the mechanism, and
      it needs its own assertion because the requirement cannot see it.
      **The unchanged-bar half compares three attributes, and the bar layer has
      a fourth state it cannot see** (round-12 Sol review, Important). An
      **assumed** bar is `[fill-opacity:0.35]` by design
      (`ASSUMED_BAR_CLASSES`, `gantt-panel.tsx:706`), so a rule behind one shows
      through it and the old "the bar is fully opaque over it" wording was false
      of that bar kind — while `x`, `width` and the critical-path class, the
      three things this slice compares, are all unchanged.
      **The two halves belong to two tiers, and putting the pixel half in this
      file made it inexecutable** (round-13 Gemini review, Important). This slice
      runs in `gantt-panel.test.tsx`, which is jsdom and has no rasterizer, and
      9.2 is already the slice of record for pixels — "jsdom asserts positions, a
      browser judges appearance". So the case here is jsdom's: a rule crossing an
      **assumed** bar, asserting the bar still carries `[fill-opacity:0.35]`,
      that its `x`, `width` and critical-path class are unchanged from the same
      plan with no marker, and that the rule still precedes it in the sequence.
      Third negative: the assumed arm of `barClasses` emptied so the bar paints
      opaque — the mutation `gantt-panel.tsx:701-706` already documents as
      watched on 2026-08-12 — caught by the fill-opacity assertion while the
      sequence and all three attribute comparisons stay green. **The pixel half
      is 9.2b's**, below. The attribute half is what stops the guarantee being
      restated as a falsehood; the pixel half is what stops it being weakened to
      "no attribute moved", and neither tier can stand for the other.
- [ ] 8.2a The rule is an opaque 1px `<line>` on screen at both ends of the
      ladder, and the mechanism is
      `vector-effect: non-scaling-stroke`. **All three rungs, and the ends carry the mechanism**
      (round-18 Gemini review, Minor, revised in round 19): 28 and 4 are the
      ends, and they are what makes the mechanism visible — a single rung cannot
      tell a non-scaling stroke from a width that happens to equal that rung's
      day pixels, and two rungs that differ by 7× can. **12 is rendered too**
      (round-19 Gemini review, Minor): the requirement says _every_ rung, 8.3
      exercises 12 only as a jsdom element count, and a fault conditioned on
      `dayPx === 12` would therefore reach no browser assertion at all. The
      middle rung costs one more pass of the same three clips and closes the
      whole class, so this slice renders all three and the ends carry the
      mechanism argument.
      **A declared width proves nothing
      here**: the chart's user space is days by rows stretched non-uniformly to
      `dayPx` (`viewBox` days×rows with `preserveAspectRatio="none"`,
      `gantt-panel.tsx:3940-3943`), so one user unit is a whole day — 28, 12 or
      4 CSS pixels — and the today edge already carries
      `vectorEffect="non-scaling-stroke"` for exactly this reason, with the
      comment at `:2984-2986` spelling it out. Nothing in this plan named the
      property, so a rule declared `strokeWidth={1}` would render a day wide at
      28px and still pass every order, colour, count and pointer assertion in
      8.2 (round-12 Sol review, Important).
      **The oracle is the attribute in jsdom and the painted columns in the
      browser, and it is NOT `getComputedStyle().strokeWidth`** (round-13 Gemini
      review, Critical; the browser half was `boundingBox().width` until
      round 14 and is stated in full below). `vector-effect` changes how the stroke is transformed
      at rasterization; it does not rewrite the computed value of
      `stroke-width`, so a rule declared 1 reads `1px` in every engine with the
      property present **or** removed — the fault would have been watched
      passing, in the same slice that exists to forbid unfailable negatives.
      jsdom cannot help either: it has no SVG layout and computes no style, as
      9.2's own note records.
      Test, jsdom tier: `apps/fe-01/src/components/wbs/gantt-panel.test.tsx`,
      assert the rule element carries `vector-effect="non-scaling-stroke"` as an
      attribute — the shape
      `markAttribute('[data-gantt-today-edge="2"]', 'class')` already uses at
      `gantt-panel.test.tsx:5828`. Negative: the property removed from the rule
      alone, while every assertion in 8.2 and 8.3 stays green. **What that
      removal reads is the helper's diagnostic sentence, not `null`** (round-14
      both seats, Minor): `markAttribute` coalesces a missing element **or a
      missing attribute** to `` `nothing on the chart at ${selector}` ``
      (`gantt-panel.test.tsx:269-271`), deliberately, so a deleted mark fails as
      a value that is not the value expected rather than as chai's own argument
      checking — its docstring at `:258-267` says so and records it watched both
      ways on 2026-08-09. The equality against `'non-scaling-stroke'` fails
      either way; the sentence is what the failure output will say.
      **The jsdom tier SHALL also assert the declared width is `1`, and without
      it the browser bound is vacuous against the requirement it exists to
      prove** (round-16, both seats, Critical). Relaxing the browser oracle to
      1-or-2 columns opened a renderer that passes everything while being
      wrong: `strokeWidth={2}` **with** `vector-effect="non-scaling-stroke"`
      paints two CSS columns at both rungs, so it satisfies the browser bound,
      the attribute assertion above, 8.2's order and colour checks and 9.2's
      "see the rule" step — every named test in the plan — while the
      requirement says one pixel. So: assert the rule's `stroke-width` is `1`
      in the same jsdom case, with a **`strokeWidth={2}` declaration** as its
      watched negative. That is the division of labour the two
      tiers have: jsdom pins the declared width **and** the mechanism, and the
      browser proves the mechanism actually holds at the rungs — a hairline
      rather than a day. Neither half is the requirement on its own, which is
      why the plan stopped trying to make one of them carry it.
      **What that negative moves, stated correctly** (round-18 Gemini review,
      Critical). Until round 17 this line claimed `strokeWidth={2}` left "the
      whole browser tier green"; adding the computed-style assertion below made
      that false and nothing updated the claim. A presentation attribute is
      still an input to the cascade, so `strokeWidth={2}` resolves to a computed
      `2px` and fails the browser equality too. It therefore fails **two**
      equalities with one fault and leaves only the painted-column bound green,
      at 2 columns. That is not a defect in the negative — the attribute and the
      computed width are the same resolved value read in two engines, and a
      fault in the declaration is supposed to be visible in both — but it does
      mean this negative cannot isolate the computed assertion, which is
      precisely why the round-17 negative below exists and must stay distinct
      from it. The two are distinguishable, and each pins a different pair:
      `strokeWidth={2}` fails attribute + computed, columns green;
      `style={{ strokeWidth: 2 }}` fails computed alone, attribute and columns
      green.
      **And a third assertion closes the gap those two leave: the EFFECTIVE
      width, read in the browser** (round-17 Sol review, Critical). The
      presentation attribute is the bottom of the SVG cascade, so
      `<line strokeWidth={1} style={{ strokeWidth: 2 }} vectorEffect="non-scaling-stroke">`
      passes **both** jsdom equalities — the attribute really is `1` — while the
      inline style wins and the rule paints two columns at every rung, which
      sits inside the 1-or-2 bound. A fifth renderer, wrong, passing everything.
      So the browser tier SHALL also assert `getComputedStyle(rule).strokeWidth`
      is `1px`, with an inline `style={{ strokeWidth: 2 }}` override as its
      watched negative, failing that equality while the attribute assertions and
      the painted-column bound stay green.
      **This is not a return to the round-13 oracle**, which was rejected as
      proof of `vector-effect` — computed style cannot see that property, which
      is the whole of round 13's Critical. It is admitted here for the one thing
      it does report faithfully, the width the cascade resolved to, and it is
      admitted in the **browser**, since jsdom computes no style at all. It is
      blind to the `viewBox` exactly as the attribute is — a rule with
      `vector-effect` removed still computes `1px` while rasterizing a day
      wide — so what it adds over the attribute equality is cascade coverage,
      not screen coverage, and the painted columns stay the only assertion that
      reads the screen.
      **And three assertions are still not a bound, because two of them read
      the element the test QUERIES rather than the element that PAINTS**
      (round-18 Gemini review, Critical). Two more renderers pass all three:
      (1) `<g data-gantt-marker-rule strokeWidth={1} vectorEffect="non-scaling-stroke">`
      wrapping `<line strokeWidth={2} vectorEffect="non-scaling-stroke">` — the
      query lands on the `<g>`, whose attribute reads `1` and whose computed
      width is `1px`, while the child paints 2 columns, inside the bound;
      (2) `<line strokeWidth={1} vectorEffect="non-scaling-stroke" strokeOpacity={0.4}>`
      — every width assertion passes, and a translucent stroke still changes
      the RGBA of the columns it covers, so the run is still 1 or 2. The second
      one violates a requirement that had **no scenario at all**:
      `specs/wbs-domain/spec.md`'s "The body rule SHALL be opaque". So the
      jsdom case SHALL also assert the rule's `localName` is `'line'`, watched
      with the wrapper above — the assertions then read a `<g>` and the
      equality fails on the tag, not on a width. And the browser case SHALL
      also assert computed `stroke-opacity` and `opacity` are both `'1'`,
      watched with `strokeOpacity={0.4}`, which fails that equality while the
      two width assertions and the painted-column bound stay green.
      **Two equalities on the rule are not opacity either** (round-19 Gemini
      review, Critical), because neither one can see the two places the alpha
      actually lives: CSS `opacity` does **not** inherit, so
      `<g opacity={0.5}>` around the rule leaves the rule computing `'1'`; and
      `stroke-opacity` is a separate channel from the colour, so a `stroke` of
      `oklch(… / 0.4)` — the form this stylesheet's tokens already take —
      leaves it computing `'1'` too. The painted-column oracle cannot help: a
      washed-out stroke still changes RGBA, so the run is still 1 or 2. So the
      browser case SHALL assert three things, not one: `stroke-opacity` is
      `'1'`, the computed `stroke` resolves to a colour with **no alpha
      component** (an `rgb(…)` serialization rather than `rgba(…)`/`… / α`), and
      **every element from the rule up to the chart `<svg>` inclusive** computes
      `opacity` `'1'`. Two more watched negatives: the stroke given an
      alpha-bearing colour of the same hue, and an `<g opacity={0.5}>` inserted
      around the rule — each failing exactly one of the three while the widths,
      the tag and both column sets stay green — a fault
      that isolates cleanly because opacity moves what a column looks like, not
      how many columns there are. Five assertions, four jobs: the tag is the
      element, the attribute is the mechanism, the computed width is the value,
      the computed opacity is the paint, and the painted columns are the proof
      that all of it reaches the screen.
      Test, browser tier: `apps/fe-01/e2e/gantt.spec.ts`, the same marker at
      28px and at 4px per day. **The oracle is the painted columns, NOT
      `boundingBox().width`** (round-14 Sol review, Critical). The rule is a
      vertical `<line>` with `x1 === x2` and therefore has **no area**; this
      repository's own fixture records that a browser reports such a line
      hidden, and opens its chart on the row labels for exactly that reason
      (`apps/fe-01/e2e/gantt.spec.ts:415-418`). A zero-area box cannot report
      the painted stroke: the correct renderer does not reliably answer `1`, and
      removing `vector-effect` does not widen the box, because the stroke is
      painted outside the geometry the box measures — the oracle would have been
      wrong for the correct renderer and unmoved by the fault, both at once.
      Instead clip a screenshot to a short horizontal strip crossing the rule in
      a row band with no bar in it, the way `apps/fe-01/e2e/hover-cards.spec.ts:148`
      clips a strip, take two at each rung, and
      assert the run of columns that differ is **1 or 2** columns wide at
      both — bounded on **both** sides, because "at most 2" is satisfied by
      **zero** and a rule that never paints at all would pass it (round-16
      Gemini review, Minor).
      **The two clips SHALL differ by the QUERIED ELEMENT'S OWN VISIBILITY, not
      by the marker's presence** (round-18 Sol review, Critical). With the
      marker toggled, the pixel delta is attributed to _whatever the marker
      draws_, and the width assertions are attributed to _the element tagged
      `data-gantt-marker-rule`_ — nothing binds those to the same primitive. So
      a correctly tagged 1px opaque `<line>` accompanied by a **coincident,
      untagged** `<line strokeWidth={2} vectorEffect="non-scaling-stroke">` in
      the same marker-conditioned branch passes every assertion in this slice:
      the tag, the attribute, the computed width, the computed opacity, and a
      2-column run inside the bound. 8.2's one-per-date count does not see it
      either, because that count selects the tagged element
      (`tasks.md`, 8.2's shared-date paragraph). The visible marker is two
      pixels wide and the plan is green. Binding closes it: create the marker
      once, clip the strip, then set `visibility: hidden` on **the element the
      other assertions queried** through `locator.evaluate`, clip the identical
      strip again, and restore. `visibility` rather than `display`, so nothing
      reflows between the two clips. Under the correct renderer, hiding the only
      rule removes its paint and 1 or 2 columns differ. Under the coincident
      auxiliary line, hiding the tagged 1px line changes **nothing** — the
      untagged 2px line covers every column it painted — so **0** columns
      differ and the lower half of the bound, added in round 16 for a different
      reason, is what fails it. Watched negative, therefore: **the coincident
      untagged 2px line**, watched failing this bound at 0 while the tag, both
      width assertions, the opacity assertions and 8.2's count all stay green.
      **And that toggle alone is still not the binding, because it can only see
      the element it hides** (round-19 Gemini review, Critical). Move the
      auxiliary line one pixel over instead of stacking it — an untagged 1px
      line at the next column — and hiding the tagged rule leaves a delta of
      exactly **one** column, which is inside the bound, while two adjacent
      hairlines paint a 2px rule. Coincident and adjacent are the two halves of
      one hole: the toggle measures the tagged element's own ink and is blind to
      every other element's, and the marker-presence clip measures the marker's
      total ink and cannot attribute it. Neither bound closes the other, and
      "1 or 2" cannot tell one anti-aliased hairline from two abutting ones.
      So take **three** clips at each rung — marker absent, marker present,
      marker present with the queried rule hidden — and derive two column sets:
      `totalInk`, the columns differing between absent and present, and
      `ruleInk`, the columns differing between present and rule-hidden. Then
      assert **both**: `ruleInk` is a contiguous run 1 or 2 columns wide, and
      `totalInk` and `ruleInk` are **the same set**. The second assertion is an
      equality rather than a bound, which is why the 1-or-2 slack cannot hide
      inside it: the adjacent line makes `totalInk` two columns and `ruleInk`
      one, the coincident line makes `ruleInk` empty, and a correct renderer
      makes them identical because the rule is the only marker ink in a row band
      with no bar and no chip in it. Watched negative, therefore: **the adjacent
      untagged 1px line**, watched failing the set equality while `ruleInk`'s
      own bound, the tag, both width assertions and 8.2's count all stay green.
      **And the set equality SHALL be taken over the whole chart body, not the
      strip** (round-19 Sol review, Critical, and it is why the strip-local
      version above is stated as the reasoning rather than the assertion). A
      strip cannot prove the absence of paint it does not cover: move the
      untagged auxiliary line into a different row band, or paint it as a CSS
      background on a sibling, and every strip-local comparison is satisfied
      while the chart carries two rules. The complete form is an identity, and
      it needs no column arithmetic at all: **the body with the queried rule
      hidden SHALL be pixel-identical to the body with no marker at all**, over
      a clip covering the whole chart body — the rows, not the axis band, since
      the chip is header ink and is supposed to differ. If hiding one element
      returns the chart to its marker-free state, that element is the only body
      ink the marker adds, anywhere, and no auxiliary primitive survives
      wherever it is drawn. The column sets then carry only what they are good
      at: `ruleInk`'s contiguous 1-or-2 run is the width, and the identity is
      the binding. Watched negative: **the untagged auxiliary line in a different
      row band**, watched failing the whole-body identity while the strip's own
      run, the set equality within it, the tag, both width assertions, the
      opacity assertions and 8.2's count all stay green. **And the predicate has to be spelled out**
      (round-16, both seats, Important): draw each clip into an in-page 2D
      canvas and read it with `getImageData`, the way
      `apps/fe-01/e2e/measure-ink.ts:78` already reads a painted pixel and three
      other e2e specs copy. **That precedent is the extraction, not the
      loading** (round-17 Gemini review, Important): `measure-ink.ts:78` reads a
      canvas it filled itself with `fillRect`, while `page.screenshot` hands
      back a Node `Buffer`, so the clip has to be carried into the page.
      **And the carrying has to be written out, because two of its steps throw
      or truncate when left implicit** (round-18 Gemini review, Important).
      In Node: `buffer.toString('base64')` — the conversion the `Buffer` types
      in this project already support, and the one `hover-cards.spec.ts:157`
      uses at `:158` to compare two clips — then pass both strings into a single
      `page.evaluate`. In the page, per clip: set `img.src` to
      `` `data:image/png;base64,${s}` ``, `await img.decode()`, set
      `canvas.width = img.naturalWidth` and `canvas.height = img.naturalHeight`
      **before** drawing, since a fresh `<canvas>` is 300×150 and would crop a
      wider clip and pad a narrower one, `ctx.drawImage(img, 0, 0)`, and read
      `ctx.getImageData(0, 0, canvas.width, canvas.height)` — with all four
      arguments, since `getImageData()` with none is a `TypeError`, not a
      whole-canvas read. Both clips come from one `strip` object, so both PNGs
      are the same `W×H` and the column indices line up.
      A **column differs** iff at least one pixel in it
      has any RGBA channel unequal to the corresponding baseline pixel; and the
      differing columns SHALL form **one contiguous run**. Without those three
      sentences the count is not reproducible — `hover-cards.spec.ts:148` is the
      precedent for _clipping_, not for column diffing, and there is no PNG
      decoder in the workspace to fall back on.
      Watched negative: the property removed, watched turning that run into
      **28** columns at the 28px rung and **4** at the 4px rung — which is why
      two rungs rather than one, since a single rung cannot tell a non-scaling
      stroke from a width that happens to equal that rung's day pixels, and why
      the count rather than a boolean, since "some pixels changed" is true of
      both renderers.
      **At most 2 rather than exactly 1, and the difference is anti-aliasing**
      (round-15 Gemini review, Critical). The rule sits at an integer user
      coordinate and the chart's horizontal map is
      `x * dayPx + CHART_PAD_PX` with all three integers
      (`CHART_PAD_PX`, `gantt-panel.tsx:590`), so a 1 CSS pixel non-scaling
      stroke is centred **on** a pixel boundary and Skia paints it at partial
      coverage into the two columns it straddles. "Exactly 1" would therefore
      have failed the correct renderer — the same shape of error as the
      bounding box it replaced, one round later, and nothing in this component
      sets `shape-rendering` to opt out (grep: no `shapeRendering` anywhere in
      `gantt-panel.tsx`). The bound is deliberately **not** tight enough to tell
      1 CSS pixel from 2: this oracle's job is a hairline against **a day**, and
      28 or 4 against 2 is the discrimination that matters. The declared width
      is 8.2a's jsdom half, and the mechanism is the attribute. The attribute is what an implementer can get wrong; the
      painted run is what a reader sees, and neither tier can stand for the
      other.
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
      **A fifth case at 12px, and it is the one that proves the rung scope.**
      An earlier draft declined a 12px case on the grounds that it would assert
      the rung scope rather than the constant — which is true, and is exactly
      why it was needed: with only the four cases above, an implementation that
      drops the `dayPx === 4` guard and suppresses at **every** rung passes all
      four. The 4px cases are unchanged by definition, and the 28px case is
      green because 3.6 days hold at most four rules, so the threshold is never
      reached there and suppression never fires whether it is scoped or not
      (round-7 Sol review, Critical). At 12px a 100px viewport spans 8.3 days,
      so the threshold **is** reachable: **seven distinct occupied dates within
      100px at 12px, asserted to draw seven rules and no suppression** —
      `7 > 6`, so an unscoped implementation suppresses and the case fails.
      Third negative: the `dayPx === 4` guard dropped so suppression applies at
      every rung, watched failing **only** the 12px case while all four
      original cases stay green — which is the measurement that the other four
      cannot see the scope at all.
      **A sixth case, because "in the viewport" is in the measure and nothing
      tested it.** Every case above puts all of its occupied dates inside the
      same 100px viewport with no scrolling, so an implementation that counts
      **every occupied date in the horizon** — ignoring the viewport entirely —
      passes all five whenever the fixture's horizon happens to equal its
      viewport, which is every fixture as written (round-8 Sol review,
      Important). The chart is a horizontal scrollport and already tracks
      `scrollLeft` (`gantt-panel.tsx:2169`, `:3699`, `:3723`), so the fixture is
      buildable: at 4px, **six occupied dates visible in the 100px viewport and
      several more occupied dates outside it**, asserted to draw six rules
      (`6 > 6` is false, so no suppression); then **scrolled to a region where
      seven are visible**, asserted to draw none.
      **What is counted is rules whose `x` lies in the visible interval, and
      the off-screen rules stay in the DOM.** The viewport scopes the _density
      measure_ and nothing else: **there is no viewport virtualization**, and
      this slice does not introduce any. The chart is one full-width SVG inside
      an overflow scrollport (`gantt-panel.tsx:2730-2735`, `:3698-3740`), so a
      correct renderer draws a rule for every unsuppressed occupied date in the
      horizon and most of them are simply scrolled out of view. A test that
      counted **every** `[data-gantt-marker-rule]` in the document would fail
      that correct renderer, and an implementation bent to satisfy such a count
      would filter the SVG itself — which would then drop those rules from the
      export, because the export clones the live chart (round-9 Sol review,
      Minor). So each assertion here filters by `x` against the visible
      interval, and the fixture's off-screen occupied dates are expected to
      carry rules that the count ignores.
      **"The off-screen rules stay in the DOM" is a decision, and until now no
      assertion carried it** (round-11 Sol review, Important). Every count above
      filters by `x` to the visible interval, so a renderer that virtualizes rule
      elements to that same interval draws six visible rules before the scroll
      and none after — passing both halves of the sixth case while dropping every
      off-screen rule, which is precisely the export failure the paragraph above
      exists to forbid. So the unscrolled half also asserts the **unfiltered**
      horizon count: every unsuppressed occupied date in the horizon carries a
      `[data-gantt-marker-rule]` element, the off-screen ones included, so the
      document holds strictly more rules than the six the density measure counts.
      **Three faults, because the three failures are distinct and no one fault
      catches two.** Fourth negative: the in-viewport filter dropped from the
      numerator so the whole horizon is counted, watched failing the
      **unscrolled** half — the off-screen dates push the count past six and
      suppress six rules that should draw. That fault leaves the scrolled half
      green, since a horizon count is already over the threshold there and
      suppressing is the expected answer, which is why the scrolled half needs
      its own: fifth negative, the density computed once at mount and not
      recomputed when `scrollLeft` changes, watched failing the **scrolled**
      half with six rules still drawn where none should be, while the
      unscrolled half and all five earlier cases stay green. Sixth negative, and
      it is the one the two above cannot reach because both mutate the
      **numerator** while this mutates the **render**: the rule elements filtered
      to the visible interval at render time, watched failing the new horizon
      assertion with the document holding exactly the six visible rules, while
      every `x`-filtered count in this slice — and every case at 28px, 12px and
      the two 4px rungs — stays green.
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
      **A chip is not a name, and an export has no hover — so the export also
      carries a legend.** The on-screen answer to "which marker is this rule?"
      is the chip's hover/tap list (`design.md` §2), and a downloaded SVG has
      no pointer at all; at 4px the chip is a coloured tick, so even a chip
      that survived would name nothing. An export of unlabelled coloured shapes
      passes every count/position/colour assertion while delivering exactly the
      "unidentified coloured line" `spec.md` says is worse than no line
      (round-8 Sol review, Important). **Decided: a legend block below the
      chart** — one row per marker, swatch, `date` and `name`, in the list's
      `(date, created_at, id)` order — rather than a `<title>` element, because
      `<title>` is a tooltip and a hover mechanism again, invisible in a PNG
      conversion or a printed page, which is what a downloaded chart is for.
      Assumption, falsifiable: nobody wants a chart exported _without_ the
      marker names; if Dany asks for a bare chart, the legend becomes a flag on
      the export call rather than an unconditional block. That is **row 10 of
      `design.md`'s assumption table** — recorded there so the catalogue stays
      the single place an assumption is looked up (round-9 Gemini review,
      Minor).
      Second case: export a plan with two markers **at 28px and again at 4px**
      and assert each marker's `name` appears as text in the exported markup at
      both rungs. Second negative: the legend block dropped while the chips are
      still drawn, watched failing both rungs while the chip count, position
      and colour assertions stay green.
      **Third case, because serializing the names is not the contract:** the
      legend has to be a legend — one row per marker in the list's
      `(date, created_at, id)` order, each row carrying a swatch in the
      marker's colour and its `date` beside its `name`, and **the last row's
      bounding box inside the exported `viewBox`**. Assert the row count, the
      order, the per-row date and swatch fill, and that
      `lastRow.y + lastRow.height <= viewBox.height`. A names-only legend, one
      in reverse order, or one appended below the chart without growing the
      canvas passes the second case and delivers nothing a reader can use
      (round-9 Sol review, Important).
      **The bounds half is a concrete failure mode in this builder, not a
      hypothetical:** `buildStandaloneGanttSvg` fixes its `totalHeight` from
      `ROW_PX` and the chart's inner height (`gantt-panel.tsx:1755`), writes
      that into `viewBox`, `width`
      and `height` (`:1762-1764`) and paints the background rect to exactly
      those dimensions (`:1771`) — all before any legend could be appended. Text
      added after that point serializes into the markup, satisfies a
      `getByText`, and is invisible in every rasterisation and every print,
      which is the only thing a downloaded chart is for.
      Third negative: the legend rows drawn with the text intact but
      `totalHeight` left unexpanded, watched failing the bounds assertion while
      the name, order, date and swatch assertions all stay green — the fault
      that separates "the names are in the file" from "the names are on the
      page".
      **Fourth case, because the chip-and-rule pairing is vacuous about rules**
      (round-11 Sol review, Minor). It requires a chip per marker and relates
      each _existing_ rule to a chip, so an export carrying chips, a legend and
      **zero** rules satisfies it — 8.6's other cases assert chips and legend,
      and 8.7 asserts rule absence only in the suppressed case, so nothing here
      requires a rule to exist. Case: export below the density threshold and
      assert **one rule per occupied date**, each carrying that date's x and its
      marker's colour. Fourth negative: the marker rules stripped from the nested
      live-chart clone while the chips and the legend are left in place, watched
      failing this case alone while every chip, name, order, swatch and bounds
      assertion in 8.6 stays green — the fault that separates "the export names
      its markers" from "the export shows them".
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
- [ ] 9.2 `apps/fe-01/e2e/gantt.spec.ts`: click a day, name a marker, see the chip and the
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
      Negative, and it is **not** "the `focus-visible` classes removed": this
      app never imports Tailwind's preflight — `styles.css` imports only
      `tailwindcss/theme.css` and `tailwindcss/utilities.css` (`:52-53`), and
      the scoped reset written into preflight's slot resets `outline` on
      nothing outside `[data-grid]` (its only `:focus` outline rule is
      `[data-grid] input:focus, [data-grid] textarea:focus` at `:912-917`). So
      a focused `tabIndex={0}` span keeps **Chromium's user-agent outline**,
      and the house focus-ring pattern authors `focus-visible:outline-none`
      beside the ring (`button.tsx:34`, `input.tsx:29`, `gantt-panel.tsx:4240`)
      — deleting every `focus-visible:*` class deletes that `outline-none` too
      and hands the cell the UA ring back, so the two readings still differ,
      the focused `outline-style` is still not `none`, and the negative
      **passes** (round-6 Sol review, Important 9; third round running that
      this ring's proof has been wrong).
      The fault is **`focus-visible:outline-none` kept and only the ring
      classes removed**, watched failing on the two readings being equal —
      while 9.2's round trip and every jsdom assertion in section 6 stay green,
      since neither can see a computed style (jsdom computes none). It bites
      because Tailwind v4.3.3 emits `outline-style: none` for `outline-none`
      and drives `ring-*` through `box-shadow` (both read out of
      `node_modules/tailwindcss/dist/lib.js`), so under the fault
      `outline-style` is `none` and `box-shadow` is `none` in **both** states
      and the transition assertion has nothing to see. Kept separate from
      9.2's stroke mutation on purpose: two guarantees in one slice share
      whichever fault is injected, and the one that shares gets no proof.
- [ ] 9.2b The bar layer's **pixels**, which are the half of 8.2 jsdom cannot
      judge — same file (`apps/fe-01/e2e/gantt.spec.ts`), screenshot-clipped to
      a bar's bounding box the way `apps/fe-01/e2e/hover-cards.spec.ts:148`
      clips a strip. Two cases: a rule crossing an
      **opaque** bar, asserting that bar's footprint is pixel-identical with and
      without the marker; and a rule crossing an **assumed** bar
      (`[fill-opacity:0.35]`), asserting **at least one differing pixel inside
      that bar's footprint** — the crop IS the footprint, so "differs" and
      "inside" are one predicate rather than two.
      **"Every differing pixel lies inside the footprint" was the vacuous
      form** (round-13 Sol review, Important): it is satisfied by **zero**
      differing pixels, so a rule masked under assumed bars passed it alongside
      the opacity and paint-order assertions — and read over the whole chart
      instead it rejects the correct renderer, whose rule differs everywhere it
      is drawn. Cropping to the footprint and requiring a difference is the form
      that has both halves.
      Negatives, two. The **opaque** arm of `barClasses` given
      `[fill-opacity:0.35]` — the same seam `gantt-panel.tsx:701-706` documents
      as watched on 2026-08-12, one arm over from 8.2's third negative — so the
      rule shows through a bar that is supposed to hide it, watched failing the
      opaque case's pixel-identity assertion while every DOM assertion in 8.2
      and 8.2a stays green: 8.2 compares `x`, `width` and the **critical-path**
      class, none of which a changed fill-opacity token moves, and its
      fill-opacity assertion is on the assumed arm, not this one.
      And the rule **masked under assumed bars** with
      `[fill-opacity:0.35]` preserved, watched failing the assumed case's
      differing-pixel assertion while the opacity assertion, the paint order and
      the opaque case all stay green — the fault the vacuous predicate could not
      see, and the one that would ship as "we protected the bar".
      **The first negative named here through round 13 was not injectible and
      its failure matrix was false** (round-14, both seats, Important). It read
      "the rule emitted into `marksOverBars`", and there is no `marksOverBars`
      anywhere in the component: the body renders two memos, `marksUnderLight`
      (`gantt-panel.tsx:2868`) and `marksOverLight` (`:2927`), with the bars
      inside the latter at `:3280`. Emitting the rule after the bars **is** a
      real mutation — but it is **8.2's**, not this slice's, because 8.2's
      sequence assertion runs from `data-gantt-weekend` through
      `data-gantt-marker-rule` to the first `data-gantt-bar`, so a rule moved
      past the bars fails in jsdom first. "Every DOM assertion in 8.2 stays
      green" was therefore false under the only reading on which the mutation
      existed at all. A pixel slice earns its own slice by carrying a fault the
      pixel tier is the **first** to see, which is what the opaque arm's
      fill-opacity is and what a paint-order move is not.
      **This slice exists because 8.2's pixel half was written into a jsdom
      file** (round-13 Gemini review, Important). 8.2 compares `x`, `width` and
      the critical-path class, all of which survive a translucent bar being
      painted over, so the guarantee needs a pixel judgement — and `jsdom` has no
      rasterizer, so it needed to be here rather than there. Its own slice for
      9.2a's reason: 9.2's fault mutates the rule's stroke, which both cases here
      would see, so sharing that slice would leave this one with no fault of its
      own.
- [ ] 9.2c The chip's **rendered** contrast — same file
      (`apps/fe-01/e2e/gantt.spec.ts`).
      3.2 proves the palette's eight literals against computed backdrops and
      8.1 and 6.x read the chip's colour at the DOM seam; none of them sees what
      the compositor put on screen. A chip carrying `opacity: 0.5`, an
      alpha-bearing fill, or an opacity-reducing ancestor passes every one of
      them while its composited colour falls under 3:1 (round-19 Sol review,
      Critical) — the same shape as the "SHALL be opaque" hole one level up,
      one component over.
      **`measureInk` is not the oracle here, and both reasons are in its
      source.** It is the right precedent for the pipeline and the wrong pair
      for this bar. It returns `contrast` between a node's `color` and its
      composited ground — the 4.5:1 **label** bar — while the claim here is the
      chip **fill** against the header backdrop, two surfaces, a ratio it never
      forms. And its walk reads
      `getComputedStyle(ancestor).backgroundColor` alone
      (`apps/fe-01/e2e/measure-ink.ts:110-115`), breaking at the first layer
      with alpha 1; `opacity` is a separate property and group opacity is not a
      per-layer alpha, so the watched negative this slice exists for — a chip at
      `opacity: 0.5` — passes `measureInk` **unchanged**. A negative that cannot
      fail is how the previous seven Criticals were written, so the oracle is
      the pixel the screenshot already carries.
      Pipeline: 9.2b's, unchanged — `page.screenshot({ clip })` per
      `apps/fe-01/e2e/hover-cards.spec.ts:148`, `buffer.toString('base64')`
      (`:158`), both strings into one `page.evaluate`, `img.decode()`,
      `canvas.width` and `canvas.height` set from `naturalWidth` and
      `naturalHeight` **before** `drawImage`, then
      `getImageData(0, 0, canvas.width, canvas.height)` with all four arguments.
      Two clips: the chip's bounding box, and an equal-sized box on a
      **markerless day cell of the same kind** in the same header row — the
      backdrop measured from the page rather than recomputed, so a theme change
      moves both together. Take the **modal** RGB of each clip, convert with the
      sRGB transfer function `measure-ink.ts:89-94` already spells out — `linear` at `:89-92` and the
      `luminance` sum at `:93-94`, and
      assert `(brighter + 0.05) / (dimmer + 0.05) >= 3`. Modal rather than mean
      because the chip carries its own label glyphs, and a mean of fill and ink
      is a colour neither of them is.
      Four cases, which is the whole of `design.md`'s chip backdrop set: a
      marker on a **weekday** cell and one on a **weekend** cell
      (`bg-muted-foreground/10`, `gantt-panel.tsx:3910`), each in **light** and
      **dark**. Today is not a fifth — the header gives it
      `font-semibold text-sky-600` and no background of its own (`:3915`), and
      `fill-sky-500/15` is a body `<rect>` (`:2955`) that cannot sit behind a
      header chip.
      Negatives, two, and both are failures.
      First, `opacity: 0.35` on the chip, watched failing the ratio on all four
      cases while 3.2's twenty ratios, 3.2a's chooser table, 8.1's placement and
      every DOM read of the chip's colour stay green — the fault this slice
      exists for, and the one `measureInk` could not see.
      **0.35 and not 0.5, and the difference is arithmetic rather than taste**
      (round-20 Gemini review, Important). 3.2's two bars bracket every palette
      fill at `0.145 <= L <= 0.30`: clearing 3:1 over the light base needs
      `L <= 0.30`, clearing it over the dark base needs `L >= 0.145`. Composite
      the top of that range at `opacity: 0.5` over dark `--background`
      (`L ≈ 0.015`) and the ratio is `(0.5·0.29 + 0.0575) / 0.065 ≈ 3.1` — the
      dark cases **pass with the fault in**, so a 0.5 negative is one whose
      failure depends on which entry the fixture's id hashes to. At 0.35 the
      worst case is `(0.35·0.30 + 0.65·0.015 + 0.05) / 0.065 ≈ 2.5` in dark and
      `1.05 / (0.35·0.30 + 0.65 + 0.05) ≈ 1.3` in light, so every entry in the
      bracket fails in both themes and the negative does not depend on the hash.
      Second, the fixture's chip fill set to a colour that clears 3:1 over the
      light base and misses it over base-over-weekend, watched failing the
      **light weekend** case while the light weekday case and 3.2's twenty
      ratios stay green. That is what proves the weekend case measures the
      weekend backdrop: without it the weekend clip is an unbound duplicate of
      the weekday one, and two cases measure one surface.
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
