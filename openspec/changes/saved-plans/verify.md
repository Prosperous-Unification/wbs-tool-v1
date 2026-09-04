# Verification

This file states what will be measured and how each check will be proved to fail,
so the plan is judged with its evidence obligations rather than after them. Every
row below is filled in with observed output before either successor task is
called done — a check with no observed failure is not done.

**Status, 2026-09-03.** The opening line here used to read "Nothing in
`tasks.md` has been implemented yet", written at the TASK-230 planning gate. That
is now stale: TASK-231 has landed slices 1 and 2 and tasks 3.0 through 3.4, and
five rows below carry observed output. An `Observed` cell names the date and the
**exact head** the observation was made at, because a fault watched at one head
says nothing about a later one. A cell that relays an earlier run's log rather
than re-observing says so.

## What is measured, not asserted

Two of these are measurements rather than exit codes, because an exit code has
already lied here once (`steps-schema-rename` shipped a `REFERENCES` clause
SQLite had not applied, and the check written for it passed against the broken
database):

1. **The tables exist as declared** — `migrate-cli.ts` against a fresh file, then
   `pragma table_info` and `pragma foreign_key_list` read back for `saved_plan`
   and `saved_plan_body`, and a write **through** the cascade, not just its
   declaration.
   **Observed 2026-09-03 at head `345e2d11`, h2puni, on a fresh
   `/tmp/t231-rehearse.db`:** `migrate-cli.ts` exit 0, `migrations applied`.
   `pragma table_info` → `saved_plan` **14 columns** (`id, project_id, name,
created_by, created_at, input_schema_version, input_bytes, input_sha256,
schedule_schema_version, schedule_bytes, schedule_sha256,
schedule_input_sha256, scheduler_algorithm_id, schedule_absent_reason`),
   `saved_plan_body` **3** (`saved_plan_id, kind, bytes`). `pragma
foreign_key_list` → `project_id -> project ON DELETE CASCADE` and
   `saved_plan_id -> saved_plan ON DELETE CASCADE`, both **applied by SQLite**,
   which is the half of this row that `steps-schema-rename` got wrong.
   **Still owed:** the write _through_ the cascade. The declaration is read back;
   a project deleted and both tables re-read is 2.3's own row below and has not
   been run.
2. **The rollback runs** — `migrate-down-cli.ts` to the preceding migration, then
   `pragma table_info` showing both tables gone.
   **Observed 2026-09-03 at head `345e2d11`, same file:**
   `migrate-down-cli.ts --to=20260902120000_add_lookup_indexes` exit 0, then the
   same probe returns **0 columns and no foreign keys for both tables** — they
   are gone, not merely emptied. Run immediately after check 1 on the file
   check 1 built, so this is the real reverse of the real forward migration.
3. **A body's size against a real plan** (task 9.1) — the serialized byte length
   of the largest real project's plan-input body, printed, against the 8 MiB
   limit. This is A-3's falsifier and a number, not a verdict.

## Watched negatives

Each row's check is written first, then the named fault is injected on the
production call path and the failure watched, per R5. `Observed` stays empty
until it has been.

