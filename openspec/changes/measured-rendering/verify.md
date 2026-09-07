## Status

R10 starts from integrated35576d79 in isolated .worktrees/refactoring-r10 / refactor/measured-rendering. Approved refactoring plan§67R10 is authority. Five baseline configurations are measured below; optimization and budgets remain pending.

Locked Bun install passed after sandbox temp/cache permission escalation (102packages,1.95s). Browser skill was read and runtime initialized; `agent.browsers.get("iab")` reported unavailable and documented discovery returned an empty list. Interactive in-app browser is unavailable. Parent confirmed canonical Playwright Chromium is appropriate for repeatable measurements. Measurement ports5500/5600/6600 are assigned to this worker, subject to actual listener verification. Parent must grant a quiet heavy-check window before timed runs.

## Commands and measurements

`bun run dev:setup` passed, using repository example configuration. No private environment was copied. FE root typecheck passed after correcting dataset index access; fixture ESLint passed after correcting numeric template interpolation and unknown JSON boundary typing. The later eight-step geometry addition still needs types/lint.

Canonical smoke: `bin/with-heavy-lock.sh -- env CI=1 E2E_PORT_SHIFT=2400 R10_BASELINE=1 R10_BASELINE_SMOKE=1 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/rendering-baseline.spec.ts --grep '100 rows / 2 steps / sparse'`. Initial run failed on the fixture's accessible-name locator: `Name of 010` matched the hundred-row number0100, receiving Row0009 instead of Row0000. Readiness now uses the exact seeded row identity. Repeated smoke passed:1test8.5s, stack-inclusive20.0s. No measurements from the failed smoke are accepted.

Full matrix command omitted the smoke option and grep, attempting3cold contexts+7warm reloads per configuration. Parent held all other heavy checks. Application source remained35576d79. Five cases passed in11.0minutes;500/2/dense was deliberately interrupted after2.1minutes to release the shared measurement window, process exit130. It is unmeasured, not a passed case. Six later configurations did not run. Listener verification found no remaining listeners on5500/5600/6600 after shutdown.

Raw completed observations are retained under [evidence/baseline](evidence/baseline). Environment: Chromium151.0.7922.34, Darwin25.5.0 arm64, Apple M1 Pro,1400×900, UTC/en-US, no throttling, warm Vite/backend with fresh browser contexts. Paint times are double-rAF opportunities; latency samples use readiness/long-task observers but no precise-coverage profiling. Coverage counts come from a separate instrumented pass.

| Configuration | Completed samples | Mounted cells, folded | Mounted cells, unfolded | Test duration |
| ------------- | ----------------- | --------------------- | ----------------------- | ------------- |
| 100/2/sparse  | 3cold+7warm       | 1500                  | n/a                     | 26.1s         |
| 100/2/dense   | 3cold+7warm       | 1500                  | n/a                     | 31.3s         |
| 100/8/sparse  | 3cold+7warm       | 2100                  | 5300                    | 48.3s         |
| 100/8/dense   | 3cold+7warm       | 2100                  | 5300                    | 52.0s         |
| 500/2/sparse  | 3cold+7warm       | 7500                  | n/a                     | 6.2m          |

The500-row case records warm ready-paint opportunities15.8–18.5seconds and broad Find2.78–3.56seconds. This development-build evidence justifies addressing scaling; it is not a production-build performance claim. Initial remaining matrix cases will use1cold+1warm to keep measurement windows bounded. No percentile or robust variance claims will be made from those limited samples. Budgets await the complete configuration matrix and first-slice review.

## Failure proof table

### Split-phase correctness execution

The first runtime attempt failed before tests: Playwright refused trace inside a describe group because it changes worker fixtures. The option now lives at file scope. The subsequent100/2/sparse run passed all three phases in17.6s: latency5.8s, coverage4.3s, Gantt3.2s. Parent checks could run concurrently; all emitted evidence is explicitly measurementUse=correctness-only and is not an accepted timing baseline.

Independent reads of the three JSON files confirmed complete status, exact stage lists (cold-context/warm-reload; precise-coverage; gantt-open), source35576d79 and the same exact fixture SHA256. They are preserved under evidence/correctness-phases. These files survive later Playwright test-results replacement. The previously observed omitted-flush and suppressed-write faults establish that the checkpoint writer can fail; this run establishes all three measurement phase callers actually persist their observations.

Next quiet-window proposal: latency /100rows /2steps /sparse only,3cold+7warm, first R10_BASELINE_TRACE=1 then0, R10_MEASUREMENT_USE=trace-characterization. Allow at most60seconds wall-clock per leg,120seconds total, including fresh stack startup/shutdown. Estimated20–40seconds per leg from the original repeated100-row case; this remains an estimate. Preserve each completed JSON before launching the next leg, require matching fixture hash/source, and keep source frozen between legs. An incomplete leg remains incomplete and cannot support an A/B conclusion. No such characterization has run yet.

### Interrupted 1000-row attempt and measurement protocol revision

