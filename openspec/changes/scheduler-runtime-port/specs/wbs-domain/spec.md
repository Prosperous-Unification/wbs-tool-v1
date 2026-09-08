# Sync prerequisite

These MODIFIED requirements follow the still-active `saved-plans` change's
`specs/wbs-domain/spec.md`. Sync that base delta into `openspec/specs/wbs-domain`
first when it is eligible; do not archive or mark that unrelated feature complete
merely to apply this delta. This packet then modifies the exact requirement names
below. All unmodified saved-plan requirements, including quotas, immutability,
independent write admission and access rules, remain authoritative.

## MODIFIED Requirements

### Requirement: A saved plan is a copy of the whole plan, joined to nothing

A saved plan SHALL be a record of one project's plan as it stood at one instant,
written by value. No column of it SHALL reference a live row, and reading one
SHALL NOT read any live table other than the saved plan's own.

It SHALL carry two bodies.

The **plan input** body SHALL hold:

- the project's date-producing settings — `estimate_method`, `dep_reach`,
  `estimate_rounding`, `start_date`, `pert_weight_optimistic`,
  `pert_weight_realistic`, `pert_weight_pessimistic`;
- the project's own metadata — `name`, `restricted`, `owner_id`,
  `solution_slug`, `solution_url`;
- the work-item tree, and per item its id, name, parent, sibling order, type,
  tags, external references, notes, `priority`, `max_parallel`,
  `frozen_number`, `service_team_id`, `service_id`, and
  `start_no_earlier_than` with its reason;
- the steps, and per (work item, step) the three-point estimate, the derived
  number, the actual and the progress;
- the token and hour measures;
- ownership — assignments, teams, services, `work_item_team`,
  `work_item_service`, `person_team` and `team_service`, and **people: every
  assigned person plus every person a captured `person_team` row names**, since
  the live projection reads only assigned people and an unassigned member of a
  captured team would otherwise be a stored id with no name;
- the dependencies, the priority bands and the team capacity;
- **the referenced registry rows, by value** — for every tag id, work-item-type
  id and external-system id the captured items use, that row's id **and name**
  (`tag`, `schema.ts:968-972`; `work_item_type`, `:1063-1067`;
  `external_system`, `:1085-1089`).

The registries are captured because the items store only ids and the registries
are live, renameable and deletable. Without their names a saved plan cannot be
rendered at all without reading a live table — which the first paragraph of this
requirement forbids — and resolving them against the live registry instead
restates history on a rename and loses the label outright on a delete. That is
the same failure the `keep` decision closed for people, and it is closed here for
labels on the same terms.

`frozen_number` is captured because it is the whole freeze mechanism
(`schema.ts:262`, `:282`) and gates live edits; a freeze that a saved plan cannot
see compares as no change. `service_team_id` and `service_id` are captured
because they are live, patchable columns (`schema.ts:376`, `:419`) rather than
derivations of the junction tables. `created_at`, `updated_at` and `created_by`
on the plan's own rows are NOT captured: they are audit metadata about editing,
not the plan. Neither is `work_item.revision` nor `project.revision`
(`schema.ts:215`): they count writes, so two content-identical plans carrying
different counters would diff as changed.

The **schedule** body SHALL hold the complete `Scheduled` and `ScheduledSlice`
field set that the selected scheduling algorithm returned, in working-day offsets, **and** the ISO
dates those offsets were rendered as, **and** the top-level `Schedule` counts
`waitingForPerson` and `waitingForCapacity` (`schedule.ts:246-263`). It SHALL
NOT hold `eventsVisited` (`schedule.ts:264-277`), which counts levelling search
work and is instrumentation about the run, not a fact about the plan.

The stored schedule body SHALL be deep-equal to the selected algorithm's schedule,
field for field except for the excluded instrumentation, so that a field added to
`Scheduled`, `ScheduledSlice` or `Schedule` later cannot be silently dropped by the
writer. The selected-ready optimized schedule SHALL NOT be replaced by Fast.
The ISO-date projection SHALL use the captured project's start date.

Each body SHALL carry its own schema version, its byte length and its SHA-256.
The schedule body SHALL additionally carry the SHA-256 of the plan input it was
computed from and the identity of the scheduling algorithm that produced it.
Fast SHALL retain its existing algorithm identity; optimized output SHALL use
`optimized:<contractVersion>:<objective>:<budgetMs>`, taking every component from
the verified schedule's cache key, with budget in decimal integer milliseconds.
The body and header SHALL carry the same identity. Existing saved records SHALL
remain unchanged.

