# Execution verification

Base `f89ebf56`, isolated worktree `.worktrees/refactoring`, 2026-09-06.

## Baseline

`bun install --frozen-lockfile`: succeeded, 102 packages installed. Initial sandbox
attempt could not write Bun's temp directory; rerun with sandbox escalation passed.

`bun run test:unit`: backend 647 passed, 0 failed; domain 503 passed,
contracts 243 passed, validation 6 passed, config 6 passed, realtime 8 passed,
observability 3 passed. Auth's fixture failed to bind `Bun.serve({ port: 0 })`
under the sandbox; its teardown then failed because no server existed.
Log: `/private/tmp/wbs-refactoring-baseline.log`.

`bunx nx test auth --skip-nx-cache`, with loopback access via escalation:
23 tests passed, 0 failed. This isolates the baseline auth failure to sandbox
listener access; no source was changed. Nx labeled the differing executions
flaky; that label does not establish a code race.
Log: `/private/tmp/wbs-refactoring-auth-baseline.log`.

Full workspace, frontend integration, browser and deployment checks have not yet
run. Per-slice evidence will live beside each change; none is inferred from this
baseline.

Clean-main format control: `bunx nx format:check --all` on the original checkout
at `f89ebf56` exited 0; no output. `git status --short --branch` confirmed that
checkout remained clean on main. This is baseline evidence only, not a format
verdict for the refactoring worktree's in-progress files.

Backend checkpoint: `bunx nx typecheck be-01 --skip-nx-cache` passed with the R2
and R3 implementations held unchanged; log
`/private/tmp/wbs-refactoring-be-typecheck.log`. R5/R6 subsequently passed the same root target (source and spec projects); log
`/private/tmp/wbs-refactoring-r5-r6-typecheck.log`.

Pre-gate checkpoint: W4-4 passed the FE root typecheck (source, spec and e2e),
601 concept tests, and independent structural review. R2, R3, R5, R6 and R8
passed their scoped tests and independent reviews. Their change-local
`verify.md` files record injected faults and the observed failures. R4 is still
under review; its valid leading-whitespace JSON compatibility fix must pass
before this checkpoint is frozen.

`git diff --check`: passed. `OPENSPEC_TELEMETRY=0 openspec validate --all --json`:
46 passed, 0 failed. Log: `/private/tmp/wbs-refactoring-openspec-checkpoint.json`.
These checks precede the final R4 correction; full workspace and browser verdicts
remain pending.

## First full checkpoint, before feature integration

Frozen clean commit `ae1fc858`; command
`HEAVY_LOCK_WAIT_SECONDS=3600 bin/h2puni-gate.sh`, uncached targets under the
canonical host lock. Format, reported lint/typecheck/build targets passed.
Frontend: 2,213 tests in 86 files passed (248.57s). Backend: 1,621 passed and two
boot tests failed (103.26s), expecting password-session 401/200 and receiving 500.
The boot fixture still threw plain Error for a credential refusal after R3;
the actual verifier throws JOSEAlgNotAllowed. Its fixture repair and explicit
boot outage tests are being verified during feature integration.

A third failure was `tool-dagger`'s immediate lock-refusal test: the invocation's
HEAVY_LOCK_WAIT_SECONDS=3600 was inherited by its child, changing refusal into
waiting and causing its 5s timeout. The next gate must run with that variable
unset. This is an invocation correction, not a production lock change.

The already-red run was stopped with SIGTERM to its verified isolated process
group while only `tool-bootstrap:test` remained. Session exited 130 and released
the canonical lock. Bootstrap was progressing through shell scenarios; it has
**no verdict** from this run and must run in the next complete gate. No browser
or deployment check has run. Log:
`/private/tmp/wbs-refactoring-checkpoint-gate.log`.

Companion checks before integration: secrets scan passed over 2,043 tracked
files; migration lint passed over 80 SQL files; doc caps and both Compose
configuration validations passed. Parsed Compose confirmed the external network
and Caddy's membership. These counts precede the incoming marker migration.

Invocation control: `env -u HEAVY_LOCK_WAIT_SECONDS bun test
./tools/tool-dagger/src/heavy-lock.test.ts` passed all three tests, five
assertions, in 2.16s. The production lock code was unchanged.

## Integration review and scoped verification

The three conflicts importing `origin/main` at `a91f831b` were resolved and
independently reviewed. Auth retains both parents' test inventories, incoming
OIDC callback behavior, and R3/R5 boundaries. Its restored boot/auth/OIDC run
passed 83 tests (272 assertions); a broad-catch mutation failed both new boot
outage cases with 401/200 instead of 500. Backend root source/spec typecheck
passed. Details: `openspec/changes/account-store-failures/verify.md`.

