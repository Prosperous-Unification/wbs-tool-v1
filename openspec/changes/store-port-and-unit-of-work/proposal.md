<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

ADR 0007 says every be-01 write waits behind the {@link Write lock} while a command batch is
open. The code does not. `WriteLock` is taken by `PlanCommandRunner.execute`, its `walk` and
`GatewayBroadcaster` — the batch and publication, nothing else. Every other mutating path (a
route write, a retention prune) goes straight to the one `bun:sqlite` connection, so a write
landing between a batch's `BEGIN IMMEDIATE` and its `COMMIT` sits **inside** that transaction
and is rolled back with the batch's refusal. Nobody is told. That is a production gap, not an
extraction detail.

The mechanism that closes it is spelled `BEGIN IMMEDIATE`, in the file the stores are written
in. A source that is a document store, a file or a browser has no such statement and no
savepoints.

## What Changes

- A `Gate` port (`enter(work)`) and `OPEN`. The process-wide coordinator moves behind it; every
  **mutating transactional** store method asks for a turn through the gate it was constructed
  with. Reads never take one.
- `UnitOfWork.run(act)` with `Scope`, `Decision` and `afterRollback(scope)` — ADR 0015's
  contract, terminal atomicity, refusals as returned values. `PlanCommandRunner` and undo's
  `walk` move onto it; the batch's services are built over `scope.stores`, which are admitted,
  so nothing that holds a turn ever asks for one.
- Announcements become an explicit per-batch collector (D24); `DeferringBroadcaster`'s ambient
  hold goes.
- `EventLogStore` (transactional, on `Scope`), `SavedPlanStore` and `SavedPlanCaptureStore`
  (independent history) as ports; `Stores = TransactionalStores & HistoryStores` (D22).
- One conformance kit per port under `apps/be-01/src/testing/kits/` and
  `unitOfWorkConformance` (a)–(l), run against the SQLite source and the in-memory fixtures.
- The runtime ports of plan §3.4 whose callers this change already opens — `PasswordHasher`,
  `TokenCodec`, `Digest`, `Timers`, `PushTransport` — with their Bun adapters in `boot.ts` and
  the global defaults removed.

## Non-goals

- Moving anything into `libs/`. That is Wave 3; every file stays in `apps/be-01` here.
- **The `Scheduler` port and `scheduleInputHash`'s move.** Wave 0's gate, re-run 2026-09-08 at
  `main` @ `d2e14214`, found `dual-optimized-scheduler` still holding unchecked slices on both.
  They land after it.
- Isolation between concurrent readers (D1). SQLite shows in-flight rows; this does not change.
- A Postgres, file or browser source.

## Constraints

- No schema change, so no migration; blue/green is untouched.
- Refusals stay returned values. A throw still rolls back and rethrows.
- Every new check gets a negative watched failing on its production call path (R5).
