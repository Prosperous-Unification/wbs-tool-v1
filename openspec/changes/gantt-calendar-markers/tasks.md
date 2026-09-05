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

- [x] 1.1 ADR under `docs/adr/` for **refusing the marker click on an undated
      plan**, carrying the three-option table from `design.md` §1 (hide /
      synthesise a date / refuse with a reason) and the chosen option. Link it
      from the JSDoc on the refusal branch; do not copy its rationale into the
      code comment — R3. No test: an ADR is a document, and a slice that
      claimed a test for it would be the vacuous shape R5 exists to stop.
- [x] 1.2 `CONTEXT.md`: add **calendar marker** — "a named annotation on an
      absolute calendar date, scoped to one project; not a work item and not
      visible to the scheduler". Glossary terms only, no design detail.

## 2. The table and the migration

- [x] 2.1 `calendar_marker` in `apps/be-01/src/repository/schema.ts` with the
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
- [x] 2.2 The forward migration, stamped later than
      `20260904020000_add_saved_plan_created_by_id` — test: the existing
      migration suite plus a case in
      `apps/be-01/src/repository/calendar-marker-migration.db.test.ts` that
      `DELETE FROM project` on a project with markers succeeds and leaves no
      marker row. Negative for the cascade: the FK written without
      `ON DELETE CASCADE`, watched failing with a constraint error — which is
      exactly the 500 an outgoing blue/green release would answer with for the
      length of a swap, and the reason the cascade is there rather than for
      tidiness. `Proof:` comment naming the omitted clause.
- [x] 2.2a The migration ships its `down.sql` — `AGENTS.md` §Migrations:
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
- [x] 2.3 Stamp collision check — run `duplicateMigrationStamps` from
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

