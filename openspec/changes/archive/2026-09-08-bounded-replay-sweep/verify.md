# Verification

2026-09-06, refactoring worktree. No commit or broad gate run by this worker.

## Commands and outcomes

- `bun test apps/be-01/src/service/replay-buffer.test.ts --test-name-pattern 'bounds record iterator'` against the original sweep: 0 pass, 3 fail. Visits were 101, 1,001 and 10,001 against a budget of 3.
- Initial `bun test apps/be-01/src/service/replay-buffer.test.ts apps/be-01/src/service/replay-orchestrator.test.ts apps/be-01/src/service/gateway-broadcaster.test.ts`: 26 pass, 0 fail, 40 assertions. Two further regressions were then added for retained-cursor fairness and direct expiry coverage; final suite evidence follows below.
- Direct instrumentation of four production records after seeding 100, 1,000 and 10,000 subscriptions: **[1, 3, 1, 1] iterator advances at every size**. Native Map iterator `next` is counted, including retained iterators and terminal advances; the synchronous test restores its prototype spy before assertions.
- Final `bun test apps/be-01/src/service/replay-buffer.test.ts apps/be-01/src/service/replay-orchestrator.test.ts apps/be-01/src/service/gateway-broadcaster.test.ts apps/be-01/src/service/gateway-broadcaster-durability.db.test.ts`: **31 pass, 0 fail, 61 assertions**.
- `bunx eslint apps/be-01/src/service/replay-buffer.ts apps/be-01/src/service/replay-buffer.test.ts`: exit 0.
- `openspec validate bounded-replay-sweep --strict`: valid, exit 0; optional telemetry flush reported DNS failure afterward.
- Scoped `git diff --check`: exit 0. Targeted Prettier check: all matched files use Prettier code style, exit 0.
- Full backend typecheck and workspace gate remain parent-owned and pending. No browser/deployment changes or checks.

## Observed failures

Every fault was restored before subsequent checks. Proof comments were written from these outputs.

| Injected fault                       | Test                                                              | Observed failure                                              |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Restore original key-array selection | bounds record iterator work with 100 / 1000 / 10000 subscriptions | 101 / 1001 / 10001 advances, expected at most 3; 3 failures   |
| Restart the cursor on every record   | advances past an earlier subscription that remains unexpired      | Received sequence 0, expected null for abandoned subscription |
| Remove the exhausted-cursor reset    | reaches subscriptions added after a completed sweep lap           | First subscription retained sequence 0, expected null         |
| Remove sweepOneOther from record     | is swept by the traffic on the others, not held forever           | Received sequence 0, expected null                            |
| Remove covers eviction               | reports expired coverage as absent before reading replay events   | Received true, expected false                                 |

Removing covers eviction initially left the existing `serves from the log when the buffer has aged out of the range` integration test green. The orchestrator now independently falls back to the log when the buffered events are incomplete, so that integration result cannot prove covers' own expiry decision. The integration behavior is retained, and the direct public coverage regression above observes the missing eviction.

## Expiry burst measurement

Forty in-process samples at each size, using the actual record path: fill one subscription at time 0, advance the injected clock to 2,000 with maxAgeMs=1,000, then time one record to a different subscription and assert the expired key was removed. Empty payload objects isolate array eviction cost; no payload byte-budget or production-latency claim follows.

| Expired entries               | Median ms | p95 ms   |
| ----------------------------- | --------- | -------- |
| 100                           | 0.002292  | 0.014917 |
| 1,000 (production cap)        | 0.032875  | 0.048500 |
| 10,000 (stress configuration) | 0.261542  | 0.339375 |

These local measurements do not justify extending this slice to deque replacement. The entry cap and age cap remain unchanged, and no byte limit was invented.

Exact measurement command:

```sh
bun -e 'import { ReplayBuffer } from "./apps/be-01/src/service/replay-buffer.ts"; for (const entries of [100, 1000, 10000]) { const durations = []; for (let run = 0; run < 40; run++) { let now = 0; const buffer = new ReplayBuffer({ maxPerSubscription: entries, maxAgeMs: 1000, now: () => now }); for (let seq = 0; seq < entries; seq++) buffer.record("closed", seq, {}); now = 2000; const began = performance.now(); buffer.record("live", 0, {}); durations.push(performance.now() - began); if (buffer.oldestSeq("closed") !== null) throw new Error("expiry burst retained the closed subscription"); } durations.sort((a,b) => a-b); console.log(JSON.stringify({ entries, runs: 40, medianMs: durations[20], p95Ms: durations[38] })); }'
```

## Archive reconciliation

2026-09-08, archive branch based on merged `main` at `5516d453`:

- `bun test apps/be-01/src/service/replay-buffer.test.ts apps/be-01/src/service/replay-orchestrator.test.ts apps/be-01/src/service/gateway-broadcaster.test.ts apps/be-01/src/service/gateway-broadcaster-durability.db.test.ts`: 33 pass, 0 fail, 72 assertions across 4 files. The two additional current-main cases also passed.
- `bunx nx typecheck be-01 --skip-nx-cache` and `bunx nx lint be-01 --skip-nx-cache` passed on the same production source before the archive-only A1–A6 edits.
- PR #356's exact-head workspace gate passed with the R8 implementation present. No browser or deployment behavior is claimed by this change.
