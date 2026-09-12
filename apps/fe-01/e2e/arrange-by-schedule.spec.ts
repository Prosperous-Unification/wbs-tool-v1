import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * `Arrange by schedule`, measured against the real stack.
 *
 * jsdom can watch the command be issued and the rows come back in a different
 * order — `plan-toolbar.test.tsx` does — and there are two things it cannot
 * see, both of which this file is for.
 *
 * The first is that the order the table draws is the order the **chart** draws:
 * the fake computes a schedule of its own, so a jsdom assertion about "the row
 * whose bar starts first" is an assertion about the fake's arithmetic. Here the
 * bar is measured where it is painted.
 *
 * The second is ADR 0023 end to end. A frozen work item moves now, and the
 * number that left the tool travels with it — which means the numbers down the
 * page stop ascending. That is a visible consequence of a deliberate decision,
 * and the kind of thing that is argued about until somebody looks at it.
 */

/** The names down the first column, in the order the table draws them. */
async function namesOnScreen(page: Page): Promise<string[]> {
  return page
    .locator('tbody tr [data-name-input]')
    .evaluateAll((boxes) =>
      boxes.map((box) => (box as HTMLTextAreaElement | HTMLInputElement).value),
    );
}

/**
 * Presses the control and waits for the plan to come back arranged.
 *
 * The wait is the point. `run` issues the command, rereads the plan and
 * re-renders the chart, and a measurement taken before that lands reads the
 * plan as it was — which is what the first cut of the bar case did, twice,
 * answering `[344, 204, 204]` for a chart it had not redrawn yet.
 */
async function arrangeAndSettle(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Arrange by schedule' }).click();
  await expect(async () => {
    expect(await namesOnScreen(page)).toEqual(['Idle', 'First', 'Waits']);
  }).toPass();
}

/** The numbers down the first column, in the order the table draws them. */
async function numbersOnScreen(page: Page): Promise<string[]> {
  return page.locator('tbody tr [data-number]').allInnerTexts();
}

/**
 * Three estimated rows where the first one has to happen last.
 *
 * `010` waits for `030`, so Fast places `020` and `030` at day zero and `010`
 * behind them. The two at zero are the **tie**: they keep the order they
 * already read in, which is what makes the arranged order `020, 030, 010`
 * rather than anything sorted.
 *
 * Every row is estimated so every bar has a width. An unestimated slice is
 * drawn at zero width standing at its own workday, and comparing those proves
 * nothing about order — R5 #16, which is the fault this file's second case
 * would otherwise repeat.
 */
async function threeRowsOutOfOrder(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // The folded trio cell, filled directly — unfolding replaces it with three
  // separate boxes and the label goes with it (`card-lanes.spec.ts` does the
  // same).
  for (const number of ['010', '020', '030']) {
    const estimate = page.getByLabel(`Dev estimate for ${number}`);
    await estimate.fill('2/3/4');
    await estimate.blur();
  }

  // Named, because the numbers re-derive: the row that moves to the top
  // *becomes* `010`, so a number is no evidence about which row it is.
  for (const [number, name] of [
    ['010', 'Waits'],
    ['020', 'Idle'],
    ['030', 'First'],
  ]) {
    await page.getByLabel(`Name of ${number}`).fill(name);
    await page.getByLabel(`Name of ${number}`).blur();
  }

  const depends = page.getByLabel('Add a dependency to 010');
  await depends.click();
  await depends.fill('030');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: /^Stop 010 waiting for / })).toHaveCount(1);
}

