import type { PlanTransactionalStores } from './stores';

/**
 * What one {@link Command batch} writes through: the transactional stores
 * admitted by its source for this run.
 *
 * The store subtype preserves capabilities specific to that source. Ownership
 * travels in this argument rather than through an ambient slot, which is what
 * the second draft of ADR 0015 got wrong.
 */
export interface Scope<S extends PlanTransactionalStores = PlanTransactionalStores> {
  stores: S;
}

/**
 * What an act says it wants done with the writes it made.
 *
 * A returned value rather than a throw, because a refusal in this codebase is a
 * returned value: `PlanCommandRunner` answers `{ ok: false, at, kind, reason }`
 * to a caller that asked for something the plan does not allow, and that is not
 * an error. `value` rides both arms so the refusal reaches the caller after the
 * rollback that made it true.
 *
 * `afterRollback` is the window undo needs and nothing else has: a refused undo
 * discards the stale journal entry it just refused, and that discard has to
 * survive the rollback that took the rest. It runs **after** the rollback and
 * **before** the turn is released, over a scope whose stores are the surviving
 * state — see {@link UnitOfWork.run}.
 */
export type Decision<T, S extends PlanTransactionalStores = PlanTransactionalStores> =
  | { commit: true; value: T }
  | { commit: false; value: T; afterRollback?: (scope: Scope<S>) => Promise<void> };

/**
 * A batch of writes that settles all at once — ADR 0015, and the port the
 * source implements however it can.
 *
 * The contract is **terminal atomicity**: once `run` settles, every write the
 * act made is observable through the stores' reads, or none is. Isolation while
 * it is open is deliberately *not* promised — SQLite's one connection shows a
 * batch's in-flight rows to a concurrent read, and the kit tests only what is
 * promised (D1).
 *
 * The SQLite adapter meets it with `BEGIN IMMEDIATE` and the stores' own
 * transactions nesting as savepoints, exactly as ADR 0007 measured. A file
 * source would meet it by staging and renaming; an in-memory one by staging a
 * clone and swapping. None of those is a transaction, which is why the port is
 * this shape and not `begin/commit/rollback`.
 */
export interface UnitOfWork<S extends PlanTransactionalStores = PlanTransactionalStores> {
  /**
   * Runs `act` as one unit and answers the value its {@link Decision} carries.
   *
   * A thrown error rolls back and rethrows. When the rollback itself also
   * fails, both causes are kept — an `AggregateError` rather than the rollback's
   * error replacing the one that caused it.
   */
  run<T>(act: (scope: Scope<S>) => Promise<Decision<T, S>>): Promise<T>;
}