- [x] 3.1 `automaticColor(markerId)` — `palette[fnv1a32(id) mod palette.length]`
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
- [x] 3.2 The palette itself, **and it lands before 3.1** — eight named hex
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
- [x] 3.2a `labelInk(fill)` — the chooser itself, which nothing above tests
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
- [x] 3.3 `validateCustomColor(hex)` refusing a colour below the **3:1** bar
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
      **Both be-01 halves are landed and watched (2026-09-05); the two composer
      halves are not, and the box stays unticked until they are.** The create
      arm is the contrast case 4.5 already carries — one case, not two homes for
      one row. The recolour arm is the new case named
      "refuses a recolour under the 3:1 bar, and leaves the stored fill behind",
      with the row read back as
      `color: null` afterwards because the marker is created without a fill: a
      recolour that wrote and then refused answers the same 422. Its negative is
      the recolour path's own — `colorProblem(color)` removed from the `PATCH`
      handler's `color !== undefined` arm, leaving the create's call in place —
      watched at 23 pass / 1 fail, exactly that case, `200` where `422` was owed
      and `#ff0000` stored, while the create's contrast case and the round
      trip's recolour stayed green. The remaining two arms are the third and
      fourth faults below and both need the composer, which slice groups 5–9
      build.
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
- [x] 3.5 The composer issues the id, so the previewed colour is the created
      one — the composer generates a v4 UUID, renders `automaticColor(id)` as
      the swatch, and sends that id as `markerId` in the create body — test:
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
      **Landed (chunk 38, b27e629f). The date and the id are ONE state**,
      `OpenComposer { date, markerId }`, and not a second piece beside
      `composerAt`: an id held on its own is free to be refreshed on its own,
      which is the very fault this slice's negative injects. `composerAt` stays
      as a derived `composer?.date ?? null`, so every reader that only wants the
      day — `aria-expanded`, the Escape effect, the caret ref — is unchanged.
      Minted in **one** opener shared by the empty cell and the sheet's `Add`,
      for the reason those two already share `operateDay`: an id minted at one
      of them alone leaves the other previewing a colour it never sends.
      `crypto.randomUUID` is the default factory (4.6a's route refuses anything
      that is not a v4) and it is a module constant, not an inline default —
      the opener's `useCallback` names the factory, so a fresh function per
      render would rebuild it every render.
      **THE NEGATIVE'S PREDICTED FAILURE POINT IS WRONG, and the correction is
      this slice's own.** Watched at a 196-case baseline on
      `gantt-panel.test.tsx`: `markerId: composer.markerId` replaced by
      `markerId: newMarkerId()` at the save → **195 pass / 1 fail, this case
      alone** — but it fails on the **recorded create's id**, not on unequal
      colours, because the same sentence above also asks for the exact id to be
      asserted on the outgoing request and that assertion runs first. The fault
      is caught; "watched failing on unequal colours" describes a test that does
      not also assert the id, and the two instructions cannot both be true of
      one case. The injected factory hands back `PREVIEW_ID` then `FRESH_ID`
      (buckets 1 and 7) so a second mint is observable at all, and the case
      asserts `automaticColor(PREVIEW_ID) !== automaticColor(FRESH_ID)` up front
      — if the palette is ever reordered into a collision that line says so,
      instead of the case passing while proving nothing.
      Not done here and not this slice's: the composer sends a **trimmed** name
      and checks nothing else, the same rule 6.3's rename follows (what a name
      may be is 4.2's refusal table, and a second copy here would be free to
      disagree with it). AC #1's "validates a name" therefore still has no
      client half, and no slice owns one.
      Gates h2puni all four rc 0 at the committed tree: `fe-01:test` 2250/0
      across 86 files (+1 on chunk 37's 2249, exactly the new case),
      `fe-01:typecheck`, scoped eslint, `prettier --check`. The first prettier
      pass was rc 1 on the new test block and **all four were re-run at the
      formatted tree**; both files md5-identical on h1claw and h2puni before the
      commit.

## 4. The API

- [x] 4.1 `apps/be-01/src/controller/calendar-marker.controller.ts` — list,
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
- [x] 4.2 Write permission — every mutation refused for a read-only actor with
      the same status the project's other writes use — test: same file, a
      read-only actor against each of the four mutations, asserting the status
      and that no row was written. Negative: the permission check removed from
      the create path, watched failing on the create case. A permission test
      that only checks the happy path is not a permission test.
- [x] 4.3 A create whose `date` is not an `IsoDate` is refused with a typed
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
- [x] 4.4 The client-supplied `markerId`, its fallback and its collision — test:
      same file, three cases: a create carrying a `markerId` stores that exact id;
      a create omitting `markerId` is issued one by `Clock.newId()` (asserted
      through the fake
      clock the suite already injects); a create repeating an existing id is
      refused with no row added and the existing marker's name, date and colour
      unchanged. Negatives, two. For the last: the insert written as an upsert,
      watched overwriting the existing row — a duplicate-id test that only
      asserts an error status passes against an upsert that already destroyed
      the row. And for the first, **the server fault `design.md` §6.1 named and
      no slice owned** (round-12 Sol review, Minor): the create ignoring the
      supplied `markerId` and calling `clock.newId()`, watched failing the
      exact-id
      case. §6.1 named it while 3.5 requires a **front-end** fault and delegates
      the server half here, so until now it was owed by neither slice and the
      exact-id case was a positive with nothing watching it. It belongs here
      because this is the only file that executes be-01 code.
- [x] 4.5 Refusals name their field and apply nothing — test: same file, one
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
- [x] 4.6 Project isolation, and a marker is not a work item — test: same file,
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
      apart** (round-14 self-review): the **list-path read** — a `work_item`
      read added on the list path, watched failing the reach
      assertion — and the **recolour-branch read** described below.
      **Both are injected in `CalendarMarkerRepository`, not in the controller
      handler this sentence used to name** (watched 2026-09-05): the handler
      holds `auth` and a `CalendarMarkerService` and no drizzle client at all,
      so a `work_item` read cannot be written there without first plumbing one
      in — and the plumbing, not the read, would then be what the negative
      tested. `listFor` is reached only by the list and `recolor` only by the
      colour branch, so the two faults stay exactly as separate as the handler
      sites would have been, and injecting a layer **below** the controller is
      the stronger demonstration of why the oracle is a runtime SQL log: the
      controller source stays clean while the read still shows up. Round 13
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
      negative, and it must be the delete path's own: **the delete path scoped
      by marker id alone** — the `project_id` term dropped from _both_ of
      `CalendarMarkerRepository.remove`'s statements, its `one(...)` guard read
      and the `tx.delete(...)` beneath it — watched failing this case with B's
      row gone, while the list query, the patch route and both cases above stay
      green: a fault the first negative cannot reach, because it mutates the
      list predicate and the delete never runs through it.
      **The narrower form this sentence asked for until 2026-09-05 cannot fail,
      and that is a finding rather than a wording fix.** It named the predicate
      "dropped from the **delete** statement only". Watched: the whole file
      stayed **23 pass / 0 fail**. `remove` reads the marker through the scoped
      `one(tx, projectId, id)` first and returns `not_found` before the `DELETE`
      is ever issued, so that statement's own `project_id` term is unreachable
      defence and **no test can falsify it** while the guard read stands. It is
      kept — a guard read is one refactor from being inlined away — but it is
      documented as redundant rather than asserted as load-bearing. The delete
      path's only _reachable_ scope fault is the one above, and it is the fault
      this sentence described in prose all along ("a delete matched on marker id
      alone").
- [x] 4.6a The client-supplied `markerId` must be a UUID v4 — test: same file, a
      create with `markerId: 'marker-1'` and one with a v1-shaped UUID each
      refused naming the `markerId` field, with the marker count unchanged after
      each.
      Negative: the UUID check replaced by a non-empty-string check, watched
      letting `'marker-1'` through and writing a row. This does **not** make the
      id spaces disjoint — nothing does, and the spec says so — it bounds the
      shape of what a client may name.

## 5. The schedule identity guarantee

- [x] 5.1 The canonical schedule projection is identical with and without
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
      **CORRECTION — that injection as worded cannot fail either, watched
      2026-09-05 (run 8, chunk 14).** A floor whose value is a marker's date but
      whose _presence_ does not depend on any marker existing is applied to
      **both** captures alike, and this test compares the two captures to each
      other rather than to a stored expectation — so the whole projection moves
      by the same amount twice and the equality still holds. Watched: a
      `notBefore` floor of `workdaysBetween(project.startDate, '2026-08-25')`
      set on the seeded `Sand` row inside `tree()`, and the file stayed **1 pass
      / 0 fail**. "Derived from a marker's date" has to mean **read from
      `calendar_marker`**, so that the fold is absent in the first capture (no
      markers yet) and present in the second (five markers). That makes 5.1's
      negative the same shape as 5.1a(iii)'s and it needs the same plumbing —
      `tree()` holds no marker client, so the injection reaches the table
      through a repository the service already has. Do 5.1a(iii) first and
      spend its injection on both slices.
      **CORRECTION — `seq` is not excluded yet, and must not be.** The
      minus-one-key form is justified by "a marker mutation advances `seq` by
      design", which is false until slice group 9:
      `CalendarMarkerService` is constructed from `{ projects, markers, clock }`
      and holds no `Broadcaster`, so no marker write reaches
      `broadcast.latestSeq`. Deleting a stationary field is strictly weaker than
      comparing it — the exact trap this slice's own "justified rather than
      asserted" sentence names. The test therefore compares the body with **no**
      exclusion and goes red the moment group 9 wires the broadcast; that
      chunk restores the deletion together with the `seq`-advanced assertion.
      **Line citations in this slice are stale** as of `e4f8eae0`: `seq` is
      read at `work-item.service.ts:1366` and returned at `:1655` (not
      `:1147-1159`), the payload fields are declared around `:1217-1290`, and
      5.1a's scheduler call site is `:1548` (not `:1458`) — where it reads
      `optimized ?? schedule(...)` over the same six arguments 5.1a(a) names, so
      that check stands as written once its line number is corrected.
      `notBefore` is built at `:1484-1489`.
      **DONE 2026-09-05 (run 9, chunk 17), and its negative is 5.1a(iii)'s
      injection** — which is how run 8's correction resolves. Only a fold that
      is **absent in the first capture and present in the second** can fail a
      test that compares two captures to each other, so the injection had to be
      conditioned on a real `calendar_marker` read; that is exactly (iii), and
      spending it here is what the correction directed. Watched failing on
      `latestStart` 0 → 2 for the seeded `Sand` row. **5.1a(iv) fails this case
      too, and on a different field**: it moves `teamCapacities` and no
      schedule field at all — which is the whole-body comparison earning its
      keep, because every enumerated field list rounds 3 and 4 proposed was a
      list of _schedule_ fields and (iv)'s fold walks straight through all of
      them. `seq` stays **inside** the comparison, unchanged from chunk 14.
- [x] 5.1a The scheduler seam is free of markers **at the seam and at the
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
      **(a) AND (b) DONE 2026-09-05 (run 8, chunk 16); (c), (iii) and (iv)
      remain.** (a) parses the argument list off the call site and compares it
      as a list rather than matching a substring, because the fault it exists
      for is an extra argument and `toContain('schedule(')` survives that. The
      **line number is deliberately not asserted** — this slice said `:1458`
      and the call is at `:1548`, and pinning it makes the test fail on every
      edit above it.
      **CORRECTION to negative (i): it does not leave 5.1 green.** Appending a
      seventh argument is **not** "ignored by the engine" — with
      `schedule(..., project.depReach, project.id)` the `createWorkItem`
      command answers **500** and 5.1 dies in its own seed, so the run is
      **0 pass / 2 fail** rather than the isolated (a) failure this slice
      describes. (a) is still watched by it, which is what (a) needs; what is
      wrong is the isolation claim. A negative that keeps 5.1 green has to pass
      an argument the engine genuinely tolerates.
      **(ii) is exactly as specified: 1 pass / 1 fail.** A
      `import type { MarkerBackdrop } from './marker-color'` added to
      `libs/domain/src/schedule.ts` with a dead local referencing it fails
      (a)+(b)'s case alone while 5.1 stays green. Baseline 2 / 0, restored
      after both.
      **(c), (iii) AND (iv) DONE 2026-09-05 (run 9, chunk 17), which closes
      5.1a and section 5's identity half.** (c) drives
      `GET /api/projects/:id/work-items` against a project with five markers
      through the app's **own** connection, opened with drizzle's `logQuery`
      for every case in the file rather than for a second app beside it, and
      asserts no logged statement names `calendar_marker`. `work_item` is
      asserted **present** in the log first: without that half the assertion's
      whole content is "the log named no marker", which a broken route
      answering nothing passes.
      Both injections reach the table through `WorkItemRepository` — the one
      repository `tree()` already holds, so no plumbing had to be invented for
      them — and **both were caught by the same logged statement**,
      `select "date" from "calendar_marker" where "calendar_marker"."project_id" = ?`.
      (iii) is the **ordering** input, a `notBefore` floor on the seeded `Sand`
      row derived from the latest marker date; (iv) is the **resource** input,
      a `marker-pool` entry folded into `slotsOf` before `slicesOf` is called.
      Each ran **1 pass / 2 fail** — (c) red, 5.1 red, (a)+(b) green throughout,
      which is the isolation this slice's fourth negative asks for and the one
      (i) could not deliver. Baseline 3 / 0 restored after both.
- [x] 5.2 Markers stay out of a saved plan — test:
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
      **DONE 2026-09-05 (run 8, chunk 15), and the injection took two goes.**
      The hash is reproduced through the product's own pipeline —
      `planInputRowsOf` → `canonicalisePlanInput` →
      `serialiseCanonicalPlanInput` → `bodySha256`, the composition
      `saved-plan.service.ts:667-668` writes `input_sha256` from — rather than
      re-serialized here, which would assert this file's own serializer.
      **The first injection did not fail, and why is worth carrying:** marker
      rows appended to `tags` inside `readPlanInput()` changed nothing, because
      the payload's directory projection is **used-only** —
      `saved-plan-input.ts:246` filters registry rows to the ids work items
      actually reference, so rows nothing points at are dropped before the
      digest. A fold has to reach a field the projection keeps. The watched
      injection folds the marker dates into `project.name`, which
      `planInputRowsOf` carries verbatim: **23 pass / 1 fail, exactly this
      case**, on unequal hashes. Baseline 24 / 0, restored after.

## 6. The click surface

- [x] 6.1 The dated axis cell accepts a click and opens the composer on that
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
- [x] 6.2 Hover and click coexist — test: same file, pointer-over then click on
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
- [x] 6.4 The dated cell becomes a control — `role="button"`, `tabIndex={0}`,
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
      **Part of the implementation is already in, and it arrived with 6.1
      because eslint would not let it arrive later** (chunk 19). A `<span>` that
      grows an `onClick` and nothing else fails
      `jsx-a11y/click-events-have-key-events` and
      `jsx-a11y/no-static-element-interactions`, so `role="button"`,
      `tabIndex={0}`, the Enter/Space `onKeyDown` and `aria-haspopup="dialog"`
      shipped in the same commit as the click. **The slice stays unticked**: not
      one of its seven cases exists, and `aria-expanded` and the marker count in
      the accessible name are not implemented at all. What the plan learns is
      that 6.1 and this slice's _implementation_ are not separable — only its
      tests are.
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
- [x] 6.4a The **undated** cell is a keyboard-operable control announcing an
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
      **The remaining two cases now wait on 6.5, not on 7.2.** Chunk 26 read
      them as 7.2's because there was no refusal at all; chunk 27 built the
      refusal and both keys reach it, so what is still missing is only the
      _live region_ — which is 6.5's whole slice. Chunk 27's second case proves
      Enter reaches the refusal; Space on the undated branch is still owed
      here, and it is 6.4a's to write because 6.4a is the slice that promised
      "the same Enter and Space handlers".
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
- [x] 6.5 The refusal is announced, not only drawn — the undated-plan message
      from 7.2 rendered into a live region — test: same file, assert the
      message's container carries the live-region role the app already uses for
      transient status. Negative: the live-region attribute removed, watched
      failing. A message a screen reader never reaches is the silent absence
      `design.md` §1 refuses.
      **Landed (chunk 31).** `role="status"` on the refusal paragraph itself —
      not an alert, the same choice `gantt-panel.tsx`'s filter note makes,
      because nothing is wrong: the plan simply has no start date yet. The
      role carries `aria-live="polite"` implicitly, so the intent is not
      spelled twice. The paragraph **is** the region rather than sitting
      inside one: a wrapper kept mounted while its child came and went would
      announce on the child's insertion — the same event — and would be one
      more element that can lose the role.
      This is also **6.4a's fifth case**, which is why that slice ticks with
      it. The Enter case now locates the message _by the live-region role_ and
      asserts the region is the refusal element, not merely near it. Two
      negatives, against a 187 / 0 baseline on this file: `role="status"`
      removed → **185 / 2**, the Enter and Space cases and nothing else — the
      click case, which still queries by `data-marker-refusal`, stayed green,
      which is exactly why it could never have caught this; and the role moved
      to a wrapper with the message in a nested `<span>` → **186 / 1**, the
      Enter case alone, on the identity assertion. The second is the one that
      makes "in the region" load-bearing rather than "somewhere on screen".

## 7. The undated-plan refusal

- [x] 7.1 `workdayAxis` cells stay dateless — test: `gantt-panel.test.tsx`, a
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
- [x] 7.2 Clicking an undated plan's cell is refused with a message naming the
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
      **TWO OF THE THREE ASSERTIONS SHIPPED IN CHUNK 27; 7.2 STAYS UNTICKED ON
      THE THIRD**, which has no seam and cannot be given one inside this slice.
      There is no calendar-marker writer anywhere on the client:
      `ProjectApi` (`apps/fe-01/src/lib/wbs-api.ts:1155`) carries none, and
      `CalendarMarker` appears in the whole of `apps/fe-01/src` only inside
      `gantt-panel.tsx` and its test. So "the fake API received no create call"
      has nothing to observe — and, which is the part that settles it, the fault
      the assertion exists to catch cannot be written either: a refusal path
      that "posted straight through" has no method to post through. An
      assertion whose negative is uninjectable is the vacuous form this plan
      rejects by name at 9.2b, so it is left out rather than written green.
      **The first negative's predicted matrix is half wrong and the correction
      is this slice's own**: "a composer opened" cannot fail, because the guard
      that opens the composer is `day.date === null` and `setComposerAt(null)`
      renders nothing whatever the refusal branch does. Watched at a 183 / 0
      baseline: `setRefusal(UNDATED_REFUSAL)` neutered in **both** handlers →
      **183 / 2**, the two new cases alone, on a `toMatch` that received
      `undefined` instead of a string — the message half, never the composer
      half.
      A third negative, not in the plan before and the one that makes _naming_
      the missing date load-bearing rather than merely _saying something_: the
      message replaced by a generic "this day cannot carry a calendar marker"
      → **183 / 2**, the same two cases, on that generic string failing to
      match `/project start date/`.
      **THE THIRD ASSERTION LANDED (chunk 39, 899dbc52) and 7.2 is ticked.**
      7.2a gave `ProjectApi` its writer and 3.5 gave the composer the save that
      uses it, so the fault this assertion exists to catch is injectable at last.
      The refusal fixture now takes an `onCreateMarker` wired to `fakeProjectApi`
      and the click case asserts **two** oracles — the recorder's call log and
      the fake's own store, because a recorder that logged without performing
      would show an empty log either way.
      It is the **last** assertion in the case on purpose: the message and
      composer halves have to be seen green in the same run for the negative to
      say anything, and an assertion placed above them would fail first and
      prove less.
      SECOND NEGATIVE WATCHED, and it is the one the first cannot reach because
      it leaves the refusal branch intact: the undated **click** arm also
      issuing an `onCreateMarker` for a synthesised `2026-08-19` →
      **195 pass / 1 fail on `gantt-panel.test.tsx`, this case alone**, on
      `expected [['p1', {…}]] to deeply equal []` — the
      no-create assertion, with the message and composer assertions green above
      it in the same run and both keyboard cases untouched (the fault was put in
      the click handler alone, so the arm it isolates is the arm it names).
      Test count is **unchanged at 2250**: this chunk added assertions to an
      existing case rather than a case, which is what the slice asked for.
- [x] 7.2a The client's calendar-marker **write seam** — `ProjectApi` gains the
      marker methods be-01 has carried since section 4, so 7.2's third
      assertion and 6.3's `PATCH`-body oracle have a call log to read. Its own
      slice and not a line inside either of them, because the cost is not the
      method: `ProjectApi` is implemented by object literals in roughly fifteen
      test files (`plan-cards`, `plan-cells`, `plan-dependencies`,
      `plan-estimates`, `plan-chart-seam`, `project-page`, `app-router` and
      more), and a required method added to the interface reddens every one of
      them at once. That is a mechanical change across files this task
      otherwise never touches, and folding it into a refusal slice would put a
      fifteen-file diff behind a two-assertion test.
      **6.3 needs this before it can start**, not only 7.2: 6.3's rename and
      recolour cases name "the fake API's recorded request" as their oracle and
      there is no request to record. Whichever of the two runs first should
      land this.
      **Landed (chunk 30). The fifteen-file estimate above was wrong, and
      measured so: `fe-01:typecheck` named exactly two files** —
      `testing/fake-project-api.ts` and `gantt-panel.test.tsx`. Everything else
      goes through `testing/refusing-api.ts`, which is a `Proxy` and therefore
      grows every method the interface grows without a line changing. The cost
      this slice was split out for does not exist; it was split out anyway, and
      the record of why it does not is worth more than the split.
      Five methods, matching be-01's four routes: `listCalendarMarkers`,
      `createCalendarMarker`, `renameCalendarMarker`, `recolorCalendarMarker`,
      `deleteCalendarMarker`. Rename and recolour are **two calls onto one
      `PATCH`** because the route refuses a body naming both — a single
      `edit(name?, color?)` would be a surface whose two-field call can only
      ever be refused. `CalendarMarkerView` moved from `gantt-panel.tsx` to
      `lib/wbs-api.ts` (the component re-exports it, so no importer changed),
      which is what stops the drawn shape and the fetched shape from being two
      declarations free to disagree. Five cases in `lib/wbs-api.test.ts`, each
      watched failing alone: the automatic colour sent as `undefined` → body
      `{}`, the 422 arm (**the one that makes `null` load-bearing**, since
      `JSON.stringify` drops an undefined member); the create's id sent as `id`
      rather than `markerId`; the rename carrying a colour too; the delete
      aimed at the collection; the list handed back unwrapped. Gates: full
      `fe-01:test` 2241/0 across 86 files (+5), typecheck rc 0, scoped eslint
      rc 0, `prettier --check .` rc 0.
- [x] 7.3 Giving that project a start date turns the same cell live — test:
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

- [x] 8.0 `axisOffsetOf(axis, date)` — `todayOffset` (`gantt-panel.tsx:872`,
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
- [x] 8.1 The chip in the axis band, placed by `axisOffsetOf` — test:
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

## Implementation notes — chunk 1 (TASK-235 run 1, 2026-09-05)

Two things the plan said that the code did not.

**`migrate-down-cli.ts --to=<migration>` does not exist.** Slice 2.2a named it
for the rollback case. `apps/be-01/src/repository/migrate-down.ts` exports
`rollbackTo(dbPath, migrationsFolder, target)` and there is no CLI beside it, so
the case calls the function. `readMigrationFolders` is also the migration lint
the slice refers to — a missing or empty `down.sql` throws there, which is what
makes both halves of 2.2a's negative reachable from one test file.

**A bare `DELETE FROM project` does not succeed on main either.** Slice 2.2's
cascade case was first written seeding a starting step, and it failed with
`FOREIGN KEY constraint failed` before this change existed: `step`, `work_item`,
`dependency` and `project_access` all reference `project` with **no** `ON DELETE`
action at all (`schema.ts:244,277,498,1639`). The outgoing release deletes those
itself; what it cannot delete is a table it has never heard of. The case now
seeds a bare project, so the only reference between the delete and success is
this migration's — and the mutation reproduces exactly that red.

**A new migration folder is not a local change.** Fifteen reversal-list
assertions in `migrate.db.test.ts` and four more files (`migrate-down`,
`identity-migration`, `saved-plan-migration`, `saved-plan-created-by-id`,
`project`) assert the applied set newest-first as an exact array. The four-file
run was green while the whole-directory run was 81 red; a later slice adding a
migration owes the same sweep.

## Implementation notes — chunk 2 (TASK-235 run 2, 2026-09-05)

Slices **3.1, 3.2 and 3.2a** landed, 3.2 first as the dependency order says.
Everything is in `libs/domain/src/marker-color.ts` and its test; the measured
results are in `verify.md`. Four things the plan got wrong or could not know:

1. **The palette's luminance is forced, and the palette is at the ceiling.**
   Clearing 3:1 against both `light:pointed+today` (L 0.7242) and
   `dark:base+weekend+zebra+today` (L 0.02908) confines every fill to
   `0.1872 <= L <= 0.2081`. The constraints balance at `L = 0.19744`, where the
   best attainable worst case over the 20 is **3.129**; the landed palette
   measures **3.108**. So "an entry that fails one is replaced before it lands"
   (design.md §6) has no slack to work with — there is no better palette, and
   the entries are separated by hue and chroma alone. Recorded rather than
   discovered again by the next person who tries to widen the bar.
2. **All eight entries take black ink, so 3.2a's palette table cannot prove the
   chooser.** The ink crossover is `L ≈ 0.17913` and the whole window is above
   it. The plan's first negative (`labelInk` hard-coded to `'#ffffff'`) is still
   watched failing, but the _opposite_ constant agrees with every recorded
   label. The discrimination is therefore carried by the sRGB cube's two ends,
   which the plan already asked for — it is load-bearing here rather than
   supplementary.
3. **The crossover case cannot be "within 1e-6".** `labelInk` takes `#rrggbb`,
   so the tightest approach to `L = sqrt(0.0525) - 0.05` is one 8-bit step:
   `#757575` sits 0.0012 below and `#767676` above. The case brackets it with
   both neighbours instead, which covers whichever side a strict inequality
   would fall through, and asserts both still clear 4.5:1.
4. **`parseHex` takes six digits only.** The three-digit form tripped
   `@typescript-eslint/no-misused-spread` and nothing in the change uses it; a
   validator that silently widened `#f00` would accept a shape no stored marker
   has.

Two gate traps, both already recorded by chunk 1 and both hit again:

- **`tsc --build` leaves `dist/out-tsc`, and the bun runner then collects every
  compiled test a second time.** A run straight after `nx typecheck` reported
  729 tests across 56 files with 7 red; `rm -rf dist` first and the same tree is
  382 across 28, all green. Delete `dist` between the typecheck and the tests,
  not merely before them.
- **`nx` without `NX_DAEMON=false` can exit 0 having computed nothing.** The
  first typecheck attempt printed `Nx Daemon was not able to compute the project
graph` and still returned `rc=0`; the target never ran. Every gate number in
  this chunk was taken with the daemon disabled.

`fe-01:typecheck` is **`Killed`** on h2puni — OOM, not a type error, the same
class that OOM-killed `fe-01:lint` for lane a earlier today. `domain:typecheck`
and `be-01:typecheck` both pass, and this chunk changes three files under
`libs/domain/src`. CI is the observer for fe-01.

## Implementation notes — chunk 3 (TASK-235 run 2, 2026-09-05)

Slice **3.3** landed. `validateCustomColor(hex)` returns
`{ ok, failures, message }`: every failing backdrop in `MARKER_BACKDROPS`
order, and a message naming the **first** of them with its ratio and the bar.

**The refusal names the first failure in table order, not the worst** — an
assumption, recorded because it decides two of the four cases. Ordering by
worst ratio would make case 1 name `dark:base+weekend+zebra+today` (the
lightest dark surface, which any dark-failing colour fails hardest) rather than
`dark:base`, and would make case 2 unwritable: `dark:base+weekend+today` is
never the worst failure, because `dark:base+weekend+zebra+today` is lighter and
always scores below it. Table order is light-then-dark and base-then-composite,
which reads as a diagnosis. **What would falsify it:** a user report that the
named surface is not the one they were looking at — the full `failures` array
is already in the verdict, so the message is the only thing that would change.

**Shape is a precondition, not a verdict.** `validateCustomColor` throws on a
malformed hex rather than returning `ok: false`; the API schema and the
composer's input refuse a typo, and folding the two together would let a
contrast message answer one. Asserted as its own case.

Three colours, all recorded in `verify.md`:

| case                                 | colour               | what it proves                                                                                                                                       |
| ------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| clears light, fails dark             | `#7a3400` (L 0.0659) | first failure is `dark:base` at 2.226                                                                                                                |
| clears both bases, fails a composite | `#0066ff` (L 0.1672) | clears three of the six earlier dark composites and first fails at `dark:base+weekend+today` — the window for that shape is `0.16476 <= L < 0.16803` |
| 19 of 20                             | `#ff0000` (L 0.2126) | exactly one failure, `light:pointed+today` at 2.943                                                                                                  |

**Three negatives watched failing, and the separation the plan asked for holds:**

- validator accepting everything → all three refusal cases red, the backdrop
  table case green;
- one entry deleted from `MARKER_BACKDROPS` → the table case red **alone**, both
  colour cases green, which is the fault the colour cases cannot see;
- the loop narrowed to the two backdrops the first two cases name →
  `MARKER_BACKDROPS` byte-identical and the table case green, with the 19-of-20
  case red. **It also reddens case 2**, which the plan did not predict: that
  case asserts the complete `failures` array rather than only the first entry,
  so a truncated loop shortens it. The discrimination the plan wanted — table
  intact, loop wrong — still holds, and is proved by the table case staying
  green under this fault.

`@typescript-eslint/restrict-template-expressions` rejects a `number` in a
template literal, so the message wraps both in `String(...)`. Same class as
chunk 2's `no-misused-spread`: the domain lint config is stricter than the
default and neither rule is autofixable.

## Merge with main — chunk 4 (TASK-235 run 2, 2026-09-05), CLOSED GREEN at 9f775619

**`f84b39da` is the merge of `origin/main` after PR 203 (TASK-219) landed. It
was red at that head for nine assertions and is green at `9f775619`:
`apps/be-01/src/repository` is 547 pass / 0 fail across 44 files on h2puni,
`libs/domain` 506/0, `nx format:check --all` rc 0.** The paragraphs below are
kept as the record of what the merge cost, because the same class reopens every
time a migration folder lands beside another branch's.

**The conflicts were all one shape and are resolved.** Main added two migration
folders (`20260904100000_add_optimizer_tables`,
`20260904140000_add_project_settings`); `20260905090000_add_calendar_marker`
sorts newest, so it takes the head of every reverse-chronological rollback list.
26 hunks were that literal shape, three needed the two sides genuinely merged
(`project.db.test.ts` uses raw strings rather than constants, and
`saved-plan-created-by-id.db.test.ts` had a one-line array on one side and a
four-line one on the other), and `libs/domain/src/index.ts` keeps both new
exports.

**What was red — nine cases, and every one a list this branch was not named
in.** Chunk 1 recorded that a new migration folder touches nineteen exact
reversal-list assertions across five files; main's two folders landed between,
so the same class reopened against assertions written after chunk 1 read them.
`apps/be-01/src/repository` at `f84b39da` is **538 pass / 9 fail** on h2puni:

| file                                         | what to change                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `calendar-marker-migration.db.test.ts:149`   | `expect(reversed).toEqual([CALENDAR_MARKER])` — the named predecessor is now two folders back, not `saved_plan_created_by_id` |
| `migrate-down.db.test.ts:484,597,704`        | `readMigrationFolders` list and two `appliedNames` lists                                                                      |
| `optimizer-migration.db.test.ts:142,172,245` | `rollbackTo(..., OPTIMIZER_TABLES)` returns `[PROJECT_SETTINGS]` and must now return `[CALENDAR_MARKER, PROJECT_SETTINGS]`    |
| `project-settings.db.test.ts`                | the newest-migration assertion expects `project_settings` and receives `calendar_marker`                                      |
| `migrate-down.db.test.ts:220`                | the `LOOKUP_INDEXES` reversal list                                                                                            |

Every one is additive — `CALENDAR_MARKER` at the head of a list, or one
expectation of "the newest" moving by one. None is a behaviour change, and the
watched mutations from chunk 1 still hold: this branch's own four migration
faults are unaffected by any of them.

**Re-gate with `rm -rf dist` first and `NX_DAEMON=false`**, for the two reasons
chunk 2 recorded.

### The half of it that was not mechanical

The first resolution pass treated every list as reverse-chronological and put
`CALENDAR_MARKER` at the head of all of them. **Three of the lists run the
other way.** `readMigrationFolders` returns the folders on disk oldest-first and
`appliedNames` returns them in the order they were applied, so in those three
`calendar_marker` belongs **last**; only a `rollbackTo` result is newest-first.
Six assertions were red for the missing entry and three for the entry being in
the wrong place, which reads as one failure count and is two faults.

Two more needed a judgement rather than an entry:

- `calendar-marker-migration.db.test.ts`'s `PREVIOUS` named
  `saved_plan_created_by_id`, and TASK-219 put two folders between. It is now
  `project_settings`, still named rather than computed, so a third folder
  arriving there is a red test and not a silently widened rollback.
- `optimized-schedule-cache.db.test.ts` asserted `names.at(-1)` and
  `names.at(-2)`, which is "the last two folders" wearing the name "immediately
  before the project-settings migration". It is now positional against
  `PROJECT_SETTINGS` itself, so it keeps meaning what it says as folders land
  above it. Its `ALSO_ROLLED_BACK` gained `calendar_marker` for the same reason.

## Implementation notes — chunk 5 (TASK-235 run 3, 2026-09-05)

**Slice 4.1's storage half.** `CalendarMarkerRepository`
(`apps/be-01/src/repository/calendar-marker.ts`) with `listFor`, `create`,
`rename`, `recolor` and `remove`, the `CalendarMarkerStore` contract in
`repository/index.ts`, and `calendar-marker-repository.db.test.ts` — twelve
cases against real SQLite. **4.1 stays unchecked**: the HTTP half — the
controller, `buildApp` wiring and `calendar-marker.controller.db.test.ts` — is
not written, and 4.1's checkbox is about the routes.

**Why the storage half is its own chunk rather than the first half of a big
one.** Two of 4.1's three named assertions are _database_ claims and nothing
above SQLite can carry them: the total order's third key is the engine's own
tie-break, and the absent-project refusal exists to keep a foreign key from
throwing. Both are provable now, and both would have been proved through four
more layers if they had waited for the routes.

**The ordering case's two ids are pinned twice over.**
`b1000000-0000-4000-8000-000000000001` and
`f1000000-0000-4000-8000-000000000002` are inserted in the reverse of their
lexical order, so insertion order and the asserted sequence disagree and the
`id` key is the only thing that can produce it — which is this slice's own
finding, that two reads of a tied pair can agree with the key gone. They also
land in **different palette buckets** (7 `magenta`, 6 `violet`), which is what
makes 3.1(c)'s same-date distinctness assertion a real oracle rather than a
one-in-eight coin flip. The rename-stability marker is
`c1000000-0000-4000-8000-000000000003`, bucket 0 `crimson`.

**3.1(b) and 3.1(c) are housed here, as the round-7 Gemini review required** —
`automaticColor(markerId)` sees neither a name nor a date, so their oracles have
to live where a marker is really renamed and where two really share a date.
Both are cases in this file. Their _mutations_ stay 3.1's.

**FOUR NEGATIVES WATCHED FAILING, each in a different place, each exactly one
case** (h2puni, the one file, 2026-09-05):

1. `asc(calendarMarker.id)` struck from the `orderBy` → only `orders a tie on
(date, created_at) by id`, on a `toEqual` diff of the two-id sequence. 11
   pass, 1 fail.
2. The project-existence read inside `create`'s transaction struck → only
   `refuses a marker on a project nothing holds, and writes nothing`, with an
   uncaught `SQLiteError: FOREIGN KEY constraint failed` where a modelled
   `not_found` was owed. 11 pass, 1 fail.
3. The duplicate-id read struck → only `refuses a repeated id and leaves the
stored marker untouched`, `SQLiteError: UNIQUE constraint failed:
calendar_marker.id`. 11 pass, 1 fail.
4. `one()`'s `projectId` scope dropped from the `WHERE` → only `answers
not_found for another project's marker, and never touches it`. 11 pass, 1
   fail.

**The audit guard caught this chunk before anything else did, and that is the
trap worth recording.** `audit.test.ts` reads every non-test file in
`repository/` for `.insert(x)` / `.update(x)` and requires each to stamp
`auditOnCreate` / `auditOnUpdate`. A new repository over a table with no audit
columns is therefore **two red cases on its first run** — `stamps every insert`
and `stamps every update` — with nothing wrong with it. The answer is the
`EXEMPT` set, and the set is itself guarded: `exempts only tables that carry no
audit columns` re-reads `schema.ts` and fails an exemption for a table that does
carry them, so the escape hatch cannot silence the guard on a table that should
be stamped. `calendarMarker` is exempt because its `created_at` is an **ordering
key, not a stamp**, and the change's spec forbids a per-marker role, so a
`created_by` would name an author no later decision consults.

**Lint's two rules to know here:** `noUncheckedIndexedAccess` is off, so
`array[0]` is non-nullable and both `?.` and `!` on one are
`no-unnecessary-condition` / `no-unnecessary-type-assertion` errors. Seven of
them, all in the new file.

**GATES on h2puni (`~/t235-gate`, `NX_DAEMON=false`).** `nx run-many -t test -p
be-01 domain` rc 0: be-01 **1530 pass / 0 fail** across 125 files against a
measured baseline of 1518 — exactly the twelve new cases, no regression — and
domain 506 / 0 unchanged. `nx run-many -t lint typecheck -p be-01 domain` rc 0.
`nx format:check --all` rc 0. `rm -rf dist` before each whole-directory run, per
chunk 1's trap.

**Next chunk:** 4.1's HTTP half — `calendar-marker.controller.ts`, a
`CalendarMarkerService` seam if one is wanted, `buildApp` wiring and
`calendar-marker.controller.db.test.ts`. 4.2 (write permission) and 4.5 (the
eight-row refusal table) fall out of the same file, and 3.4's two server faults
need the create and recolour handlers to exist before either can be removed.

## Implementation notes — chunk 7 (TASK-235 run 4, 2026-09-05)

**Slice 4.1's HTTP half, and 4.1 is now checked.** `77ee990a` on
`change/gantt-calendar-markers-impl`, PR 209. Four new files —
`service/calendar-marker.service.ts`, `controller/calendar-marker.controller.ts`,
`testing/calendar-marker-fixture.ts` and
`controller/calendar-marker.controller.db.test.ts` — plus the wiring and a
regenerated `apps/be-01/openapi.json`.

**A service seam, not a controller talking to the store.** The previous chunk's
note left it open. It is there because the _permission_ decision needs the
project row and the store deliberately knows nothing about projects: putting
`canEdit` in the controller would have made the gate a property of four call
sites remembering it, which is the exact shape `CalendarMarkerRepository`'s own
`WHERE`-clause scoping exists to refuse one layer down.

**Reading is not gated on write permission, and that is a decision rather than
an omission.** `projectController` already lets a non-owner read a restricted
project (`project.controller.test.ts`, "lets a non-owner read a restricted
project"), and a marker is part of what the axis draws. `canEdit` gates the four
writes only.

**Rename and recolour narrow through two explicit arms.** The obvious spelling —
a `renaming`/`recoloring` flag pair and a ternary — does not typecheck without
`body.color as string | null`, and eslint's
`non-nullable-type-assertion-style` refuses it. Two arms (`name !== undefined &&
color === undefined`, then the mirror) narrow naturally, and a body naming
**both** falls to the same 422 as a body naming neither: two writes the store
applies one at a time is a partial apply the moment the second refuses.

**`calendarMarkers` is required in `AppOptions`,** for `history`'s stated reason.
That cost 17 call sites one line and one import each — the whole of the
69-line modified half of this diff. An optional service would have let a
process answer 404 on every marker route, which a client cannot tell from a
project that has no markers.

**THE NEGATIVE, WATCHED THROUGH THE ROUTES.** `asc(calendarMarker.id)` struck
from `CalendarMarkerRepository.listFor`'s `orderBy`, against real SQLite:
3 pass / 1 fail, failing on the **first** read
(`calendar-marker.controller.db.test.ts:232`) with
`Expected ["b1000000-…-000000000001", "f1000000-…-000000000002"]` and
`Received ["f1000000-…-000000000002", "b1000000-…-000000000001"]` — insertion
order exactly, which is the flakiness the third key exists to remove and which
an equality-of-two-reads assertion would have passed straight through. Restored:
4 pass / 0 fail. Watched 2026-09-05.

**3.1(b) and 3.1(c) are NOT duplicated here.** Chunk 5 housed them in
`repository/calendar-marker-repository.db.test.ts`, which is where a marker is
really renamed and where two really share a date. 4.1's paragraph asks for them
in this file; one home is the requirement and two would be two oracles free to
disagree.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first):
`test` over be-01 and domain rc 0 — be-01 **1534 pass / 0 fail across 126
files** against chunk 5's measured 1530 / 125 baseline, exactly the four new
cases and no regression; domain 506 / 0 unchanged. `lint` over be-01 and domain
rc 0. `format:check --all` rc 0. `be-01:typecheck` rc 0 — **on its own**: run
concurrently with `lint` it was `Killed`, with `free -m` showing 2.4 GB
available of 15.6 GB while other lanes gated. That is the OOM class that killed
`fe-01:typecheck` in run 2 and `fe-01:lint` for lane a, one project further in.
Lint's first pass found 19 real errors — 17 import-sort (the option lines were
inserted by script, before the anchor import rather than in sorted position) and
the assertion above; `--fix` plus `format:write` cleared them.

**`apps/be-01/openapi.json` is regenerated, not hand-edited** —
`bun apps/be-01/src/openapi/emit-openapi-cli.ts` on h2puni, +232 lines, the two
new paths at `/api/projects/{id}/calendar-markers` and
`…/{markerId}`. `openapi-document.test.ts` diffs the committed document against
the app, so a route added without this is a red with a confusing name.

**Next chunk:** 4.2 (the other three mutations plus the removed-check negative),
4.3 (`IsoDate`, typed 422) and 4.6a (UUID v4) — all in the same file, all
validation the create and patch handlers do not do yet. 4.4, 4.5 and 4.6 follow.

## Implementation notes — chunk 8 (TASK-235 run 4, 2026-09-05)

**Slices 4.2, 4.3 and 4.6a, all three checked.** `82e26cb5`. One new helper in
`calendar-marker.controller.ts` — `createProblem(body)`, returning the refusal
table's `{ reason, field }` or `null` — and five more cases in
`calendar-marker.controller.db.test.ts`.

**Validation runs in front of the service, not inside it.** A refused body
never reaches `CalendarMarkerService.create`, so "refused" and "unchanged" are
one fact rather than two — a validate-after-write is what breaks the second.

**`isIsoDate` rather than a regexp of this file's own.** It already rejects
`2026-02-31`, which matches `^\d{4}-\d{2}-\d{2}$` and is not a day, and it is
what `ProjectService.patch` answers `startDate` against. A second spelling would
be a second rule free to disagree with the one the rest of the API applies.

**The UUID check pins the version and variant nibbles, not the length.** A v1
UUID is the same length and the same alphabet, and it carries a MAC address and
a timestamp a marker id has no business publishing. This still does **not** make
the id spaces disjoint — 4.4 lets a client name its own id, and route-family
disjointness (4.6) is what forbids a marker reaching work-item code.

**One `it` per fixture rather than a loop over them**, and it changed what the
negatives prove. The first version looped inside one case; the truthiness
negative then stopped at whichever date the loop reached first and the record
would have named the wrong row. Split, the negative names every row it reddens.

**THREE NEGATIVES WATCHED, each in a different place, baseline 9 pass / 0 fail:**

- **4.3** — `isIsoDate(body.date)` replaced with `body.date`, a truthiness
  check: **6 pass / 3 fail**, reddening all three date rows including
  `2026-09-17T00:00:00Z`, each `201` where `422` was owed. The timestamp is the
  row the spec names because it is the one a _plausible_ lax validator lets
  through; the other two are not strings any check would mistake for a date.
- **4.6a** — `UUID_V4.test(body.markerId)` replaced with `body.markerId.length > 0`:
  **7 pass / 2 fail**, both id rows, `marker-1` among them.
- **4.2** — the `forbidden` arm dropped from `create`'s gate in
  `CalendarMarkerService` **only**: **8 pass / 1 fail**, failing at the create
  assertion inside the permission case (`201` where `403` was owed) while the
  rename, recolour and delete assertions in that same case stayed green — which
  is what shows the four arms are four checks and not one.

Restored after each: 9 pass / 0 fail.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first):
`test` over be-01 and domain rc 0 — be-01 **1539 pass / 0 fail across 126
files**, exactly the five new cases over chunk 7's 1534; domain 506 / 0. `lint`
over be-01 and domain rc 0. `be-01:typecheck` and `domain:typecheck` rc 0, run
**one at a time** for chunk 7's OOM reason. `format:check --all` rc 0.
`apps/be-01/openapi.json` regenerated and **byte-identical** (sha256
`55f6b6c5…`) — this chunk added no route and changed no body schema.

**Next chunk:** 4.4 (the client id, its `clock.newId()` fallback and its
collision, two negatives), 4.5 (the eight-row table with the astral name
boundaries, three negatives) and 4.6 (isolation and route-family disjointness
through a drizzle `logQuery` reach assertion, three negatives).

## Implementation notes — chunk 9 (TASK-235 run 4, 2026-09-05)

**Slice 4.4, checked.** `4262c281`. **Test-only** — `marker.id ??
this.clock.newId()` and the store's `taken` refusal both already shipped in
chunks 7 and 5; what was missing was anything watching them.

The app's test clock now mints exactly one id, `MINTED`. A random one would
have made the fallback assertion "a UUID appeared", which a create ignoring the
clock entirely also satisfies.

**TWO NEGATIVES WATCHED, baseline 12 pass / 0 fail:**

- **The create ignoring the supplied `id`** — `marker.id ?? this.clock.newId()`
  replaced with `this.clock.newId()` in `CalendarMarkerService.create`:
  **9 pass / 3 fail**. The slice's own case, `stores the exact id the create
carried`, is one of the three; the round trip and the tie case also supply
  ids and legitimately break with them. This is the server fault `design.md`
  §6.1 named and no slice owned until now — 3.5 requires a _front-end_ fault
  and delegates the server half here, and this is the only file executing be-01
  code.
- **The insert written as an upsert** — the duplicate-id read struck and
  `.onConflictDoUpdate({ target: calendarMarker.id, set: marker })` in its
  place: **11 pass / 1 fail**, exactly the collision case, which is what the
  "and leaves the stored marker untouched" third of that assertion buys. A
  duplicate-id test asserting only the status passes against an upsert that has
  already destroyed the row on its way to answering.

Restored after each: 12 pass / 0 fail.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first):
`be-01:lint` rc 0, `format:check --all` rc 0, `be-01:typecheck` rc 0,
`test` over be-01 and domain rc 0 — be-01 **1542 pass / 0 fail across 126
files**, exactly the three new cases over chunk 8's 1539; domain 506 / 0.

**Next chunk:** 4.5 (the eight-row refusal table, the astral `MARKER_NAME_MAX`
boundaries and the hex/contrast rows, three negatives) and 4.6 (isolation, the
cross-project delete, and route-family disjointness through a drizzle
`logQuery` reach assertion, three negatives). Those two close section 4.

## Implementation notes — chunk 10 (TASK-235 run 5, 2026-09-05)

**Slice 4.5, checked.** The eight-row refusal table is now answered row by row,
and answering it needed three rules the routes did not have: the `name` cap, the
hex-triple shape, and the 3:1 contrast bar.

**One default, not two ladders, and this is what makes the first negative
reachable.** `MARKER_ROUTE_DEFAULT = 422` is now a named constant and _every_
refusal these routes answer leaves through `statusForRefusal(reason,
MARKER_ROUTE_DEFAULT)` — the body ones included, where chunk 8 had written
`set.status = 422` inline. With the inline spelling the route default is
**unfalsifiable**: `taken`, `not_found` and `forbidden` each leave through their
own shared arm, so changing the default moves no status at all and the negative
task 4.5 names could not fail anything.

**Two colour rows, two codes, in that order.** Shape is `malformed`, contrast is
`contrast`, and `colorProblem` asks them in that sequence because
`validateCustomColor` states well-formedness as a **precondition it does not
check** — handed `#f00` it throws through `parseHex`, which at a boundary is a
500 blaming the server for the client's typo. `isHexTriple` is new in
`marker-color.ts` and shares the `HEX_TRIPLE` literal with `parseHex`, so "what
the API accepts" and "what the domain can parse" cannot drift apart.

**`MARKER_NAME_MAX` lives in the domain** (`libs/domain/src/marker-name.ts`),
not in be-01, for the reason the colour rules do: slice 6's composer refuses an
over-long name before sending, and two spellings of "too long" are two rules
free to disagree about a name the user is looking at.

**THE FINDING OF THE CHUNK, and it was three existing tests going red:**
`#4c3a86` — the custom fill the round trip, the permission case and the
collision case had all been sending since chunk 7 — **fails ten of the twenty
backdrops** (`dark:base` at 2.166 down to `dark:base+weekend+zebra+today` at
1.419). It was never a fill this API could accept; nothing had measured a custom
colour until this slice. Replaced by a named `CUSTOM_FILL = '#5d6afe'`
(`azure`, a `PALETTE` entry, clean over all twenty). The permission case is the
one that mattered: a 403 case whose body is _independently_ refusable is not a
permission case, and it would have started passing for the wrong reason the
moment the gate moved.

**THREE NEGATIVES WATCHED, each in a different place, baseline 20 pass / 0
fail on the file:**

- **`MARKER_ROUTE_DEFAULT` 422 → 400**: **9 pass / 11 fail** — every
  `malformed` and `contrast` row red (both colour rows, the contrast row, both
  name rows, the refused rename, all three date rows and both id rows), while
  the three shared-arm rows stayed green: `taken` still 409, `not_found` still
  404, `forbidden` still 403. That split is the whole point of the negative —
  it proves the table tests **this route's default** rather than the shared
  ladder underneath it.
- **`[...name].length` → `name.length` in `isMarkerName`**: **19 pass / 1
  fail**, and the one is the **acceptance** case — a 120-code-point name
  refused 422 where 201 was owed. Every refusal case stayed green, because
  those are wrong at either count. This is the direction that matters (a user
  refused a name the spec allows) and it is only reachable because both
  boundary fixtures are astral: 120 ASCII characters are 120 UTF-16 units too,
  so an ASCII fixture passes over the fault in both directions (round-7 Sol
  review).
- **`nameProblem(name)` moved after `markers.rename(…)`**: **19 pass / 1
  fail**, exactly `refuses an over-cap rename and leaves the stored name
behind`, on the name diff with the status still 422. "Refused" and
  "unchanged" are two claims and only the second reaches the row.

Restored after each: 20 pass / 0 fail.

**Where the eight rows live**, since the table is answered from four places and
not one — deliberately, because two homes for a row would be two oracles free to
disagree:

| row                       | case                                                |
| ------------------------- | --------------------------------------------------- |
| `date` not an `IsoDate`   | 4.3's three date cases                              |
| `markerId` not a UUID v4  | 4.6a's two id cases                                 |
| `color` not a hex triple  | new: `rebeccapurple` and `#f00`                     |
| `name` empty or over cap  | new: `''` and 121 astral code points                |
| `color` under the 3:1 bar | new: `#ff0000`, failing **exactly one** backdrop    |
| `markerId` already exists | 4.4's collision case, its assertion strengthened    |
| absent / another project  | new: a rename of an absent marker                   |
| `forbidden`               | 4.2's create, now `toEqual({ error: 'forbidden' })` |

The last two rows of that table are assertions about **shape**, not just codes:
`taken` and `not_found` now carry `field: 'markerId'` and `forbidden` carries no
field at all, which is why its case is an exact-shape `toEqual` — only that can
fail when a field appears.

`#ff0000` is the contrast fixture because it fails **one** of the twenty
(`light:pointed+today`, 2.943:1), so it also proves the server runs the whole
loop rather than a sample of it; a colour failing ten would be refused by a
validator that measured two.

**`no-misused-spread` fired on both `[...name]` sites and the disables are a
decision, not a silencing:** the rule is right that a ZWJ sequence is several
code points and costs several against the cap. The spec names code points, so
that is the unit — an `Intl.Segmenter` count would be a different cap, and one
the composer would have to reproduce exactly for its pre-send refusal to agree
with this one.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first):
`test` over be-01 and domain rc 0 — be-01 **1550 pass / 0 fail across 126
files**, exactly the eight new cases over chunk 9's 1542 and no regression;
domain **506 / 0** across 42 files, unchanged. `lint` over be-01 and domain
rc 0. `be-01:typecheck` and `domain:typecheck` rc 0, run **one at a time**.
`format:check --all` rc 0. `apps/be-01/openapi.json` regenerated and
**byte-identical** (sha256 `55f6b6c5…`, chunk 8's) — new validation, no new
route and no changed body schema.

**Next chunk:** 4.6 — isolation over two seeded projects, the cross-project
`DELETE`, and route-family disjointness through a drizzle `logQuery` reach
assertion, with three negatives: the `project_id` predicate dropped from the
list query, a `work_item` read in the list handler, and a second one in the
**recolour** branch specifically. That closes section 4.

### 2026-09-05 — run 6, chunk 11: the create body is `markerId`

**The inherited CI red, fixed.** `e3a0ee37`. Not a slice — the debt chunk 7 took
on when the routes first shipped, diagnosed by run 5 and paid here.

`postApiProjectsByIdCalendar-markers: "id" is declared as both a path input and
a body input. One would overwrite the other, so neither is sent.`
`openapi-tools.ts` derives one MCP tool per operation from
`apps/be-01/openapi.json` and flattens path and body inputs into a single
argument object; `claim()` throws rather than ship a tool where one input
silently overwrites the other. `POST /api/projects/:id/calendar-markers` spends
`id` on the project, so 4.4's client-supplied marker id could not also be `id`.

**The fix is the body field, and the obvious alternative stays ruled out.**
Renaming the path parameter to `:projectId` cannot work — memoirist refuses two
different parameter names in the same path position, so it would mean renaming
`:id` across every `/api/projects/:id/...` route in be-01 (run 5 attempted it
against the real emitter, proved it impossible, reverted). `markerId` is what
the `PATCH` and `DELETE` paths already call this same value, so the create was
the only route that ever called it anything else.

**Wire only.** `NewCalendarMarker.id` and `CalendarMarker.id` are unchanged —
inside the service there is no project id to collide with — and the two names
meet in one mapping line in the `POST` handler, written as an explicit
destructure because a spread-then-override would carry `markerId` into the
service's object as an extra member.

**The refusal envelope moved with the field**, and that is a decision rather
than a sweep: `malformed`, `taken` and `not_found` now blame `markerId`. The
spec requires every row to answer with exactly the field its row gives, and
leaving `taken` at `id` would have answered a collision by naming a member no
marker request has — the path parameter is `markerId`, the body property is now
`markerId`, and `id` on this API means the project.

**A SECOND RED THE SAME CHANGE UNCOVERED, and it is the guard working.** With
`claim()` unblocked the four marker routes reach the tool list for the first
time and `mcp-01`'s count guard fired, **28 to 32**, with the README count
following. All four are admitted, `EXCLUDED_PATHS` stays at five, and the
reasoning is recorded beside the count: the `plan-commands` exclusion looks like
it should remove the three writes and does not, because **a marker is not a plan
edit at all** — the spec makes that structural, and no command in the batch
vocabulary creates, renames, recolours or deletes one, so excluding them would
leave no way to annotate a date through MCP. The list read is admitted for the
reason every read here is: a date is not a unique key, so an agent must list a
day's markers before it can name an id.

**NEGATIVES.** The rename's own proof is the before/after at the real head
rather than a mutation: `mcp-01` at `85191455` was **92 pass / 1 fail** on
exactly this error, and is **106 / 0** after. Two more watched against the
marker route file's 20 pass / 0 fail baseline, restored to 20 / 0 after each:

- **the mapping dropped** (`{ ...rest, id: markerId }` → `{ ...rest }`) gives
  **17 / 3** — the round trip, the tie-order case and `stores the exact id the
create carried`, which is every case whose client-supplied id has to reach
  storage, and nothing else. It is the negative that matters, because the seam
  is one line and a create that quietly minted its own id would answer `201`.
- **the envelope blaming `id` again** gives **18 / 2** — exactly the `taken` and
  `not_found` cases, which are exact-shape `toEqual`s and so are the only two
  that can see a field name change.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first;
`bun install --frozen-lockfile` first, the tree had no `node_modules`):
`test` over be-01 and domain rc 0 — be-01 **1550 pass / 0 fail across 126
files** and domain **506 / 0** across 42, both unchanged from chunk 10, which is
what a rename should do to a count. `mcp-01` **106 / 0**, rc 0. `lint` over
be-01, mcp-01 and domain rc 0 (`jsdoc/no-multi-asterisks` fired once on a
comment line beginning `*project*`; reworded, not disabled). `be-01:typecheck`,
`mcp-01:typecheck` and `domain:typecheck` rc 0, run **one at a time**.
`format:check --all` rc 0 after `format:write` reflowed the test file and the
spec's refusal table. `apps/be-01/openapi.json` regenerated — **+3/-3**, the
body property and nothing else.

