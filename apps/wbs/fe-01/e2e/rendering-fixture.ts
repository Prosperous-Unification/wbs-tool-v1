import { expect, type Page } from '@playwright/test';
import type { PlanCommandWire } from '@wbs/contracts';

import { createProject } from './create-project';
import { assertCommandResults, fixtureClient, fixtureSuccess } from './plan-fixture';

export interface RenderingSize {
  rows: number;
  steps: number;
  density: 'sparse' | 'dense';
}

/** A flat DAG with a declared, independently verified edge count. */
export function renderingEdges(
  rows: number,
  density: RenderingSize['density'],
): [number, number][] {
  const edges: [number, number][] = [];
  for (let successor = 1; successor < rows; successor += 1) {
    const count = density === 'dense' ? Math.min(8, successor) : successor % 10 === 0 ? 1 : 0;
    for (let previous = 1; previous <= count; previous += 1)
      edges.push([successor, successor - previous]);
  }
  return edges;
}

/** Seeds batches while the plan observer is unmounted, then verifies the actual server tree. */
export async function seedRenderingPlan(page: Page, size: RenderingSize) {
  const started = Date.now();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page, `Rendering ${String(size.rows)}/${String(size.steps)}/${size.density}`);
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('rendering fixture has no selected project');
  await page.goto('/directory');
  const client = fixtureClient(page);
  const project = fixtureSuccess(
    'getApiProjectsById',
    await client.getApiProjectsById({ params: { id: projectId } }),
  ).body;
  expect(project.steps).toHaveLength(2);
  for (let index = 2; index < size.steps; index += 1) {
    const answer = fixtureSuccess(
      'postApiProjectsByIdSteps',
      await client.postApiProjectsByIdSteps({
        params: { id: projectId },
        body: { name: `Step ${String(index + 1)}` },
      }),
    );
    project.steps.push(answer.body.step);
  }
  const ids: string[] = [];
  for (let start = 0; start < size.rows; start += 200) {
    const count = Math.min(200, size.rows - start);
    const commands: PlanCommandWire[] = Array.from({ length: count }, (_, offset) => ({
      kind: 'createWorkItem',
      ref: `row${String(offset)}`,
      parentId: null,
      ...(offset === 0
        ? { afterId: ids.at(-1) ?? null }
        : { afterRef: `row${String(offset - 1)}` }),
      name: `Row ${String(start + offset).padStart(4, '0')}${start + offset === size.rows - 1 ? ' z' : ''}`,
    }));
    const answer = fixtureSuccess(
      'postApiProjectsByIdCommands',
      await client.postApiProjectsByIdCommands({
        params: { id: projectId },
        body: { commands },
      }),
    ).body;
    const created = assertCommandResults('rendering create rows', commands, answer.results);
    for (let index = 0; index < count; index += 1) ids.push(created[`row${String(index)}`]);
  }
  const estimates: PlanCommandWire[] = ids.flatMap((id) =>
    project.steps.map((step) => ({
      kind: 'setEstimate',
      workItemId: id,
      stepId: step.id,
      days: { optimistic: 1, realistic: 2, pessimistic: 3 },
    })),
  );
  const edges = renderingEdges(size.rows, size.density);
  const dependencies: PlanCommandWire[] = edges.map(([successor, predecessor]) => ({
    kind: 'addDependency',
    workItemId: ids[successor],
    predecessorId: ids[predecessor],
  }));
  for (const commands of [estimates, dependencies]) {
    for (let start = 0; start < commands.length; start += 200) {
      const batch = commands.slice(start, start + 200);
      const answer = fixtureSuccess(
        'postApiProjectsByIdCommands',
        await client.postApiProjectsByIdCommands({
          params: { id: projectId },
          body: { commands: batch },
        }),
      ).body;
      assertCommandResults('rendering authored commands', batch, answer.results);
    }
  }
  const tree = fixtureSuccess(
    'getApiProjectsByIdWork-items',
    await client['getApiProjectsByIdWork-items']({ params: { id: projectId } }),
  ).body;
  expect(tree.workItems.map((row) => row.id)).toEqual(ids);
  expect(tree.steps.map(({ id, name }) => ({ id, name }))).toEqual(
    project.steps.map(({ id, name }) => ({ id, name })),
  );
  const expectedDays = { optimistic: 1, realistic: 2, pessimistic: 3 };
  for (const [index, row] of tree.workItems.entries()) {
    // Proof: changing one real outgoing estimate to 8/9/10 made the named
    // rendering estimate assertion refuse before geometry was sampled.
    for (const step of project.steps)
      expect(row.estimates[step.id], `rendering estimate ${String(index)}/${step.name}`).toEqual(
        expectedDays,
      );
    const predecessors = edges
      .filter(([successor]) => successor === index)
      .map(([, predecessor]) => ids[predecessor])
      .sort();
    // Proof: redirecting the real sparse edge 10→9 to 10→0 preserved the
    // edge count and made this endpoint assertion refuse before geometry.
    expect([...row.dependsOn].sort(), `rendering dependencies for row ${String(index)}`).toEqual(
      predecessors,
    );
  }
  return { ...size, projectId, ids, edges: edges.length, setupMs: Date.now() - started };
}

/** Read once after layout; mounted counts are not computed from a virtualizer's range. */
export function renderingGeometry(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-table-frame]');
    if (frame === null) throw new Error('rendering measurement has no table frame');
    const box = frame.getBoundingClientRect();
    // Proof: removing this guard made `rendering measurement refuses a frame
    // with no layout area` resolve width0/height0 instead of rejecting.
    if (box.width <= 0 || box.height <= 0)
      throw new Error('rendering measurement has empty frame geometry');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-grid] tbody tr[data-row-id]')];
    const cells = [...document.querySelectorAll<HTMLElement>('[data-grid] tbody td[data-column]')];
    const intersects = (node: HTMLElement) => {
      const cell = node.getBoundingClientRect();
      return (
        cell.width > 0 &&
        cell.height > 0 &&
        cell.right > box.left &&
        cell.left < box.right &&
        cell.bottom > box.top &&
        cell.top < box.bottom
      );
    };
    return {
      mountedRows: rows.length,
      mountedCells: cells.length,
      intersectingRows: rows.filter(intersects).length,
      intersectingCells: cells.filter(intersects).length,
      headers: document.querySelectorAll('[data-grid] th[data-column]').length,
      width: box.width,
      height: box.height,
      scrollTop: frame.scrollTop,
      scrollLeft: frame.scrollLeft,
      columns: [...document.querySelectorAll<HTMLElement>('[data-grid] th[data-column]')].map(
        (node) => ({ id: node.dataset['column'], width: node.getBoundingClientRect().width }),
      ),
      rowHeights: rows.slice(0, 3).map((row) => row.getBoundingClientRect().height),
    };
  });
}

/** Two animation frames mark an opportunity to paint, not compositor presentation. */
export function painted(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve(performance.now());
          }),
        );
      }),
  );
}
