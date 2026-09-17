import { health, metrics } from '@wbs/contracts';
import type { Logger, MetricsScrape } from '@wbs/observability';

import { bind } from '../http/endpoint';
import type { DatabaseHealth } from '../repository/health-probe';

export interface InfrastructureEndpointOptions {
  migrationsApplied: boolean;
  probeDatabase: () => DatabaseHealth;
  deployedCommit?: () => string | null;
  logger: Pick<Logger, 'error'>;
  scrapeMetrics: () => Promise<MetricsScrape>;
}

/** Binds process readiness and metrics to their shared wire declarations. */
export function infrastructureEndpoints(options: InfrastructureEndpointOptions) {
  return [
    bind(health, () => {
      const commit = options.deployedCommit?.() ?? null;
      if (!options.migrationsApplied) {
        // Proof: returning the healthy 200 branch here made the production app
        // test expect 503 and receive 200 while migrations were still pending.
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { error: 'dependency_unavailable', status: 'migrating', commit },
        });
      }
      let schema: DatabaseHealth;
      try {
        schema = options.probeDatabase();
      } catch (error) {
        options.logger.error({ err: error }, 'health probe could not reach the database');
        // Proof: returning the healthy branch after a thrown probe made
        // health.db.test.ts expect 503 and receive 200.
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { error: 'dependency_unavailable', status: 'database_unreachable', commit },
        });
      }
      if (schema !== 'ok') {
        // Proof: returning the healthy branch here made health.db.test.ts expect
        // 503 and receive 200 against a real unmigrated SQLite database.
        return Promise.resolve({
          ok: false,
          status: 503,
          body: { error: 'dependency_unavailable', status: schema, commit },
        });
      }
      return Promise.resolve({ ok: true, status: 200, body: { status: 'ok', commit } });
    }),
    bind(metrics, async () => {
      const scrape = await options.scrapeMetrics();
      // Proof: forcing every scrape to 200 made the mounted metrics test expect
      // 500 and receive 200 for a collector error.
      return { ok: true, status: scrape.status, text: scrape.text };
    }),
  ] as const;
}
