import type { PlanTransactionalStores } from './stores';
import type { UnitOfWork } from './unit-of-work';

export interface ScopeFixture {
  stores: PlanTransactionalStores;
}

export type ProjectStoreInScope = ScopeFixture['stores']['projects'];

// Proof: removing this expectation failed core:typecheck on TS2339:
// PlanTransactionalStores has no property 'savedPlans' (2026-09-09).
// @ts-expect-error A command scope cannot enlist independently durable saved plans.
export type SavedPlanStoreInScope = ScopeFixture['stores']['savedPlans'];

interface SourceStores extends PlanTransactionalStores {
  sourceSpecific: { read(): string };
}

/** Compile-time witness that a source's extra capability reaches its act unchanged. */
// Proof: before UnitOfWork accepted its store generic, core:typecheck failed
// here with TS2315 "Type 'UnitOfWork' is not generic" and TS7006 for the erased
// scope parameter (2026-09-09).
export function readSourceSpecific(uow: UnitOfWork<SourceStores>): Promise<string> {
  return uow.run((scope) =>
    Promise.resolve({ commit: true, value: scope.stores.sourceSpecific.read() }),
  );
}
