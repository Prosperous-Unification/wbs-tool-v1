---
status: accepted
---

# Adapter transactions stay outside core ports

The core extraction at `339708fa` is blocked by `EventLogStore.recordEventIn(tx)` and
`SavedPlanStore.holdingOf(db)`/`bodyOf(db)`, although only SQLite implementations and their
tests need those arguments. Keep these operations on the SQLite adapters and expose only
source-independent operations through core ports; the optimizer's outcome and replay event
continue to commit in one adapter-owned transaction, while a saved plan's quota callback
continues to run inside its independent write. Making an opaque transaction token part of
every source would preserve the driver dependency under another name, and moving saved-plan
history into the batch's unit of work would violate [ADR 0015](0015-a-command-batch-is-a-unit-of-work-the-source-implements.md).

`PlanCommandRunner` must build its graph inside `UnitOfWork.run(scope)` from that scope's
stores, then use the separate public graph after settlement and the supplied live repair
scope after rollback. A factory closing over SQLite's admitted stores is insufficient:
memory scopes must refer to that particular batch's staged state. This resolves the remaining
implementation choice in [ADR 0014](0014-ports-live-in-a-framework-free-core-lib.md), without
promising stronger read isolation or changing announcement ownership.

The decisions are accepted for implementation under the user's 2026-09-08 instruction to
resolve and document assumptions autonomously. Acceptance is not a claim that the code has
been moved or that the planned failure tests have run.
