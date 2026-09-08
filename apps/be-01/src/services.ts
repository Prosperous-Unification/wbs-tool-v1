import { type Clock, clockOf } from '@wbs/core';
import { contractVersionOf } from '@wbs/domain';
import type { Logger } from '@wbs/observability';
import { systemTimers } from '@wbs/runtime-portable';

import { PLAN_EVENT_RETENTION_DAYS } from './repository';
import { ActualRepository } from './repository/actual';
import { CalendarMarkerRepository } from './repository/calendar-marker';
import { CapacityRepository } from './repository/capacity';
import { CommandJournalRepository } from './repository/command-journal';
import type { Drizzle } from './repository/db';
import { DependencyRepository } from './repository/dependency';
import { DirectoryRepository } from './repository/directory';
import { EstimateRepository } from './repository/estimate';
import { DrizzleEventLogStore } from './repository/event-log';
import { type Gate, OPEN, type WriteCoordinator } from './repository/gate';
import { PlanEventRepository } from './repository/plan-event';
import { PriorityBandRepository } from './repository/priority-band';
import { ProjectRepository } from './repository/project';
import { sqliteUnitOfWork } from './repository/sqlite-unit-of-work';
import { StepRepository } from './repository/step';
import { StepMeasureRepository } from './repository/step-measure';
import { StepProgressRepository } from './repository/step-progress';
import { UserRepository } from './repository/user';
import { SubtreeRepository, WorkItemRepository } from './repository/work-item';
import { bunPasswordHasher, joseTokenCodec, systemInterval } from './runtime/bun-runtime';
import { AuthService, type AuthServiceOptions } from './service/auth.service';
import type { Broadcaster } from './service/broadcast';
import { CalendarMarkerService } from './service/calendar-marker.service';
import { CapacityService } from './service/capacity.service';
import { DirectoryService } from './service/directory.service';
import { GatewayBroadcaster } from './service/gateway-broadcaster';
import { HistoryService } from './service/history.service';
import { OptimizationCoordinator, type ReservedSpawner } from './service/optimization-coordinator';
import { OptimizerTriggerBroadcaster } from './service/optimizer-trigger-broadcaster';
import { optimizerWiring } from './service/optimizer-wiring';
import { PriorityBandService } from './service/priority-band.service';
import { ProjectService } from './service/project.service';
import { type FetchLike, PushClient } from './service/push-client';
import { ReplayBuffer } from './service/replay-buffer';
import { ReplayOrchestrator } from './service/replay-orchestrator';
import { RetentionTimer } from './service/retention-timer';
import { StepService } from './service/step.service';
import type { UnitOfWork } from './service/unit-of-work';
import { WorkItemService } from './service/work-item.service';

/**
 * How much of the event stream is kept, and how often.
 *
 * Constants rather than configuration: nothing about an environment changes the
 * right answer, and a knob nobody sets is a knob nobody keeps correct. The
 * buffer is the fast path for a reconnect within minutes; the log is what a
 * longer absence falls back to.
 */
const EVENT_LOG_MAX_PER_SUBSCRIPTION = 1_000;
// The history's own window is `PLAN_EVENT_RETENTION_DAYS`, argued where it is
// declared, and it is swept on the same tick as the log.
const RETENTION_INTERVAL_MS = 10 * 60_000;
const REPLAY_BUFFER_MAX_AGE_MS = 5 * 60_000;

export interface OptimizerRuntime {
  solverVersion: string;
  budgetMs: number;
  spawn: ReservedSpawner;
}

export interface ServicesOptions {
  db: Drizzle;
  /**
   * The process's one write coordinator, which `boot.ts` must hand to **both**
   * this factory and `buildApp`'s `writes.gate`.
   *
   * Every store built here takes its turn at this object, so nothing can write
   * inside a command batch's outer transaction on `db`; the runner takes one
   * turn for the whole batch. Two coordinators would each look healthy and
   * exclude nothing — the same failure mode the one-broadcaster and one-buffer
   * comments below describe.
   */
  gate: WriteCoordinator;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
  /** The transport used for the gateway push boundary. */
  pushFetch: FetchLike;
  oidc?: AuthServiceOptions['oidc'];
  passwordSessions?: boolean;
  localIdentity?: AuthServiceOptions['localIdentity'];
  optimizer?: OptimizerRuntime;
}

