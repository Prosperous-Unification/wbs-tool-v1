import {
  decodeSchedule,
  encodeSchedule,
  type PublicationDecision,
  type Schedule,
  type StoredSchedule,
} from '@wbs/domain';

import {
  SOLVER_OBJECTIVE_TERM_KEYS,
  SOLVER_OBJECTIVE_TERMS,
  SOLVER_STAGE_STATUSES,
  type SolverObjectiveTerm,
  type SolverObjectiveTermValue,
} from './wire-types';

/**
 * 4.12b — the envelope `optimized_schedule_cache.result_json` actually holds,
 * and the only validator of the two enums that live inside it.
 *
 * **Why it is here and not in `libs/domain` beside 4.12's schedule codec.**
 * The envelope needs both halves: `encodeSchedule` from `@wbs/domain` and the
 * stage-status vocabulary the wire schema generates. `libs/contracts/solver`
 * already imports `@wbs/domain` in five production modules
 * (`solver-units`, `build-solver-slices`, `build-solver-edges`,
 * `build-solver-request`, `quantised-baseline`), so the import direction is
 * established; the reverse would make `@wbs/domain` depend on the package that
 * depends on it, which is a project cycle rather than a tag violation, and the
 * tag constraints would have allowed it.
 *
 * **Why the row is not a bare schedule (Sol r7 Critical 6).** `Schedule`
 * carries neither `objectiveValues` — which is what records how far a partially
 * staged run got — nor the publication indicator the 4.11b guard must persist,
 * so a cache holding only `scheduleJson` discarded both at storage.
 */

/**
 * The version of the stored **result envelope**, distinct from 4.12's
 * `CACHE_DTO_VERSION`, which versions the schedule nested inside it.
 *
 * Two numbers rather than one, because the two shapes change for different
 * reasons: a new objective term or a third publication kind moves this one, a
 * new `Schedule` field moves the other. **They are no longer equal** — this
 * one is 1 and `CACHE_DTO_VERSION` went to 2 on 2026-09-06 when
 * `ScheduledSlice` gained a required `lateBy`, which is the reason it was
 * written down that their being equal was a coincidence rather than a rule.
 * Nothing below compares them.
 *
 * Like 4.12's, it is a **read fence, not a migration**: a row stamped otherwise
 * is refused by {@link decodeOptimizedResult}, the cache read reports `corrupt`
 * (4.8) and the ordinary admission path recomputes.
 */
export const RESULT_DTO_VERSION = 1;

/**
 * Which of the two schedules the row holds.
 *
 * Stored rather than inferred, because a `quantisation-floor` row **is** Fast's
 * schedule: the solver's quantisation-optimal answer scored worse in the real
 * domain and the guard published Fast instead. A comparison indicator that
 * re-derived this would present that row as a solver win.
 *
 * It lives here and **never in a term's `status`** (Sol r8 Critical 5, kimi r8
 * Important 2). The matrix fixes the stage-status enum at three values and
 * generates both the wire schema and 4.8's validator from it, so a fourth token
 * there leaves the codec rejecting the very row the guard has to store.
 */
export const OPTIMIZED_PUBLICATIONS = ['solver', 'quantisation-floor'] as const;
export type OptimizedPublication = (typeof OPTIMIZED_PUBLICATIONS)[number];

/**
 * One objective term as the row carries it.
 *
 * Deliberately an alias rather than a twin declaration: tasks.md 4.12b says the
 * stored shape is **identical to the wire shape**, and `stageValue` and `bound`
 * are already nullable on the wire (matrix row `UNKNOWN, no incumbent, k > 1`),
 * so storage widens nothing. Two structurally equal interfaces would let the
 * two drift while every test still passed.
 */
export type StoredObjectiveValue = SolverObjectiveTermValue;

/** What the optimizer produced, as the cache stores and returns it. */
export interface OptimizedResult {
  readonly publication: OptimizedPublication;
  readonly objectiveValues: Readonly<Record<SolverObjectiveTerm, StoredObjectiveValue>>;
  readonly schedule: Schedule;
}

/** The JSON shape of {@link OptimizedResult}, i.e. what `result_json` holds. */
export interface StoredOptimizedResult {
  dtoVersion: number;
  publication: OptimizedPublication;
  objectiveValues: Record<SolverObjectiveTerm, StoredObjectiveValue>;
  schedule: StoredSchedule;
}

/** The prefix every defect below carries, so a corrupt row is diagnosable from the log line. */
function defect(message: string): Error {
  return new Error(`stored result: ${message}`);
}

