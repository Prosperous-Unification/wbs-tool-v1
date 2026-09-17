import { openConnection } from '../db';
import type {
  SqliteLateWriteEvidence,
  SqliteLateWritePoint,
  SqliteLateWriteSeam,
} from '../late-write-seam';
import type { StoredSavedPlan } from '../saved-plan';
import { SavedPlanRepository } from '../saved-plan';
import { armSavedPlanWriteFault, type SavedPlanWriteFault } from '../saved-plan-write-fault';
import type { OpenSqliteSourceOptions, SqliteSource } from '../source';
import { openSqliteSourceWithLateWriteSeam } from '../source';
import { createNonAtomicSubtreeMutantForTesting } from '../work-item';

export type { SqliteLateWritePoint } from '../late-write-seam';

export interface SqliteLateWriteControl<Phase extends SqliteLateWritePoint> {
  readonly adapter: 'sqlite';
  readonly phase: Phase;
  claim(): boolean;
  arm(): void;
  isArmed(): boolean;
  reach(phase: SqliteLateWritePoint): boolean;
  reached(): boolean;
  observedSatelliteKeys(): readonly string[];
  observedSavedPlan(): Pick<SqliteLateWriteEvidence, 'savedPlan'>;
  reachTransactionWrite(phase: SqliteLateWritePoint, evidence?: SqliteLateWriteEvidence): boolean;
}

/** Creates a per-source hook to be called inside the transaction write it names. */
export function sqliteLateWriteControl<const Phase extends SqliteLateWritePoint>(
  phase: Phase,
): SqliteLateWriteControl<Phase> {
  let isArmed = false;
  let hasReached = false;
  let isClaimed = false;
  let evidence: SqliteLateWriteEvidence = {};
  const reach = (
    reachedPhase: SqliteLateWritePoint,
    reachedEvidence: SqliteLateWriteEvidence = {},
  ): boolean => {
    if (!isArmed || reachedPhase !== phase) return false;
    hasReached = true;
    evidence = reachedEvidence;
    return true;
  };
  return {
    adapter: 'sqlite',
    phase,
    claim() {
      if (isClaimed) return false;
      isClaimed = true;
      return true;
    },
    arm: () => {
      isClaimed = true;
      if (isArmed) throw new Error(`SQLite fault control for ${phase} was already armed`);
      isArmed = true;
    },
    isArmed: () => isArmed,
    reach,
    reached: () => hasReached,
    observedSatelliteKeys: () => evidence.satelliteKeys ?? [],
    observedSavedPlan: () => ({
      savedPlan: evidence.savedPlan,
    }),
    reachTransactionWrite: reach,
  };
}

/** Opens the real SQLite source with this run's transaction barrier attached. */
export function openSqliteSourceWithFault(
  options: OpenSqliteSourceOptions,
  control: SqliteLateWriteControl<SqliteLateWritePoint>,
  reachProof: () => void = () => undefined,
  observeBoundary: (evidence: SqliteLateWriteEvidence) => void = () => undefined,
): SqliteSource {
  return openSqliteSourceWithLateWriteSeam(options, {
    isActive: (phase) => control.isArmed() && phase === control.phase,
    observeBoundary: (_phase, evidence) => {
      observeBoundary(evidence);
    },
    reach(phase, evidence) {
      if (control.reachTransactionWrite(phase, evidence)) {
        reachProof();
        throw new Error(`injected SQLite fault at ${phase}`);
      }
    },
  });
}

/** Opens the real source with only the subtree transaction boundary disabled. */
export function openSqliteSourceWithNonAtomicSubtreeFault(
  options: OpenSqliteSourceOptions,
  control: SqliteLateWriteControl<'subtree-final-satellite'>,
  reachProof: () => void = () => undefined,
): SqliteSource {
  const lateWrite = {
    isActive: (phase) => control.isArmed() && phase === control.phase,
    reach(phase, evidence) {
      if (control.reachTransactionWrite(phase, evidence)) {
        reachProof();
        throw new Error(`injected SQLite fault at ${phase}`);
      }
    },
  } satisfies SqliteLateWriteSeam;
  const source = openSqliteSourceWithLateWriteSeam(options, lateWrite);
  return {
    ...source,
    stores: {
      ...source.stores,
      subtrees: createNonAtomicSubtreeMutantForTesting(source.db, source.gate, lateWrite),
    },
  };
}

