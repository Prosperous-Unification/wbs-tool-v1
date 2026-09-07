import { createLogger, type Logger, type MetricsScrape, scrapeMetrics } from '@wbs/observability';
import { Elysia } from 'elysia';

import { authOidcEndpoints } from './controller/auth-oidc-endpoints';
import { authPasswordEndpoints } from './controller/auth-password-endpoints';
import { calendarMarkerRoutes } from './controller/calendar-marker.routes';
import { directoryRoutes } from './controller/directory.routes';
import { historyRoutes } from './controller/history.routes';
import { infrastructureEndpoints } from './controller/infrastructure-endpoints';
import { internalRoutes } from './controller/internal.routes';
import type { OidcRouteOptions } from './controller/oidc-options';
import { projectRoutes } from './controller/project.routes';
import { savedPlanRoutes } from './controller/saved-plan.routes';
import { smokeRoutes } from './controller/smoke.routes';
import { solutionRoutes } from './controller/solution.routes';
import { stepRoutes } from './controller/step.routes';
import { workItemRoutes } from './controller/work-item.routes';
import { mountEndpoints } from './http/elysia/mount';
import type { BoundEndpoint } from './http/endpoint';
import { identityResolver } from './http/identity';
import { openApiPlugin } from './openapi/openapi-plugin';
import type { WriteCoordinator } from './repository/gate';
import type { DatabaseHealth } from './repository/health-probe';
import type { AuthService } from './service/auth.service';
import type { DeferringBroadcaster } from './service/broadcast';
import type { CalendarMarkerService } from './service/calendar-marker.service';
import type { CapacityService } from './service/capacity.service';
import type { DirectoryService } from './service/directory.service';
import type { HistoryService } from './service/history.service';
import { LoginThrottle } from './service/login-throttle';
import type { OptimizationCoordinator } from './service/optimization-coordinator';
import type { OuterTransaction } from './service/outer-transaction';
import { PlanCommandRunner } from './service/plan-commands';
import type { PriorityBandService } from './service/priority-band.service';
import type { ProjectService } from './service/project.service';
import type { ReplayOrchestrator } from './service/replay-orchestrator';
import type { SavedPlanService } from './service/saved-plan.service';
import type { StepService } from './service/step.service';
import type { WorkItemService } from './service/work-item.service';
import type { WritingServices } from './services';