**Next chunk:** 4.6 — isolation over two seeded projects, the cross-project
`DELETE`, and route-family disjointness through a drizzle `logQuery` reach
assertion, with three negatives: the `project_id` predicate dropped from the
list query, a `work_item` read in the list handler, and a second one in the
**recolour** branch specifically. That closes section 4.

## Implementation notes — chunk 19 (TASK-235 run 10, 2026-09-05)

**Slice 6.1 checked.** The dated axis cell takes a click and opens a composer
bound to that cell's own `data-axis-date`.

The composer's state is the **date**, not the offset, and that is the slice.
Every other piece of axis state carries `day.offset`, so a composer handed one
would have to convert — and on a plan starting Monday 2026-08-10 there are two
wrong conversions that both look plausible. Cell 9 is the one cell where all
three candidates differ: its date is `2026-08-19`, its workday is 7,
`addWorkdays(start, 9)` is `2026-08-21` and `addCalendarDays(start, 7)` is
`2026-08-17`. `addCalendarDays(start, day.offset)` is _also_ `2026-08-19`, which
is why neither watched fault is that one — it would pass with the fault in.

**TWO NEGATIVES WATCHED**, baseline 164 pass / 0 fail on
`gantt-panel.test.tsx`, restored to 164 / 0 after each:
`setComposerAt(addWorkdays(startDate, day.offset))` → **163 / 1**, this case
alone, `expected '2026-08-21' to be '2026-08-19'`;
`setComposerAt(addCalendarDays(startDate, day.workday))` → **163 / 1**, again
this case alone, `expected '2026-08-17' to be '2026-08-19'`.

