# Gateway request deadlines — backend checkpoint

2026-09-06; isolated refactoring-r9 worktree, based on362c29a8 plus parent-cherry-picked R7 as8d848903. Backend implementation only; gateway tasks and final full gates pending. No commits made by this agent.

## Commands and results

- OpenSpec CLI1.3.0 new/status/instructions apply succeeded with sdd-lean,15 ordered tasks. Initial optional telemetry DNS flush failed; later calls OPENSPEC_TELEMETRY=0. No repository lockfile changed.
- Initial focused push/broadcaster/durability baseline:11 pass,26 assertions.
- Restored backend scope: `bun test apps/be-01/src/service/push-transport.test.ts apps/be-01/src/service/push-client.test.ts apps/be-01/src/service/push-deadline.test.ts apps/be-01/src/service/gateway-broadcaster-durability.db.test.ts apps/be-01/src/service/gateway-broadcaster.test.ts apps/be-01/src/service/plan-commands.db.test.ts apps/be-01/src/service/step.service.db.test.ts` —69 pass,0 fail,203 assertions,7 files,5.43s. `/private/tmp/r9-final-tests.log`.
- `bunx nx typecheck be-01 --skip-nx-cache` source+spec passed. `/private/tmp/r9-type-final.log`. Earlier new-test rename errors were fixed, not waived.
- ESLint all changed backend source/test files passed with Nx graph available; initial standalone run without graph skipped boundary rule and is not that evidence. `/private/tmp/r9-lint-final.log`.
- Prettier write completed; final format-check and OpenSpec validation/restoration runs recorded below when finished.
- Real Bun loopback tests required escalation: sandbox listener returned EADDRINUSE on port0. Escalated run passed2/2; no external server used. Server-side cancellation observed in both header/body cases, not merely wrapper rejection.

## Failure proofs

| Guard / behavior              | Named fault or pre-implementation absence | Observed failure                                                                                                                            |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| signal passed to fetch        | omit signal after implementation          | deterministic6pass/4fail; both real transport tests expected server cancellation true, receivedfalse while deadline wrapper still rejected  |
| overall budget                | replace configured overall with150000     | 6 deterministic failures; bounded retry pending at literal1000; clock-admission calls6 instead of1                                          |
| retry of attempt expiry       | original no timeout retry                 | settledtrue at400 instead offalse                                                                                                           |
| budget validity               | original no validation                    | constructor did not throw for invalid budget/count                                                                                          |
| acknowledgement schema        | original unchecked cast                   | malformed trusted response resolved instead of rejected                                                                                     |
| transient classification      | original no socket retry                  | calls1 instead of2                                                                                                                          |
| unknown failures              | classify all Error as transient           | original TypeError replaced by DeadlineExceeded after15s                                                                                    |
| timer cleanup                 | omit cancelTimer in finally               | successful socket-retry case active timers3 instead of0                                                                                     |
| already-cancelled caller      | ignore pre-aborted parent                 | actual client fetch calls1 instead of0; test reordered to assert no fetch before comparing error so wrong body validation is not the oracle |
| delayed callback timing       | original no clock check                   | returned delivered1 after250ms instead ofError                                                                                              |
| admission after clock expiry  | original no absolute admission check      | calls6 instead of1 after clock251ms, overall250ms                                                                                           |
| write-lock independence       | push inside durable record turn           | real-PushClient DB test second writer enteredfalse instead oftrue during held transport                                                     |
| committed publication success | rethrow push failure                      | same DB test settledfalse instead oftrue after deadline despite durable event                                                               |

Fault logs `/private/tmp/r9-{no-signal-fault,overall-fault,unknown-fault,cleanup-fault,alreadycancel-fault2,lock-fault,commit-fault}.log`; real-signal failure output observed directly. Source restored after each injection. Proof comments are written from these outputs, never guessed.

## Composition and limits

PushClient now requires fetchImpl, timers, attemptMs and overallMs. services.ts explicitly supplies systemTimers/global fetch,5000ms attempt,15000ms overall and maxRetries5. The latter still means additional attempts; defaults to5 only when omitted. Test callers updated in the same slice. No hidden global fetch/timer/budget defaults remain inside PushClient. Legacy optional test sleep is cancellably awaited; real composition uses timer-owned cancellable delay.

