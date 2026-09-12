import { and, asc, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import type { Drizzle } from './db';
import {
  reserveSolverSlotIn,
  type SolverSlotAdmission,
  type SolverSlotRequest,
} from './optimization-admission';
import { readGeneration } from './optimization-generation';
import { toSolverQueueRow } from './optimizer-rows';
import {
  type OptimizationGenerationRow,
  project,
  type SolverObjectiveName,
  solverQueue,
  type SolverQueueRow,
} from './schema';

type Transaction = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];
interface QueueEntry extends Omit<SolverQueueRow, 'objective'> {
  readonly objective: SolverObjectiveName;
}

export interface SolverQueueRequest {
  readonly projectId: string;
  readonly contractVersion: string;
  readonly generation: number;
  readonly objective: SolverObjectiveName;
  readonly budgetMs: number;
  readonly enqueuedAt: number;
}

export interface SolverQueueEnqueue {
  readonly kind: 'queued' | 'already-present' | 'closed';
}

export interface SolverQueueDequeueRequest {
  readonly ownerId: string;
  readonly attemptToken: string;
  readonly now: number;
}

export type SolverQueueDequeue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'capacity-full' }
  | {
      readonly kind: 'reserved';
      readonly entry: QueueEntry;
      readonly inputHash: string;
      readonly admission: Extract<SolverSlotAdmission, { readonly kind: 'reserved' }>;
    };

const queueIdentity = (entry: SolverQueueRequest) =>
  and(
    eq(solverQueue.projectId, entry.projectId),
    eq(solverQueue.contractVersion, entry.contractVersion),
    eq(solverQueue.objective, entry.objective),
    eq(solverQueue.budgetMs, entry.budgetMs),
  );

export function currentQueueInputHash(
  generation: OptimizationGenerationRow | null,
  entry: Pick<QueueEntry, 'generation' | 'admittedCancelEpoch'>,
): string | null {
  return generation !== null &&
    generation.generation === entry.generation &&
    generation.cancelEpoch === entry.admittedCancelEpoch
    ? generation.inputHash
    : null;
}

function currentInputHash(tx: Transaction, entry: QueueEntry): string | null {
  return currentQueueInputHash(readGeneration(tx, entry.projectId, entry.contractVersion), entry);
}

/** Persist one capacity-blocked solve under the generation and cancel epoch observed now. */
/** Persist one capacity-blocked solve inside the caller's wider admission transaction. */
export function enqueueSolverRequestIn(
  tx: Transaction,
  request: SolverQueueRequest,
): SolverQueueEnqueue {
  const generation = readGeneration(tx, request.projectId, request.contractVersion);
  const state = tx
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
    state?.enabled !== true ||
    state.deletePendingAt !== null
  ) {
    return { kind: 'closed' };
  }
  const inserted = tx
    .insert(solverQueue)
    .values({ ...request, admittedCancelEpoch: generation.cancelEpoch })
    .onConflictDoNothing()
    .returning({ projectId: solverQueue.projectId })
    .all();
  return { kind: inserted.length === 1 ? 'queued' : 'already-present' };
}

export function enqueueSolverRequest(db: Drizzle, request: SolverQueueRequest): SolverQueueEnqueue {
  return db.transaction((tx) => enqueueSolverRequestIn(tx, request));
}

/**
 * Reserve the first valid durable entry, or leave the FIFO untouched while its
 * head is capacity-blocked. Invalid entries are consumed before trying the next.
 */
export function dequeueSolverRequest(
  db: Drizzle,
  request: SolverQueueDequeueRequest,
): SolverQueueDequeue {
  return db.transaction((tx) => {
    for (;;) {
      const stored = tx
        .select()
        .from(solverQueue)
        .orderBy(
          asc(solverQueue.enqueuedAt),
          asc(solverQueue.projectId),
          asc(solverQueue.contractVersion),
          asc(solverQueue.objective),
          asc(solverQueue.budgetMs),
        )
        .limit(1)
        .get();
      if (stored === undefined) return { kind: 'empty' };
      const entry = toSolverQueueRow(stored);
      const inputHash = currentInputHash(tx, entry);
      if (inputHash === null) {
        tx.delete(solverQueue).where(queueIdentity(entry)).run();
        continue;
      }

      const slot: SolverSlotRequest = {
        projectId: entry.projectId,
        contractVersion: entry.contractVersion,
        generation: entry.generation,
        objective: entry.objective,
        budgetMs: entry.budgetMs,
        ownerId: request.ownerId,
        attemptToken: request.attemptToken,
        // A Retry queue entry may have been stamped one tick after its retained
        // marker even when a deterministic clock stood still. Never move that
        // ordering backwards when the durable entry becomes a slot.
        now: Math.max(request.now, entry.enqueuedAt),
      };
      const admission = reserveSolverSlotIn(tx, slot);
      if (
        admission.kind === 'project-full' ||
        admission.kind === 'global-full' ||
        admission.kind === 'already-present'
      ) {
        // A matching row can belong to a still-live child from the previous
        // coordinator. Keep the durable request behind it: a later pump may
        // reserve the same variant only after that counted orphan is gone.
        return { kind: 'capacity-full' };
      }
      tx.delete(solverQueue).where(queueIdentity(entry)).run();
      if (admission.kind === 'reserved') {
        return { kind: 'reserved', entry, inputHash, admission };
      }
    }
  });
}
