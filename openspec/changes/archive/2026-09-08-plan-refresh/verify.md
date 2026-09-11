## Status and scope

Implemented on `refactor/plan-refresh`, isolated worktree `.worktrees/refactoring-r1`, based on `362c29a8`. No commit or staging performed by the worker. Parent owns integration, independent review and full workspace/Chromium gates. Those remain pending; scoped successes below are not whole-gate claims.

The transport integration uses real `httpProjectApi` parsing and real `subscribeToProject` with held fetch responses and a socket/timer transport fixture. Gateway ingress separately uses actual listening WebSockets. The backend broadcaster ordering test uses real SQLite, GatewayBroadcaster, WriteLock and PushClient with a held fetch transport. These are complementary boundary tests, not one end-to-end socket/browser composition.

## Commands and observed results

All commands run in the isolated worktree; Vitest commands run from `apps/fe-01`. Logs are local `/private/tmp/r1-*.log` and are not committed artifacts.

- Baseline: `TZ=UTC bunx vitest run src/lib/wbs-api.test.ts src/lib/project-stream.test.ts src/components/wbs/plan-read-and-write.test.tsx --no-file-parallelism --maxWorkers=1 --minWorkers=1`: 112 passed, 3 files (`r1-baseline.log`).
- First red: real API lifetime overlap installed `old-row` instead of `new-row`; held renamed step with competing tree disappeared, while its no-competing control passed (`r1-first-red.log`).
- Initial adaptation exposed 36 existing host failures, traced to mutation refresh joining initial work rather than creating a later obligation. Fixed; the next run exposed retry after failed bootstrap and a fixture row-id collision. Corrected rather than excluding suites (`r1-adapter-first/second/third.log`).
- Coordinator/stream/host iteration: 91 passed (`r1-second-green.log`). Earlier red caught both old-API mutation toast leakage and a second sequence gap lost during resync (`r1-second-red.log`).
- Expanded regression: `TZ=UTC bunx vitest run src/lib/plan-refresh.test.ts src/lib/plan-refresh-stream.test.ts src/lib/project-stream.test.ts src/lib/wbs-api.test.ts src/test-tiers.test.ts src/components/wbs/plan-read-and-write.test.tsx src/components/wbs/plan-chart-seam.test.tsx src/components/wbs/plan-keyboard.test.tsx src/components/wbs/plan-structure.test.tsx src/components/wbs/plan-dependencies.test.tsx src/components/wbs/gantt-panel.test.tsx src/components/wbs/plan-table.test.tsx src/components/wbs/project-page.test.tsx src/components/wbs/plan-cards.test.tsx --no-file-parallelism --maxWorkers=1 --minWorkers=1`: 765 passed, 20 failed, all failures in Gantt's shared fake refusing the required initial marker read (`r1-expanded-final.log`). The other 13 files passed. The Gantt fixture now explicitly returns an empty marker list while retaining refused writes. Complete Gantt rerun: 222 passed (`r1-gantt-final.log`).
- Auckland: `TZ=Pacific/Auckland bunx vitest run --config vitest.zoned.config.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1`: 3 passed, 2 files (`r1-zoned-final.log`).
- `bun test apps/gw-01/src/ws-ingress.integration.test.ts apps/gw-01/src/controller/ws.controller.test.ts apps/be-01/src/service/replay-orchestrator.test.ts`: 51 passed, 183 assertions (`r1-empty-cursor-green.log`). Actual gateway ingress accepts -1 and receives event0 from its replay transport fixture, rejects -2 and still pongs; real SQLite replay orchestrator behavior is separately covered. Old >=0 bound failed with `invalid_payload` then `pong`, no requested replay frames (`r1-empty-cursor-red.log`).
- `bun test apps/be-01/src/service/gateway-broadcaster-order.db.test.ts`: 1 passed, 5 assertions (`r1-order-green.log`). While B's fetch is held, production publisher durably records B and C and delivers C first; release yields delivery order [1,0].
- `bunx nx typecheck fe-01 --skip-nx-cache`: passed, source/spec/e2e root references (`r1-typecheck-final.log`). Earlier run caught the new test's `afterEach` returning VitestUtils; corrected to return void.
- `bunx nx run-many -t typecheck -p gw-01,contracts --skip-nx-cache`: both projects passed (`r1-gw-types.log`).
- Explicit ESLint over changed FE source/tests/config, contracts/ws and gateway tests passed (`r1-lint-final.log`). Cleanup of Gantt fixture and obsolete API-cache JSDoc passed scoped lint (`r1-cleanup-lint.log`). New broadcaster/live-gap additions require final checks recorded below.

