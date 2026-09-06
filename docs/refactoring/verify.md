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
