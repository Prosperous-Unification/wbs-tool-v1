import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnUpdate } from './audit';
import type { WriteStamp } from './index';
import {
  optimizationGeneration,
  optimizedScheduleCache,
  project,
  type SolverObjectiveName,
  solverQueue,
  solverSlot,
} from './schema';

/** The handle a caller's own transaction hands to the helpers below. */
type Transaction = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];

/**
 * Phase 1 of the two-phase cancel-and-drain (tasks.md 3.9b).
 *
 * The target is what `contractVersion` selects, and the two targets are not two
 * policies: **naming a release retires that contract version**, and **omitting
 * it deletes the whole project**, closing every release it has. The steps below
 * are the same steps in both cases, widened from one generation row to all of
 * them, plus one extra write the project case needs and the release case must
 * not make — the durable `optimization_delete_pending_at` marker.
 *
 * **Why deletion is two-phase at all.** The immediate cascade — delete the row
 * and let `ON DELETE CASCADE` take the slot rows with it — frees the capacity
 * accounting before the children are proved dead. That is the fault that let six
 * real solver processes run while SQLite counted two: a second project admitted
 * into capacity the first had not actually given back. So phase 1 closes the
 * door and phase 2 deletes, and between them the slot rows stay **counted and
 * undeleted** until each is released by its owner or passes its stored
 * `admittedDeadlineAt`.
 *
 * This begin is one transaction and does four things to the affected rows:
 *
 * 1. `admissionState = 'draining'`, which is what admission and dequeue read.
 * 2. `cancelEpoch` advances by one, so a child admitted under the old epoch
 *    cannot write its result back.
 * 3. `cancel_requested_at` is stamped on the affected live slot rows — and
 *    **only on those that do not already carry one**. Re-stamping would move the
 *    instant a cancellation was first requested every time the reconciler ran,
 *    and that instant is what a reader uses to judge whether a child is ignoring
 *    the request. Leaving it alone is also what makes a repeated `begin`
 *    idempotent in the field that matters.
 * 4. The affected queued work is deleted. A queue row is unstarted work with
 *    no process behind it, so nothing is freed early by removing it — the
 *    asymmetry with the slot rows above is the whole point.
 *
 * **Deleting a project writes the marker first, before any generation row.**
 * Within one transaction the order of two writes is not observable, so this is
 * about what a *reader* of the marker is promised rather than about the
 * interleaving: the marker is the durable fence a coordinator in another process
 * reads, and every generation row it fences is closed under the same commit.
 * Setting it after the generations would put the same rows under two fences that
 * commit together anyway — the sequence is written this way so the fence reads
 * as the first thing the deletion establishes, which is what
 * `finishOptimizationDrain` and the reconciler both re-read.
 *
 * **A deletion never gets the project's physical row taken out from under it
 * here.** The row remains, because the slot rows reference it and their capacity
 * accounting has to stay alive while the children it counts are still running —
 * that is the same reason a slot row survives a retirement. Phase 2 is what
 * removes the project, once it has observed no slots left.
 *
 * **The generation rows are not deleted here and admission is never reopened.**
 * `finishOptimizationDrain` is the only writer that removes them, and it may run
 * from a different coordinator than the one that began the drain.
 *
 * The stamp is a {@link WriteStamp} rather than a bare instant because the
 * deletion arm's marker lands on `project`, which carries audit columns, and
 * `auditOnUpdate` is how every write in this folder proves it filled them. It
 * asks no caller to invent an actor it does not have: `auditOnUpdate` writes
 * `updatedAt` and nothing else, so a retirement triggered by a deploy supplies
 * the same instant it always did.
 *
 * Returns the number of slot rows the caller must still wait for. Zero means
 * finish may run immediately; it does not mean finish has run.
 */
