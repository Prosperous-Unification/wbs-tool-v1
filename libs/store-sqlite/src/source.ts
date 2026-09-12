import type { Source, TransactionalStores } from '@wbs/core';

import { buildStores } from './build-stores';
import { type Connection, openConnection as openDatabaseConnection } from './db';
import { OPEN, WriteCoordinator } from './gate';
import { probeSchema } from './health-probe';
import { SavedPlanRepository } from './saved-plan';
import { SavedPlanCaptureRepository } from './saved-plan-capture';
import { sqliteUnitOfWork } from './sqlite-unit-of-work';

/** The adapter-owned details needed by be-01's optimizer runtime. */
export interface SqliteSource extends Source<TransactionalStores> {
  readonly db: Connection['db'];
  readonly gate: WriteCoordinator;
}

/** Options that own every connection in one SQLite source lifetime. */
export interface OpenSqliteSourceOptions {
  readonly dbPath: string;
  readonly openConnection?: (dbPath: string) => Connection;
}

/** Opens SQLite persistence without changing its schema. */
export function openSqliteSource(options: OpenSqliteSourceOptions): SqliteSource {
  const connect = options.openConnection ?? openDatabaseConnection;
  const process = connect(options.dbPath);
  const coordinator = new WriteCoordinator();
  const stores = buildStores(process.db, coordinator);
  const admitted = buildStores(process.db, OPEN);
  let closed = false;

  return {
    db: process.db,
    gate: coordinator,
    stores,
    history: {
      savedPlans: new SavedPlanRepository({
        openConnection: () => connect(options.dbPath),
      }),
      savedPlanCapture: new SavedPlanCaptureRepository({
        openConnection: () => connect(options.dbPath),
      }),
    },
    uow: sqliteUnitOfWork(process.db, coordinator, admitted),
    health() {
      try {
        return Promise.resolve(
          probeSchema(process.db) === 'ok' ? { ok: true } : { ok: false, reason: 'unavailable' },
        );
      } catch (cause) {
        return Promise.reject(new Error('failed to probe SQLite source health', { cause }));
      }
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      try {
        process.close();
        return Promise.resolve();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        return Promise.reject(new Error(`failed to close SQLite source: ${detail}`, { cause }));
      }
    },
  };
}
