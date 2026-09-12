import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * `work-item-status-and-facts` and `status-at-a-glance` in a browser: choosing
 * Done in the Status cell asks for the day in the completion prompt, and
 * confirming it strikes the row through, paints the status strip and the done
 * tint on it — pinned cells included — fills the Fact end with the day
 * confirmed, and stops the row's bar on the chart inside that day's axis cell,
 * whatever the estimate said.
 *
 * The plan is dated **weeks in the past** with a long estimate, so the engine's
 * finish stands well past today and the clip has something to clip. Every
 * assertion below is about what the browser drew, not what the payload said:
 * the unit suites hold the payload.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The reader's own calendar day, as the app reads it — local, never UTC. */
function localIsoDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}

/** `shortIsoDate`'s reading of a day in the reader's own year: `12 Sep`. */
function shortDay(iso: string): string {
  const month = MONTHS.at(Number(iso.slice(5, 7)) - 1);
  if (month === undefined) throw new Error(`not a day: ${iso}`);
  return `${String(Number(iso.slice(8, 10)))} ${month}`;
}

/**
 * A Monday some weeks back, so the plan's first day and today are both on the
 * axis **and on screen**: the chart renders only the days in its viewport, so a
 * plan that reaches further than the window has cells nothing can measure.
 */
/**
 * The workday a fact end on `day` is drawn on: the day itself, or the Friday
 * before a weekend — `factEndStopOf` rolls back, so a run on a Saturday still
 * stops its bar in Friday's cell.
 */
function workdayOnOrBefore(iso: string): string {
  const at = new Date(`${iso}T12:00:00`);
  while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() - 1);
  return localIsoDay(at);
}

function mondayWeeksAgo(weeks: number): string {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() - weeks * 7);
  while (at.getDay() !== 1) at.setDate(at.getDate() - 1);
  return localIsoDay(at);
}

async function setDate(page: Page, label: string, day: string): Promise<void> {
  const box = page.getByLabel(label);
  await box.fill(day);
  await box.blur();
}

/** Turns a hidden column on from the `Columns` control and waits for its header. */
async function showColumn(page: Page, label: string, columnId: string): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: label }).check();
  await expect(page.locator(`thead th[data-column="${columnId}"]`)).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
}

/** One dated root whose Dev estimate reaches a fortnight past today. */
async function seedALongRow(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page, 'Status browser evidence');
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
  await setDate(page, 'Project start date', mondayWeeksAgo(2));
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  const estimate = page.getByLabel('Dev estimate for 010');
  await estimate.fill('20');
  await estimate.blur();
  await expect(estimate).not.toHaveValue('');
}

async function openTheChart(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('[data-gantt-chart]')).toBeVisible();
  await expect(page.locator('[data-gantt-bar]').first()).toBeVisible();
}

/** A positive-area browser box or a failure naming the mark that vanished. */
async function boxOf(mark: Locator, name: string): Promise<{ left: number; right: number }> {
  const box = await mark.boundingBox();
  if (box === null) throw new Error(`${name} has no browser box`);
  expect(box.width, `${name} has no rendered width`).toBeGreaterThan(0);
  return { left: box.x, right: box.x + box.width };
}

