## Why

Dany, 2026-08-20 23:07: _"I need to have service and team as separate entities."_

Today they are one row. The directory table is literally `service_team`
(`schema.ts:561`), and one entry answers two different questions at once: **who
does the work** — a pool the scheduler spends slots in, with people as members
and a per-project capacity — and **what product area the work belongs to**.
Picking `Platform` costs the plan the ability to say `Payments`, and picking
`Payments` gives a product area a capacity it should never have had.

R2-5 designed the second dimension on 2026-08-13
(`notes/wbs-brief-2026-08-13-r2-team-service.md` §2, §3, §6). I dropped it on
2026-08-16 as not worth three days beside the team label; Dany revived the
general half of it on 2026-08-19 as **tags** (R10-B, PR #87). That leaves the
specific half, and this change is it. The test the split has to pass is
therefore: **a service must be more than a tag, or it should have stayed one.**

It is. Three things a tag cannot do, all of them asked for on 2026-08-20:

- **A team owns services.** Dany, 23:18: _"one team can be responsible for
  several services - it must be configurable in the directory. It will help in
  the future to flag where teams build something they do not own."_ A tag has no
  relationship to any other directory entity; a service is joined to teams.
- **It reads against the team.** That ownership map makes a row whose service is
  not in its team's owned set a statement — _built by a non-owner_ — which is a
  sentence no tag can form.
- ~~**It is single-valued on the item.**~~ Retired 2026-08-21 — Dany, 07:46:
  _"can be several services."_ A row carries a **set**, the `tagIds` shape. The
  two bullets above are what still separate a service from a tag, and they are
  enough: cardinality never was the distinction.

Dany, 23:16: _"Let service and teams be independent."_ So service is its own
dimension on the work item, not derived through the team — R2-5 §2's shape
exactly. The ownership map is directory data _about_ teams and services; it
never labels a work item, and it never reaches the engine.

Dany, 23:19, on assignees: _"Same for assignees if they do not belong to a
team."_ Second signal, same vocabulary.

## What Changes

**Two tables, additive only.** `service (id, name)` — a global directory, no
project column, exactly as `service_team` and `tag` are global — and
`team_service (team_id, service_id)`, the ownership map, cascading on both
sides. The item's own services are a third table, `work_item_service`, the
`work_item_tag` shape — a set per item. D2 records why it was a nullable column
first and what the widening cost.

**`service_team` keeps its name.** Blue and green share one SQLite file, so
nothing is renamed while a release beside this one still selects it. The rename
to `team` is R2-5's R2-6 and is not this change — task decision 4, and D9.

**A service has no pool, no size and no effect on any date.** `service_team`
minus `size`, in R2-5's words. This is the defining absence and it is asserted,
not asserted-about: `service/schedule.ts` and everything under `slicesOf` have
an empty diff, watched by a red that wires the scheduler to read a service and
watches every downstream date move.

**Inheritance is override, per dimension, independently** — R2's Q4, confirmed
for teams, shipped for tags, and unchanged here. `effectiveServicesOf` is a
fourth line over the shared `effectiveLabelsOf` walk
(`libs/domain/src/effective-label.ts`), beside `effectiveTeamsOf` and
`effectiveTagsOf`. A row with a service and no teams inherits its ancestor's
teams and overrides its ancestor's service. Blank means inherit; there is no
third "deliberately none" state. Inheritance is a **reading, never a write**.

**Two mismatch signals, one vocabulary.** Both are computed from the effective
reading, both flag only when **both** facts are stated, and neither blocks
anything or moves any date:

- **Built by a non-owner** — the row's effective service is not in the owned set
  of any of its effective teams.
- **Assigned outside the team** — an assignee on the row is a member of none of
  the row's effective teams. `person_team` already stores membership per person
  and `PersonView.teamIds` already carries it to the client, so the data exists
  (verified in the tree before designing, per task decision 7).

Each is one filter facet and one quiet marker on the cell the signal is about.
Rows missing either half flag nothing: absence is not a mismatch.

**The filter gains two facets**, to nine: `FilterCriteria` (`tree-search.ts:77`)
grows `serviceIds` and the two boolean signals, `NO_FACETS` grows their empty
entries, and `narrowTree` gains predicates against the **effective** reading —
never the row's own stored label, which is the stored-versus-effective bug this
repo has shipped twice.

**One export column**, `Service`, RFC4180-quoted, beside `Teams` and `Tags`.

## Impact

- **Prod mode**, mandatory: this adds `apps/be-01/drizzle/**` and touches
  `libs/domain/**`. Two of the four watched paths. See
  `notes/delivery-modes.md`. The PR ends at `state: review`; it is not merged by
  the worker.
- **Affected specs:** `wbs-domain` — the service dimension, its inheritance, the
  ownership map, the two signals and the directory routes. One delta, not two:
  there is no `wbs-api` capability in this repo (tags D10, and 66 of 68 changes
  state route behaviour in `wbs-domain`).
- **Affected code:** `apps/be-01` schema, repository, controller, service,
  directory-usage, drizzle; `libs/domain` `effective-service.ts` and the two new
  signal readings; `apps/fe-01` `wbs-table.tsx`, `plan-cards.tsx`,
  `plan-export.ts`, `directory-page.tsx`, `tree-search.ts`, `lib/wbs-api.ts`,
  `table-frame.ts`.
- **Deliberately untouched:** `apps/be-01/src/service/schedule.ts`, everything
  in `libs/domain` the scheduler reads, `project_team_capacity` (not
  generalised, not re-keyed — R2-5 §2), `person_team`'s shape, `tag` and
  `work_item_tag`, `gantt-geometry.ts`'s geometry and `barColorOf`. Each empty
  diff is an assertion and a task below watches it.

## Non-goals

- **No backfill.** Existing `service_team` rows are teams and start owning
  nothing; every work item starts with no service. Nothing in the data
  distinguishes a row somebody typed meaning `Payments` from one meaning
  `Platform`, and guessing wrong would put a product area where a pool is. Task
  decision 4, R2-5 §3's seed argument.
- **No scheduling effect.** No pool, no size, no capacity row, no clamp, no
  floor. Task decision 2.
- **Tags stay, unchanged and general-purpose.** Task decision 3. A service is
  not a tag with a rule; the two coexist and neither reads the other.
- **No richer mismatch UX.** No counts, no report, no dashboard. Dany's words
  were "in the future"; the map has no data yet, and a count of nothing is a
  screen that teaches a reader the feature is broken. Facet plus marker now.
- **The mismatch never blocks a write.** A plan that says a non-owner is
  building something is describing what is happening, and a tool that refuses to
  record it is a tool people work around.
- **No multi-service item.** One service per row — the open detail in the task
  brief, defaulted here. D2 states what changing it would cost, which is a
  migration and nothing else.
- **`service_team` is not renamed to `team`.** R2-6, a release later. D9.
