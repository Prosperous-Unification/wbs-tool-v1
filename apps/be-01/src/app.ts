import { createLogger } from '@wbs/observability';
import { observabilityPlugin } from '@wbs/observability/server';
import { Elysia } from 'elysia';

import {
  authController,
  hasInvalidCookieOrigin,
  type OidcRouteOptions,
} from './controller/auth.controller';
import { directoryController } from './controller/directory.controller';
import { historyController } from './controller/history.controller';
import { internalController } from './controller/internal.controller';
import { projectController } from './controller/project.controller';
import { roleController } from './controller/role.controller';
import { smokeController } from './controller/smoke.controller';
import { solutionController } from './controller/solution.controller';
import { workItemController } from './controller/work-item.controller';
import { userFromHeaders } from './middleware/authenticated';
import { openApiPlugin } from './openapi/openapi-plugin';
import type { DatabaseHealth } from './repository/health-probe';
import type { AuthService } from './service/auth.service';
import type { CapacityService } from './service/capacity.service';
import type { DirectoryService } from './service/directory.service';
import type { HistoryService } from './service/history.service';
import type { OuterTransaction } from './service/outer-transaction';
import { PlanCommandRunner } from './service/plan-commands';
import type { PriorityBandService } from './service/priority-band.service';
import type { ProjectService } from './service/project.service';
import type { ReplayOrchestrator } from './service/replay-orchestrator';
import type { RoleService } from './service/role.service';
import type { WorkItemService } from './service/work-item.service';
import type { WriteLock } from './service/write-lock';

export interface AppOptions {
  migrationsApplied: boolean;
  /**
   * Required rather than optional. An optional auth service would let a
   * misconfigured process start with the registration and login routes simply
   * absent, answering 404 — indistinguishable from a routing fault at the edge.
   */
  auth: AuthService;
  oidc?: OidcRouteOptions;
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
   * Required for the same reason as `priorityBands`: a process built without it
   * would answer 404 on the history route, which a client cannot tell from a
   * plan whose history is empty — and "empty" is the answer for every plan the
   * day the table ships, so the mistake would be invisible for a week.
   */
  history: HistoryService;
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
   * connection and the write lock — `drizzleOuterTransaction(db)` and a
   * `WriteLock` in production, the counting fixture on in-memory stores. See
   * `service/plan-commands.ts` and ADR 0007.
   */
  writes: { transactions: OuterTransaction; lock: WriteLock };
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
  version?: string;
}

export function buildApp(opts: AppOptions) {
  const logger = createLogger({ service: 'be-01', version: opts.version });
  const commands = new PlanCommandRunner({
    workItems: opts.workItems,
    directory: opts.directory,
    capacity: opts.capacity,
    priorityBands: opts.priorityBands,
    transactions: opts.writes.transactions,
    lock: opts.writes.lock,
  });

  return (
    new Elysia()
      .use(observabilityPlugin({ service: 'be-01' }))
      .decorate('logger', logger)
      // Before every controller, and that is the order the plugin needs: it
      // answers from the route table of the instance it is mounted on, so a
      // route registered after it is seen and a route registered on an instance
      // it never joined is not. The document is committed and diffed against
      // this app by `openapi-document.test.ts`, so a route that goes missing
      // here is a red rather than a silent omission.
      .use(openApiPlugin())
      .onRequest(async ({ request, set }) => {
        if (opts.oidc !== undefined && hasInvalidCookieOrigin(request, opts.oidc.appOrigin)) {
          set.status = 403;
          return { error: 'invalid_origin' };
        }
        if (requiresWriteScope(request)) {
          // `onRequest` deliberately runs before Elysia parses and validates a
          // body. A reader gets the authorization answer without letting an
          // invalid body route around the write-scope boundary as a 422.
          const requestIdentity = await userFromHeaders(
            opts.auth,
            Object.fromEntries(request.headers.entries()),
          );
          if (requestIdentity === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          if (!requestIdentity.scopes.includes('write')) {
            set.status = 403;
            return { error: 'insufficient_scope' };
          }
        }
        return undefined;
      })
      .derive(async ({ headers }) => ({
        requestIdentity: await userFromHeaders(opts.auth, headers),
      }))
      .use(smokeController)
      .use(authController(opts.auth, opts.oidc))
      .use(solutionController(opts.auth, opts.projects))
      .use(projectController(opts.auth, opts.projects, opts.workItems))
      .use(roleController(opts.auth, opts.roles))
      .use(workItemController(opts.auth, opts.workItems, commands))
      .use(directoryController(opts.auth, opts.directory))
      // After `projectController`, whose prefix it shares: Elysia matches in
      // registration order and `/:id/teams/:teamId/capacity` cannot be shadowed by
      // anything that route declares, but keeping the two adjacent is what makes
      // that checkable at a glance.
      // Beside `capacityController` for its reason: it shares
      // `projectController`'s prefix, `/:id/priority-bands` cannot be shadowed by
      // anything that route declares, and adjacency is what makes that checkable
      // at a glance.
      // Beside the two above for their reason: it shares `projectController`'s
      // prefix, `/:id/history` cannot be shadowed by anything that route
      // declares, and adjacency is what makes that checkable at a glance.
      .use(historyController(opts.auth, opts.history))
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
        // On every answer, including the unhealthy ones. "Which commit is this
        // wedged process at" is the first question a failed deploy raises, and
        // an endpoint that only names the commit when all is well cannot answer
        // it — the deploy poller reads this precisely when it does not yet know
        // whether the reset it just made has taken effect.
        const commit = opts.deployedCommit?.() ?? null;
        if (!opts.migrationsApplied) {
          set.status = 503;
          return { status: 'migrating' as const, commit };
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
          return { status: 'database_unreachable' as const, commit };
        }
        if (schema !== 'ok') {
          set.status = 503;
          return { status: schema, commit };
        }
        return { status: 'ok' as const, commit };
      })
  );
}

const WRITE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/** User-facing domain writes; auth handshakes, internal RPC, and pure echo are not domain writes. */
export function requiresWriteScope(request: Request): boolean {
  if (!WRITE_METHODS.has(request.method)) return false;
  const path = new URL(request.url).pathname;
  return path.startsWith('/api/') && !path.startsWith('/api/auth/') && path !== '/api/smoke/echo';
}
