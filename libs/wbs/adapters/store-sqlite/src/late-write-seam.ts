import type { StoredSavedPlan } from './saved-plan';

export type SqliteLateWritePoint =
  'subtree-final-satellite' | 'journal-history-insert' | 'saved-plan-schedule-body';

export interface SqliteLateWriteEvidence {
  readonly satelliteKeys?: readonly string[];
  readonly savedPlan?: StoredSavedPlan;
}

export interface SqliteLateWriteSeam {
  isActive?(phase: SqliteLateWritePoint): boolean;
  observeBoundary?(phase: SqliteLateWritePoint, evidence: SqliteLateWriteEvidence): void;
  reach(phase: SqliteLateWritePoint, evidence?: SqliteLateWriteEvidence): void;
}

export const inertSqliteLateWriteSeam: SqliteLateWriteSeam = {
  reach: () => undefined,
};