export function beginOptimizationDrain(
  db: SQLiteBunDatabase,
  projectId: string,
  stamp: WriteStamp,
  contractVersion?: string,
): number {
  return db.transaction((tx) => {
    if (contractVersion === undefined) {
      // `isNull` for the same reason the slot stamp carries one: the marker
      // records when the deletion was FIRST requested, and a reader judging how
      // long a drain has been stuck needs that instant rather than the instant
      // of the most recent attempt to make it.
      tx.update(project)
        .set({ optimizationDeletePendingAt: stamp.at, ...auditOnUpdate(stamp) })
        .where(and(eq(project.id, projectId), isNull(project.optimizationDeletePendingAt)))
        .run();
    }

    const affected = tx
      .select()
      .from(optimizationGeneration)
      .where(
        and(
          eq(optimizationGeneration.projectId, projectId),
          ...(contractVersion === undefined
            ? []
            : [eq(optimizationGeneration.contractVersion, contractVersion)]),
        ),
      )
      .all();

    // **Every write below is a no-op on an absent target, and none of them needs
    // a guard to be one.** Draining a release that never allocated updates no
    // generation because the loop has nothing to loop over; deleting a project
    // that is not there matches no row in any of the four statements. An
    // early return asserting either would be a branch no mutation can red, which
    // is a guard that documents a belief rather than enforcing one. What the
    // absence must NOT do is create the row — and none of these is an upsert.
    //
    // Row by row, because `cancelEpoch` advances from each row's own value and a
    // single statement cannot read one column per row without dropping to SQL.
    // A project holds one generation row per live contract version — two during
    // a swap — so this is a loop over two, not over a table.
    for (const row of affected) {
      tx.update(optimizationGeneration)
        .set({
          admissionState: 'draining',
          cancelEpoch: row.cancelEpoch + 1,
          updatedAt: stamp.at,
        })
        .where(
          and(
            eq(optimizationGeneration.projectId, projectId),
            eq(optimizationGeneration.contractVersion, row.contractVersion),
          ),
        )
        .run();
    }

    tx.update(solverSlot)
      .set({ cancelRequestedAt: stamp.at })
      .where(
        and(
          eq(solverSlot.projectId, projectId),
          ...(contractVersion === undefined
            ? []
            : [eq(solverSlot.contractVersion, contractVersion)]),
          isNull(solverSlot.cancelRequestedAt),
        ),
      )
      .run();

    tx.delete(solverQueue)
      .where(
        and(
          eq(solverQueue.projectId, projectId),
          ...(contractVersion === undefined
            ? []
            : [eq(solverQueue.contractVersion, contractVersion)]),
        ),
      )
      .run();

    return tx
      .select()
      .from(solverSlot)
      .where(
        and(
          eq(solverSlot.projectId, projectId),
          ...(contractVersion === undefined
            ? []
            : [eq(solverSlot.contractVersion, contractVersion)]),
        ),
      )
      .all().length;
  });
}

/**
 * What one attempt at phase 2 did, and why it did nothing when it did nothing.
 *
 * Three of the four are ordinary and none is an error: `finish` is called from
 * three places that race each other on purpose — the initiator, every slot
 * release, and the reconciler — so most calls are expected to find the work
 * already done or not yet finishable.
 *
 * - `finished` — this call deleted the target.
 * - `waiting` — the closed state holds and affected slot rows remain. The
 *   children are still running and their capacity is still theirs.
 * - `open` — the durable closed state does **not** hold, so there is nothing to
 *   finish. This is the one that must never delete: a project with no slots is
 *   the ordinary state of most projects, and a `finish` that deleted on a
 *   zero-slot observation alone would delete a live project the moment anybody
 *   called it.
 * - `absent` — the target is already gone. The loser of a race, and a no-op.
 */
export type OptimizationDrainFinish = 'finished' | 'waiting' | 'open' | 'absent';

