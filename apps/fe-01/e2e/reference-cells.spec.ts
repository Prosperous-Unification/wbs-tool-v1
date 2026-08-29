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

/** One batch on a project, answering the id each command created (by index). */
async function commands(
  page: Page,
  projectId: string,
  list: Record<string, unknown>[],
): Promise<(string | undefined)[]> {
  const answer = await jsonPost<{ results: { id?: string }[] }>(
    page,
    `/api/projects/${projectId}/commands`,
    { commands: list },
  );
  return answer.results.map((each) => each.id);
}

/** One directory batch, answering the entry each command created (by index). */
async function directoryCommands<T>(page: Page, list: Record<string, unknown>[]): Promise<T[]> {
  const answer = await jsonPost<{ results: { entity?: T }[] }>(page, '/api/directory/commands', {
    commands: list,
  });
  return answer.results.map((each) => {
    if (each.entity === undefined) throw new Error('a directory create answered no entry');
    return each.entity;
  });
}

async function seed(page: Page): Promise<Seed> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();

  await expect.poll(() => page.evaluate(() => localStorage.getItem('wbs.project'))).not.toBeNull();
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id after creating the plan');
  // Four rows in one batch, each placed after the one before it by ref.
  await commands(
    page,
    projectId,
    ['010', '020', '030', '040'].map((number, at) => ({
      kind: 'createWorkItem',
      ref: number,
      parentId: null,
      ...(at === 0 ? { afterId: null } : { afterRef: ['010', '020', '030', '040'][at - 1] }),
      name: `Reference ${number}`,
    })),
  );

  const make = (kind: 'createTeam' | 'createTag' | 'createService', names: string[]) =>
    directoryCommands<Entry>(
      page,
      names.map((name) => ({ kind, name })),
    );
  const teams = await make('createTeam', ['Platform', 'Release', 'Support']);
  const tags = await make('createTag', ['Ready', 'Risk', 'Review']);
  const services = await make('createService', ['Billing', 'Identity', 'Search']);

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

  await commands(page, projectId, [
    { kind: 'createWorkItem', parentId: id010, afterId: null, name: 'Inherited reference child' },
    {
      kind: 'patchWorkItem',
      workItemId: id010,
      patch: {
        teamIds: teams.slice(0, 2).map(({ id }) => id),
        tagIds: tags.slice(0, 2).map(({ id }) => id),
        serviceIds: services.slice(0, 2).map(({ id }) => id),
      },
    },
    { kind: 'addDependency', workItemId: id040, predecessorId: id010 },
    { kind: 'addDependency', workItemId: id040, predecessorId: id020 },
  ]);
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
  await page.getByRole('button', { name: 'local-dev' }).click();
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

async function showReferenceColumns(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  for (const label of ['Teams', 'Tags', 'Services', 'Depends on']) {
    await page.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await page.getByText('Columns', { exact: true }).click();
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
  await showReferenceColumns(page);
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

test.describe('390x844 reference sheets', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('round-trips three reachable values, inherited context, and light/dark paint', async ({
    page,
  }) => {
    const seeded = await seed(page);
    const parent = page.getByRole('article', { name: 'Work item 010', exact: true });
    const fields = [
      {
        kind: 'team',
        label: 'Service or team for 010',
        trigger: '[data-card-team-field]',
        entries: seeded.teams,
      },
      {
        kind: 'tag',
        label: 'Tags for 010',
        trigger: '[data-card-tags-field]',
        entries: seeded.tags,
      },
      {
        kind: 'service',
        label: 'Services for 010',
        trigger: '[data-card-service-field]',
        entries: seeded.services,
      },
    ] as const;

    const openSheet = async (field: (typeof fields)[number], owner = parent) => {
      await owner.locator(field.trigger).click();
      const dialog = page.getByRole('dialog', { name: `Edit ${field.label}` });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const closeSheet = async (field: (typeof fields)[number], dialog: Locator) => {
      await dialog.getByRole('button', { name: `Close ${field.label}` }).click();
      await expect(dialog).toBeHidden();
    };

    for (const field of fields) {
      const dialog = await openSheet(field);
      const box = dialog.getByRole('combobox', { name: field.label, exact: true });
      await box.fill(field.entries[2].name);
      await dialog.getByRole('option', { name: field.entries[2].name, exact: true }).click();
      await expect(dialog).toBeHidden();
    }

    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    let dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await expect(dependsDialog).toBeVisible();
    await dependsDialog.getByLabel('Add a dependency to 040').fill('030');
    await dependsDialog.locator('[data-card-depends-option="030"]').click();
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(3);
    await page.keyboard.press('Escape');

    await page.reload();

    for (const palette of ['Light', 'Dark'] as const) {
      await chooseTheme(page, palette);
      for (const field of fields) {
        const dialog = await openSheet(field);
        const root = dialog.locator(`[data-reference-set="${field.kind}"]`);
        await assertReachablePaint(page, [root]);
        const sheet = await dialog.boundingBox();
        expect(sheet, `${field.kind} sheet has no painted box`).not.toBeNull();
        expect(sheet!.x, `${field.kind} sheet clips left`).toBeGreaterThanOrEqual(0);
        expect(sheet!.x + sheet!.width, `${field.kind} sheet clips right`).toBeLessThanOrEqual(390);
        expect(sheet!.y + sheet!.height, `${field.kind} sheet clips below`).toBeLessThanOrEqual(
          844,
        );
        await closeSheet(field, dialog);
      }

      await page.getByRole('button', { name: 'Depends on for 040' }).click();
      dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
      await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(3);
      for (const row of await dependsDialog.locator('[data-card-wait]').all()) {
        await expect(row).toBeVisible();
        await expect(row).toBeInViewport();
      }
      expect(
        await dependsDialog.evaluate((dialog) =>
          [...dialog.querySelectorAll('button')]
            .filter((button) => button.getClientRects().length > 0)
            .filter((button) => getComputedStyle(button).backgroundColor === 'rgb(239, 239, 239)')
            .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ),
        'the dependency sheet exposes a native grey button face',
      ).toEqual([]);
      await page.keyboard.press('Escape');
    }

    const inherited = page.locator('article[data-card]').filter({
      has: page.locator('[data-inherited]'),
    });
    await expect(inherited).toHaveCount(1);
    for (const field of fields) {
      const dialog = await openSheet(field, inherited);
      await expect(dialog.locator('[data-reference-inherited]')).toContainText('from 010');
      await closeSheet(field, dialog);
    }

    for (const field of fields) {
      const dialog = await openSheet(field);
      await dialog
        .getByRole('button', { name: `Remove ${field.entries[0].name} from 010` })
        .click();
      await expect(dialog.locator(`[data-reference-chip="${field.entries[0].id}"]`)).toHaveCount(0);
      await closeSheet(field, dialog);
    }
    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await dependsDialog.getByRole('button', { name: 'Stop 040 waiting for 010' }).click();
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await page.reload();

    for (const field of fields) {
      const dialog = await openSheet(field);
      const root = dialog.locator(`[data-reference-set="${field.kind}"]`);
      await expect(root.locator(`[data-reference-chip="${field.entries[0].id}"]`)).toHaveCount(0);
      await expect(root.locator(`[data-reference-chip="${field.entries[1].id}"]`)).toBeVisible();
      await expect(root.locator(`[data-reference-chip="${field.entries[2].id}"]`)).toBeVisible();
      await closeSheet(field, dialog);
    }
    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(2);
    await expect(dependsDialog.locator('[data-card-wait="010"]')).toHaveCount(0);
  });
});