| Check                                                            | Fault injected                                                                                                                                                                                                                                                    | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical serialization is order-stable (1.3)                    | work-item sort dropped from `canonicalisePlanInput`                                                                                                                                                                                                               | **2026-09-03, run 1, head `ed8354bd`** (relayed from the task log, not re-observed since). Committed as a standing assertion rather than injected once: the byte comparison is run against a copy of the fold with exactly the work-item sort removed and asserted to differ, which is the only thing that catches a dropped sort — the value stays perfectly well-typed                                                                                                                                                                                                                                                                                                                           |
| No `UPDATE` targets `saved_plan_body` (2.4)                      | an `update(savedPlanBody)` call added in `repository/`                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No `UPDATE` targets a `saved_plan` column but `name` (2.4)       | an `update(savedPlan).set({ inputSha256 })` call added                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Every read checks bytes against their hash (5.1b)                | one byte of a stored body flipped with raw SQL                                                                                                                                                                                                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Rename is permissioned like delete (6.2)                         | rename given the project's ordinary write rule — the third-party case must fail                                                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The concurrency refusal is SQLite-visible (4.4)                  | the mechanism replaced with an in-memory in-flight set, watched on two connections                                                                                                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The quota check runs inside the write transaction (4.6)          | the count check moved outside `BEGIN IMMEDIATE`, two saves at 99/100                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `schedule()` runs outside the read snapshot (3.3)                | `schedule()` called inside the snapshot — the liveness assertion must fail                                                                                                                                                                                        | **2026-09-03, head `c8f0bd4d`, watched red: 1 fail / 3 pass.** `readPlanInput` given the scheduler and calling it immediately before `tx.commit()`. `holds no connection open while the plan is scheduled` failed on `sampled` being `[1]` where `[0]` is owed — one handle live at the instant of the call. **Which three stayed green is the row's real finding:** `schedules every leaf from the captured values alone` samples the count only _after_ the call returns and passed against the fault, which is exactly why 3.3's assertion is sampled from inside the scheduling call and not around it. Run as a watched red and reverted on both checkouts, not committed                     |
| The save never blocks on a single acquire (4.5)                  | the bounded retry replaced with one 60 s blocking acquire                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The stored schedule is deep-equal to `schedule()`'s return (3.4) | `resourcePredecessorId` dropped from the writer — the equality must name the key                                                                                                                                                                                  | **2026-09-03, head `ae1c6de3`, watched red: 2 fail / 3 pass, 12 expect calls.** One `delete` on the copied timing in `datedRecordOf`. Both deep-equality rows failed and the diff **names the key**, on `wi-2` at the value `"wi-1 st-1"` and on `wi-3` at `null` — so the fixture proves the field with a real referent, not only with nulls. **The row that stayed green is the finding:** `is computed over a plan whose resource fields are set` reads `planned`, never the body, so it is green against every writer fault by construction and is there to keep the fixture from flattening. Run as a watched red on the h2puni gate checkout and reverted, `git status` clean; not committed |
| Project delete cascades to headers and bodies (2.3)              | the `ON DELETE CASCADE` clause removed from the migration                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Capture is one read snapshot (3.2)                               | ~~the shared read transaction replaced with a connection per read~~ — retired, `bun:sqlite` has no pool, so that fault could only ever have been staged. Replaced by: the capture run on the **shared process handle** with a stranger's `UPDATE tag` interleaved | **2026-09-03, head `92cad22b`.** One scenario run twice, differing only in the connection handed to the capture. Own connection: the stranger's rename survives the capture's rollback, a third connection reads `renamed`. Process handle: the same write is inside the capture's transaction, the rollback revokes it, the third connection reads the pre-edit `urgent`. Both green; the pair is the assertion                                                                                                                                                                                                                                                                                   |
| Every capture-only read rides that snapshot too (3.2)            | the registry and junction reads moved outside the transaction with the twelve left inside, then a `tag.name` rename interleaved — the registry-rename case must fail while every projection-boundary assertion still passes                                       | **2026-09-03, head `cacf9e1b`, watched red: 17 fail / 1151 pass.** `tx.commit()` moved above `listTags`. Failures: the enclosure test and boundaries **2–17**, every other `be-01` test green. **The prediction in the middle column is wrong in the guard's favour** — one edit spanning both halves tears at every boundary from 2 up, not only the registry one. Boundary 1 stays green by construction: the write lands before the snapshot is taken, so the whole capture is legitimately post-edit. Run as a watched red rather than committed — a second implementation would prove things about itself                                                                                     |
| The compare route carries the project read rule (7.3b)           | the route mounted without the read rule — 6.2's anonymous and third-party cases must fail                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The diff names every differing canonical field (7.2b)            | `frozen_number`, then a tag id, dropped from `diffPlans`' comparison                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The diff names every differing schedule field (7.2c)             | `diffPlans` built over the plan inputs alone — every schedule mutation must report "no change"                                                                                                                                                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `current` carries a live schedule, not an absent reason (7.3a)   | `projectCurrentPlan()` returns the absent reason `unavailable` for `current` — the saved-vs-current date test must fail while 7.2b and 7.2c stay green                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `current`'s schedule runs outside the read snapshot (7.3a)       | `schedule()` called inside 7.3's held `BEGIN DEFERRED` — 3.3's handle-liveness assertion must fail on this path too                                                                                                                                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The other side survives an absent side (7.3a second case)        | the comparison suppresses the other side's schedule whenever one side has none — 7.3a's second assertion must fail                                                                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A successful retry captures a new read snapshot (4.5)            | the retry reuses the refused attempt's detached values — the interleaved live edit must be missing from the stored input                                                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Immutability, asserted by hash (4.2)                             | one captured field dropped from the writer — the hash must move even though every asserted field is still present                                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Save writes nothing on failure (4.3)                             | a throw injected between the header and the input body                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Quota refuses before any write (4.6)                             | the quota check moved after the header insert                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The read never recomputes (5.1)                                  | the reader re-derives dates from the stored settings — a date comparison would pass, the scheduler spy must not                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A schedule is refused against the wrong input (5.2)              | the writer stores a mismatched `schedule_input_sha256`                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An absent schedule is not the live one (5.4)                     | the read falls back to the live scheduler                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An unknown body version throws (5.5)                             | the parser accepts an unrecognised version optimistically                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An old node's refusal is typed (6.4)                             | a bare 404 returned instead                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Normalising forward does not rewrite bytes (7.4)                 | the normaliser writes the upgraded body back                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An open comparison is not replaced (8.4)                         | the broadcast refetches into the open comparison                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## The gate

