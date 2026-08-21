# verify — `service-split`

Branch `change/service-split`, cut from `main` @ `d4fe1d0` on 2026-08-21. Dany,
2026-08-20 23:07: _"I need to have service and team as separate entities."_ The
single directory entity was literally `serviceTeam` in the schema; this makes
service a dimension of its own beside team and tags, adds a many-to-many
team↔service **responsibility** map, and surfaces two mismatch signals off it.

Three tables (`service`, `team_service`, `work_item_service`), two migrations,
both apps, `libs/domain`, and a scope change landed mid-branch — Dany, 07:46:
_"can be several services"_ — which widened the item's dimension from a nullable
column to a set (section 10).

The claim under all of it is an **absence**: a service is a label the scheduler
never reads, so no date in any plan may move because of one. That claim is
asserted by faults with their own controls, not by a file list — section 8 in the
table below.

**Prod mode** (`notes/delivery-modes.md`): this adds `apps/be-01/drizzle/**`.
The PR ends at **review**, not merged. The four watched paths a reviewer owns
are named at the end of this file.

## The two migrations

`20260821000000_add_service` — `service (id, name)` with a unique `service_name`,
`team_service (team_id, service_id)` keyed on the pair with
`team_service_by_service`, and `work_item.service_id` as a nullable FK with
`ON DELETE SET NULL`.

`20260821080000_add_work_item_service` — the widening: `work_item_service
(work_item_id, service_id)` keyed on the pair, both sides cascading, indexed by
`service_id`, seeded from the column with
`INSERT … SELECT id, service_id FROM work_item WHERE service_id IS NOT NULL`.

**`work_item.service_id` is left standing and unread** (design D2). Blue and
green share one SQLite file and the outgoing release still selects it, so
dropping it here breaks the release that is still running. Same rule keeps
`service_team` named `service_team` in the schema: a cosmetic rename is not
worth a mid-swap fault.

Both stamps were checked against every existing directory before being written —
`ls apps/be-01/drizzle | sed 's/_.*//' | sort | uniq -d`, silent both times.
That check is not ceremony: #60 and #61 both stamped `20260814100000` and
`migrationsToRollback` filters on a strict `created_at >`, so `rollbackTo`
reversed nothing, silently, with both tables still standing.

## The gate

Run on **h2puni** over plain ssh at `6b7895b`, in
`/home/puni1/wd/puni/wt-service-split`, `CHECKOUT_HEAD` printed by the script and
matched against the branch head at both ends. Nothing was compiled or tested on
h1claw; that box denies both (`bin/block-local-builds.sh`).

