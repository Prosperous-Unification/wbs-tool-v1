import {
  type AccountfulServices,
  type Broadcaster,
  type Clock,
  clockOf,
  composeServices,
  type OidcVerifier,
  type PlanTransactionalStores,
  servicesOver as coreServicesOver,
} from '@wbs/core';
import { contractVersionOf } from '@wbs/domain';
import type { Logger } from '@wbs/observability';
import { type FetchLike, PushClient, systemTimers } from '@wbs/runtime-portable';
import {
  capturedOptimizationReaderOf,
  DrizzleEventLogStore,
  type SqliteSource,
} from '@wbs/store-sqlite';

import { PLAN_EVENT_RETENTION_DAYS } from './repository';
import {
  bunPasswordHasher,
  joseTokenCodec,
  nodeDigest,
  systemInterval,
} from './runtime/bun-runtime';
import type { AuthenticatedUser } from './service/auth.service';
import { OptimizationCoordinator, type ReservedSpawner } from './service/optimization-coordinator';
import { optimizerWiring } from './service/optimizer-wiring';

const EVENT_LOG_MAX_PER_SUBSCRIPTION = 1_000;
const RETENTION_INTERVAL_MS = 10 * 60_000;
const REPLAY_BUFFER_MAX_AGE_MS = 5 * 60_000;

export interface OptimizerRuntime {
  solverVersion: string;
  budgetMs: number;
  spawn: ReservedSpawner;
}

export interface ServicesOptions {
  source: SqliteSource;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
  pushFetch: FetchLike;
  oidc?: OidcVerifier;
  passwordSessions?: boolean;
  localIdentity?: AuthenticatedUser;
  optimizer?: OptimizerRuntime;
}

export interface BeServices extends AccountfulServices {
  readonly optimizer: OptimizationCoordinator | undefined;
  readonly gate: SqliteSource['gate'];
}

export type { WritingServices } from '@wbs/core';
export { buildStores } from '@wbs/store-sqlite/build-stores';

/** Compatibility shape for adapter tests while composition belongs to core. */
export interface SharedRuntime {
  readonly clock: Clock;
  readonly broadcast: Broadcaster;
  readonly optimized: ReturnType<typeof optimizerWiring>;
}

/** Compatibility entrypoint over core's pure transactional half. */
export function servicesOver(stores: PlanTransactionalStores, shared: SharedRuntime) {
  return coreServicesOver(stores, {
    clock: shared.clock,
    broadcast: shared.broadcast,
    scheduler: shared.optimized.scheduler,
  });
}

/** Adds be-01's optimizer process adapter around core's single service composition. */
export function buildServices(options: ServicesOptions): BeServices {
  const { source } = options;
  const clock = clockOf({ now: () => Date.now(), newId: () => crypto.randomUUID() });
  let coordinator: OptimizationCoordinator | undefined;
  const optimized =
    options.optimizer === undefined
      ? undefined
      : {
          readLive: (ask: Parameters<OptimizationCoordinator['readPlan']>[0]) => {
            if (coordinator === undefined) {
              throw new Error('optimizer read before service composition completed');
            }
            return coordinator.readPlan(ask);
          },
          readCaptured: capturedOptimizationReaderOf(source.db, {
            contractVersion: contractVersionOf(options.optimizer.solverVersion),
            budgetMs: options.optimizer.budgetMs,
            now: Date.now,
          }),
        };
  const scheduler = optimizerWiring(optimized).scheduler;
  const graph = composeServices({
    source,
    runtime: {
      clock,
      digest: nodeDigest,
      timers: systemTimers,
      intervals: systemInterval,
      push: new PushClient({
        gwUrl: options.gwUrl,
        secret: options.internalAuthSecret,
        fetchImpl: options.pushFetch,
        timers: systemTimers,
        attemptMs: 5_000,
        overallMs: 15_000,
        maxRetries: 5,
      }),
      scheduler,
      onPlanChanged: (projectId) => coordinator?.inputChanged(projectId),
      passwords: bunPasswordHasher,
      tokens: joseTokenCodec(options.jwtKey),
      ...(options.oidc === undefined ? {} : { oidc: options.oidc }),
      ...(options.passwordSessions === undefined
        ? {}
        : { passwordSessions: options.passwordSessions }),
      ...(options.localIdentity === undefined ? {} : { localIdentity: options.localIdentity }),
    },
    shared: {
      logger: options.logger,
      replayMaxPerSubscription: EVENT_LOG_MAX_PER_SUBSCRIPTION,
      replayMaxAgeMs: REPLAY_BUFFER_MAX_AGE_MS,
      retentionIntervalMs: RETENTION_INTERVAL_MS,
      planEventRetentionDays: PLAN_EVENT_RETENTION_DAYS,
    },
  });
  if (options.optimizer !== undefined) {
    const optimizer = options.optimizer;
    coordinator = new OptimizationCoordinator({
      db: source.db,
      contractVersion: contractVersionOf(optimizer.solverVersion),
      solverVersion: optimizer.solverVersion,
      budgetMs: optimizer.budgetMs,
      ownerId: crypto.randomUUID(),
      now: Date.now,
      attemptToken: () => crypto.randomUUID(),
      inputOf: async (projectId) => await graph.workItems.scheduleInput(projectId),
      enabledOf: async (projectId) =>
        (await source.stores.projects.findById(projectId))?.optimizationEnabled === true,
      spawn: optimizer.spawn,
      eventLog: new DrizzleEventLogStore(source.db, source.gate),
      pushRecorded: (subscription, recorded, event) =>
        graph.gatewayBroadcaster.pushRecorded(subscription, recorded, event),
      onChildError: (error) => {
        options.logger.error({ err: error }, 'optimizer child failed');
      },
    });
  }

  return { ...graph, optimizer: coordinator, gate: source.gate };
}
