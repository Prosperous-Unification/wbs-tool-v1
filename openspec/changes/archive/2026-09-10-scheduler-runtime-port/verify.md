# Verification

## Starting state

- Work began from clean `8214af98` on 2026-09-09; `origin/main` was `5516d453`
  and already an ancestor.
- The inspected two-schedule/cue baseline `aca7a5c9` and its `5375cf5f` follow-up
  are both ancestors of this branch. The current interface carries both optimized
  schedules and Fast's seventh deadline argument.

## Slice 1.1 — scheduler value port

- `bun test` in `libs/runtime-portable`: **13 pass / 0 fail**. The scheduler cases
  cover both engines, both objectives, enabled and disabled reads, absent and installed
  adapters, live and capture readers, all seven optimization states, ready-with-null,
  unexpected adapter failure and a domain cycle.
- Five existing optimizer/read files in `be-01`: **56 pass / 0 fail**.
- Core, runtime-portable and `be-01` typechecks: clean, including spec projects.
- ESLint over core, runtime-portable and every touched `be-01` file: clean.
- Removing the selected missing-adapter guard returned a scheduled Fast plan instead of
  `engine_unavailable`; the test failed before its zero-Fast-call assertion.
- Dropping Fast's seventh argument removed the literal `Map { "leaf" => 9 }` deadline
  from every recorded call.
- Removing the ready-schedule invariant returned `kind: scheduled` with a null PRI
  schedule instead of throwing.

## Slice 1.2 — synchronous cache hash move

- `scheduleInputHash` now lives at the repository cache boundary; all eight importing
  production/test files use that adapter, while canonicalization and its mutation corpus
  remain in domain. The scheduler contract version is unchanged.
- The focused domain, hash, cache and coordinator/service run completed with **143 pass /
  0 fail**. The restored final domain/hash/cache run completed with **94 pass / 0 fail**.
- Fresh `tsc --build --force` runs for domain, contracts and `be-01`: clean. Fresh ESLint
  runs for all three projects: clean. Prettier over every touched TypeScript file: clean.
- `rg` found no production `node:crypto` import under `libs/domain/src` (exit 1, no
  matches); the SHA-256 import exists only in the new repository adapter.
- Hard-coding canonical `reach` to `whole-item` made the real published-cache read serve
  the stored schedule in array slot 0 instead of returning `null`. Emptying canonical
  `deadlines` served it in slot 1. Both faults ran through `publishedScheduleReaderOf`
  against a real SQLite row and were restored.
- Changing the adapter from SHA-256 to SHA-1 changed the literal address from
  `e35e9e9c28d2d392bfca660c9892de1682ddbf7e86ede0878bd8eafa26167e14` to
  `db508ad760d4acd7813774dd6674d5e7cbaf47d3`; the literal test observed and names that
  failure.

## Slice 1.3 — nonadmitting captured cache read

- `capturedOptimizationReaderOf` reads the exact input hash, contract, budget and current
  generation directly from SQLite. It projects ready, pending, retrying, failed, corrupt,
  plan-infeasible and idle states plus both decoded schedules.
- Four real-database captured-reader cases plus the existing normalizer and coordinator
  suites completed with **39 pass / 0 fail**. Fresh `be-01` typecheck, full source lint and
  touched-file Prettier checks are clean.
- Replacing the unallocated captured read with the production coordinator's
  `readPlan({ enabled:true })` returned generation 1 instead of `null`; the state-table
  snapshot sits immediately after that assertion and would also see its slots and queue.
- Reusing live `readPlan`'s `enabled:false` early return for capture returned a null
  generation instead of 1 and removed the stored ready PRI schedule. The restored reader
  ignores admission enablement and reads that exact row.

## Slices 2.1–2.3 — live read, HTTP refusal and publication

- `WorkItemService.tree` now reads through the scheduler port. The real composition without
  an optimizer adapter returns the exact unavailable value; the live composition returns
  while its admitted fake solver is still held. The focused scheduler/service run completed
  with **33 pass / 0 fail** and `be-01`'s forced solution-build typecheck is clean.
- GET work-items plus JSON and Markdown export map the shared unavailable value to exact
  `409 application/json` replies. The mounted controller run completed with **130 pass /
  0 fail**. Removing either binder mapping produced 500 instead of 409 before restoration.
- Shared shape/client checks completed with **61 pass / 0 fail**, generated frontend client
  checks with **51 pass / 0 fail**, generated MCP checks with **49 pass / 0 fail**, and the
  production route-bijection/reachability file with **5 pass / 0 fail**. Contracts, MCP and
  frontend forced typechecks are clean.