test.describe('marking a row done, in a browser', () => {
  test('asks for the day, then strikes and tints the row, fills the fact end and stops the bar', async ({
    page,
  }, testInfo) => {
    await seedALongRow(page);
    await showColumn(page, 'Status', 'status');
    await showColumn(page, 'Fact end', 'fact-end');
    await openTheChart(page);

    const before = await page.locator('[data-gantt-bar]').first().getAttribute('data-finish');
    if (before === null) throw new Error('the seeded bar carries no finish');
    await expect(page.locator('[data-gantt-bar][data-done="true"]')).toHaveCount(0);

    const status = page.getByRole('combobox', { name: 'Status of 010' });
    await expect(status).toHaveAttribute('data-status-value', 'unknown');
    const row = page.locator('tbody tr[data-row-id]').first();
    const dragCell = row.locator('td[data-column="drag"]');
    const pinnedCell = row.locator('td[data-column="number"]');
    const unpinnedCell = row.locator('td[data-column="depends"]');
    const paintOf = (cell: Locator) =>
      cell.evaluate((node) => {
        const style = getComputedStyle(node);
        return { shadow: style.boxShadow, layer: style.backgroundImage };
      });
    // Before: no strip on the drag cell, and the tint layer is there but clear.
    const atRest = await paintOf(dragCell);
    expect(atRest.shadow, 'an unknown row already wears a strip').not.toMatch(
      /3px 0px 0px 0px inset/,
    );
    expect((await paintOf(pinnedCell)).layer).toMatch(/linear-gradient\(rgba\(0, 0, 0, 0\)/);

    const chooseDone = async (): Promise<void> => {
      await status.click();
      await page
        .getByRole('listbox', { name: 'Status for 010' })
        .getByRole('option', { name: 'Done' })
        .click();
    };
    // The browser's own day, not this process's: Playwright runs Chromium in
    // UTC while the runner keeps the host's zone, and after 21:00 in Kyiv the
    // two are a day apart. The day the prompt offers and the day the Fact end
    // shows are both the browser's.
    const today = await page.evaluate(() => {
      const at = new Date();
      const month = String(at.getMonth() + 1).padStart(2, '0');
      const day = String(at.getDate()).padStart(2, '0');
      return `${String(at.getFullYear())}-${month}-${day}`;
    });

    // Done asks first. Escape leaves the row as it was and puts the focus back
    // in the cell that asked — the one focus question jsdom cannot answer.
    await chooseDone();
    const prompt = page.getByRole('dialog', { name: 'Mark 010 done' });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel('Finished on')).toHaveValue(today);
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect(status).toHaveAttribute('data-status-value', 'unknown');
    await expect(status).toBeFocused();

    await chooseDone();
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Mark done' }).click();

    await expect(status).toHaveAttribute('data-status-value', 'done');
    await expect(page.getByLabel('Fact end of 010')).toHaveValue(shortDay(today));
    await expect(page.locator('tbody tr[data-row-done="true"]')).toHaveCount(1);
    await expect(row).toHaveAttribute('data-row-status', 'done');
    // The strip, drawn as the drag cell's inset shadow beside the separator …
    expect((await paintOf(dragCell)).shadow).toMatch(/3px 0px 0px 0px inset/);
    // … and the tint on a pinned and an unpinned cell alike: both carry the
    // layer, and neither layer is clear any more.
    // Proof: the gradient dropped from `ROW_BACKGROUND` in `table-frame.ts`,
    // and the run fails at the pinned cell's at-rest check above — `Expected
    // pattern: /linear-gradient\(rgba\(0, 0, 0, 0\)/ · Received string: "none"`
    // — a pinned cell with no layer for the tint to land in while the cells
    // beside it carry one; watched in Chromium 2026-09-13.
    for (const [cell, name] of [
      [pinnedCell, 'pinned'],
      [unpinnedCell, 'unpinned'],
    ] as const) {
      const painted = await paintOf(cell);
      expect(painted.layer, `the ${name} cell has no tint layer`).toMatch(/linear-gradient/);
      expect(painted.layer, `the ${name} cell's tint is clear`).not.toMatch(/rgba\(0, 0, 0, 0\)/);
    }
    const struck = await page
      .locator('tbody tr[data-row-done="true"] td[data-column="name"] [data-cell]')
      .first()
      .evaluate((cell) => getComputedStyle(cell).textDecorationLine);
    expect(struck, 'the done row’s name is not struck through').toContain('line-through');

    // One bar for the row, done, stopping earlier than the estimate did …
    const bar = page.locator('[data-gantt-bar][data-done="true"]');
    await expect(bar).toHaveCount(1);
    await expect(page.locator('[data-gantt-bar]')).toHaveCount(1);
    const after = await bar.getAttribute('data-finish');
    if (after === null) throw new Error('the done bar carries no finish');
    expect(Number(after), 'the done bar reaches as far as the estimate did').toBeLessThan(
      Number(before),
    );
    // … and its right edge inside the fact end's axis cell — today's, or the
    // Friday's on a weekend run — within a pixel of nudge.
    const drawn = await boxOf(bar, 'the done bar');
    const factDay = workdayOnOrBefore(today);
    const factCell = await boxOf(
      page.locator(`[data-axis-date="${factDay}"]`),
      `the axis cell of ${factDay}`,
    );
    expect(drawn.right, 'the done bar stops before the fact end’s cell').toBeGreaterThan(
      factCell.left,
    );
    expect(drawn.right, 'the done bar reaches past the fact end’s cell').toBeLessThanOrEqual(
      factCell.right + 1,
    );
    await expect(bar).toHaveAttribute('aria-label', /Done — drawn over what happened/);
    // The picture, for whoever reads the run: the struck row, the filled fact
    // end, and the done bar with its mark — what the assertions above measured.
    const shot = testInfo.outputPath('done-row.png');
    await page.screenshot({ path: shot });
    await testInfo.attach('the done row and its bar', { path: shot, contentType: 'image/png' });
  });
});
