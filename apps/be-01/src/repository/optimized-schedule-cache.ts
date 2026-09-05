import {
  decodeOptimizedResult,
  encodeOptimizedResult,
  type OptimizedResult,
} from '@wbs/contracts/solver/optimized-result';
import {
  decodePlanInfeasible,
  encodePlanInfeasible,
  type PlanInfeasibleResult,
} from '@wbs/contracts/solver/plan-infeasible';
import { type Schedule } from '@wbs/domain';
import { type ScheduleInput, scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { and, desc, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { readGeneration } from './optimization-generation';
import { toOptimizedScheduleCacheRow, toSolverSlotRow } from './optimizer-rows';
import {
  optimizedScheduleCache,
  project,
  SOLVER_OBJECTIVES,
  type SolverFailureReason,
  type SolverObjectiveName,
  solverSlot,
} from './schema';

/** The handle a caller's own transaction hands to the helpers below. */
type Transaction = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];

/**
 * A database handle or an open transaction on one.
 *
 * Every predicate below takes this rather than a bare {@link SQLiteBunDatabase}
 * because 4.1's write composes all four of them *inside one transaction*. A
 * predicate that could only be called on the outer handle would read a state
 * the insert never sees, which is the entire failure the predicates exist to
 * prevent.
 */
type Reader = SQLiteBunDatabase | Transaction;

/**
 * Tasks.md 4.1, both halves: the stored outcome of both objectives for one full
 * cache key, and the guarded write that puts one there.
 *
 * 4.1b's retention bound is the one part still absent. It is a rule about
 * which rows *other than this one* survive a commit rather than about the
 * commit itself, and it is separately numbered.
 */

/**
 * Everything but the objective, which is what makes this a *pair* read.
 *
 * `budgetMs` is a key column and not a detail (schema.ts): raising the budget
 * changes neither the hash nor the generation, so a read that dropped it would
 * serve a 60 s answer to a release configured for 120 s.
 */
export interface OptimizedCacheKey {
  readonly projectId: string;
  readonly inputHash: string;
  readonly contractVersion: string;
  readonly budgetMs: number;
}

/**
 * What one stored row means to a reader, after the generation predicate and the
 * payload decode have both had their say.
 *
 * These are row states, not the plan read's `VariantState`: `pending`,
 * `retrying` and `idle` are decided by a live slot or queue entry, which this
 * layer does not read. Every member below maps into that union by adding that
 * one fact, and none of them is derivable from it — which is why the two are
 * separate types rather than one shared enum.
 */
export type CachedOutcome =
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'ok';
      readonly result: OptimizedResult;
      readonly generation: number;
      readonly createdAt: number;
    }
  | {
      readonly kind: 'failed';
      readonly reason: SolverFailureReason;
      readonly generation: number;
      readonly createdAt: number;
    }
  | {
      readonly kind: 'plan-infeasible';
      readonly certificate: PlanInfeasibleResult;
      readonly generation: number;
      readonly createdAt: number;
    }
  | {
      readonly kind: 'corrupt';
      readonly reason: string;
      readonly generation: number;
      readonly createdAt: number;
    };

/** Both objectives' outcomes for one key, which is what a plan read asks for. */
export type OptimizedPair = Readonly<Record<SolverObjectiveName, CachedOutcome>>;

/** No row at all, and the value every objective starts at. */
const MISS: CachedOutcome = { kind: 'miss' };

/**
 * A decode failure as the reader reports it, never as a thrown error.
 *
 * The row is **left in place** (tasks.md 4.8, Sol r7 Important 13). Deleting it
 * and reporting a miss would turn corruption into a read-triggered solve — the
 * timer retry Dany rejected, arriving through the cache instead of the clock —
 * and would destroy the only evidence of the defect at the moment it was found.
 * `corrupt` never satisfies a read and never auto-spawns, exactly like `failed`;
 * an explicit Retry overwrites it through the ordinary admission path.
 */
function corrupt(reason: unknown, generation: number, createdAt: number): CachedOutcome {
  return {
    kind: 'corrupt',
    reason: reason instanceof Error ? reason.message : String(reason),
    generation,
    createdAt,
  };
}

