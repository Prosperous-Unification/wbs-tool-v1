import type { StoredSavedPlan } from './saved-plan';

/** A saved-plan write mutation available only to adapter-owned test factories. */
export interface SavedPlanWriteFault {
  readonly kind: 'split' | 'omit-input';
  readonly targetId: string;
  readonly beforeRestart?: () => void;
  readonly afterRestart?: () => void;
  readonly observeBoundary?: (stored: StoredSavedPlan) => void;
}

const savedPlanWriteFaults = new WeakMap<object, SavedPlanWriteFault>();

/** Reads the mutation armed for one repository instance.
 * @internal
 */
export function savedPlanWriteFaultOf(repository: object): SavedPlanWriteFault | undefined {
  return savedPlanWriteFaults.get(repository);
}

/** Arms one repository instance; test factories are the sole caller.
 * @internal
 */
export function armSavedPlanWriteFault(repository: object, fault: SavedPlanWriteFault): void {
  savedPlanWriteFaults.set(repository, fault);
}