/**
 * Phase 2 of the two-phase cancel-and-drain (tasks.md 3.9b).
 *
 * **Finish is not the initiator's job.** A crash between `begin` and `finish`
 * left the project hidden with admission closed for ever, and admission is
 * exactly what a draining project rejects, so no later read could sweep it.
 * Three callers therefore run this same transaction: the initiator, every slot
 * release and reclaim sweep that removes the last affected row, and
 * `reconcileOptimizationDrains()` on its interval. All three are idempotent and
 * safe to race, and **none of them reopens admission** — there is no path from
 * `draining` back to `open` in this file.
 *
 * **The precondition is the lock.** The closed state and the zero-slot
 * observation are read inside the same transaction as the delete, and SQLite
 * will not let that transaction upgrade to a write on a stale read: a
 * concurrent commit in between makes the upgrade busy rather than letting it
 * proceed. So the loser of a race either blocks or comes back and observes the
 * row already gone, and never deletes on a view of the world that has moved.
 *
 * **What the delete takes.** Deleting the project row is the whole story — the
 * generation, slot, queue and cache rows all reference it `ON DELETE CASCADE`.
 * Retiring one contract version is not, because nothing references the
 * generation row: its queue rows went at `begin`, and its cache rows are taken
 * here, explicitly.
 *
 * **Assumption A-1, and what would falsify it.** Retiring a contract version
 * deletes that version's cache rows. They can never be read again — the cache
 * key carries `contractVersion` and no live release carries the retired one —
 * and 4.1b's retention bound is stated *per live contract version*, so a
 * retired version's rows fall outside every bound there is and accumulate one
 * release at a time, for ever. The cost of taking them is that a **rollback**
 * to a retired release starts on a cold cache and re-solves once per objective,
 * bounded by the budget the configuration already accepts. An unbounded leak
 * against a bounded re-solve is the trade this makes. It is falsified if
 * rolling back is routine rather than an incident: then the re-solve recurs and
 * keeping the rows is worth the growth.
 */
export function finishOptimizationDrain(
  db: SQLiteBunDatabase,
  projectId: string,
  contractVersion?: string,
): OptimizationDrainFinish {
  return db.transaction((tx) => finishDrainIn(tx, projectId, contractVersion));
}

/**
 * The whole of phase 2, in a transaction the caller already opened.
 *
 * **Every word of `finishOptimizationDrain`'s contract lives here, including
 * the one about the lock.** The three callers differ only in which transaction
 * they hand it: the initiator and the reconciler open one that does nothing
 * else, while a slot release opens one that has just removed a row — and the
 * spec asks for exactly that, the marker re-read *in the same transaction that
 * removes the last affected row*. Splitting the body out is what makes the
 * shared transaction expressible at all: `db.transaction` cannot be called
 * from inside a transaction, so the release path could otherwise only have
 * committed its delete first and finished afterwards, leaving a window in
 * which the target has no slots and no finisher.
 */
function finishDrainIn(
  tx: Transaction,
  projectId: string,
  contractVersion?: string,
): OptimizationDrainFinish {
  const outstanding = (): number =>
    tx
      .select()
      .from(solverSlot)
      .where(
        and(
          eq(solverSlot.projectId, projectId),
          ...(contractVersion === undefined
            ? []
            : [eq(solverSlot.contractVersion, contractVersion)]),
        ),
      )
      .all().length;

  if (contractVersion === undefined) {
    const target = tx.select().from(project).where(eq(project.id, projectId)).get();
    if (target === undefined) return 'absent';
    if (target.optimizationDeletePendingAt === null) return 'open';
    if (outstanding() > 0) return 'waiting';

    tx.delete(project).where(eq(project.id, projectId)).run();
    return 'finished';
  }

  const generation = tx
    .select()
    .from(optimizationGeneration)
    .where(
      and(
        eq(optimizationGeneration.projectId, projectId),
        eq(optimizationGeneration.contractVersion, contractVersion),
      ),
    )
    .get();
  if (generation === undefined) return 'absent';
  if (generation.admissionState !== 'draining') return 'open';
  if (outstanding() > 0) return 'waiting';

  tx.delete(optimizedScheduleCache)
    .where(
      and(
        eq(optimizedScheduleCache.projectId, projectId),
        eq(optimizedScheduleCache.contractVersion, contractVersion),
      ),
    )
    .run();

  tx.delete(optimizationGeneration)
    .where(
      and(
        eq(optimizationGeneration.projectId, projectId),
        eq(optimizationGeneration.contractVersion, contractVersion),
      ),
    )
    .run();
  return 'finished';
}

