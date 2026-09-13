import type {
  DependencyReach,
  EstimateMethod,
  EstimateRounding,
  IsoDate,
  MeasureMetric,
  PertWeights,
  PriorityBand,
  ScheduleEngine,
  SolverObjectiveName,
} from '@wbs/domain';

export interface CapturedProject {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly restricted: boolean;
  readonly estimateMethod: EstimateMethod;
  readonly depReach: DependencyReach;
  readonly pertWeights: PertWeights;
  readonly estimateRounding: EstimateRounding;
  readonly startDate: IsoDate | null;
  readonly scheduleEngine: ScheduleEngine;
  readonly scheduleObjective: SolverObjectiveName;
  readonly optimizationEnabled: boolean;
  readonly solutionRef: { readonly slug: string; readonly url: string } | null;
}

export interface CapturedStep {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface CapturedWorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly name: string;
  readonly notes: string;
  readonly frozenNumber: string | null;
  readonly startNoEarlierThan: IsoDate | null;
  readonly startNoEarlierThanReason: string | null;
  readonly deadline: IsoDate | null;
  readonly priority: number | null;
  readonly serviceTeamId: string | null;
  readonly serviceId: string | null;
  readonly maxParallel: number;
  readonly revision: number;
  readonly teamIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly typeIds: readonly string[];
  readonly externalRefs: readonly {
    readonly id: string;
    readonly systemId: string;
    readonly url: string;
  }[];
}

export interface CapturedEstimate {
  readonly workItemId: string;
  readonly stepId: string;
  readonly optimistic: number;
  readonly realistic: number;
  readonly pessimistic: number;
}

export interface CapturedActual {
  readonly workItemId: string;
  readonly stepId: string;
  readonly days: number;
  readonly recordedAt: number;
}

export interface CapturedProgress {
  readonly workItemId: string;
  readonly stepId: string;
  readonly state: 'in_progress' | 'done';
  readonly statedAt: number;
}

export interface CapturedMeasure {
  readonly workItemId: string;
  readonly stepId: string;
  readonly metric: MeasureMetric;
  readonly value: number;
  readonly recordedAt: number;
}

export interface CapturedDependency {
  readonly predecessorId: string;
  readonly successorId: string;
}

export interface CapturedAssignment {
  readonly workItemId: string;
  readonly stepId: string;
  readonly personId: string;
}

export interface CapturedNamedValue {
  readonly id: string;
  readonly name: string;
}

export interface CapturedPerson extends CapturedNamedValue {
  readonly teamIds: readonly string[];
}

export interface CapturedTeam extends CapturedNamedValue {
  readonly serviceIds: readonly string[];
}

/** Every detached row used to build one canonical saved-plan input. */
export interface PlanInputReads {
  readonly project: CapturedProject;
  readonly steps: readonly CapturedStep[];
  readonly workItems: readonly CapturedWorkItem[];
  readonly estimates: readonly CapturedEstimate[];
  readonly actuals: readonly CapturedActual[];
  readonly progress: readonly CapturedProgress[];
  readonly measures: readonly CapturedMeasure[];
  readonly dependencies: readonly CapturedDependency[];
  readonly assignments: readonly CapturedAssignment[];
  readonly capacity: ReadonlyMap<string, number>;
  readonly priorityBands: readonly PriorityBand[];
  readonly people: readonly CapturedPerson[];
  readonly teams: readonly CapturedTeam[];
  readonly services: readonly CapturedNamedValue[];
  readonly tags: readonly CapturedNamedValue[];
  readonly workItemTypes: readonly CapturedNamedValue[];
  readonly externalSystems: readonly CapturedNamedValue[];
}

/** A coherent source snapshot of one project's saved-plan input. */
export interface SavedPlanCaptureStore {
  readPlanInput(projectId: string): Promise<PlanInputReads | null>;
}