export interface BeServices extends WritingServices {
  /**
   * The one broadcaster every route publishes through, and where a batch's own
   * collector drains to once it has committed and let go of its turn.
   * `boot.ts` hands it to `buildApp` as `writes.announcements`.
   */
  announcements: Broadcaster;
  /**
   * The broadcaster {@link announcements} wraps, for **one** reader: the
   * one-lock regression in `boot.db.test.ts` has to read the lock off the object
   * that records under it, or it restates the wiring instead of observing it.
   *
   * Nothing publishes through this. It replaced `DeferringBroadcaster.undeferred`
   * (TASK-256), which was reachable from every service that held the wrapper,
   * and outlived that wrapper itself (D24); this is reachable only from the
   * composition root. A publisher wired here
   * would announce before its batch committed, and a rollback would leave a push
   * describing a write that is not there.
   */
  gatewayBroadcaster: GatewayBroadcaster;
  /**
   * The process's one write coordinator, exposed for the same single reader
   * `gatewayBroadcaster` is: a regression that reads the object off the graph
   * rather than restating the wiring. Nothing publishes or writes through it.
   */
  gate: WriteCoordinator;
  /**
   * The source's unit of work: what `buildApp` gives `PlanCommandRunner` as
   * `writes.uow`. One per process, over the same admitted stores {@link batch}
   * is built from.
   */
  uow: UnitOfWork;
  auth: AuthService;
  /**
   * How a batch's service graph is built: over stores that hold no turn because
   * `UnitOfWork.run` holds it for them (D20), and over the collector its runner
   * hands in (D24). `PlanCommandRunner` is its only caller; a route reaching
   * for it would write inside somebody else's batch and announce into it.
   */
  batch: (broadcast: Broadcaster) => WritingServices;
  history: HistoryService;
  replay: ReplayOrchestrator;
  retention: RetentionTimer;
  optimizer: OptimizationCoordinator | undefined;
}

/**
 * Every transactional store of the SQLite source, built over one gate.
 *
 * Built **twice** in this process and that is the whole point (D20): once over
 * the {@link WriteCoordinator}, which is what a route write goes through and
 * what makes it wait for an open batch's turn, and once over {@link OPEN} for
 * the batch itself, whose services already hold that turn. A batch built over
 * the coordinator would wait for the turn it is holding — a deadlock, not a
 * slow write.
 *
 * The saved-plan stores are **not** here: they open their own connection per
 * call, take no turn, and are independent of any batch (ADR 0015, D12/D27).
 */
export function buildStores(db: Drizzle, gate: Gate) {
  return {
    projects: new ProjectRepository(db, gate),
    users: new UserRepository(db, gate),
    directory: new DirectoryRepository(db, gate),
    capacity: new CapacityRepository(db, gate),
    priorityBands: new PriorityBandRepository(db, gate),
    calendarMarkers: new CalendarMarkerRepository(db, gate),
    eventLog: new DrizzleEventLogStore(db, gate),
    planEvents: new PlanEventRepository(db, gate),
    steps: new StepRepository(db, gate),
    workItems: new WorkItemRepository(db, gate),
    estimates: new EstimateRepository(db, gate),
    // Its own store beside the estimates rather than more methods on that one:
    // the two tables answer different questions, and the day one of them grows
    // a rule the other must not have is the day a shared class becomes a
    // conditional. See `actual` in `schema.ts`.
    actuals: new ActualRepository(db, gate),
    measures: new StepMeasureRepository(db, gate),
    // And its own store again, for the same reason once more: a state is a
    // sentence about work and an actual is a number about it, and the table
    // that holds one must not grow a rule the other has to carry. See
    // `step_progress` in `schema.ts`.
    progress: new StepProgressRepository(db, gate),
    dependencies: new DependencyRepository(db, gate),
    // The one store that writes across all four of the tables above, because
    // a duplicated subtree is one act — see {@link SubtreeRepository}.
    subtrees: new SubtreeRepository(db, gate),
    // The undo stack, on the server so it survives a reload — one per account
    // per project. See `command_journal` in `schema.ts`. It is also what writes
    // the plan's history, in the same transaction, because a journalled command
    // and a recorded one are the same act.
    journal: new CommandJournalRepository(db, gate),
  };
}

/** The transactional stores of one source, over one gate. */
export type Stores = ReturnType<typeof buildStores>;

/** What a service graph needs that is not a store, and is shared across graphs. */
export interface SharedRuntime {
  clock: Clock;
  /**
   * Where a write announces itself. The process's own graph publishes straight
   * through; a batch's graph is given the collector that holds its events until
   * it has committed and released its turn.
   */
  broadcast: Broadcaster;
  optimized: ReturnType<typeof optimizerWiring>;
}

/**
 * The services that write through one set of stores.
 *
 * Called once for the process's own graph and once for the batch's, so that the
 * difference between them is exactly the two arguments: which gate their stores
 * hold, and where their announcements go. Everything shared — the clock, the
 * replay buffer, the throttle, the optimizer wiring — is built by
 * {@link buildServices} and passed in.
 */
