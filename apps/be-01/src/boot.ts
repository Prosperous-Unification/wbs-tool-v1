import type { Logger } from '@wbs/observability';

import { buildApp } from './app';
import type { OidcRouteOptions } from './controller/auth.controller';
import { readDeployedCommit } from './deployed-commit';
import { openConnection } from './repository/db';
import { probeSchema } from './repository/health-probe';
import { runMigrations } from './repository/migrate';
import { UserRepository } from './repository/user';
import type { AuthenticatedUser } from './service/auth.service';
import { type BeServices, buildServices } from './services';

export interface BootOptions {
  dbPath: string;
  port: number;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
  oidc?: OidcRouteOptions;
  localIdentity?: AuthenticatedUser;
  version?: string;
  /**
   * Local dev only, and off by default.
   *
   * A deployed container must not migrate at startup: blue and green share one
   * SQLite file during the swap overlap, so migrating on boot means green starts
   * rewriting the schema the instant the container is up — before the swap
   * executor's discrete `migrate` step, before the health gate, while blue is
   * still serving against it. The deploy path runs `migrate-cli.ts` as its own
   * step instead, strictly before anything polls `/health`.
   */
  migrateOnStartup?: boolean;
  migrationsFolder?: string;
  /**
   * Where to start looking for the checkout `/health` should name the commit of.
   *
   * Defaults to the process's working directory, which for a served tier is
   * `apps/be-01` — the reader walks up from there. It is an option only so a
   * test can point it at a repository it built itself; nothing in a deployment
   * sets it.
   */
  commitDir?: string;
}

export interface RunningBe {
  services: BeServices;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Everything between an empty process and a serving be-01.
 *
 * It is a function, and it is tested. `retention.start()` living in a top-level
 * script meant "the timer is running in production" was a claim no test could
 * reach — the same shape of gap as the `runRetention` that had no caller at all,
 * which is what this change set out to fix.
 */
export function bootBe01(opts: BootOptions): RunningBe {
  // One connection for the process, opened through `openDrizzle` so the
  // per-connection pragmas (WAL, busy_timeout) are set and asserted.
  const connection = openConnection(opts.dbPath);
  const db = connection.db;
  const services = buildServices({
    db,
    logger: opts.logger,
    jwtKey: opts.jwtKey,
    gwUrl: opts.gwUrl,
    internalAuthSecret: opts.internalAuthSecret,
    oidc:
      opts.oidc === undefined
        ? undefined
        : {
            groupPrefix: opts.oidc.groupPrefix,
            groupsClaim: opts.oidc.groupsClaim,
            verifier: opts.oidc.verifier,
          },
    passwordSessions: opts.oidc !== undefined && opts.oidc.passwordLoginEnabled !== false,
    localIdentity: opts.localIdentity,
  });

  const state = { migrationsApplied: false };
  const app = buildApp({
    get migrationsApplied() {
      return state.migrationsApplied;
    },
    auth: services.auth,
    oidc: opts.oidc,
    projects: services.projects,
    roles: services.roles,
    workItems: services.workItems,
    directory: services.directory,
    capacity: services.capacity,
    priorityBands: services.priorityBands,
    history: services.history,
    replay: services.replay,
    probeDatabase: () => probeSchema(db),
    // Read per call, not captured here: dev's deploy is a `git reset` under
    // live watchers, so this process outlives the commit it started on.
    deployedCommit: () => readDeployedCommit(opts.commitDir),
    internalAuthSecret: opts.internalAuthSecret,
    version: opts.version,
  });

  // Started before `listen`, not inside its callback: the callback is skipped by
  // a port that fails to bind, which would leave retention off in exactly the
  // deployment that had a problem.
  services.retention.start();

  const ensureLocalIdentity = (): void => {
    if (opts.localIdentity !== undefined) {
      new UserRepository(db).ensureLocalIdentity(opts.localIdentity);
    }
  };

  app.listen(opts.port, () => {
    if (opts.migrateOnStartup !== true) {
      opts.logger.info(
        { port: opts.port },
        'be-01 listening (schema managed by the deploy pipeline)',
      );
      ensureLocalIdentity();
      state.migrationsApplied = true;
      return;
    }
    opts.logger.info({ port: opts.port }, 'be-01 listening (migrating)');
    runMigrations(opts.dbPath, opts.migrationsFolder ?? './drizzle');
    ensureLocalIdentity();
    state.migrationsApplied = true;
    opts.logger.info('migrations applied');
  });

  return {
    services,
    port: app.server?.port ?? opts.port,
    /** Stops accepting, waits for a retention sweep in flight, then closes the file. */
    stop: async () => {
      await app.stop();
      await services.retention.stop();
      connection.close();
    },
  };
}