The composer reports the day twice — the ISO string in `data-composer-date` and
the words from `shortIsoDate` in its text and its accessible name. Both are
asserted, because a test reading only the words asserts about the formatter as
much as about the day. The clock is pinned inside 2026 for the same reason
`shortIsoDate` drops a matching year: read against the real clock this case
starts failing on 1 January 2027 for a reason unconnected to the slice.

**THE FINDING: 6.1 could not ship alone.** `jsx-a11y/click-events-have-key-events`
and `jsx-a11y/no-static-element-interactions` both refuse a `<span>` that grew
an `onClick` and nothing else, so the first lint run was **rc 1 with two errors
on the axis cell**. The bounded answer is 6.4's control contract —
`role="button"`, `tabIndex={0}`, an Enter/Space `onKeyDown` with Space
`preventDefault`ed, `aria-haspopup="dialog"` on the dated branch and
`aria-disabled` on the undated one — shipped in this commit. **6.4 and 6.4a
stay unticked**: not one of 6.4's seven cases or 6.4a's exists, and
`aria-expanded` and the marker count in the accessible name are not implemented.
6.1 and 6.4's _implementation_ are not separable; only its tests are, and the
plan sequenced them as if they were.

**A SECOND FINDING, on the gate rather than the code:** `fe-01:lint` was
**`Killed`** on the first attempt — the OOM chunk 7 met on typecheck reaches
eslint too, on a box with 904 MB free of 15.6 GB. `NODE_OPTIONS=--max-old-space-size=3072`
and running it alone gives rc 0. Also: the runner's path argument is relative to
the **project** directory, so `apps/fe-01/src/...` matches nothing and exits 1
with `No test files found` — `src/components/wbs/gantt-panel.test.tsx` is the
form that works, and it is a substring filter either way (chunk 17).

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`, `rm -rf dist` first):
full `fe-01:test` rc 0 — **2213 pass / 0 fail across 86 files**, the a11y
attributes added to every axis cell breaking nothing; `fe-01:lint` rc 0 (one
pre-existing `react-hooks/exhaustive-deps` warning at `wbs-table.tsx`, not this
diff); `fe-01:typecheck` rc 0. be-01 and domain not run: nothing outside
`apps/fe-01` changed.

## Implementation notes — chunk 20 (TASK-235 run 10, 2026-09-05)

**Slice 6.2 checked.** Test-only — the click handler already declined to touch
`openDay`, so this chunk is the assertion that says so.

The tooltip is asserted **twice**, before the click as well as after. Without
the first assertion the case is green against an implementation whose hover
never opened at all, which is the same green a click that dismissed it would
produce — the slice's own warning, and the reason its negative is watched on the
_second_ assertion specifically.

**NEGATIVE WATCHED**, baseline 165 pass / 0 fail on `gantt-panel.test.tsx`,
restored to 165 / 0 after: `setOpenDay(null)` inserted ahead of the handler's
`setComposerAt` → **164 / 1**, this case alone, failing the second tooltip
assertion with `Unable to find an accessible element with the role "tooltip"`
while 6.1's case and every other axis case stayed green.

## Implementation notes — chunk 21 (TASK-235 run 11, 2026-09-05)

**Slice 8.0 checked.** `axisOffsetOf(axis, date)` is the lookup, `todayOffset`
is now its first caller and nothing else, and the two docstrings were split
along the seam: what is true of _any_ date on the axis moved up, what is true of
_today_ — Dany's three null readings, and the weekend that is not one of them —
stayed down. One lookup rather than two that can disagree is the point, and a
`todayOffset` that still ran its own `find` would have been exactly the second
scale this function exists instead of, one level lower.

**The negative needed a hand-made axis, and the round-4 review was right about
why.** On every axis `calendarAxis` builds, a cell's stored `offset`, its array
index and `calendarDaysBetween(axis[0].date, date)` are the same number, so the
arithmetic spelling is invisible to all 165 existing cases. The fixture here is
three cells — `2026-08-10`, `2026-08-11`, `2026-08-12` carrying offsets 0, 7 and
9 — where looking the third up must give **9** and not its index 2 and not its
calendar distance 2. Both cells are asserted, not just the last, so returning
the final offset in the array does not pass either.

**NEGATIVE WATCHED**, baseline 165 → 167 pass / 0 fail on
`gantt-panel.test.tsx`, restored to 167 / 0 after: the body replaced by
`calendarDaysBetween(axis[0].date, date)` → **163 / 4**, `expected 2 to be 9` on
the lookup case exactly as predicted.

**A FINDING ABOUT THE MUTANT, worth carrying into 8.1.** The other three
failures were not predicted and they change what the negative proves. The
arithmetic spelling also broke `answers null for a date the axis does not hold`
(`expected 3 to be null`) and _two_ existing today cases — `draws no marker when
today is before the plan begins` and `draws no marker when today is past the
last day drawn`, both `expected SVGElement{…} to be null`. So the today marker's
**out-of-range** arms already caught this class of fault; what nothing in the
suite could see before this slice is a **wrong offset for a date the axis does
hold**, which is precisely the drift 8.1's chip placement depends on. The
round-4 claim that the mutant "passes" is true of in-range dates and only those
— the part that matters, and the part 8.0's own case now owns.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`,
`NODE_OPTIONS=--max-old-space-size=3072`): full `fe-01:test` rc 0 — **2216 pass
/ 0 fail across 86 files**, exactly the two new cases over chunk 20's 2214;
`fe-01:lint` rc 0 (one pre-existing `react-hooks/exhaustive-deps` warning at
`wbs-table.tsx:4628`, not this diff); `fe-01:typecheck` rc 0. be-01 and domain
not run: nothing outside `apps/fe-01` changed.

