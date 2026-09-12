import type { HistoryStores, PlanTransactionalStores } from './stores';
import type { UnitOfWork } from './unit-of-work';

/** Whether an opened source can currently serve requests. */
export type SourceHealth = { ok: true } | { ok: false; reason: 'unavailable' };

/** An opened persistence source and every lifetime it owns. */
export interface Source<S extends PlanTransactionalStores = PlanTransactionalStores> {
  readonly stores: S;
  readonly history: HistoryStores;
  readonly uow: UnitOfWork<S>;
  health(): Promise<SourceHealth>;
  close(): Promise<void>;
}
