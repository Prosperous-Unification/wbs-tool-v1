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
   **Observed 2026-09-04 at head `7208e8a4`, h2puni, over all 161 projects in
   the deployed database:** the largest body is **50,975 bytes — 0.6077% of
   8,388,608**, 164.6× headroom, on a project of 63 work items. Next four:
   39,197 (79 items), 18,774 (60), 15,546 (44), 15,051 (35). **A-3 is not
   falsified.** Density at the largest is 809 bytes per work item, so 8 MiB is
   about **10,300 work items in one project**; the corpus holds 927 across 161,
   largest 63.
   **Measured by running the save path, not an estimate of it.** A throwaway
   script called `SavedPlanCaptureRepository.readPlanInput`, `planInputRowsOf`,
   `canonicalisePlanInput`, `serialiseCanonicalPlanInput` and `bodyByteLength`
   in production order against a copy of the database file, so no shape or
   serializer is reimplemented and the UTF-8 count is the same one the quota
   uses. The script and the one-line `tsconfig.json` `bun` needed to resolve
   `@wbs/domain` were deleted afterwards, `dirty=0` re-asserted.
   **The trap this row nearly fell into, recorded because the next reader will
   meet it too.** The deployment's colours invert the usual reading of which
   file holds real data. `be-01-green`, which serves the `wbs.` origin, mounts
   `/home/puni1/wbs/data/wbs.db`: **36 KiB, last written 2026-08-24, five
   tables** (`__drizzle_migrations`, `event_log`, `event_sequencer`, `examples`,
   `sqlite_sequence`) and **no `project` table at all**. The script pointed
   there exits 1 on `SQLiteError: no such table: project`. Had it instead
   swallowed the error and printed "0 projects measured", this row would read as
   a green verdict resting on an empty file. The 161 real projects are in
   `dev-be-01-blue`'s `/home/puni1/wbs-dev/data/wbs.db` — 27 MB, 35 tables,
   written within the hour. Both were copied and both were run.

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

## TASK-232 run 1 chunk 3 — forward-only normalisation (7.4)

`normalisePlanInputForward(body, storedVersion, readerVersion?, upgrades?)` in
`libs/domain/src/saved-plan/normalise-plan-input.ts`.

**It takes the parsed body, never the bytes, and that is the structural half of
"the stored bytes are unchanged".** The function has no access to them and no
way to write them; the hash assertion 7.4 asks for is then a check on the other
half rather than the only guard. At the reader's own version it is the
**identity** — the same value back, not a copy, because a copy would quietly
hide a step that had mutated its argument.

### Three refusals, distinguished

A single "unsupported version" would hide which of these happened, and they call
for different answers:

| `reason`          | When                                                  | Why not silent                                                                                                               |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `from-the-future` | stored version above the reader's                     | design.md: a schema that _removes_ a field needs a down-conversion rule written at that change, never guessed here           |
| `no-upgrade-path` | stored version below the reader's, no step registered | passing an old shape through as current is how a removed field comes to read `undefined` and compare as a change nobody made |
| `not-a-version`   | not a positive integer                                | a header number that is not a version is a corrupt header, not a conversion problem                                          |

`PLAN_INPUT_UPGRADES` is **empty today, and that is a statement**: version 1 is
the only version that has ever existed, so there is no *n*→*n+1* step to write.
When `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` moves to 2 a step keyed `1` lands
with it, and until then a v1 body against a v2 reader fails `no-upgrade-path`
loudly instead of arriving half-converted. The step-ordering case proves the
loop by running two synthetic steps and asserting both the order and that each
ran once.

### The watched negative, standing rather than one-off

7.4 names "rewrite the stored body during normalisation and watch the hash
assertion fail". The suite keeps both halves as a permanent comparison: a
`mutating` step that writes into its argument leaves the caller's own parsed
value tampered, and a `copying` step leaves it untouched. The assertion is red
for the first and green for the second in the same case, so the guard cannot
rot into a test that passes either way.

