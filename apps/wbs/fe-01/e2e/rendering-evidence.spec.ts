import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { createRenderingEvidence } from './rendering-evidence';

test('a completed timing sample survives before later measurement stages', async ({
  browserName,
}, testInfo) => {
  const path = testInfo.outputPath(`${browserName}-checkpoint.json`);
  const evidence = await createRenderingEvidence(path, { phase: 'latency', sourceHead: 'probe' });
  await evidence.record('cold-context', { readyPaintMs: 123 });
  const checkpoint = JSON.parse(await readFile(path, 'utf8')) as {
    status: string;
    stage: string;
    samples: unknown[];
    metadata: { sourceHead: string };
  };
  expect(checkpoint.status).toBe('running');
  expect(checkpoint.stage).toBe('cold-context');
  expect(checkpoint.samples).toEqual([
    { stage: 'cold-context', observation: { readyPaintMs: 123 } },
  ]);
  expect(checkpoint.metadata.sourceHead).toBe('probe');
  await evidence.finish();
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'complete' });
});

test('unwritable evidence is a refused measurement rather than a silent checkpoint', async ({
  browserName,
}, testInfo) => {
  await expect(
    createRenderingEvidence(testInfo.outputPath(`${browserName}-missing`, 'checkpoint.json'), {
      phase: 'latency',
    }),
  ).rejects.toThrow(/ENOENT/);
});
