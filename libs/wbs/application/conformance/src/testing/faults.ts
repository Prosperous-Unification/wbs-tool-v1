import type { CaseId } from '../case-manifest';
import { failureMessage } from '../failure-message';

export const FAULT_VARIANTS = {
  'break:steps.add:stored-value': { caseId: 'steps.add', sources: ['sqlite'] },
  'break:steps.add:seed-failure': { caseId: 'steps.add', sources: ['sqlite'] },
  'break:steps.add:cleanup-failure': { caseId: 'steps.add', sources: ['sqlite'] },
  'break:savedPlans.touch:principals-scope:principal-identity': {
    caseId: 'savedPlans.touch:principals-scope',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.touch:principals-scope:unknown-rename': {
    caseId: 'savedPlans.touch:principals-scope',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.touch:principals-scope:unknown-delete': {
    caseId: 'savedPlans.touch:principals-scope',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:bytes-and-bodies:utf8-length': {
    caseId: 'savedPlans.write:bytes-and-bodies',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:bytes-and-bodies:header-only': {
    caseId: 'savedPlans.write:bytes-and-bodies',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:bytes-and-bodies:altered-body': {
    caseId: 'savedPlans.write:bytes-and-bodies',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:bytes-and-bodies:altered-hash': {
    caseId: 'savedPlans.write:bytes-and-bodies',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:bytes-and-bodies:affected-row': {
    caseId: 'savedPlans.write:bytes-and-bodies',
    sources: ['sqlite'],
  },
  'break:priorityBands.replace:whole-project:priority-first-rung': {
    caseId: 'priorityBands.replace:whole-project',
    sources: ['memory', 'sqlite'],
  },
  'break:priorityBands.replace:whole-project:priority-project-scope': {
    caseId: 'priorityBands.replace:whole-project',
    sources: ['memory', 'sqlite'],
  },
  'break:calendarMarkers.write:project-scope:marker-project-scope': {
    caseId: 'calendarMarkers.write:project-scope',
    sources: ['memory', 'sqlite'],
  },
  'break:calendarMarkers.write:project-scope:marker-literal-date': {
    caseId: 'calendarMarkers.write:project-scope',
    sources: ['memory', 'sqlite'],
  },
  'break:workItems.setFrozenNumbers:clear:frozen-acquire': {
    caseId: 'workItems.setFrozenNumbers:clear',
    sources: ['memory', 'sqlite'],
  },
  'break:workItems.setFrozenNumbers:clear:frozen-clear': {
    caseId: 'workItems.setFrozenNumbers:clear',
    sources: ['memory', 'sqlite'],
  },
  'break:actuals.remove:pair:actual-remove-pair': {
    caseId: 'actuals.remove:pair',
    sources: ['memory', 'sqlite'],
  },
  'break:actuals.remove:pair:actual-remove-first-call': {
    caseId: 'actuals.remove:pair',
    sources: ['memory', 'sqlite'],
  },
  'break:measures.set:metric-key:measure-set-pair-identity': {
    caseId: 'measures.set:metric-key',
    sources: ['memory', 'sqlite'],
  },
  'break:measures.set:metric-key:measure-set-recorded-at': {
    caseId: 'measures.set:metric-key',
    sources: ['memory', 'sqlite'],
  },
  'break:measures.moveAll:all-metrics:measure-move-one-metric': {
    caseId: 'measures.moveAll:all-metrics',
    sources: ['memory', 'sqlite'],
  },
  'break:measures.moveAll:all-metrics:measure-move-recorded-at': {
    caseId: 'measures.moveAll:all-metrics',
    sources: ['memory', 'sqlite'],
  },
  'break:dependencies.add:idempotent-pair:dependency-id': {
    caseId: 'dependencies.add:idempotent-pair',
    sources: ['memory', 'sqlite'],
  },
  'break:dependencies.add:idempotent-pair:dependency-input-mutation': {
    caseId: 'dependencies.add:idempotent-pair',
    sources: ['memory', 'sqlite'],
  },
  'break:directory.assign:scope-replace-clear:directory-assignments-of-subset': {
    caseId: 'directory.assign:scope-replace-clear',
    sources: ['memory', 'sqlite'],
  },
  'break:directory.assign:scope-replace-clear:directory-assignment-scope': {
    caseId: 'directory.assign:scope-replace-clear',
    sources: ['memory', 'sqlite'],
  },
  'break:dependencies.removeAllFor:touching-set:dependency-outgoing-only': {
    caseId: 'dependencies.removeAllFor:touching-set',
    sources: ['memory', 'sqlite'],
  },
  'break:dependencies.removeAllFor:touching-set:dependency-incomplete-set': {
    caseId: 'dependencies.removeAllFor:touching-set',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.flip:preconditions:journal-retained-preconditions': {
    caseId: 'journal.flip:preconditions',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.flip:preconditions:journal-restamp-flips': {
    caseId: 'journal.flip:preconditions',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:history-atomic:journal-independent-history': {
    caseId: 'journal.append:history-atomic',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:history-atomic:journal-late-outside': {
    caseId: 'journal.append:history-atomic',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:history-atomic:journal-collateral-actor': {
    caseId: 'journal.append:history-atomic',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:account-redo-depth:journal-replacement-corruption': {
    caseId: 'journal.append:account-redo-depth',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:account-redo-depth:journal-broad-redo': {
    caseId: 'journal.append:account-redo-depth',
    sources: ['memory', 'sqlite'],
  },
  'break:journal.append:account-redo-depth:journal-history-prune': {
    caseId: 'journal.append:account-redo-depth',
    sources: ['memory', 'sqlite'],
  },
  'break:subtrees.insertSubtree:complete-copy:subtree-dependency-backing': {
    caseId: 'subtrees.insertSubtree:complete-copy',
    sources: ['memory', 'sqlite'],
  },
  'break:subtrees.insertSubtree:complete-copy:subtree-removed-measure': {
    caseId: 'subtrees.insertSubtree:complete-copy',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-refusal:saved-plan-persisted-refusal': {
    caseId: 'savedPlans.write:quota-refusal',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-window:saved-plan-stale-quota': {
    caseId: 'savedPlans.write:quota-window',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:late-body-failure:saved-plan-split-write': {
    caseId: 'savedPlans.write:late-body-failure',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:late-body-failure:saved-plan-missing-input': {
    caseId: 'savedPlans.write:late-body-failure',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-mutation': {
    caseId: 'savedPlans.write:quota-refusal',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-window:saved-plan-window-no-mutation': {
    caseId: 'savedPlans.write:quota-window',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:late-body-failure:saved-plan-late-no-mutation': {
    caseId: 'savedPlans.write:late-body-failure',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-refusal:saved-plan-refusal-premature': {
    caseId: 'savedPlans.write:quota-refusal',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-window:saved-plan-window-premature': {
    caseId: 'savedPlans.write:quota-window',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:late-body-failure:saved-plan-late-premature': {
    caseId: 'savedPlans.write:late-body-failure',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-refusal:saved-plan-refusal-no-reach': {
    caseId: 'savedPlans.write:quota-refusal',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:quota-window:saved-plan-window-no-reach': {
    caseId: 'savedPlans.write:quota-window',
    sources: ['memory', 'sqlite'],
  },
  'break:savedPlans.write:late-body-failure:saved-plan-late-no-reach': {
    caseId: 'savedPlans.write:late-body-failure',
    sources: ['memory', 'sqlite'],
  },
} as const satisfies Record<string, { caseId: CaseId; sources: readonly FaultSource[] }>;

