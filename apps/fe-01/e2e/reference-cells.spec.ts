import { expect, type Locator, type Page, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

interface Entry {
  id: string;
  name: string;
}
interface Seed {
  teams: Entry[];
  tags: Entry[];
  services: Entry[];
}

async function jsonPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  return page.evaluate(
    async ({ at, value }) => {
      const response = await fetch(at, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`POST ${at} failed: ${String(response.status)}`);
      return response.json() as Promise<T>;
    },
    { at: path, value: body },
  );
}

async function patch(page: Page, path: string, body: unknown): Promise<void> {
  await page.evaluate(
    async ({ at, value }) => {
      const response = await fetch(at, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`PATCH ${at} failed: ${String(response.status)}`);
    },
    { at: path, value: body },
  );
}

async function seed(page: Page): Promise<Seed> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();

  const add = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030', '040']) {
    await add.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
    await page.getByLabel(`Name of ${number}`).fill(`Reference ${number}`);
    await page.getByLabel(`Name of ${number}`).blur();
  }

  const make = async (path: string, names: string[], key: 'team' | 'tag' | 'service') =>
    Promise.all(
      names.map(async (name) => {
        const made = await jsonPost<Record<'team' | 'tag' | 'service', Entry>>(page, path, {
          name,
        });
        return made[key];
      }),
    );
  const [teams, tags, services] = await Promise.all([
    make('/api/teams', ['Platform', 'Release', 'Support'], 'team'),
    make('/api/tags', ['Ready', 'Risk', 'Review'], 'tag'),
    make('/api/services', ['Billing', 'Identity', 'Search'], 'service'),
  ]);

  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id after creating the plan');
  const tree = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/work-items`);
    return response.json() as Promise<{ workItems: { id: string; number: string }[] }>;
  }, projectId);
  const byNumber = new Map(tree.workItems.map((row) => [row.number, row.id]));
  const id010 = byNumber.get('010');
  const id020 = byNumber.get('020');
  const id030 = byNumber.get('030');
  const id040 = byNumber.get('040');
  if (id010 === undefined || id020 === undefined || id030 === undefined || id040 === undefined)
    throw new Error('the four reference rows were not created');

  await jsonPost(page, `/api/projects/${projectId}/work-items`, {
    parentId: id010,
    afterId: null,
    name: 'Inherited reference child',
  });
  await patch(page, `/api/work-items/${id010}`, {
    teamIds: teams.slice(0, 2).map(({ id }) => id),
    tagIds: tags.slice(0, 2).map(({ id }) => id),
    serviceIds: services.slice(0, 2).map(({ id }) => id),
  });
  for (const predecessorId of [id010, id020]) {
    await jsonPost(page, `/api/work-items/${id040}/dependencies`, { predecessorId });
  }
  await page.reload();
  return { teams, tags, services };
}

async function choose(page: Page, label: string, name: string): Promise<void> {
  const box = page.getByRole('combobox', { name: label, exact: true });
  await box.click();
  await box.fill(name);
  await page.getByRole('option', { name, exact: true }).click();
}

async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => !['finished', 'idle'].includes(animation.playState)).length,
      ),
    )
    .toBe(0);
}

async function assertReachablePaint(page: Page, roots: Locator[]): Promise<void> {
  for (const root of roots) {
    const chips = root.locator('[data-reference-chip]');
    await expect(chips).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const chip = chips.nth(index);
      await expect(chip).toBeVisible();
      expect(
        await chip.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return box.width > 0 && box.height > 0 && hit !== null && node.contains(hit);
        }),
        `reference chip ${String(index + 1)} is clipped or covered`,
      ).toBe(true);
    }
  }
  expect(
    await page.evaluate(() => {
      const unnamed = new Set(['rgb(239, 239, 239)', 'rgb(107, 107, 107)']);
      return [...document.querySelectorAll('[data-reference-set] button')]
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) => unnamed.has(getComputedStyle(node).backgroundColor))
        .map((node) => node.getAttribute('aria-label') ?? node.textContent);
    }),
  ).toEqual([]);
}

test('round-trips every desktop reference set with three reachable values in both palettes', async ({
  page,
}) => {
  const seeded = await seed(page);
  await choose(page, 'Service or team for 010', seeded.teams[2].name);
  await choose(page, 'Tags for 010', seeded.tags[2].name);
  await choose(page, 'Services for 010', seeded.services[2].name);
  const depends = page.getByLabel('Add a dependency to 040');
  await depends.click();
  await depends.fill('030');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: /^Stop 040 waiting for / })).toHaveCount(3);

  await page.reload();
  const roots = (['team', 'tag', 'service'] as const).map((kind) =>
    page
      .locator(`[data-reference-set="${kind}"]`)
      .filter({
        has: page.locator('[data-reference-chip]'),
      })
      .first(),
  );
  await expect(
    page
      .locator('[data-reference-inherited]')
      .filter({ hasText: /Inherited:/ })
      .first(),
  ).toBeVisible();
  for (const palette of ['Light', 'Dark'] as const) {
    await chooseTheme(page, palette);
    await assertReachablePaint(page, roots);
    await page.getByLabel('Add a dependency to 040').locator('xpath=ancestor::td').hover();
    await expect(
      page
        .getByRole('tooltip', { name: 'What 040 waits for' })
        .locator('[data-depends-card-target]'),
    ).toHaveCount(3);
    await page.mouse.move(0, 0);
  }

  await page.getByRole('button', { name: `Remove ${seeded.teams[0].name} team` }).click();
  await page.getByRole('button', { name: `Remove ${seeded.tags[0].name} from 010` }).click();
  await page.getByRole('button', { name: `Remove ${seeded.services[0].name} from 010` }).click();
  await page.getByRole('button', { name: 'Stop 040 waiting for 010' }).click();
  await page.reload();

  for (const [kind, entries] of [
    ['team', seeded.teams],
    ['tag', seeded.tags],
    ['service', seeded.services],
  ] as const) {
    const root = page
      .locator(`[data-reference-set="${kind}"]`)
      .filter({ has: page.locator('[data-reference-chip]') })
      .first();
    await expect(root.locator(`[data-reference-chip="${entries[0].id}"]`)).toHaveCount(0);
    await expect(root.locator(`[data-reference-chip="${entries[1].id}"]`)).toBeVisible();
    await expect(root.locator(`[data-reference-chip="${entries[2].id}"]`)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /^Stop 040 waiting for / })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Stop 040 waiting for 010' })).toHaveCount(0);
});
