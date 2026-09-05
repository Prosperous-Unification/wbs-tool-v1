import { createLogger } from '@wbs/observability';

import { bootBe01 } from './boot';
import { loadConfig } from './config';
import { oidcRouteOptionsFromEnv } from './controller/auth.routes';

const cfg = loadConfig();
const logger = createLogger({ service: 'be-01', level: cfg.LOG_LEVEL });

// Everything this file used to do inline now lives in `bootBe01`, which has
// tests. A process whose composition is a top-level script is a composition no
// test can reach — and this change exists because `runRetention` sat with no
// caller for exactly that reason.
//
// `MIGRATE_ON_STARTUP` defaults OFF: a deployed container must not migrate at
// boot, because blue and green share one SQLite file during the swap overlap.
// Local dev opts in through `apps/be-01/.env`.
let running;
try {
  running = bootBe01({
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
  });
} catch (err) {
  logger.error({ err }, 'be-01 failed to start');
  process.exit(1);
}

// Stops accepting, waits for a retention sweep in flight, closes the file. The
// default SIGTERM would kill the process mid-DELETE against a file the other
// deployment colour is also using.
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
