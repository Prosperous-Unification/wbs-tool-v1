import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';

import { expect, type Page, test } from '@playwright/test';

import { createRenderingEvidence, renderingProvenance } from './rendering-evidence';
import { painted, renderingGeometry, seedRenderingPlan } from './rendering-fixture';

interface InputObservation {
  input: number;
  paint: number | null;
  filtered: number | null;
}

type ObservedWindow = Window & {
  renderingInput?: InputObservation;
  renderingReady?: number;
  renderingLongTasks?: { start: number; duration: number }[];
};

/** A real single keystroke, observed separately from its completed filtering. */
async function findSample(page: Page, character: string, rows: number) {
  const field = page.getByLabel('Find', { exact: true });
  await field.fill('');
  await expect(page.locator('[data-grid] tbody tr[data-row-id]')).toHaveCount(rows);
  await painted(page);
  await field.focus();
  await page.evaluate(
    (expectedRows) => {
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Find"]');
      if (field === null) throw new Error('Find is absent at measurement');
      const observed = window as ObservedWindow;
      delete observed.renderingInput;
      field.addEventListener(
        'input',
        () => {
          const observation: InputObservation = {
            input: performance.now(),
            paint: null,
            filtered: null,
          };
          observed.renderingInput = observation;
          const observeFilter = () => {
            if (
              document.querySelectorAll('[data-grid] tbody tr[data-row-id]').length ===
                expectedRows &&
              document.querySelectorAll('[data-grid] [data-match="true"]').length === expectedRows
            ) {
              requestAnimationFrame(() => {
                observation.filtered = performance.now();
              });
            } else requestAnimationFrame(observeFilter);
          };
          requestAnimationFrame(observeFilter);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              observation.paint = performance.now();
            }),
          );
        },
        { capture: true, once: true },
      );
    },
    character === 'z' ? 1 : rows,
  );
  await page.keyboard.type(character);
  await expect(page.locator('[data-grid] tbody tr[data-row-id]')).toHaveCount(
    character === 'z' ? 1 : rows,
  );
  await painted(page);
  const observed = await page.evaluate(() => {
    const observation = (window as ObservedWindow).renderingInput;
    if (observation?.paint == null || observation.filtered === null)
      throw new Error('input has no observed paint opportunity');
    return observation;
  });
  return {
    character,
    inputPaintMs: observed.paint! - observed.input,
    filterPaintMs: observed.filtered! - observed.input,
  };
}