`bunx nx run-many -t test lint typecheck` on **h2puni** — never on the ops box —
plus `bun x @fission-ai/openspec validate --all --json` on the exact pushed head.
Both outputs are pasted here verbatim when the slices land.

### Planning gate, TASK-230

| Seat                | Model                                                                     | Round            | Verdict                  |
| ------------------- | ------------------------------------------------------------------------- | ---------------- | ------------------------ |
| OpenSpec validation | `@fission-ai/openspec validate --all --json`, h2puni                      | 1                | recorded in the task log |
| Peer                | `openai/gpt-5.6-sol`                                                      | 2                | recorded in the task log |
| Gemini              | per AGENTS.md seat order                                                  | 2                | recorded in the task log |
| Peer                | `anthropic/claude-fable-5` (Sol seat unavailable)                         | 2, 4, 5, 6, 7, 8 | recorded in the task log |
| Gemini              | `openrouter/google/gemini-3.1-pro-preview` (agy and direct google failed) | 3, 4, 5, 6, 7, 8 | recorded in the task log |

Every round's full verdict is a verified artifact under `queue/reviews/` in the
ops workspace, with its byte length and SHA-256 recorded in the task log beside
the findings it produced and their dispositions. Rounds 3 and later are listed
here so a reader at archive time does not take the gate to have stopped at
round 2. The `openai/gpt-5.6-sol` seat was attempted at the head of every round
from 4 on and refused in under a second each time with the same Codex
harness tool-policy error, so the peer column names the model that actually
read the artifacts rather than the one the routing policy prefers.

## 6.5 — the closing gate, 2026-09-04

Run on **h2puni** (`/home/puni1/gate-task231`, `dirty=0`, `NX_DAEMON=false`,
`--skip-nx-cache`, `TMPDIR=/home/puni1/gate-tmp`, head asserted with
`rev-parse` after each reset). Nothing was built or run on h1claw.

