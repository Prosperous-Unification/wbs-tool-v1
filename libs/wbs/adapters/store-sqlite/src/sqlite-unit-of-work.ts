import type { Decision, Scope, UnitOfWork } from '@wbs/core';
import type { TransactionalStores } from '@wbs/core';
import { sql } from 'drizzle-orm';

import type { Drizzle } from './db';
import type { Gate } from './gate';

/**
 * The SQLite source's {@link UnitOfWork}: one turn, one `BEGIN IMMEDIATE`, and
 * the stores' own transactions nesting inside it as savepoints.
 *
 * `IMMEDIATE` rather than `DEFERRED` takes SQLite's write lock at `BEGIN`
 * rather than at the first write, so a reader in another process cannot turn
 * the batch into `SQLITE_BUSY` halfway through — ADR 0007, measured against
 * `bun:sqlite` and drizzle rather than read off the documentation.
 *
 * `admitted` is the stores the act writes through: the same adapter classes the
 * process's graph is built from, over the **open** gate, because their caller
 * holds this run's turn. Built once at composition rather than per batch — an
 * adapter holds no batch state, only its connection and its gate.
 */
export function sqliteUnitOfWork(
  db: Drizzle,
  gate: Gate,
  admitted: TransactionalStores,
): UnitOfWork<TransactionalStores> {
  const scope: Scope<TransactionalStores> = { stores: admitted };
  return {
    run<T>(
      act: (scope: Scope<TransactionalStores>) => Promise<Decision<T, TransactionalStores>>,
    ): Promise<T> {
      return gate.enter(async () => {
        db.run(sql.raw('BEGIN IMMEDIATE'));
        let decision: Decision<T, TransactionalStores>;
        try {
          decision = await act(scope);
          db.run(sql.raw(decision.commit ? 'COMMIT' : 'ROLLBACK'));
        } catch (cause) {
          try {
            db.run(sql.raw('ROLLBACK'));
          } catch (rollbackCause) {
            // Both, and not the second one alone: the rollback failing is the
            // more recent event and the less informative one, and a caller
            // reading only it would be told the database is unhappy without
            // being told what the batch was doing when it became so. `cause` is
            // the rollback's failure — the one this `catch` is holding — and
            // the batch's own is the first arm of the aggregate.
            throw new AggregateError([cause, rollbackCause], 'batch and rollback failed', {
              cause: rollbackCause,
            });
          }
          throw cause;
        }
        // **Outside the transaction's own catch**, deliberately (D28): the
        // repair below is a separate surviving act on a closed transaction, so
        // a failure inside it must propagate as itself rather than trigger a
        // second `ROLLBACK` on a transaction that is no longer open.
        //
        // The scope it is handed is the same admitted one, which on SQLite is
        // the surviving state the moment the rollback returned. Handing it the
        // *public* stores instead would deadlock: this run still holds the
        // turn, and they would ask for another.
        if (!decision.commit && decision.afterRollback !== undefined) {
          await decision.afterRollback(scope);
        }
        return decision.value;
      });
    },
  };
}
