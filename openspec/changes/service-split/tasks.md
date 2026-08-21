## 1. The tables, and the migration that adds them

- [x] 1.1 `service` and `teamService` in `schema.ts`. `service` global — **no
      project column**, mirroring `service_team` and `tag`, with `name`
      `NOT NULL` and a unique index so a rename can answer `taken`.
      `team_service` keyed on `(team_id, service_id)`, **both sides cascading**,
      indexed by `service_id` for the "what would removing this touch" read.
      JSDoc says what each table is **not**: not a pool, not a size, not
      anything a date reads — and names R2-6 as where `service_team` becomes
      `team`, because for one release the two names read backwards (design D9).
- [x] 1.2 `work_item.service_id TEXT REFERENCES service(id) ON DELETE SET NULL`
      — a column, not a join table, because one service per item is the
      cardinality (design D2). `SET NULL` not `CASCADE`: deleting a service must
      not delete work items. **Watched red** — make it `CASCADE` and the
      "removing a service keeps the rows" test must fail.
      **Superseded by 10.1** (scope change, 2026-08-21): the cardinality is now
      a set. The column stays where it is, unread, until a later migration drops
      it — see D2's blue/green rule. Left `[x]` because it shipped and the
      column is still in the schema.
- [x] 1.3 `drizzle/20260821000000_add_service/{migration,down}.sql`. **Check the
      stamp against every existing directory before writing it** — #60 and #61
      both stamped `20260814100000`, `migrationsToRollback` filters on a strict
      `created_at >`, and `rollbackTo` therefore reversed nothing, silently,
      with both tables still present. Newest existing is
      `20260819120000_add_tag`.
- [x] 1.4 The rollback test: down, then up, then a row survives the round trip.
      **Watched red** — revert a `DROP` in `down.sql` and it must fail.
- [x] 1.5 **No seed, asserted.** `service` and `team_service` are empty after
      the migration and every `work_item.service_id` is null. One test, three
      one-line assertions, and it is the cheapest proof that the no-backfill
      decision was implemented rather than intended.

## 2. The read path and the effective reading

- [x] 2.1 `repository/work-item.ts`: `serviceId` per row beside `teamIds` and
      `tagIds`. It is a column on the row being selected already — no join, no
      N+1, and if this needs a second query the column went in the wrong place.
- [x] 2.2 `effectiveServicesOf` in `libs/domain/src/effective-service.ts`, over
      the shared `effectiveLabelsOf` walk, with its own row shape, result shape
      and cycle error. **The domain reading is set-shaped over a single-valued
      column** (design D2) — `serviceId` in, singleton set through the walk,
      `serviceId` out. Exported from the package index; `effective-label.ts`
      stays unexported.
      **Widened in chunk 12** (2026-08-21): `serviceIds` in and out, both
      conversions deleted, so this is now `effectiveTagsOf` with different
      names. Four cases added, including the two-against-two override.
- [x] 2.3 **Watched red** — make the walk union instead of override for this
      dimension and the inheritance case must fail.
- [x] 2.4 Per dimension, independently: a row with a service and no teams
      inherits the ancestor's teams and overrides the ancestor's service, and
      the mirror case with tags. Both asserted — three dimensions now, and the
      independence is the property that has to survive the third.

## 3. The write path, and the undo journal

- [x] 3.1 `controller/work-item.controller.ts`: `serviceId?: string | null` on
      the patch payload. Unknown id → `unknown_service`, the refusal shape the
      team and tag writes already make.
- [x] 3.2 `service/work-item.service.ts`: the journalled before-value is the
      **prior scalar**, because the field is a column (design D6 — the inverse
      of the tags rule, stated so nobody "fixes" it into an array). **Watched
      red** — journal it as an array and the undo must fail.
- [x] 3.3 Undo and redo of a service change over **real SQLite**, not the
      in-memory store — the store cannot model a cascade, which is how a restore
      case passed under the very fault it was written for in #79.

## 4. The directory: services, and the ownership map

- [x] 4.1 `GET/POST /api/services`, `PATCH /api/services/:id` (rename, 409
      `taken` carrying the surviving name), `DELETE /api/services/:id`, confirmed
      with `?cascade=true`. Global — no project in the path or the query. The
      brief wrote the flag as `?cascade=1`; D7 says "`removeTeam`'s two-step
      verbatim", and `isCascade` in `directory.controller.ts` reads `true`, so
      verbatim won — a second spelling would be a second flag.
