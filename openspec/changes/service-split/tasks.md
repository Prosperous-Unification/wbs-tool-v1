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

- [ ] 5.1 `libs/domain/src/label-mismatch.ts`: `builtByNonOwner` and
      `assignedOutsideTeam`, one module, one vocabulary (design D5). Both take
      the **effective** team set.
- [ ] 5.2 **Watched red** — point either at the row's own stored teams instead
      of the effective reading and the inherited-team case must fail. This is
      the class of bug this repo has shipped twice, and here it would hide the
      marker exactly where inheritance is doing the work.
- [ ] 5.3 **Absence flags nothing**, asserted per half: no service → no
      non-owner flag; no team → neither flag; no assignee → no
      assigned-outside flag. Three tests, and they are what stops the marker
      covering most of a young plan.
- [ ] 5.4 The signals never block a write: patching a row into a mismatch
      returns 200 and the row reads back mismatched. Asserted, because "we
      decided not to validate" is invisible in a diff.

## 6. The filter

- [ ] 6.1 `tree-search.ts`: `serviceIds`, `builtByNonOwner`, `assignedOutsideTeam`
      on `FilterCriteria` and `NO_FACETS`; `RowFacets` gains the **effective**
      service and the two booleans; three predicates in `narrowTree`;
      `filterWords` gains three labels.
- [ ] 6.2 **Watched red** — point the service predicate at the row's own stored
      column instead of the effective reading and the inherited case must fail.
- [ ] 6.3 The three facet controls beside the eight shipped. The two signal
      facets are **disabled with a stated reason** while no team owns any
      service (design's first risk) — an empty filter offered as if it worked is
      how a reader concludes the feature is broken.

## 7. The rest of fe-01

- [ ] 7.1 The service cell in `wbs-table.tsx` — a single-select picker, blank =
      inherit, with the quiet non-owner marker on the cell. No inline create:
      the directory page is the surface, `tags` 6.1's non-goal for its reasons.
- [ ] 7.2 The assignee cell's quiet marker for `assignedOutsideTeam`, on the
      cell the signal is about. Both markers carry a hover sentence naming which
      team and which service or person — a marker that cannot say why is a
      mystery, not a signal.
- [ ] 7.3 `plan-cards.tsx`: the `↳` inherited chip for the service dimension,
      per dimension as the other two are.
- [ ] 7.4 `plan-export.ts`: a `Service` column, RFC4180-quoted, beside `Teams`
      and `Tags`.
- [ ] 7.5 `directory-page.tsx`: a **Services** card beside Teams and Tags — no
      capacity column, no membership chips — and a **services picker on the team
      row**, which is where the map is edited (Dany, 2026-08-20 23:18). The
      absence on the Services card is asserted the way the Tags card's is: its
      test reads for `member` and for a number box and finds neither.
- [ ] 7.6 `lib/wbs-api.ts`: `serviceId` on the work-item wire type,
      `ServiceView`, `serviceIds` on `TeamView`.
- [ ] 7.7 The table-width budget rule — **exempted, and the exemption names what
      it exempts**: `CONDITIONAL_COLUMNS` in `table-frame.ts` keeps `service`
      out of `FIXED_COLUMNS`, so `foldedTableMinWidth` answers exactly what it
      did before this change. Asserted, not assumed.

## 8. The empty diffs, asserted

- [ ] 8.1 `service/schedule.ts` — empty diff, asserted in
      `service-empty-diff.test.ts` on a plan where a sized team really does
      decide dates. **Watched red:** wire the scheduler to read a service, every
      downstream date moves, revert.
- [ ] 8.2 `libs/domain` — **the scheduling surface** has an empty diff, not the
      whole library: `effective-service.ts` and `label-mismatch.ts` are added
      here and both apps read them, and what a service is not is anything below
      `slicesOf`. Asserted by 8.1's fault rather than by a second test —
      `tags` 7.2's correction, applied up front this time instead of mid-build.
- [ ] 8.3 `project_team_capacity` — untouched, not generalised, not re-keyed
      (R2-5 §2). Row-for-row unchanged after the migration, one assertion.
- [ ] 8.4 `person_team` — shape untouched. The assignee signal **reads** it and
      writes nothing to it.
- [ ] 8.5 `gantt-geometry.ts` — the service reaches the hover text and nothing
      that computes a position. `barColorOf` unchanged: a bar already carries a
      person as a colour and a priority as a cap, and a third meaning on one
      small rectangle stops it meaning anything.

## 9. The gate and the record

- [ ] 9.1 Full gate on h2puni, with the bun version beside every count: be-01,
      fe-01, gw-01, domain, lint + typecheck over every project,
      `format:check`, `openspec validate --strict`, secrets + doc-caps +
      migration-lint. Re-run at the head before the PR. **Never on h1claw.**
- [ ] 9.2 `verify.md` with the R5 fault table — every watched red above, each
      sourced from the `Proof:` comment beside the line it guards, plus what
      this change deliberately did not build.
- [ ] 9.3 The migration proved **applied**, not assumed: `service`,
      `team_service` and `work_item.service_id` present in the dev database
      after the restart, with `service_name` and `team_service_by_service`.
- [ ] 9.4 PR opened, CI green (`gate` and `pixels`). **Prod mode: the worker
      does not merge.** Task goes to `state: review`; the main session reviews
      the four watched paths and merges.
- [ ] 9.5 `LLM_README.md`'s wbs-mcp entry says **43 MCP tools**, and section 4's
      four service routes make it **47**. Corrected there when this lands, not
      before: the number describes what is on `main`.