export interface AppOptions {
  /** Trusted browser origin, resolved from operator configuration before boot. */
  appOrigin: string;
  migrationsApplied: boolean;
  /**
   * Required rather than optional. An optional auth service would let a
   * misconfigured process start with the registration and login routes simply
   * absent, answering 404 — indistinguishable from a routing fault at the edge.
   */
  auth: AuthService;
  /** Per-process active password logins; defaults to eight and must be a positive integer. */
  maxConcurrentLogins?: number;
  oidc?: OidcRouteOptions;
  /**
   * Required for the same reason as `auth`: an absent project service would
   * answer 404 on every project route, which reads as an edge misconfiguration
   * rather than a process built without its domain.
   */
  projects: ProjectService;
  /** Required for the same reason as `projects`. */
  workItems: WorkItemService;
  /** The manual Retry admission seam; absent only in optimizer-less deployments and tests. */
  optimizer?: Pick<OptimizationCoordinator, 'retry'>;
  /**
   * Required for the same reason as `projects`. A process built without it
   * would answer 404 on every saved-plan route, which a client reads as "this
   * project has no saved plans" rather than as a be-01 that cannot store one.
   * Task 6.4 is where absence acquires a *typed* answer; until then it is not
   * an absence this process is allowed to have.
   */
  savedPlans: SavedPlanService;
  /**
   * Required for the same reason as `projects`, and for one more: a process
   * built without it would answer 404 on every step route, which is exactly
   * what a client asking a be-01 from before steps could be written sees.
   */
  steps: StepService;
  directory: DirectoryService;
  /**
   * Required for the same reason as `projects`: a process built without it would
   * answer 404 on the capacity route, and a plan whose capacity box silently did
   * nothing reads as a plan whose numbers do not matter.
   */
  capacity: CapacityService;
  /**
   * Required for the same reason as `capacity`: a process built without it would
   * answer 404 on the ladder route, and a Priorities dialog whose Save silently
   * did nothing reads as a plan whose configuration does not matter.
   */
  priorityBands: PriorityBandService;
  /**
   * Required for the same reason as `priorityBands`: a process built without it
   * would answer 404 on the history route, which a client cannot tell from a
   * plan whose history is empty — and "empty" is the answer for every plan the
   * day the table ships, so the mistake would be invisible for a week.
   */
  history: HistoryService;
  /**
   * Required for the same reason as `history`, and for its exact failure mode: a
   * process built without it answers 404 on every marker route, which a client
   * cannot tell from a project that has no markers — and "none" is the answer
   * for every project the day the table ships, so the mistake would be
   * invisible for a week.
   */
  calendarMarkers: CalendarMarkerService;
  /**
   * Shared secret gw-01 presents on /internal/*. Required — a default here
   * would silently diverge from the value gw-01 loads from the environment,
   * failing every forward with a 401 that only shows up in a real deployment.
   */
  internalAuthSecret: string;
  /**
   * Required for the same reason as `auth`, and for one more: the stub this
   * replaced answered every resume with `replaying, count: 0`, which no client
   * could distinguish from "you missed nothing". An optional service would let
   * that answer come back by accident.
   */
  replay: ReplayOrchestrator;
  /**
   * Asks the database whether it is the one this process was built for.
   *
   * Required, and it runs on every `/health` call rather than once at startup.
   * The endpoint used to answer from a boolean set before any query had been
   * made, so a container pointed at the wrong `DB_PATH` passed the deploy's
   * health gate and took traffic it could not serve. A health check that cannot
   * fail is the failure `AGENTS.md` R5 is about.
   */
  probeDatabase: () => DatabaseHealth;
  /**
   * What a command batch runs inside: the outer transaction on the one
   * connection, the write coordinator it takes one turn at, and the batch's own
   * service graph — `drizzleOuterTransaction(db)` and a `WriteCoordinator` in
   * production, the counting fixture on in-memory stores. See
   * `service/plan-commands.ts`, ADR 0007 and ADR 0015.
   */
  writes: {
    transactions: OuterTransaction;
    /** The process's one write coordinator — see {@link ServicesOptions.gate}. */
    gate: WriteCoordinator;
    /**
     * The services a batch writes through, built over stores that hold no turn
     * because the batch holds it for them (D20). These are **not** the services
     * beside them in these options: those take a turn per write, which is what
     * keeps a route write out of an open batch.
     */
    batch: WritingServices;
    /**
     * The broadcaster the directory, capacity and priority-band services were
     * built with, so a batch can hold their announcements until it has committed
     * and let go of the lock. It has to be the *same* object those services
     * publish through — a second one would hold nothing.
     */
    announcements: DeferringBroadcaster;
  };
  /**
   * The commit the checkout on disk is at, read fresh on every `/health` call.
   *
   * Optional, and this is the one place an absent value does not lie: `null`
   * means "this deployment cannot tell you which commit it is at", which is the
   * true answer for a prod image with no `.git` and for a test that never
   * wired it. `boot.ts` passes the real reader, and `boot.test.ts` fails if it
   * stops doing so, so the default cannot quietly become production's answer.
   *
   * A function rather than a string because dev's deploy is a `git reset` under
   * running watchers: a docs-only commit moves the checkout and restarts
   * nothing, so a value captured at startup would report the previous deploy
   * for as long as the process happened to live.
   */
  deployedCommit?: () => string | null;
  /** Overrides the process collector in tests while retaining the real shape boundary. */
  metricsScrape?: () => Promise<MetricsScrape>;
  version?: string;
}

interface InfrastructureRuntime {
  logger: Logger;
  scrapeMetrics: () => Promise<MetricsScrape>;
}

