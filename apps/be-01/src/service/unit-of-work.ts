import type { TransactionalStores } from '../repository';

/**
 * What one {@link Command batch} writes through: the transactional stores,
 * already holding the batch's turn.
 *
 * "Already holding" is the whole of D20. The stores here are the same adapter
 * classes the process's own graph is built from, constructed over the **open**
 * gate — so a write made inside `run` does not ask the coordinator for a turn
 * the batch is itself holding. Ownership travels in this argument rather than
 * through an ambient slot, which is what the second draft of ADR 0015 got wrong.
 */
export interface Scope {
  stores: TransactionalStores;
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
export type Decision<T> =
  | { commit: true; value: T }
  | { commit: false; value: T; afterRollback?: (scope: Scope) => Promise<void> };

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
export interface UnitOfWork {
  /**
   * Runs `act` as one unit and answers the value its {@link Decision} carries.
   *
   * A thrown error rolls back and rethrows. When the rollback itself also
   * fails, both causes are kept — an `AggregateError` rather than the rollback's
   * error replacing the one that caused it.
   */
  run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T>;
}