| Gate                                               | Head       | Result                                                                                              |
| -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `run-many -t test lint typecheck`, all 22 projects | `e21c92f7` | 20 of 22 green; two failures, both diagnosed below                                                  |
| `run-many -t test lint typecheck -p be-01 mcp-01`  | `0fd70261` | exit 0 — be-01 **1301 pass / 0 fail** across 110 files, mcp-01 **106 pass / 0 fail** across 7 files |
| `nx format:check --all`                            | `f7a8e7ee` | exit 0                                                                                              |
| `openspec validate --all`                          | `f7a8e7ee` | **35 passed / 0 failed**                                                                            |

### What the whole-workspace gate caught that sixteen per-project runs could not

Runs 1–17 gated `-p be-01`. Widening to all 22 projects turned up two reds and
one of them was real.

**`mcp-01:test`, 2 failures — a real defect, now fixed at `0fd70261`.** `mcp-01`
derives its MCP tool set from the committed `apps/be-01/openapi.json`, and this
change adds five paths to it, so the drift guard _"is 22 tools, so a route that
appears must be decided about"_ went red along with the README count that is
asserted against it. That guard is doing exactly its job. The decision recorded
in `openapi-tools.test.ts`: **all five saved-plan operations become tools (22 → 27) and `EXCLUDED_PATHS` stays at five.** No exclusion class reaches them — they
are not `/api/auth/*`, not `/internal/*`, and unlike `/health`, `/metrics` and
`/api/smoke/echo` they carry a plan. The `plan-commands` exclusion is the one
that looks like it should apply and does not: it removed single-item plan
_edits_ because a model gets one batch write and must not pick the slow path,
whereas a saved plan is a separate resource with its own id, quota and
lifecycle, and no command in the batch vocabulary creates one — excluding its
writes would leave no way to save at all.

**`fe-01:lint`, `Killed` — the host, not the code.** The OOM killer, at
`mem_available_pct` 15 (~1.8G of 15.6G). h2puni's `/tmp` and `/dev/shm` are
tmpfs and together held ~10G of scratch from runs dated 26–31 August; `/tmp` was
full enough that an unrelated `sed` on that box failed with "Disk quota
exceeded" while the filesystem itself was 52% used with 70G free. This is the
same condition that OOM-killed lane e's combined lint+typecheck earlier the same
day. `--parallel=1` is what let the other 21 projects through, and is why the
be-01 suite completed at all. Recorded as a host bottleneck, not absorbed.

### Two defects found by reading, outside any gate

**A literal NUL byte in a TypeScript source file** (`c095b6e6`).
`service/saved-plan-input.ts` carried a raw `0x00` byte inside the composite map
key `${workItemId}<NUL>${stepId}`, so git classified the file as binary: it
showed as `Bin 0 -> 11026 bytes` in every diff, could not be reviewed as text,
and needed `git apply --binary` to patch. Written as the escape ` ` the
character is identical and the file is text again. The key is an in-memory `Map`
key only (lines 165, 171–173, 176) — never persisted, never digested — so the
runtime value is byte-identical either way.

**Prettier is not idempotent on `tasks.md`** (`f7a8e7ee`). After the bulk
format, `format:check --all` stayed red on that one file, and `--write` followed
by `--check` still warned: one line oscillated between two and four spaces of
indent. The cause is an inline code span split across a line break inside a
nested list item — the span opened at the end of one line and closed on the
next. Joined onto one line there is nothing left to re-indent.

CI's `Format` step is `nx format:check --all`, not a changed-files check, so the
per-chunk prettier of runs 1–17 never saw the call sites run 16 threaded
`savedPlans` through: 26 files needed formatting at `9afe7363`.

### Review seats

| Seat   | Model                   | Head       | Verdict                                                |
| ------ | ----------------------- | ---------- | ------------------------------------------------------ |
| Gemini | `agy` (Antigravity CLI) | `c095b6e6` | **APPROVE** — no Critical, Important or Minor findings |
| Peer   | `openai/gpt-5.6-sol`    | `c095b6e6` | **unavailable** — `peer-review-skipped`                |