export function servicesOver(stores: Stores, shared: SharedRuntime) {
  const { clock, broadcast } = shared;
  return {
    projects: new ProjectService({
      clock,
      projects: stores.projects,
      broadcast,
      optimizerAvailable: shared.optimized.available,
    }),
    capacity: new CapacityService({
      clock,
      projects: stores.projects,
      capacity: stores.capacity,
      broadcast,
    }),
    calendarMarkers: new CalendarMarkerService({
      clock,
      projects: stores.projects,
      markers: stores.calendarMarkers,
      broadcast,
    }),
    priorityBands: new PriorityBandService({
      clock,
      projects: stores.projects,
      bands: stores.priorityBands,
      broadcast,
    }),
    steps: new StepService({ clock, projects: stores.projects, steps: stores.steps, broadcast }),
    directory: new DirectoryService({ clock, directory: stores.directory, broadcast }),
    workItems: new WorkItemService({
      clock,
      workItems: stores.workItems,
      projects: stores.projects,
      estimates: stores.estimates,
      actuals: stores.actuals,
      measures: stores.measures,
      progress: stores.progress,
      dependencies: stores.dependencies,
      directory: stores.directory,
      capacity: stores.capacity,
      // Read by `tree()` alone: the ladder is what every face draws priorities
      // through, and it rides the payload the dates ride so a client cannot
      // hold labels from one moment over numbers from another.
      priorityBands: stores.priorityBands,
      subtrees: stores.subtrees,
      journal: stores.journal,
      broadcast,
      // The other half of the same `optimizerWiring` the settings gate reads,
      // so this process cannot serve optimized plans while refusing to be
      // switched on to them, or the reverse.
      optimized: shared.optimized.read,
    }),
  };
}

/** One graph of the services a write goes through — see {@link servicesOver}. */
export type WritingServices = ReturnType<typeof servicesOver>;

/**
 * Everything be-01 runs, built once and wired together.
 *
 * It is a function rather than the body of `main.ts` so the wiring itself can be
 * asserted. Two of this change's guarantees live only here and nowhere else: the
 * broadcaster and the replay orchestrator must share **one** `ReplayBuffer`, and
 * the retention timer must actually be constructed against the same log the
 * orchestrator reads. Both were previously provable about the classes and not
 * about the process — which is the failure `AGENTS.md` R5 exists to catch, and
 * exactly what a reviewer caught here.
 */
