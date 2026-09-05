import type { Logger } from '@wbs/observability';

import { PLAN_EVENT_RETENTION_DAYS } from './repository';
import { ActualRepository } from './repository/actual';
import { CalendarMarkerRepository } from './repository/calendar-marker';
import { CapacityRepository } from './repository/capacity';
import { CommandJournalRepository } from './repository/command-journal';
import type { Drizzle } from './repository/db';
import { DependencyRepository } from './repository/dependency';
import { DirectoryRepository } from './repository/directory';
import { EstimateRepository } from './repository/estimate';
import { DrizzleEventLogRepo } from './repository/event-log';
import { PlanEventRepository } from './repository/plan-event';
import { PriorityBandRepository } from './repository/priority-band';
import { ProjectRepository } from './repository/project';
import { StepRepository } from './repository/step';
import { StepMeasureRepository } from './repository/step-measure';
import { StepProgressRepository } from './repository/step-progress';
import { UserRepository } from './repository/user';
import { SubtreeRepository, WorkItemRepository } from './repository/work-item';
import { AuthService, type AuthServiceOptions } from './service/auth.service';
import { DeferringBroadcaster } from './service/broadcast';
import { CalendarMarkerService } from './service/calendar-marker.service';
import { CapacityService } from './service/capacity.service';
import { clockOf } from './service/clock';
import { DirectoryService } from './service/directory.service';
import { GatewayBroadcaster } from './service/gateway-broadcaster';
import { HistoryService } from './service/history.service';
import { optimizerWiring } from './service/optimizer-wiring';
import { PriorityBandService } from './service/priority-band.service';
import { ProjectService } from './service/project.service';
import { PushClient } from './service/push-client';
import { ReplayBuffer } from './service/replay-buffer';
import { ReplayOrchestrator } from './service/replay-orchestrator';
import { RetentionTimer } from './service/retention-timer';
import { StepService } from './service/step.service';
import { WorkItemService } from './service/work-item.service';
import type { WriteLock } from './service/write-lock';

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

export interface ServicesOptions {
  db: Drizzle;
  /**
   * The process's one write lock, which `boot.ts` must hand to **both** this
   * factory and `buildApp`'s `writes.lock`.
   *
   * The broadcaster built here records each event under it so the row can never
   * land inside a command batch's outer transaction on `db`; the runner opens
   * that transaction under the same lock. Two locks would each look healthy and
   * exclude nothing — the same failure mode the one-broadcaster and one-buffer
   * comments below describe.
   */
  lock: WriteLock;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
  oidc?: AuthServiceOptions['oidc'];
  passwordSessions?: boolean;
  localIdentity?: AuthServiceOptions['localIdentity'];
}

