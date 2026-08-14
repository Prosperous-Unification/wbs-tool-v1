import { createLogger } from '@wbs/observability';
import { observabilityPlugin } from '@wbs/observability/server';
import { Elysia } from 'elysia';

import { authController } from './controller/auth.controller';
import { capacityController } from './controller/capacity.controller';
import { directoryController } from './controller/directory.controller';
import { internalController } from './controller/internal.controller';
import { priorityBandController } from './controller/priority-band.controller';
import { projectController } from './controller/project.controller';
import { roleController } from './controller/role.controller';
import { smokeController } from './controller/smoke.controller';
import { workItemController } from './controller/work-item.controller';
import type { DatabaseHealth } from './repository/health-probe';
import type { AuthService } from './service/auth.service';
import type { CapacityService } from './service/capacity.service';
import type { DirectoryService } from './service/directory.service';
import type { PriorityBandService } from './service/priority-band.service';
import type { ProjectService } from './service/project.service';
import type { ReplayOrchestrator } from './service/replay-orchestrator';
import type { RoleService } from './service/role.service';
import type { WorkItemService } from './service/work-item.service';

export interface AppOptions {
  migrationsApplied: boolean;
  /**
   * Required rather than optional. An optional auth service would let a
   * misconfigured process start with the registration and login routes simply
   * absent, answering 404 — indistinguishable from a routing fault at the edge.
   */
  auth: AuthService;
  /**
   * Required for the same reason as `auth`: an absent project service would
   * answer 404 on every project route, which reads as an edge misconfiguration
   * rather than a process built without its domain.
   */
  projects: ProjectService;
  /** Required for the same reason as `projects`. */
  workItems: WorkItemService;
  /**
   * Required for the same reason as `projects`, and for one more: a process
   * built without it would answer 404 on every role route, which is exactly
   * what a client asking a be-01 from before roles could be written sees.
   */
  roles: RoleService;
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
  version?: string;
}

export function buildApp(opts: AppOptions) {
  const logger = createLogger({ service: 'be-01', version: opts.version });

  return (
    new Elysia()
      .use(observabilityPlugin({ service: 'be-01' }))
      .decorate('logger', logger)
      .use(smokeController)
      .use(authController(opts.auth))
      .use(projectController(opts.auth, opts.projects))
      .use(roleController(opts.auth, opts.roles))
      .use(workItemController(opts.auth, opts.workItems))
      .use(directoryController(opts.auth, opts.directory))
      // After `projectController`, whose prefix it shares: Elysia matches in
      // registration order and `/:id/teams/:teamId/capacity` cannot be shadowed by
      // anything that route declares, but keeping the two adjacent is what makes
      // that checkable at a glance.
      .use(capacityController(opts.auth, opts.capacity))
      // Beside `capacityController` for its reason: it shares
      // `projectController`'s prefix, `/:id/priority-bands` cannot be shadowed by
      // anything that route declares, and adjacency is what makes that checkable
      // at a glance.
      .use(priorityBandController(opts.auth, opts.priorityBands))
      .use(
        internalController({
          secret: opts.internalAuthSecret,
          // A deliberate pure ack, not a stub. Every mutation in this product is
          // an HTTP call to be-01; a client message arriving over the socket is
          // acknowledged and carried no further, because there is no message the
          // socket is the authority for. The test asserting a forward records no
          // event and pushes nothing is what keeps this honest.
          onForward: () => Promise.resolve({ push_responses: [] }),
          onResume: (points) => opts.replay.replay(points),
        }),
      )
      .get('/health', ({ set }) => {
        if (!opts.migrationsApplied) {
          set.status = 503;
          return { status: 'migrating' as const };
        }
        let schema: DatabaseHealth;
        try {
          schema = opts.probeDatabase();
        } catch (err) {
          // Caught and reported, not rethrown: a 500 from a health endpoint is
          // indistinguishable at the gate from the process being wedged, and the
          // operator reading the log needs to know which.
          logger.error({ err }, 'health probe could not reach the database');
          set.status = 503;
          return { status: 'database_unreachable' as const };
        }
        if (schema !== 'ok') {
          set.status = 503;
          return { status: schema };
        }
        return { status: 'ok' as const };
      })
  );
}
