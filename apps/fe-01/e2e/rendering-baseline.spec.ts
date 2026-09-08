import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';

import { expect, type Locator, type Page, test } from '@playwright/test';

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
  await expect(page.locator('[data-grid] tbody tr[data-row-id]').first()).toBeVisible();
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
            const grid = document.querySelector('[data-grid]');
            const mountedRows = grid?.querySelectorAll('tbody tr[data-row-id]') ?? [];
            if (
              grid?.getAttribute('aria-rowcount') === String(expectedRows + 1) &&
              mountedRows.length > 0 &&
              grid.querySelectorAll('[data-match="true"]').length === mountedRows.length
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
  await expect(page.locator('[data-grid]')).toHaveAttribute(
    'aria-rowcount',
    String((character === 'z' ? 1 : rows) + 1),
  );
  await painted(page);
  await expect
    .poll(() => page.evaluate(() => (window as ObservedWindow).renderingInput?.filtered ?? null))
    .not.toBeNull();
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
async function cellRenderCalls(page: Page) {
  const field = page.getByLabel('Find', { exact: true });
  await field.fill('');
  await expect(page.locator('[data-grid] tbody tr[data-row-id]').first()).toBeVisible();
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

test('a broad Find renders no more than its two filter-sensitive cells per row', async ({
  page,
}) => {
  const rows = 100;
  const seeded = await seedRenderingPlan(page, { rows, steps: 2, density: 'sparse' });
  await page.goto('/');
  await expect(page.locator(`[data-name-input="${seeded.ids[0]}"]`)).toHaveValue('Row 0000');
  await expect
    .poll(async () => (await renderingGeometry(page)).mountedCells)
    .toBeLessThanOrEqual(1200);
  const firstName = page.locator(`[data-name-input="${seeded.ids[0]}"]`);
  await firstName.focus();
  await firstName.press('End');
  await firstName.pressSequentially(' half-typed');
  const nameNode = await firstName.evaluateHandle((node) => node);
  const selection = await firstName.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error('Name cell is not a textarea');
    return { start: node.selectionStart, end: node.selectionEnd };
  });
  await page.locator('[data-table-frame]').evaluate((frame) => {
    frame.scrollTop = frame.scrollHeight;
  });
  expect(await firstName.evaluate((node, before) => node === before, nameNode)).toBe(true);
  await expect(firstName).toBeFocused();
  await expect(firstName).toHaveValue('Row 0000 half-typed');
  expect(
    await firstName.evaluate((node) => {
      if (!(node instanceof HTMLTextAreaElement)) throw new Error('Name cell is not a textarea');
      return { start: node.selectionStart, end: node.selectionEnd };
    }),
  ).toEqual(selection);
  await expect(page.locator(`[data-name-input="${seeded.ids[rows - 1]}"]`)).toHaveValue(
    'Row 0099 z',
  );
  await expect(page.locator('[data-grid]')).toHaveAttribute('aria-rowcount', '101');
  await expect(page.locator(`tr[data-row-id="${seeded.ids[0]}"]`)).toHaveAttribute(
    'aria-rowindex',
    '2',
  );
  await expect(page.locator(`tr[data-row-id="${seeded.ids[0]}"]`)).toHaveAttribute(
    'data-row-parity',
    'odd',
  );
  await expect(page.locator(`tr[data-row-id="${seeded.ids[rows - 1]}"]`)).toHaveAttribute(
    'aria-rowindex',
    '101',
  );
  await expect(page.locator(`tr[data-row-id="${seeded.ids[rows - 1]}"]`)).toHaveAttribute(
    'data-row-parity',
    'even',
  );
  expect((await renderingGeometry(page)).mountedCells).toBeLessThanOrEqual(1200);
  await page.reload();
  await expect(firstName).toHaveValue('Row 0000');

  expect(await cellRenderCalls(page)).toBeLessThanOrEqual(rows * 2);

  const mountedRows = page.locator('[data-grid] tbody tr[data-row-id]');
  const lastMountedId = await mountedRows.last().getAttribute('data-row-id');
  if (lastMountedId === null) throw new Error('the last mounted row has no logical id');
  const lastMountedIndex = seeded.ids.indexOf(lastMountedId);
  if (lastMountedIndex < 0) throw new Error('the last mounted row is absent from the seeded plan');
  if (lastMountedIndex >= seeded.ids.length - 1)
    throw new Error('the initial row window reaches the end of the plan');
  const nextId = seeded.ids[lastMountedIndex + 1];
  const nextName = page.locator(`[data-name-input="${nextId}"]`);
  expect(await nextName.count()).toBe(0);
  await page.locator(`[data-name-input="${lastMountedId}"]`).evaluate((node) => {
    if (!(node instanceof HTMLElement)) throw new Error('the source cell cannot take focus');
    node.focus({ preventScroll: true });
  });
  expect(await nextName.count()).toBe(0);
  await page.keyboard.press('Control+j');
  await expect(nextName).toBeFocused();
});