Frontend marker lifecycle was moved into the existing plan-read module, with
five Gantt props retained at the table host. The reviewer confirmed all other
29 incoming frontend files matched main before the separate lint coverage fix.
Focused suites passed 330 tests; Auckland timezone suites passed three tests.
FE root source/spec/e2e typecheck and owned-file lint/format passed. Columns'
three dependencies and PlanLive remain unchanged. Composed full gates pending.

The inherited timezone-config lint omission is fixed in both FE commands.
A filesystem-derived root-source coverage test failed for both omitted inputs,
then passed (five test-tier cases total). The actual Nx lint target caught an
injected unnecessary condition in vitest.zoned.config.ts at 49:5. Restored, lint
passed with zero errors and the one preserved use-plan-filter dependency warning.
Independent scoped review approved the coverage fix. No config fault remains.

`bash bin/heavy-lock.test.sh`: all checks passed.
`OPENSPEC_TELEMETRY=0 openspec validate --all --json`: 46 changes passed,
zero failed. ADR inventory: 17 unique IDs, with all three marker-reference files
updated to 0017. Logs: `/private/tmp/wbs-refactoring-heavy-lock.log` and
`/private/tmp/wbs-refactoring-merge-openspec.json`.

## Merged checkpoint gates at 362c29a8

Tracked tree remained clean throughout both runs. Full browser command:
`env -u HEAVY_LOCK_WAIT_SECONDS CI=1 E2E_PORT_SHIFT=1900 bin/with-heavy-lock.sh -- bun run e2e`. Fresh owned ports5000/5100/6100 and CI server-reuse refusal were verified. **293 passed, 1 skipped, 0 failed**,10.0m, exit0. The existing skipped case is `apps/fe-01/e2e/gantt.spec.ts:2684`, “the chart edge the reader drags > dragging up moves the boundary up”. Log `/private/tmp/wbs-refactoring-merged-browser.log`.

Full workspace command: `env -u HEAVY_LOCK_WAIT_SECONDS bin/h2puni-gate.sh`. Format and all lint/typecheck/build targets passed; backend **1693 passed,0failed**, frontend **2307 passed in88files** plus **3 Auckland cases in2files**. The complete run exited1 solely for `tool-bootstrap:test`:53passed,7failed,219assertions,1360.16s. Log `/private/tmp/wbs-refactoring-merged-gate.log`. **This is not a full gate pass.**

The four host-state fault sweeps took25.40–32.91s under Bun's default5s timeout; the128-cell environment sweeps took339.44–451.94s under60s limits. Bun reported timeout and killed fixture subprocesses, causing expected deliberate-stop7 to read as null. No provisioning assertion was removed. The test-only correction gives host sweeps120s and environment sweeps900s. Focused host controls passed: 4 tests, 104 assertions, 140.11s. The corrected complete bootstrap suite passed: 60 tests, 0 failures, 286 assertions, 969.23s, exit 0, under the canonical lock with HEAVY_LOCK_WAIT_SECONDS unset. Logs: `/private/tmp/wbs-refactoring-bootstrap-host.log` and `/private/tmp/wbs-refactoring-bootstrap-restored.log`. These runner budgets do not claim provisioning performance. A new complete workspace gate is still required; this scoped restoration does not change the earlier exit 1.

Workers began R1/R7/R9 in separate sibling worktrees from362c29a8 during this run; they did not edit its frozen tracked tree. Their pending tests are not part of this checkpoint evidence.

## Deadline feature integration

Fetched main advanced to b2bb095c, additive deadline schema slice#218. Merging into the integration branch produced no conflicts. Read-only review found explicit work-item projections keep the nullable field outside current API/capture shapes; R2 stamps and R6 assignment joins are unchanged. Upstream historical review/gate claims are not substituted for this branch's checks. The complete backend suite passed after merge: 1693 tests, 0 failures, 15395 assertions, 130 files, 112.90s; log `/private/tmp/wbs-refactoring-deadline-be.log`. Forced backend and frontend root source/spec typechecks passed during HTTP baseline measurement. A fresh migration lint after merge remains pending. Future writable deadline slices must coordinate projection and delete/undo restoration before they are integrated.

## HTTP foundation checkpoint — 2026-09-06

