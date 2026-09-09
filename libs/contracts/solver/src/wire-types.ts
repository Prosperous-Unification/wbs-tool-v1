/**
 * The TypeScript binding of `solver-wire.v1.json` (2.1).
 *
 * The schema is the contract and the Python side reads the very same file, so
 * nothing here may be authored independently of it. Every vocabulary below is
 * a `const` array rather than a bare union so that `wire-types.test.ts` can
 * read the schema at run time and fail when the two drift — a union alone is
 * erased before any test can see it.
 */

/** `#/$defs/wireVersion` — a `const`, so the type is the literal. */
export const SOLVER_WIRE_VERSION = 1;
export type SolverWireVersion = typeof SOLVER_WIRE_VERSION;

/**
 * `#/$defs/response.properties.status` — the RUN-OUTCOME vocabulary: whether a
 * schedule is being returned at all and, if not, which of the two reasons
 * applies. `optimal` is deliberately absent; proof strength is per stage.
 */
export const SOLVER_RESPONSE_STATUSES = ['feasible', 'unknown', 'infeasible'] as const;
export type SolverResponseStatus = (typeof SOLVER_RESPONSE_STATUSES)[number];

/**
 * `#/$defs/objective-term.properties.status` — a different question: how
 * strong the proof for one stage is. Overlaps the run-outcome vocabulary in
 * two tokens and is not the same field.
 */
export const SOLVER_STAGE_STATUSES = ['optimal', 'feasible', 'unknown'] as const;
export type SolverStageStatus = (typeof SOLVER_STAGE_STATUSES)[number];

/** `#/$defs/objectiveValues` — every term is required, so this is its key set. */
export const SOLVER_OBJECTIVE_TERMS = ['makespan', 'priority', 'movement'] as const;
export type SolverObjectiveTerm = (typeof SOLVER_OBJECTIVE_TERMS)[number];

/**
 * `#/$defs/offsetMap` — units from day zero, one per slice, keyed by
 * `sliceKey()`'s result. TypeScript cannot express the key-set equality with
 * the request's slices; that invariant is the re-validator's (2.4), not the
 * type's.
 */
export type SolverOffsetMap = Readonly<Record<string, number>>;

/** `#/$defs/objective-term`. All four members are required; two are nullable. */
export interface SolverObjectiveTermValue {
  readonly value: number;
  readonly stageValue: number | null;
  readonly bound: number | null;
  readonly status: SolverStageStatus;
}

export type SolverObjectiveValues = Readonly<Record<SolverObjectiveTerm, SolverObjectiveTermValue>>;

/**
 * `#/$defs/response`, with the schema's `allOf` conditional carried as the
 * discriminant rather than as a runtime check: `feasible` is the only status
 * that publishes, so it is the only one that carries `offsets` and
 * `objectiveValues`, and it carries BOTH. The other two carry NEITHER — and
 * absent rather than `{}`, because an empty map is a well-formed `offsetMap`
 * that would pass the schema and then fail the key-set invariant one layer
 * later, reporting a vocabulary decision as a corrupt payload.
 */
export type SolverResponse =
  | {
      readonly wireVersion: SolverWireVersion;
      readonly status: 'feasible';
      readonly offsets: SolverOffsetMap;
      readonly objectiveValues: SolverObjectiveValues;
    }
  | {
      readonly wireVersion: SolverWireVersion;
      readonly status: Exclude<SolverResponseStatus, 'feasible'>;
      readonly offsets?: undefined;
      readonly objectiveValues?: undefined;
    };

/**
 * The property names `#/$defs/response` admits. The branch is
 * `additionalProperties: false`, so this is the closed set an unknown-key
 * rejection is written against (2.3).
 */
export const SOLVER_RESPONSE_KEYS = [
  'wireVersion',
  'status',
  'offsets',
  'objectiveValues',
] as const;
export type SolverResponseKey = (typeof SOLVER_RESPONSE_KEYS)[number];

/** The members `#/$defs/objective-term` requires — all four of them. */
export const SOLVER_OBJECTIVE_TERM_KEYS = ['value', 'stageValue', 'bound', 'status'] as const;