export function buildServices(opts: ServicesOptions): BeServices {
  // One clock for every service that stamps a write and for the broadcaster
  // that dates the events they publish, for the reason there is one
  // broadcaster: the seven services each built their own `stampFor` out of
  // their own `now`, so "an act reads the clock once" (ADR 0012) was seven
  // separate promises about seven separate objects.
  const clock = clockOf();
  // The process's own stores: every write through them waits for its turn at
  // the coordinator, which is what keeps a route write out of an open batch's
  // transaction. The batch's own stores are `admitted` below.
  const stores = buildStores(opts.db, opts.gate);
  // The batch's, over `OPEN`: their caller already holds the turn. See
  // {@link buildStores}.
  const admitted = buildStores(opts.db, OPEN);
  const { projects: projectStore, users: userStore, eventLog } = stores;
  // One store for the route that reads the history and the timer that prunes it.
  const planEventStore = stores.planEvents;

  // One buffer, shared by the two halves of resume: the broadcaster fills it as
  // it publishes, the orchestrator serves reconnects from it. Two buffers would
  // both look healthy and one of them would always be empty.
  const replayBuffer = new ReplayBuffer({
    maxPerSubscription: EVENT_LOG_MAX_PER_SUBSCRIPTION,
    maxAgeMs: REPLAY_BUFFER_MAX_AGE_MS,
  });

  // One broadcaster for every service that changes a project, so a step event
  // and a work item event share the project's sequence. Two would each count
  // from their own zero, and a client resuming from a work item's sequence
  // would be replayed step events it had already seen — or none at all.
  const broadcast = new GatewayBroadcaster({
    eventLog,
    clock,
    buffer: replayBuffer,
    push: new PushClient({
      gwUrl: opts.gwUrl,
      secret: opts.internalAuthSecret,
      fetchImpl: opts.pushFetch,
      timers: systemTimers,
      attemptMs: 5_000,
      overallMs: 15_000,
      maxRetries: 5,
    }),
    // The event is already in the durable log and the mutation already
    // committed, so a client that reconnects still gets it on replay.
    // Failing the request here would tell the caller their edit did not
    // happen when it did.
    onPushFailed: (err, subscription) => {
      opts.logger.warn({ err, subscription }, 'project event recorded but not pushed');
    },
  });

  // Every service publishes through this wrapper, and only `PlanCommandRunner`
  // ever holds it. Wrapping here rather than at the runner is the point: there
  // is exactly one broadcaster object in the process, so a batch cannot hold one
  // while a service publishes through another. See {@link AnnouncementCollector}.
  const optimizerInput: { workItems: WorkItemService | undefined } = { workItems: undefined };
  const coordinator =
    opts.optimizer === undefined
      ? undefined
      : new OptimizationCoordinator({
          db: opts.db,
          contractVersion: contractVersionOf(opts.optimizer.solverVersion),
          solverVersion: opts.optimizer.solverVersion,
          budgetMs: opts.optimizer.budgetMs,
          ownerId: crypto.randomUUID(),
          now: Date.now,
          attemptToken: () => crypto.randomUUID(),
          inputOf: async (projectId) => {
            if (optimizerInput.workItems === undefined) {
              throw new Error('optimizer input reader used before service composition completed');
            }
            return await optimizerInput.workItems.scheduleInput(projectId);
          },
          enabledOf: async (projectId) =>
            (await projectStore.findById(projectId))?.optimizationEnabled === true,
          spawn: opts.optimizer.spawn,
          eventLog,
          pushRecorded: (subscription, recorded, event) =>
            broadcast.pushRecorded(subscription, recorded, event),
          onChildError: (err) => {
            opts.logger.error({ err }, 'optimizer child failed');
          },
        });
  const optimizerEvents = new OptimizerTriggerBroadcaster(broadcast, (projectId) => {
    coordinator?.inputChanged(projectId);
  });
  // No wrapper: a batch's announcements belong to the batch, and its own
  // collector holds them (D24). This is the direct path every route publishes
  // through and the one a committed batch drains into.
  const announcements: Broadcaster = optimizerEvents;
  // Both service-facing halves derive from the same coordinator instance: a
  // process cannot accept the ON setting unless its plan reader can also admit
  // and consume optimized rows.
  const optimizer = optimizerWiring(coordinator?.readPlan);

  const services: BeServices = {
    announcements,
    gatewayBroadcaster: broadcast,
    // The process's one coordinator, for **one** reader: `boot.db.test.ts` has
    // to take a turn off the object the stores were built with, or it restates
    // the wiring instead of observing it. Nothing writes through this.
    gate: opts.gate,
    optimizer: coordinator,
    auth: new AuthService({
      clock,
      users: userStore,
      identities: userStore,
      // The runtime this process happens to be, handed over at the root rather
      // than reached for in the service (D10).
      tokens: joseTokenCodec(opts.jwtKey),
      passwords: bunPasswordHasher,
      oidc: opts.oidc,
      passwordSessions: opts.passwordSessions,
      localIdentity: opts.localIdentity,
    }),
    // Every writing service in one call, over the stores that take a turn and
    // the broadcaster that publishes straight out. A route's event leaves as
    // soon as its write has committed, whoever else is mid-batch.
    ...servicesOver(stores, { clock, broadcast: announcements, optimized: optimizer }),
    // How the batch's graph is built: over the admitted stores, because its
    // writes are already the batch's and nothing in it waits for the turn
    // `UnitOfWork` holds; and over whichever collector the runner hands in, so
    // one batch's announcements are never another's (D24).
    batch: (broadcast: Broadcaster) =>
      servicesOver(admitted, { clock, broadcast, optimized: optimizer }),
    // Built here because this is where the admitted stores are: the unit of
    // work hands its act the same objects the batch's services write through,
    // and a second set would be a scope nothing in the graph is holding.
    uow: sqliteUnitOfWork(opts.db, opts.gate, admitted),
    history: new HistoryService({ projects: projectStore, events: planEventStore }),
    replay: new ReplayOrchestrator({ log: eventLog, buffer: replayBuffer }),
    retention: new RetentionTimer({
      repo: eventLog,
      maxPerSubscription: EVENT_LOG_MAX_PER_SUBSCRIPTION,
      // The same store the history route reads, so the table pruned is the table
      // served. Two stores would both look healthy and one of them would be
      // pruning a file nobody reads.
      planEvents: planEventStore,
      planEventRetentionDays: PLAN_EVENT_RETENTION_DAYS,
      intervalMs: RETENTION_INTERVAL_MS,
      // This process's own timers, handed over rather than reached for (D10).
      ...systemInterval,
      onSweep: (removed) => {
        if (removed.eventLog > 0) {
          opts.logger.info({ removed: removed.eventLog }, 'event log pruned');
        }
        // Logged even though the log line above is conditional on the same
        // shape: history rows go a year after they were written, so a sweep that
        // removes any is worth one line somebody can correlate with a gap.
        if (removed.planEvents > 0) {
          opts.logger.info({ removed: removed.planEvents }, 'plan history pruned');
        }
      },
      // Reported, not swallowed: the log growing without bound is the failure
      // the timer exists to prevent, and a dead sweep looks healthy from outside.
      onError: (err) => {
        opts.logger.error({ err }, 'retention sweep failed');
      },
    }),
  };
  optimizerInput.workItems = services.workItems;
  return services;
}
