import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * What the chart's `Detail` switch hides, measured by the engine that paints it.
 *
 * The switch answered about three families of mark until 2026-09-12: the
 * stored-dependency arrows, the parent rows' summary brackets, and the bars for
 * slices nobody has estimated. Dany asked for the third in the first place
 * (2026-08-11, "remove … unestimated QA bars") and took it back after looking at
 * his own plan with the switch off — twelve of its rows are uncosted, and all
 * twelve drew nothing at all: _"with details disabled you still have to show the
 * unestimated slices"_.
 *
 * **A browser and not jsdom**, for the reason that report exists: this is a
 * claim about what a reader can see on a chart, and it was made by looking.
 * jsdom can watch the filter change and can say nothing about a row that has
 * gone blank.
 */

/** Two rows, one costed and one not, on a plan with no dependency at all. */
async function oneCostedAndOneNot(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  // Only `010` is costed. `020` is the uncosted row this file is about, and the
  // plan carries no edge — so the switch opens **off**, which is the state the
  // report was made in.
  const estimate = page.getByLabel('Dev estimate for 010');
  await estimate.fill('2/3/4');
  await estimate.blur();

  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('[data-gantt-chart]')).toBeVisible();
  await expect(page.locator('[data-gantt-bar]').first()).toBeVisible();
}

test.describe('what the chart’s detail switch hides, in a browser', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('draws an uncosted row with the detail off, and paints it as a guess', async ({ page }) => {
    await oneCostedAndOneNot(page);

    // The state the report was made in: nothing on this plan turns the switch on.
    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // `020`'s own bar, found through the row's number rather than by counting:
    // every row carries a Dev and a QA slice, so a fully uncosted row draws two
    // assumed bars and the costed row draws one of its own. A global count says
    // nothing about *which* row is blank, and which row is blank is the report.
    //
    // Drawn with **area**, not merely present in the DOM — which is all jsdom
    // could ever have said about it.
    //
    // Proof: `drawnBars` put back to
    // `detailShown ? placed.bars : placed.bars.filter(({ bar }) => bar.estimated)` —
    // watched failing on `expect(locator).toBeVisible() failed · element(s) not
    // found` for this very locator, and the second case in this file timing out
    // on `locator.boundingBox`. That is the blank row, reproduced.
    const assumed = page.locator('[data-gantt-bar][data-assumed="true"][aria-label^="020 - "]');
    await expect(assumed.first()).toBeVisible();
    const box = await assumed.first().boundingBox();
    if (box === null) throw new Error('the assumed bar has no box');
    expect(box.width, 'the assumed bar is drawn with no width').toBeGreaterThan(0);
    expect(box.height, 'the assumed bar is drawn with no height').toBeGreaterThan(0);

    // And it still says it is a guess rather than passing for costed work: the
    // dashes, the lighter fill and the `?` are what carry that.
    const painted = await assumed.first().evaluate((bar) => {
      const style = getComputedStyle(bar);
      return { dash: style.strokeDasharray, fill: style.fillOpacity };
    });
    expect(painted.dash, 'the assumed bar is not dashed').not.toBe('none');
    expect(Number(painted.fill)).toBeLessThan(1);
    await expect(page.locator('[data-gantt-bar-label]').filter({ hasText: '?' })).not.toHaveCount(
      0,
    );

    // Non-vacuity: the costed bar on `010` is drawn too, so the assertions above
    // are not holding of a chart that draws nothing — and it is *not* assumed,
    // so they are not holding of one that marks everything as a guess.
    await expect(page.locator('[data-gantt-bar]:not([data-assumed])')).toHaveCount(1);
  });

  test('leaves the uncosted row alone when the switch is pressed', async ({ page }) => {
    await oneCostedAndOneNot(page);
    const assumed = page.locator('[data-gantt-bar][data-assumed="true"][aria-label^="020 - "]');
    const before = await assumed.first().boundingBox();
    if (before === null) throw new Error('the assumed bar has no box');

    await page.locator('[data-gantt-detail-toggle]').click();

    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Same bar, same place: the switch draws arrows and brackets, and this row
    // is no longer any of its business.
    await expect(assumed.first()).toBeVisible();
    expect(await assumed.first().boundingBox()).toEqual(before);
  });
});
