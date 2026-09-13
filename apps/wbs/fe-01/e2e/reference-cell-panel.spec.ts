import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The four reference cells' popover and its card, in a browser.
 *
 * **jsdom is the oracle for none of this.** Every claim here is about
 * something jsdom does not have: the focus a disabled control drops, a
 * `<td>`'s clip, the point an option is actually painted at, and a card that
 * is only a card because the browser laid it out. All three faults this file
 * covers were reported by Dany from real Chrome on 2026-08-31, and all three
 * were invisible to the 60-odd jsdom cases in `reference-set-field.test.tsx`.
 *
 * Its own file rather than lines in `reference-cells.spec.ts` for the reason
 * that file states about itself: it does not drive two cells of neighbouring
 * rows in one pass, and every case here drives one cell hard.
 */
test.use({ viewport: { width: 1400, height: 900 } });

interface Entry {
  id: string;
  name: string;
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

interface Seed {
  tags: Entry[];
  projectId: string;
}

/**
 * Three top-level rows, a child under the first, and three tags in the
 * directory — all three written onto `010`, and the first of them onto its
 * child as well.
 *
 * That last patch is what makes the child's card worth reading: since ADR 0008
 * tags **accumulate**, so a row that states one of its own still carries its
 * ancestor's, and the card has to put the two kinds in order and say where the
 * carried ones came from. A child that stated nothing would exercise only half
 * of it.
 *
 * Arranged through the API and not the UI for `reference-cells.spec.ts`'s
 * reason: an open picker is a panel over the row below, so a fixture that drove
 * one cell to arrange another would be measuring a page with a popover standing
 * on it. What each test drives is the one cell it is about.
 */
async function seed(page: Page): Promise<Seed> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('wbs.project'))).not.toBeNull();
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id after creating the plan');

  const numbers = ['010', '020', '030'];
  await jsonPost(page, `/api/projects/${projectId}/commands`, {
    commands: numbers.map((number, at) => ({
      kind: 'createWorkItem',
      ref: number,
      parentId: null,
      ...(at === 0 ? { afterId: null } : { afterRef: numbers[at - 1] }),
      name: `Reference ${number}`,
    })),
  });

  const answered = await jsonPost<{ results: { entity?: Entry }[] }>(
    page,
    '/api/directory/commands',
    {
      commands: ['Ready', 'Risk', 'Review'].map((name) => ({ kind: 'createTag', name })),
    },
  );
  const tags = answered.results.map((each) => {
    if (each.entity === undefined) throw new Error('a tag create answered no entry');
    return each.entity;
  });

  const tree = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/work-items`);
    return response.json() as Promise<{ workItems: { id: string; number: string }[] }>;
  }, projectId);
  const id010 = tree.workItems.find((row) => row.number === '010')?.id;
  if (id010 === undefined) throw new Error('010 was not created');

  await jsonPost(page, `/api/projects/${projectId}/commands`, {
    commands: [
      {
        kind: 'createWorkItem',
        ref: 'child',
        parentId: id010,
        afterId: null,
        name: 'Inherited child',
      },
      {
        kind: 'patchWorkItem',
        workItemId: id010,
        patch: { tagIds: tags.map(({ id }) => id) },
      },
      {
        kind: 'patchWorkItem',
        workItemRef: 'child',
        patch: { tagIds: [tags[0].id] },
      },
    ],
  });
  await page.reload();
  await showReferenceColumns(page);
  return { tags, projectId };
}

async function showReferenceColumns(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  for (const label of ['Teams', 'Tags', 'Services', 'Types']) {
    await page.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await page.getByText('Columns', { exact: true }).click();
}

/**
 * Whether the strip of `kind` on the row holding `label`'s box has left the
 * flow — which is the whole of "the add popover is open".
 *
 * `position` and not a screenshot, because leaving the flow is exactly what
 * the panel does and exactly what a stuck one keeps doing: the strip is
 * `absolute` while `editing` and `static` at rest (`reference-set-field.tsx`).
 * jsdom returns the inline value for either and can see the style flip without
 * ever seeing the focus that drives it, which is why this reads it in a
 * browser after a real gesture.
 */
async function panelIsOpen(page: Page, label: string): Promise<boolean> {
  return page
    .getByRole('combobox', { name: label, exact: true })
    .locator('xpath=ancestor::span[@data-reference-strip][1]')
    .evaluate((strip) => getComputedStyle(strip).position === 'absolute');
}

const focusedLabel = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '<none>');

/** The `<td>` a reference cell's box stands in, found by the box's own name. */
function cellOf(page: Page, label: string): Locator {
  return page.getByRole('combobox', { name: label, exact: true }).locator('xpath=ancestor::td[1]');
}

test('a landed take keeps the focus, and the panel closes when the focus leaves', async ({
  page,
}) => {
  const seeded = await seed(page);
  const tags = page.getByRole('combobox', { name: 'Tags for 020', exact: true });

  await tags.click();
  expect(await panelIsOpen(page, 'Tags for 020')).toBe(true);
  await tags.fill(seeded.tags[0].name);
  await page.getByRole('option', { name: seeded.tags[0].name, exact: true }).click();
  await expect(cellOf(page, 'Tags for 020').locator('[data-reference-chip]')).toHaveCount(1);

  // Proof: `readOnly` in `creatable-picker.tsx` put back to `disabled` — the
  // shape this shipped in until 2026-08-31 — and this line failed on
  // `Expected: "Tags for 020" / Received: "<none>"`. Chromium takes the focus
  // off a disabled control onto `<body>` inside React's commit of the very
  // update that disabled it, and React never runs the `onBlur`. Watched in
  // Chromium, 2026-08-31.
  expect(await focusedLabel(page), 'the take took the focus out of the box it was made in').toBe(
    'Tags for 020',
  );

  // …and because the focus is still there, the ordinary way out still works.
  //
  // Proof: the same fault, with the assertion above lifted out of the way so
  // this one is reached at all — `Expected: false / Received: true`, a panel
  // standing over the rows below that no click could take away, which is
  // Dany's report in one line. Watched in Chromium, 2026-08-31.
  await page.mouse.click(700, 8);
  expect(
    await panelIsOpen(page, 'Tags for 020'),
    'the add popover was still standing after a click outside it',
  ).toBe(false);
});

test('escape closes the list, and escape again leaves the cell', async ({ page }) => {
  await seed(page);
  const tags = page.getByRole('combobox', { name: 'Tags for 020', exact: true });

  await tags.click();
  await expect(page.getByRole('listbox', { name: 'Tags for 020' })).toBeVisible();

  // One press is the cheat sheet's promise, unchanged: the list goes, the box
  // stays.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Tags for 020' })).toHaveCount(0);
  expect(await focusedLabel(page)).toBe('Tags for 020');
  expect(await panelIsOpen(page, 'Tags for 020')).toBe(true);

  // Proof: the `e.currentTarget.blur()` branch deleted, leaving the bare
  // `setTyped(null)` this shipped with, and the first line below failed on
  // `Expected: "<none>" / Received: "Tags for 020"` — the second Escape doing
  // nothing at all, which is the half of the report that reads as "no Escape
  // out either". Watched in Chromium, 2026-08-31.
  await page.keyboard.press('Escape');
  expect(await focusedLabel(page), 'the second Escape did not leave the box').toBe('<none>');
  expect(await panelIsOpen(page, 'Tags for 020'), 'the panel outlived the focus').toBe(false);
});

test('the Types cell offers what is typed into it, on top of the row below', async ({ page }) => {
  await seed(page);
  const types = page.getByRole('combobox', { name: 'Types for 010', exact: true });

  await types.click();
  await types.fill('Bug');

  // The list is painted where a pointer can reach it. Asserted through the
  // browser's own hit test rather than through `toBeVisible`, because a list
  // clipped by its cell is still "visible" to Playwright — it has a box, and
  // the box is simply not where the pixels are.
  //
  // Proof: `'type'` taken back out of `POPOVER_COLUMNS` in `wbs-table.tsx` —
  // the shape the Types column shipped in — and this failed on `Expected: "Add
  // “Bug”" / Received: "Types for 010.1"`: the middle of the `Add “Bug”` line
  // lands on the **next row's** own box, because the cell's `overflow: clip`
  // ends 26px down. `toBeVisible` above passed with the fault in, which is why
  // it is not the check. Watched in Chromium, 2026-08-31.
  const offered = page.getByRole('option', { name: 'Add “Bug”', exact: true });
  await expect(offered).toBeVisible();
  expect(
    await offered.evaluate((line) => {
      const box = line.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (hit === null) return '<nothing>';
      // The name first, because what a clipped list is covered **by** is a box
      // whose `textContent` is the empty string. Read the other way round this
      // reported `Received: ""` and said nothing about what had taken the
      // pixels — measured, 2026-08-31.
      const named = hit.getAttribute('aria-label');
      if (named !== null) return named;
      return hit.textContent === '' ? hit.tagName : hit.textContent;
    }),
    'the offered line is not the thing painted where it stands',
  ).toBe('Add “Bug”');

  // And it can therefore be taken, which is the whole ask.
  await offered.click();
  // `Bug×`, because the chip's own `✕` is text inside it — the accessible name
  // of the button beside it is asserted instead of trimming, so a chip drawn
  // without its remove action would fail here rather than pass on a substring.
  await expect(cellOf(page, 'Types for 010').locator('[data-reference-chip]')).toHaveText(['Bug×']);
  await expect(page.getByRole('button', { name: 'Remove Bug from 010' })).toHaveCount(1);
});

