import { isOnTime, lastWorkdayOf, SOLVER_QUANTUM } from '@wbs/domain';

import {
  SOLVER_OBJECTIVE_TERMS,
  type SolverObjectiveTerm,
  type SolverRequest,
  type SolverResponse,
  type SolverSlice,
} from './wire-types';

/**
 * 2.4 — re-validation, placement half.
 *
 * `parseSolverResponse` (2.3) proves the bytes are a well-formed response. It
 * proves nothing about whether the schedule inside them is one Bun may publish:
 * the schema has no access to the request, so it cannot know that an offset map
 * is missing a slice, that an edge is violated, or that a pool is oversubscribed.
 * The golden corpus makes that gap concrete rather than theoretical — its own
 * `request/valid-two-slices.json` is schema-valid with a width-5 slice drawn
 * against a capacity-2 pool, so the schema accepts a request whose only feasible
 * schedule does not exist. Re-validation is the only thing standing between a
 * wrong solver and a published plan.
 *
 * Every rejection here is the coordinator's `invalid-output` disposition, never
 * `plan-infeasible`: a solver that returns `feasible` and breaks a constraint is
 * a broken engine, not an infeasible plan. So this returns a result rather than
 * throwing, for the same reason 2.3 does — the caller records a value, and an
 * exception would make it re-derive that value from a message.
 *
 * This module carries the placement rules and the objective arithmetic. The
 * deadline clause is stated on the MATERIALISED schedule in the real fractional
 * domain, so it cannot be reached from `(request, response)` alone and lives in
 * {@link revalidateOptimizedDeadlines} at the foot of this file — a second
 * entry point the caller composes after materialising, not another block here.
 * The reason it is split rather than folded in is written out there.
 */

/*
 * Proof: 2.7 asks for the removed check to be named, one per rule, because
 * re-validation is the only thing standing between a wrong solver and a
 * published schedule and a check that cannot fail is the failure mode AGENTS.md
 * R5 names. Each row below was RUN on h2puni against `libs/contracts` — the
 * check disabled in a byte-verified copy, the suite recorded, the file restored
 * and re-compared — and each names the single case that went red. A mutation
 * that failed to apply was caught by `cmp` and re-run rather than scored as a
 * pass, which happened once.
 *
 *   edge respected            widened by 1e6              69/1  successor case
 *   every pool, not the first `poolIds.slice(0, 1)`       69/1  every-pool case
 *   notBeforeUnits floor      compared against -1         69/1  floor case
 *   assignee non-overlap      capacity 1 -> 99            69/1  double-booking
 *   releases before starts    sweep sorts starts first    68/2  BOTH exactly-met
 *   offset domain (2.9)       guard removed               69/1  fractional/neg/horizon
 *   value matches offsets     comparison neutered         69/1  disagreeing term
 *   value <= stageValue       widened by 1000             69/1  worse-than-incumbent
 *   ...and not `!==`          tightened to `!==`          69/1  strictly-better case
 *   objective overflow        bound raised x1000          69/1  overflow case
 *   wire safe-integer rule    disabled                    69/1  wire-domain case
 *   baseline domain           disabled                    69/1  unbuildable request
 *
 * The sweep ordering is the row worth reading twice: it fails BOTH exactly-met
 * neighbours and no violation case at all, which is what "the ordering, not the
 * comparison, is what makes an exactly-met constraint legal" looks like as a
 * measurement. The counts are 69/1 against the 70-test suite at
 * `2df9bc97`, and 61/1 or 60/2 against the 62-test suite at `411af89b` for the
 * five placement rows, which landed first.
 *
 * One row is absent on purpose. An `Object.hasOwn` presence check in front of
 * the baseline domain check was disabled and NOTHING failed (70/0): it was the
 * careful spelling of a check rather than a check, because
 * `Number.isSafeInteger(undefined)` is already false. It was deleted, not
 * documented.
 *
 * Still owed by 2.7: the `days / width` mutation against 2.6's width case,
 * which needs 2.2's request builder to exist.
 */