export type FaultSource = 'memory' | 'sqlite';
type VariantFaultId = keyof typeof FAULT_VARIANTS;
type VariantCaseId = (typeof FAULT_VARIANTS)[VariantFaultId]['caseId'];
type CanonicalFaultId = `break:${Exclude<CaseId, VariantCaseId>}`;
export type FaultId = CanonicalFaultId | VariantFaultId;

export type FaultCase<Id extends FaultId> = Id extends VariantFaultId
  ? (typeof FAULT_VARIANTS)[Id]['caseId']
  : Id extends `break:${infer FaultCase extends CaseId}`
    ? FaultCase
    : never;

export interface FaultControl<Phase extends string> {
  readonly phase: Phase;
  claim(): boolean;
  arm(): void;
  isArmed(): boolean;
  reach(phase: Phase): boolean;
  reached(): boolean;
}

interface RegisteredFault<
  Subject,
  Id extends FaultId,
  Phase extends string = string,
  Control extends FaultControl<Phase> = FaultControl<Phase>,
> {
  readonly id: Id;
  readonly caseId: FaultCase<Id>;
  createControl(): Control;
  mutate(subject: Subject, control: Control): Subject;
}

export interface FaultRun<
  Subject,
  Id extends FaultId = FaultId,
  Phase extends string = string,
  Control extends FaultControl<Phase> = FaultControl<Phase>,
> {
  readonly id: Id;
  readonly caseId: FaultCase<Id>;
  readonly control: Control;
  mutate(subject: Subject, control: Control): Subject;
}

/** The closed fault registry, discriminated by manifest-derived fault ID. */
export type Fault<
  Subject,
  Phase extends string = string,
  Control extends FaultControl<Phase> = FaultControl<Phase>,
> = {
  [Id in FaultId]: RegisteredFault<Subject, Id, Phase, Control>;
}[FaultId];

