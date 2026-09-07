## ADDED Requirements

### Requirement: Every transactional write takes a turn

The source SHALL own a write coordinator: a queue of turns whose key is the source's own
choice — process-wide for one-connection SQLite, per project for a Postgres advisory lock,
a no-op where every transaction has its own connection.

Every **mutating** method of a transactional store SHALL ask for a turn through the `Gate` it
was constructed with before it writes. Reads SHALL NOT take a turn. A store built with the
`OPEN` gate already holds one and SHALL run its work immediately.

`UnitOfWork.run` SHALL take exactly one turn for the whole batch, and the stores it hands its
act SHALL be built over `OPEN`, so nothing that already holds a turn ever asks for one.

#### Scenario: a route write started while a batch is suspended

- **WHEN** a command batch is suspended after its first write and `StepService.add` is called
  from outside it, and the batch is then refused
- **THEN** the step is stored and its event is consistent — the outside write waited for the
  batch's turn and was not rolled back with it

#### Scenario: every public transactional write waits

- **WHEN** each public transactional store's mutating method is called while a batch is
  suspended
- **THEN** it has not written when the batch is still open, and writes once the batch releases

#### Scenario: an admitted store does not wait for itself

- **WHEN** a store on the scope handed to `run`'s act is written to inside the batch
- **THEN** the write completes rather than deadlocking on the turn the batch already holds

### Requirement: A command batch is a unit of work

`UnitOfWork.run(act)` SHALL give `act` a `Scope` carrying the **transactional** stores only and
SHALL settle with terminal atomicity: once `run` returns, every write the act made is
observable through the stores' reads, or none is.

`act` SHALL answer a `Decision` — `{ commit: true, value }` or `{ commit: false, value,
afterRollback? }` — because a refusal in this codebase is a returned value rather than a throw.
A thrown error SHALL roll back and rethrow; when the rollback itself fails, both causes SHALL
be retained.

`afterRollback` SHALL run after the rollback and before the turn is released, and SHALL receive
a **new admitted scope over the surviving state**. It SHALL run outside the transaction's own
catch, so a failure inside it SHALL propagate without a second rollback being attempted.

`Scope` SHALL NOT expose the independent history stores, so a command cannot enlist a saved
plan in its batch.

#### Scenario: a refused third write

- **WHEN** three writes across three stores are made inside one `run` and the act answers
  `{ commit: false }`
- **THEN** none of the three is observable after `run` settles

#### Scenario: a thrown third write

- **WHEN** the same batch throws at its third write instead
- **THEN** none of the three is observable and the error reaches the caller

#### Scenario: a committed batch

- **WHEN** the act answers `{ commit: true }`
- **THEN** all three writes are observable through the stores' own reads

#### Scenario: the repair that follows a rollback

- **WHEN** an undo is refused and its stale journal entry is discarded through `afterRollback`
  while a second write waits for the turn
- **THEN** the discard is durable, the second write proceeds afterwards, and a repair that
  throws surfaces its own error with no second rollback attempted

### Requirement: Announcements belong to the batch that made them

A batch's services SHALL be built over `scope.stores` with a **fresh collector per batch**;
ordinary services SHALL publish through the direct broadcaster. No ambient slot SHALL carry
the current batch.

A batch SHALL flush only its own collected events, after commit and after its turn is
released, and SHALL discard only its own events on rollback.

The clock, login throttle, replay buffer and optimizer wiring SHALL remain one shared instance
across batches.

#### Scenario: an event committed just before the next batch opens

- **WHEN** an ordinary route write commits, a following batch takes the turn before that route
  publishes, and the batch is then refused
- **THEN** the route's event still leaves, exactly once

#### Scenario: a publication from inside a batch

- **WHEN** a service publishes from inside a suspended batch
- **THEN** the event is held by that batch and leaves after its commit, never inside it

### Requirement: Saved plans are independent of any batch

`SavedPlanStore` and `SavedPlanCaptureStore` SHALL be history ports of the source, run on their
own connection, and SHALL NOT take a turn in the write coordinator.

A save that succeeds while a batch is open SHALL survive both that batch's commit and its
rollback. A save that meets the existing bounded contention SHALL report `snapshot_busy` rather
than waiting behind the batch.

An in-memory source SHALL stage and swap its **transactional** tables only; its history tables
SHALL never be cloned or replaced by a batch's outcome.

#### Scenario: a save during a suspended batch

- **WHEN** a saved plan is written while a batch is suspended
- **THEN** it either succeeds without waiting for the batch, or reports `snapshot_busy`; and if
  it succeeded it is still there after the batch commits, and after the batch rolls back

### Requirement: A source is certified by the kits for the ports it offers

Every port SHALL have a conformance kit that is a function of a factory for that port, and
`sourceConformance` SHALL be their composition over the ports a source declares. A source that
does not offer a port SHALL NOT be asked about it.

A case belongs to a kit when it states behaviour a caller can observe **through the port**, and
SHALL have been watched failing against a deliberately broken source before it is believed.

A method a source stubs SHALL be named on that source's stub allowlist; the stub SHALL throw
rather than answer, `sourceConformance` SHALL report the skipped cases by name, and a stub with
no allowlist entry SHALL fail the allowlist test.

#### Scenario: the report names what was not offered

- **WHEN** `sourceConformance` runs against a source with a stubbed method on its allowlist
- **THEN** the report names the kits that ran and the cases skipped as not offered, and no
  skipped case is reported as passing

#### Scenario: a stub with no allowlist line

- **WHEN** a source stubs a method that is not on its allowlist
- **THEN** the allowlist test fails naming that method

### Requirement: The runtime a service needs is injected

`PasswordHasher`, `TokenCodec`, `Digest`, `Timers` and `PushTransport` SHALL be ports with their
Bun adapters supplied by `boot.ts`. A service SHALL NOT fall back to a global default when the
root supplies none.

A project's chosen schedule engine SHALL be served by a `Scheduler` port. A source or runtime
that cannot serve the chosen engine SHALL refuse with `engine_unavailable` and SHALL NOT
substitute the other engine.

#### Scenario: the default that is no longer there

- **WHEN** a service that used `fetch`, `setTimeout` or `setInterval` by default is constructed
  without that port
- **THEN** it fails to compile, rather than silently reaching for the global

#### Scenario: the engine a project chose is unavailable

- **WHEN** a project's chosen engine cannot run
- **THEN** the caller receives `engine_unavailable` naming the engine, and no plan is answered
  from the other one
