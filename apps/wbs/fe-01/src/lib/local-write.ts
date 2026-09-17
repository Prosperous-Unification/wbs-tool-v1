import type { CommitOutcome } from '@/components/wbs/live-editing';

import { ALL_RESOURCES, type RefreshResource } from './plan-refresh';

/** One plan gesture, which records only requests that resolved successfully. */
export interface LocalWrite {
  /**
   * Runs one real request and records its refresh obligations after it resolves.
   * A rejected request contributes nothing; earlier completed requests remain recorded.
   */
  perform<T>(resources: readonly RefreshResource[], request: () => Promise<T>): Promise<T>;
}

/** The write boundary shared by plan mutation callers. */
export type RunPlanWrite = (action: (write: LocalWrite) => Promise<void>) => Promise<CommitOutcome>;

/** A gesture-local write plus the successful request obligations collected so far. */
export interface LocalWriteAttempt extends LocalWrite {
  completedResources(): readonly RefreshResource[];
}

/** Creates the completed-request ledger for one plan gesture. */
export function createLocalWrite(): LocalWriteAttempt {
  const completed = new Set<RefreshResource>();
  return {
    async perform(resources, request) {
      const response = await request();
      for (const resource of resources) completed.add(resource);
      return response;
    },
    completedResources: () => ALL_RESOURCES.filter((resource) => completed.has(resource)),
  };
}
