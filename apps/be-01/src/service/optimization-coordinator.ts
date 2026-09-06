import type { BuiltSolverRequest } from '@wbs/contracts/solver/build-request';
import { dispositionOfPreflightFailure } from '@wbs/contracts/solver/solver-failure-disposition';
import type { Schedule } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';

import type { Drizzle } from '../repository/db';
import type { EventLogRepo, RecordedEvent } from '../repository/event-log';
import {
  bindSolverSlot,
  reserveSolverSlot,
  type SolverSlotAdmission,
} from '../repository/optimization-admission';
import {
  DRAIN_RECONCILE_INTERVAL_MS,
  reconcileOptimizationDrains,
  releaseSolverSlot,
} from '../repository/optimization-drain';
import { allocateGeneration } from '../repository/optimization-generation';
import { dequeueSolverRequest, enqueueSolverRequest } from '../repository/optimization-queue';
import {
  optimizedVariantIsLive,
  type OutcomeWrite,
  type OutcomeWriteResult,
  readOptimizedPairAndSpawn,
  type SpawnRequest,
  storeOptimizedOutcomeIn,
} from '../repository/optimized-schedule-cache';
import type { SolverObjectiveName } from '../repository/schema';
import { type ProjectEvent, subscriptionFor } from './broadcast';
import {
  optimizationVariantState,
  type OptimizedScheduleReader,
} from './optimized-schedule-reader';
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
  /** Rebuild the current canonical input for a durable queue entry after restart. */
  readonly inputOf: (projectId: string) => Promise<ScheduleInput | null>;
  /** Whether an edit-triggered read may spend solver capacity for this project. */
  readonly enabledOf: (projectId: string) => Promise<boolean>;
  /**
   * The launcher boundary, called only after SQLite returned this attempt's
   * counted `starting` row. Slice 6.2b binds that row to the launcher PID.
   */
  readonly spawn: ReservedSpawner;
  readonly runChild?: (options: SolverChildLifecycleOptions) => Promise<SolverChildLifecycleResult>;
  readonly onChildError: (error: unknown) => void;
  /** Durable half of a newly stored result's project event. */
  readonly eventLog: Pick<EventLogRepo, 'recordEventIn'>;
  /** Best-effort live half, invoked only after the outcome transaction commits. */
  readonly pushRecorded: (
    subscription: string,
    recorded: RecordedEvent,
    event: OptimizationOutcomeEvent,
  ) => Promise<void>;
  readonly editDebounceMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

type ReservedAdmission = Extract<SolverSlotAdmission, { kind: 'reserved' }>;
type SolverRequest = Extract<BuiltSolverRequest, { readonly ok: true }>['request'];
export type ScheduleOptimizedEvent = Extract<ProjectEvent, { type: 'schedule_optimized' }>;
export type ScheduleOptimizationFailedEvent = Extract<
  ProjectEvent,
  { type: 'schedule_optimization_failed' }
>;
export type OptimizationOutcomeEvent = ScheduleOptimizedEvent | ScheduleOptimizationFailedEvent;

export interface RecordedOptimizedOutcome {
  readonly result: OutcomeWriteResult;
  readonly subscription?: string;
  readonly recorded?: RecordedEvent;
  readonly event?: OptimizationOutcomeEvent;
}

/** Atomically store one validated result and its durable replay record. */
export function storeOptimizedOutcomeAndRecord(
  db: Drizzle,
  eventLog: Pick<EventLogRepo, 'recordEventIn'>,
  write: OutcomeWrite,
): RecordedOptimizedOutcome {
  return db.transaction((tx) => {
    const result = storeOptimizedOutcomeIn(tx, write);
    if (result !== 'stored' || write.outcome.kind === 'plan-infeasible') return { result };
    const identity = {
      projectId: write.claim.projectId,
      generation: write.claim.generation,
      inputHash: write.inputHash,
      objective: write.claim.objective,
      contractVersion: write.claim.contractVersion,
      budgetMs: write.claim.budgetMs,
    };
    const event: OptimizationOutcomeEvent =
      write.outcome.kind === 'ok'
        ? { type: 'schedule_optimized', ...identity }
        : {
            type: 'schedule_optimization_failed',
            ...identity,
            failureReason: write.outcome.reason,
          };
    const subscription = subscriptionFor(write.claim.projectId);
    const recorded = eventLog.recordEventIn(tx, subscription, event, write.now);
    return { result, subscription, recorded, event };
  });
}

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

