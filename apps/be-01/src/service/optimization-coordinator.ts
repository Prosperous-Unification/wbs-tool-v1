import type { BuiltSolverRequest } from '@wbs/contracts/solver/build-request';
import { dispositionOfPreflightFailure } from '@wbs/contracts/solver/solver-failure-disposition';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';

import type { Drizzle } from '../repository/db';
import {
  bindSolverSlot,
  reserveSolverSlot,
  type SolverSlotAdmission,
} from '../repository/optimization-admission';
import { releaseSolverSlot } from '../repository/optimization-drain';
import { allocateGeneration } from '../repository/optimization-generation';
import {
  readOptimizedPairAndSpawn,
  type SpawnRequest,
  storeOptimizedOutcome,
} from '../repository/optimized-schedule-cache';
import type { SolverObjectiveName } from '../repository/schema';
import type { OptimizedScheduleReader } from './optimized-schedule-reader';
import {
  runSolverChildLifecycle,
  type SolverChildLifecycleOptions,
  type SolverChildLifecycleResult,
  type SolverChildProcess,
} from './solver-child-lifecycle';
import { evaluateSolverOutcome, type SolverProcessOutcome } from './solver-exit-outcome';
import { buildSolverRequestPair, type SolverRequestPair } from './solver-request-pair';

export interface OptimizationCoordinatorOptions {
  readonly db: Drizzle;
  readonly contractVersion: string;
  readonly solverVersion: string;
  readonly budgetMs: number;
  /** Stable for this backend process; generated once at coordinator boot. */
  readonly ownerId: string;
  /** Read once per plan-read admission attempt. */
  readonly now: () => number;
  /** Fresh 128-bit token source; the production root supplies `randomUUID`. */
  readonly attemptToken: () => string;
  /**
   * The launcher boundary, called only after SQLite returned this attempt's
   * counted `starting` row. Slice 6.2b binds that row to the launcher PID.
   */
  readonly spawn: ReservedSpawner;
  readonly runChild?: (options: SolverChildLifecycleOptions) => Promise<SolverChildLifecycleResult>;
  readonly onChildError: (error: unknown) => void;
}

type ReservedAdmission = Extract<SolverSlotAdmission, { kind: 'reserved' }>;
type SolverRequest = Extract<BuiltSolverRequest, { readonly ok: true }>['request'];

/** Everything the launcher needs from the read and its successful reservation. */
export interface ReservedSpawnRequest extends SpawnRequest {
  readonly generation: number;
  readonly admission: ReservedAdmission;
  /** The exact deterministic request written to the launcher's stdin after bind. */
  readonly request: SolverRequest;
  /** The canonical input used to materialise and independently revalidate the response. */
  readonly input: ScheduleInput;
}

export interface ReservedSolverTerminal {
  readonly exitCode: number;
  readonly deadlineKilled: boolean;
  readonly oomKilled: boolean;
}

/** The authenticated host child and the streams its lifecycle drains immediately. */
export interface ReservedSolverChild extends SolverChildProcess {
  readonly terminal?: Promise<ReservedSolverTerminal>;
  readonly verdict: (verdict: 'bound' | 'abort') => void | Promise<void>;
}

export type ReservedSpawner = (request: ReservedSpawnRequest) => Promise<ReservedSolverChild>;

/**
 * The synchronous plan-read half of the optimizer coordinator (tasks.md 6.1).
 *
 * A cache hit returns immediately. A miss also returns immediately, after
 * requesting admission for each absent objective; the child never sits on the
 * request path. Exact-key `failed` and `corrupt` rows remain terminal until an
 * explicit Retry because {@link readOptimizedPairAndSpawn} admits only misses.
 */
