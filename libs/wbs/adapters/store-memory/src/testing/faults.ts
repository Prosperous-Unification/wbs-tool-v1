import type { PlanEvent, Source, TransactionalStores } from '@wbs/core';

import type { MemoryLateWriteEvidence, MemoryLateWritePoint } from '../late-write-seam';
import { openMemorySourceWithLateWriteSeam } from '../source';

export type { MemoryLateWritePoint } from '../late-write-seam';

export interface MemoryFaultSource extends Source<TransactionalStores> {
  journalHistoryFor(projectId: string): Promise<PlanEvent[]>;
}

export interface MemoryLateWriteControl<Phase extends MemoryLateWritePoint> {
  readonly adapter: 'memory';
  readonly phase: Phase;
  claim(): boolean;
  arm(): void;
  isArmed(): boolean;
  reach(phase: MemoryLateWritePoint): boolean;
  reached(): boolean;
  observedJournalEventIds(): readonly string[];
  observedSatelliteKeys(): readonly string[];
  observedSavedPlan(): Pick<MemoryLateWriteEvidence, 'savedPlan'>;
  reachStagedWrite(phase: MemoryLateWritePoint, evidence?: MemoryLateWriteEvidence): boolean;
}

/** Creates a per-source hook to be called inside the staged write it names. */
export function memoryLateWriteControl<const Phase extends MemoryLateWritePoint>(
  phase: Phase,
): MemoryLateWriteControl<Phase> {
  let isArmed = false;
  let hasReached = false;
  let isClaimed = false;
  let evidence: MemoryLateWriteEvidence = {};
  const reach = (
    reachedPhase: MemoryLateWritePoint,
    reachedEvidence: MemoryLateWriteEvidence = {},
  ): boolean => {
    if (!isArmed || reachedPhase !== phase) return false;
    hasReached = true;
    evidence = reachedEvidence;
    return true;
  };
  return {
    adapter: 'memory',
    phase,
    claim() {
      if (isClaimed) return false;
      isClaimed = true;
      return true;
    },
    arm: () => {
      isClaimed = true;
      if (isArmed) throw new Error(`memory fault control for ${phase} was already armed`);
      isArmed = true;
    },
    isArmed: () => isArmed,
    reach,
    reached: () => hasReached,
    observedJournalEventIds: () => evidence.journalEventIds ?? [],
    observedSatelliteKeys: () => evidence.satelliteKeys ?? [],
    observedSavedPlan: () => ({
      savedPlan: evidence.savedPlan,
    }),
    reachStagedWrite: reach,
  };
}

/** Opens the real staged source with this run's late-write barrier attached. */
export function openMemorySourceWithFault(
  control: MemoryLateWriteControl<MemoryLateWritePoint>,
): MemoryFaultSource {
  const fixture = openMemorySourceWithLateWriteSeam({
    isActive: (phase) => control.isArmed() && phase === control.phase,
    reach(phase, evidence) {
      if (control.reachStagedWrite(phase, evidence))
        throw new Error(`injected memory fault at ${phase}`);
    },
  });
  return {
    ...fixture.source,
    journalHistoryFor: (projectId) => fixture.journalHistoryFor(projectId),
  };
}
