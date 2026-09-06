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