Frozen primary source at 35576d79 plus reviewed HTTP/origin changes: complete
backend suite passed 1765 tests, 0 failures, 15716 assertions across 136 files
in 106.30s (`env -u HEAVY_LOCK_WAIT_SECONDS bin/with-heavy-lock.sh -- bun test
./apps/be-01/src`). Log: `/private/tmp/wbs-http-origin-backend-full.log`.
A 2126-file content manifest was unchanged after the suite. Forced backend root
source/spec compilation passed separately. Post-foundation forced compiler means
were 10.133s backend and 11.637s frontend; neither doubled the recorded baseline.
This is a scoped checkpoint; a fresh full workspace and browser gate remain owed.

Fetched feature head bf69132d awaits integration after this checkpoint commit.
Read-only audits identified OIDC mismatch retention, resolved marker wire colors,
marker broadcaster composition, and required slice lateBy fields to preserve.

## Feature merge bf69132d — 2026-09-06

Merged origin/main bf69132d into bf1fa107 without textual conflicts. Two independent
source reviews approved preservation of R1/R3/R5/R6/R9 plus incoming OIDC transaction
retention, marker broadcasting/resolved colors, deadline scheduling and SVG legends.
Fresh backend, auth, domain and solver-contract suites passed 2610 tests, 0 failures,
55786 assertions across 206 files in 115.75s. Command: `env -u HEAVY_LOCK_WAIT_SECONDS
bin/with-heavy-lock.sh -- bun test ./apps/be-01/src ./libs/domain/src ./libs/auth/src
./libs/contracts/solver/src`; log `/private/tmp/wbs-http-feature-merge-tests.log`.
Two earlier launch attempts exited75 because the R10 fixture owned the canonical
lock; neither ran tests. Forced backend and frontend root project compilation
passed: `bunx tsc --build --force apps/be-01/tsconfig.json apps/fe-01/tsconfig.json`
(`/private/tmp/wbs-http-feature-merge-types.log`). Concurrent new unexported client
files are outside this merge's evidence and will receive separate checks.

Merged Gantt SVG suite passed all 228 cases in 5.98s via canonical lock and
`bunx vitest run src/components/wbs/gantt-panel.test.tsx --no-file-parallelism
--maxWorkers=1 --minWorkers=1` from apps/fe-01. Log:
`/private/tmp/wbs-http-feature-merge-gantt.log`. Full browser/workspace gates remain
pending; this scoped jsdom run does not claim pixel or browser-default behavior.

## Merged state — 2026-09-07

The branch was squash-merged into `main` as `cbad68af` (PR #287). The branch-local hashes
above no longer resolve; `cbad68af` carries them all. Read from the runs, not the prose:

| `main` head | Run         | gate    | pixels  | Note                                                                                |
| ----------- | ----------- | ------- | ------- | ----------------------------------------------------------------------------------- |
| `cbad68af`  | 34146365377 | failure | success | `fe-01:test`, `<MenuControl>` under the refusing-api fake; fixed on `main` by #300  |
| `a0c7cada`  | 34148109854 | success | success | first green with every slice of this branch on `main`                               |
| `7aa61b09`  | 34149386984 | success | success | green again one commit later                                                        |
| `98093d2d`  | 34151063325 | —       | —       | cancelled by the next push (toolchain merge, PR #248)                               |
| `3e17fb01`  | 34160044188 | failure | success | `gantt-panel.test.tsx` rename sheet read before the read-back landed; PR #309 waits |

The two `layout.spec.ts` failures recorded in `docs/state/TASK-347-http-endpoint-port.md`
(`:1233`, `:2721`) are in the `pixels` job, which is green at `a0c7cada` and `7aa61b09`; the
branch's own last runs before merge were not, and no fix commit names them. Their disposition is
therefore "pass on `main` at the merged tree", observed, not explained.

Spec-project typecheck, measured 2026-09-07 at `3e17fb01`: `tsc -p <project>/tsconfig.spec.json
--noEmit` over all 23 `tsconfig.spec.json` files reports **0** errors. Non-vacuous: a deliberate
`const deliberatelyWrong: number = 'not a number'` appended to `apps/be-01/src/http/endpoint.test.ts`
and `apps/fe-01/src/components/wbs/plan-cards.test.tsx` produced 1 error each under that command
**and** under the gate's own `tsc --build --force apps/be-01/tsconfig.json`, whose references include
`tsconfig.spec.json`. The handoff's "218 type errors, outside every gate" (2026-09-02) and
AGENTS.md's "10" are both superseded by that measurement.
