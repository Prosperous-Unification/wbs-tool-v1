# design — `resource-model`

The written source is `notes/wbs-brief-2026-08-13-r2-team-service.md` (revision
of 2026-08-13, §10 holding Dany's answers verbatim) and
`notes/wbs-scope-2026-08-13-wave6.md` §R2. This change is the brief's **R2-1**.

**D1 and D2 are decisions to _not_ write code**, and an absence is exactly what a
later reader mistakes for an unfinished job. Neither moves a line of R2-1; both
are answers Dany gave on **2026-08-14 09:00**, recorded in §10 of the brief.

**D3 onward are this implementation's own calls** — the places the brief left
something open, or where the code departs from it. Much of the rest of the
rationale is in the migration's and the schema's own comments, where the reader
who could get it wrong is standing.

## D1 — `service` and `work_item_service` ship empty by decision, and the conversion is a later, per-row, user action

Q6 asked whether anything seeds the service list. The brief recommended "start
empty, and a user who has been using the team field as a product area retypes
it". Dany's answer was **"convert existing"** — against that recommendation.

**It does not change this migration.** What he bought is the alternative §8
priced, not a migration seed: a **per-row, opt-in "convert this team to a
service" action in the directory**, one row at a time, him choosing which. It
lands in R2-4/R2-5, about half a day. R2-1 writes no row into either table, the
same as if the recommendation had been taken.

Where the brief would have refused the action for a team holding capacity or
members, follow the delete precedent instead (services delete behind a confirm,
2026-08-14 07:53): **allow it behind a modal** that states what is lost — the
pool, the members, and that dates will move. The difference from the delete
modal is that this one is a warning rather than informational, because dates do
in fact move.

**A blanket conversion of every `service_team` row is refused and stays
refused.** Nothing in the data distinguishes a row somebody typed meaning
"Payments" from one typed meaning "Platform". Converting the wrong one takes the
pool away from every work item that named it and moves dates nobody typed — on
the day of a deploy, with no screen showing why.

**For whoever reads the migration next:** the two empty tables are not a seed
somebody forgot. Do not add an `INSERT` into them, here or in a later migration.
`migrate.test.ts` — `seeds no service at all, and touches neither capacity nor
membership` — asserts both come out of this migration empty, so the absence is
checked rather than assumed.

## D2 — no filtering or grouping by service in wave 6, and no seam for one

Q8 asked whether R2 includes filtering and grouping. Answer: **no**. R2 stores
the service, shows it, and exports it. That is all.

Filtering became **its own project, R10**: filter the table by several fields at
once, and the Gantt shows only what matches. Grouping the Gantt by service is
not in R2 either.

So this is an explicit non-goal, and it is a non-goal about _preparation_ as much
as about features. Not in this change and not in R2: a `?service=` query
parameter, a filter predicate threaded through the read model, a `groupBy`
argument on the chart, or an unused prop kept "for later".

**Why not leave a seam.** Two reasons, and the second is the load-bearing one.
A half-built seam reads as a promise the code does not keep — the same objection
the migration raises against a nullable `project_id` on `service`. And R10 filters
by _several_ fields, not by service alone; a seam cut for one field is the wrong
shape for the change that arrives, so building it now buys a rewrite rather than
a head start.

What R10 actually needs from R2 is already true, without a seam: `serviceIds` is
on every read-model row, from `work-item.service.ts` through `wbs-api.ts`.

## D3 — the service tables land here, with the teams, and stay empty

The brief's §6 puts `service` and `work_item_service` in **R2-5**, with R2-1 as
`team-sets` alone. This change ships all three tables and both dimensions of the
read model, and nothing else of the service half — no route, no picker, no export
column, no way at all to create a service.

Why: the two dimensions share one walk and one payload shape. Splitting them
means `effectiveSetOf` is written against an accessor here and gets its second
caller three changes later, `NumberedWorkItem` gains one array now and a second
one later, and every deployed client learns the payload twice. The brief's own
ordering argument (§6) is about _readers learning a shape before writers produce
it_, and it does not bind the service dimension at all — a service cannot move a
date, so a client that ignores `serviceIds` shows one label fewer and nothing
else.

What it costs: three tables with no writer, which reads as a promise the code
does not keep. Bounded by making the absence explicit rather than implied —
`service`'s JSDoc names the change that fills it, `migrate.test.ts` asserts both
tables come out of the migration empty, and `NumberedWorkItem.serviceIds` says
"always empty in this release" on the field itself. D1 above is the other half of
the same discipline.

_Refused:_ teams-only, as the brief scoped it. It is the smaller diff and the
larger total: the same six readers get touched twice.

## D4 — the sets are two maps off the repository, not fields on `WorkItem`

`WorkItemStore.resourceSetsOf(projectId)` answers `{teamIdsOf, serviceIdsOf}`,
and `WorkItem` — the row every write path hands to the database — is unchanged.

The alternative is `WorkItem.teamIds`, which is what R2-4 will want: a client that
sends a set needs a write shape that carries one. It is refused **here** because
the sets are not columns of that row. They are rows of two other tables, written
in the same transaction and read back by their own statement, and putting them on
the row type would make every construction of a work item state a set it has
nothing to say about — 130-odd sites across the suites, in a change whose whole
claim is that nothing moves. The seam is `mirrorTeam`, one function, and R2-4
rewrites that function around the client's set.

The **read** model does carry them: `NumberedWorkItem` gains `teamIds` and
`serviceIds`, because a reader genuinely is answered about a work item and its
labels at once.

## D5 — the wire carries each row's own set, never the resolved one

`teamIds` on the payload is what the row itself states, exactly as
`serviceTeamId` beside it has always been, and every consumer resolves
inheritance with `effectiveSetOf`.

Sending the resolved set would be a second copy of the inheritance rule on the
wire — the copy capacity-engine D5 put the function in `libs/domain` to prevent —
and it would take the cell's sentence away: "Platform — inherited from 010
Backend" needs the row the label was written on, which a resolved set has already
thrown away.

## D6 — one walk, taken through an accessor

`effectiveSetOf(rows, membersOf)` rather than `effectiveTeamsOf(rows)` and
`effectiveServicesOf(rows)` side by side, and rather than one walk answering
about both dimensions at once.

Two implementations of "most-specific wins" is two chances to disagree, which is
the whole reason the rule was extracted in the first place. One walk answering
about both is worse: it has to decide what a row that states teams and not
services inherits, and every answer to that is a rule nobody asked for. Q4
(2026-08-13) says the dimensions resolve independently, so the walk runs twice
over the same rows with two accessors, which is what "independently" means in
code.

The accessor also keeps the call sites honest about which dimension they are
reading: `effectiveSetOf(rows, (row) => row.teamIds)` names it at the point of
use, where a wrapper would hide it behind a name that is right until somebody
copies the line.

## D7 — the narrowing throws, and it is one function

Every remaining single-valued reader — the scheduler's adapter, the table's cell,
the export's Team column, the Teams dialog's per-row team — goes through
`soleMemberOf(memberIds, at)`, which answers null for none, the member for one,
and **throws** for two.

`[0]` is the failure this change exists to make impossible. It compiles
everywhere, it is right in every test, and it is wrong exactly once — on the day
a release that writes several teams talks to a reader from this one, at which
point a plan is bounded by whichever pool sorted first, with nothing on screen or
in a log to say so. capacity-engine D5 predicted precisely this ("if the new
function still answers `.teamId` for 'the first team', every one of the six
readers keeps compiling and silently drops teams"), which is also why
`effectiveTeamOf` is **deleted** rather than kept beside the new one: every call
site had to be a compile error.

In fe-01 the throw reaches the error boundary, which is the house rule for an
impossible union state and the same shape C1 used when `boundBy: 'capacity'`
landed ahead of the words for it.

_Refused:_ answering the first member and logging. A log nobody reads is the
silent wrong answer with paperwork.

## D8 — the dual write is one function, inside the repository's transactions

`work_item.service_team_id` is still written, and `mirrorTeam` puts the same fact
in `work_item_team` in the same transaction — on insert, on a patch that names
the label, and on every row of a subtree copy. A patch that does not name the
label does not touch the set.

Both spellings exist because blue and green share one SQLite file: the outgoing
release selects the column on every tree read, and this release reads the join.
Two spellings maintained in two places drift, and the drift shows up as a plan
whose labels depend on which release last touched the row — so there is one
function, in the layer that owns the transaction.

Direction matters and is temporary: today the column is the writer's spelling and
the join is derived from it, which is exactly what caps the set at one. R2-4
reverses it and R2-6 deletes the column.

## D9 — the identity differential becomes field-by-field, with the keys read off the capture

C5 compared `tree()` whole, and could: its payload gained one key. This change
adds two keys to **every work item**, so a blanket `toEqual(oracle)` fails for the
right reason on all 151 rows — and then gets relaxed into `toMatchObject`, or into
a hand-listed subset that quietly stops covering the field somebody adds next.

So the comparison iterates the keys **the captured document holds**, work items
included, and asserts the two new keys separately: `teamIds` equals the singleton
the captured `serviceTeamId` derives, and `serviceIds` is empty. A capture that
gains a key is compared on it without this file being edited, and a field the
change stops sending fails on `undefined`.

The brief (§3, Claim B) calls for exactly this and gives the reason. The oracle
itself is **not** recaptured — a capture against this branch would measure the new
code against itself, which its own header says.

## D10 — the service no-op differential runs against real SQLite

The claim that a service moves no date has a structural half — `slicesOf` is never
handed the service sets, so no service id has a path into `schedule()` — and a
differential half: the same plan read twice, the second time with every row
carrying two services, compared field by field.

Nothing in this release writes a service, so the differential has to write the
rows the way R2-5's routes will, against a migrated database. An in-memory store
told to answer with services would be a fixture asserting its own arrangement,
and would not exercise `resourceSetsOf`'s service statement at all.

The plan under it is deliberately one a pool binds — three leaves, two slots, a
capacity floor asserted before the differential runs — because a differential over
an uncontended plan is green against an engine that lost the pool entirely.

## D11 — the foreign key on `work_item.service_team_id` is recorded, not fixed

Found while writing the blue/green case: `schema.ts` says the column has no
foreign key and two JSDoc comments say so at length, and the **deployed column has
one** — `20260806190000_add_teams_and_assignees` writes `REFERENCES
service_team(id)` with no `ON DELETE`, so a team that still labels work cannot be
deleted at all. `DirectoryRepository.removeTeam` nulls the column inside the
transaction that deletes the team, which is why every path works and why nothing
noticed.

Measured against a migrated database rather than read off a file: the bare
`DELETE FROM service_team` fails with `FOREIGN KEY constraint failed` with no
other rows present at all.

Not fixed here. Reconciling drizzle's definition with the database is a migration
of its own — SQLite cannot add or drop a foreign key without rewriting the table —
and this change's claim is that nothing observable moves. The column's JSDoc now
states what is actually deployed, the migration test nulls first and says why, and
verify.md carries it as a finding for whoever schedules R2-6, which is the change
that drops the column and would otherwise inherit the surprise.
