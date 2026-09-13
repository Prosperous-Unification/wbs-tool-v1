import { expect, test } from 'bun:test';

import { testApp } from '../testing/app-fixture';

test('serves collector success and failure as declared Prometheus text', async () => {
  for (const scrape of [
    { status: 200 as const, text: 'probe_count 1\n' },
    { status: 500 as const, text: '# scrape errors: collector unavailable\n' },
  ]) {
    const response = await testApp({ metricsScrape: () => Promise.resolve(scrape) }).handle(
      new Request('http://localhost/metrics'),
    );
    expect(response.status).toBe(scrape.status);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await response.text()).toBe(scrape.text);
  }
});

test('keeps deploy commit metadata on a dependency refusal', async () => {
  const response = await testApp({
    migrationsApplied: false,
    deployedCommit: () => '0123456789abcdef',
  }).handle(new Request('http://localhost/health'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'dependency_unavailable',
    status: 'migrating',
    commit: '0123456789abcdef',
  });
});