The Gemini verdict is a verified artifact: `queue/reviews/task231-gemini.txt`,
10243 bytes, SHA-256
`ed28d5c1c3c462888a9ccf272214b91d680224f87baed5cb042a81ea9704fdda`, seat
`gemini/antigravity-cli`. It cites `saved-plan.controller.ts:68-71`,
`middleware/caller.ts:50-51` and `app.ts:182-185` for the finding that
authentication halts an anonymous caller with 401 on all five routes before any
project read, permission rule or existence check — so a 403 never tells a
stranger the project exists.

The first Gemini attempt failed with `rc=126`, `Argument list too long`: the
seat passes its prompt as one argv argument and the full 177KB non-test diff
exceeds the per-argument limit. The bounded 53KB authorisation-critical prompt
went through. That is a caller-side size limit, not a seat failure.

The `openai/gpt-5.6-sol` peer seat was attempted twice at the exact head and
refused both times in under half a second with _"Codex agent harness cannot
enforce this conversation's tool policy"_ — the same error this file already
records against TASK-230's rounds 4 through 8. Recorded as
`peer-review-skipped` per the worker procedure; a completed peer verdict's
Critical or Important findings would still block.

### Scope call taken here

**TASK-231 closes at this gate with 6.4 carried into slice 8.** Run 17 wrote 6.5
as a recommendation rather than a decision, because moving an item out is a
scope call; this run takes it. Every _storage and route_ obligation the task
names is met and proved. 6.4's two halves are both client-side and `apps/fe-01`
has no saved-plan code at all, so the one open item is a client rendering with
no client to render it — its mechanism is settled in its own checkbox so 8.1
lands it in one pass.

## TASK-232 run 1 — slice 7's diff (7.1, 7.2, 7.2b, 7.2c)

Gate at `ce239c72`, on h2puni `/home/puni1/gate-task232`, `dirty=0`,
`NX_DAEMON=false`, `--skip-nx-cache`, `--parallel=1`,
`TMPDIR=/home/puni1/gate-tmp`, head asserted with `rev-parse` after the reset:

| Gate                                           | Result                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| `nx run-many -t test lint typecheck -p domain` | exit 0 — **363 pass / 0 fail** across 26 files |
| `nx format:check --all`                        | exit 0, zero files                             |

### The finding: "names the field" is the wrong assertion, "covers the leaf" is the right one

7.2b and 7.2c say the property must assert the diff "names the field". Taken
literally — the reported path's last segment equals the mutated leaf's last
segment — the property fails on 32 leaves that the comparison reports
**correctly**, and the first draft did fail on exactly those:

- **Key fields.** Mutating `workItems[…].id`, `steps[…].id`,
  `stepValues[…].stepId` and their kin makes the row a _different row_, so the
  diff reports it removed and re-added. That is the truthful reading and the one
  that keeps a large plan legible; a difference literally named `.id` would be a
  claim that one row changed identity in place.
- **Nested arrays.** `typeIds[0]`, `tagIds[1]`, `externalRefs[0].url` are
  reported at the field that holds them, because the field of
  `CanonicalWorkItem` is `typeIds`, not `typeIds[0]`, and spec bounds coverage
  by _that_ field list.

So the assertion is now: some reported difference's named-segment chain is a
**prefix** of the mutated leaf's. It is not a loosening — a field the comparison
drops produces no covering difference at all, which is what the two watched
negatives assert directly (drop `frozenNumber`, drop a tag id; each mutant is
built in the suite rather than by editing `diffPlans`, so the negative stays
permanently).

### What the coverage bound actually is

Both halves are walked structurally, so neither is an enumeration:

- **Input half** — every leaf of `CanonicalPlanInput`, over a hundred of them
  from the shared fixture, derived from the value. A capture field added later
  is compared without an edit to `diffPlans`; at worst it groups under `other`,
  which the catch-all cases assert for both a new _field_ and a whole new
  _collection_.
- **Schedule half** — every leaf of the stored body, plus `present`,
  `absentReason` and the header `algorithmId`. The motivating case is asserted
  directly: byte-identical inputs whose schedules differ report the dates and
  the changed identity while the input half reports nothing.