/** Opens the real saved-plan repository with header/input committed before schedule failure. */
export function openSqliteSourceWithNonAtomicSavedPlanFault(
  options: OpenSqliteSourceOptions,
  control: SqliteLateWriteControl<'saved-plan-schedule-body'>,
  reachProof: () => void,
  beforeRestart?: () => void,
  observeBoundary: (stored: StoredSavedPlan | undefined) => void = () => undefined,
): SqliteSource {
  let didRestartSplit = false;
  return openSqliteSourceWithSavedPlanFault(
    options,
    control,
    reachProof,
    {
      kind: 'split',
      targetId: 'late-target',
      beforeRestart,
      afterRestart: () => {
        didRestartSplit = true;
      },
    },
    (evidence) => {
      observeBoundary(evidence.savedPlan);
      // Proof: routing a wrong target through the ordinary transaction reached the
      // generic schedule seam until this callback required the scoped split restart.
      if (!didRestartSplit)
        throw new Error('saved-plan split target did not cross its transaction boundary');
      // Proof: changing canonical target content before repository entry used to mark
      // the split phase from a self-derived request even though the shared assertion failed.
      if (JSON.stringify(evidence.savedPlan) !== JSON.stringify(expectedLateTargetPartial()))
        throw new Error('saved-plan split boundary does not match the canonical target');
    },
  );
}

function expectedLateTargetPartial(): StoredSavedPlan {
  return {
    header: {
      id: 'late-target',
      projectId: 'project-a',
      name: 'Late target',
      createdBy: 'Quota Writer',
      createdById: 'owner-b',
      createdAt: 522,
      inputSchemaVersion: 11,
      inputBytes: 15,
      inputSha256: '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
      scheduleSchemaVersion: 12,
      scheduleBytes: 18,
      scheduleSha256: '67f1fdbc1d60444b0f4a7e14af440a54c9be6cb9004c37a71db3a6c70745d160',
      scheduleInputSha256: '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4',
      schedulerAlgorithmId: 'conformance-scheduler',
      scheduleAbsentReason: null,
    },
    bodies: { input: 'late-input-🔧', schedule: null },
  };
}

function openSqliteSourceWithSavedPlanFault(
  options: OpenSqliteSourceOptions,
  control: SqliteLateWriteControl<'saved-plan-schedule-body'>,
  reachProof: () => void,
  fault: SavedPlanWriteFault,
  validateReach: (evidence: SqliteLateWriteEvidence) => void = () => undefined,
): SqliteSource {
  const lateWrite: SqliteLateWriteSeam = {
    isActive: (phase) => control.isArmed() && phase === control.phase,
    reach(phase, evidence) {
      validateReach(evidence ?? {});
      if (control.reachTransactionWrite(phase, evidence)) {
        reachProof();
        throw new Error(`injected SQLite fault at ${phase}`);
      }
    },
  };
  const source = openSqliteSourceWithLateWriteSeam(options, lateWrite);
  const connect = options.openConnection ?? openConnection;
  const savedPlans = new SavedPlanRepository(
    { openConnection: () => connect(options.dbPath) },
    lateWrite,
  );
  armSavedPlanWriteFault(savedPlans, fault);
  return { ...source, history: { ...source.history, savedPlans } };
}

/** Opens the real repository with its input insert omitted before the late barrier. */
export function openSqliteSourceWithMissingSavedPlanInput(
  options: OpenSqliteSourceOptions,
  control: SqliteLateWriteControl<'saved-plan-schedule-body'>,
  reachProof: () => void,
  observeBoundary?: (stored: StoredSavedPlan) => void,
): SqliteSource {
  return openSqliteSourceWithSavedPlanFault(options, control, reachProof, {
    kind: 'omit-input',
    targetId: 'late-target',
    observeBoundary,
  });
}
