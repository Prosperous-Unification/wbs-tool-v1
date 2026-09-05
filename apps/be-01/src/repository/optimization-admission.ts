import { and, eq } from 'drizzle-orm';

import type { Drizzle } from './db';
import { reclaimExpiredSolverSlotsIn } from './optimization-drain';
import { readGeneration } from './optimization-generation';
import { project, type SolverObjectiveName, solverSlot } from './schema';

const MAX_PROJECT_SLOTS = 4;
const MAX_GLOBAL_SLOTS = 16;
const CHILD_EXIT_GRACE_MS = 5_000;
const SLOT_RECLAIM_MARGIN_MS = 15_000;

export interface SolverSlotRequest {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  readonly ownerId: string;
  /** A fresh 128-bit value minted by the coordinator for this one attempt. */
  readonly attemptToken: string;
  readonly now: number;
}

export type SolverSlotAdmission =
  | {
      readonly kind: 'reserved';
      readonly attemptToken: string;
      readonly admittedCancelEpoch: number;
      readonly childDeadlineAt: number;
      readonly admittedDeadlineAt: number;
    }
  | { readonly kind: 'already-present' | 'closed' | 'project-full' | 'global-full' };

export interface SolverSlotBind {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  readonly attemptToken: string;
  readonly pid: number;
}

export interface SolverSlotHeartbeat {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  /** The reservation's 6.11 fence. */
  readonly attemptToken: string;
  /** The cancellation epoch returned by admission for this attempt. */
  readonly admittedCancelEpoch: number;
  readonly now: number;
}

export type SolverSlotHeartbeatOutcome =
  | { readonly kind: 'live' }
  | { readonly kind: 'cancelled'; readonly reason: 'requested' | 'generation' }
  | { readonly kind: 'lost' };

/**
 * Atomically gives one still-current `starting` reservation its launcher PID.
 * A stale token or a second bind updates zero rows, which tells the caller to
 * send `abort` and kill the launcher without executing the solver.
 */
export function bindSolverSlot(db: Drizzle, slot: SolverSlotBind): boolean {
  return (
    db
      .update(solverSlot)
      .set({ lifecycle: 'running', pid: slot.pid })
      .where(
        and(
          eq(solverSlot.projectId, slot.projectId),
          eq(solverSlot.contractVersion, slot.contractVersion),
          eq(solverSlot.generation, slot.generation),
          eq(solverSlot.objective, slot.objective),
          eq(solverSlot.budgetMs, slot.budgetMs),
          eq(solverSlot.attemptToken, slot.attemptToken),
          eq(solverSlot.lifecycle, 'starting'),
        ),
      )
      .returning({ attemptToken: solverSlot.attemptToken })
      .all().length === 1
  );
}

/**
 * Refresh one running attempt and observe durable cancellation in the same
 * SQLite round trip (tasks.md 6.4 and 6.11).
 *
 * The UPDATE carries both the full slot identity and the attempt token. A late
 * owner therefore cannot refresh a replacement that reused the same primary
 * key. The transaction then reads the slot's cancellation marker and the
 * generation/cancel-epoch pair that admission returned; either invalidation
 * tells the coordinator to terminate the child before its next five-second
 * heartbeat.
 */
export function heartbeatSolverSlot(
  db: Drizzle,
  slot: SolverSlotHeartbeat,
): SolverSlotHeartbeatOutcome {
  return db.transaction((tx) => {
    const refreshed = tx
      .update(solverSlot)
      .set({ heartbeatAt: slot.now })
      .where(
        and(
          eq(solverSlot.projectId, slot.projectId),
          eq(solverSlot.contractVersion, slot.contractVersion),
          eq(solverSlot.generation, slot.generation),
          eq(solverSlot.objective, slot.objective),
          eq(solverSlot.budgetMs, slot.budgetMs),
          eq(solverSlot.attemptToken, slot.attemptToken),
          eq(solverSlot.lifecycle, 'running'),
        ),
      )
      .returning({ cancelRequestedAt: solverSlot.cancelRequestedAt })
      .all();
    if (refreshed.length !== 1) return { kind: 'lost' };
    if (refreshed[0].cancelRequestedAt !== null) {
      return { kind: 'cancelled', reason: 'requested' };
    }

    const current = readGeneration(tx, slot.projectId, slot.contractVersion);
    if (
      current?.generation !== slot.generation ||
      current.cancelEpoch !== slot.admittedCancelEpoch
    ) {
      return { kind: 'cancelled', reason: 'generation' };
    }
    return { kind: 'live' };
  });
}