- A real command runner commits the mutation and appends exactly one `plan_unavailable`
  event. Publishing `tree_replaced` instead failed on the durable event itself before the
  peer read. A refused batch appends no event. Removing its narrow resource mapping made the
  peer refresh request tree, steps, directory and markers instead of tree alone.
- The frontend names `Optimized scheduling is unavailable in this runtime.` on the initial
  refusal, exposes no export before a successful tree, and retains the installed plan on a
  peer failure. The focused jsdom run completed with **67 pass / 0 fail**; touched frontend,
  backend and contracts lint are clean.
- Chromium on owned ports 5500/5600/6600 completed the dated-plan failure window with **1
  pass / 0 fail**. Suppressing the modeled failure text failed there on `Expected:
Optimized scheduling is unavailable in this runtime. · Received: This plan may be out of
date — the last refresh failed. Retry`; the restored run kept the `2026-09-07` Start fact
  installed and passed.

## Main synchronization

- `git fetch origin main` on 2026-09-09 advanced `origin/main` to `cb472a0e`; merge
  `1f018ee3` contains that revision on this branch.
- A later fetch advanced `origin/main` to `0dc0a831`; merge `8b1352fb` contains that
  revision on this branch. The final scheduler checks below ran after that merge.

## Slices 3.1–3.2 — detached selected captures

- `scheduleInputOfCaptured` derives the same literal seven fields as the live projection:
  rows, edges, slices, not-before offsets, capacity pools, dependency reach and deadline
  offsets. The saved-plan suite completed with **120 pass / 0 fail**; its connection-entry
  check observed `[0]`, while the counting control observed `[1]` for a live handle.
- SavedPlanService now receives the shared Scheduler and selects from detached capture
  state. Ready optimized output is stored with identity
  `optimized:2.4:pri:12345`; idle, pending and retrying store `pending`; failed and corrupt
  store `unavailable`; plan infeasibility and dependency cycles store `infeasible`.
  Disabled optimized preference stores Fast, and a zero-work optimized capture stays pending.
- The real service graph and captured-reader database run completed with **14 pass / 0
  fail**. A save through the captured reader left generation, slot and queue tables exactly
  unchanged. Routing it through the live coordinator admitted generation 1 and left two
  `starting` solver slots at save return.
- Substituting Fast for a ready selected result failed on `Expected: 73 · Received: 0` for
  `waitingForCapacity`. Hardcoding the Fast algorithm identity failed on `Expected:
optimized:2.4:pri:12345 · Received: slice-leveling-v2`. Both faults were restored.
- Stored-history reads use only persisted bytes. Deliberately recomputing one through
  `captureAndAttempt` failed with `stored history invoked the scheduler` on the production
  read path; restoration completed the focused case with **1 pass / 0 fail**.
- Fresh forced typechecks for `be-01` and core are clean. Fresh uncached ESLint runs for
  both projects are clean; the core boundary fixture completed with **3 pass / 0 fail**.

## Slice 4.1 — integration gate

- The canonical `HEAVY_LOCK_WAIT_SECONDS=3600 bin/h2puni-gate.sh` ran from a clean,
  isolated h2puni checkout at `ca5190cfc066` after a frozen Bun install. **86 targets
  succeeded**, but the gate exited 1 on two stale test oracles: `be-01:test` completed
  with **2045 pass / 2 skip / 1 fail**, and `fe-01:test` completed with **2589 pass /
  1 fail** across 102 files. This is recorded as a failed gate and must be rerun at the
  repaired revision.
- The backend failure scanned the former WorkItemService scheduler call and therefore
  found no call after the runtime-port extraction. The oracle now parses the production
  Fast call in `libs/runtime-portable/src/scheduler.ts` and asserts all seven named input
  fields. Removing `ask.input.deadlines` from that call failed with the six received
  fields and the seventh missing; restoration completed the identity file with **3 pass /
  0 fail** and the runtime scheduler file with **11 pass / 0 fail**.
- The frontend failure queried the Export control synchronously while the initial tree
  read was pending. That observed fault failed with `Unable to find a label with the text
of: Mermaid lanes`. The test now waits for the successful read that makes Export
  available; restoration completed the focused case with **1 pass / 0 fail** and the
  whole toolbar file with **25 pass / 0 fail**.
- A local whole-Chromium attempt used confirmed-free owned ports 5000/5100/6100 and a
  frozen tree. It was stopped after 70 minutes with **143 pass / 5 Gantt timeouts / 1
  skip / 203 unrun**. It is not a browser-gate success; the whole suite remains required
  on the final h2puni revision.