/**
 * Why an admission or a dequeue must refuse, or `null` when neither is closed.
 *
 * - `deleting` — the project carries `optimization_delete_pending_at`. Reported
 *   in preference to `draining` when both hold, because a deletion closes every
 *   release of the project and saying so is the more useful of two true things.
 * - `draining` — that contract version alone is retiring. Its siblings are
 *   unaffected, which is the whole difference between the two targets.
 * - `absent` — there is no generation row, or no project. **This is a refusal,
 *   not a shrug**, and it is the one that is easy to get wrong: `finish` deletes
 *   the generation row, so a caller that read absence as "nothing closed here"
 *   would admit work for a contract version that has just been retired, one
 *   transaction after the drain it was supposed to respect completed.
 */
export type OptimizationClosedReason = 'deleting' | 'draining' | 'absent';

/**
 * The closed-state predicate 3.9b puts in front of both admission and dequeue.
 *
 * **One predicate rather than two copies**, because 3.9b's second watched red
 * removes "either closed-state predicate" and requires work to start between
 * the zero-slot observation and the final delete — a red that only means
 * something if there is a single thing to remove. Admission (6.2) and dequeue
 * (6.3) both reject unless the matching generation is `open` and the project
 * carries no delete marker; the rest of the dequeue's re-check — generation
 * currency, `cancelEpoch`, the project toggle — is 6.3's own and is not here.
 *
 * Read inside the caller's transaction so the two reads and the caller's insert
 * commit together. {@link readOptimizationClosedState} is the same read for a
 * caller with no transaction of its own, and opens one for the same reason:
 * the marker and the admission state must be observed as of one instant.
 */
function closedStateIn(
  tx: Transaction,
  projectId: string,
  contractVersion: string,
): OptimizationClosedReason | null {
  const target = tx.select().from(project).where(eq(project.id, projectId)).get();
  if (target === undefined) return 'absent';
  if (target.optimizationDeletePendingAt !== null) return 'deleting';

  const generation = tx
    .select()
    .from(optimizationGeneration)
    .where(
      and(
        eq(optimizationGeneration.projectId, projectId),
        eq(optimizationGeneration.contractVersion, contractVersion),
      ),
    )
    .get();
  if (generation === undefined) return 'absent';
  return generation.admissionState === 'open' ? null : 'draining';
}

/** {@link closedStateIn} for a caller that has no transaction open. */
export function readOptimizationClosedState(
  db: SQLiteBunDatabase,
  projectId: string,
  contractVersion: string,
): OptimizationClosedReason | null {
  return db.transaction((tx) => closedStateIn(tx, projectId, contractVersion));
}

/** Which slot row a release means, and which attempt is entitled to release it. */
export interface SolverSlotRelease {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  /** 6.11's fence. A release presenting a stale token removes nothing. */
  readonly attemptToken: string;
}

/** What one slot release did — to the row, and to each of the two drain targets. */
export interface SolverSlotReleaseOutcome {
  /** Whether this call is the one that removed the row. */
  readonly released: boolean;
  /** Phase 2 on the slot's own contract version. */
  readonly retirement: OptimizationDrainFinish;
  /** Phase 2 on the slot's project. */
  readonly deletion: OptimizationDrainFinish;
}