| target                                                                        | result                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunx nx run-many -t lint typecheck --parallel=1 --skip-nx-cache`             | **22 projects**, exit 0                                                                                                                     |
| be-01 unit (bun **1.3.14**, in `apps/be-01`)                                  | **975 pass, 0 fail**, 28,023 `expect()` calls, **73 files**, 23.82s                                                                         |
| gw-01 unit (bun 1.3.14)                                                       | **45 pass, 0 fail**, 86 `expect()` calls, 8 files                                                                                           |
| `libs/domain` unit (bun 1.3.14)                                               | **118 pass, 0 fail**, 320 `expect()` calls, 9 files                                                                                         |
| fe-01 unit (`node vitest run`)                                                | **1,584 pass across 53 files, 0 fail**, 70.33s                                                                                              |
| `bunx nx format:check`                                                        | exit 0                                                                                                                                      |
| `bunx @fission-ai/openspec@1.3.0 validate --all --strict`                     | **71 items, 71 passed, 0 failed**                                                                                                           |
| `migration-lint` / `doc-caps` / `plaintext-secrets` (lefthook, `--all-files`) | all three ✔                                                                                                                                 |
| lefthook `lint` (`--all-files`, wider than the nx target)                     | **2 errors, 1 warning** — both errors pre-existing and neither in this diff; the warning is this branch's. See _Carried findings_.          |
| `bunx nx run-many -t build`                                                   | **not run here** — `tool-bootstrap` and `tool-devsync` refuse without `shellcheck`, absent on h2puni. CI runs it and is the gate of record. |
| fe-01 e2e (`pixels`)                                                          | CI.                                                                                                                                         |

The bun version is quoted beside the counts deliberately: same tree, 1.2.20 and
1.3.14 print different `expect()` totals (#58's verify.md measured it both ways).
`nx run be-01:test` and `nx run fe-01:test` are **not** how the suites were run:
under bun on h2puni the fe-01 target runs zero tests and exits 0. be-01, gw-01
and `libs/domain` are `bun test` in their own directories; fe-01 is
`node ../../node_modules/vitest/vitest.mjs run`.

**A combined `run-many -t test lint typecheck --parallel` is not a gate on this
box, and this chunk has the corpse to prove it.** The first run at this head came
back with four failed tasks — `be-01:lint`, `fe-01:lint`, `be-01:test`,
`fe-01:test` — and Nx labelled three of them flaky. The log says `Killed` on the
bare `bunx eslint` line: the kernel took them, not a rule. h2puni has 7.7 GB with
~2.3 GB of it shared and the dev deployment (`nx run-many -t serve`) holding a
share, so 22 projects × three targets in parallel is an OOM, reported as a red
test suite. Re-run at `--parallel=1` with each suite in its own directory, the
same head is green. **A red that names a project but no test case is a resource
verdict; look for `Killed` before you look at the diff.** Chunk 17 saw the same
thing as a SIGTERM and read it correctly then too.

## The migration, applied to dev's own data

Dev serves `main`, so there is no restart on this branch to inspect — and
pointing the dev container at an unreviewed prod-mode branch is not a worker's
call. The checkable half, and the stronger one, is that both migrations apply to
**the real dev database**: `VACUUM INTO` a snapshot of
`/home/puni1/wbs-dev/data/wbs.db` (a consistent copy taken over a live WAL,
never a write to the file dev is serving from), then `runMigrations` from this
branch against the copy. Run on h2puni at `39f9671`:

| read                                      | before             | after                                                              |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| tables matching `service`                 | `["service_team"]` | `["service", "service_team", "team_service", "work_item_service"]` |
| `work_item` rows                          | 342                | **342**                                                            |
| `project` rows                            | 57                 | **57**                                                             |
| `work_item.service_id`                    | absent             | present                                                            |
| `service_name` index                      | —                  | present                                                            |
| `team_service_by_service` index           | —                  | present                                                            |
| `service` rows / `work_item_service` rows | —                  | **0 / 0**                                                          |

The two zeroes are decision 4 shown rather than asserted: no existing dev row
carries a service, so the `INSERT … SELECT` seed correctly moves nothing and
nothing invents facts. 342 work items and 57 projects came through unchanged —
which is what "the migration applies" has to mean on a database somebody is
using.

## The failure-proof table

R5: every check is watched failing with the thing it guards deliberately broken.
Each row names the fault, what saw it, and what the run printed. Faults are
injected on h2puni, observed, and reverted from a byte copy taken before the
injection — a restored file, not a nearly-restored one — with the worktree
asserted clean before the final green.

**The guard on the guard, learned three chunks running and then a fourth time:**
assert a **non-empty diff before believing a red went in**. Chunk 19's F4 (`sed`
without `/g`), chunk 20's F5 and chunk 21's G2 (`sed` choking on `?? []`, which
it reported as `unterminated s command`) were all no-ops that a careless reader
would have logged as "the fault changed nothing, so the assertion is fine".
Chunk 22 found the sharper form: R1's first attempts appended to `up.sql`, a file
this repo does not have — the pair on disk is `migration.sql` + `down.sql` — so
each attempt _created_ it, and `git diff --quiet` reports clean about a file git
has never seen. **The guard must cover untracked files: `git status --porcelain`,
not `git diff`.**

### Section 1 — the tables and the migration

| fault                                                      | printed                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ON DELETE SET NULL` → `CASCADE` on `work_item.service_id` | **929 pass, 1 fail** — `keeps the work items when a service is removed`, `Received: undefined` for the item's name. Deleting a service had deleted somebody's plan.                                                                                                     |
| `DROP TABLE IF EXISTS team_service` struck from `down.sql` | **908 pass, 22 fail**. The target case saw `team_service` still in the table list after a rollback that reported success; the other 21 are the blast radius — an orphan join whose FK points at a dropped table blocks the reversal of nearly every migration under it. |