Access and navigation metadata SHALL NOT be captured — `project_access` and
anything recording who last opened what is not part of the plan.

`created_at` SHALL be the instant the read snapshot was taken, not the instant
the transaction committed: a comparison is labelled with when the plan was
looked at.

#### Scenario: a plan is saved and read back

- **WHEN** a user with write access to a project saves the plan
- **THEN** a record is written holding the plan input body and, when a schedule
  was available, the schedule body, and reading it back returns exactly the bytes
  that were written

#### Scenario: the live plan moves afterwards

- **WHEN** a work item is renamed, another is deleted, a step is deleted and
  `estimate_method` and `start_date` are changed after a save
- **THEN** the saved plan's stored bytes and both SHA-256 values are unchanged

#### Scenario: the command log is gone

- **WHEN** every row of `plan_event` is deleted
- **THEN** every saved plan still reads back in full

#### Scenario: a person leaves the live plan

- **WHEN** a person is deleted from the directory
- **THEN** saved plans written before that deletion still name that person as the
  owner of the work they owned, and no stored body has been rewritten

#### Scenario: the selected optimized schedule is ready

- **GIVEN** enabled optimization, the optimized engine and a selected objective with
  a verified ready schedule for the captured input's exact key
- **WHEN** the plan is saved
- **THEN** its schedule fields equal that optimized schedule rather than Fast, its
  dates use the captured start date, and body and header carry the same truthful
  optimized identity

### Requirement: A saved plan describes a plan that actually existed

Every authored plan-input read SHALL observe one SQLite read snapshot, including
the project's scheduling selection. A saved plan SHALL NOT contain
a mix of authored state from before and after a concurrent write.

The header write and both body writes SHALL be one transaction: on any failure
no header and no body SHALL survive, and the live plan SHALL be unchanged.

A second save of the same project attempted **while the first save's write
transaction is still open** SHALL be refused with a typed outcome, not serialised
behind it. The refusal SHALL be visible across processes, because blue and green
run against one file: an in-process marker is not a mechanism.

The bound is the open transaction, not the caller's whole attempt. A caller
retry that acquires the lock **after** the rival save has committed is a fresh
save of the now-current plan and SHALL be allowed to succeed: it captures a new
read snapshot and writes a record of a plan that did exist at that instant. What
is forbidden is a second save _waiting on_ the first — that is the serialisation
that holds live edits behind two body writes.

Scheduling SHALL use values already detached from that snapshot, never run inside
it, and SHALL hold no capture read transaction. A selected optimized schedule MAY
be read from the verified cache after the capture connection closes, but only at
the full key derived from that detached input, captured project id, configured
contract version and budget, and with the existing generation-validity check.
The lookup SHALL NOT re-read live authored input, allocate a generation, reserve
a solver slot, enqueue work or spawn a solver. A missing matching schedule SHALL
produce the selected engine's typed absent state, never a schedule for different
input.

#### Scenario: an edit lands between two of the capture's reads

- **WHEN** a work-item edit commits between any two reads of a save in progress
- **THEN** the saved plan input describes the project entirely before that edit or
  entirely after it, and never a mixture

#### Scenario: the write fails halfway

- **WHEN** the schedule body write fails after the header and plan input body
  were written
- **THEN** no header, no plan input body and no schedule body exist for that save,
  and the live plan is untouched

#### Scenario: two saves at once

- **WHEN** two saves of the same project are requested concurrently and the
  second attempts to acquire while the first's write transaction is still open
- **THEN** the second returns a typed refusal at that attempt rather than waiting
  for the first, and the first writes its record

#### Scenario: a retry after the rival committed

- **WHEN** a refused save's bounded caller retry acquires the write lock after
  the rival save has already committed
- **THEN** it succeeds as a fresh save over a new read snapshot, and the project
  holds two records, each describing the plan at its own instant

#### Scenario: live input changes after the capture closes

- **GIVEN** a detached capture of input A and a committed live edit to input B
- **WHEN** the save consults optimized output after its capture connection closes
- **THEN** only a verified schedule keyed to A may be recorded, or the record
  carries the typed absent reason; the cache lookup admits no solver work

### Requirement: Stored dates are reported, never recomputed