/**
 * A stored value as a message may quote it.
 *
 * Not `JSON.stringify` alone: its lib signature promises a `string` and it
 * returns `undefined` for `undefined`, a function and a symbol, so three
 * different defects would every one read `... is undefined`.
 */
function show(value: unknown): string {
  switch (typeof value) {
    case 'object':
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    default:
      return typeof value;
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw defect(`${what} is not an object: ${show(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * The numeric domain, **per `publication` rather than blanket** (Sol r12
 * Critical 1).
 *
 * A `'solver'` row's numbers are quantised solver units and obey the wire's own
 * rule: non-negative safe integers. A `'quantisation-floor'` row's `value` is
 * recomputed in the **real** domain on the stored Fast schedule, where
 * `durationOf` keeps `days / width` fractional
 * (`libs/domain/src/schedule.ts:539-541`), so the mandated width-5 floor row's
 * makespan is 0.6 workdays. A blanket safe-integer rule is therefore not merely
 * strict, it is unsatisfiable: it would reject the one row 4.11b is required to
 * store.
 *
 * `NaN`, both infinities and negatives are refused under both readings.
 */
function checkNumber(
  value: unknown,
  what: string,
  publication: OptimizedPublication,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw defect(`${what} is not a finite non-negative number: ${show(value)}`);
  }
  if (publication === 'solver' && !Number.isSafeInteger(value)) {
    throw defect(`${what} is not a safe integer: ${show(value)}`);
  }
}

/**
 * One term, validated against the row's own publication.
 *
 * `stageValue` and `bound` are the solver's proof state — the incumbent it had
 * when the stage's budget ran out and the bound it had proved — and a
 * `quantisation-floor` row has neither, because no stage produced its numbers:
 * the schedule is Fast's and the values were rescored afterwards. They are
 * required to be `null` there rather than merely expected to be, so that 2.4's
 * `value <= stageValue` relation is structurally absent on a floor row instead
 * of being a relation between a real-domain value and a quantised one.
 */
function readTerm(
  raw: unknown,
  term: SolverObjectiveTerm,
  publication: OptimizedPublication,
): StoredObjectiveValue {
  const value = asRecord(raw, `objectiveValues.${term}`);

  const extra = Object.keys(value).filter(
    (key) => !SOLVER_OBJECTIVE_TERM_KEYS.includes(key as never),
  );
  if (extra.length > 0) {
    throw defect(`objectiveValues.${term} carries the unknown key ${extra.sort().join(', ')}`);
  }

  const status = value['status'];
  if (typeof status !== 'string' || !SOLVER_STAGE_STATUSES.includes(status as never)) {
    throw defect(`objectiveValues.${term}.status is ${show(status)}`);
  }

  const raws = { value: value['value'], stageValue: value['stageValue'], bound: value['bound'] };
  checkNumber(raws.value, `objectiveValues.${term}.value`, publication);

  for (const half of ['stageValue', 'bound'] as const) {
    const held = raws[half];
    if (held === null) continue;
    if (publication === 'quantisation-floor') {
      throw defect(
        `objectiveValues.${term}.${half} is ${show(held)} on a quantisation-floor row, ` +
          'which has no stage',
      );
    }
    checkNumber(held, `objectiveValues.${term}.${half}`, publication);
  }

  return {
    value: raws.value,
    stageValue: raws.stageValue as number | null,
    bound: raws.bound as number | null,
    status: status as StoredObjectiveValue['status'],
  };
}

/**
 * An {@link OptimizedResult} in the shape that goes into `result_json`.
 *
 * The terms are written in {@link SOLVER_OBJECTIVE_TERMS} order rather than in
 * whatever order the caller's object happens to carry, for the same reason
 * 4.12 sorts its map entries: one result, one encoding.
 */
export function encodeOptimizedResult(result: OptimizedResult): StoredOptimizedResult {
  const objectiveValues = {} as Record<SolverObjectiveTerm, StoredObjectiveValue>;
  for (const term of SOLVER_OBJECTIVE_TERMS) {
    const held = result.objectiveValues[term];
    objectiveValues[term] = {
      value: held.value,
      stageValue: held.stageValue,
      bound: held.bound,
      status: held.status,
    };
  }
  return {
    dtoVersion: RESULT_DTO_VERSION,
    publication: result.publication,
    objectiveValues,
    schedule: encodeSchedule(result.schedule),
  };
}

/**
 * A stored payload back into an {@link OptimizedResult}, or a throw naming the
 * defect.
 *
 * **This is where the two JSON-held enums are enforced** (Sol r10 Important
 * 11). `publication` and the per-term `status` live inside `result_json`, so no
 * column `CHECK` covers either and none is generated: a malformed payload has
 * to insert and then surface as `corrupt` on the read, which is what keeps it
 * retryable. A constraint would turn a corrupt row into a failed write.
 *
 * The nested schedule is handed to 4.12's {@link decodeSchedule}, which owns
 * its own four defects (unknown `dtoVersion`, a duplicate key, a key
 * disagreeing with its entry, a missing projection) and throws with its own
 * prefix.
 */
export function decodeOptimizedResult(raw: unknown): OptimizedResult {
  const dto = asRecord(raw, 'the payload');
  // Bracketed throughout: `dto` is an index signature and this package compiles
  // under `noPropertyAccessFromIndexSignature`, where dotted access would read
  // as a declared field and hide that every one of these came off a stored
  // string.
  const version = dto['dtoVersion'];
  if (version !== RESULT_DTO_VERSION) {
    throw defect(
      `unknown dtoVersion ${show(version)}; this release reads ${String(RESULT_DTO_VERSION)}`,
    );
  }

  const publication = dto['publication'];
  if (typeof publication !== 'string' || !OPTIMIZED_PUBLICATIONS.includes(publication as never)) {
    throw defect(`publication is ${show(publication)}`);
  }
  const kind = publication as OptimizedPublication;

  const rawTerms = asRecord(dto['objectiveValues'], 'objectiveValues');
  const extra = Object.keys(rawTerms).filter(
    (key) => !SOLVER_OBJECTIVE_TERMS.includes(key as never),
  );
  if (extra.length > 0) {
    throw defect(`objectiveValues carries the unknown term ${extra.sort().join(', ')}`);
  }
  const objectiveValues = {} as Record<SolverObjectiveTerm, StoredObjectiveValue>;
  for (const term of SOLVER_OBJECTIVE_TERMS) {
    if (!(term in rawTerms)) {
      throw defect(`objectiveValues has no ${term} term`);
    }
    objectiveValues[term] = readTerm(rawTerms[term], term, kind);
  }

  return { publication: kind, objectiveValues, schedule: decodeSchedule(dto['schedule']) };
}

/**
 * 4.11b's boundary line: one {@link PublicationDecision} becomes the row.
 *
 * The guard lives in `libs/domain` and answers
 * `chosen: 'optimized' | 'baseline'` rather than naming a `publication`,
 * because {@link OPTIMIZED_PUBLICATIONS} is this library's vocabulary and a
 * second copy of those two literals in the engine is the copy that disagrees
 * after an edit. This function is that mapping, and it is production code
 * rather than a line each caller writes for itself, because the two arms are
 * not symmetric and the asymmetry is where a hand-written mapping goes wrong.
 *
 * **A `'solver'` row keeps the solver's own numbers.** They are quantised
 * integer units and {@link decodeOptimizedResult} requires safe integers of
 * them; the guard's real-domain scores measured the *comparison* and are not
 * what the run reported.
 *
 * **A `'quantisation-floor'` row keeps none of them.** Its schedule IS the
 * Baseline — real Fast — so every `value` is the real-domain score of the
 * schedule being stored, `stageValue` and `bound` are null because no stage
 * produced them, and `status` is `'unknown'`. 2.4's `value <= stageValue`
 * relation is deliberately not applied: it is a within-stage relation and has
 * no meaning across the quantised and real domains.
 *
 * @param decision What the guard returned, carrying the schedule to store and
 *   its real-domain score.
 * @param solverValues What the run itself reported, used only on the
 *   `'optimized'` arm.
 */
export function publishOptimizedResult(
  decision: PublicationDecision,
  solverValues: Readonly<Record<SolverObjectiveTerm, StoredObjectiveValue>>,
): OptimizedResult {
  if (decision.chosen === 'optimized') {
    return {
      publication: 'solver',
      objectiveValues: solverValues,
      schedule: decision.schedule,
    };
  }
  const objectiveValues = {} as Record<SolverObjectiveTerm, StoredObjectiveValue>;
  for (const term of SOLVER_OBJECTIVE_TERMS) {
    objectiveValues[term] = {
      value: decision.values[term],
      stageValue: null,
      bound: null,
      status: 'unknown',
    };
  }
  return { publication: 'quantisation-floor', objectiveValues, schedule: decision.schedule };
}