The single1000/2/sparse case ran in a confirmed quiet window starting2026-09-06 13:52:26UTC. Backend setup verified in13.496s. It was deliberately interrupted before the six-minute wall deadline: exit130,1interrupted,5.7minutes test duration. By13:58:25UTC all reserved listeners were absent and the window was released. No measurements.json completed; this configuration remains unmeasured. Trace inspection located the interrupted stage: clearing selective Find before the separate coverage pass, after both timing sample operations had reached their final read. No trace-recovered timing values are accepted.

Canonical trace=retain-on-failure records during measurements; this attempt's browser trace was35,171,132bytes. Earlier timings are therefore traced development observations, not directly comparable with future trace-disabled samples. Their structural mounted counts remain direct DOM observations. The overhead itself is unmeasured. All earlier raw files lack an exact fixture hash and retain legacy status; do not infer that hash from the revised fixture.

The fixture now declares separate latency/coverage/Gantt cases for every configuration, defaults measurement tracing off, and enables it explicitly through R10_BASELINE_TRACE=1 for A/B characterization. Every checkpoint includes source HEAD, git status, SHA256 over the exact measurement files, phase, trace mode, environment and last completed stage. Each sample is flushed before later work; overall status remains running until the complete phase finishes. Partial files cannot claim a completed phase or configuration. Normal browser gates skip these36 exploratory cases; fixture correctness cases run normally.

Checkpoint tests first failed collection on the absent implementation, then passed2/2 in5.0s. Omitting the sample flush failed on expected cold-context/received setup. Suppressing the initial filesystem write error failed because the promise resolved instead of rejecting ENOENT. Both faults were restored before Proof comments were retained; restored2/2 passed3.1s. Scoped ESLint passed after import sorting and replacing empty fixture patterns. FE root typecheck passed for the phase split and evidence helper. Split phase browser execution and traced/trace-disabled A/B characterization remain pending; no revised latency measurements have been accepted.

Correctness runs used the canonical heavy lock, CI=1, E2E_PORT_SHIFT=2400 and `apps/fe-01/e2e/rendering-fixture.spec.ts`. Initial3/3 passed7.1s. All three guards were removed together:3/3 failed, exit1. The identity fault initially also intercepted later malformed estimate commands, producing an incidental route assertion; interception was narrowed to createWorkItem batches and this guard was removed alone for a clean repeated proof. Restored3/3 passed6.9s, exit0. Proof comments were written from the observed output. No performance samples were accepted during these runs; parent checks were active.

| Guard                     | Injected fault                                                               | Observed failure                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP setup refusal        | Remove response.ok rejection                                                 | `rendering setup reports an actual backend refusal`: promise resolved to actual API `{error:"not_found",at:0,kind:"createWorkItem"}` instead of rejecting |
| Batch row identity        | Remove index/ref/id guard; actual successful create response has IDs removed | `rendering setup refuses a successful batch without its row identity`: expected missing row identity0, received downstream real setEstimate400 missing_id |
| Nonzero measurement frame | Remove positive area guard; actual frame display:none                        | `rendering measurement refuses a frame with no layout area`: promise resolved with width0/height0 instead of rejecting                                    |

Scoped ESLint of all three rendering fixture/spec files passed. `bunx tsc --build --force apps/fe-01/tsconfig.json` passed, including the latest geometry and fixture regression changes. An earlier attempt named a nonexistent tsconfig.root.json and exited TS5058; it compiled nothing and is not accepted type evidence. Correctness logs: `/private/tmp/r10-fixture-green.log`, `/private/tmp/r10-fixture-fault.log`, `/private/tmp/r10-fixture-identity-fault.log`, `/private/tmp/r10-fixture-restored.log`. Logs are local execution evidence, not portable artifacts; the observed failure table above is retained in the change.

## PR preservation check — 2026-09-07

The measurement plan, harness and evidence were moved without production changes onto
`change/measured-rendering-plan`, then rebased onto `origin/main` at `f5c919d2`. Fresh checks
under the repository-pinned Bun1.4.2 passed: `fe-01:typecheck`; `fe-01:lint`;
`tool-git-hooks:lint`; repository `format:check --all`; strict validation of this OpenSpec
change; and the five rendering evidence/fixture browser cases in11.9seconds.

The first two browser launches were refused before test collection because the execution
sandbox denied loopback binds while Bun reported `EADDRINUSE`. A minimal Bun server and
`curl`/`nc` reproduced that boundary. The identical locked command passed with local-network
permission; neither refused launch is test evidence.

The first install after the toolchain merge used the host's stale Bun1.3.14 and omitted
ESLint's nested Ajv6, so lint stopped before reading a source file. Bun1.4.2 reinstalled the
same lockfile with that dependency present. The first Playwright1.63 run then passed the two
non-browser cases and refused the other three before their bodies because Chromium revision
1243 was absent. Installing that revision made the unchanged five-case command pass; the
failed launch is dependency setup evidence, not a test failure.

## Skipped / pending

Seven matrix configurations, optimization, structural/latency gates, full workspace/Chromium gates and independent review remain pending. The original12 experiments are now36 separate opt-in phase cases that intentionally skip in normal browser gates; future acceptance tests must run normally. In-app browser inspection unavailable as recorded above.