### Gate

At `a10ad8cd`, h2puni `/home/puni1/gate-task232`, `dirty=0`, `NX_DAEMON=false`,
`--skip-nx-cache`, `--parallel=1`, `TMPDIR=/home/puni1/gate-tmp`:

| Gate                                           | Result                                         |
| ---------------------------------------------- | ---------------------------------------------- |
| `nx run-many -t test lint typecheck -p domain` | exit 0 — **371 pass / 0 fail** across 27 files |
| `nx format:check --all`                        | exit 0, zero files                             |

Re-run whole at the run's final head `ab14f1fa`, `dirty=0`:
`nx run-many -t test lint typecheck -p be-01 domain` exit 0 — **domain 371 pass
/ 0 fail, be-01 1310 pass / 0 fail**, lint and typecheck 0 for both; `nx
format:check --all` exit 0; `bun x @fission-ai/openspec validate --all --json`
**35 valid / 0 invalid**. So the be-01 figure is observed at the head this run
ends on, not relayed from the earlier chunk.

### Slice 7 after this chunk

7.1, 7.2, 7.2b, 7.2c, 7.3, 7.3a and 7.4 are done. **7.3b — the compare route on
`savedPlanController`, extending 6.2's permission matrix to a sixth route — is
the only item left in the slice**, and it is the one that can expose a
restricted project's _live_ plan through `current`, so its guard owes the same
proof every other check here does. (Closed by the section below; **slice 7 is
complete**.)

## 7.3b — the compare route

`GET /api/projects/:id/saved-plans/compare?left=&right=`, each side the literal
`current` or a saved-plan id. `SavedPlanService.compare` resolves both sides and
hands them to `diffPlans`; the route answers `{ diff }`.

**The project id in the path is load-bearing rather than repeated**, which is
why this route sits on the project prefix while read, rename and delete sit on
their own. `current` has no id, so "the live plan" is only meaningful against a
named project. The rule the second prefix enforces structurally — a URL may not
name a project its plan does not belong to — is therefore enforced here by an
explicit check: a side naming a plan of another project answers `not_found`,
with the same body a plan id that never existed gets.

`normalisePlanInputForward` is called on every stored side (7.4). Today it is
the identity and its three refusals are unreachable from this path, because
`readOfStored` has already thrown on a version outside
`SUPPORTED_INPUT_BODY_VERSIONS`. That is stated rather than counted as coverage.
It is called anyway because the day a second version exists is the day this call
is the only thing between an old body and a diff reporting a removed field as a
change nobody made.

### Two watched negatives, both measured

**1. The route without the read rule.** Removing `...signedIn` from the compare
route's options and re-running: **16 pass / 2 fail**, and the two are exactly
`unrestricted: anonymous` and `restricted: anonymous`. One cell moved in each
row — `compare: 401 -> 200` — with `save`, `list`, `read`, `rename` and `delete`
unchanged at 401. An unauthenticated caller received the restricted project's
**live** plan, captured server-side through 7.3.

**2. The cross-project refusal removed.** Deleting the
`found.plan.projectId !== projectId` branch in `sideOf`: **17 pass / 1 fail**,
and the failure is the cross-project case alone.

**The second negative is the finding.** With that branch gone the whole
permission matrix stayed green — all eight rows, both columns. A status matrix
cannot see this exposure, because the caller is authenticated and lawfully reads
project A: what leaks is project B's live plan, named as the _other side_, at
status 200 in both builds. The task's wording ("watch the matrix's anonymous and
third-party cases fail") holds for the anonymous half only. On this codebase's
read rule an authenticated third party is a lawful 200 on `read` and stays 200
on `compare` — `canEdit` restricts writing, not reading — so the third-party
half needed its own case rather than a matrix cell, and that case is the one
that catches the leak.

