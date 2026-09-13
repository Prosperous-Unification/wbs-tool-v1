/**
 * The development entrypoint that solves locally instead of through the host
 * supervisor. Started by `nx run be-01:serve-local-solver`; never by the image.
 *
 * **This file is the selection.** There is no environment variable that turns
 * the local solver spawner on inside `main.ts`, because a variable is a thing a
 * production process can be started with by accident. `main.ts` does not import
 * this module or `./local-solver-spawner`, so a production process has no
 * expression that reaches a local Python spawn.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createLogger } from '@wbs/observability';

import { bootBe01 } from '../boot';
import { loadConfig } from '../config';
import { oidcRouteOptionsFromEnv } from '../controller/oidc-options';
import { readRuntimeSolverVersion } from '../service/solver-launcher-process';
import { createLocalSolverSpawner, LOCAL_SOLVER_CAPABILITIES } from './local-solver-spawner';

const cfg = loadConfig();
const logger = createLogger({ service: 'be-01', level: cfg.LOG_LEVEL });

// `cwd` is `apps/be-01` under the serve target, matching the supervised target.
const repoRoot = resolve(process.cwd(), '../..');
const binDirectory = join(repoRoot, '.venv-solver', 'bin');

let running;
try {
  // Refuse rather than degrade. An unprovisioned environment that started
  // anyway would spawn a launcher that cannot exec, store `internal-error`, and
  // leave the page saying `Optimizing…` — which is precisely the failure this
  // whole line of work exists to stop reporting as progress.
  if (!existsSync(join(binDirectory, 'wbs-solver-launcher'))) {
    throw new Error(
      `no solver environment at ${binDirectory}; run \`bunx nx run solver-py:setup-macos\` first`,
    );
  }

  logger.warn(
    { optimizer: LOCAL_SOLVER_CAPABILITIES },
    'be-01 starting with the local solver (development only): no memory ceiling, no parent-death signal, no durable deadline owner',
  );

  running = bootBe01({
    appOrigin: cfg.appOrigin,
    dbPath: cfg.DB_PATH,
    port: cfg.PORT,
    logger,
    jwtKey: cfg.JWT_SIGNING_KEY_CURRENT,
    gwUrl: cfg.GW_URL,
    internalAuthSecret: cfg.INTERNAL_AUTH_SECRET,
    oidc: cfg.AUTH_MODE === 'oidc' ? oidcRouteOptionsFromEnv(process.env) : undefined,
    localIdentity:
      cfg.AUTH_MODE === 'local'
        ? { id: 'local-dev', username: 'local-dev', scopes: ['read', 'write', 'editor'] }
        : undefined,
    version: process.env['VERSION'],
    migrateOnStartup: process.env['MIGRATE_ON_STARTUP'] === 'true',
    optimizer: {
      solverVersion: readRuntimeSolverVersion(process.env.NODE_ENV),
      budgetMs: cfg.SOLVER_BUDGET_MS,
      spawn: createLocalSolverSpawner({
        binDirectory,
        searchWorkers: cfg.SOLVER_SEARCH_WORKERS,
        memoryLimitMb: cfg.SOLVER_MEMORY_LIMIT_MB,
      }),
    },
  });
} catch (err) {
  logger.error({ err }, 'be-01 failed to start');
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void running.stop().then(
      () => {
        logger.info({ signal }, 'be-01 stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err, signal }, 'be-01 did not stop cleanly');
        process.exit(1);
      },
    );
  });
}
