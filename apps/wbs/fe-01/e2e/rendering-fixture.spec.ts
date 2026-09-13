import { expect, test } from '@playwright/test';

import { createProject } from './create-project';
import { renderingGeometry, renderingRequest, seedRenderingPlan } from './rendering-fixture';

test.afterEach(async ({ page }) => {
  // Wait for route.fetch() and response.json() before Playwright tears down
  // the page and disposes the handler's APIResponse underneath that read.
  await page.unrouteAll({ behavior: 'wait' });
});

test('rendering setup reports an actual backend refusal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await expect(
    renderingRequest(page, '/api/projects/missing-rendering-project/commands', {
      commands: [{ kind: 'createWorkItem', name: 'Refused' }],
    }),
  ).rejects.toThrow(/rendering fixture .*: 404/);
});

test('rendering setup refuses a successful batch without its row identity', async ({ page }) => {
  await page.route('**/api/projects/*/commands', async (route) => {
    const request = route.request().postDataJSON() as { commands: { kind: string }[] };
    if (!request.commands.every((command) => command.kind === 'createWorkItem')) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const answer = (await response.json()) as { results: Record<string, unknown>[] };
    for (const row of answer.results) delete row['id'];
    await route.fulfill({ response, json: answer });
  });
  await expect(seedRenderingPlan(page, { rows: 2, steps: 2, density: 'sparse' })).rejects.toThrow(
    'rendering fixture missing row identity 0',
  );
});

test('rendering measurement refuses a frame with no layout area', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page, 'Rendering geometry refusal');
  await expect(page.locator('[data-table-frame]')).toBeVisible();
  await page.locator('[data-table-frame]').evaluate((frame) => {
    frame.style.display = 'none';
  });
  await expect(renderingGeometry(page)).rejects.toThrow(
    'rendering measurement has empty frame geometry',
  );
});
