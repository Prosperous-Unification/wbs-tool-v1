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