Runtime helper stages at be-01/src/runtime/deadline.ts, to move once into runtime-portable before gateway reuse; no root project/config changes yet. Timing values are an initial bounded policy, not claimed production latency measurements. Existing InternalPushResponse schema validates trusted success bodies. No background worker added. Synchronous CPU/event-loop stalls cannot be preempted; monotonic clock checks prevent accepting a late response or admitting retries after expiry.

Gateway forward/resume and connection cancellation remain pending despite R7 handoff being available. Preserve its presence/ingress tests when gateway work starts. No whole-workspace or browser gate was run in this isolated worker; parent owns final frozen gates. OpenSpec must remain unarchived until both backend and gateway tasks are actually complete.

## Final backend restoration

After the last faults, source restored: backend root source+spec typecheck passed again; OpenSpec strict validation reports `Change 'gateway-request-deadlines' is valid`; latest deadline/durability restoration16pass/61assertions. Scoped restored-file ESLint and git diff --check passed. Required-composition fault omitted overallMs at services.ts:158; tsc emitted TS2345, missing required overallMs, from both source/spec compilation. No assertion that malformed callback/body cancellation works derives from that type proof; those retain separate transport tests above.

Backend files held for independent review. Task2.3 awaits that review; gateway3.x and full-gate4.1 remain pending. No commit or shared runtime project created in this checkpoint.

## Backend review correction: permanent refusal diagnostics

Independent review found that a permanent 400 with a stalled diagnostic body could retry when the body deadline expired. Added `does not retry a permanent refusal when its diagnostic body times out` with attempt100ms, overall1000ms and five retries enabled. The pre-fix test failed at600ms: expected one fetch, received two. It separately observes body abortion at100ms, settled failure after the backoff window, no later attempts and no remaining timers.

The client now records terminal status before awaiting diagnostics and excludes that attempt from retry classification even when reading diagnostics throws DeadlineExceeded or a modeled socket error. Diagnostic reading remains bounded and uses the same transport AbortSignal; unknown errors still propagate. Removing only the terminal-status catch guard reproduced expected1/received2; restored before final verification.

Fresh restored verification: the seven-file focused backend regression command above passed70 tests,0 failures,209 assertions, including both real loopback cancellation cases. `bunx nx typecheck be-01 --skip-nx-cache` passed source and spec compilation. Gateway implementation and broad gates remain pending; this correction is held for re-review.

Scoped ESLint initially rejected a closure-assigned scalar as always falsy (TypeScript callback control-flow limitation). The per-attempt terminal decision now uses a mutable response-state property, preserving the same behavior without an assertion or lint suppression. Restored deadline tests passed13/51 assertions and scoped ESLint passed after that representation correction.

## Backend independent re-review

Approved after the permanent-status correction; no remaining backend findings. Reviewer verified the terminal decision precedes diagnostic reading and checked the five-retry, body-abort, terminal-settlement and timer-cleanup oracle against the recorded guard-removal failure. No additional tests were run by the reviewer. Gateway work and parent integration gates remain pending.

## Gateway continuation after R7 handoff

Backend review correction was approved and committed as ff8b0bfc; gateway continuation starts from that checkpoint with R7 already cherry-picked as8d848903. Shared runtime code moved once to libs/runtime-portable (ring:adapter/runtime:isomorphic/product:wbs), with a minimal Nx project and root aliases. Shared deterministic clock moved to its testing subpath; backend/gateway never import one another. No root package/lock changes.

ForwardClient and extracted ResumeClient use requestBackend with required fetch/timers/attempt/overall inputs. Both retain one attempt. Production buildApp supplies5000ms attempt/15000ms overall explicitly; the earlier deadline bounds the one attempt through status/body/schema processing. Health retains its separate2000ms policy. Connection-owned abort occurs before close waits for joined; late controller errors/replay do not send frames or increment failure metrics. Existing live forward-unavailable and resume-denied/ack mappings remain.