/** Typed bindings mounted by the production app. */
export function mountedEndpoints(
  opts: AppOptions,
  runtime: InfrastructureRuntime = {
    logger: createLogger({ service: 'be-01', version: opts.version }),
    scrapeMetrics: opts.metricsScrape ?? (() => scrapeMetrics('be-01')),
  },
) {
  const passwordThrottle = new LoginThrottle({
    now: opts.oidc?.now,
    maxConcurrent: opts.maxConcurrentLogins ?? 8,
  });
  const commands = new PlanCommandRunner({
    workItems: opts.writes.batch.workItems,
    directory: opts.writes.batch.directory,
    capacity: opts.writes.batch.capacity,
    priorityBands: opts.writes.batch.priorityBands,
    transactions: opts.writes.transactions,
    gate: opts.writes.gate,
    announcements: opts.writes.announcements,
  });
  return [
    // Proof: omitting health and metrics separately made app.routes.test.ts
    // expect 40 local bindings and receive 39 for each injected fault.
    ...infrastructureEndpoints({
      // Readiness changes after the endpoint table is built. Capturing this
      // boolean here left production `/health` at 503 after boot had completed;
      // boot.db.test.ts observed `Expected: 200, Received: 503` on five paths.
      get migrationsApplied() {
        return opts.migrationsApplied;
      },
      probeDatabase: opts.probeDatabase,
      deployedCommit: opts.deployedCommit,
      logger: runtime.logger,
      scrapeMetrics: runtime.scrapeMetrics,
    }),
    ...authPasswordEndpoints(opts.auth, opts.oidc, passwordThrottle),
    // Proof: removing this spread made app.routes.test.ts receive 40 bindings
    // instead of the 44 required by the OIDC composition.
    ...(opts.oidc === undefined ? [] : authOidcEndpoints(opts.auth, opts.oidc)),
    // Proof: omitting this binding made “binds each shared HTTP shape once”
    // receive39 instead of40 in app.routes.test.ts.
    ...smokeRoutes(),
    ...stepRoutes(opts.steps),
    ...directoryRoutes(opts.directory),
    ...historyRoutes(opts.history),
    ...solutionRoutes(opts.projects),
    ...projectRoutes(opts.projects, opts.workItems, opts.optimizer),
    ...workItemRoutes(opts.workItems, commands),
    ...calendarMarkerRoutes(opts.calendarMarkers),
    ...savedPlanRoutes(opts.savedPlans, opts.projects, opts.writes.announcements),
    ...internalRoutes({
      // A deliberate pure ack: every mutation is an HTTP call to be-01, so a
      // client socket message has no write authority.
      onForward: () => Promise.resolve({ push_responses: [] }),
      onResume: (points) => opts.replay.replay(points),
    }),
  ] as const;
}

export function buildApp(opts: AppOptions) {
  const logger = createLogger({ service: 'be-01', version: opts.version });
  // The OIDC callback binding reports provider refusals, and it names no
  // framework, so it cannot reach the decorated `logger` above and is handed
  // it here instead of at every call site that builds `OidcRouteOptions`
  // (TASK-273). A caller that supplied its own wins — that is how a test
  // asserts on what a refused login writes down without a pino destination.
  const routedOptions: AppOptions =
    opts.oidc === undefined ? opts : { ...opts, oidc: { logger, ...opts.oidc } };
  const endpoints: readonly BoundEndpoint[] = mountedEndpoints(routedOptions, {
    logger,
    scrapeMetrics: opts.metricsScrape ?? (() => scrapeMetrics('be-01')),
  });

  return (
    new Elysia()
      .decorate('logger', logger)
      // The document comes from this configuration's mounted endpoint table, so
      // local auth does not advertise the four conditional OIDC operations.
      .use(openApiPlugin(endpoints.map(({ shape }) => shape)))
      .use(
        // Proof: mounting an empty table made “reaches every local path and method”
        // report postApiAuthRegister equal to the 404/NOT_FOUND router miss.
        mountEndpoints(endpoints, {
          appOrigin: opts.appOrigin,
          resolveIdentity: identityResolver(opts.auth, opts.internalAuthSecret),
        }),
      )
  );
}