## Observed mutation proofs

Each injection was run sequentially and restored in `finally`; no fault is left active. Log names below have prefix `/private/tmp/r1-proof-` and suffix `.log`. Proof comments were added only after the corresponding failure output was read.

| Fault                                   | Production path / assertion                                              | Observed failure                                       | Log                               |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| Restore URL-only request map            | real httpProjectApi across API owners                                    | old-row instead of new-row                             | url-only-sharing                  |
| Restore whole-host global generation    | WbsTable held renamed steps + later tree, alongside no-competing control | Renamed step missing; control passes                   | global-generation                 |
| Drop trailing read                      | coordinator invalidation during held tree                                | expected two requests, got one; B has no covering read | drop-trailing-read                |
| Install superseded response             | coordinator while covering response held                                 | installed generation2 replaced generation1 prematurely | install-superseded                |
| Clear all stale on unrelated success    | coordinator marker failure + tree success                                | [] instead of [markers]                                | clear-unrelated-stale             |
| Acknowledge arbitrary future tree seq   | real API/stream disconnect before marker frame                           | resume cursor1 instead of0                             | ack-future-tree                   |
| Ignore unknown sequence gap             | coordinator live C after missing marker B                                | undefined instead of Missed marker                     | ignore-sequence-gap               |
| Remove disposal flag                    | coordinator late resolve and reject                                      | old snapshot identity changes after departure          | forget-disposal                   |
| Skip covered empty baseline replay      | real API/stream event0 before registration                               | undefined instead of Launch                            | skip-empty-baseline-resume        |
| Start marker read before tree anchor    | real API/stream held anchor                                              | undefined instead of Launch                            | parallel-pre-anchor-resources     |
| Publish first tree before initial steps | WbsTable held initial steps                                              | textarea present instead of null                       | publish-initial-tree-before-steps |
| Skip marker reread after refusal        | WbsTable peer-deleted marker then refused rename                         | deleted marker span remains instead of null            | skip-marker-refusal-read          |

Additional observed red/green checks: project-only mutation guard leaks one old API refusal toast (`r1-second-red.log`); failure to retain another gap during ongoing resync leaves its marker absent (same log); old resume bound rejects the empty-history socket request (`r1-empty-cursor-red.log`).

The initial publication fault first passed the existing dependency-highlight case when run alone despite the expanded run finding a timing failure. It was not accepted as proof. A new held initial-steps fixture asserts within the exposed-editor window and the same fault then failed on the textarea presence. The gap assertion initially failed by dereferencing undefined; it was tightened to assert the missing marker value and rerun to observe the intended assertion. No guessed Proof claims were kept.

## Remaining checks and limits

- Parent-owned complete workspace and Chromium gates, browser peer/marker/editor-selection checks, independent review, and integration with newer feature commits remain pending.
- Production broadcaster ordering plus frontend live-gap recovery are separate boundary tests. No cross-app TypeScript runtime dependency was introduced to force an artificial composition.
- Held host overlap now covers steps (including a no-competing control), grouped directory labels and markers after a newer tree installs; initial steps are held before first editor publication. Coordinator tests separately cover grouped partial failure and superseded completion.
- Initial OpenSpec creation emitted an optional telemetry DNS failure but returned success and created the change. Subsequent calls disable telemetry. Artifact validation is recorded after completion below.

## Final additions

- Actual HTTP/stream live-gap case joins the three resume races: 4 passed (`r1-gap-stream-green.log`). It installs marker B after only overtaking tree C arrives and performs exactly one additional marker read.
- Mutating gap recovery to request only C's known tree scope fails on `undefined` instead of `Launch` in that actual HTTP/stream case (`r1-proof-live-gap.log`). Restored before green verification.
- Retaining/reusing the disposed owner across StrictMode setup fails on zero subscriptions instead of one (`r1-proof-strict-reuse.log`). Restored; adjacent Proof records that actual assertion.
- Generic no-history -1 behavior remains covered by the existing stream tests. The positive-baseline audit below completed task3.0.

Positive-anchor audit: hardcoding -1 initially passed at both factory seams because the adapter's immediate seen(anchor) repaired the number before socket open. Removed that redundant initialization: the explicit baseline initializes the stream; seen now only advances later covered events. With that single initialization path, both faults fail on outbound `project:p2: -1` instead of7 (`r1-proof-page-baseline.log`, `r1-proof-adapter-baseline.log`). No extra guard was invented. Task3.0's factory proof is now observed.

## Final restored verification

