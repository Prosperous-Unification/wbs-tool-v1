<!--
Only for a non-trivial technical shape. Do not restate an ADR's rationale.
-->

## Context

R2-5 designed this on 2026-08-13 (`notes/wbs-brief-2026-08-13-r2-team-service.md`
§2 target model, §3 schema, §5 surfaces). Its general half shipped 2026-08-20 as
`tags` (PR #87), which left the specific half and gave it a code template: a
label dimension in this repo is now a known shape — a global directory table, a
per-item statement, a reading over the shared `effectiveLabelsOf` walk, a facet,
a cell, an export column, and a set of asserted empty diffs.

So the technical shape here is **not** "add a third label". Two things make it
its own design:

1. **A service is joined to teams.** The ownership map is the first
   directory-to-directory relationship in this schema. Everything else in the
   directory is a flat list plus a link to work; `team_service` links two
   directory entities to each other and belongs to neither work items nor
   projects. Where it may be read from is the question D4 answers.
2. **Two derived signals read two dimensions at once.** Every reading in this
   repo so far answers about one dimension. _Built by a non-owner_ needs the
   effective service, the effective teams and the ownership map together;
   _assigned outside the team_ needs the effective teams and `person_team`. A
   reading that joins dimensions is a new kind of thing here, and D5 fixes where
   it lives so it does not get computed three ways in three components.

The defining absence is `tags`' unchanged: a team is a pool the scheduler
spends, a service decides nothing. Every omission below — no capacity column, no
`capacity_released` arm, no blocking on a mismatch — is that absence made
visible on purpose and asserted rather than left to be noticed.

## Decisions

### D1 — `service` is a global directory table; `team_service` is the ownership map

`service (id, name)` with a unique index on `name`, mirroring `service_team`
(`schema.ts:589`) and `tag` (`schema.ts:673`) exactly, and for their reason:
unique at the database, not only in the service, because two people creating
`Payments` at the same moment both pass a check-then-insert and only a
constraint stops the second.

Global rather than per-project, R2-5 §2's Q7 answer verbatim: `Payments` means
`Payments` in every plan, which is what makes an export column mean the same
thing across plans and what R3's name-matched import would need. There is no
`project_id`, no per-project list and no scoping read. Were the list ever scoped
later the change is a nullable column plus a widened unique index — additive,
not a redesign — but nothing here anticipates it, because a half-built scoping
column reads as a promise the code does not keep.

`team_service (team_id, service_id)` keyed on the pair, **both sides
`ON DELETE CASCADE`**. The pair is the fact: "Platform owns Payments" is either
stated or not, and a second row saying it again would be a second answer to one
question. Both cascades carry `work_item_tag`'s argument unchanged — blue and
green share one SQLite file, the outgoing release knows nothing about this
table, and its plain `DELETE FROM service_team` must not hit a constraint it
cannot see.

Indexed by `service_id` as well as the primary key, because the directory asks
"what would removing this service touch" and the primary key answers only the
other direction — `work_item_tag_by_tag`'s reason.

_Rejected:_ a `kind` column on `service_team` making one table serve both
entities. R2-5 §3 rejected it and the reasoning holds harder now: a
discriminator would put a nullable `size` on product areas, make every existing
capacity query filter by kind, and give the ownership map a self-join on the
table it discriminates. Two tables, two behaviours, no branch.

### D2 — The item's service is a nullable column on `work_item`, not a join table

`work_item.service_id TEXT REFERENCES service(id) ON DELETE SET NULL`.

This is the one place the design departs from the tags template, and it is the
task brief's open detail defaulted: **one service per item**. The rationale is
that the schema should state the cardinality rather than a comment stating it.
A join table with a `work_item_id` unique index would say the same thing in a
weaker way — the shape would read as many-valued to anybody scanning it, and
every read would then be a group-by that returns arrays of length ≤ 1, which is
how a "temporarily single-valued" field becomes multi-valued by accident.

`ON DELETE SET NULL` rather than `CASCADE`, and the difference matters: deleting
a service must not delete work items. This is also the arm that makes the
directory removal effect `label_nulled` rather than `label_removed` — the
existing tag/team distinction in `directory-usage.ts:15-30`, which this change
does not invent and does not blur. A column is nulled; a set member is removed;
the two are different sentences on screen and now both are true of something.

**What multi-service would cost, stated so the door stays visibly open:** a
`work_item_service` join table, the seed `INSERT … SELECT id, service_id FROM
work_item WHERE service_id IS NOT NULL`, a read that returns an array, and the
effective reading changing its `wrap` — the walk itself is already set-valued,
because `effectiveLabelsOf` works in sets and this dimension hands it a
singleton set. That last part is deliberate: **the domain reading is set-shaped
even though the column is single-valued**, so widening the cardinality is a
migration plus a read, not a redesign of the inheritance. Dany can say "multi"
and it is a day.

_Rejected:_ free text on the work item. R2-5 §2 states the reason and it is
unchanged — typing the label onto the item makes `Payments` and `payments ` two
product areas and leaves rename with nothing to rename.

### D3 — Inheritance is the shared walk, and the fourth line over it

`effectiveServicesOf` in `libs/domain/src/effective-service.ts`, built from
`effectiveLabelsOf` exactly as `effectiveTagsOf` is: its own row shape
(`ServiceLabelled`), its own result shape (`EffectiveServices`), its own cycle
error (`ServiceAncestryCycleError`), and the walk itself shared. The
per-dimension vocabulary stays per-dimension for `effective-label.ts`'s stated
reason — "Payments — inherited from 010 Backend" is not "regulatory — inherited
from 010 Backend", and a shared error class would name neither.

The row's `serviceId: string | null` becomes `labelIds: serviceId ? [serviceId]
: []` on the way in, and the result carries `serviceId: labelIds[0]` back out.
Absence is spelled once — a row with no service anywhere above it is **absent
from the map**, never present with a null — which is the same single spelling of
"unstated" the other two dimensions have.

`effective-service.ts` is exported from the package index beside
`effective-tag.ts`; `effective-label.ts` stays deliberately unexported, and that
comment stays true with three dimensions over it.

**Watched red:** make the walk union instead of override for this dimension and
the inheritance case must fail. Same red the tag dimension carries, because the
same line is what would break.

**What that red actually showed, watched 2026-08-21 and worth writing down**,
because it is a limit of the single-valued read rather than of the walk: the
union fault is ordering-dependent for _this_ dimension. Unioned
**ancestor-first**, three of the service dimension's own cases fail and the
walk's override rule is proved from here. Unioned **own-first**, the service
half sees `[own, ancestor]`, takes `labelIds[0]`, and answers correctly — the
fault is invisible to this dimension and is caught by the team and tag halves of
the same shared case instead.

So the single-valued read narrows what a fault in the shared walk can show, and
the reason a union cannot drift in unnoticed is that **three** dimensions read
the walk and the other two return the whole set. That is an argument for keeping
`effective-label.ts` shared and for keeping the three-dimension case asserting
all three, not for a defensive length check inside `effectiveServicesOf`: a
throw there would be an unreachable branch with no test able to reach it
honestly.

### D4 — The ownership map is read on be-01 and shipped whole to the client

The map is small — teams × services, both directory-sized — and both signals
need it per row. So `GET /api/directory` (or whatever the existing directory
read is called at build time) carries `serviceIds: string[]` on `TeamView`, and
fe-01 computes the signal per row from the tree it already has.

The alternative, computing both signals on be-01 and sending a boolean per row,
was rejected for a reason this repo has been bitten by: **a derived flag on the
wire is a second copy of a rule that the client also needs in order to filter.**
The facet must narrow the tree client-side without a round trip (every other
facet does), so the client needs the rule anyway; sending the answer too would
mean two implementations, and the one that drifts is the one nobody looks at.

The map lives on `TeamView` rather than as its own top-level list because it is
a fact about a team — the directory edits it on the team row (Dany's "it must be
configurable in the directory"), and a picker needs it exactly where it is
edited.

### D5 — Both signals are one domain module, computed from the effective reading

`libs/domain/src/label-mismatch.ts`, two functions, shared vocabulary:

- `builtByNonOwner({ serviceId, teamIds, ownedServicesByTeam })` — true when
  `serviceId` is stated, `teamIds` is non-empty, and no team in `teamIds` owns
  `serviceId`.
- `assignedOutsideTeam({ assigneeIds, teamIds, teamsByPerson })` — true when
  both are non-empty and some assignee belongs to none of `teamIds`.

In `libs/domain` rather than fe-01 because be-01 needs them the day an export or
an MCP tool wants the flag, and because the rule is a domain sentence, not a
rendering. One module rather than two files because they are one vocabulary with
two subjects, and a reader who finds one should find the other beside it.

**Both take the _effective_ team set**, never the row's own stored labels. This
is the class of bug this repo has shipped twice (`RowFacets.teamIds`'s comment
names both), and here it would be louder than usual: a leaf under a
`Platform`-labelled parent, assigned to somebody outside Platform, would flag
nothing — the marker would be missing exactly where the inheritance is doing the
work.

**Absence flags nothing, and this is a rule, not a default.** No service, no
team, or no assignee → no signal. A tool that marks unlabelled rows would mark
most of a young plan, which teaches readers to ignore the marker, which is worse
than not having it. Each half is asserted with its own test.

**The signals never block a write.** No 4xx, no confirm dialog, no validation.
Recording that a non-owner built something is the plan being honest about what
happened; refusing the write is how a tool gets worked around.

### D6 — `work_item.service_id` is set through the existing patch path, journalled as a scalar

`serviceId?: string | null` on the work-item patch payload, unknown id →
`unknown_service`, the refusal shape the team and tag writes already make.
Journalled before-value is the **prior scalar**, and that is correct here rather
than the whole-set rule tags needed: a column has one prior value. The tags
change had to warn about the scalar habit because its field was set-valued; this
field is not, and stating that inversion here stops a reviewer "fixing" it into
an array.

Undo and redo asserted over real SQLite rather than the in-memory store — the
store cannot model a cascade, which is how a restore case passed under the very
fault it was written for in #79.

### D7 — Deleting a service: the team flow, minus the capacity arm

`DELETE /api/services/:id` answers **409 `in_use`** with the usage document when
any work item names it, and removes it when the caller repeats with
`?cascade=1`. That is `removeTeam`'s two-step verbatim
(`directory.service.ts`, `answerRemoval` at `directory.controller.ts:56`), so
the dialog, the 409 shape and the confirm are a clone rather than a design.

Two differences, both making the service side safer, both R2-5 §3's:

- one effect kind, `label_nulled` (see D2 — a column, not a set member), and
  **no `capacity_released` arm**, because there is no size to release;
- **no date can move**, so the confirm is informational rather than a warning.
  The removal announces `directory_changed` to each touched project, never
  `capacity_changed`: a client re-reads the tree, and the schedule it re-reads
  is the one it already had.

The `team_service` rows go with the cascade, and **that is not part of the usage
report**: losing an ownership claim about a service that no longer exists is not
an effect on any plan.

_Rejected:_ soft-archive (a second visibility state on every picker, for a list
users can retype in five seconds) and silent delete (a label vanishing from rows
nobody looked at is the one directory operation that should be loud).

### D8 — Nine facets, and the two signals are booleans

`FilterCriteria` grows `serviceIds: readonly string[]`, `builtByNonOwner:
boolean` and `assignedOutsideTeam: boolean`; `NO_FACETS` grows `[]`, `false`,
`false`. Booleans rather than a tri-state, matching `unestimated` and `critical`
which are the two existing derived-predicate facets: "show me only the
mismatches" is a question, "show me only the non-mismatches" is not one anybody
asks, and a tri-state costs every control a third rendering.

`RowFacets` gains `serviceId: string | null` and the two booleans, all three
from the **effective** reading. `filterWords` gains three labels.

### D9 — `service_team` keeps its name, and the directory page says `Teams`

No rename in this change. Blue and green share one SQLite file during a swap and
the outgoing release selects `service_team` on every tree read; renaming it here
would break the release that is still running while this one boots. R2-5 put the
rename in R2-6 for exactly this reason and task decision 4 prefers the smallest
blue/green-safe diff over a cosmetic one.

The consequence to accept out loud: for one release the schema has a table
called `service_team` that means _team_ and a table called `service` that means
_service_, and that is confusing to read. It is confusing for one release and
survivable; a mid-swap 500 is not. Both tables' JSDoc says which is which and
names R2-6.

### D10 — One spec delta, in `wbs-domain`

There is no `wbs-api` capability in this repo. 66 of 68 change folders state
route behaviour in `wbs-domain`, `directory-crud` — which shipped the directory
routes and their 409 shapes — included. Creating a second capability for one
change would split the directory's rules by release. Same deviation `tags` D10
named, same reason, restated here rather than cross-referenced because a
reviewer of this change should not have to read another one to find out why.

## Risks

- **The ownership map ships with no data**, so both new facets find nothing on
  day one and the feature reads as broken until somebody fills the directory in.
  Mitigated only by honesty: the Services card and the team row's services
  picker are the first thing the change puts on screen, and the facet is
  disabled with a "no services own anything yet" hint rather than offered as an
  empty filter. Not mitigated by seeding — see the non-goal.
- **A third label dimension is a third column budget claim.** The folded table
  had 29px of slack at 1280 before tags, and tags took its exemption
  (`CONDITIONAL_COLUMNS` in `table-frame.ts`). The service column takes the same
  exemption for the same reason and the same test guards it; if
  `foldedTableMinWidth` answers anything different after this change, that is a
  red, not a rounding.
- **`ON DELETE SET NULL` is a write the outgoing release will see.** A service
  deleted during a swap nulls `work_item.service_id`, a column the outgoing
  release does not select — so it sees nothing, which is the correct outcome and
  the reason the column is nullable rather than defaulted.
- **Two signals is where scope grows.** Counts, a report, a dashboard, blocking
  — all obvious next steps, all deferred by the proposal's non-goals. The risk
  is a build that quietly adds one; the tasks below add none, and the verify
  record lists what was left out.