/* ------------------------------------------------------------------------- *
 * The request side.
 *
 * Same rule as above: every vocabulary is a `const` array pinned to its schema
 * branch by the drift guard, because a bare union is erased before a test can
 * see it. Bun owns duration and graph derivation and Python owns placement
 * only, so nothing here carries the tree — no `parentId`, no `dep_reach`.
 * ------------------------------------------------------------------------- */

/** `#/$defs/request.properties.objective` — the two independently solved runs. */
export const SOLVER_OBJECTIVES = ['pri', 'time'] as const;
export type SolverObjective = (typeof SOLVER_OBJECTIVES)[number];

/**
 * `#/$defs/request.properties.horizonUnits.maximum`. The serial bound is
 * checked against this **before spawn** (2.10), because it is the CP-SAT
 * variable domain and not a preference.
 */
export const SOLVER_HORIZON_UNITS_MAX = 2147483647;

/**
 * `#/$defs/request.properties.stageBudgetSplit` is `minItems` = `maxItems` = 3.
 * Exactly three stages, so the split is a fixed-length tuple rather than a list
 * that happens to have three entries today.
 */
export const SOLVER_STAGE_COUNT = 3;
export type SolverStageBudgetSplit = readonly [number, number, number];

/** `#/$defs/edge` — two named endpoints, asymmetric, never a 2-array. */
export const SOLVER_EDGE_KEYS = ['predecessorKey', 'successorKey'] as const;
export interface SolverEdge {
  readonly predecessorKey: string;
  readonly successorKey: string;
}

/** `#/$defs/slice`. Every member is required; two of them are nullable. */
export const SOLVER_SLICE_KEYS = [
  'workItemKey',
  'key',
  'durationUnits',
  'width',
  'personId',
  'poolIds',
  'priorityWeight',
  'notBeforeUnits',
  'deadlineUnits',
  'workItemIsMilestone',
] as const;
export interface SolverSlice {
  /** Opaque work-item identity, carried separately so consumers never parse {@link key}. */
  readonly workItemKey: string;
  readonly key: string;
  readonly durationUnits: number;
  /** People, so at least 1: duration is effort divided by width and 0 is Infinity days. */
  readonly width: number;
  readonly personId: string | null;
  /** A sorted set. The whole width is spent in **each** pool named here. */
  readonly poolIds: readonly string[];
  readonly priorityWeight: number;
  readonly notBeforeUnits: number;
  /** The **effective** deadline, already folded over the tree. `null` is unconstrained. */
  readonly deadlineUnits: number | null;
  /** True only when every slice of this work item has zero duration. */
  readonly workItemIsMilestone: boolean;
}

/**
 * `#/$defs/request`. Every one of the thirteen members is required — the branch
 * lists them all in `required` — so there is no optional field to forget.
 */
export const SOLVER_REQUEST_KEYS = [
  'wireVersion',
  'contractVersion',
  'solverVersion',
  'objective',
  'budgetMs',
  'stageBudgetSplit',
  'quantum',
  'horizonUnits',
  'slices',
  'edges',
  'pools',
  'baselineOffsets',
  'fastHint',
] as const;
export type SolverRequestKey = (typeof SOLVER_REQUEST_KEYS)[number];

export interface SolverRequest {
  readonly wireVersion: SolverWireVersion;
  readonly contractVersion: string;
  readonly solverVersion: string;
  readonly objective: SolverObjective;
  readonly budgetMs: number;
  readonly stageBudgetSplit: SolverStageBudgetSplit;
  readonly quantum: number;
  readonly horizonUnits: number;
  readonly slices: readonly SolverSlice[];
  readonly edges: readonly SolverEdge[];
  /** Pool id to capacity. A pool of 0 slots is a plan of Infinity dates, so capacity floors at 1. */
  readonly pools: Readonly<Record<string, number>>;
  readonly baselineOffsets: SolverOffsetMap;
  readonly fastHint: SolverOffsetMap;
}