- `TZ=UTC bunx vitest run src/components/wbs/plan-read-and-write.test.tsx src/components/wbs/plan-chart-seam.test.tsx src/components/wbs/project-page.test.tsx src/lib/plan-refresh-stream.test.ts src/lib/plan-refresh.test.ts src/lib/project-stream.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1`: **169 passed**, six files,38.47s (`r1-ownership-final.log`). This includes both new host overlap tests, explicit positive baseline initialization, StrictMode, installed event coverage and the four HTTP/stream races.
- Final `bunx nx typecheck fe-01 --skip-nx-cache`: passed (`r1-ownership-types.log`). Additional BE+FE root typechecks passed after adding the actual broadcaster test (`r1-additions-types.log`).
- New backend/stream additions lint passed (`r1-additions-lint.log`). Final host/page lint first identified two void shorthand callbacks and untyped JSON access in the new tests; corrected with typed fixture access and block callbacks (`r1-ownership-lint-fix.log`).
- `OPENSPEC_TELEMETRY=0 bunx openspec validate plan-refresh --json`: valid, zero issues (`r1-openspec-validation.log`).

Task3.1a is satisfied through explicitly composed evidence: production broadcaster/SQLite test proves overtaking is possible, the real frontend stream/API test feeds that order and proves bounded recovery without B or another frame, and its known-scope-only mutation loses Launch. This is not a claim of an end-to-end browser/WebSocket pipeline. Parent-owned browser/full gates and independent review remain unchecked.

## Independent review fixes: replay recovery and stale sockets

Independent review found two Important issues after the first handoff. A refused resume (or an empty acknowledgment) called initialize, whose new baseline epoch reopened the subscription, whose replay was refused again. The reviewer reproduced five full reads and sockets in100ms. Separately, physical callbacks from a replaced socket could mark the current socket disconnected or trigger resync/presence effects.

The adapter now retains the registered stream across anchored recovery and advances its seen cursor once covering reads finish. There is no automatic new socket/replay after that read, so persistent refusal has no self-generated retry cycle. A real disconnect still reconnects from the installed cursor and can request another recovery. Initial factory-baseline semantics remain unchanged. Physical socket callbacks capture an epoch; close invalidates it before scheduling reconnect. Unsubscribed/replaced sockets have no callback authority.

The HTTP/stream fixture was corrected to call initialize on null controls, matching production. It now proves registration-window changes install after denied replay without another socket and that a second registration gap during a held recovery retains its covering read.

Observed red and mutation evidence (all injected changes restored):

| Fault                                                       | Production path                                                               | Observed failure                                                     | Log                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Restore baseline epoch socket replacement                   | actual ProjectPage -> usePlanRead -> subscribeToProject, denial and empty ack | two sockets instead of one after first covering recovery, both cases | r1-review-proof-replace-after-refusal.log    |
| Ignore captured physical epoch                              | actual subscribeToProject old close after new resume_ack                      | connected false instead of true                                      | r1-review-proof-stale-socket-callbacks.log   |
| Same epoch fault, stale open                                | actual subscribeToProject                                                     | six sent frames instead of three                                     | same log                                     |
| Same epoch fault, stale resync                              | actual subscribeToProject                                                     | one change callback instead of zero                                  | same log                                     |
| Same epoch fault, stale presence                            | actual subscribeToProject                                                     | one presence callback instead of zero                                | same log                                     |
| Discard initialize requested during held recovery           | real HTTP/stream, second reconnect registration gap                           | Launch instead of After reconnect                                    | r1-review-proof-lose-reconnect-recovery.log  |
| Report synchronization after recovery callback unsubscribes | actual subscribeToProject                                                     | [true] instead of [] connection reports                              | r1-review-proof-settle-after-unsubscribe.log |

`r1-review-red.log` captured the original three failures before implementation. The original combined stale callback probe was split into four cases so a later stale resume cannot conceal the earlier false connection report. Proof comments use the split observed failures.

Restored regression: `TZ=UTC bunx vitest run src/components/wbs/plan-read-and-write.test.tsx src/components/wbs/plan-chart-seam.test.tsx src/components/wbs/project-page.test.tsx src/lib/plan-refresh-stream.test.ts src/lib/plan-refresh.test.ts src/lib/project-stream.test.ts src/lib/wbs-api.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1`: **220 passed**, seven files,39.30s (`r1-review-regression.log`). `bunx nx typecheck fe-01 --skip-nx-cache` passed (`r1-review-types.log`). Scoped lint flagged two async test callbacks without awaits; explicit microtask waits preserve the held-recovery act boundary, with final lint recorded after that correction. Parent-owned full gates and independent rereview remain pending.