## Implementation notes — chunk 22 (TASK-235 run 11, 2026-09-05)

**Slice 7.1 checked.** `workdayAxis` and the `AxisDay` type are exported, and
the assertion calls the builder directly: eight cells, every `date` null, and
the offsets `0..7` asserted alongside so "no date" cannot be passing by way of
an empty or broken axis.

**NEGATIVE WATCHED**, baseline 168 pass / 0 fail on `gantt-panel.test.tsx`,
restored after: `date: null` replaced by `date: addWorkdays('2026-01-01',
workday)` inside `workdayAxis` → **164 / 4**, this case among them on
`expected false to be true`.

**THE OTHER THREE FAILURES ARE THE FINDING, and they narrow the slice's claim.**
The mutant also broke three existing cases — `the axis is a calendar > prints
the workday offsets and no weekend at all without a start date`, `the calendar
axis agrees with the columns > prints workday offsets, and no dates at all, on a
plan with no start date`, and `the axis says its date… > says the workday alone
when the plan is not on a calendar`. So the field is **not** currently
unguarded, and the slice's justification is not "nothing else sees it". It is
narrower and still sound: all three are _renders of an undated plan_, so they
go with the undated render path, and the future change this slice names — every
project given a start date — deletes the branch that makes them reachable while
leaving `workdayAxis` in the tree with a synthesised date and section 7's
refusals silently unreachable. The direct call survives that; a render does not.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`): full `fe-01:test` rc 0 —
**2217 pass / 0 fail across 86 files**, exactly the one new case over chunk 21's
2216; `fe-01:typecheck` rc 0; `prettier --check .` rc 0.

**`fe-01:lint` COULD NOT BE RUN WHOLE — `Killed`, twice, and it is the box
rather than the diff.** h2puni had 2.3 GB available of 15.6 GB (13.3 used, 10.1
of it `shared`), and `NODE_OPTIONS=--max-old-space-size=3072` does not reach the
linter because the target shells out to `bunx eslint`, not to node. Scoped
instead: `bunx eslint apps/fe-01/src/components/wbs/gantt-panel.tsx
apps/fe-01/src/components/wbs/gantt-panel.test.tsx` **rc 0**, which is the whole
of this chunk's diff, and chunk 21's full-project run on the same two files was
rc 0 forty minutes earlier. CI runs the whole project regardless, and that is
the run that gates the merge.

## Implementation notes — chunk 23 (TASK-235 run 12, 2026-09-05)

**Slice 8.1 checked, and it is the slice that gives `GanttChart` its markers.**
`CalendarMarkerView` (`id`, `date`, `name`, nullable `color`) is the shape
be-01's list route answers with, minus the two columns no mark reads;
`GanttProps.markers` is optional at the panel boundary and required inside the
chart, the bargain `dayPx` already makes, defaulting to a module-level
`NO_MARKERS` rather than to a `= []` that would rebuild every chip on every
unrelated render. `markerFill(marker)` resolves `color ?? automaticColor(id)` in
one place because two marks draw one marker — the chip here and 8.2's rule down
the body — and a second spelling is a chart that can disagree with itself about
what colour one marker is.

**The chips are a layer over the cells, not children of them, and that is what
makes the slice falsifiable at all.** A chip rendered inside its own axis cell
stands at the right x by construction and the fault this slice exists to catch
could never happen; placed by `axisOffsetOf` it can be placed by the wrong
number, which is the point. The layer spends `CHART_PAD_PX` once so each chip's
own `left` is the plain calendar x a test can read — `left` on an absolutely
positioned child is measured from the containing block's _padding_ edge, so the
band's own `paddingLeft` does not move it. The band's `sticky` is that
containing block; a `relative` beside it would be two `position` declarations on
one element and which of them won would be a question about stylesheet order.
The layer is `pointer-events-none`: the cell underneath carries 6.1's click and
6.2's hover, and a chip lying across it would eat both on exactly the days that
have something to say. What a chip does when it is pointed at is 8.4's, and 8.4
will need that line revisited rather than kept.

**THREE NEGATIVES WATCHED**, baseline 168 → 171 pass / 0 fail on
`gantt-panel.test.tsx`, restored to 171 / 0 after each:

- the placement taken from the cell's **workday** instead of `axisOffsetOf` —
  `axis.find((day) => day.date === marker.date)?.workday ?? null` → **170 / 1**,
  the placement case alone, `expected '7' to be '9'`. The fixture is 6.1's cell
  9: on a plan starting Monday `2026-08-10`, `2026-08-19` is offset **9** and
  workday **7**, so a workday-placed chip is right in week one and two days
  early here — the drift `gantt-calendar-axis` exists to end.
- the label ink hard-coded to `#ffffff` → **169 / 2**, `expected 'rgb(255, 255,
255)' to be 'rgb(0, 0, 0)'`. **Two and not one**, which is the better result:
  the automatic-colour case asserts the ink on its own resolved fill too, so
  both call sites of the chooser are guarded rather than only the one the slice
  named.