/**
 * Why a schedule was refused. One code per distinct repair, and each names a
 * different broken thing: the solver answered about the wrong slice set, put a
 * slice outside the variable domain, ignored an edge, ignored a floor, or
 * oversubscribed a pool or a person. They are diagnosis, not disposition.
 *
 * `malformed-request` is the one code that does not blame the solver. It fires
 * when the request itself cannot support a verdict — a duplicate slice key, an
 * edge naming a slice that does not exist, a pool that carries no capacity.
 * Reporting that as a solver fault would send the repair to the wrong side of
 * the seam, and passing it silently would let a check report success on a
 * question it never asked.
 */
export const SOLVER_REVALIDATION_FAILURES = [
  'malformed-request',
  'offset-key-mismatch',
  'offset-domain',
  'edge-violated',
  'floor-violated',
  'pool-overcapacity',
  'assignee-double-booked',
  'objective-domain',
  'objective-overflow',
  'objective-regression',
  'objective-mismatch',
  'deadline-violated',
] as const;
export type SolverRevalidationFailure = (typeof SOLVER_REVALIDATION_FAILURES)[number];

/**
 * `published` distinguishes the two ways a response can be acceptable. Only
 * `feasible` carries a schedule, so a non-publishing response passes with
 * nothing checked, and the caller must not read that as "there is a plan".
 */
export type RevalidatedSolverResult =
  | { readonly ok: true; readonly published: boolean }
  | {
      readonly ok: false;
      readonly failure: SolverRevalidationFailure;
      readonly detail: string;
    };

const refuse = (failure: SolverRevalidationFailure, detail: string): RevalidatedSolverResult => ({
  ok: false,
  failure,
  detail,
});

/** A slice placed at an offset. Occupancy is half-open: `[start, finish)`. */
interface Placement {
  readonly slice: SolverSlice;
  readonly start: number;
  readonly finish: number;
}

/**
 * A sweep over half-open intervals, refusing the first instant at which the
 * running load exceeds `capacity`.
 *
 * Two orderings matter and neither is cosmetic. Releases run before
 * acquisitions at the same instant, so a slice finishing exactly where the next
 * starts is a hand-off and not an overlap — the same closed-then-open reading
 * the edge rule uses. And zero-length placements are dropped before the sweep
 * rather than emitted as a coincident pair, because a pair at one instant has
 * no ordering that is both non-negative and non-occupying.
 */
const overloadAt = (
  placements: readonly Placement[],
  weightOf: (placement: Placement) => number,
  capacity: number,
): { readonly at: number; readonly load: number } | null => {
  const events: { time: number; delta: number }[] = [];
  for (const placement of placements) {
    if (placement.finish <= placement.start) continue;
    const weight = weightOf(placement);
    events.push({ time: placement.start, delta: weight });
    events.push({ time: placement.finish, delta: -weight });
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let load = 0;
  for (const event of events) {
    load += event.delta;
    if (load > capacity) return { at: event.time, load };
  }
  return null;
};

const isNonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The three cost terms of 5.2, recomputed from the final offsets in quantised
 * units: `MAKESPAN = max finish`, `PRIORITY = Σ priorityWeight(s) · finish(s)`,
 * `MOVEMENT = Σ |start(s) − baselineOffsets[s]|`.
 *
 * The accumulator is `bigint` for the same reason 2.10's preflight bound is:
 * `PRIORITY` multiplies a weight by a horizon and sums that over every slice,
 * so a `number` accumulator would silently round the overflow it is here to
 * detect and then agree with whatever the solver reported.
 */
const recomputeObjectives = (
  request: SolverRequest,
  placements: readonly Placement[],
): Record<SolverObjectiveTerm, bigint> => {
  let makespan = 0n;
  let priority = 0n;
  let movement = 0n;
  for (const placement of placements) {
    const finish = BigInt(placement.finish);
    if (finish > makespan) makespan = finish;
    priority += BigInt(placement.slice.priorityWeight) * finish;
    const start = BigInt(placement.start);
    const baseline = BigInt(request.baselineOffsets[placement.slice.key]);
    movement += start >= baseline ? start - baseline : baseline - start;
  }
  // An empty slice set has no finish to take a maximum over, and 0 is the
  // honest reading: nothing is scheduled, so the schedule ends at day zero.
  return { makespan, priority, movement };
};

const groupBy = <T>(items: readonly T[], keysOf: (item: T) => readonly string[]) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    for (const key of keysOf(item)) {
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [item]);
      else group.push(item);
    }
  }
  return groups;
};