Final review-fix checks: corrected persistent-refusal cases both passed (`r1-review-final-persistent.log`); all six changed source/test files passed scoped ESLint (`r1-review-lint-final.log`, empty output, exit0); OpenSpec validation remained valid with zero issues (`r1-review-spec-validation.log`); `git diff --check` passed. Source held for independent rereview.

## Independent rereview approval

On2026-09-06 the parent reported independent rereview approval: both Important findings (persistent replay refusal loop and stale socket callbacks) are resolved. Task5.5's review/validation portion and6.4 are complete. Integration, current-branch adaptation of the new broadcaster test to R9 PushClient dependencies, full workspace gate and complete Chromium gate remain parent-owned and pending. The parent authorized committing the explicit owned R1 paths with hooks enabled; this worker has not claimed those integration gates passed.

## Real-browser peer closeout

2026-09-08, archive branch based on merged `main` at `5516d453`:

- `CI=1 E2E_PORT_SHIFT=1900 ... playwright test ... live-caret.spec.ts`: 2 passed in 12.2s on an isolated stack at 5000/5100/6100. The existing two-browser rename case observed the bystander revision before preserving the focused editor's node, typed value, backward selection and caret. The new two-browser marker case observed the peer-created `Peer checkpoint` chip before preserving the same editor state.
- Marker-scope fault: changed `resourcesFor('calendar_markers_changed')` from `['markers']` to `['tree']`. The new case failed at its installed-output window after 30s: `the peer marker never reached this session`, expected count 1, received 0. Source was restored; the complete two-case file then passed.
- `bunx eslint apps/fe-01/e2e/live-caret.spec.ts`: passed.
- `bunx nx typecheck fe-01 --skip-nx-cache`: passed, including the e2e project.
- Prettier and `git diff --check`: passed.

This completes task 5.2 with a real second browser, backend write, gateway event and browser-rendered marker. The integrated gate and merged disposition are recorded below.

## Integrated closeout

2026-09-09, archive branch frozen first at `61aef8e1`, ten commits ahead of and zero behind
`origin/main` at `5516d453`:

- Complete Chromium on isolated ports 5000/5100/6100: `CI=1 E2E_PORT_SHIFT=1900 bunx nx e2e
fe-01 --skip-nx-cache` passed **315**, skipped the **37** opt-in rendering measurements, and
  failed **0** in 17m53s. The peer rename case, the new peer marker case and the platform-neutral
  active-editor fixture all passed inside that whole run.
- `bin/h2puni-gate.sh` completed its Nx run on Darwin: **85 targets passed**. Its three failed
  targets were reproduced as host/toolchain limits, not hidden: bare Python lacked the locked
  solver packages; the shell had Bun 1.3.14 instead of `.bun-version`'s 1.4.2; and the Linux deploy
  helper's GNU `mv -T` is rejected by Darwin `/bin/mv` on the unchanged `origin/main` line.
- After installing Bun 1.4.2 and running `bunx nx run solver-py:setup-macos`, the locked solver
  environment reported Python 3.14.2, `wbs-solver` 0.1.1 and a feasible golden request.
  `solver-py:test` then passed. `tool-devsync:test` retained six Darwin-only failures because
  `/bin/mv` exits 64 on `-T`; the production poller runs on Linux, and changing that deploy helper
  is outside this no-production-code archive branch.
- `be-01:test` passed **2,046**, skipped **2**, failed **0**, then reported two asynchronous
  `SQLITE_IOERR_VNODE` errors after a test-owned database was removed. The focused production
  coordinator plus following saved-plan-list reproduction passed **36/36** with 218 assertions.
  Exact-base GitHub Actions run 34272524792 is green on `5516d453`, including the Auckland tier;
  this branch changes only archive/spec documents and the two browser tests named above.
- Before the whole runs, scoped ESLint, Prettier and the full FE TypeScript build passed. The
  browser portability fix was also run alone and passed before the complete Chromium run.
- After sync, the preservation oracle matched all **89** requirement/scenario headings across the
  seven R1-R9 capability specs. `openspec validate --all --strict` passed all **61** items;
  Prettier and `git diff --check` passed on the archived and queue documents.

The original production refactor remains the squash merge `cbad68af`. HTTP migration and the
checked R10 slices are already on the base. This closeout adds no production source: it preserves
the nine R1-R9 contracts, supplies the two missing browser oracles, and records every local gate
limit rather than converting it to a green claim.
