import { expect, type Page, test } from '@playwright/test';

import type { PlanRead } from '../src/lib/wbs-api';
import { createProject } from './create-project';

async function datedPlan(page: Page): Promise<{ refuseNextRead: () => void }> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();

  let unavailable = false;
  await page.route('**/api/projects/*/work-items', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    if (unavailable) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        json: { error: 'engine_unavailable', engine: 'optimized' },
      });
      return;
    }
    const response = await route.fetch();
    const plan = (await response.json()) as PlanRead;
    const row = plan.workItems.at(0);
    if (row === undefined) throw new Error('the dated-plan fixture has no work item');
    await route.fulfill({
      response,
      json: {
        ...plan,
        startDate: '2026-09-07',
        workItems: [
          { ...row, dates: { startsOn: '2026-09-07', endsOn: '2026-09-08' } },
          ...plan.workItems.slice(1),
        ],
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  return { refuseNextRead: () => (unavailable = true) };
}

test('names an unavailable optimizer over the last installed dates', async ({ page }) => {
  const { refuseNextRead } = await datedPlan(page);
  const row = page.locator('tbody tr').filter({ has: page.getByLabel('Name of 010') });
  const start = row.locator('td[data-column="start"]');
  await expect(start).toHaveAttribute('data-start-said', /^2026-09-07/);

  refuseNextRead();
  const name = page.getByLabel('Name of 010');
  await name.fill('Committed before optimizer refusal');
  await name.blur();

  const stale = page.locator('[data-stale-tree]');
  await expect(stale).toContainText('Optimized scheduling is unavailable in this runtime.');
  await expect(start).toHaveAttribute('data-start-said', /^2026-09-07/);
});
