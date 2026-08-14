import type { Logger } from '@wbs/observability';

import { CapacityRepository } from './repository/capacity';
import { CommandJournalRepository } from './repository/command-journal';
import type { Drizzle } from './repository/db';
import { DependencyRepository } from './repository/dependency';
import { DirectoryRepository } from './repository/directory';
import { EstimateRepository } from './repository/estimate';
import { DrizzleEventLogRepo } from './repository/event-log';
import { PriorityBandRepository } from './repository/priority-band';
import { ProjectRepository } from './repository/project';
import { RoleRepository } from './repository/role';
import { UserRepository } from './repository/user';
import { SubtreeRepository, WorkItemRepository } from './repository/work-item';
import { AuthService } from './service/auth.service';
import { CapacityService } from './service/capacity.service';
import { DirectoryService } from './service/directory.service';
import { EventSequencer } from './service/event-sequencer';
import { GatewayBroadcaster } from './service/gateway-broadcaster';
import { PriorityBandService } from './service/priority-band.service';
import { ProjectService } from './service/project.service';
import { PushClient } from './service/push-client';
import { ReplayBuffer } from './service/replay-buffer';
import { ReplayOrchestrator } from './service/replay-orchestrator';
import { RetentionTimer } from './service/retention-timer';
import { RoleService } from './service/role.service';
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
const RETENTION_INTERVAL_MS = 10 * 60_000;
const REPLAY_BUFFER_MAX_AGE_MS = 5 * 60_000;

export interface ServicesOptions {
  db: Drizzle;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
}

export interface BeServices {
  auth: AuthService;
  projects: ProjectService;
  capacity: CapacityService;
  priorityBands: PriorityBandService;
  roles: RoleService;
  directory: DirectoryService;
  workItems: WorkItemService;
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
  const projectStore = new ProjectRepository(opts.db);
  const directoryStore = new DirectoryRepository(opts.db);
  const capacityStore = new CapacityRepository(opts.db);
  const priorityBandStore = new PriorityBandRepository(opts.db);
  const eventLog = new DrizzleEventLogRepo(opts.db);

  // One buffer, shared by the two halves of resume: the broadcaster fills it as
  // it publishes, the orchestrator serves reconnects from it. Two buffers would
  // both look healthy and one of them would always be empty.
  const replayBuffer = new ReplayBuffer({
    maxPerSubscription: EVENT_LOG_MAX_PER_SUBSCRIPTION,
    maxAgeMs: REPLAY_BUFFER_MAX_AGE_MS,
  });

  // One broadcaster for every service that changes a project, so a role event
  // and a work item event share the project's sequence. Two would each count
  // from their own zero, and a client resuming from a work item's sequence
  // would be replayed role events it had already seen — or none at all.
  const broadcast = new GatewayBroadcaster({
    sequencer: new EventSequencer(eventLog),
    buffer: replayBuffer,
    push: new PushClient({ gwUrl: opts.gwUrl, secret: opts.internalAuthSecret }),
    // The event is already in the durable log and the mutation already
    // committed, so a client that reconnects still gets it on replay.
    // Failing the request here would tell the caller their edit did not
    // happen when it did.
    onPushFailed: (err, subscription) => {
      opts.logger.warn({ err, subscription }, 'project event recorded but not pushed');
    },
  });

  return {
    auth: new AuthService({
      users: new UserRepository(opts.db),
      jwtKey: opts.jwtKey,
    }),
    projects: new ProjectService({ projects: projectStore }),
    // The same broadcaster again: a capacity event takes its place in the
    // project's one sequence, so a client resuming from a work item's sequence is
    // not replayed a capacity change it has seen — or handed none it has not.
    capacity: new CapacityService({
      projects: projectStore,
      capacity: capacityStore,
      broadcast,
    }),
    // The same broadcaster again, for the capacity service's reason: a ladder
    // event takes its place in the project's one sequence, so a client resuming
    // from a work item's sequence is not replayed a rename of a rung it has seen.
    priorityBands: new PriorityBandService({
      projects: projectStore,
      bands: priorityBandStore,
      broadcast,
    }),
    roles: new RoleService({
      projects: projectStore,
      roles: new RoleRepository(opts.db),
      broadcast,
    }),
    // The same broadcaster the roles and the work items use, so a directory
    // event takes its place in the project's one sequence — a client resuming
    // from a work item's sequence must not be replayed a rename it has seen,
    // or miss one it has not.
    directory: new DirectoryService({ directory: directoryStore, broadcast }),
    workItems: new WorkItemService({
      workItems: new WorkItemRepository(opts.db),
      projects: projectStore,
      estimates: new EstimateRepository(opts.db),
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
      // account per project. See `command_journal` in `schema.ts`.
      journal: new CommandJournalRepository(opts.db),
      broadcast,
    }),
    replay: new ReplayOrchestrator({ log: eventLog, buffer: replayBuffer }),
    retention: new RetentionTimer({
      repo: eventLog,
      maxPerSubscription: EVENT_LOG_MAX_PER_SUBSCRIPTION,
      intervalMs: RETENTION_INTERVAL_MS,
      onSweep: (removed) => {
        if (removed > 0) opts.logger.info({ removed }, 'event log pruned');
      },
      // Reported, not swallowed: the log growing without bound is the failure
      // the timer exists to prevent, and a dead sweep looks healthy from outside.
      onError: (err) => {
        opts.logger.error({ err }, 'event log retention sweep failed');
      },
    }),
  };
}
