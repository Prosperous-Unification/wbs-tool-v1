<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

Six slices, each its own PR against `main`. The order is the plan's (§4, Wave 2) and it is a
dependency order, not a preference: nothing can hold a turn until the gate exists, and nothing
can hand out an admitted scope until something holds a turn.

**Slice 1 carries the two service graphs, which the plan put in slice 2.** It has to: the
moment a store takes a turn, a batch built over the same stores waits for the turn it is
itself holding. So `servicesOver` and the admitted graph land with the gate, and slice 2 is
`UnitOfWork.run` over them rather than the split as well.

## 1. The gate, and the turn every write has to take

- [x] 1.1 **The suspension negative first, watched red.** `apps/be-01/src/service/write-coordinator.db.test.ts`
      › `a route write started while a batch is suspended is not rolled back with it`: open a
      real batch through `PlanCommandRunner` against a migrated database, suspend it after its
      first write (a command whose service awaits a deferred the test resolves), call
      `StepService.add` from outside, then refuse the batch. The step must be there afterwards
      and its event consistent. On `main` this fails — the step's insert lands inside the
      batch's `BEGIN IMMEDIATE` and the refusal takes it. Record the observed failure text in
      `verify.md` before writing a line of the fix.
- [x] 1.2 `Gate` and `OPEN` in `apps/be-01/src/repository/gate.ts` — `WriteLock` moved there
      whole as `WriteCoordinator`, `run` renamed `enter`, and `GatewayBroadcaster` stopped
      taking a turn of its own (the event log now takes it, and a caller holding a turn while
      its callee asks for one is a deadlock): `enter<T>(work: () => Promise<T>): Promise<T>`,
      and `OPEN` whose `enter` runs the work at once because its caller already holds a turn.
      `WriteLock` (`service/write-lock.ts`) becomes the SQLite source's coordinator and
      implements `Gate`; its `run` is renamed `enter` with every call site moved in the same
      commit. JSDoc on `Gate` says what a turn is and who may skip one; JSDoc on `OPEN` says it
      is a claim by its constructor, not a lock that is always free.
- [x] 1.3 Every **transactional** repository constructor takes its gate — sixteen classes, 53
      mutating methods — and every one of them runs its body inside `this.gate.enter`. The
      six function-style optimizer modules take `db` per call rather than holding one and are
      **not** gated here; they are named in slice 3 with the drain seams that are still
      `dual-optimized-scheduler`'s. `UserRepository.ensureLocalIdentity` stays ungated and
      says why: it runs at boot before the server listens, so there is no batch to land in. Reads take nothing and the diff must show
      that: a `select` inside an `enter` is a stalled read behind an unrelated write.
      `SavedPlanRepository` and `SavedPlanCaptureRepository` take **no** gate (they own their
      connection; slice 3 states that as a contract).
- [x] 1.4 1.1 goes green. The negative that keeps it honest is the fault it was written for:
      take the gate back out of `StepRepository.add` and watch 1.1 fail again; record the
      output. Then case (i) — `every public transactional write waits` — walks the store list
      and calls one mutating method of each while a batch is suspended, asserting none has
      written; injected fault is `OPEN` in place of the coordinator for one store, watched.
- [x] 1.5 `bun run test:unit`, `nx run be-01:test`, `nx run be-01:typecheck`, `nx run be-01:lint`.

## 2. The unit of work

- [x] 2.1 **The deadlock negative first (h).** `unit-of-work.db.test.ts` › `a store on the scope
does not wait for the turn its batch holds`: a `run` whose act writes through
      `scope.stores` must settle inside the case's timeout. Build the scope's stores over the
      **coordinator** rather than `OPEN` and watch it time out; that observed output is the
      proof comment's text.