### Section 2 — the effective reading

| fault                                                                | printed                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared walk made **union, ancestor-first** (`[...above, ...stated]`) | **92 pass, 8 fail**, three of them the service dimension's own — a leaf's own service losing to its parent's, the nearer-ancestor case, and the three-dimension independence case.                                                           |
| shared walk made **union, own-first** (`[...stated, ...above]`)      | **94 pass, 6 fail** and **none of the service cases among them** — the single-valued read took `labelIds[0]`, still the row's own id. Recorded as D3: a single-valued read over a set-shaped walk narrows what a fault in the walk can show. |
| D3's blind spot **re-injected after the widening** (chunk 13)        | **109 pass, 9 fail**, three of them `effectiveServicesOf`'s own including the two-against-two override. Before the widening the same fault contributed none. Baseline back to **118 / 0** on revert.                                         |

### Section 3 — the write path and the undo journal

| fault                                                     | printed                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the array habit — `out.serviceId = [before.serviceId]`    | does not compile: `TS2322: Type '(string \| null)[]' is not assignable to type 'string'`. Cast past it: **74 pass, 2 fail**, both `SQLite query expected 2 values, received 1` — the undo **throws** rather than silently unlabelling, which is not what D6 predicted and the comment now says so. |
| `fieldsOf`'s service line deleted                         | **3 fail** at `expectDone` — `refused: stale_undo`, an undo reaching past an unjournalled write to an entry that write had already made stale.                                                                                                                                                     |
| the store's `patch.serviceId === undefined` guard deleted | **4 fail**, `Expected: "<id>" / Received: null` — a patch naming only another field unlabelling the row.                                                                                                                                                                                           |

### Section 4 — the directory, the services card, the ownership map

| fault                                                                                         | printed                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bumpWorkItems` struck from `removeService`                                                   | **950 pass, 1 fail** — `nulls the column on ?cascade and moves every row's revision`. Without the bump a journal entry holding the old number undoes against a row whose service changed under it.                                           |
| `directoryUsageOfService` naming every row, not the stating rows                              | **949 pass, 2 fail** — the two service-level cases caught it and the route-level 409 test **did not**, because its project holds one work item and that row carries the label. A confirmation test needs a row that is _not_ affected in it. |
| the `unknown_service` check struck from `inMemoryWorkItems`                                   | **950 pass, 1 fail** — 4.6's own case, which is what proves the fixture debt was actually paid.                                                                                                                                              |
| service validation moved **below** the rename                                                 | **2 fail** — route and service, both with `Renamed` sitting in the table after a patch that answered `unknown_service`. Returning from a drizzle transaction callback commits it.                                                            |
| `if (wanted !== null)` narrowed to `wanted.length > 0`                                        | **1 fail** — `replaces the whole owned set, and an empty array clears it`. Only the route-level case caught it; repository and service have no clearing case.                                                                                |
| the announce guard struck (map edit announced like a rename)                                  | **1 fail** — `editing the ownership map announces nothing`.                                                                                                                                                                                  |
| **the scheduler reading a service as a team** (`effectiveTeamsOf` fed `teamIds: [serviceId]`) | **2 pass, 2 fail** — the delete claim _and its control_. The control failing is the fault stated plainly: the plan's dates stop answering to the team at all.                                                                                |

### Section 5 — the two signals