Both files were restored and `dirty=0` re-asserted before the gate below.

### Gate

At `d8fe88c1`, h2puni `/home/puni1/gate-task232`, `dirty=0`, `NX_DAEMON=false`,
`--skip-nx-cache`, `--parallel=1`, `TMPDIR=/home/puni1/gate-tmp`:

| Gate                                                 | Result                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `nx run-many -t test lint typecheck -p be-01 domain` | exit 0 — domain **371 pass / 0 fail**, be-01 **1314 pass / 0 fail** across 111 files |

Re-run whole at the run's final head `7fc09526`, `dirty=0` — the delta from
`d8fe88c1` is one prettier line break in the service and the wrapping of this
record — `nx run-many -t test lint typecheck -p be-01 domain` exit 0, **domain
371 pass / 0 fail, be-01 1314 pass / 0 fail**, lint and typecheck 0 for both;
`nx format:check --all` exit 0, zero files; `bun x @fission-ai/openspec validate
--all --json` **35 valid / 0 invalid** (observed at `1310caa6`, the head that
introduced this section's text).

The first attempt at `5744c156` failed twice and both were real: an
`emit-openapi-cli` guard ("the routes moved and the document did not") caught
the sixth route missing from `openapi.json`, and `simple-import-sort` caught the
service's new import members. Both were fixed on h2puni and the corrected files
copied back, then the whole gate re-run at the head above.

### 7.3b — the two cases the first chunk deferred

**A corrupt side is 422 and names the plan.** A saved plan whose input bytes are
damaged underneath the record — `bytes || ' '`, the one-byte append
`saved-plan-read.db.test.ts` uses — compared against `current` answers 422 with
`error: 'corrupt'` and the `savedPlanId`. The refusal is `read`'s; what is
proved here is that the compare route carries it out rather than folding it into
the `not_found` its other three refusals share. With two sides, a refusal naming
no plan leaves a caller unable to tell which picker holds the damaged one.
**Negative, measured:** the compare route's `422` changed to `404` — **19 pass /
1 fail**, that case alone.

**`current` is a reserved literal, not a lookup.** Both sides `current` on a
project with no saved plans at all: 200 and an empty diff on both halves.
**Negative, measured — and it falsified the claim first written beside it.**
Deleting the reservation from `sideRef` turns **8 of 20 red**, not 1, because
every other compare case passes `right=current` too. The case is therefore not
the sole detector; it is the only one whose failure is unambiguous, having no
saved plan in it that could fail for another reason. The comment was corrected
to what was measured rather than left standing.

**Not covered, and named rather than implied:** the `no_project` branch of
`sideOf` is reachable only if the project is deleted between the route's own
`projects.read` and the capture, which this file cannot stage.

At `7734769b`, h2puni `/home/puni1/gate-task232`, `dirty=0`:
`nx run-many -t lint typecheck -p be-01` exit 0; `nx format:check --all` exit 0;
`bun test src/controller/saved-plan.controller.db.test.ts` exit 0 — **20 pass /
0 fail**. **This gate is narrower than the one above on purpose**: the diff is
one test file plus one comment, so the whole-project suite was not re-run here.
`7fc09526` remains the last whole-project observation.

## 9.2 — the first whole-repo signal this branch ever had, and it is red

**Run 12, 2026-09-04.** CI on PR 202 at `9ee94b38`, run
[33864337961](https://github.com/Prosperous-Unification/wbs-tool-v1/actions/runs/33864337961).
Both jobs failed. That is 9.2's answer: not a green tick, three separate reds,
each recorded below with what it proves rather than summarised as "CI failed".

**Everything else on the branch is green, and those numbers matter** so the reds
are read as three defects rather than a broken branch: `domain` 371/0 (36,417
`expect()` calls), `be-01` 1322/0 across 112 files, `gw-01` 65/0, `contracts`
12/0, `auth` 23/0, and every `lint`, `typecheck` and `build` target in the
workspace exit 0 — including `fe-01:lint` (one warning, no errors),
`fe-01:typecheck` and `fe-01:build`.

### Reds 1 and 2 — `mcp-01`'s tool-count drift guards. Fixed at `f0897a42`.

`apps/mcp-01/src/openapi-tools.test.ts`, 104 pass / 2 fail:

| Test                                                                                          | Assertion      | Expected | Received |
| --------------------------------------------------------------------------------------------- | -------------- | -------- | -------- |
| `is 27 tools, so a route that appears must be decided about` (`:296`)                         | `toHaveLength` | 27       | 28       |
| `the README names the tools that exist > counts them the same way the document does` (`:440`) | `toBe`         | 28       | 27       |

The two reds are one fact seen from both ends: the document derives 28 tools and
two hand-written numbers still said 27.

**Exactly one route arrives on this branch.** `git diff origin/main...HEAD --
apps/be-01/openapi.json` adds one `operationId` and removes none:
`getApiProjectsByIdSaved-plansCompare`, from
`GET /api/projects/{id}/saved-plans/compare`. The same diff also drops three
`"required": ["name"]` clauses — A-1, be-01 defaulting the saved-plan name — but
a required-ness change adds no tool. The other five saved-plan routes were
already on `main` and already inside the 27.

**The decision the guard demands, made rather than deferred:** the compare route
belongs. It is a read, so none of the five `EXCLUDED_PATHS` classes reaches it —
not `/api/auth/*`, not `/internal/*`, and unlike `/health`, `/metrics` and
`/api/smoke/echo` it carries a plan. `EXCLUDED_PATHS` stays at five. It is also
the route the existing admissions already pointed at: the list and single reads
were let in because "an agent asked to compare two snapshots has to list them
and read one before it can name an id", and this is what then answers the
comparison. Without it an agent would have to re-derive the diff from two full
plan bodies it has no contract for.

**The guard worked exactly as its own comment says it should.** That comment
records three separate times that count drift arrived "as a red four chunks
late", because the change was gated `-p be-01` while the drift test lives in
`mcp-01`. This time it was caught on the first whole-repo run the branch ever
had — the run that only happened because h2puni was saturated and 9.2 was handed
to CI.

### Red 3 — `pixels`, four layout tests. Open.

279 passed, 4 failed, 12.5m:

| #   | Spec                                                                                         | Assertion                | Expected | Received |
| --- | -------------------------------------------------------------------------------------------- | ------------------------ | -------- | -------- |
| 1   | `header.spec.ts:272` — gives the table the height the chrome stopped taking                  | `>= FRAME_BEFORE + GAIN` | >= 634   | 601      |
| 2   | `header.spec.ts:289` — ends the frame at the bottom of the window                            | `belowFrame <= 16`       | <= 16    | 76       |
| 3   | `plan-surface.spec.ts:278` — ends the chart at the window's bottom however short the plan is | `belowChart <= 16`       | <= 16    | 76       |
| 4   | `plan-surface.spec.ts:318` — still ends the chart at the bottom when the plan is long        | same chain               | —        | —        |

**Diagnosis, and it is a fault in this branch rather than a stale baseline.**
`project-page.tsx` mounts the shelf as a `shrink-0` sibling of the table inside
`<main>`:

```tsx
<div className="mt-2 max-h-64 shrink-0 overflow-y-auto">
  <SavedPlansPanel key={selected} projectId={selected} deps={savedPlans} />
```

`shrink-0` was chosen to stop a thirty-checkpoint history squeezing the table,
and that reasoning is right and is written out beside the code. What it missed
is that the same `shrink-0` **guarantees** the shelf takes its height out of the
one column whose invariant is that it reaches the window's bottom. The gap is
the same 60px in tests 2 and 3 (76 − 16) because it is one shelf measured twice:
at rest the panel is roughly 68px, plus `mt-2`'s 8px.

**Raising those numbers would be the wrong repair, because the four tests encode
a product invariant** — "the frame is the thing that scrolls", and
`plan-surface.spec.ts:300` adds "what reaches the bottom is the chart itself,
not a control strip that parted company with it". A shelf that pushes the chart
up is precisely the control strip that test was written against. The repair
belongs in the mount: the shelf must stop consuming the main column's height at
rest — inside the scrolling frame, or behind an overlay/disclosure that is out
of the flex chain until it is opened.

### Red 4 — the `fe-01` unit target. Not recoverable from CI's log; reproduced and fixed at `afd3e934`.

The `fe-01:test` target is marked ❌ and the job ends `Process completed with
exit code 1`, but the group's captured output is cut mid-token (`at WbsTable
(…/wbs-table.tsx`) and no vitest summary survives anywhere in the log — no
`Test Files`, no `Tests`, not one `×`. Both `gh api
.../jobs/100995637561/logs` (5,224 lines) and `gh run view --log-failed`
(13,512 lines) end at the same truncation, so this is GitHub's per-group output
cap and not a fetch artefact. Everything before the cut is `stderr` noise:
expected `GanttDataError` output from the **passing** "a chart that cannot be
drawn" cases, and React `act(...)` warnings from `wbs-table.tsx:1260`.

**Reproduced on h2puni rather than guessed at, and fixed at `afd3e934`.** The
first two attempts were abandoned at load1 141.19 / 453 MB free; the third, at
load1 2.16 in `/home/puni1/gate-task232` at `ce9e0aa3` `dirty=0`, ran the target
to completion in 245s: **1 test file failed, 85 passed, of 86.** The file is
`apps/fe-01/src/test-tiers.test.ts`, and its two assertions are one fact:

| Assertion                                                               | Expected   | Received |
| ----------------------------------------------------------------------- | ---------- | -------- |
| `[...NODE_SUITES].sort()` deep-equals the directory walk's DOM-free set | 20 entries | 19       |
| `NODE_SUITES.length + domTier.length` is `all.length`                   | 86         | 85       |

**The missing entry is `src/lib/saved-plan-compare.test.ts`.** Of the four
`src/lib` suites this branch adds, it is the only one the tier rule reads as
DOM-free: `saved-plan-save.test.ts` and `saved-plan-shelf.test.ts` import
`@testing-library` and genuinely need jsdom, and `saved-plan-api.test.ts` is
caught by `DOM_EVIDENCE`'s deliberately generous `\bdocument\b` on **fourteen
prose mentions of the _OpenAPI_ document** and not one browser global. That
third one is left where the rule puts it: being wrong in that direction only
costs the file the slow tier, which is the trade the rule's own comment says to
prefer, and special-casing it would trade a cheap loss for a real one.

**Both halves gated at `afd3e934`, h2puni, `dirty=0`.** The guard itself: 3
passed. And the half the guard says it cannot make — "what this file cannot say
is that a listed suite really runs under `node`; only running it can" — the fast
tier now runs **20 files / 359 tests in 1.37s**, with
`src/lib/saved-plan-compare.test.ts` among them at 15 passed.

**What this also says about the truncation.** The whole failure was one list
entry, and it cost a reproduction on a second host because GitHub's per-group
cap ate the summary. Worth remembering the next time a red is read from CI
alone: a target marked ❌ with no surviving summary is an unknown, not a
diagnosis.

### The bottleneck, measured a second time on the same day

Run 11 measured three lanes gating concurrently driving h2puni to load1 110 with
2% memory available. This run measured the same box again at 10:56Z: **load1
141.19, 453 MB free of 15.6 GB** — twenty minutes after `monitoring/status.json`
had recovered to `ok: true` with load1 3.77. A build host that swings between
3.77 and 141 inside twenty minutes is not one any lane can plan a gate against.