/**
 * Atomically reserves one `starting` solver seat without exceeding either
 * process ceiling (tasks.md 6.2's reservation half).
 *
 * The existing-key read happens before the ceiling reads: a second coordinator
 * asking for the same full identity coalesces with the first rather than being
 * reported as capacity pressure. Every unreleased row counts, including
 * `starting` rows, cancellation requests and a different budget.
 *
 * Expired seats are reclaimed before either ceiling is counted. The shared
 * transaction helper also attempts every affected contract/project finish, so
 * freeing capacity cannot strand the last row of a durable drain.
 */
export function reserveSolverSlot(db: Drizzle, request: SolverSlotRequest): SolverSlotAdmission {
  return db.transaction((tx) => {
    reclaimExpiredSolverSlotsIn(tx, request.now);

    const generation = readGeneration(tx, request.projectId, request.contractVersion);
    const projectState = tx
      .select({
        enabled: project.optimizationEnabled,
        deletePendingAt: project.optimizationDeletePendingAt,
      })
      .from(project)
      .where(eq(project.id, request.projectId))
      .get();
    if (
      generation?.generation !== request.generation ||
      generation.admissionState !== 'open' ||
      projectState?.enabled !== true ||
      projectState.deletePendingAt !== null
    ) {
      return { kind: 'closed' };
    }

    const identity = and(
      eq(solverSlot.projectId, request.projectId),
      eq(solverSlot.contractVersion, request.contractVersion),
      eq(solverSlot.generation, request.generation),
      eq(solverSlot.objective, request.objective),
      eq(solverSlot.budgetMs, request.budgetMs),
    );
    if (tx.select({ ownerId: solverSlot.ownerId }).from(solverSlot).where(identity).get()) {
      return { kind: 'already-present' };
    }

    const projectCount = tx
      .select({ ownerId: solverSlot.ownerId })
      .from(solverSlot)
      .where(eq(solverSlot.projectId, request.projectId))
      .all().length;
    if (projectCount >= MAX_PROJECT_SLOTS) return { kind: 'project-full' };

    const globalCount = tx.select({ ownerId: solverSlot.ownerId }).from(solverSlot).all().length;
    if (globalCount >= MAX_GLOBAL_SLOTS) return { kind: 'global-full' };

    const childDeadlineAt = request.now + request.budgetMs + CHILD_EXIT_GRACE_MS;
    const admittedDeadlineAt = childDeadlineAt + SLOT_RECLAIM_MARGIN_MS;
    const inserted = tx
      .insert(solverSlot)
      .values({
        projectId: request.projectId,
        contractVersion: request.contractVersion,
        generation: request.generation,
        objective: request.objective,
        budgetMs: request.budgetMs,
        ownerId: request.ownerId,
        attemptToken: request.attemptToken,
        lifecycle: 'starting',
        pid: null,
        startedAt: request.now,
        heartbeatAt: request.now,
        cancelRequestedAt: null,
        admittedDeadlineAt,
      })
      .onConflictDoNothing()
      .returning({ attemptToken: solverSlot.attemptToken })
      .all();
    if (inserted.length === 0) return { kind: 'already-present' };

    return {
      kind: 'reserved',
      attemptToken: request.attemptToken,
      admittedCancelEpoch: generation.cancelEpoch,
      childDeadlineAt,
      admittedDeadlineAt,
    };
  });
}