/**
 * Re-validate a solver response against the request that produced it.
 *
 * Order is deliberate: the request is proved usable, then the offset map is
 * proved to be about the right slices and inside the variable domain, and only
 * then are the constraints checked. A constraint checked against a key set that
 * does not match the request is a check that reads whichever slices both
 * happened to name.
 */
export const revalidateSolverResult = (
  request: SolverRequest,
  response: SolverResponse,
): RevalidatedSolverResult => {
  const slices = new Map<string, SolverSlice>();
  for (const slice of request.slices) {
    if (slices.has(slice.key)) {
      return refuse('malformed-request', `duplicate slice key ${JSON.stringify(slice.key)}`);
    }
    slices.set(slice.key, slice);
    // The objective arithmetic below converts these three to `bigint`, and
    // `BigInt(1.5)` throws. A re-validator that crashes on a malformed request
    // reports nothing at all, so the domain is proved before it is used.
    for (const field of ['durationUnits', 'priorityWeight', 'notBeforeUnits'] as const) {
      if (!isNonNegativeSafeInteger(slice[field])) {
        return refuse(
          'malformed-request',
          `slice ${JSON.stringify(slice.key)} has ${field} ${JSON.stringify(slice[field])}`,
        );
      }
    }
    // MOVEMENT is measured against the baseline, so a slice with no baseline is
    // a term that cannot be computed rather than a term that is zero. ONE check
    // covers both absent and out-of-domain, and it is one check on purpose: an
    // `Object.hasOwn` guard in front of it read as the careful spelling and was
    // measured dead — removing it changed no test, because
    // `Number.isSafeInteger(undefined)` is already false. `SolverOffsetMap` is
    // a `Record<string, number>`, so the compiler believes this lookup always
    // lands; the map is a wire value and its key set is exactly what is in
    // question here, which is why the domain is asked of the value itself.
    const baseline = request.baselineOffsets[slice.key];
    if (!isNonNegativeSafeInteger(baseline)) {
      return refuse(
        'malformed-request',
        `slice ${JSON.stringify(slice.key)} has baseline offset ${JSON.stringify(baseline)}`,
      );
    }
    for (const poolId of slice.poolIds) {
      if (!Object.hasOwn(request.pools, poolId)) {
        return refuse(
          'malformed-request',
          `slice ${JSON.stringify(slice.key)} draws on pool ${JSON.stringify(poolId)}, which has no capacity`,
        );
      }
    }
  }
  for (const edge of request.edges) {
    for (const end of [edge.predecessorKey, edge.successorKey]) {
      if (!slices.has(end)) {
        return refuse('malformed-request', `edge names unknown slice ${JSON.stringify(end)}`);
      }
    }
  }

  // A non-publishing response carries no schedule, so there is nothing to
  // re-validate and `published: false` says so out loud.
  if (response.status !== 'feasible') return { ok: true, published: false };

  const offsets = response.offsets;
  for (const key of Object.keys(offsets)) {
    if (!slices.has(key)) {
      return refuse('offset-key-mismatch', `offsets carry unknown slice ${JSON.stringify(key)}`);
    }
  }
  for (const key of slices.keys()) {
    if (!Object.hasOwn(offsets, key)) {
      return refuse('offset-key-mismatch', `offsets omit slice ${JSON.stringify(key)}`);
    }
  }

  // 2.9. `horizonUnits` is the CP-SAT variable domain for the offset itself, so
  // that is what is bounded here; a finish past the horizon is 2.4's makespan
  // arithmetic, not this rule. `parseSolverResponse` already refused a negative
  // or fractional offset, and this repeats it on purpose — that call proves the
  // bytes and this one proves the domain, and the re-validator must not depend
  // on which parser its caller used.
  const placements: Placement[] = [];
  const placementByKey = new Map<string, Placement>();
  for (const [key, slice] of slices) {
    const start = offsets[key];
    if (!Number.isSafeInteger(start) || start < 0 || start > request.horizonUnits) {
      return refuse(
        'offset-domain',
        `offset ${JSON.stringify(key)} is ${JSON.stringify(start)}, outside 0..${String(request.horizonUnits)}`,
      );
    }
    const placement: Placement = { slice, start, finish: start + slice.durationUnits };
    placements.push(placement);
    placementByKey.set(key, placement);
  }

  for (const placement of placements) {
    if (placement.start < placement.slice.notBeforeUnits) {
      return refuse(
        'floor-violated',
        `slice ${JSON.stringify(placement.slice.key)} starts at ${String(placement.start)}, before its floor ${String(placement.slice.notBeforeUnits)}`,
      );
    }
  }

  for (const edge of request.edges) {
    const predecessor = placementByKey.get(edge.predecessorKey);
    const successor = placementByKey.get(edge.successorKey);
    // Both endpoints were proved present above. The guard is kept because the
    // lookup and the proof are different statements, and a re-validator that
    // silently skips an edge it cannot resolve is the exact hole 2.7 aims at.
    if (predecessor === undefined || successor === undefined) {
      return refuse('malformed-request', `edge names unknown slice`);
    }
    if (predecessor.finish > successor.start) {
      return refuse(
        'edge-violated',
        `${JSON.stringify(edge.predecessorKey)} finishes at ${String(predecessor.finish)}, after ${JSON.stringify(edge.successorKey)} starts at ${String(successor.start)}`,
      );
    }
  }

  // The whole width is spent in EACH pool a slice names, so a slice in two
  // pools is counted at full width in both. Checking only the first would let a
  // solver hide an overload behind a second membership.
  const byPool = groupBy(placements, (placement) => placement.slice.poolIds);
  for (const [poolId, members] of byPool) {
    const capacity = request.pools[poolId];
    const overload = overloadAt(members, (placement) => placement.slice.width, capacity);
    if (overload !== null) {
      return refuse(
        'pool-overcapacity',
        `pool ${JSON.stringify(poolId)} carries ${String(overload.load)} of ${String(capacity)} at unit ${String(overload.at)}`,
      );
    }
  }

  // An assignee is a person and not a quantity: two slices naming one person
  // overlap or they do not, whatever their widths.
  const byPerson = groupBy(placements, (placement) =>
    placement.slice.personId === null ? [] : [placement.slice.personId],
  );
  for (const [personId, members] of byPerson) {
    const overload = overloadAt(members, () => 1, 1);
    if (overload !== null) {
      return refuse(
        'assignee-double-booked',
        `${JSON.stringify(personId)} is on ${String(overload.load)} slices at unit ${String(overload.at)}`,
      );
    }
  }

  // The objective arithmetic runs last, on a schedule already proved placeable:
  // a term recomputed over offsets that do not match the request's slices would
  // be arithmetic about a different plan.
  const recomputed = recomputeObjectives(request, placements);
  for (const term of SOLVER_OBJECTIVE_TERMS) {
    const entry = response.objectiveValues[term];

    // Repeated from the parser on purpose, and for the same reason the offset
    // domain is: this function must hold whether or not its caller used
    // `parseSolverResponse`.
    for (const member of ['value', 'stageValue', 'bound'] as const) {
      const at = entry[member];
      if (at !== null && !isNonNegativeSafeInteger(at)) {
        return refuse(
          'objective-domain',
          `${term}.${member} is ${JSON.stringify(at)}, not a non-negative safe integer`,
        );
      }
    }

    // `value` is a statement about the published schedule and `stageValue` is a
    // statement about one stage's incumbent, so a later stage improving the
    // term below its own incumbent is legal and expected. What is not legal is
    // publishing a value WORSE than an incumbent every later stage was
    // constrained at.
    if (entry.stageValue !== null && entry.value > entry.stageValue) {
      return refuse(
        'objective-regression',
        `${term}.value ${String(entry.value)} is worse than its stage incumbent ${String(entry.stageValue)}`,
      );
    }

    const computed = recomputed[term];
    if (computed > MAX_SAFE) {
      return refuse(
        'objective-overflow',
        `${term} recomputes to ${computed.toString()}, past Number.MAX_SAFE_INTEGER`,
      );
    }
    // `value` is the ONLY recomputed field. `stageValue`, `bound` and `status`
    // are statements about a stage rather than about this schedule, and there
    // is nothing in the published offsets to check them against.
    if (computed !== BigInt(entry.value)) {
      return refuse(
        'objective-mismatch',
        `${term}.value is ${String(entry.value)}, but the offsets give ${computed.toString()}`,
      );
    }
  }

  return { ok: true, published: true };
};

