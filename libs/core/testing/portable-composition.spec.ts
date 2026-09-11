import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import type { PortableCompletion } from './portable-composition';

declare global {
  interface Window {
    portableComposition: Promise<PortableCompletion>;
  }
}

const bootstrap = 'https://core-probe.invalid/';
const bundlePath = resolve('dist/libs/core/portable-composition.js');

test('portable composition executes all operations in Chromium', async ({ page }) => {
  const unexpectedRequests: string[] = [];
  await page.route('**/*', async (route) => {
    if (route.request().url() === bootstrap) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><title>core probe</title>',
      });
      return;
    }
    unexpectedRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.goto(bootstrap);
  await expect
    .poll(
      async () => await page.evaluate(() => ({ secure: isSecureContext, subtle: !!crypto.subtle })),
    )
    .toEqual({ secure: true, subtle: true });

  const bundleBytes = await readFile(bundlePath);
  const bundle = bundleBytes.toString('utf8');
  expect(bundle).not.toContain('@wbs/');
  // Proof: a production `Bun.version` access failed in Chromium with
  // `page.evaluate: ReferenceError: Bun is not defined` at the bundled access.
  expect(bundle).not.toMatch(/\bBun\s*\./);
  const identity = createHash('sha256').update(bundleBytes).digest('hex');
  console.log(
    `portable bundle: portable-composition.js sha256=${identity} bytes=${String(bundleBytes.byteLength)}`,
  );
  await page.addScriptTag({ path: bundlePath, type: 'module' });
  const completion = await page.evaluate(async () => await window.portableComposition);
  await page.waitForTimeout(50);

  // Proof: omitting `completed.add('retention')` failed this independent record
  // with `Expected: {batch:true,replay:true,retention:true,save:true}` and
  // `Received: {batch:true,replay:true,retention:false,save:true}`.
  expect(completion.operations).toEqual({
    batch: true,
    save: true,
    replay: true,
    retention: true,
  });
  expect(completion.pushed).toBeGreaterThan(0);
  // Proof: requesting `https://unexpected.invalid/fault` from an injected image
  // immediately before this assertion failed here with that exact URL as the
  // sole received array member. Without the bounded observer-settlement wait,
  // the assertion raced the route callback and the same injected fault passed.
  expect(unexpectedRequests).toEqual([]);
});