- `?? automaticColor(marker.id)` replaced by a fixed `PALETTE[0].fill` →
  **170 / 1**, the automatic case alone, `expected 'rgb(247, 1, 0)' to be
'rgb(3, 134, 165)'` — crimson where teal was owed.

**THE FINDING, and it is about 3.2a rather than about this slice.** `labelInk`
has exactly **one reachable branch in production**, and the third negative is
what showed it: swapping teal for crimson moved the fill and left the ink
assertion green. The reason is arithmetic on the bars 3.2 already set. A chip
fill has to clear **3:1** against the base backdrop in _both_ themes, so against
a white base `1.05 / (L + 0.05) >= 3` gives `L <= 0.30`, and against a
near-black base `(L + 0.05) / 0.10 >= 3` gives `L >= 0.25`. Every admissible
fill therefore has `L` in `[0.25, 0.30]`, while the chooser's own crossover is
at `sqrt(0.0525) - 0.05 ≈ 0.179` — below that whole window. **No colour this API
can accept will ever be given white ink.** So the assertion here catches a
hard-coded _white_, which is what the slice asked for, and cannot catch a
hard-coded _black_; the `#ffffff` arm is unreachable from any real marker and is
defended only by 3.2a's own table over synthetic fills. That is not a defect — a
total function with an unreachable arm is cheaper than a partial one with a
refusal — but a later slice must not claim the component proves the chooser
whole, because it proves half of it.