export interface BeServices {
  /**
   * The one broadcaster every service publishes through, wrapped so a command
   * batch can hold its announcements until it has committed and released the
   * write lock. `boot.ts` hands it to `buildApp` as `writes.announcements`; it
   * must be this object and not a second wrapper.
   */
  announcements: DeferringBroadcaster;
  /**
   * The broadcaster {@link announcements} wraps, for **one** reader: the
   * one-lock regression in `boot.db.test.ts` has to read the lock off the object
   * that records under it, or it restates the wiring instead of observing it.
   *
   * Nothing publishes through this. It replaced `DeferringBroadcaster.undeferred`
   * (TASK-256), which was reachable from every service that held the wrapper —
   * this is reachable only from the composition root. A publisher wired here
   * would announce before its batch committed, and a rollback would leave a push
   * describing a write that is not there.
   */
  gatewayBroadcaster: GatewayBroadcaster;
  auth: AuthService;
  projects: ProjectService;
  calendarMarkers: CalendarMarkerService;
  capacity: CapacityService;
  priorityBands: PriorityBandService;
  steps: StepService;
  directory: DirectoryService;
  workItems: WorkItemService;
  history: HistoryService;
  replay: ReplayOrchestrator;
  retention: RetentionTimer;
}

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
  const projectStore = new ProjectRepository(opts.db);
  const userStore = new UserRepository(opts.db);
  const directoryStore = new DirectoryRepository(opts.db);
  const capacityStore = new CapacityRepository(opts.db);
  const priorityBandStore = new PriorityBandRepository(opts.db);
  const calendarMarkerStore = new CalendarMarkerRepository(opts.db);
  const eventLog = new DrizzleEventLogRepo(opts.db);
  // One store for the route that reads the history and the timer that prunes it.
  const planEventStore = new PlanEventRepository(opts.db);

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
    // `eventLog` is on `opts.db`, which is the connection a batch holds its
    // outer transaction open on, so the durable record has to wait for that
    // transaction to close. See `GatewayBroadcasterOptions.lock`.
    lock: opts.lock,
    push: new PushClient({ gwUrl: opts.gwUrl, secret: opts.internalAuthSecret }),
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
  // while a service publishes through another. See {@link DeferringBroadcaster}.
  const announcements = new DeferringBroadcaster(broadcast);

  // **The optimizer is not deployed yet, and this is the one line that says so.**
  // TASK-219 lands the solver core and the Fast-parity refactor; TASK-220 is
  // what wires a real `OptimizedScheduleReader` in here, behind its migrations.
  // Until then `read` is `undefined`, `available()` is `false`, and the settings
  // PATCH refuses to switch a project on to something no plan read could serve —
  // see {@link optimizerWiring} for why these are one argument and not two.
  const optimizer = optimizerWiring(undefined);

  return {
    announcements,
    gatewayBroadcaster: broadcast,
    auth: new AuthService({
      clock,
      users: userStore,
      identities: userStore,
      jwtKey: opts.jwtKey,
      oidc: opts.oidc,
      passwordSessions: opts.passwordSessions,
      localIdentity: opts.localIdentity,
    }),
    // The same broadcaster once more, so `project_settings_changed` takes its
    // place in the project's one sequence beside the step, capacity and tree
    // events (tasks.md 3b.3).
    projects: new ProjectService({
      clock,
      projects: projectStore,
      broadcast: announcements,
      optimizerAvailable: optimizer.available,
    }),
    // The same broadcaster again: a capacity event takes its place in the
    // project's one sequence, so a client resuming from a work item's sequence is
    // not replayed a capacity change it has seen — or handed none it has not.
    capacity: new CapacityService({
      clock,
      projects: projectStore,
      capacity: capacityStore,
      broadcast: announcements,
    }),
    // No broadcaster yet, and that is this slice rather than an omission: task
    // 4.1 is the routes, and slice 9 is where a marker write announces itself.
    // A service handed one it never publishes through would read as a route
    // that already fans out.
    calendarMarkers: new CalendarMarkerService({
      clock,
      projects: projectStore,
      markers: calendarMarkerStore,
    }),
    // The same broadcaster again, for the capacity service's reason: a ladder
    // event takes its place in the project's one sequence, so a client resuming
    // from a work item's sequence is not replayed a rename of a rung it has seen.
    priorityBands: new PriorityBandService({
      clock,
      projects: projectStore,
      bands: priorityBandStore,
      broadcast: announcements,
    }),
    steps: new StepService({
      clock,
      projects: projectStore,
      steps: new StepRepository(opts.db),
      broadcast: announcements,
    }),
    // The same broadcaster the steps and the work items use, so a directory
    // event takes its place in the project's one sequence — a client resuming
    // from a work item's sequence must not be replayed a rename it has seen,
    // or miss one it has not.
    directory: new DirectoryService({ clock, directory: directoryStore, broadcast: announcements }),
    workItems: new WorkItemService({
      clock,
      workItems: new WorkItemRepository(opts.db),
      projects: projectStore,
      estimates: new EstimateRepository(opts.db),
      // Its own store beside the estimates rather than more methods on that one:
      // the two tables answer different questions, and the day one of them grows
      // a rule the other must not have is the day a shared class becomes a
      // conditional. See `actual` in `schema.ts`.
      actuals: new ActualRepository(opts.db),
      measures: new StepMeasureRepository(opts.db),
      // And its own store again, for the same reason once more: a state is a
      // sentence about work and an actual is a number about it, and the table
      // that holds one must not grow a rule the other has to carry. See
      // `step_progress` in `schema.ts`.
      progress: new StepProgressRepository(opts.db),
      dependencies: new DependencyRepository(opts.db),
      directory: directoryStore,
      capacity: capacityStore,
      // Read by `tree()` alone: the ladder is what every face draws priorities
      // through, and it rides the payload the dates ride so a client cannot hold
      // labels from one moment over numbers from another.
      priorityBands: priorityBandStore,
      // The one store that writes across all four of the tables above, because
      // a duplicated subtree is one act — see {@link SubtreeRepository}.
      subtrees: new SubtreeRepository(opts.db),
      // The undo stack, on the server so it survives a reload — one per
      // account per project. See `command_journal` in `schema.ts`. It is also
      // what writes the plan's history, in the same transaction, because a
      // journalled command and a recorded one are the same act.
      journal: new CommandJournalRepository(opts.db),
      broadcast: announcements,
      // The other half of the same `optimizerWiring` the settings gate reads,
      // so this process cannot serve optimized plans while refusing to be
      // switched on to them, or the reverse.
      optimized: optimizer.read,
    }),
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
}