export const OPTIMIZATION_EDIT_DEBOUNCE_MS = 250;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  private pumpInFlight: Promise<void> | undefined;
  private pumpRequested = false;
  private readonly editEpoch = new Map<string, number>();
  private reconcileHandle: unknown = null;

  constructor(private readonly options: OptimizationCoordinatorOptions) {}

  /** Await children already launched by this coordinator; used by shutdown and deterministic tests. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Start restart reconciliation after the composition root has wired the input reader. */
  start(): void {
    if (this.reconcileHandle !== null) return;
    this.reconcileDrains();
    const handle = (this.options.setInterval ?? setInterval)(() => {
      this.reconcileDrains();
      this.requestPump();
    }, DRAIN_RECONCILE_INTERVAL_MS);
    (handle as { unref?: () => void }).unref?.();
    this.reconcileHandle = handle;
    this.requestPump();
  }

  /** Stop periodic reconciliation, then await attempts already owned by this process. */
  async stop(): Promise<void> {
    if (this.reconcileHandle !== null) {
      (this.options.clearInterval ?? clearInterval)(
        this.reconcileHandle as ReturnType<typeof setInterval>,
      );
      this.reconcileHandle = null;
    }
    await this.drain();
  }

  private reconcileDrains(): void {
    try {
      reconcileOptimizationDrains(this.options.db, this.options.now());
    } catch (error) {
      this.options.onChildError(error);
    }
  }

  /** Coalesce project events, then admit both absent variants for the newest input. */
  inputChanged(projectId: string): void {
    const epoch = (this.editEpoch.get(projectId) ?? 0) + 1;
    this.editEpoch.set(projectId, epoch);
    const tracked = this.optimizeAfterEdit(projectId, epoch)
      .catch((error: unknown) => {
        this.options.onChildError(error);
      })
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private async optimizeAfterEdit(projectId: string, epoch: number): Promise<void> {
    await (this.options.sleep ?? sleep)(
      this.options.editDebounceMs ?? OPTIMIZATION_EDIT_DEBOUNCE_MS,
    );
    if (this.editEpoch.get(projectId) !== epoch) return;
    this.editEpoch.delete(projectId);
    if (!(await this.options.enabledOf(projectId))) return;
    const input = await this.options.inputOf(projectId);
    if (input === null) return;
    this.read({ projectId, objective: 'pri', input });
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
    this.storeOutcome({
      claim: { ...this.slotOf(request), ownerId: this.options.ownerId },
      inputHash: request.key.inputHash,
      admittedCancelEpoch: request.admission.admittedCancelEpoch,
      outcome: { kind: 'failed', reason: 'internal-error' },
      now: this.options.now(),
    });
  }

  private storeOutcome(write: OutcomeWrite): OutcomeWriteResult {
    const committed = storeOptimizedOutcomeAndRecord(this.options.db, this.options.eventLog, write);
    if (
      committed.subscription !== undefined &&
      committed.recorded !== undefined &&
      committed.event !== undefined
    ) {
      const tracked = this.options
        .pushRecorded(committed.subscription, committed.recorded, committed.event)
        .catch((error: unknown) => {
          this.options.onChildError(error);
        })
        .finally(() => this.inFlight.delete(tracked));
      this.inFlight.add(tracked);
    }
    return committed.result;
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
          this.storeOutcome({
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
      .finally(() => {
        this.inFlight.delete(tracked);
        this.requestPump();
      });
    this.inFlight.add(tracked);
  }

  private requestPump(): void {
    if (this.pumpInFlight !== undefined) {
      this.pumpRequested = true;
      return;
    }
    this.pumpRequested = false;
    const tracked = this.pumpQueue()
      .catch((error: unknown) => {
        this.options.onChildError(error);
      })
      .finally(() => {
        this.inFlight.delete(tracked);
        this.pumpInFlight = undefined;
        if (this.pumpRequested) this.requestPump();
      });
    this.pumpInFlight = tracked;
    this.inFlight.add(tracked);
  }

  private async pumpQueue(): Promise<void> {
    for (;;) {
      const next = dequeueSolverRequest(this.options.db, {
        ownerId: this.options.ownerId,
        attemptToken: this.options.attemptToken(),
        now: this.options.now(),
      });
      if (next.kind === 'empty' || next.kind === 'capacity-full') return;

      const slot = {
        projectId: next.entry.projectId,
        contractVersion: next.entry.contractVersion,
        generation: next.entry.generation,
        objective: next.entry.objective,
        budgetMs: next.entry.budgetMs,
        attemptToken: next.admission.attemptToken,
      };
      const input = await this.options.inputOf(next.entry.projectId);
      if (input === null) {
        releaseSolverSlot(this.options.db, slot);
        continue;
      }
      if (scheduleInputHash(input) !== next.inputHash) {
        releaseSolverSlot(this.options.db, slot);
        this.read({ projectId: next.entry.projectId, objective: next.entry.objective, input });
        continue;
      }

      const built = buildSolverRequestPair(input, this.options.solverVersion, next.entry.budgetMs)[
        next.entry.objective
      ];
      if (!built.ok) {
        try {
          this.storeOutcome({
            claim: { ...slot, ownerId: this.options.ownerId },
            inputHash: next.inputHash,
            admittedCancelEpoch: next.admission.admittedCancelEpoch,
            outcome: { kind: 'failed', reason: dispositionOfPreflightFailure(built.failure) },
            now: this.options.now(),
          });
        } finally {
          releaseSolverSlot(this.options.db, slot);
        }
        continue;
      }

      this.startReserved({
        key: {
          projectId: next.entry.projectId,
          inputHash: next.inputHash,
          contractVersion: next.entry.contractVersion,
          budgetMs: next.entry.budgetMs,
        },
        objective: next.entry.objective,
        generation: next.entry.generation,
        admission: next.admission,
        request: built.request,
        input,
      });
    }
  }

  /**
   * The reader wired into {@link WorkItemService}. It is an arrow so handing it
   * to the service cannot lose the coordinator instance as `this`.
   */
  readonly readPlan: OptimizedScheduleReader = (ask) => {
    const inputHash = scheduleInputHash(ask.input);
    const key = {
      projectId: ask.projectId,
      inputHash,
      contractVersion: this.options.contractVersion,
      budgetMs: this.options.budgetMs,
    };
    if (
      ask.enabled === false ||
      ask.input.slices.length === 0 ||
      ask.input.slices.every((slice) => slice.days === 0)
    ) {
      return {
        ...key,
        generation: null,
        variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
        selectedSchedule: null,
      };
    }

    const now = this.options.now();
    const generation = allocateGeneration(
      this.options.db,
      ask.projectId,
      this.options.contractVersion,
      inputHash,
      now,
    );
    let requests: SolverRequestPair | undefined;
    const pair = readOptimizedPairAndSpawn(this.options.db, key, (request) => {
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
      if (admission.kind === 'project-full' || admission.kind === 'global-full') {
        enqueueSolverRequest(this.options.db, {
          projectId: request.key.projectId,
          contractVersion: request.key.contractVersion,
          generation,
          objective: request.objective,
          budgetMs: request.key.budgetMs,
          enqueuedAt: now,
        });
        return;
      }
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
            this.storeOutcome({
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
            this.requestPump();
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
    });
    const outcome = pair[ask.objective];
    const live = (objective: SolverObjectiveName): boolean =>
      optimizedVariantIsLive(this.options.db, key, generation, objective);
    return {
      ...key,
      generation,
      variants: {
        pri: optimizationVariantState(pair.pri, live('pri')),
        time: optimizationVariantState(pair.time, live('time')),
      },
      selectedSchedule: outcome.kind === 'ok' ? outcome.result.schedule : null,
    };
  };

  /** Compatibility seam for queue callbacks and tests that need only the selected schedule. */
  readonly read = (ask: {
    readonly projectId: string;
    readonly objective: SolverObjectiveName;
    readonly input: ScheduleInput;
  }): Schedule | null => this.readPlan(ask).selectedSchedule;
}