### Observed gateway fault proofs

| Guard                            | Named fault                                                   | Observed failure                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active transport signal          | omit fetch signal                                             | Four deterministic header/body cases expected cancelled=true, receivedfalse. Four real live-socket deadline cases timed out waiting for backend request/stream cancellation even though wire timeout replies arrived. |
| Overall budget                   | use attemptMs alone                                           | Four deterministic cases cancellationfalse at literal250ms.                                                                                                                                                           |
| Attempt budget                   | use overallMs alone                                           | Forward/resume settlementfalse at literal100ms.                                                                                                                                                                       |
| Budget validation                | remove positive finite check                                  | Both clients issued one request rather than zero for invalid input.                                                                                                                                                   |
| Status before parsing            | remove response.ok guard                                      | Client tests accepted success-shaped503 bodies instead ofError. Real socket emitted replay data and resume_ack count1 instead of resume_denied unavailable and empty ack.                                             |
| Trusted response schema          | bypass forward/resume parser                                  | Both malformed-response tests received {ack:"wrong"} rather thanError.                                                                                                                                                |
| Connection abort                 | omit close abort                                              | Initially forward failure metric1 vs0 and resume dropped frames2 vs0. Strengthened cancellation window: all four cases time out awaiting cancellation within250ms, before independent1000ms attempt expiry.           |
| Parent signal propagation        | omit parent passed to deadline helper                         | All four close cases time out awaiting cancellation within250ms. This explicit window prevents the later attempt timeout hiding a missing connection cancellation link.                                               |
| Late failure/success suppression | remove controller lifetime checks                             | Forward error, resume_denied/ack, and successful replay/ack emitted after close in the three controller negatives.                                                                                                    |
| New library source typecheck     | add const deliberatelyWrong:number='not a number' to index.ts | runtime-portable:typecheck failed TS2322 at index.ts10. Source restored.                                                                                                                                              |

All faults were observed and restored before the latest checks. No guessed Proof comments. The proposed extra pre-dispatch guard was removed: a held-verifier real-socket probe stayed CONNECTING at verifies2 and never established its claimed queued-message window. Existing R7 lifecycle guards remain, and their whole gateway suite passes.

### Fresh restored commands

- `bunx nx test gw-01 --skip-nx-cache`:121pass,0fail,3426assertions across15files (3.80s), including real headers/body timeout and close, status503 replay refusal, health, ingress, JWT and R7 presence/join/leave regressions. Log:/private/tmp/r9-gateway-final-tests.log.
- The seven-file backend push/transport/deadline/broadcaster/durability/plan-command/step command recorded above:70pass,0fail,209assertions after the shared helper move. Log:/private/tmp/r9-backend-move-restored.log.
- `bunx nx test runtime-portable --skip-nx-cache`:2pass,0fail,6assertions.
- `bunx nx run-many -t typecheck,lint --projects=gw-01,runtime-portable --skip-nx-cache`:all four targets passed after final fault restoration; source and spec projects compile. Log:/private/tmp/r9-gateway-final-checks.log.
- `bunx nx run-many -t typecheck,lint --projects=be-01 --skip-nx-cache`:both passed after helper move. Log:/private/tmp/r9-backend-move-checks.log.

An earlier root `bun test apps/gw-01/src libs/runtime-portable/src` directory-filter command also matched emitted dist JS, producing13 module-resolution errors; it additionally saw one initial ingress socket-open failure. This was not counted as passing evidence. The configured Nx gateway target avoids dist collection and passed the full suite twice (120 before the added503 case,121 after). Real listeners required authorized escalation; no external service was used.

Independent gateway review approved the scoped implementation with no findings (task3.4). Full workspace/browser gates and final integration remain parent-owned and pending (task4.1). No performance-optimal timeout claim, background worker, or task-completion/archive claim is made from this scoped verification.

## Gateway independent review

Parent reported independent R9 gateway review approved with no findings. Task3.4 is complete; task4.1 remains pending for parent integration and frozen full gates. This worker commit records the reviewed implementation and scoped evidence, without claiming a full workspace or browser gate.