**A PLUMBING NOTE FOR THE NEXT CHUNK THAT REACHES INTO `libs/domain`.**
`@wbs/domain/marker-color` had no path mapping, and fe-01 needs one in **seven**
places: `tsconfig.base.json`, `apps/fe-01/tsconfig{,.app,.spec,.e2e}.json`,
`vite.config.ts` and the suite config beside it. The first gate run missed the
last one and died at collect with
`Failed to resolve import "@wbs/domain/marker-color"` — which is the slip
`vite-config.test.ts` was written for after it happened three times in August,
and that guard passed on the fixed tree. No nx `inputs` declaration is owed
here: this is an import, so the project graph carries it, unlike chunk 18's
runtime `fs` read of a domain source.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`,
`NODE_OPTIONS=--max-old-space-size=3072`): full `fe-01:test` rc 0 — **2220 pass
/ 0 fail across 86 files**, exactly the three new cases over chunk 22's 2217;
`fe-01:typecheck` rc 0; `fe-01:lint` **rc 0 over the whole project**, with the
one pre-existing `react-hooks/exhaustive-deps` warning at `wbs-table.tsx:4628`;
`prettier --check .` rc 0 first time. **The full lint ran here with 11 GB
free**, which confirms chunk 22's reading that the `Killed` was h2puni's memory
pressure and not the diff. be-01 and domain not run: the only file changed
outside `apps/fe-01` is `tsconfig.base.json`, and a path mapping added beside
ten others changes nothing either of them compiles.

## Implementation notes — chunk 24 (TASK-235 run 12, 2026-09-05)

**Slice 8.5's panel half, and 8.5 stays unticked.** The return trip is asserted
— one marker on `2026-08-19`, drawn twice: against a three-workday plan whose
axis stops at `2026-08-12` it draws nothing, and against the ten-workday plan it
is back at offset 9. Two horizons, one untouched fixture. The other half of the
slice, that the marker is **still stored and still answered by the list route**,
is not observable on the panel at any horizon; it is the be-01 controller case
from 4.1 and it is what 8.5 is still owed.

**"Draws nothing" needed the second render to mean anything**, which is the part
of the slice's own text worth keeping: a component that had simply stopped
drawing chips satisfies the shortened case exactly as well as one that placed
this marker correctly and found no cell for it. The absent case also asserts
`[data-gantt-marker-band]` is still in the tree, so what is missing is one
marker rather than the whole layer.

**NEGATIVE WATCHED**, baseline 171 → 173 pass / 0 fail on `gantt-panel.test.tsx`,
restored to 173 / 0 after: the chip's own `if (offset === null) return null`
weakened to `offset === undefined`, which `axisOffsetOf` never returns → **172 /
1**, the shortened case alone, `expected <span …(3)></span> to be null`. The
slice proposed throwing from `axisOffsetOf`'s absent-date branch instead; that
mutant is 8.0's — it would fail 8.0's own null case first and would say nothing
about whether the chip layer honours the answer. The guard this chunk's code
actually owns is the one watched.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`,
`NODE_OPTIONS=--max-old-space-size=3072`): full `fe-01:test` rc 0 — **2222 pass
/ 0 fail across 86 files**, exactly the two new cases over chunk 23's 2220;
`fe-01:lint` rc 0 whole; `fe-01:typecheck` rc 0; `prettier --check .` rc 0.
Test-only outside this record: no source file changed.

## Chunk 25 — slice 6.4 (TASK-235 run 13, 2026-09-05)

**Slice 6.4 checked: the dated axis cell is a control a keyboard can operate,
and it says what day it is and what is already on it.** Chunk 19 shipped half of
this implementation because eslint would not let 6.1 land without it; what was
missing was `aria-expanded`, the marker count in the accessible name, and all
seven cases. All three are here.

**`aria-expanded` is `composerAt === day.date` — the transition, and per cell.**
Two wrong implementations pass a weaker test: a value hard-coded to either
constant satisfies a single-state assertion, and one derived from
`composerAt !== null` announces **every** dated cell on the axis as open at
once. So the case reads both states on one cell and reads a second cell beside
it at each state.