/** Chromium's actual production function counts, in a separate instrumented pass. */
async function cellRenderCalls(page: Page, rows: number) {
  const field = page.getByLabel('Find', { exact: true });
  await field.fill('');
  await expect(page.locator('[data-grid] tbody tr[data-row-id]')).toHaveCount(rows);
  await painted(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  try {
    await field.focus();
    await page.keyboard.type('R');
    await painted(page);
    const coverage = await session.send('Profiler.takePreciseCoverage');
    const functions = coverage.result.flatMap((script) =>
      script.functions.filter((fn) => fn.functionName === 'flexibleCellStyle'),
    );
    if (functions.length === 0)
      throw new Error('production flexibleCellStyle coverage was not collected');
    return functions.reduce((count, fn) => count + fn.ranges[0].count, 0);
  } finally {
    await session.send('Profiler.stopPreciseCoverage');
    await session.detach();
  }
}

test.use({
  actionTimeout: 120_000,
  navigationTimeout: 120_000,
  trace: process.env['R10_BASELINE_TRACE'] === '1' ? 'retain-on-failure' : 'off',
});

/** Exploratory measurements are opt-in; acceptance budgets get their own normal gate cases. */
test.describe('Chromium rendering baseline', () => {
  test.skip(
    process.env['R10_BASELINE'] !== '1',
    'opt-in baseline experiment, not the acceptance gate',
  );
  for (const rows of [100, 500, 1000]) {
    for (const steps of [2, 8]) {
      for (const density of ['sparse', 'dense'] as const) {
        for (const phase of ['latency', 'coverage', 'gantt'] as const) {
          test(`${phase} / ${String(rows)} rows / ${String(steps)} steps / ${density}`, async ({
            page,
            browser,
          }, testInfo) => {
            test.setTimeout(600_000);
            const provenance = await renderingProvenance();
            const seeded = await seedRenderingPlan(page, { rows, steps, density });
            console.log(
              `Seeded ${String(rows)}/${String(steps)}/${density} in ${String(seeded.setupMs)}ms`,
            );
            const storageState = await page.context().storageState();
            const evidence = await createRenderingEvidence(
              testInfo.outputPath('measurements.json'),
              {
                ...provenance,
                phase,
                measurementUse: process.env['R10_MEASUREMENT_USE'] ?? 'correctness-only',
                startedAt: new Date().toISOString(),
                trace: process.env['R10_BASELINE_TRACE'] === '1' ? 'retain-on-failure' : 'off',
                seeded: {
                  rows,
                  steps,
                  density,
                  projectId: seeded.projectId,
                  edges: seeded.edges,
                  setupMs: seeded.setupMs,
                },
                browser: browser.version(),
                runtime: {
                  platform: platform(),
                  release: release(),
                  arch: arch(),
                  cpu: cpus()[0]?.model,
                },
                viewport: { width: 1400, height: 900 },
                server: 'warm Vite development/backend; fresh owned stack',
                throttle: 'none',
              },
            );
            const record = async (observation: { kind: string } & Record<string, unknown>) => {
              await evidence.record(observation.kind, observation);
              console.log(
                `Checkpoint ${phase}/${String(rows)}/${String(steps)}/${density}: ${observation.kind}`,
              );
            };
            const coldCount =
              phase === 'latency' && process.env['R10_BASELINE_SMOKE'] !== '1' ? 3 : 1;
            const warmCount = process.env['R10_BASELINE_SMOKE'] === '1' ? 1 : 7;
            const baseURL = testInfo.project.use.baseURL;
            if (baseURL === undefined) throw new Error('baseline has no configured stack URL');
            for (let contextIndex = 0; contextIndex < coldCount; contextIndex += 1) {
              const context = await browser.newContext({
                storageState,
                baseURL,
                viewport: { width: 1400, height: 900 },
                locale: 'en-US',
                timezoneId: 'UTC',
              });
              try {
                await context.addInitScript((rows) => {
                  const observed = window as ObservedWindow;
                  observed.renderingLongTasks = [];
                  new PerformanceObserver((entries) => {
                    for (const entry of entries.getEntries())
                      observed.renderingLongTasks?.push({
                        start: entry.startTime,
                        duration: entry.duration,
                      });
                  }).observe({ type: 'longtask', buffered: true });
                  const ready = new MutationObserver(() => {
                    if (
                      document.querySelectorAll('[data-grid] tbody tr[data-row-id]').length !== rows
                    )
                      return;
                    ready.disconnect();
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        observed.renderingReady = performance.now();
                      }),
                    );
                  });
                  ready.observe(document, { subtree: true, childList: true });
                }, rows);
                const measured = await context.newPage();
                const rounds = phase === 'latency' && contextIndex === 0 ? warmCount + 1 : 1;
                for (let round = 0; round < rounds; round += 1) {
                  await measured.goto('/');
                  await expect(measured.locator('[data-grid] tbody tr[data-row-id]')).toHaveCount(
                    rows,
                    { timeout: 120_000 },
                  );
                  await expect(
                    measured.locator(`[data-name-input="${seeded.ids[0]}"]`),
                  ).toHaveValue('Row 0000');
                  expect(await measured.getByLabel('Gantt chart', { exact: true }).count()).toBe(0);
                  await painted(measured);
                  if (phase === 'latency') {
                    const mount = await measured.evaluate(() => {
                      const observed = window as ObservedWindow;
                      if (observed.renderingReady === undefined)
                        throw new Error('table readiness paint was not observed');
                      const tree = performance
                        .getEntriesByType('resource')
                        .filter((entry) => entry.name.endsWith('/work-items'))
                        .at(-1) as PerformanceResourceTiming | undefined;
                      if (tree === undefined)
                        throw new Error('tree response timing was not observed');
                      return {
                        readyPaintMs: observed.renderingReady,
                        treeResponseToPaintMs: observed.renderingReady - tree.responseEnd,
                        longTasks: observed.renderingLongTasks,
                      };
                    });
                    const geometry = await renderingGeometry(measured);
                    const broad = await findSample(measured, 'R', rows);
                    const selective = await findSample(measured, 'z', rows);
                    await record({
                      kind: round === 0 ? 'cold-context' : 'warm-reload',
                      contextIndex,
                      round,
                      ...mount,
                      geometry,
                      broad,
                      selective,
                    });
                  }
                }
                if (phase === 'coverage') {
                  const calls = await cellRenderCalls(measured, rows);
                  await record({ kind: 'precise-coverage', broadFindCellStyleCalls: calls });
                }
                if (phase === 'gantt') {
                  await measured.getByLabel('Find', { exact: true }).fill('');
                  await expect(measured.locator('[data-grid] tbody tr[data-row-id]')).toHaveCount(
                    rows,
                  );
                  await measured.getByRole('button', { name: 'Gantt', exact: true }).click();
                  await expect(measured.getByLabel('Gantt chart', { exact: true })).toBeVisible();
                  await painted(measured);
                  await record({
                    kind: 'gantt-open',
                    geometry: await renderingGeometry(measured),
                    chart: await measured.locator('[data-gantt-label]').count(),
                    labelGeometry: await measured
                      .locator('[data-gantt-label]')
                      .evaluateAll((labels) =>
                        labels.slice(0, 3).map((label) => {
                          const box = label.getBoundingClientRect();
                          return { top: box.top, height: box.height };
                        }),
                      ),
                  });
                  if (steps === 8) {
                    const unfold = measured.getByRole('button', { name: /^Unfold .* estimates$/ });
                    await expect(unfold).toHaveCount(8);
                    for (let index = 0; index < 8; index += 1) await unfold.first().click();
                    await measured.locator('[data-table-frame]').evaluate((frame) => {
                      frame.scrollLeft = 0;
                    });
                    await painted(measured);
                    await record({
                      kind: 'eight-steps-unfolded-left',
                      geometry: await renderingGeometry(measured),
                    });
                    await measured.locator('[data-table-frame]').evaluate((frame) => {
                      frame.scrollLeft = frame.scrollWidth;
                    });
                    await painted(measured);
                    await record({
                      kind: 'eight-steps-unfolded-right',
                      geometry: await renderingGeometry(measured),
                    });
                  }
                }
              } finally {
                await context.close();
              }
            }
            await evidence.finish();
            const serialized = await readFile(testInfo.outputPath('measurements.json'), 'utf8');
            await testInfo.attach('rendering-measurements', {
              body: serialized,
              contentType: 'application/json',
            });
            console.log(
              `Rendering baseline ${String(rows)}/${String(steps)}/${density}: ${serialized}`,
            );
          });
        }
      }
    }
  }
});
