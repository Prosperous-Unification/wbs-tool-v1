import type { Logger } from '@wbs/observability';

import { buildApp } from './app';
import { openConnection } from './repository/db';
import { probeSchema } from './repository/health-probe';
import { runMigrations } from './repository/migrate';
import { type BeServices, buildServices } from './services';

export interface BootOptions {
  dbPath: string;
  port: number;
  logger: Logger;
  jwtKey: string;
  gwUrl: string;
  internalAuthSecret: string;
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
  });

  const state = { migrationsApplied: false };
  const app = buildApp({
    get migrationsApplied() {
      return state.migrationsApplied;
    },
    auth: services.auth,
    projects: services.projects,
    roles: services.roles,
    workItems: services.workItems,
    directory: services.directory,
    capacity: services.capacity,
    priorityBands: services.priorityBands,
    replay: services.replay,
    probeDatabase: () => probeSchema(db),
    internalAuthSecret: opts.internalAuthSecret,
    version: opts.version,
  });

  // Started before `listen`, not inside its callback: the callback is skipped by
  // a port that fails to bind, which would leave retention off in exactly the
  // deployment that had a problem.
  services.retention.start();

  app.listen(opts.port, () => {
    if (opts.migrateOnStartup !== true) {
      opts.logger.info(
        { port: opts.port },
        'be-01 listening (schema managed by the deploy pipeline)',
      );
      state.migrationsApplied = true;
      return;
    }
    opts.logger.info({ port: opts.port }, 'be-01 listening (migrating)');
    runMigrations(opts.dbPath, opts.migrationsFolder ?? './drizzle');
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