export class OptimizationCoordinator {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: OptimizationCoordinatorOptions) {}

  /** Await children already launched by this coordinator; used by shutdown and deterministic tests. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private slotOf(request: ReservedSpawnRequest) {
    return {
      projectId: request.key.projectId,
      contractVersion: request.key.contractVersion,
      generation: request.generation,
      objective: request.objective,
      budgetMs: request.key.budgetMs,
      attemptToken: request.admission.attemptToken,
      admittedCancelEpoch: request.admission.admittedCancelEpoch,
    };
  }

  private storeInternalFailure(request: ReservedSpawnRequest): void {
    storeOptimizedOutcome(this.options.db, {
      claim: { ...this.slotOf(request), ownerId: this.options.ownerId },
      inputHash: request.key.inputHash,
      admittedCancelEpoch: request.admission.admittedCancelEpoch,
      outcome: { kind: 'failed', reason: 'internal-error' },
      now: this.options.now(),
    });
  }

  private async processOutcome(
    child: ReservedSolverChild,
    exit: { readonly code: number; readonly stdout: string },
  ): Promise<SolverProcessOutcome> {
    if (child.terminal === undefined) {
      return exit.code === 0
        ? { kind: 'response', stdout: exit.stdout }
        : { kind: 'failed', reason: 'internal-error' };
    }
    const terminal = await child.terminal;
    if (terminal.deadlineKilled) return { kind: 'failed', reason: 'timeout' };
    if (terminal.oomKilled) return { kind: 'failed', reason: 'oom' };
    return terminal.exitCode === 0
      ? { kind: 'response', stdout: exit.stdout }
      : { kind: 'failed', reason: 'internal-error' };
  }

  private async runReserved(request: ReservedSpawnRequest): Promise<void> {
    const slot = this.slotOf(request);
    let child: ReservedSolverChild;
    try {
      child = await this.options.spawn(request);
    } catch (error) {
      // Without host terminal evidence, a process may still exist. Preserve
      // the counted seat until its admitted deadline rather than overbook.
      this.storeInternalFailure(request);
      throw error;
    }

    const bound = bindSolverSlot(this.options.db, {
      ...slot,
      pid: child.pid,
    });
    if (!bound) {
      await child.verdict('abort');
      await child.exited;
      return;
    }

    try {
      await child.verdict('bound');
    } catch (error) {
      try {
        await child.kill();
      } catch {
        // The first transport failure is the useful error. Either way there is
        // no terminal evidence, so the reservation remains counted.
      }
      this.storeInternalFailure(request);
      throw error;
    }

    const execute = this.options.runChild ?? runSolverChildLifecycle;
    try {
      await execute({
        db: this.options.db,
        slot,
        child,
        now: this.options.now,
        onExit: async (exit) => {
          const outcome = await this.processOutcome(child, exit);
          storeOptimizedOutcome(this.options.db, {
            claim: { ...slot, ownerId: this.options.ownerId },
            inputHash: request.key.inputHash,
            admittedCancelEpoch: request.admission.admittedCancelEpoch,
            outcome: evaluateSolverOutcome(request.input, request.request, outcome),
            now: this.options.now(),
          });
        },
      });
    } catch (error) {
      // The lifecycle releases only after a proved terminal or cancellation.
      // A rejected terminal/EOF therefore leaves this exact slot present.
      this.storeInternalFailure(request);
      throw error;
    }
  }

  private startReserved(request: ReservedSpawnRequest): void {
    const tracked = this.runReserved(request)
      .catch((error: unknown) => {
        this.options.onChildError(error);
      })
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * The reader wired into {@link WorkItemService}. It is an arrow so handing it
   * to the service cannot lose the coordinator instance as `this`.
   */
  readonly read: OptimizedScheduleReader = (ask: {
    readonly projectId: string;
    readonly objective: SolverObjectiveName;
    readonly input: ScheduleInput;
  }) => {
    if (ask.input.slices.length === 0 || ask.input.slices.every((slice) => slice.days === 0)) {
      return null;
    }

    const inputHash = scheduleInputHash(ask.input);
    const now = this.options.now();
    const generation = allocateGeneration(
      this.options.db,
      ask.projectId,
      this.options.contractVersion,
      inputHash,
      now,
    );
    let requests: SolverRequestPair | undefined;
    const pair = readOptimizedPairAndSpawn(
      this.options.db,
      {
        projectId: ask.projectId,
        inputHash,
        contractVersion: this.options.contractVersion,
        budgetMs: this.options.budgetMs,
      },
      (request) => {
        const admission = reserveSolverSlot(this.options.db, {
          projectId: request.key.projectId,
          contractVersion: request.key.contractVersion,
          generation,
          objective: request.objective,
          budgetMs: request.key.budgetMs,
          ownerId: this.options.ownerId,
          attemptToken: this.options.attemptToken(),
          now,
        });
        if (admission.kind === 'reserved') {
          requests ??= buildSolverRequestPair(
            ask.input,
            this.options.solverVersion,
            this.options.budgetMs,
          );
          const built = requests[request.objective];
          const slot = {
            projectId: request.key.projectId,
            contractVersion: request.key.contractVersion,
            generation,
            objective: request.objective,
            budgetMs: request.key.budgetMs,
            attemptToken: admission.attemptToken,
          };
          if (!built.ok) {
            try {
              storeOptimizedOutcome(this.options.db, {
                claim: { ...slot, ownerId: this.options.ownerId },
                inputHash: request.key.inputHash,
                admittedCancelEpoch: admission.admittedCancelEpoch,
                outcome: {
                  kind: 'failed',
                  reason: dispositionOfPreflightFailure(built.failure),
                },
                now,
              });
            } finally {
              releaseSolverSlot(this.options.db, slot);
            }
            return;
          }

          const launch = {
            ...request,
            generation,
            admission,
            request: built.request,
            input: ask.input,
          };
          this.startReserved(launch);
        }
      },
    );
    const outcome = pair[ask.objective];
    return outcome.kind === 'ok' ? outcome.result.schedule : null;
  };
}
