---
status: proposed
---

# A command batch is a unit of work the source implements

ADR 0007 made a command batch an outer `BEGIN IMMEDIATE` over the stores' own SQLite
transactions, which nest as savepoints. That is a fact about `bun:sqlite`, and a data source
that is a file, an HTTP API or a document store has no savepoints. We keep the behaviour and
move the mechanism: core owns a `UnitOfWork` port whose contract is **terminal atomicity** —
once `run` settles, every write made inside it is observable through every store's reads or
none is — and each source meets it its own way. The SQLite adapter meets it exactly as ADR 0007
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
  adapter method asks through the **gate** it was built with, and that `run` takes one turn
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
  a turn ever asks for one; everything else waits. The deadlock has no code path left to live
  in, and the kit's case (h) watches for its return.

`run` takes an act that returns a `Decision` — commit or roll back, with the value either way,
and an optional `afterRollback` that runs before the turn is released — because a refusal in
this codebase is a returned value, not a throw, and undo discards its stale journal entry in
exactly that window, through the ordinary journal store rather than the scope's, whose write
was just rolled back. A thrown error rolls back and rethrows.

The coordinator carries one more guarantee than atomicity: it is what makes the batch's
**ambient announcement context** portable. `DeferringBroadcaster` holds announcements in an
`AsyncLocalStorage`; behind the `AsyncContext` port the browser adapter is a single slot, and
a single slot is correct only because the coordinator admits one writer at a time **and**
because ownership never travels through it — the slot carries announcements and nothing else,
so nothing outside the batch can publish while it is open. Kit cases (f) and (g) in the plan
assert exactly that, and the slot throws on overlap so a coordinator fault is loud.

Why this is believed to be a port and not SQLite renamed: a Postgres source has the
mirror-image bug — a service built over the pool, called inside a transaction, writes outside
it and survives the rollback — and `scope.stores` bound to the transaction client is the same
line that fixes both; its coordinator is a per-project advisory lock, so batches on one project
still take turns while different projects run in parallel. A file source has no transactions
at all, and meets terminal atomicity by staging, acting and one atomic rename, which is the
memory source with a persist hook. Neither is built; both fit the three interfaces without
core changing.

## Considered options

**Transactions stay SQL-only; swappability promised only among SQL sources.** Rejected
because "the repository layer must not care about the source" was the requirement, and a
port that only SQL can implement is drizzle's shape with a different name.

**Push atomicity into the stores as aggregate-level methods** (`applyPlanBatch`). Rejected
for the same reason ADR 0007 rejected the unit-of-work rewrite: it replaces the per-command
store API every service is written against, and the batch runner would become a second
service layer.

## Consequences

ADR 0007 is not superseded; it becomes the SQLite adapter's documentation. The saved-plan
repositories, which open their own connection per call and check quota inside their own
transaction, are **independent operations** of the source: never enlisted in a batch and
never taking a turn, so an open batch neither delays nor undoes them; the kit holds every
source to that. `EventLogRepo` is a port of the source like the stores (`EventLogStore`),
because replay and retention read and prune through it. The batch runner composes its
services per batch over `scope.stores`; for SQLite that graph is built once at `open`, since
the admitted stores never change, and the only per-instance state a batch service holds is
its own collector, which is per batch by design.

The set of stores a source offers is a composition, not one record: a source without
accounts is certified for the ports it has, and the composition root's type says which
service is then absent. A source that cannot serve a project's chosen schedule engine refuses
with `engine_unavailable` rather than substituting another engine; dates from an engine the
project did not choose are a wrong plan with no mark on it (plan D22, D23).
