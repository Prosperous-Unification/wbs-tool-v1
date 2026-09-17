import { metrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

import type { ServiceName } from './logger';

export interface MetricsScrape {
  status: 200 | 500;
  text: string;
}

let started = false;
let sharedReader: PrometheusExporter | null = null;

function ensureReader(): PrometheusExporter {
  if (sharedReader !== null) return sharedReader;
  const reader = new PrometheusExporter({ preventServerStart: true });
  if (!started) {
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    started = true;
  }
  sharedReader = reader;
  return reader;
}

/** Collects Prometheus text without owning an HTTP framework or route. */
export async function scrapeMetrics(service: ServiceName): Promise<MetricsScrape> {
  const { resourceMetrics, errors } = await ensureReader().collect();
  if (errors.length > 0) {
    const message = errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join(', ');
    return { status: 500, text: `# scrape errors: ${message}\n` };
  }
  const text = new PrometheusSerializer().serialize(resourceMetrics);
  return {
    status: 200,
    text: text.length > 0 ? text : `# no metrics registered yet for ${service}\n`,
  };
}

export function resetMetricsForTests(): void {
  sharedReader = null;
  started = false;
}