/**
 * 2.4 — re-validation, DEADLINE half, and it is a second entry point rather
 * than another block inside {@link revalidateSolverResult}. That is a finding
 * about the seam, not a convenience.
 *
 * The clause is stated on the MATERIALISED schedule in the real fractional
 * domain — `lastWorkdayOf(start, finish) <= effectiveDeadlineOffset` for every
 * slice — and deliberately not in quantised units, because checking it in units
 * would re-implement the inclusive-ceiling rounding a second time and could
 * disagree with the End date the column prints. Materialising needs
 * `materialiseOptimized`, and that needs `rows`, `edges`, `slices`,
 * `notBefore`, `poolSizes` and `reach`: the DOMAIN plan. `revalidateSolverResult`
 * is signed `(request, response)` and has only the wire request, whose slices
 * are already quantised. So the check cannot live inside it without either
 * widening that signature or re-deriving the domain plan from the wire, and
 * re-deriving it would be a second copy of the canonicaliser.
 *
 * The composition is therefore the caller's, in this order: re-validate the
 * wire pair, materialise, then call this. Everything the wire alone can refuse
 * has already been refused by the time a `Schedule` exists.
 *
 * `deadlineUnits` is an EXCLUSIVE bound on the finish, `(D + 1) × quantum`
 * (`deadlineUnitsOf`), so the due day itself is `deadlineUnits / quantum - 1`.
 * Converting the other way would require the work finished by the START of its
 * own due day and lose a whole workday on every deadline in the plan.
 *
 * A slice the schedule has no placement for is `malformed-request`, not a
 * deadline violation: the key sets are equal by construction once
 * `materialiseOptimized` has returned, so a gap is our bug and blaming the
 * solver would send the repair to the wrong side of the seam.
 *
 * **The verdict is {@link isOnTime}'s and is not re-derived here.** This once
 * computed `lastWorkdayOf` and compared it to `dueDay` itself, which made it
 * the third copy of a predicate `libs/domain/src/on-time.ts` exists to hold
 * once — and the copy the CP-SAT model carried disagreed with it on a
 * zero-duration milestone, so a plan the solver called feasible was refused
 * here as `invalid-output` instead of being reported as `plan-infeasible`.
 * `lastWorkdayOf` still appears below, but only to name the day in the refusal
 * message; nothing decides anything from it.
 */