- [x] 4.2 `directoryUsageOfService`: `label_nulled` per item, **no
      `capacity_released` arm and no date effect**. Same 409-then-`?cascade=1`
      shape as `removeTeam`. The `team_service` rows the cascade takes are
      **not** in the usage report (design D7).
- [x] 4.3 The ownership map write: services on the team row — an optional
      `serviceIds` array on the team patch, whole-set semantics, absent leaves
      it alone and empty clears it, exactly `PersonPatch.teamIds`' rule
      (`wbs-api.ts:528`). Unknown service id → `unknown_service`.
- [x] 4.4 `TeamView` carries `serviceIds` (design D4 — the map ships whole; the
      client needs the rule anyway to filter, and a derived flag on the wire
      would be a second copy of it).
- [x] 4.5 **Watched red on the empty diff:** deleting a service, and editing the
      ownership map, each move no date in the plan.
- [x] 4.6 **Owed from section 3:** `unknown_service` is **404**, asserted over
      the route. Section 3 proved the refusal over real SQLite (`undo.test.ts`,
      `refuses a service the directory no longer holds, and writes nothing`) but
      could not assert its **status**: `work-item.controller.test.ts` runs on
      the in-memory work item fixture, which answers `unknown_team` only because
      it is handed a team list, and there were no services to hand it. Once 4.1
      gives the directory services, hand them to `inMemoryWorkItems` the same
      way and assert the 404 — `statusFor`'s arm for it is untested code until
      then.

## 5. The two signals

- [x] 5.1 `libs/domain/src/label-mismatch.ts`: `builtByNonOwner` and
      `assignedOutsideTeam`, one module, one vocabulary (design D5). Both take
      the **effective** team set.
- [x] 5.2 **Watched red** — point either at the row's own stored teams instead
      of the effective reading and the inherited-team case must fail. This is
      the class of bug this repo has shipped twice, and here it would hide the
      marker exactly where inheritance is doing the work.
- [x] 5.3 **Absence flags nothing**, asserted per half: no service → no
      non-owner flag; no team → neither flag; no assignee → no
      assigned-outside flag. Three tests, and they are what stops the marker
      covering most of a young plan.
- [x] 5.4 The signals never block a write: patching a row into a mismatch
      returns 200 and the row reads back mismatched. Asserted, because "we
      decided not to validate" is invisible in a diff.

## 6. The filter

- [x] 6.1 `tree-search.ts`: `serviceIds`, `builtByNonOwner`, `assignedOutsideTeam`
      on `FilterCriteria` and `NO_FACETS`; `RowFacets` gains the **effective**
      service and the two booleans; three predicates in `narrowTree`;
      `filterWords` gains three labels.
- [x] 6.2 **Watched red** — point the service predicate at the row's own stored
      column instead of the effective reading and the inherited case must fail.