Reading a saved plan's schedule SHALL return the stored values and SHALL NOT call
any scheduler or consult the live optimizer cache. The saved plan SHALL be labelled with the scheduling algorithm
identity stored in its header.

**Any change to `schedule()`'s semantics SHALL change that identity in the same
commit.** An identity that does not move is a constant, and stored plans then
read "same algorithm" straight across a semantics change — the silent
restatement the column exists to prevent. This rule lives here rather than only
in the implementation plan because `tasks.md` is archived when the change lands
and this requirement is what survives into the main spec; TASK-219's dual
objective and TASK-240's deadline each carry the bump.

A schedule body whose stored plan-input SHA-256 does not equal the plan input
body's SHA-256 SHALL be refused rather than rendered.

A saved plan MAY have no schedule body, and SHALL then record why —
`pending`, `infeasible` or `unavailable`. Save SHALL select the schedule from the
captured project's engine, objective and enabled flag. Fast selection or disabled
optimization SHALL compute Fast with its existing identity. Enabled optimized
selection SHALL record the selected verified ready schedule when available;
selected idle, pending or retrying SHALL record `pending`; selected failed or
corrupt SHALL record `unavailable`; a selected plan-infeasible outcome SHALL
record `infeasible`. An enabled selected optimized engine with no installed
adapter SHALL record `unavailable`, never silently use Fast. An empty optimized
plan with no ready output SHALL remain `pending`, not invent an optimized result.

A plan whose dependencies form a cycle SHALL be saved with the reason
`infeasible`: this is a property of the scheduling attempt, captured as the absent
reason and never a field of the plan input. Input history SHALL still be saved
when scheduling is absent, subject to the unchanged write-access, atomicity,
contention and quota rules. A comparison SHALL report the absence for **that
saved side**, and SHALL NOT substitute the live schedule for it. `current` has
its own independent schedule selection under the comparison requirement below.

#### Scenario: an older algorithm's numbers

- **WHEN** a saved plan recorded under an earlier scheduling algorithm is read
- **THEN** the stored dates and offsets are returned unchanged, labelled with that
  algorithm's identity, with no call into `schedule()`

#### Scenario: a schedule that does not match its input

- **WHEN** a schedule body's stored plan-input SHA-256 does not equal the plan
  input body's SHA-256
- **THEN** the read refuses to render that schedule and says so

#### Scenario: saved while optimization was pending

- **WHEN** a plan is saved while no schedule is available
- **THEN** the record has no schedule body, carries the reason, and a comparison
  against it reports that no schedule was saved **for that side** and does not
  substitute live dates **for that side** — the other side, including `current`,
  still carries its independently selected schedule and identity, or its own
  explicit absent reason

#### Scenario: a selected optimized engine has no adapter

- **WHEN** an enabled optimized project is saved in a runtime without that engine
- **THEN** the input history is saved with schedule reason `unavailable`, no Fast
  schedule body is written, and normal quota and write refusals still apply

#### Scenario: a pending selected variant does not borrow the other variant

- **GIVEN** enabled optimized selection of a pending objective and a ready other objective
- **WHEN** the plan is saved
- **THEN** the saved schedule reason is `pending`, no Fast or other-objective dates
  are substituted, and the save admits no solver work

### Requirement: A comparison is one diff over two sides, either of which may be the live plan

The comparison API SHALL take two sides. Each side SHALL be either a saved plan
id or the literal `current`. There SHALL NOT be a separate compare-to-live
endpoint.

`current` SHALL be produced by projecting the live plan through the same
canonical function the save uses, in memory. It SHALL NOT write a record and
SHALL NOT count against any quota.

**Any field of the canonical plan input that differs between the two sides SHALL
appear in the comparison.** The coverage bound is `CanonicalPlanInput`'s field
list, not a list written here: a field the capture stores and the diff cannot
report is data the product writes and never shows, which is the same silent-loss
failure the capture list exists to prevent.

The category names below are **presentation, not coverage** — how differences are
grouped for a reader, in the same way requirement "the stored schedule is
deep-equal to the selected algorithm's return" makes the writer's bound the value rather
than an enumeration. A comparison groups differences as added, removed, renamed,
reparented and reordered work items, and changed estimates, uncertainty, actuals,
progress, measures, ownership, dependencies, settings, dates, freeze — an item
whose `frozen_number` was set, cleared or changed between the two sides — type,
tags, external references, notes, `priority`, `max_parallel`, service assignment
(`service_team_id`, `service_id`), `start_no_earlier_than` and its reason,
priority bands, team capacity, and the registry rows a label resolves through. A
differing field with no listed category SHALL still be reported, under a
catch-all group naming the field.