test('a clipped reference cell says its whole set on hover', async ({ page }) => {
  const seeded = await seed(page);

  // 010 states all three tags in a 120px column: the rest line is one clipped
  // line and the third tag is past the edge. That is the state the card is
  // for, and it is asserted rather than assumed.
  const cell = cellOf(page, 'Tags for 010');
  const chips = cell.locator('[data-reference-chip]');
  await expect(chips).toHaveCount(3);
  expect(
    await chips.nth(2).evaluate((chip) => {
      const box = chip.getBoundingClientRect();
      const clipper = chip.closest('td');
      if (clipper === null) return false;
      return box.right > clipper.getBoundingClientRect().right;
    }),
    'the fixture is not a clipped cell — the card would have nothing to add',
  ).toBe(true);

  // Proof: the `{carded && <HoverCard …>}` block deleted from
  // `reference-set-field.tsx`, and this failed on `expect(locator).toBeVisible()
  // failed … Expected: visible … Error: element(s) not found` — no card at all
  // on a cell a reader cannot otherwise read, which is exactly what Dany saw.
  // Watched in Chromium, 2026-08-31.
  await cell.hover();
  const card = page.getByRole('tooltip', { name: 'Tags for 010' });
  await expect(card).toBeVisible();
  // Membership rather than order, and deliberately: the order inside a group is
  // the tree's own reading of the row (`effectiveTagLabelOf`), which this change
  // does not touch and has no business pinning. What it does claim — own
  // members before carried ones — is asserted by the two attributes in the case
  // below, where a row has one of each kind to put in order.
  expect(new Set(await card.locator('[data-reference-card-line]').allTextContents())).toEqual(
    new Set(seeded.tags.map((tag) => tag.name)),
  );

  // The card is not what the cell already draws: it says the third tag whole,
  // where the cell has run out of room for it.
  expect(
    await card.evaluate((box) => box.getBoundingClientRect().width),
    'the card is no wider than the cell it is unfolding',
  ).toBeGreaterThan(120);

  // The pointer leaving takes it away.
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
});