**THE CLOSE PATH WAS OWED BY NOBODY AND IS OWED BY THIS SLICE.** 6.4 requires
`aria-expanded` to be `false` again after the sheet closes, and until this chunk
the composer had **no way to close at all** — no dismiss control, no Escape, and
nothing in section 6 or 8 claims one. Escape on `document` is the answer, bound
only while the composer is open. On `document` rather than on the dialog because
nothing focuses the dialog yet: 6.3 is the slice that moves focus into the name
field, and a listener on the dialog's own subtree would never receive the key
until it lands. A `role="dialog"` reachable by keyboard — Enter on an axis cell,
as of this slice — and dismissible only by mouse is a trap.

**THE FINDING, and it is about `marksOverLight` rather than about a11y: an
accessible name is a `shortIsoDate` caller, and `shortIsoDate` is the oracle two
existing render-silence tests count.** The first version built each cell's name
inline in the `axis.map`, and the gate came back **2 failed / 178 passed** — not
on anything in this slice, but on `pointing a row re-renders no Gantt mark`
(`expected 5 to be +0`) and `opening a bar's facts re-renders no Gantt mark`
(`expected 14 to be 4`). A light moving re-renders the axis band, the band had
never called `shortIsoDate` before, and it now called it once per day of the
horizon. The names are memoised on `[axis, markers, today]` and the counts are
folded into that same pass; both cases went back to green. **The tests were
right and the code was wrong** — nothing in a cell's name depends on a gesture,
so nothing in it should be recomputed by one. The `marksOverLight` discipline
this file already documents now has a second mark under it.

**6.4a STAYS UNTICKED.** Its five cases do not exist, and the undated branch has
no `aria-label` at all — its accessible name is still the bare axis number,
which is precisely the generic name round-8's Sol review called the failure mode
the contract exists to prevent. The count is spoken as `no calendar markers`
rather than omitted on an empty day, so silence on a cell means the name failed
to build rather than that the day is empty.

**TWO NEGATIVES WATCHED**, baseline 173 → 180 pass / 0 fail on
`gantt-panel.test.tsx` (exactly the seven new cases), restored to 180 / 0 after
each:

- the axis cell's `key.key !== 'Enter' && key.key !== ' '` narrowed to
  `key.key !== 'Enter'` → **179 / 1**, the Space case alone, `Unable to find an
accessible element with the role "dialog"`. Enter's own case stayed green,
  which is the point: an Enter-only test passes a handler that forwards every
  key **and** one that handles Enter alone, and only a second key tells them
  apart.
- `role="button"` made conditional so only the **undated** branch keeps it →
  **179 / 1**, the role-and-name case alone, `Unable to find an accessible
element with the role "button" and name "19 Aug, 1 calendar marker"`, while
  the six cases that locate the cell by `data-axis-day` stayed green. That is
  the case's whole reason to exist: a focusable generic `<span>` carrying every
  handler and every ARIA attribute passes the other six while never being
  announced as a button.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`,
`NODE_OPTIONS=--max-old-space-size=3072`, `rm -rf dist` first): full `fe-01:test`
rc 0 — **2229 pass / 0 fail across 86 files**, exactly the seven new cases over
chunk 24's 2222; `fe-01:typecheck` rc 0; `fe-01:lint` rc 0 whole (the one
pre-existing `react-hooks/exhaustive-deps` warning at `wbs-table.tsx:4628`, not
this diff); `prettier --check .` rc 0. Nothing outside `apps/fe-01` changed.

## Chunk 26 — three of slice 6.4a's five cases (TASK-235 run 13, 2026-09-05)

**6.4a STAYS UNTICKED, and this is the part of it that does not need slice
7.2.** The undated cell now has an accessible name — `Workday 3, no project
start date` — and three of the five cases stand: it is focusable and carries
`role="button"` and `aria-disabled="true"`; it carries neither `aria-haspopup`
nor `aria-expanded`; and it is located **by role and name**. The two missing
cases are Enter and Space putting the refusal in the live region, and they are
not writable: **there is no refusal and no live region in the panel at all.**
Both are 7.2's, so 7.2 is now a prerequisite of 6.4a rather than a successor —
the plan sequenced them the other way.

**The name is the half two Sol rounds found unasserted** (rounds 8 and 9,
Important, on this slice and on 6.4). An implementation with the tab stop, both
handlers and every ARIA attribute passes the other two cases while announcing
nothing but "button", and §6's own argument for giving these cells a tab stop is
that a row of stops announced that way is worse than no stop. So the name is
what makes the tab stop worth having, and until this chunk the undated cell's
accessible name was its bare axis number.

**NEGATIVE WATCHED**, baseline 180 → 183 pass / 0 fail on `gantt-panel.test.tsx`
(exactly the three new cases), restored to 183 / 0 after: the undated branch's
`aria-label` replaced by the bare generic string `Day` → **182 / 1**, the
role-and-name case alone, `Unable to find an accessible element with the role
"button" and name "Workday 3, no project start date"`, while the focusability,
`aria-disabled` and both ARIA-absence assertions stayed green. A removal and a
generic label are different defects and the slice already names the generic one
as the likelier.

**The `aria-label`'s `workday === null` arm is the shared type's, not this
axis's.** An undated cell is drawn only by `workdayAxis`, which sets `workday`
on every cell it makes; it is `calendarAxis` that has workdayless cells, and
those are weekends, which always carry a date and so never reach this branch.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`,
`NODE_OPTIONS=--max-old-space-size=3072`): full `fe-01:test` rc 0 — **2232 pass
/ 0 fail across 86 files**, exactly the three new cases over chunk 25's 2229;
`fe-01:typecheck` rc 0; `fe-01:lint` rc 0 whole (the same pre-existing
`react-hooks/exhaustive-deps` warning at `wbs-table.tsx:4628`); `prettier
--check .` rc 0. Nothing outside `apps/fe-01` changed.

## Chunk 27 — slice 7.2's two writable assertions (TASK-235 run 14, 2026-09-05)

**Landed.** The undated axis cell now answers when it is operated, instead of
returning in silence. **7.2 stays unticked** on its third assertion, and the
reason is a missing seam rather than missing work — see 7.2a, filed above.

**The refusal is state, not a derivation.** `startDate === null` is true for
every cell on an undated axis, so a message rendered from it would be a
standing complaint on a chart nobody has asked anything of. `refusal` is set by
the two handlers that were already refusing — the click and the Enter/Space
keydown — and cleared on the dated branch, so a refusal cannot outlive the plan
gaining a start date.

**It names the missing thing.** "This day cannot carry a calendar marker" is a
dead control with a caption; the sentence has to say _project start date_
because that is the only thing the reader can go and do. The test matches on
`/project start date/` rather than the whole sentence, so the wording stays
editable and the contract does not.

**Drawn, not announced.** The message carries `data-marker-refusal` and no
live-region role: 6.5 is the slice that puts it where a screen reader reaches
it, and writing the role here would tick 6.5's box with nothing having proved
it.

**THREE NEGATIVES WATCHED**, baseline 183 → 185 pass / 0 fail on
`gantt-panel.test.tsx`, restored after each:

1. `setRefusal(UNDATED_REFUSAL)` neutered in **both** handlers → **183 / 2**,
   the two new cases alone, `.toMatch() expects to receive a string, but got
undefined`.
2. The message replaced by the generic `This day cannot carry a calendar
marker.` → **183 / 2**, the same two cases, `expected 'This day cannot carry
a calendar mark…' to match /project start date/`. This is the one that makes
   _naming_ the date load-bearing; negative 1 passes against any message at all.
3. Not injectible, and recorded as such: 7.2's own second negative — the
   refusal path also issuing a create — has no method to issue one.

**The plan's predicted matrix for negative 1 was half wrong**, and the
correction is in 7.2 above: "a composer opened" cannot fail, because
`setComposerAt` is only reached on the dated branch and `composerAt === null`
renders nothing regardless of what the refusal branch does.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`): full `fe-01:test` rc 0 —
**2234 pass / 0 fail across 86 files**, exactly +2 over chunk 26's 2232;
`fe-01:typecheck` rc 0; scoped `bunx eslint` over both changed files rc 0 (the
full-project target is the OOM-blocked one chunk 22 measured, and CI runs it);
`prettier --write` over both files reported **unchanged**.

## Chunk 28 — 6.4a's Space case (TASK-235 run 14, 2026-09-05)

**Landed.** Test-only. 6.4a's fourth of five cases: Space on the **undated**
axis cell reaches the same refusal Enter does.

**6.4a still stays unticked** — its fifth case is the refusal reaching a live
region, which is 6.5's slice and does not exist.

**The plan's named negative for this case is the wrong one, and measuring it is
what shows why.** 6.4a says "Space removed from the undated branch only,
watched failing the Space case while Enter, the ARIA cases and all of 6.4 stay
green". There is one shared key guard for both branches
(`gantt-panel.tsx:4201`), so narrowing it to Enter is not a
"from the undated branch only" mutation at all: measured, it fails **two**
cases, 184 / 2 — this one and 6.4's own dated `opens the composer on Space`.
Mutating the guard by text rather than by line is worse still: the identical
guard on the bar handler (`:3606`) matches too, and the sed took both for
183 / 3, adding an unrelated bar case.

**The negative that IS isolated** is a branch-specific one: `return` on Space
inside the undated arm of the handler, after the shared guard has admitted it.
Watched at a 186 / 0 baseline → **185 / 1**, this case alone, on a `toMatch`
handed `undefined`, while Enter, both ARIA cases, the name case and every one
of 6.4's dated cases stayed green. That is the isolation 6.4a asked for; the
guard mutation cannot deliver it because the two branches share the guard.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`): full `fe-01:test` rc 0 —
**2235 pass / 0 fail across 86 files**, exactly +1 over chunk 27's 2234;
`fe-01:typecheck` rc 0; scoped `bunx eslint` rc 0; `prettier --check` rc 0.

## Chunk 29 — slice 7.3 (TASK-235 run 14, 2026-09-05)

**Landed.** Test-only. **7.3 checked** — the same cell that was refused goes
live once the plan has a start date, which is what makes 7.2 a refusal rather
than an inert cell. "No composer appeared" is equally true of a click handler
that was never wired, so 7.2's own cases cannot tell the two apart; this one
gives the same panel a start date and shows the same click doing the thing it
was refused.

A `rerender` and not a fresh render, because a fresh one re-proves 6.1 and this
slice is about the transition: the plan gained a calendar, so its axis did too.

**Negative watched**, baseline 187 pass / 0 fail on `gantt-panel.test.tsx`,
restored after: the click handler's dated branch neutered
(`setComposerAt(day.date)` → `void day.date` at `gantt-panel.tsx:4148`) →
**181 / 6**. The plan's prediction — this case failing "while 7.2's refusal case
stays green" — **holds**: both refusal cases and the Space case stayed green.
The other five failures are the click-to-open path's own (`6.1`'s two and three
of `6.4`'s), which is the expected blast radius of removing it and not a
surprise: they assert the same branch through a different door.

**GATES on h2puni** (`~/t235-gate`, `NX_DAEMON=false`): full `fe-01:test` rc 0 —
**2236 pass / 0 fail across 86 files**, exactly +1 over chunk 28's 2235;
`fe-01:typecheck` rc 0; scoped `bunx eslint` rc 0; `prettier --check` rc 0.