/**
 * Give a solver slot back, and finish any drain that was waiting on it
 * (tasks.md 3.9b, path (a) — the opportunistic finish).
 *
 * **One transaction, and that is the requirement rather than an optimisation.**
 * The delete and both marker re-reads commit together, so no observer ever sees
 * a drained target with zero slots and nobody finishing it. Committing the
 * delete first and finishing afterwards would leave exactly that window, and a
 * crash inside it is what makes the reconciler necessary — this path exists so
 * the reconciler is the backstop for a crash rather than the ordinary route.
 *
 * **The token is a fence, not a formality.** Reclamation mints a new
 * `attemptToken` (6.11), so an owner that was reclaimed and whose slot was then
 * re-admitted would, releasing late, delete a row belonging to a live child and
 * hand its capacity to somebody else. The delete carries the token; a stale one
 * matches no row and `released` comes back false.
 *
 * **Both finishes run even when nothing was released**, and both run even when
 * no drain is in progress. A release that removed nothing is precisely the case
 * where another path already took the row, which is the moment a target may
 * have gone quiet; and on an ordinary project neither target is closed, so both
 * calls read a marker, return `open` and write nothing. Two reads is what the
 * ordinary path pays for never needing to know whether it is the last one out.
 *
 * **Retirement before deletion**, for the reason the reconciler orders its two
 * loops the same way: a delete-pending project has every release draining, and
 * retiring them first is what makes the observation. Deleting the project first
 * reaches the same end state by cascade, without it.
 */
export function releaseSolverSlot(
  db: SQLiteBunDatabase,
  slot: SolverSlotRelease,
): SolverSlotReleaseOutcome {
  return db.transaction((tx) => {
    const held = and(
      eq(solverSlot.projectId, slot.projectId),
      eq(solverSlot.contractVersion, slot.contractVersion),
      eq(solverSlot.generation, slot.generation),
      eq(solverSlot.objective, slot.objective),
      eq(solverSlot.budgetMs, slot.budgetMs),
      eq(solverSlot.attemptToken, slot.attemptToken),
    );
    // Read then delete, never `.run().changes`: bun-sqlite returns that count at
    // runtime but drizzle types it `void` here, and a number nobody can
    // typecheck is a number nobody can trust.
    const released = tx.select().from(solverSlot).where(held).all().length > 0;
    tx.delete(solverSlot).where(held).run();

    return {
      released,
      retirement: finishDrainIn(tx, slot.projectId, slot.contractVersion),
      deletion: finishDrainIn(tx, slot.projectId),
    };
  });
}

/** How long a coordinator waits between reconciliation passes (tasks.md 3.9b). */
export const DRAIN_RECONCILE_INTERVAL_MS = 60000;

/** What one reconciliation pass did, for the log line and for the tests. */
export interface OptimizationDrainReconciliation {
  /** Slot rows removed because they passed their own stored deadline. */
  readonly reclaimed: number;
  /** Targets phase 2 completed on this pass. */
  readonly finished: number;
  /** Targets still holding at least one live slot row. */
  readonly waiting: number;
}

/** Limit a reclaim pass to one drain target; omit it for admission's global sweep. */
export interface SolverSlotReclaimScope {
  readonly projectId: string;
  readonly contractVersion?: string;
}

/**
 * Remove expired seats and finish every affected drain in the same transaction.
 *
 * Admission calls the unscoped form before counting capacity, because an
 * expired child anywhere on the host no longer owns a global seat. The drain
 * reconciler calls the scoped form so its existing target-by-target result
 * counts stay meaningful. In both cases the deadline comes from each row and
 * the last-row delete cannot commit without the matching finish attempt.
 */
