import { expect, test } from '@playwright/test';

import { createProject } from './create-project';
import { fixtureClient, fixtureSuccess } from './plan-fixture';
import { renderingGeometry, seedRenderingPlan } from './rendering-fixture';

test.afterEach(async ({ page }) => {
  // Wait for route.fetch() and response.json() before Playwright tears down
  // the page and disposes the handler's APIResponse underneath that read.
  await page.unrouteAll({ behavior: 'wait' });
});

test('rendering setup reports an actual backend refusal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await expect(
    fixtureClient(page)
      .postApiProjectsByIdCommands({
        params: { id: 'missing-rendering-project' },
        body: { commands: [{ kind: 'createWorkItem', name: 'Refused' }] },
      })
      .then((reply) => fixtureSuccess('postApiProjectsByIdCommands', reply)),
  ).rejects.toThrow(/postApiProjectsByIdCommands refused.*not_found/);
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
    'rendering create rows result at 0 has no id for row0',
  );
});

test('rendering setup refuses a wrong authored result index before its tree read', async ({
  page,
}) => {
  let treeReads = 0;
  let authoredBatches = 0;
  let corrupted = false;
  await page.route('**/api/projects/*/work-items', async (route) => {
    if (corrupted) treeReads += 1;
    await route.continue();
  });
  await page.route('**/api/projects/*/commands', async (route) => {
    const request = route.request().postDataJSON() as { commands: { kind: string }[] };
    if (request.commands.every((command) => command.kind === 'createWorkItem')) {
      await route.continue();
      return;
    }
    authoredBatches += 1;
    const response = await route.fetch();
    const answer = (await response.json()) as { results: { index: number }[] };
    answer.results[0].index = 999;
    corrupted = true;
    await route.fulfill({ response, json: answer });
  });
  await expect(seedRenderingPlan(page, { rows: 2, steps: 2, density: 'sparse' })).rejects.toThrow(
    'rendering authored commands result at 0 has index 999, expected 0',
  );
  expect(authoredBatches).toBe(1);
  expect(treeReads).toBe(0);
});

test('rendering setup refuses an altered estimate value', async ({ page }) => {
  let alteredEstimates = 0;
  let treeReads = 0;
  await page.route('**/api/projects/*/work-items', async (route) => {
    if (alteredEstimates > 0) treeReads += 1;
    await route.continue();
  });
  await page.route('**/api/projects/*/commands', async (route) => {
    const request = route.request().postDataJSON() as { commands: Record<string, unknown>[] };
    const commands = request.commands.map((command) => ({ ...command }));
    const estimate = commands.find((command) => command['kind'] === 'setEstimate');
    if (estimate !== undefined && alteredEstimates === 0) {
      estimate['days'] = { optimistic: 8, realistic: 9, pessimistic: 10 };
      alteredEstimates += 1;
      const response = await route.fetch({ postData: JSON.stringify({ commands }) });
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await expect(seedRenderingPlan(page, { rows: 2, steps: 2, density: 'sparse' })).rejects.toThrow(
    /rendering estimate 0\//,
  );
  expect(alteredEstimates).toBe(1);
  expect(treeReads).toBe(1);
});

test('rendering setup refuses a redirected dependency endpoint', async ({ page }) => {
  const createdIds: string[] = [];
  let redirectedEdges = 0;
  let treeReads = 0;
  await page.route('**/api/projects/*/work-items', async (route) => {
    if (redirectedEdges > 0) treeReads += 1;
    await route.continue();
  });
  await page.route('**/api/projects/*/commands', async (route) => {
    const request = route.request().postDataJSON() as { commands: Record<string, unknown>[] };
    if (request.commands.every((command) => command['kind'] === 'createWorkItem')) {
      const response = await route.fetch();
      const answer = (await response.json()) as { results: { id?: string }[] };
      for (const created of answer.results) {
        if (typeof created.id === 'string') createdIds.push(created.id);
      }
      await route.fulfill({ response, json: answer });
      return;
    }
    const commands = request.commands.map((command) => ({ ...command }));
    const dependency = commands.find((command) => command['kind'] === 'addDependency');
    if (dependency !== undefined) {
      const predecessorId = createdIds.at(0);
      if (predecessorId === undefined) throw new Error('edge fault has no first created row');
      dependency['predecessorId'] = predecessorId;
      redirectedEdges += 1;
      const response = await route.fetch({ postData: JSON.stringify({ commands }) });
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await expect(seedRenderingPlan(page, { rows: 11, steps: 2, density: 'sparse' })).rejects.toThrow(
    'rendering dependencies for row 10',
  );
  expect(redirectedEdges).toBe(1);
  expect(treeReads).toBe(1);
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
