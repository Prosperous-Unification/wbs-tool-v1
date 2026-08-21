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

### D2 — The item's services are a set, stored in a `work_item_service` join table

**Superseded 2026-08-21.** Dany, 07:46 Kyiv: _"can be several services."_ D2
originally decided a nullable `work_item.service_id` column on the argument that
the schema should state a cardinality of one rather than a comment stating it.
The cardinality it stated is no longer the one we want, so the argument now
points the other way: the store is a `work_item_service (work_item_id,
service_id)` join table, keyed on the pair, both sides cascading — literally
`work_item_tag`, the shape D2 departed from. The departure is over.

The paragraph that turned out to matter is the one D2 wrote to keep the door
open: **the domain reading was already set-shaped**, because `effectiveLabelsOf`
works in sets and this dimension handed it a singleton. That is why widening cost
a migration and a read rather than a redesign of the inheritance, exactly as
predicted.

**The transition is staged, and the middle state is on the branch right now.**
Chunk 12 widened the domain and the filter to `serviceIds` and left the store
single-valued, folding the wire into a singleton set at **two named edges** —
the `effectiveServicesOf` memo in `wbs-table.tsx` and be-01's 5.4 route case —
each carrying a comment naming the line that deletes it. Both folds die with the
migration below. A middle state is fine; an unmarked one is not.

**What the migration owes, blue/green-safe (two be-01 processes, one SQLite
file):** create `work_item_service`, seed it `INSERT … SELECT id, service_id FROM
work_item WHERE service_id IS NOT NULL`, and **leave `work_item.service_id` in
place**, unread by the new code — the outgoing process still writes it during the
swap, and a column that is merely ignored breaks nobody. Dropping it is a later,
separate migration once no process reads it. That is the same additive rule D1
follows.

**One consequence, carried into the spec:** the directory removal effect for a
service becomes `label_removed`, not `label_nulled`. A column is nulled; a set
member is removed. D2 originally chose `label_nulled` _because_ of the column,
and named the tag/team distinction in `directory-usage.ts:15-30` as the thing not
to blur — so the effect follows the storage honestly rather than staying put.
Until the join table lands, the store is still a column and `label_nulled` is
still what the code emits; the switch belongs to the migration chunk, in one
commit with it.

_Rejected:_ free text on the work item. R2-5 §2 states the reason and it is
unchanged — typing the label onto the item makes `Payments` and `payments ` two
product areas and leaves rename with nothing to rename.

_Rejected:_ keeping the column and adding a `work_item_id` unique index later.
That was the shape D2 warned about — a join table read as many-valued while
constrained to one — and it is now the wrong constraint besides.

### D3 — Inheritance is the shared walk, and the fourth line over it

`effectiveServicesOf` in `libs/domain/src/effective-service.ts`, built from
`effectiveLabelsOf` exactly as `effectiveTagsOf` is: its own row shape
(`ServiceLabelled`), its own result shape (`EffectiveServices`), its own cycle
error (`ServiceAncestryCycleError`), and the walk itself shared. The
per-dimension vocabulary stays per-dimension for `effective-label.ts`'s stated
reason — "Payments — inherited from 010 Backend" is not "regulatory — inherited
from 010 Backend", and a shared error class would name neither.

The row carries `serviceIds: readonly string[]` in and the result carries
`serviceIds` back out — no conversion at either end, so `effectiveServicesOf` is
now literally `effectiveTagsOf` with different names. Absence is spelled once — a
row with no service anywhere above it is **absent from the map**, never present
with an empty array — which is the same single spelling of "unstated" the other
two dimensions have.

**This is the widening D2 records**, and it happened at the domain layer first:
the two conversions this paragraph used to describe (`[serviceId]` in,
`labelIds[0]` out) were the whole cost of the singleton, and deleting them was
the whole cost of the set.

`effective-service.ts` is exported from the package index beside
`effective-tag.ts`; `effective-label.ts` stays deliberately unexported, and that
comment stays true with three dimensions over it.

**Watched red:** make the walk union instead of override for this dimension and
the inheritance case must fail. Same red the tag dimension carries, because the
same line is what would break.

**What that red showed while the read was single-valued, watched 2026-08-21 and
kept because it explains why the case list looks the way it does:** the union
fault was ordering-dependent for _this_ dimension. Unioned **ancestor-first**,
three of the service dimension's own cases failed and the walk's override rule
was proved from here. Unioned **own-first**, the service half saw
`[own, ancestor]`, took `labelIds[0]`, and answered correctly — the fault was
invisible to this dimension and was caught by the team and tag halves of the
same shared case instead.