export function reclaimExpiredSolverSlotsIn(
  tx: Transaction,
  now: number,
  scope?: SolverSlotReclaimScope,
): OptimizationDrainReconciliation {
  const expiring = and(
    lte(solverSlot.admittedDeadlineAt, now),
    ...(scope === undefined
      ? []
      : [
          eq(solverSlot.projectId, scope.projectId),
          ...(scope.contractVersion === undefined
            ? []
            : [eq(solverSlot.contractVersion, scope.contractVersion)]),
        ]),
  );
  const expired = tx
    .select({
      projectId: solverSlot.projectId,
      contractVersion: solverSlot.contractVersion,
    })
    .from(solverSlot)
    .where(expiring)
    .all();
  tx.delete(solverSlot).where(expiring).run();

  const targets: SolverSlotReclaimScope[] = [];
  if (scope !== undefined) {
    targets.push(scope);
  } else {
    const contracts = new Map<string, SolverSlotReclaimScope>();
    const projects = new Map<string, SolverSlotReclaimScope>();
    for (const row of expired) {
      contracts.set(`${row.projectId}\u0000${row.contractVersion}`, row);
      projects.set(row.projectId, { projectId: row.projectId });
    }
    targets.push(...contracts.values(), ...projects.values());
  }

  let finished = 0;
  let waiting = 0;
  for (const target of targets) {
    const outcome = finishDrainIn(tx, target.projectId, target.contractVersion);
    if (outcome === 'finished') finished += 1;
    if (outcome === 'waiting') waiting += 1;
  }
  return { reclaimed: expired.length, finished, waiting };
}

/**
 * The path that makes a crash between `begin` and `finish` recoverable
 * (tasks.md 3.9b).
 *
 * **Why it has to exist.** Without it, a coordinator that died after `begin`
 * left the project hidden with admission closed for ever — and admission is
 * exactly what a draining project rejects, so no ordinary read could ever sweep
 * it up again. Remove this function and that project is wedged and undeletable
 * by any code path in the system. Called on coordinator startup and every
 * {@link DRAIN_RECONCILE_INTERVAL_MS}.
 *
 * **What it reclaims, and why that is not the immediate cascade wearing a new
 * name.** A slot row is deleted here only once `now` has passed the deadline
 * **stored on that row**, at which point its child is presumed dead and the
 * capacity was never really outstanding. The deadline is read from the row
 * rather than computed from this coordinator's own configuration, so a
 * coordinator running the smaller budget cannot reclaim a larger-budget child
 * that is still inside its own deadline — the fault that would put the six
 * processes back by another route.
 *
 * **Generations before projects.** A delete-pending project has every one of
 * its generations draining, so the first pass retires them release by release
 * and the second deletes the project once nothing is left. Running it the other
 * way would delete the project first and take the generation rows with it by
 * cascade — the same end state, reached without ever observing the releases,
 * which is the observation the drain exists to make.
 *
 * Idempotent and safe to run concurrently, because every decision it makes is
 * `finishOptimizationDrain`'s: two reconcilers reach the same end state and
 * neither errors, one of them simply reading `absent` where the other read
 * `finished`. It never reopens admission.
 */
export function reconcileOptimizationDrains(
  db: SQLiteBunDatabase,
  now: number,
): OptimizationDrainReconciliation {
  let reclaimed = 0;
  let finished = 0;
  let waiting = 0;

  const sweep = (projectId: string, contractVersion?: string): void => {
    // Reclaim and finish in ONE transaction, which is what 3.9b asks of a
    // reclaim sweep in the same words it asks it of a slot release: the marker
    // is re-read in the transaction that removes the last affected row. The
    // counts are returned rather than added inside the callback, so a rolled
    // back transaction cannot leave this pass reporting rows it did not remove.
    //
    // Counted by reading the rows rather than by the delete's own row count:
    // `.run()` is typed `void` here, so `.changes` is reachable at runtime but
    // untyped, and a number nobody can typecheck is a number nobody can trust.
    const pass = db.transaction((tx) =>
      reclaimExpiredSolverSlotsIn(tx, now, { projectId, contractVersion }),
    );
    reclaimed += pass.reclaimed;
    finished += pass.finished;
    waiting += pass.waiting;
  };

  const draining = db
    .select()
    .from(optimizationGeneration)
    .where(eq(optimizationGeneration.admissionState, 'draining'))
    .all();
  for (const row of draining) sweep(row.projectId, row.contractVersion);

  const pending = db
    .select()
    .from(project)
    .where(isNotNull(project.optimizationDeletePendingAt))
    .all();
  for (const row of pending) sweep(row.id);

  return { reclaimed, finished, waiting };
}