- [x] 2.2 `UnitOfWork`, `Scope`, `Decision` in `service/unit-of-work.ts` (types) and
      `repository/sqlite-unit-of-work.ts` (the adapter, ADR 0015's sketch): one `enter`, then
      `BEGIN IMMEDIATE`, `act({ stores: admitted })`, `COMMIT`/`ROLLBACK`, `afterRollback`
      **outside** the transaction catch, `AggregateError` when the rollback fails too.
- [x] 2.3 Cases (a) three writes with the third refused, (b) the same throwing, (c) the
      committed batch, plus (h) and both halves of (k). They live in
      `apps/be-01/src/testing/kits/unit-of-work-conformance.ts` from the start, so slice 5 moves
      a file rather than rewriting the cases. **Against SQLite only for now**: the second source
      needs a memory unit of work that stages and swaps, and the in-memory fixtures hold private
      arrays with no snapshot. That is slice 5's, where the memory source is tightened; the kit
      takes a factory, so the second source is one call.
- [x] 2.4 `servicesOver(stores, shared)` factored out of `buildServices`, so a batch's graph can
      be built over `scope.stores`. `buildServices` keeps building the shared half once — clock,
      throttle, replay buffer, optimizer wiring — and `services.db.test.ts` grows the assertion
      that two batches see **one** buffer and **two** collectors.
- [x] 2.5 `PlanCommandRunner.execute` and `walk` move onto `UnitOfWork.run`. `execute`'s refusal
      becomes `{ commit: false }`; `walk`'s stale-journal discard becomes `afterRollback`, using
      the journal on the scope it is handed. `OuterTransaction` and its `countingOuterTransaction`
      fixture are deleted, not left beside the new seam.
- [x] 2.6 **Case (k), the repair window.** Two kit cases: the repair writes through the scope it
      is handed and survives the rollback, and a repair that throws surfaces as itself with the
      source still usable afterwards (no second `ROLLBACK` on a closed transaction). The
      **discarded memory scope** fault waits for the memory source in slice 5. `walk`'s own
      discard goes through the batch's `workItems`, which **is** the admitted graph — the note
      is at the call site, and it becomes `servicesOver(scope.stores, …)` in slice 3.
- [x] 2.7 The full be-01 suite, both tiers.

## 3. Announcements — who owns an event (D24)

- [x] 3.1 **Case (l) first, watched red on `main`'s shape.** An ordinary route write commits, a
      following batch takes the turn before that route publishes, the batch is refused — the
      route's event must still leave, exactly once. Inject the shared ambient slot
      (`DeferringBroadcaster`'s `AsyncLocalStorage` hold) and watch it drop.
- [x] 3.2 A per-batch `AnnouncementCollector`; the batch graph is built **per batch** over the
      collector the runner hands in (`batchServices` is a factory), ordinary services keep the
      direct broadcaster. `DeferringBroadcaster` is deleted whole — `hold`, `send`, the nested
      hold guard and the `AsyncLocalStorage` with them. Cases (f) and (g).
      Two things the change had to answer that the plan did not name: the post-commit
      `announceTreeNow` runs **after** the collector has been drained, so it publishes through a
      graph over the direct broadcaster (collected, the event would never leave); and two tests
      pinned a service **identity** through `spyOn`, which a per-batch graph breaks, so the
      work-item service there is built once and relays to whichever collector is in hand.

## 3b. The event log and the history that is not in the batch

- [x] 3.3 `EventLogStore` replaces `EventLogRepo` and joins `TransactionalStores`, so a batch
      records through `scope.stores.eventLog` while replay and retention read and prune through
      the public gated copy. **`recordEventIn(tx)` stays**, and says why at the declaration:
      its one caller is the optimizer's `storeOptimizedOutcomeAndRecord`, which writes a solver
      result and its replay record as one act on its own transaction, and moving that onto the
      unit of work is `dual-optimized-scheduler`'s slice by the Wave 0 gate. `EventLogTransaction`
      goes with it, not before it.
- [x] 3.4 `Stores`, `TransactionalStores` and `HistoryStores` in `repository/index.ts` as the
      D22 composition; `Scope` carries the transactional subset only, so a command cannot
      enlist a saved plan. Type-level negative: a `scope.stores.savedPlans` reference must fail
      `tsc`, watched at the line it names.
- [x] 3.5 **Case (j).** A saved plan written while a batch is suspended either succeeds without
      waiting or reports `snapshot_busy`, and a successful save is still there after the batch
      commits **and** after it rolls back — both arms, in
      `saved-plan-in-transaction.db.test.ts`. The memory negative (history put back inside the
      swapped clone) waits for slice 5, where a memory source exists to break.

## 4. What a broken reference means, said by the method it happened in

- [ ] 4.1 Each store method that can trip a foreign key answers its own modeled outcome —
      `unknown_step`, `unknown_person`, … — rather than handing the service a driver error to
      classify. D6's negative: a foreign-key failure on a **person** while the step exists
      throws; the step deleted answers `unknown_step`.
- [ ] 4.2 `isForeignKeyViolation` leaves `service/`. It stays in `repository/constraint.ts`
      where the driver's error is, and the grep that proves no service imports it is the check.

## 5. The kits

- [ ] 5.1 One kit per port under `apps/be-01/src/testing/kits/`, each a function of a factory
      for that port, assembled from the existing `.db.test.ts` cases under the plan's admission
      rule: a case earns its place by being watched failing against `brokenSource(source, fault)`.
- [ ] 5.2 `sourceConformance(open)` as their composition, reporting the kits that ran and the
      cases skipped as **not offered**. SQLite runs it with no stubs.
- [ ] 5.3 The in-memory fixtures are tightened until the kit passes, or the method goes on the
      stub allowlist (D29) and throws `NotImplemented`. The allowlist test is watched failing on
      a stub with no line, and `sourceConformance`'s report is watched naming a skipped case.

## 6. The runtime this process happens to be

- [ ] 6.1 `PasswordHasher`, `TokenCodec`, `Digest`, `Timers`, `PushTransport` as ports with their
      Bun adapters built in `boot.ts`. Every global default is removed at the same time — a
      service constructed without its port must fail `tsc`, watched.
- [ ] 6.2 `Buffer.byteLength` in `saved-plan.ts` becomes `TextEncoder`.
- [ ] 6.3 Whole-workspace gate on a frozen tree, recorded in `verify.md` with its command,
      duration and counts. The browser gate is not this change's oracle — no fe-01 file moves —
      but `nx run-many -t test lint typecheck build` is.