- [x] 6.3 The three facet controls beside the eight shipped. The two signal
      facets are **disabled with a stated reason** while no team owns any
      service (design's first risk) — an empty filter offered as if it worked is
      how a reader concludes the feature is broken.

## 7. The rest of fe-01

- [x] 7.1 The service cell in `wbs-table.tsx` — a single-select picker, blank =
      inherit. No inline create: the directory page is the surface, `tags` 6.1's
      non-goal for its reasons. **Split**: the quiet non-owner marker moved to
      7.2, which builds the other one. Two markers that must carry the same
      kind of hover sentence are one piece of work, and writing the first
      without the second is how they end up phrased differently.
- [x] 7.2 **Both** quiet markers: `builtByNonOwner` on the service cell (moved
      from 7.1) and `assignedOutsideTeam` on the assignee cell, each on the cell
      its signal is about. Both markers carry a hover sentence naming which
      team and which service or person — a marker that cannot say why is a
      mystery, not a signal. **Under the set** the service sentence names
      **every** offending service, not the first; the "which ones" predicate
      already exists in `label-mismatch.ts` and needs no third export. **Do 10.2
      first** — a marker built against a single-select cell is the third surface
      that would need redoing.
- [x] 7.3 `plan-cards.tsx`: the `↳` inherited chip for the service dimension,
      per dimension as the other two are. **Last of the three chips**, matching
      `wbs-table.tsx`'s own column order (`Service/team`, `Tags`, `Services`),
      and asserted — nothing else on a card asserts sibling order.
      **No mismatch marker on it**: this face renders neither signal today —
      `CardAssignee.outside` reaches no phone — and one half of a paired signal
      on a face silent about the other reads as an all-clear.
- [x] 7.4 `plan-export.ts`: a **`Services`** column — plural since the scope
      change — joined and RFC4180-quoted exactly the way `Teams` and `Tags` are,
      beside them. **After `Tags`**, which is `wbs-table.tsx`'s column order and
      `plan-cards.tsx`'s chip order, so no third face re-argues it. The three
      label cells now share **one** renderer (`labelCell`): a third copy of a
      body two copies already agreed on is a thing somebody has to keep true,
      and 7.2 had already written down that dimensions inheriting by one rule
      must read as though they do.
- [x] 7.5 `directory-page.tsx`: a **Services** card beside Teams and Tags — no
      capacity column, no membership chips — and a **services picker on the team
      row**, which is where the map is edited (Dany, 2026-08-20 23:18). The
      absence on the Services card is asserted the way the Tags card's is: its
      test reads for `member` and for a number box and finds neither.
      **Built in two chunks and both are in.** Chunk 20: the card, the write
      half of `DirectoryApi` it needs, and the confirmation's dimension — a
      service removal had been confirming with a sentence about tags. Chunk 21:
      the ownership map on the team row, where `renameTeam(id, name)` became
      `patchTeam(id, patch)` so that one route has one spelling and a rename
      leaves `serviceIds` alone.
- [x] 7.6 `lib/wbs-api.ts`: `serviceId` on the work-item wire type,
      `ServiceView`, `serviceIds` on `TeamView`.
      **Still singular on `WorkItemView`**, deliberately — the wire follows the
      store, and both widen together in 10.1/10.2. `TeamView.serviceIds` is the
      ownership map and was always a set.
- [x] 7.7 The table-width budget rule — **exempted, and the exemption names what
      it exempts**: `CONDITIONAL_COLUMNS` in `table-frame.ts` keeps `service`
      out of `FIXED_COLUMNS`, so `foldedTableMinWidth` answers exactly what it
      did before this change. Asserted, not assumed.

## 8. The empty diffs, asserted

- [x] 8.1 `service/schedule.ts` — empty diff, asserted in
      `service-empty-diff.test.ts` on a plan where a sized team really does
      decide dates. **Watched red:** wire the scheduler to read a service, every
      downstream date moves, revert. **Re-aimed in chunk 22:** the file labelled
      its rows with `serviceId` — a field that left `WorkItemPatch` at chunk 12 —
      so it wrote and read the dead `work_item.service_id` column and was vacuous
      for the dimension it names. Every case labels through `serviceIds` now,
      asserts the label came back on `listByProject`, and the red was re-watched
      against the set: **1 pass, 3 fail**, one of them `poolFor` throwing outright
      on a row carrying two services.
- [x] 8.2 `libs/domain` — **the scheduling surface** has an empty diff, not the
      whole library: `effective-service.ts` and `label-mismatch.ts` are added
      here and both apps read them, and what a service is not is anything below
      `slicesOf`. Asserted by 8.1's fault rather than by a second test —
      `tags` 7.2's correction, applied up front this time instead of mid-build.
- [x] 8.3 `project_team_capacity` — untouched, not generalised, not re-keyed
      (R2-5 §2). Row-for-row unchanged after the migration, one assertion.
- [x] 8.4 `person_team` — shape untouched. The assignee signal **reads** it and
      writes nothing to it.
- [x] 8.5 **Restated as the absence it is — chunk 23's decision, taken against
      the tree rather than against the original wording.** The original text
      ("the service reaches the hover text and nothing that computes a
      position") described a chart that does not carry a service. Verified at
      `6b7895b`: `GanttRow`, `GanttPlan` and `GanttBar` declare no service
      field, and this branch's whole diff over `gantt-geometry.ts` is **32
      added lines, all of them the `ServiceLabel` type and its doc comment —
      zero statements changed**, so `barColorOf` and every geometry function
      are byte-identical to `main`. The chart's hover was never built, in any
      chunk, and is not built here.
      **No test is added, and that is the point.** `layOutGantt` has no service
      input to vary, so the tags precedent (untagged-vs-tagged identical
      geometry, `gantt-geometry.test.ts:1315`) cannot be copied: a case feeding
      a service to a type that has no field for one does not compile, and a case
      that omits it cannot fail. That is chunk 7's 5.2 lesson — a guard mistaken
      for a proof — and this item refuses it. The type is the assertion; the
      spec's `A service SHALL NOT colour a bar` is satisfied by a `barColorOf`
      nothing touched. `ServiceLabel` lives in `gantt-geometry.ts` because that
      file is where this repo declares row labels (`ServiceTeamLabel`,
      `TagLabel` sit beside it); it is consumed by `wbs-table.tsx` and
      `plan-cards.tsx` and by nothing that computes an x, a width or a colour.
      **Owed, and named as owed rather than quietly dropped:** the service on
      the chart's bar hover. The hover this change _did_ ship is the table
      cell's — the title naming the ancestor a row inherits from, and the
      non-owner note — which is what the brief's "hover text" face is answered
      by. A service on the bar is its own change, against `GanttBar` and the
      hover component, and it is written down in `verify.md` under what this
      change deliberately did not build.

## 9. The gate and the record

- [x] 9.1 Full gate on h2puni, with the bun version beside every count: be-01,
      fe-01, gw-01, domain, lint + typecheck over every project,
      `format:check`, `openspec validate --strict`, secrets + doc-caps +
      migration-lint. Re-run at the head before the PR. **Never on h1claw.**
- [x] 9.2 `verify.md` with the R5 fault table — every watched red above, each
      sourced from the `Proof:` comment beside the line it guards, plus what
      this change deliberately did not build.
- [x] 9.3 The migration proved **applied**, not assumed — and proved against
      **dev's own data** rather than against dev itself. Dev serves `main`
      (LLM_README, "Dev serves `main`"), so there is no restart on this branch to
      check after, and pointing the dev container at an unreviewed prod-mode
      branch is not a worker's call. What is checkable now, and is the stronger
      half of the claim, is that the two migrations apply **to the real dev
      database**: `VACUUM INTO` a snapshot of `/home/puni1/wbs-dev/data/wbs.db`
      (a consistent copy over a live WAL, never a write to the file dev serves),
      then `runMigrations` from this branch against the copy. Printed on h2puni
      at `39f9671`:
      before `["service_team"]`, 342 work items, 57 projects → after
      `["service","service_team","team_service","work_item_service"]`, **342 work
      items and 57 projects unchanged**; `work_item.service_id` present;
      `service (id, name)`, `team_service (team_id, service_id)`,
      `work_item_service (work_item_id, service_id)`; indexes `service_name` and
      `team_service_by_service` both present, plus
      `work_item_service_by_service`. **0 services and 0 `work_item_service`
      rows** — decision 4's no-backfill, shown rather than asserted: no dev row
      carries a service, so the `INSERT … SELECT` seed correctly moves nothing.
      Owed once this merges: the same three objects read off dev's live database
      after it restarts on `main`.
- [x] 9.4 **PR #90**, opened at `501bec9` — 90 files, 9,397 insertions / 365
      deletions over 104 commits. CI green: **`gate` pass in 3m12s, `pixels` pass
      in 10m24s**, run 32484830946. **Prod mode: the worker does not merge**, and
      did not. Task set to `state: review`; the main session reviews the four
      watched paths (`drizzle/**`, `libs/domain/**`, `service/schedule.ts`, auth)
      and merges.
- [ ] 9.5 `LLM_README.md`'s wbs-mcp entry says **43 MCP tools**, and section 4's
      four service routes make it **47**. Corrected there when this lands, not
      before: the number describes what is on `main`.

## 10. The widening — a work item carries a set of services

Dany, 2026-08-21 07:46 Kyiv: _"can be several services."_ The domain and the
filter were widened in chunk 12; the store, the wire and the picker were not, and
the branch folds between them at two commented edges. This section closes that
gap. **Do it before 7.2, 7.3 and 7.4** — each of those is a new surface, and a
surface built on the singleton is a surface built twice.

- [x] 10.1 `work_item_service (work_item_id, service_id)` in `schema.ts` and a
      migration, keyed on the pair, both sides cascading, indexed by
      `service_id` — `work_item_tag` line for line. Seed it from the column:
      `INSERT … SELECT id, service_id FROM work_item WHERE service_id IS NOT NULL`.
      **Leave `work_item.service_id` in place and unread**: blue and green
      share one SQLite file and the outgoing release still selects it, so
      dropping it here breaks the release that is still running (design D2, and
      the same rule 1.1's `service_team` rename follows). Check the stamp against
      every existing directory before writing it — 1.3's `>`-filter bug is the
      reason this sentence is repeated. **Watched red:** revert a `DROP` in
      `down.sql` and the rollback round-trip test must fail.
- [x] 10.2 The wire and the write, both ends in one slice: `serviceIds` on the
      repository read (a grouped join, as `tagIds` is), an optional readonly
      `serviceIds` array on the patch payload replacing the set whole and
      deduplicating a repeat, `unknown_service` refusing the **whole** patch from
      inside the
      write's transaction, and `WorkItemView.serviceIds` on `lib/wbs-api.ts`.
      Deleting the two folds is how this task is finished: the
      `effectiveServicesOf` memo in `wbs-table.tsx` and be-01's 5.4 controller
      case each carry a comment naming the line that goes. **Watched red:**
      leave either fold in and the two-service row must fail to reach the table.
- [x] 10.3 The journal takes the **whole prior set**, not the prior scalar
      (design D6, amended). **Watched red:** journal one member and the undo case
      restoring two services must fail — the fault tags 6.3 already caught once
      on its own dimension. **The shape landed early, in 10.2, and the proof did
      not.** 10.2's type change left no compiling way to keep the scalar, so
      `revertTo` already reads `out.serviceIds = before.serviceIds`; every undo
      case over it states **one** service, and a one-member set restores
      identically through a whole-set journal and a first-member one. So this
      item is now exactly its watched red: the two-service undo case, plus the
      injection that proves it fails on a first-member journal. Ticking it off
      the existing green would be chunk 7's 5.2 lesson repeated — a guard
      mistaken for a proof. **Done in chunk 16, red first:**
      `puts a replaced service set back, whole` in `undo.test.ts` — two services on, replaced by
      a third, undo restores both and redo narrows it back — and with
      `before.serviceIds.slice(0, 1)` in `revertTo` it fails alone (76 pass, 1
      fail over that file) while the five one-service cases beside it stay
      green.
- [x] 10.4 7.1's cell becomes a multi-select, the tags cell's control: blank
      still means inherit, the ancestor still named in the title, and the
      column header becomes **Services**. `CONDITIONAL_COLUMNS` unchanged, so
      7.7's folded floor of 1067 must still be exactly what it was. **Watched
      red:** assert the floor first and the membership second — 7.7's first
      injection fired on the wrong assertion because they were the other way
      round. **Done in chunk 16:** a chip per stated service with its own ✕ and
      a picker that adds one, the tag cell's control; the header reads
      `Services` and the **column id stays `service`**, which is what
      `CONDITIONAL_COLUMNS`, `cellKey`, the grid's key routing and saved column
      orders are written against — so 7.7's floor case is untouched and still
      1067, floor-first. `ServiceLabel` widened to `names` and lost its
      `unresolved` arm (a chip falls back to the id, so an unnamed service is on
      screen rather than missing), and `setServiceOf(id, string | null)` became
      `setServicesOf(id, ids)`. **Red driven:** `own` restored to
      `serviceIds.slice(0, 1)` and the new two-service case fails alone — 1 fail
      / 1559 pass, on `Remove Ledger from 010` not being a label the table
      has — the second service is not on screen at all. **Found on the way:** the cell passes no `onClear`, because
      `CreatablePicker` draws its ✕ only while `value !== null` and this box's
      value is always null — the tag cell beside it carries that prop dead. The
      chip is the gesture, and the case asserts `[]` goes out through it.
- [x] 10.5 `directoryUsageOfService` reports `label_removed`, not
      `label_nulled`, once the store is a join table — a column is nulled, a set
      member is removed, and `directory-usage.ts:15-30` already distinguishes
      them. ~~**One commit with 10.1**~~ **One commit with 10.2**, and the
      correction is this task's own reason read properly: _while the column is
      still authoritative, `label_nulled` is the true sentence_, and 10.1 does
      not make the join table authoritative — 10.2 does. 10.1 creates and seeds
      it while every reader still goes through the column, so shipping
      `label_removed` there would describe a mechanism nothing uses yet. The
      watched red needs 10.2 too: **an item carrying two services loses only the
      removed one** cannot be driven while `directoryUsageOfService` reads a
      scalar `row.serviceId`, so the case would be a guard mistaken for a proof —
      chunk 7's 5.2 lesson. Never before 10.1 still holds.
