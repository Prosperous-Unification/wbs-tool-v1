import type { Scope } from '../ports/unit-of-work';
import { createWorkingPlan } from './working-plan';

/** Compile-time witness that a plan-only scope is sufficient and remains accountless. */
export function workingPlanOver(accountlessScope: Scope) {
  return createWorkingPlan(accountlessScope, 'project');
}

// Proof: widening WorkingPlan.stores to the source's full store type made this
// expectation unused because the batch graph could reach account persistence.
// @ts-expect-error A working plan has no account capability.
export type WorkingPlanUsers = ReturnType<typeof workingPlanOver>['stores']['users'];