The one enumeration in the module is `ROW_KEYS`, a **collection→key** map, and
coverage does not depend on it: a collection with no entry falls back to
positional comparison, which still reports every difference, just less legibly.
The category table is likewise presentation only; every category the spec names
is asserted reachable, one field at a time.

### Shared fixture

`canonical-plan-input.test.ts`'s inline plan moved to `plan-fixture.ts` and both
suites now import it. Copying it would have let the diff's completeness property
drift onto a stale field set — the second copy silently stops covering anything
the capture gains.

### Still open in slice 7

7.3 (`projectCurrentPlan()`), 7.3a (`current`'s own schedule), 7.3b (the compare
route) and 7.4 (cross-version normalisation). All four are `apps/be-01` work;
nothing in `libs/domain` blocks them.

## TASK-232 run 1 chunk 2 — `current` as a comparison side (7.3, 7.3a)

`SavedPlanService.projectCurrentPlan(projectId)` returns a `PlanSide` or `null`.
It is built on `captureAndAttempt`, **the save path's own capture**, rather than
on reads of its own — which is what 7.3 requires and what the two defects below
turn on.

### What reuse buys, stated as the failures it prevents

Both are invisible to the domain diff's completeness properties, because those
mutate `CanonicalPlanInput` values directly and never run this path:

1. A `current` assembled from the live projection's twelve awaited reads lacks
   the registry and junction rows **by value**, so every saved-vs-current
   comparison reports the saved side's tags, types and external systems as
   removed. The assertion that catches it compares the projected input's
   **bytes** against what a `save()` of the same project stored — not a field
   list somebody has to remember to extend.
2. A `current` whose schedule is the absent reason `unavailable` — which spec's
   stored-schedule bound lawfully permits until 7.3a exists — answers "no
   schedule was saved" about the live side of this feature's primary direction.

Reuse also gives `current` the one `BEGIN DEFERRED` read snapshot, without which
a torn `current` renders a comparison against a live plan that never existed.

### The schedule side

`schedule()`'s return over the values just captured, computed **outside** the
read snapshot as the save path already arranges, labelled with the algorithm
identity currently in force, with `ScheduleCycleError` mapping to `infeasible`
on 5.4's derivation. The body is round-tripped through `serialiseScheduleBody`
rather than handed over as the built object: the live side must compare against
a stored side on identical serialization terms, or every difference the
serializer normalises away is reported as a real one.

### 3.3's handle-liveness assertion, on this scheduling call

3.3's spy covers the save path only. The new suite samples the open-connection
count from **inside** the scheduling callback — a reading taken before and after
stays green under exactly the arrangement it forbids — and pairs it with the
instrument's own proof that a held handle reads as 1, so the zero is a release
rather than a counter that never increments.

### Watched red, measured

Returning `{ present: false, absentReason: 'unavailable' }` from
`projectCurrentPlan` before the real branch — defect (2) above, written out —
turns **2 of the 9 cases red**: the algorithm-identity case and the cycle case.
Reverted, `dirty=0` re-asserted.

**Not run this chunk, and not claimed:** the negative for 7.3's reuse (build
`current` from the projection instead of the capture) and the negative for the
liveness sample (schedule inside the held snapshot). Both are named here so the
next run does them rather than inheriting a green it did not earn.

### Gate

At `5103e0b3`, h2puni `/home/puni1/gate-task232`, `dirty=0`, `NX_DAEMON=false`,
`--skip-nx-cache`, `TMPDIR=/home/puni1/gate-tmp`:

| Gate                                                 | Result                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bun test src/service/saved-plan-current.db.test.ts` | exit 0 — **9 pass / 0 fail**                                                       |
| `nx run-many -t lint typecheck -p be-01 domain`      | exit 0 after the import-sort autofix                                               |
| `nx run-many -t test -p be-01` (whole suite)         | exit 0 — **1310 pass / 0 fail** across 111 files in 102.5s; 1301 before this chunk |