test('the card names the row an inherited tag was written on', async ({ page }) => {
  const seeded = await seed(page);

  // 010.1 states one tag of its own and carries the other two of its parent's
  // — the accumulating dimension's own shape (ADR 0008). The carried ones are
  // drawn as `↳` chips with no `✕`, because a tag comes off where it was
  // written; the card is where a reader is told **where** that is.
  const cell = cellOf(page, 'Tags for 010.1');
  await expect(cell.locator('[data-reference-chip]')).toHaveCount(1);
  await expect(cell.locator('[data-reference-inherited-chip]')).toHaveCount(2);

  await cell.hover();
  const card = page.getByRole('tooltip', { name: 'Tags for 010.1' });
  await expect(card).toBeVisible();

  // What the row says itself comes first, and it is one line rather than one
  // list: the order across the two kinds is this card's own claim.
  await expect(card.locator('[data-reference-card-line="stated"]')).toHaveText([
    seeded.tags[0].name,
  ]);
  expect(
    await card
      .locator('[data-reference-card-line]')
      .first()
      .getAttribute('data-reference-card-line'),
    'a carried member was drawn ahead of one the row states',
  ).toBe('stated');

  // Proof: `referenceSetLines` made to print the bare name for a carried
  // member — dropping the `↳ … — from …` the line exists for — and this failed
  // on `Set { - "↳ Review — from 010 Reference 010", - "↳ Risk — from 010
  // Reference 010", + "Review", + "Risk" }`. Watched in Chromium, 2026-08-31.
  expect(
    new Set(await card.locator('[data-reference-card-line="carried"]').allTextContents()),
  ).toEqual(new Set(seeded.tags.slice(1).map((tag) => `↳ ${tag.name} — from 010 - Reference 010`)));
});

test('the card keeps out of the way of the open editor', async ({ page }) => {
  await seed(page);
  const cell = cellOf(page, 'Tags for 010');

  await cell.hover();
  await expect(page.getByRole('tooltip', { name: 'Tags for 010' })).toBeVisible();

  // Clicking the cell opens the panel under the pointer, which is still on the
  // anchor: without the `!editing` half of `carded` the card would stand over
  // the panel it is a folded copy of.
  //
  // Proof: `carded` widened to `pointed && lines.length > 0`, and this failed
  // on `expect(locator).toHaveCount(expected) failed … Expected: 0 / Received:
  // 1` — the card open on top of the editor it folds. Watched in Chromium,
  // 2026-08-31.
  await page.getByRole('combobox', { name: 'Tags for 010', exact: true }).click();
  expect(await panelIsOpen(page, 'Tags for 010')).toBe(true);
  await expect(page.getByRole('tooltip', { name: 'Tags for 010' })).toHaveCount(0);
});
