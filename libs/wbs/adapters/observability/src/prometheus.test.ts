import { expect, test } from 'bun:test';

import { resetMetricsForTests, scrapeMetrics } from './prometheus';

test('collects a nonempty Prometheus scrape without an HTTP framework', async () => {
  resetMetricsForTests();
  const scrape = await scrapeMetrics('be-01');
  expect(scrape.status).toBe(200);
  expect(scrape.text.length).toBeGreaterThan(0);
});