/**
 * `JSON.parse` as an outcome rather than as a throw.
 *
 * A truncated payload fails here and a well-formed one that breaks the codec
 * fails a layer down; both are the same state to a reader, so both funnel into
 * {@link corrupt} and neither escapes this module.
 */
function parsePayload(
  payload: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * One row's payload, dispatched on the row's own `status`.
 *
 * **`plan-infeasible` is decoded only as far as its envelope, and that is a
 * stated hole rather than an oversight.** Assumption A1 (schema.ts) says the
 * row holds a versioned `PlanInfeasibleResult` discriminated by `status`, and
 * that a payload which fails to decode reads as `corrupt` on exactly the rule
 * an `ok` row obeys. The certificate type itself belongs to the failure path
 * (slice 7) and does not exist yet, so what is enforced here is the half A1
 * fixes and this layer can honestly check: valid JSON carrying a numeric
 * `dtoVersion`, which is the read fence both existing codecs already use.
 * The certificate's *contents* are unvalidated until that codec lands.
 * **What would falsify the split:** a `plan-infeasible` payload whose offending
 * item list is malformed reads `plan-infeasible` today and must read `corrupt`
 * once `decodePlanInfeasible` exists — so the case below asserts the envelope
 * rule only, and tightening it is a change to this function, not to its caller.
 */
function decodePayload(
  status: 'ok' | 'plan-infeasible',
  payload: string,
  generation: number,
  createdAt: number,
): CachedOutcome {
  const parsed = parsePayload(payload);
  if (!parsed.ok) return corrupt(parsed.error, generation, createdAt);

  if (status === 'ok') {
    try {
      return { kind: 'ok', result: decodeOptimizedResult(parsed.value), generation, createdAt };
    } catch (error) {
      return corrupt(error, generation, createdAt);
    }
  }

  try {
    return {
      kind: 'plan-infeasible',
      certificate: decodePlanInfeasible(parsed.value),
      generation,
      createdAt,
    };
  } catch (error) {
    return corrupt(error, generation, createdAt);
  }
}

/**
 * One row read into its outcome.
 *
 * **A row that violates the payload `CHECK` reads `corrupt`, not a throw**, and
 * the divergence from 3.8's boundary rule is deliberate. `toOptimizedScheduleCacheRow`
 * throws on an *unknown enum value*, because there is no honest way to answer a
 * question about a token the release has never heard of. A missing payload is a
 * different defect: the value is absent rather than unrecognised, the constraint
 * that forbids it has existed since the table did, and a throw here would wedge
 * the plan read for **both** objectives on one bad row — precisely the outcome
 * 4.8 introduced `corrupt` to prevent. The row is still left in place and still
 * recoverable by Retry. **Falsified if** a `failed` row with no reason ever
 * needs to be distinguished from a decode failure by a caller; today nothing
 * renders them differently, both showing `Optimization unavailable · Retry`.
 */
function outcomeOf(row: {
  status: 'ok' | 'failed' | 'plan-infeasible';
  resultJson: string | null;
  failureReason: SolverFailureReason | null;
  generation: number;
  createdAt: number;
}): CachedOutcome {
  const { status, resultJson, failureReason, generation, createdAt } = row;

  if (status === 'failed') {
    return failureReason === null
      ? corrupt(
          new Error('stored row: a failed row carries no failure_reason'),
          generation,
          createdAt,
        )
      : { kind: 'failed', reason: failureReason, generation, createdAt };
  }

  return resultJson === null
    ? corrupt(
        new Error(`stored row: a ${status} row carries no result_json`),
        generation,
        createdAt,
      )
    : decodePayload(status, resultJson, generation, createdAt);
}

/**
 * Reads both objectives' stored outcomes for one full key.
 *
 * **The generation predicate is part of the read, not of the eviction.**
 * Allocation deletes the superseded rows, but a read that ran between the
 * allocation and its delete would otherwise serve an answer computed against a
 * plan that no longer exists — the ABA the 4.6 fence is about. So a row whose
 * `generation` is not the current one for `(projectId, contractVersion)` is a
 * miss, and a key with no generation row at all serves nothing: nothing can
 * have been admitted before the first allocation, so any row present is a
 * leftover.
 *
 * The generation row's own `inputHash` is deliberately **not** a predicate. It
 * records which hash the last allocation was for, and requiring it to match
 * would make a legitimate read of a key whose reallocation has not happened yet
 * miss on the coordinator's schedule rather than on the plan's. The key already
 * carries `inputHash` as a primary-key column, which is what fences a stale
 * plan; this predicate fences a stale *generation*, and they are different
 * facts.
 */
export function readOptimizedPair(db: Reader, key: OptimizedCacheKey): OptimizedPair {
  const pair: Record<SolverObjectiveName, CachedOutcome> = { pri: MISS, time: MISS };

  const current = readGeneration(db, key.projectId, key.contractVersion);
  if (current === null) return pair;

  const rows = db
    .select()
    .from(optimizedScheduleCache)
    .where(
      and(
        eq(optimizedScheduleCache.projectId, key.projectId),
        eq(optimizedScheduleCache.inputHash, key.inputHash),
        eq(optimizedScheduleCache.contractVersion, key.contractVersion),
        eq(optimizedScheduleCache.budgetMs, key.budgetMs),
        eq(optimizedScheduleCache.generation, current.generation),
      ),
    )
    .all();

  for (const stored of rows) {
    // Through the 3.8 boundary, so an enum no `CHECK` was in force for throws
    // here rather than being cast into a typed field.
    const row = toOptimizedScheduleCacheRow(stored);
    pair[row.objective] = outcomeOf(row);
  }

  return pair;
}

/**
 * Everything the seam below hands a spawner, and nothing it has to look up.
 *
 * The `key` is the one the read ran against rather than a rebuilt one, because
 * `budgetMs` and `contractVersion` are key columns: a spawner given the project
 * and the objective alone would have to guess which of the two live budgets a
 * blue/green pair asked for, and 4.1b's whole point is that those are two rows.
 */
export interface SpawnRequest {
  readonly key: OptimizedCacheKey;
  readonly objective: SolverObjectiveName;
}

/**
 * tasks.md 4.2's injected spawner, as this layer sees it.
 *
 * It returns nothing on purpose. Admission, the slot ceilings and the queue are
 * 6.x's, and a repository read that could observe whether a solve *started*
 * would be a read that waits on one — which is the timer-shaped coupling the
 * whole cache exists to avoid. What is assertable here is the call, which is
 * exactly what 4.2 asks to be asserted on ("on the spawner, not on elapsed
 * time").
 */
export type Spawner = (request: SpawnRequest) => void;

/**
 * Which objectives an *automatic* read asks a solver for.
 *
 * Pure, exported and separately tested, because it is the whole spawn policy
 * and every other arm of slice 4 is a claim about it: 4.4 is `failed` staying
 * out of this set, 4.8 is `corrupt` staying out of it, and 4.5/4.7 are watched
 * reds that put one of them back.
 *
 * **Only `miss` spawns.** Every other outcome is an answer this key already
 * has — `ok` is the answer, `failed` and `plan-infeasible` are answers about
 * the solve and the plan, and `corrupt` is a defect whose row is deliberately
 * left in place (4.8). Auto-spawning on any of the four would make every read
 * of a settled key a re-solve, which is the timer retry Dany rejected arriving
 * through the cache instead of the clock.
 *
 * It iterates {@link SOLVER_OBJECTIVES} rather than naming `pri` and `time`, so
 * the order is the stored vocabulary's and a third objective would be covered
 * by construction rather than by remembering this line.
 */
export function objectivesToAutoSpawn(pair: OptimizedPair): readonly SolverObjectiveName[] {
  return SOLVER_OBJECTIVES.filter((objective) => pair[objective].kind === 'miss');
}

/**
 * {@link readOptimizedPair} with 4.2's spawner seam attached: read the pair,
 * then ask for exactly the objectives that have no answer.
 *
 * The pair is returned whether or not anything was spawned, because a caller
 * needs both halves — a full hit renders immediately, and a miss renders
 * `pending` beside the request that was just made. Splitting them would put the
 * decision in the caller, which is the arrangement 4.2 replaces: a reader that
 * decides for itself is a reader that can forget, and nothing about "zero calls
 * on a hit" would then be provable in one place.
 *
 * The spawner is called **once per objective**, never once per read, so a key
 * whose `pri` committed and whose `time` did not asks for one solve rather than
 * two or none.
 */
export function readOptimizedPairAndSpawn(
  db: Reader,
  key: OptimizedCacheKey,
  spawn: Spawner,
): OptimizedPair {
  const pair = readOptimizedPair(db, key);
  for (const objective of objectivesToAutoSpawn(pair)) spawn({ key, objective });
  return pair;
}

/**
 * Which objectives an **explicit Retry** asks a solver for (tasks.md 4.4).
 *
 * Everything that is not `ok`, which is the mirror of
 * {@link objectivesToAutoSpawn} spawning on `miss` alone. `ok` is the only
 * state with an answer to serve, so it is the only one a Retry has no reason to
 * touch; `failed`, `corrupt` and `plan-infeasible` are all states a person
 * looking at "Optimization unavailable · Retry" is asking about, and a Retry
 * that refused one of them would be a button that does nothing on the row the
 * user is looking at. `plan-infeasible` will very likely answer the same way
 * again — that is the user's minute to spend, not this layer's to refuse.
 */
export function objectivesToRetry(pair: OptimizedPair): readonly SolverObjectiveName[] {
  return SOLVER_OBJECTIVES.filter((objective) => pair[objective].kind !== 'ok');
}

/**
 * The Retry arm of the same seam: read the pair, then ask for everything that
 * has no answer.
 *
 * **A separate entry point rather than a flag on the one above**, so that "an
 * automatic read can never spawn on a `failed` row" is a property of which
 * function was called rather than of a parameter's default. 4.5's whole worry
 * is a `failed` row silently rejoining the auto-spawn set; a boolean with a
 * default is exactly the shape that lets it, and a caller that meant to read
 * would have had to pass something to avoid re-solving.
 */
export function retryOptimizedPair(
  db: Reader,
  key: OptimizedCacheKey,
  spawn: Spawner,
): OptimizedPair {
  const pair = readOptimizedPair(db, key);
  for (const objective of objectivesToRetry(pair)) spawn({ key, objective });
  return pair;
}

/**
 * Who a writer claims to be, and the whole of what {@link writerStillHolds}
 * checks it against.
 *
 * `ownerId` and `attemptToken` are two facts and not one: the slot's primary
 * key names the *seat*, `ownerId` names the coordinator sitting in it, and
 * `attemptToken` names the attempt. A reclaimed owner that re-reserved the same
 * seat has the same `ownerId` and a freshly minted token, which is precisely the
 * case the token exists to fence.
 */
export interface SlotClaim {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  readonly ownerId: string;
  readonly attemptToken: string;
}

/**
 * Whether the writer still holds the slot it is about to commit against
 * (tasks.md 4.1's first condition).
 *
 * **This is the check that is not implied by the row existing.** A superseded
 * run's slot row is deleted or re-reserved by whoever reclaimed it, so
 * "my seat has a row in it" is true for the run that replaced me. Only the
 * token distinguishes the two, and it is the fence that keeps a late write from
 * a reclaimed child out of the cache: without it, six real children ran while
 * SQLite counted two, and a stale outcome could overwrite a live one.
 *
 * It reads through {@link toSolverSlotRow}, so a `lifecycle` or `objective` no
 * `CHECK` was in force for throws rather than being cast (tasks.md 3.8) — a
 * corrupted slot row must not silently authorize a write.
 *
 * **`lifecycle` is deliberately not a condition.** A `starting` slot is a real
 * reservation whose process has not been forked yet, and both phases are the
 * writer's own seat; requiring `running` would refuse a legitimate write from a
 * child that committed before its lifecycle row was advanced. **Falsified if**
 * a `starting` row is ever reachable at commit time only through a defect, at
 * which point the lifecycle becomes a fourth condition rather than a comment.
 *
 * The remaining conditions of 4.1's write live in
 * {@link admissionStillCurrent} (the generation and the cancel epoch) and
 * {@link optimizationStillEnabled} (the project switch). Each is proved on its
 * own and all three are composed, inside one transaction, by
 * {@link storeOptimizedOutcome}.
 */
export function writerStillHolds(db: Reader, claim: SlotClaim): boolean {
  const stored = db
    .select()
    .from(solverSlot)
    .where(
      and(
        eq(solverSlot.projectId, claim.projectId),
        eq(solverSlot.contractVersion, claim.contractVersion),
        eq(solverSlot.generation, claim.generation),
        eq(solverSlot.objective, claim.objective),
        eq(solverSlot.budgetMs, claim.budgetMs),
      ),
    )
    .get();
  if (stored === undefined) return false;

  const row = toSolverSlotRow(stored);
  return row.ownerId === claim.ownerId && row.attemptToken === claim.attemptToken;
}

/**
 * What an admitted attempt recorded about the generation it was admitted under.
 *
 * Two numbers because they answer two different questions. `generation` moves
 * when the plan's input hash changes; `cancelEpoch` moves when somebody cancels.
 * A write may be superseded by either and by neither the same way, so a single
 * "still current" counter would collapse a cancelled run and a re-planned one
 * into one indistinguishable state.
 */
export interface AdmissionClaim {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly admittedCancelEpoch: number;
}

/**
 * Whether the generation row still says what it said when this attempt was
 * admitted (tasks.md 4.1's second and third conditions).
 *
 * Read as one row rather than as two lookups on purpose: both numbers live in
 * `optimization_generation` keyed `(projectId, contractVersion)`, and reading
 * them separately would let a concurrent allocation land between the two and
 * produce a verdict that was never true of any single state of the row.
 *
 * A **missing** generation row is not current. Nothing can have been admitted
 * before the first allocation, so a claim against a key with no row is a claim
 * by a run whose own allocation has since been deleted — the project was
 * dropped, or its rows were retired.
 *
 * It reads through {@link readGeneration}, so an `admission_state` no `CHECK`
 * was in force for throws rather than authorizing a write (tasks.md 3.8).
 *
 * **`admissionState` is deliberately not a condition, and this is the one place
 * that could be argued either way.** `draining` means the generation admits no
 * new* work; a run already admitted and still holding its slot is finishing
 * work that was admitted while the generation was open, and refusing its commit
 * would throw away a completed solve and leave the key with no outcome at all.
 * **Falsified if** draining ever needs to mean "and discard what is in flight",
 * at which point it is a condition here and the drain has to say so.
 *
 * The fourth condition of 4.1's write — `optimization_enabled` still 1 — is
 * {@link optimizationStillEnabled}, kept separate because it is a fact about
 * the *project* rather than about this attempt's generation.
 * {@link storeOptimizedOutcome} composes all three inside one transaction.
 */
export function admissionStillCurrent(db: Reader, claim: AdmissionClaim): boolean {
  const current = readGeneration(db, claim.projectId, claim.contractVersion);
  if (current === null) return false;
  return (
    current.generation === claim.generation && current.cancelEpoch === claim.admittedCancelEpoch
  );
}

/**
 * Whether this project is still allowed to spend solver time at all — 4.1's
 * fourth and last write condition.
 *
 * **This is the condition that blocked the write half of 4.1 for three runs**,
 * and it is not interchangeable with the other three. The slot token fences a
 * superseded attempt and the generation and cancel epoch fence a superseded
 * input; this one fences a project whose owner switched the optimizer off
 * while a solve that was legitimately admitted was still running. Nothing else
 * in the pipeline observes that, because admission happened before the switch
 * was thrown — so without it a project can be switched off and still acquire a
 * fresh optimized plan seconds later, which is the one behaviour the switch
 * exists to forbid.
 *
 * A **missing** project row is not enabled. `optimized_schedule_cache` cascades
 * on `project.id`, so a claim against a project that is gone is a claim by a
 * run whose whole key has already been deleted; returning `true` there would
 * re-create a row for a deleted project between the cascade and the commit.
 *
 * The column is `integer … NOT NULL DEFAULT 0` with
 * `CHECK (optimization_enabled IN (0, 1))` in the database
 * (`20260904140000_add_project_settings`), so there is no third value for the
 * boolean mapping to be lossy about and this needs no 3.8 boundary of its own.
 * The default is what makes the predicate safe on a release that has never
 * heard of the switch: every existing project reads `false` until somebody
 * turns it on.
 */
export function optimizationStillEnabled(db: Reader, projectId: string): boolean {
  const row = db
    .select({ enabled: project.optimizationEnabled })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  if (row === undefined) return false;
  return row.enabled;
}

/**
 * What a finished attempt has to store: a solved result, or the reason it did
 * not solve.
 *
 * `plan-infeasible` is a third stored `status` and is deliberately **not** a
 * member. Its payload is a certificate whose codec belongs to slice 7 and does
 * not exist, so admitting it here would mean writing a row this release cannot
 * read back — `readOptimizedPair` would serve it as `corrupt`. It joins this
 * union in the same change that lands `decodePlanInfeasible`.
 */
export type OutcomeToStore =
  | { readonly kind: 'ok'; readonly result: OptimizedResult }
  | { readonly kind: 'failed'; readonly reason: SolverFailureReason }
  | { readonly kind: 'plan-infeasible'; readonly certificate: PlanInfeasibleResult };

/**
 * One finished attempt's commit, carrying every fact the four predicates and
 * the row itself need.
 *
 * `claim` is the {@link SlotClaim} the attempt has been holding all along
 * rather than a fresh set of key fields, because the seat and the row must be
 * the *same* project, contract version, generation, objective and budget. Two
 * parallel copies of those five columns would let a caller commit against a
 * seat it does not hold by mistyping one of them, and every predicate below
 * would still pass.
 */
export interface OutcomeWrite {
  readonly claim: SlotClaim;
  readonly inputHash: string;
  readonly admittedCancelEpoch: number;
  readonly outcome: OutcomeToStore;
  readonly now: number;
}

/**
 * What happened to a commit, as three distinguishable facts rather than a
 * boolean.
 *
 * `superseded` and `already-recorded` are not the same event and a caller has
 * to tell them apart: the first says this attempt lost its right to write and
 * its work is discarded, the second says this key already carries an outcome —
 * which, after the retry path lands, is a completed sibling rather than a
 * defect. A boolean would collapse "I was overtaken" into "my write was a
 * no-op" and lose the only signal a coordinator has that its own fencing is
 * working.
 */
export type OutcomeWriteResult = 'stored' | 'superseded' | 'already-recorded';

/**
 * The write half of tasks.md 4.1: a conditional insert of one attempt's
 * outcome, guarded by all four conditions inside one transaction.
 *
 * **Not an upsert, and that is the whole design.** A superseded run must not be
 * able to store, evict, overwrite an `ok` with a `failed`, or emit a second
 * outcome record for one key. `onConflictDoNothing` is what makes the last of
 * those true: the primary key is
 * `(projectId, inputHash, objective, contractVersion, budgetMs)` and does
 * **not** include `generation`, so two generations of the same key collide by
 * construction. The legitimate replacement path is not an overwrite either —
 * `allocateGeneration` deletes that contract version's older-generation cache
 * rows in its own transaction, so a newer generation finds the key empty.
 *
 * **All four predicates are re-read inside the transaction, not passed in.**
 * The caller read them minutes ago when it was admitted; what matters is
 * whether they hold at the instant of the insert, and SQLite's write
 * transaction is what makes the read and the insert one observation. That is
 * also why {@link readOptimizedPair}, {@link writerStillHolds},
 * {@link admissionStillCurrent} and {@link optimizationStillEnabled} all take a
 * {@link Reader}: they are called on `tx` here and on the handle elsewhere.
 *
 * **The order is cheapest-fence-first and is not arbitrary.** The slot token is
 * the condition that fails most often (every reclaimed child), the generation
 * and cancel epoch next, the project switch last because it changes rarely.
 * All three are single-row primary-key lookups, so the ordering buys clarity
 * rather than time — but a reader tracing a `superseded` return reaches the
 * likely cause first.
 *
 * 4.1b's retention bound is deliberately not here: it is a rule about which
 * rows *other than this one* survive a commit, it is separately numbered, and
 * folding it in would make this function's contract two claims instead of one.
 */
export function storeOptimizedOutcome(
  db: SQLiteBunDatabase,
  write: OutcomeWrite,
): OutcomeWriteResult {
  const { claim, outcome } = write;
  return db.transaction((tx) => {
    if (!writerStillHolds(tx, claim)) return 'superseded';
    if (
      !admissionStillCurrent(tx, {
        projectId: claim.projectId,
        contractVersion: claim.contractVersion,
        generation: claim.generation,
        admittedCancelEpoch: write.admittedCancelEpoch,
      })
    ) {
      return 'superseded';
    }
    if (!optimizationStillEnabled(tx, claim.projectId)) return 'superseded';

    const inserted = tx
      .insert(optimizedScheduleCache)
      .values({
        projectId: claim.projectId,
        inputHash: write.inputHash,
        objective: claim.objective,
        contractVersion: claim.contractVersion,
        budgetMs: claim.budgetMs,
        generation: claim.generation,
        status: outcome.kind,
        resultJson:
          outcome.kind === 'ok'
            ? JSON.stringify(encodeOptimizedResult(outcome.result))
            : outcome.kind === 'plan-infeasible'
              ? JSON.stringify(encodePlanInfeasible(outcome.certificate))
              : null,
        failureReason: outcome.kind === 'failed' ? outcome.reason : null,
        createdAt: write.now,
      })
      .onConflictDoNothing()
      .returning({ objective: optimizedScheduleCache.objective })
      .all();

    if (inserted.length !== 1) return 'already-recorded';

    enforceLiveBudgetBound(tx, {
      projectId: claim.projectId,
      objective: claim.objective,
      contractVersion: claim.contractVersion,
      inputHash: write.inputHash,
    });
    return 'stored';
  });
}

/**
 * How many budgets one project keeps per objective per live contract version
 * (tasks.md 4.1b, rule 2).
 *
 * **A bound, not an exclusion, and the difference is a livelock.** The rule this
 * replaced deleted every row whose `(inputHash, budgetMs)` differed from the one
 * committing. A config change is not a code change, so blue and green can read
 * `60000` and `120000` under one `contractVersion` — and each release then
 * deleted the other's row on every store, alternating solves for ever on a plan
 * nobody edited while holding the concurrency ceilings busy. The per-contract
 * generation table cannot fix that, because both releases share the contract
 * version; only a bound can, because under a bound both rows survive.
 *
 * Two, so the pair of budgets a blue/green swap has in flight both fit. With
 * both objectives that is at most four outcome rows per project per live
 * contract version — never "two rows total".
 */
const MAX_LIVE_BUDGETS = 2;

/** The tuple 4.1b's bound counts within: everything but `budgetMs`. */
interface LiveBudgetKey {
  readonly projectId: string;
  readonly objective: SolverObjectiveName;
  readonly contractVersion: string;
  readonly inputHash: string;
}

/**
 * Keeps the {@link MAX_LIVE_BUDGETS} most recently written budgets for one
 * {@link LiveBudgetKey} and deletes the rest.
 *
 * Ordered by `createdAt` and then by `budgetMs`, both descending. The second
 * key is not decoration: two rows written in the same millisecond are ordinary
 * in a test and possible under a coarse clock, and without a tie-break the
 * survivor would be whichever order SQLite happened to return — a bound that
 * deletes a different row on two runs of the same input. Descending `budgetMs`
 * on the tie keeps the larger budget, which is the more expensive answer to
 * recompute.
 *
 * Deletes by full primary key rather than by a `NOT IN` on `budgetMs`, so the
 * statement can only reach rows this function has actually seen and counted.
 *
 * Called only after an insert that actually landed. On the
 * `already-recorded` path nothing was added, so nothing can have gone over.
 */
function enforceLiveBudgetBound(tx: Transaction, key: LiveBudgetKey): void {
  const live = tx
    .select({ budgetMs: optimizedScheduleCache.budgetMs })
    .from(optimizedScheduleCache)
    .where(
      and(
        eq(optimizedScheduleCache.projectId, key.projectId),
        eq(optimizedScheduleCache.objective, key.objective),
        eq(optimizedScheduleCache.contractVersion, key.contractVersion),
        eq(optimizedScheduleCache.inputHash, key.inputHash),
      ),
    )
    .orderBy(desc(optimizedScheduleCache.createdAt), desc(optimizedScheduleCache.budgetMs))
    .all();

  for (const surplus of live.slice(MAX_LIVE_BUDGETS)) {
    tx.delete(optimizedScheduleCache)
      .where(
        and(
          eq(optimizedScheduleCache.projectId, key.projectId),
          eq(optimizedScheduleCache.objective, key.objective),
          eq(optimizedScheduleCache.contractVersion, key.contractVersion),
          eq(optimizedScheduleCache.inputHash, key.inputHash),
          eq(optimizedScheduleCache.budgetMs, surplus.budgetMs),
        ),
      )
      .run();
  }
}

/**
 * The two key columns a plan read must not name, and the reader owns.
 *
 * Both are **deployment** facts rather than plan facts. `budgetMs` is a key
 * column and not a detail, so a blue/green pair on two budgets is two rows;
 * `contractVersion` is the COMPOSITE the writer stores —
 * `"<SCHEDULER_CONTRACT_VERSION>+<solverVersion>"`, as
 * `build-solver-request.ts` builds it — and not the bare domain constant, so a
 * release running a new solver against unchanged Fast semantics does not read
 * the previous solver's answers.
 *
 * Taken as constructor arguments and not as members of the ask, because the
 * plan read knows neither and a plan read that guessed either would serve an
 * answer computed under a configuration this release is not running.
 */
export interface PublishedScheduleOptions {
  readonly contractVersion: string;
  readonly budgetMs: number;
}

/**
 * tasks.md 4.11's adapter: the production implementation of the plan read's
 * `OptimizedScheduleReader`, and `readOptimizedPair`'s first caller above the
 * repository.
 *
 * **Structurally typed rather than importing the service's port type.** The
 * service layer depends on the repository and not the other way round, so
 * naming `OptimizedScheduleReader` here would invert that for a type alias.
 * The composition root assigns this to `WorkItemServiceOptions.optimized`, and
 * TypeScript checks the shape at that assignment — which is the layer the
 * mistake would be made at anyway.
 *
 * **Four kinds collapse to `null` here and that is the whole mapping.** A miss,
 * a `failed` row, a `plan-infeasible` certificate and a `corrupt` payload are
 * four different facts to a reader deciding whether to spawn (4.2, 4.4) and one
 * fact to a plan read: there is no schedule to publish, so Fast answers. This
 * function must never spawn — an automatic read that started a solve is the
 * timer-shaped coupling slice 4 refuses, and `readOptimizedPairAndSpawn` is a
 * separate entry point precisely so that is a property of which function was
 * called.
 *
 * The hash is taken **here**, over the plan read's own `ScheduleInput`, because
 * this is the one place that turns a plan into a key. A caller that passed a
 * hash would be a second caller of 1.1/1.2 whose argument order could drift
 * from the writer's with both sides still green.
 */
export function publishedScheduleReaderOf(
  db: Reader,
  options: PublishedScheduleOptions,
): (ask: {
  readonly projectId: string;
  readonly objective: SolverObjectiveName;
  readonly input: ScheduleInput;
}) => Schedule | null {
  return (ask) => {
    const pair = readOptimizedPair(db, {
      projectId: ask.projectId,
      inputHash: scheduleInputHash(ask.input),
      contractVersion: options.contractVersion,
      budgetMs: options.budgetMs,
    });
    const outcome = pair[ask.objective];
    return outcome.kind === 'ok' ? outcome.result.schedule : null;
  };
}