**The schedule side is covered on the same terms and is normative, not
presentational.** The schedule body is not a field of the canonical plan input,
so the rule above does not reach it. A comparison SHALL report any difference
between the two sides' stored schedules — the ISO dates, the working-day
offsets, the whole `Scheduled`/`ScheduledSlice` field set, the top-level counts,
the presence or absence of a schedule with its reason, and the
`scheduler_algorithm_id` — bounded by the stored schedule field set rather than
by a list written here. Without this a change to `schedule()`'s semantics, which
is exactly what `scheduler_algorithm_id` exists to record, moves every date
between two saves whose inputs are byte-identical while the comparison reports
no change: the feature's motivating question answered wrongly.

**`current` has an independently selected schedule or a justified absent reason.**
The paragraph above bounds each side by its _stored_ schedule and `current`
stores nothing, so this requirement states what the live side carries. `current`
SHALL apply the same engine/objective/enabled selection and closed absent-reason
policy as save, over the same detached authored input. Scheduling and the
non-admitting optimized cache lookup SHALL happen only after that input capture
closes. A present schedule SHALL carry the identity of the algorithm that
actually produced it, not an identity borrowed from either saved side.

A dependency cycle SHALL yield `infeasible`; an unavailable selected optimized
adapter or selected failed/corrupt variant SHALL yield `unavailable`; selected
idle/pending/retrying SHALL yield `pending`; selected plan-infeasible SHALL yield
`infeasible`. `current` SHALL NOT be given `unavailable` merely because it has no
stored body. Fast selection and disabled optimization still carry computed Fast
dates unless the domain reports a cycle. The comparison SHALL report a genuine
selected-engine absence for the current side and SHALL NOT hide it by borrowing
Fast or another objective's dates.

#### Scenario: a saved plan against the live plan's dates

- **WHEN** a saved plan is compared against `current`, their canonical plan
  inputs are equal, a current selected schedule is available, and that schedule
  differs from the stored one
- **THEN** the comparison reports the date and offset differences and the two
  algorithm identities, and does not report `current` as having no schedule

#### Scenario: the dates moved but the input did not

- **WHEN** two saved plans of one project hold byte-identical plan input bodies
  and schedule bodies that differ, because the scheduling algorithm changed
  between them and their `scheduler_algorithm_id` values differ with it
- **THEN** the comparison reports the changed dates and offsets and the changed
  algorithm identity, and does not report the plan as unchanged

#### Scenario: a captured field the category list does not name

- **WHEN** two sides differ in exactly one field of the canonical plan input
- **THEN** the comparison is non-empty and names that field, whichever field it is

A body written at schema version _n_ SHALL still be readable after the reader
moves to _n+1_, by normalising forward in memory. Stored bytes SHALL NOT be
rewritten. An unrecognised body version SHALL fail loudly rather than be parsed.

#### Scenario: two saved plans

- **WHEN** two saved plans of one project are compared
- **THEN** the differences between them are reported by the same diff that serves
  a comparison against `current`

#### Scenario: a saved plan against the live plan

- **WHEN** a saved plan is compared against `current`
- **THEN** no record is written, no quota is consumed, and the live side has been
  projected through the same canonical function as the stored side

#### Scenario: an older body version

- **WHEN** a body stored at schema version _n_ is diffed after the reader moved to
  _n+1_
- **THEN** it is normalised forward in memory for the diff and its stored bytes are
  unchanged

#### Scenario: a body from the future

- **WHEN** a body carries a schema version the reader does not recognise
- **THEN** the read fails with a typed error naming the version, and nothing is
  parsed optimistically

#### Scenario: current has a genuinely pending selected schedule

- **GIVEN** a saved side with recorded dates and current enabled optimized selection
  whose selected objective is pending
- **WHEN** the saved side is compared against `current`
- **THEN** the saved dates remain unchanged, current carries `pending`, the
  comparison reports that side's absence, and no record or solver work is created

#### Scenario: Fast current remains available without an optimized adapter

- **WHEN** a saved side is compared against a current project selecting Fast, or
  with optimization disabled, in a runtime without an optimized adapter
- **THEN** current carries computed Fast dates and their existing identity rather
  than an absent reason merely because it has no saved body