| fault                                                                    | printed                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the effective reading pointed at the row's own stored teams              | **113 pass, 1 fail** — `reads the inherited team, not the row's own stored labels`.                                                                                |
| the absence guard struck from `builtByNonOwner`                          | **112 / 2** — both absence cases. `!teamIds.some(...)` over an empty set is `true`, so every unlabelled row in a young plan would wear the marker.                 |
| `teamIds.length === 0` struck from `assignedOutsideTeam`                 | **113 / 1** — the no-team case. A row with nobody's team named would flag every assignee on it.                                                                    |
| `some` → `every` in `builtByNonOwner`                                    | **113 / 1** — `takes any one owner among several teams as enough`.                                                                                                 |
| the ownership map emptied on the wire (fixture `serviceIds: []`)         | **966 / 1**, and only 5.4 — the controller's own map cases run on real SQLite, so the fixture's answer is watched nowhere else.                                    |
| `serviceIds.some` → `.every` in `builtByNonOwner` **after the widening** | **116 pass, 2 fail** — the mixed row and the "names which services" case. Every other case states one service, which is exactly why the `any` needed its own pair. |

**The sixth fault does not exist, and the code says so.** Striking the
`assigneeIds.length === 0` half of the assignee guard fails **nothing** —
**114 / 0** — because `.some` over an empty set already answers false. That half
is a statement of the rule rather than load-bearing code; it stays so absence is
spelled the same way in both signals, with a comment saying no case protects it.

### Section 6 — the filter

| fault                                                               | printed                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| the service predicate reading the row's **own stored** column       | the case chunk 8 deferred for want of a control and chunk 9 built — the stored-versus-effective fault at its real site in `RowFacets`. |
| the filter predicate pointed at `row.facets.serviceIds.slice(0, 1)` | **1 fail, 48 pass** in `tree-search.test.ts` — the row delivering two services stops answering to a tick on its second.                |

### Section 7 — the faces

| fault                                                                    | printed                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the cell's `own` restored to `serviceIds.slice(0, 1)` (7.1/10.4)         | **1 fail / 1559 pass** — `Remove Ledger from 010` is not a label the table has: the second service is not on screen at all.                                                                                |
| the marker's sentence naming only the first offending service (7.2)      | **1 fail**.                                                                                                                                                                                                |
| the carded mark carrying a native `title` after all (7.2)                | **1 fail**.                                                                                                                                                                                                |
| the folded card dropping the sentence the carded mark moved onto it      | **1 fail**.                                                                                                                                                                                                |
| the assumed-assignee arm forced off (7.2, F4)                            | **green, 1564/0** — nothing held it up. **F4 disproved the code it was written to prove, so that code is gone.**                                                                                           |
| the card's chip printing `names[0]` (7.3)                                | **1568/1**, the two-service case alone.                                                                                                                                                                    |
| the inherited chip drawn bare — no `↳`, no `data-inherited` (7.3)        | **1 fail**.                                                                                                                                                                                                |
| the chip moved **below** the tags (7.3, F3)                              | **GREEN, 1569/0 first time** — the case was blind, not the order safe. Re-aimed and re-run in the same chunk: moving the chip back up fails.                                                               |
| the table wiring `effectiveTagLabelOf` into `serviceLabel` (7.3)         | **1566/3**.                                                                                                                                                                                                |
| the export cell printing `serviceIds.slice(0, 1)` (7.4)                  | **1 fail** — `names every service a row delivers`.                                                                                                                                                         |
| the export column moved left of `Tags` (7.4)                             | **1 fail**, the full column-order case.                                                                                                                                                                    |
| `plan.services` swapped for `plan.tags` in `serviceCell` (7.4)           | **1 fail**.                                                                                                                                                                                                |
| `removing` pinned to `'tag'` in the dialog — _the bug as it stood_ (7.5) | **1 fail**.                                                                                                                                                                                                |
| `removing` pinned to `'service'` (7.5)                                   | **1 fail** — `still names the tag when a tag is what is going`.                                                                                                                                            |
| the service's `rename` wired to `directory.renameTag` (7.5)              | **1 fail**.                                                                                                                                                                                                |
| the Services card's `askToRemove('service', …)` → `'tag'` (7.5)          | **1 fail**.                                                                                                                                                                                                |
| the rename carrying `serviceIds: []` (7.5, ownership map)                | **1 fail** — `renames a team without touching what it is responsible for`. This is the fault the optional field exists to make impossible: a rename that silently empties a map somebody else just edited. |
| `servicesOf` following the claim order, not the directory's              | **1 fail**, the order case, which seeds the claims reversed on purpose.                                                                                                                                    |
| choosing a service **replacing** the set rather than joining it          | **1 fail**.                                                                                                                                                                                                |
| the picker creating a service and never claiming it                      | **1 fail** — `makes a service and claims it in one gesture`.                                                                                                                                               |

### Section 8 — the empty diffs

| fault                                                                                                  | printed                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `const teamOf = effectiveTeamsOf(rows)` reading `r.serviceIds` as `teamIds` (8.1, re-aimed at the set) | **1 pass, 3 fail**. The third is the interesting one: `poolFor` **throws** rather than mis-dating, because a row carrying two services claims two teams and a slice spends one pool. A set-valued dimension read as a pool key is not a wrong date, it is a plan that cannot be scheduled. |
| `ALTER TABLE project_team_capacity ADD service_id` appended to the migration (8.3)                     | **1 pass, 2 fail** — asserted against the **migration** rather than the ORM, because a re-key would have to happen in the schema and a `pragma` answer cannot be satisfied by a type that merely looks unchanged.                                                                          |
| the same append on `person_team` (8.4)                                                                 | **1 pass, 2 fail**.                                                                                                                                                                                                                                                                        |

**8.1's file was measuring a dead column for ten hours of chunks, and that is
the finding of section 8.** `service-empty-diff.test.ts` was written at task 4.5
against `work_item.service_id`. Chunk 12 widened the dimension to a set and 10.2
moved the fact onto `work_item_service`, leaving the column standing for the
outgoing release (D2) — read by nothing. The file kept passing: `serviceId` is
not in `WorkItemPatch`, so `patch(id, owner, { serviceId })` fell through the
patch's rest-spread **straight onto the dead column**, and the FK's
`on delete set null` nulled it again on removal. Four green cases asserting that
the one field no scheduler could read did not move a date.

**Why nothing caught it: `nx typecheck` builds `tsconfig.lib.json`, which
excludes `src/**/\*.test.ts`. Test files in this repo are never typechecked** — a
stale field name in a spec is invisible to lint, to typecheck and to a green
suite alike. The only defence is asserting the fact came _back_ rather than
trusting the write, so `pooledPlan`now ends with a guard: two rows carry a
non-empty`serviceIds`on the read`listByProject` delivers, or the plan under
test is not a service plan. Same four cases, 9 expects → 24.

8.3's strong form uses `rollbackTo(BEFORE_SERVICE)`: seed a capacity row on the
pre-split database, run the two service migrations forward, and the row and the
column list are identical — with `reversed.length > 0` asserted **first** so the
case cannot pass by comparing a database with itself.

### Section 10 — the widening

| fault                                                               | printed                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DROP TABLE IF EXISTS work_item_service` struck from `down.sql`     | **30 pass, 25 fail** — the target case plus the blast radius section 1 named one dimension over.                                                                                                                                                                                                                                                |
| the `INSERT … SELECT` seed struck                                   | **52 pass, 3 fail**, all three the new work-item-service cases. The seed is load-bearing and nothing else in the file leans on it.                                                                                                                                                                                                              |
| `WHERE service_id IS NOT NULL` struck                               | **41 pass, 14 fail**, and louder than expected in a useful way: `DrizzleError: Failed to run the query`, because `service_id` is `NOT NULL` on the join table and an inheriting row's null cannot be inserted. A migration that tries to seed absence **refuses to apply** rather than quietly mislabelling a plan.                             |
| `(row) => row.serviceIds` → `.slice(0, 1)` in `effectiveServicesOf` | **117 pass, 1 fail**, the two-service override — the realistic regression for this change, a leftover singleton fold.                                                                                                                                                                                                                           |
| the table's `.map` restored to `serviceIds.slice(0, 1)` (facet)     | **1 fail / 1558 pass** at `Unable to find a label with the text of: Service Ledger`. The prediction was wrong in an informative way: the facet is built from the effective reading, so a fold does not narrow the table to nothing — the second service never becomes a facet value, and the box a user would tick is **not on screen at all**. |
| `before.serviceIds.slice(0, 1)` in `revertTo` (10.3)                | **76 pass, 1 fail** over `undo.test.ts` — `puts a replaced service set back, whole` fails alone while the five one-service cases beside it stay green.                                                                                                                                                                                          |

