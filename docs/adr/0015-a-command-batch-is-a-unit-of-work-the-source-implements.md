---
status: proposed
---

# A command batch is a unit of work the source implements

ADR 0007 made a command batch an outer `BEGIN IMMEDIATE` over the stores' own SQLite
transactions, which nest as savepoints. That is a fact about `bun:sqlite`, and a data source
that is a file, an HTTP API or a document store has no savepoints. We keep the behaviour and
move the mechanism: core owns a `UnitOfWork` port whose contract is **terminal atomicity** —
once `run` settles, every write made by its batch is observable through the stores' reads or
none is; explicitly declared post-rollback repair is a separate surviving act — and each
source meets it its own way. The SQLite adapter meets it exactly as ADR 0007
describes; the in-memory source meets it by staging and swapping. A conformance case
(`unitOfWorkConformance`) asserts the contract against every source, so a source that cannot
roll back is not a slower source, it is a failing one.
Plan: `docs/2026-09-05-ports-and-adapters-plan.md` §3.2.

Two things the first draft of this ADR got wrong, corrected on review (plan §8):

- **Isolation is not promised.** SQLite's one shared connection shows a batch's in-flight rows
  to a concurrent read, and a probe against the production event log observed it. The
  contract is about the state after `run` settles; the kit says so and tests the in-flight
  window only for what _is_ promised — that an outside write is not undone by the batch.
- **The source owns write coordination.** ADR 0007 says every be-01 write waits behind the
  lock while a batch is open; the code has only publication taking it, so a route write or a
  retention prune can land inside an open batch and be rolled back with it. The lock leaves
  core and becomes the source's **write coordinator**: a queue of turns that every mutating
  transactional adapter method asks through the **gate** it was built with, and that `run` takes one turn
  of for the whole batch. Its key is the source's choice — the process for one-connection
  SQLite, the project for a Postgres advisory lock, nothing where each transaction has its own
  connection.

And one thing the second draft got wrong, corrected on the third review (plan §10):

- **There is no re-entrancy.** The second draft had the coordinator "re-entrant by owner
  token" and never said how the token reached a store method called from inside `run`. Every
  store method asks for a turn; `run` holds the turn; the runner's services were built over
  those same stores — so a batch's first write would have waited for itself. And the only
  ambient channel for a token, `AsyncContext`, is a single slot in the browser that hands the
  batch's token to every caller while the batch is open, which admits exactly the outsider the
  coordinator exists to keep out. Ownership therefore travels **explicitly**: `run` hands `act`
  a `Scope` whose stores are the same adapter classes built so their writes are already the
  batch's own — an open gate for SQLite, the transaction client for Postgres, the staged clone
  for memory — and the batch runner builds its services over `scope.stores`. Nothing that holds
  a turn ever asks for one; outside transactional writers wait. Case (h) is the planned
  production-call-path negative; the next review found that repair still violated this rule.

`run` takes an act that returns a `Decision` — commit or roll back, with the value either way,
and an optional `afterRollback` that runs before the turn is released — because a refusal in
this codebase is a returned value, not a throw, and undo discards its stale journal entry in
exactly that window. **Corrected on the 2026-09-06 repository review (D28):** the callback
receives a fresh admitted scope over the surviving transactional state and uses its journal.
The ordinary journal reacquires the coordinator the callback holds and deadlocks; the old
memory scope writes into a discarded clone. A thrown batch error rolls back and rethrows.
The callback runs outside the transaction catch, so its own failure propagates without a
second rollback; if transaction failure and rollback both fail, both errors are retained.

**Announcements also have explicit ownership (D24, superseding D15).** Per-store admission
cannot prevent an ordinary route from completing its write, releasing the turn, and
publishing after the next batch opens its hold. The review's probe observed exactly that
order and the following refusal dropped the committed route's event. A single browser slot
therefore is not a valid substitute for today's `AsyncLocalStorage`.

Build a fresh collector and `servicesOver(scope.stores, { ...shared, broadcast: collector })`
per batch; ordinary services receive the direct broadcaster. Flush only the batch's own
events after commit and coordinator release; discard only those events after rollback. This
works in either runtime without an `AsyncContext` port. Composition cases (f), (g) and (l)
cover outside writers on both sides of the admission window and post-commit events from a
preceding batch. The clock, replay buffer, throttle and optimizer wiring remain shared.

Why this is believed to be a port and not SQLite renamed: a Postgres source has the
mirror-image bug — a service built over the pool, called inside a transaction, writes outside
it and survives the rollback — and `scope.stores` bound to the transaction client is the same
line that fixes both. Its coordinator must survive transaction rollback until repair ends:
a transaction-level advisory lock is insufficient, so a future adapter retains a session-level
project lock and its borrowed connection through repair and releases both afterward. Batches
on one project still take turns. A file source has no transactions
at all, and meets terminal atomicity by staging, acting and one atomic rename, which is the
memory source with a persist hook. Neither is built; both fit the three interfaces without
core changing.

## Considered options

**Transactions stay SQL-only; swappability promised only among SQL sources.** Rejected
because "the repository layer must not care about the source" was the requirement, and a
port that only SQL can implement is drizzle's shape with a different name.

**A shared announcement slot under the write coordinator.** Rejected after the observed
write-before-next-batch publication race. Holding the coordinator across network delivery
would serialize unrelated writes behind gateway latency. Binding the collector to the scoped
service graph preserves explicit ownership without extending that critical section.

**Push atomicity into the stores as aggregate-level methods** (`applyPlanBatch`). Rejected
for the same reason ADR 0007 rejected the unit-of-work rewrite: it replaces the per-command
store API every service is written against, and the batch runner would become a second
service layer.

## Consequences

ADR 0007 is not superseded; it becomes the SQLite adapter's documentation. The saved-plan
repositories, which open their own connection per call and check quota inside their own
transaction, are **independent operations** of the source: never enlisted in a batch and
never taking a coordinator turn. Existing bounded database contention may return
`snapshot_busy`; an independently successful save survives either batch outcome. `Scope`
contains only `TransactionalStores`; the source separately composes `HistoryStores` (D27).
The memory source holds history outside its cloned/swapped transactional tables, and case (j)
tests successful independent saves against both commit and rollback. This addresses a
conditional design risk, not a measured data-loss bug in an implemented memory source.
`EventLogRepo` is a port of the source like the stores (`EventLogStore`),
because replay and retention read and prune through it. The batch runner composes its
services per batch over `scope.stores` with that batch's collector. SQLite's admitted store
adapters can be built once at `open`; its scoped service graph is rebuilt because announcement
ownership changes for every batch. The conformance checks must prove behavior through these
callers; declarations that a store is gated do not establish that its write waits.

The set of stores a source offers is a composition, not one record: a source without
accounts is certified for the ports it has, and the composition root's type says which
service is then absent. A source that cannot serve a project's chosen schedule engine refuses
with `engine_unavailable` rather than substituting another engine; dates from an engine the
project did not choose are a wrong plan with no mark on it (plan D22, D23).
