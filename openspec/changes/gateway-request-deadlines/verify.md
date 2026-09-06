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