- A second canonical h2puni gate ran from clean exact revision `1f018ee374b6` and ended
  after 9m32s with **87 successful tasks / 1 failed task**. Both `be-01:test` and
  `fe-01:test` passed, proving the two repaired oracles in the full gate. The remaining
  `tool-devsync:test` failure reported this outside read as undeclared:
  `be-01:test does not declare libs/runtime-portable/src/scheduler.ts`.
- Inspection of Nx's actual graph showed that report was a false positive: `be-01`
  directly depends on `runtime-portable`, and its existing `^production` input already
  hashes the production scheduler file. The workspace check now resolves the actual Nx
  graph and applies Nx's own dependency-input glob rules. Ignoring that coverage failed
  on the exact scheduler diagnostic above; restoration completed the suite with **10 pass
  / 0 fail** without a redundant explicit input.
- The corrected canonical gate ran at clean exact revision `9a714b9940bb` and completed
  all **88 Nx tasks** in 9m12s. Its final real Docker
  `be-01:solver-image-smoke` completed with **3 pass / 0 fail** in 48.2s.
- The first isolated h2puni browser attempt could not launch Chromium because Playwright's
  pinned revision 1243 was absent; it ended with **2 pass / 37 skip / browser launches
  failed** and is not counted as a behavior result. `bunx playwright install chromium`
  installed that exact revision before the real run.
- The first real whole-browser run at `9a714b9940bb` completed **315 pass / 37 skip / 1
  fail** in 32m58s. The failure exposed a real late-mount fault: Export became available
  after `useClosedByPointerOutside`'s one-shot effect had already read a null ref, so its
  outside-pointer listener was never installed. The assertion failed on `Export stayed
open · Expected: 0 · Received: 1`.
- The hook now follows its mounted `<details>` node. The exact failed production-path case
  passed remotely with **1 pass / 0 fail** in 15.8s. Fresh frontend typecheck and uncached
  lint are clean.
- After confirming owned ports 5000/5100/6100 were free, the whole browser suite at clean
  exact revision `2e135b2b4114` completed with **316 pass / 37 intentionally skipped / 0
  fail** in 36m1s. The formerly failing case passed inside that run. The recurring Vite
  websocket `EPIPE`/`ECONNRESET` diagnostics accompanied context teardown and did not fail
  a browser case.
- The final canonical gate ran from clean exact merged revision `8b1352fb` and completed
  all **88 Nx tasks** in 9m37s. Its real Docker `be-01:solver-image-smoke` completed with
  **3 pass / 0 fail**; the target took 53.1s and the solver process took 12.07s.
- Two whole-browser runs against the source-module Vite server each completed **315 pass /
  37 intentionally skipped / 1 fail**, in 35m21s and 40m6s. The failing case moved from
  Gantt to name Markdown, and each exact case then passed alone. The second trace showed
  simultaneous `net::ERR_NETWORK_CHANGED` failures across `/@fs/` source modules and an
  empty mounted root, so the gate now builds once and serves the bundled app with Vite
  preview.
- Replacing that command with `bunx vite` failed its production config check on the exact
  received and expected commands. The restored local frontend suite completed **2598 pass /
  0 fail** across the normal and zoned projects; frontend lint, typecheck, build and the
  **23 pass / 0 fail** config checks were clean.
- The first bundled whole-browser run at exact `228929dc` completed **314 pass / 37
  intentionally skipped / 2 fail** in 22m30s. Both failures were harness compatibility:
  the dark-mode case still intercepted the source entry, and minification removed the
  function name used by rendering coverage. Revision `53efcbb6` intercepts the built entry
  and uses an unminified build; those exact two cases completed **2 pass / 0 fail** in
  20.4s.
- The final whole-browser run used owned ports 5000/5100/6100 against clean exact revision
  `53efcbb6`. Playwright's persisted result is `status: passed` with an empty failed-test
  list. The SSH transport stopped returning output after the remote Playwright and preview
  processes exited, so the final aggregate count and duration were unavailable; the saved
  status and artifacts were read directly rather than inferring success from the transport.

## Final integrated head

The scheduler port landed in the same combined candidate as `core-lib-extraction`.
After merging `origin/main` at `a42fbf4e`, exact pushed revision
`3d67da8ec717642c4c9ae13ad14ff38e13a81835` passed all 101 uncached h2puni Nx
tasks and the 3/3 Docker solver-image cases. Its complete Chromium run passed
328 cases with 37 intentional rendering-baseline skips and no failures in
17m57s. The detailed command and host evidence is recorded in
`../2026-09-10-core-lib-extraction/verify.md` under “Final integrated head”.