test('an editor that left the row window can commit, escape, and hold a refusal', async ({
  page,
}) => {
  const rows = 100;
  const seeded = await seedRenderingPlan(page, { rows, steps: 2, density: 'sparse' });
  await page.goto('/');
  const frame = page.locator('[data-table-frame]');
  const firstName = page.locator(`[data-name-input="${seeded.ids[0]}"]`);
  const lastName = page.locator(`[data-name-input="${seeded.ids[rows - 1]}"]`);
  const leaveFirstBehind = async (active: Locator): Promise<void> => {
    await frame.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(lastName).toBeVisible();
    await expect(active).toBeFocused();
  };
  const returnToFirst = async (): Promise<void> => {
    await frame.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(firstName).toBeVisible();
  };

  await firstName.fill('Committed after leaving the row window');
  await leaveFirstBehind(firstName);
  await lastName.focus();
  await expect.poll(() => firstName.count()).toBe(0);
  await returnToFirst();
  await expect(firstName).toHaveValue('Committed after leaving the row window');
  await page.reload();
  await expect(firstName).toHaveValue('Committed after leaving the row window');

  await page.getByLabel('Project start date').fill('2026-06-01');
  await page.getByLabel('Project start date').blur();
  await page.locator('thead th[data-column="not-before"]').evaluate((heading) => {
    heading.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const firstStart = page.getByLabel('Earliest start for 0010');
  await firstStart.fill('2026-09-09');
  await leaveFirstBehind(firstStart);
  await page.keyboard.press('Escape');
  await returnToFirst();
  await expect(firstStart).toHaveValue('—');

  await page.locator('thead th[data-column="priority"]').evaluate((heading) => {
    heading.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const firstPriority = page.getByLabel('Priority for 0010');
  await firstPriority.fill('0');
  await leaveFirstBehind(firstPriority);
  const refusalResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/commands'),
  );
  await lastName.focus();
  expect(await (await refusalResponse).text()).toContain('priority_must_be_a_whole_number_from_1');
  await expect(page.getByRole('alert')).toContainText(
    'That change could not be completed (priority_must_be_a_whole_number_from_1).',
  );
  await expect.poll(() => firstPriority.count()).toBe(0);
  await returnToFirst();
  await expect(firstPriority).toHaveValue('0');
});

test('an unfolded plan mounts only its viewport columns', async ({ page }) => {
  await seedRenderingPlan(page, { rows: 100, steps: 8, density: 'sparse' });
  await page.goto('/');
  const unfold = page.getByRole('button', { name: /^Unfold .* estimates$/ });
  await expect(unfold).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) await unfold.first().click();

  const actions = page.locator('[data-grid] tbody td[data-column="actions"]');
  expect(await actions.count()).toBe(0);
  expect((await renderingGeometry(page)).mountedCells).toBeLessThanOrEqual(2250);

  const estimate = page.locator('[data-grid] input[data-cell$="-optimistic"]').first();
  await estimate.focus();
  await estimate.press('End');
  await estimate.pressSequentially('7');
  const estimateNode = await estimate.evaluateHandle((node) => node);
  const estimateValue = await estimate.inputValue();
  const pinnedName = page.locator('[data-grid] tbody td[data-column="name"]').first();
  const pinnedBefore = await pinnedName.boundingBox();
  if (pinnedBefore === null) throw new Error('the pinned Name cell has no geometry');

  await page.locator('[data-table-frame]').evaluate((frame) => {
    frame.scrollLeft = frame.scrollWidth;
  });
  await expect(actions.first()).toBeVisible();
  expect(await estimate.evaluate((node, before) => node === before, estimateNode)).toBe(true);
  await expect(estimate).toBeFocused();
  await expect(estimate).toHaveValue(estimateValue);
  const pinnedAfter = await pinnedName.boundingBox();
  if (pinnedAfter === null) throw new Error('the scrolled pinned Name cell has no geometry');
  expect(Math.abs(pinnedAfter.x - pinnedBefore.x)).toBeLessThanOrEqual(1);
  expect((await renderingGeometry(page)).mountedCells).toBeLessThanOrEqual(2250);
});

test('a measured row above the viewport leaves the visible row anchored', async ({ page }) => {
  const seeded = await seedRenderingPlan(page, { rows: 100, steps: 2, density: 'sparse' });
  await page.goto('/');
  const firstName = page.locator(`[data-name-input="${seeded.ids[0]}"]`);
  await firstName.evaluate((node) => {
    if (!(node instanceof HTMLElement)) throw new Error('the first Name cannot take focus');
    node.focus({ preventScroll: true });
  });
  const frame = page.locator('[data-table-frame]');
  await frame.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.locator(`[data-name-input="${seeded.ids[99]}"]`)).toBeVisible();

  const anchor = await frame.evaluate((node) => {
    const frameTop = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('tbody tr[data-row-id]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > frameTop,
    );
    if (row === undefined) throw new Error('the viewport has no visible logical row');
    return {
      id: row.dataset['rowId'],
      top: row.getBoundingClientRect().top,
      scrollTop: node.scrollTop,
    };
  });
  if (anchor.id === undefined) throw new Error('the visible anchor has no row id');

  await firstName.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error('the first Name is not a textarea');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (descriptor?.set === undefined) throw new Error('the textarea value boundary is unreadable');
    descriptor.set.call(node, `${node.value}\nsecond line\nthird line\nfourth line`);
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await expect
    .poll(async () => frame.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(anchor.scrollTop);
  const settled = await page.locator(`tr[data-row-id="${anchor.id}"]`).evaluate((row) => ({
    top: row.getBoundingClientRect().top,
  }));
  expect(Math.abs(settled.top - anchor.top)).toBeLessThanOrEqual(1);
});

test('a row drag at the frame edge reaches an initially unmounted destination', async ({
  page,
}) => {
  const seeded = await seedRenderingPlan(page, { rows: 100, steps: 2, density: 'sparse' });
  await page.goto('/');
  const destination = page.locator(`tr[data-row-id="${seeded.ids[60]}"]`);
  expect(await destination.count()).toBe(0);
  await page.locator('[aria-label^="Reorder "]').first().dispatchEvent('dragstart');
  const frame = page.locator('[data-table-frame]');
  const box = await frame.boundingBox();
  if (box === null) throw new Error('the table frame has no drag geometry');
  for (let event = 0; event < 60; event += 1)
    await frame.dispatchEvent('dragover', { clientY: box.y + box.height - 1 });
  await expect(destination).toBeVisible();
  const destinationBox = await destination.boundingBox();
  if (destinationBox === null) throw new Error('the mounted drag destination has no geometry');
  await destination.dispatchEvent('dragover', {
    clientY: destinationBox.y + destinationBox.height / 2,
  });
  await expect(destination).toHaveAttribute('data-drop', 'into');
});

test('a windowed table and the complete Gantt stay on the same logical row', async ({ page }) => {
  const seeded = await seedRenderingPlan(page, { rows: 100, steps: 2, density: 'sparse' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  const labels = page.locator('[data-gantt-label]');
  await expect(labels).toHaveCount(100);
  await painted(page);
  const frame = page.locator('[data-table-frame]');
  const panel = page.locator('[data-gantt-panel]');

  const firstShown = async (surface: 'table' | 'gantt') =>
    page.evaluate((asked) => {
      const port = document.querySelector<HTMLElement>(
        asked === 'table' ? '[data-table-frame]' : '[data-gantt-panel]',
      );
      const heading = document.querySelector<HTMLElement>(
        asked === 'table' ? '[data-grid] thead th' : '[data-gantt-axis]',
      );
      if (port === null || heading === null) throw new Error(`${asked} face is absent`);
      const selector = asked === 'table' ? 'tr[data-row-id]' : '[data-gantt-label]';
      const row = [...port.querySelectorAll<HTMLElement>(selector)].find(
        (candidate) =>
          candidate.getBoundingClientRect().bottom > heading.getBoundingClientRect().bottom + 1,
      );
      if (row === undefined) throw new Error(`${asked} face shows no row`);
      return asked === 'table' ? row.dataset['rowId'] : row.dataset['ganttLabel'];
    }, surface);

  await frame.evaluate((node) => {
    node.scrollTop = 50 * 28;
  });
  await painted(page);
  const tableFromFrame = await firstShown('table');
  const tableIndex = seeded.ids.indexOf(tableFromFrame ?? '');
  await expect
    .poll(async () => seeded.ids.indexOf((await firstShown('gantt')) ?? ''))
    .toBe(tableIndex);
  expect(tableIndex).toBeGreaterThan(40);

  await panel.evaluate((node) => {
    node.scrollTop = 70 * 28;
  });
  await painted(page);
  const ganttIndex = seeded.ids.indexOf((await firstShown('gantt')) ?? '');
  await expect
    .poll(async () => seeded.ids.indexOf((await firstShown('table')) ?? ''))
    .toBe(ganttIndex);

  const alignedId = seeded.ids[ganttIndex];
  const alignedLabel = page.locator(`[data-gantt-label="${alignedId}"]`);
  await alignedLabel.hover();
  await expect(page.locator(`tr[data-row-id="${alignedId}"]`)).toHaveAttribute(
    'data-row-lit',
    'true',
  );
  const label = await labels.nth(ganttIndex).boundingBox();
  const following = await labels.nth(ganttIndex + 1).boundingBox();
  if (label === null || following === null)
    throw new Error('aligned Gantt labels have no geometry');
  expect(Math.abs(following.y - label.y - 28)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1200, height: 800 });
  await painted(page);
  await frame.evaluate((node) => {
    node.scrollTop = 60 * 28;
  });
  await painted(page);
  const tableAfterResize = seeded.ids.indexOf((await firstShown('table')) ?? '');
  await expect
    .poll(async () => seeded.ids.indexOf((await firstShown('gantt')) ?? ''))
    .toBe(tableAfterResize);

  const saving = page.waitForEvent('download');
  await page.locator('[data-gantt-svg-download]').click();
  const saved = await saving;
  const file = await readFile(await saved.path(), 'utf8');
  expect(file).toContain('Row 0000');
  expect(file).toContain('Row 0099 z');
});

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
                    const grid = document.querySelector('[data-grid]');
                    // Proof: asking for rows + 2 here failed this production measurement at
                    // `table readiness paint was not observed`.
                    if (
                      grid?.getAttribute('aria-rowcount') !== String(rows + 1) ||
                      grid.querySelector('tbody tr[data-row-id]') === null
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
                  await expect(measured.locator('[data-grid]')).toHaveAttribute(
                    'aria-rowcount',
                    String(rows + 1),
                    { timeout: 120_000 },
                  );
                  await expect(
                    measured.locator('[data-grid] tbody tr[data-row-id]').first(),
                  ).toBeVisible();
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
                  const calls = await cellRenderCalls(measured);
                  await record({ kind: 'precise-coverage', broadFindCellStyleCalls: calls });
                }
                if (phase === 'gantt') {
                  await measured.getByLabel('Find', { exact: true }).fill('');
                  await expect(measured.locator('[data-grid]')).toHaveAttribute(
                    'aria-rowcount',
                    String(rows + 1),
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