/** Refuses missing, duplicate or source-inapplicable entries in an adapter's named mutation inventory. */
export function assertFaultVariantCoverage(
  source: FaultSource,
  faults: readonly { readonly id: FaultId }[],
): void {
  const expected = Object.entries(FAULT_VARIANTS)
    .filter(([, entry]) => (entry.sources as readonly FaultSource[]).includes(source))
    .map(([id]) => id)
    .toSorted();
  const observed = faults
    .map(({ id }) => id)
    .filter((id): id is VariantFaultId => Object.hasOwn(FAULT_VARIANTS, id))
    .toSorted();
  const duplicates = observed.filter((id, index) => observed.indexOf(id) !== index);
  // Proof: omitting a real adapter fault, repeating one, or supplying SQLite's
  // lifecycle mutation to memory independently fails this exact inventory.
  if (duplicates.length > 0 || expected.length !== observed.length) {
    throw new Error(
      `${source} fault variant coverage mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== observed[index]) {
      throw new Error(
        `${source} fault variant coverage mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
    }
  }
}

/** Creates one activation state owned by one broken-source proof run. */
export function createFaultControl<const Phase extends string>(phase: Phase): FaultControl<Phase> {
  let isArmed = false;
  let hasReached = false;
  let isClaimed = false;
  return {
    phase,
    claim() {
      if (isClaimed) return false;
      isClaimed = true;
      return true;
    },
    arm() {
      isClaimed = true;
      if (isArmed) throw new Error(`fault control for ${phase} was already armed`);
      isArmed = true;
    },
    isArmed: () => isArmed,
    reach(reachedPhase) {
      if (!isArmed || reachedPhase !== phase) return false;
      hasReached = true;
      return true;
    },
    reached: () => hasReached,
  };
}

/** Keeps the fault ID and its owning manifest case coupled at compilation. */
export function defineFault<
  Subject,
  const Id extends FaultId,
  const Phase extends string,
  Control extends FaultControl<Phase>,
>(
  fault: RegisteredFault<Subject, Id, Phase, Control>,
): RegisteredFault<Subject, Id, Phase, Control> {
  return fault;
}

export type FaultProof =
  | {
      readonly kind: 'observed';
      readonly faultId: FaultId;
      readonly caseId: CaseId;
      readonly phase: string;
      readonly assertion: string;
      readonly observedFailure: string;
    }
  | {
      readonly kind: 'setup-failed';
      readonly faultId: FaultId;
      readonly caseId: CaseId;
      readonly failure: string;
    }
  | {
      readonly kind: 'phase-failed';
      readonly faultId: FaultId;
      readonly caseId: CaseId;
      readonly phase: string;
      readonly failure: string;
    }
  | {
      readonly kind: 'assertion-passed';
      readonly faultId: FaultId;
      readonly caseId: CaseId;
      readonly phase: string;
      readonly assertion: string;
    };

export interface FaultProofPlan<
  Context,
  Subject,
  Phase extends string,
  Control extends FaultControl<Phase>,
> {
  readonly assertion: string;
  setup(run: FaultRun<Subject, FaultId, Phase, Control>): Promise<Context>;
  exercise(context: Context): Promise<void>;
  assert(context: Context): Promise<void>;
}

/** Accepts a broken assertion only after verified setup and its named phase. */
export async function recordFaultProof<
  Context,
  Subject,
  Phase extends string,
  Control extends FaultControl<Phase>,
>(
  fault: Fault<Subject, Phase, Control>,
  plan: FaultProofPlan<Context, Subject, Phase, Control>,
): Promise<FaultProof> {
  const control = fault.createControl();
  if (!control.claim()) {
    return {
      kind: 'setup-failed',
      faultId: fault.id,
      caseId: fault.caseId,
      failure: `fault control for ${control.phase} was reused across proof runs`,
    };
  }
  const run: FaultRun<Subject, typeof fault.id, Phase, Control> = {
    id: fault.id,
    caseId: fault.caseId,
    control,
    mutate: (subject, runControl) => fault.mutate(subject, runControl),
  };
  let context: Context;
  try {
    context = await plan.setup(run);
  } catch (failure) {
    return {
      kind: 'setup-failed',
      faultId: fault.id,
      caseId: fault.caseId,
      failure: failureMessage(failure),
    };
  }

  control.arm();
  try {
    await plan.exercise(context);
  } catch (failure) {
    return {
      kind: 'phase-failed',
      faultId: fault.id,
      caseId: fault.caseId,
      phase: control.phase,
      failure: failureMessage(failure),
    };
  }
  if (!control.reached()) {
    return {
      kind: 'phase-failed',
      faultId: fault.id,
      caseId: fault.caseId,
      phase: control.phase,
      failure: `fault did not reach ${control.phase}`,
    };
  }
  try {
    await plan.assert(context);
    return {
      kind: 'assertion-passed',
      faultId: fault.id,
      caseId: fault.caseId,
      phase: control.phase,
      assertion: plan.assertion,
    };
  } catch (failure) {
    return {
      kind: 'observed',
      faultId: fault.id,
      caseId: fault.caseId,
      phase: control.phase,
      assertion: plan.assertion,
      observedFailure: failureMessage(failure),
    };
  }
}