test.describe('arranging a plan by its schedule, in a browser', () => {
  test.afterEach(async ({ page }) => {
    // Wait for route.fetch() and response.json() before Playwright tears down
    // the page and disposes any handler's APIResponse underneath that read.
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('puts the row whose bar starts first at the top', async ({ page }) => {
    await threeRowsOutOfOrder(page);

    await arrangeAndSettle(page);

    // `Idle` and `First` both start on day zero and keep the order they read
    // in; `Waits` falls to the bottom.
    //
    // Proof: the handler in `wbs-table.tsx` wired to `api.freezeProject`
    // instead — watched failing on `Expected: ["Idle", "First", "Waits"] ·
    // Received: ["Waits", "Idle", "First"]`, the plan in the order it was
    // typed in; 2026-09-11.
    expect(await namesOnScreen(page)).toEqual(['Idle', 'First', 'Waits']);
  });

  test('draws the arranged rows against bars that start left to right', async ({ page }) => {
    await threeRowsOutOfOrder(page);
    await page.getByRole('button', { name: 'Gantt' }).click();
    await arrangeAndSettle(page);

    // By the row's **number**, which after the arrangement is its place, and by
    // the **least** x across that row's bars rather than `.first()`: a row
    // draws one bar per step, painted in slice order, so `.first()` returned a
    // QA bar and made `010` look like the latest row in the plan (`[343, 203,
    // 343]`, measured 2026-09-11). R5 #16's lesson with the index replaced by a
    // minimum.
    const drawn = await page.locator('[data-gantt-bar]').evaluateAll((bars) =>
      bars.map((bar) => {
        const box = bar.getBoundingClientRect();
        return { label: bar.getAttribute('aria-label') ?? '', x: box.x, width: box.width };
      }),
    );
    const lefts: number[] = [];
    for (const number of ['010', '020', '030']) {
      const mine = drawn.filter((bar) => bar.label.startsWith(`${number} - `));
      expect(mine.length, `${number} draws no bar · ${JSON.stringify(drawn)}`).toBeGreaterThan(0);
      expect(
        mine.some((bar) => bar.width > 0),
        `${number} draws no bar with a width · ${JSON.stringify(mine)}`,
      ).toBe(true);
      lefts.push(Math.min(...mine.map((bar) => bar.x)));
    }

    expect([...lefts].sort((left, right) => left - right)).toEqual(lefts);
    // And it is not three bars at one x, which the sort above would accept.
    expect(lefts[2]).toBeGreaterThan(lefts[0] ?? 0);
  });

  test('moves a frozen row and leaves the number that left the tool alone', async ({ page }) => {
    await threeRowsOutOfOrder(page);
    await page.getByRole('button', { name: 'Freeze #' }).click();
    await page.getByRole('menuitem', { name: 'Freeze numbering' }).click();
    await expect(page.getByLabel('Number is frozen')).toHaveCount(3);

    await arrangeAndSettle(page);

    // ADR 0023, drawn: the rows are in schedule order and the numbers are not.
    // `020` and `030` start together and keep their order, `010` falls to the
    // bottom, and every label stays where it was frozen — so the column now
    // reads 020, 030, 010 down the page.
    //
    // Proof: `byTreeOrder(treeOrder(rows))` in `work-item.service.ts`'s read
    // replaced by the old number-string sort — watched failing 2026-09-11, and
    // **in `arrangeAndSettle` rather than on the line below**: with the read
    // sorted by label the rows never settle into the arranged order at all, so
    // the wait is where the fault surfaces and the numbers are never reached.
    // Worth writing down, because a proof that names the wrong line is how a
    // check acquires a comment saying it can fail when it cannot (R5 #22).
    await expect(async () => {
      expect(await numbersOnScreen(page)).toEqual(['020', '030', '010']);
    }).toPass();
  });

  test('says why it cannot arrange a plan whose dependencies run in a circle', async ({ page }) => {
    await threeRowsOutOfOrder(page);
    // The other half of the circle, which be-01 refuses at the boundary — so
    // this asserts the control's at-rest state rather than building a cycle.
    const arrange = page.getByRole('button', { name: 'Arrange by schedule' });

    await expect(arrange).toBeEnabled();
    await expect(arrange).toHaveAttribute('data-hint', /order its bar starts/);
    // Never both, which is the sweep `hints.spec.ts` runs over the whole page.
    expect(await arrange.getAttribute('data-fact')).toBeNull();
  });
});