## What this change deliberately did not build

1. **The service on the chart's bar hover.** Task 8.5 was written against a
   surface that does not exist: `GanttRow`, `GanttPlan` and `GanttBar` declare
   no service field, and this branch's whole diff over `gantt-geometry.ts` is 32
   added lines — the `ServiceLabel` type and its doc comment, **zero statements
   changed**. So `barColorOf` and every geometry function are byte-identical to
   `main`, the spec's `A service SHALL NOT colour a bar` holds because nothing
   touched it, and no test is added: a case feeding a service to a type with no
   field for one does not compile, and a case that omits it cannot fail. The
   hover this change _did_ ship is the table cell's — the title naming the
   ancestor a row inherits from, and the non-owner note. A service on the bar is
   its own change.
2. **Scheduling.** Decision 2: grouping and reporting only. No pool, no size, no
   engine change. Section 8 is the assertion.
3. **A backfill.** Decision 4: existing `serviceTeam` rows are teams and start
   with no service. Nothing invents facts.
4. **The `service_team` → `team` rename.** D9: a cosmetic rename against a
   shared blue/green SQLite file is not worth a mid-swap fault. The schema keeps
   the old name and `ServiceTeamLabel` keeps saying so out loud, which is also
   why `ServiceLabel` is its own type rather than an alias of it.