export const revalidateOptimizedDeadlines = (
  request: SolverRequest,
  placed: {
    readonly slices: ReadonlyMap<string, { earliestStart: number; earliestFinish: number }>;
  },
): RevalidatedSolverResult => {
  for (const slice of request.slices) {
    if (slice.deadlineUnits === null) continue;
    if (!isNonNegativeSafeInteger(slice.deadlineUnits)) {
      return refuse(
        'malformed-request',
        `slice ${JSON.stringify(slice.key)} has deadlineUnits ${JSON.stringify(slice.deadlineUnits)}`,
      );
    }
    const timing = placed.slices.get(slice.key);
    if (timing === undefined) {
      return refuse(
        'malformed-request',
        `the materialised schedule has no slice ${JSON.stringify(slice.key)}`,
      );
    }
    const dueDay = slice.deadlineUnits / SOLVER_QUANTUM - 1;
    if (!isOnTime(timing.earliestStart, timing.earliestFinish, dueDay)) {
      const lastDay = lastWorkdayOf(timing.earliestStart, timing.earliestFinish);
      return refuse(
        'deadline-violated',
        `slice ${JSON.stringify(slice.key)} last works on day ${String(lastDay)}, past its deadline day ${String(dueDay)}`,
      );
    }
  }
  return { ok: true, published: true };
};