**The widening closed that hole.** With `serviceIds` returned whole, an own-first
union is visible to this dimension too: chunk 12's _"overrides a parent's two
services with a leaf's two, keeping none of them"_ puts two ids on each side, so
a union answers with four whichever end it starts from. **Watched 2026-08-21**,
own-first union re-injected into `effective-label.ts` on h2puni: 109 pass, 9
fail, and **three** of them are `effectiveServicesOf`'s own — that case, "lets a
leaf's own service beat its parent's", and "gives the nearer ancestor's service
to a leaf between two" — plus the three-dimension case. Before the widening this
dimension contributed none of them. The argument for keeping
`effective-label.ts` shared and for keeping the three-dimension case asserting
all three still stands on its own; it no longer has to carry this dimension's
blind spot as well. Still no defensive length check inside `effectiveServicesOf`
— there was never a reachable fault for one, and now there is not even a
cardinality to check.

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

**The write is a patch, not a second route, and that is a departure worth
naming.** `/api/teams/:id` took a required `{ name }` and called `renameTeam`.
It now takes `{ name?, serviceIds? }` and calls `patchTeam`, exactly as
`/api/people/:id` has taken `{ name?, teamIds? }` since the people dimension
shipped. The alternative — a `PUT /api/teams/:id/services` beside the rename —
was rejected because the two writes would each need their own transaction, and
a team renamed and re-owned in one gesture on the directory page would be two
requests either of which could fail alone. One patch, one transaction, one
refusal. The cost is that `name` is no longer required on the wire, which is
why `nothing_to_change` now guards this route as it already guarded the
person's.

### D5 — Both signals are one domain module, computed from the effective reading

`libs/domain/src/label-mismatch.ts`, two functions, shared vocabulary:

- `builtByNonOwner({ serviceIds, teamIds, ownedServicesByTeam })` — true when
  `serviceIds` is non-empty, `teamIds` is non-empty, and **some** service in
  `serviceIds` is owned by no team in `teamIds`. `some`, not `every`: one
  unowned service flags the row, which is Dany's sentence and also what makes
  the two signals read alike — some service unowned, some assignee outside.
  Naming _which_ services is the same predicate over a one-element set, so
  there is no third export.
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

### D6 — A work item's services are set through the existing patch path, journalled whole

**Amended 2026-08-21 with D2.** `serviceIds?: readonly string[]` on the
work-item patch payload, replacing the stated set in full, deduplicated rather
than refused on a repeat, unknown id → `unknown_service` refusing the whole
patch — the refusal shape the team and tag writes already make.

The journalled before-value is the **whole prior set**, not one member, so an
undo restores every service the patch replaced. D6 originally decided the
opposite — a prior scalar, "correct here rather than the whole-set rule tags
needed: a column has one prior value" — and warned a reviewer off "fixing" it
into an array. That warning is now backwards: the field is set-valued, so the
tags rule applies to it unchanged and the inversion is what would be the bug.
The paragraph is kept rather than deleted because the branch still carries the
scalar arm until D2's join table lands, and a reviewer reading the code before
the migration should find the reason it is still there.

**Still single until the migration:** `serviceId?: string | null` is what be-01
accepts today, and the two folds D2 names are where it meets the set-shaped
domain.

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

`RowFacets` gains `serviceIds: readonly string[]` and the two booleans, all three
from the **effective** reading. The service predicate is therefore the same
`carriesAnyChosen` line the team and tag facets already use — ticking two
services widens the result — rather than the nought-or-one fold the single-valued
shape needed. `filterWords` gains three labels.

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
- **The delete arm is a write the outgoing release will see.** While the store is
  still a column, a service deleted during a swap nulls `work_item.service_id`, a
  column the outgoing release does not select — so it sees nothing, which is the
  correct outcome and the reason the column is nullable rather than defaulted.
  After D2's join table, the same delete cascades `work_item_service` rows the
  outgoing release also never reads, so the property survives the migration. What
  does **not** survive is the column staying authoritative: the migration leaves
  `work_item.service_id` behind unread, and a delete that stops maintaining it
  while an old process still reads it is the one ordering that would bite. Hence
  D2's rule — drop the column in a **later** migration, not the same one.
- **Two signals is where scope grows.** Counts, a report, a dashboard, blocking
  — all obvious next steps, all deferred by the proposal's non-goals. The risk
  is a build that quietly adds one; the tasks below add none, and the verify
  record lists what was left out.