5. **Richer mismatch UX** — counts, a report, anything that moves or blocks a
   row. Dany's words were "in the future"; today it is one facet and a quiet
   marker per signal.
6. **A Delete/Backspace focus walk on the ownership chips.** Each chip is a
   button, so a keyboard removes one with Enter or Space; what is missing is the
   person row's move-to-the-neighbour afterwards, which needs `neighbourChip`
   and that is written against a person's own membership list. Generalising it
   is its own change.
7. **A third export from `label-mismatch.ts` answering _which person_ is
   outside.** 7.2's hover needs the name; the same function over a person set is
   a second shape, and one dimension's marker did not justify it.

## Carried findings a reviewer should see

- **be-01's `directory.controller.ts` comment on `DELETE /services/:id` still
  says `label_nulled`.** Since 10.2 the join table is authoritative and
  `directoryUsageOfService` reports `label_removed` (10.5). The comment is stale
  by one task and costs a be-01 suite run to correct.
- **One lint warning is this branch's and `nx lint` cannot see it.**
  `bunx lefthook run pre-commit --all-files` lints a **wider** set than the nx
  target and reported three problems at `6b7895b`. Two are parsing errors on
  `apps/be-01/drizzle.config.ts` and `apps/be-01/tools/capture-capacity-oracle.ts`
  — "not found by the project service", files outside every tsconfig, in neither
  this diff nor this change's business. The third is ours:
  `react-hooks/exhaustive-deps` at **`wbs-table.tsx:3641`** — _useMemo has
  unnecessary dependencies: `ownedServicesByTeam` and `teamsByPerson`_. Both
  names are section 5's. It is a warning, so `nx run-many -t lint` exits 0 over
  it and the branch reads green from the target a reviewer would run. Owed: drop
  the two names from that dependency array and re-run fe-01 (a suite run, ~70s,
  which is why it is written down here rather than squeezed into the chunk that
  found it at the end of its time box).
- **The map half of 4.5 is a regression guard, not a proof.** Breaking the
  reading of the _item's_ service leaves `moves not one date when the ownership
map is edited` green, because the map is not on the item at all. What proves
  that claim today is the grep (`grep -rn serviceIds apps/be-01/src
libs/domain/src`, minus its own cases and the five directory files that own
  it, returns nothing under the scheduling surface) and the announce red. The
  file says so where a reader will find it.

## The four paths a prod-mode review owns

`notes/delivery-modes.md`. The worker does not merge this.

1. **`apps/be-01/drizzle/**`** — two migrations, and the D2 decision to leave
`work_item.service_id` standing and unread rather than drop it.
2. **`libs/domain/**`** — `effective-service.ts`and`label-mismatch.ts`, both
read by both apps, and the shared `effectiveLabelsOf` walk they lean on.
3. **`service/schedule.ts`** — untouched, and asserted untouched by section 8's
   faults rather than by a file list.
4. **Auth** — untouched. No route added here changes who may read or write; the
   four service routes sit behind the same guard the directory's other routes do.
