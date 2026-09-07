import { expect, type Page, test } from '@playwright/test';

import type { PlanOptimizationView, PlanRead } from '../src/lib/wbs-api';
import { createProject } from './create-project';

/**
 * The toolbar's width with one `Project settings` control where three dialogs'
 * triggers stood, measured by a browser.
 *
 * `project-config-modal`'s one measurable claim (design D5): the folded toolbar
 * at 1280 is **no wider than it was**. jsdom lays nothing out, so the only thing
 * that can say how wide a row of buttons is, is Chromium.
 */

/**
 * How far a measured edge may be from the pinned figure, in CSS px. Two, as in
 * `plan-surface.spec.ts`: the numbers compared are rects from two runs of one
 * browser, and a fractional glyph advance lands in both of them.
 */
const NEARLY = 2;

/**
 * What the plan toolbar has to lay out at 1280 on a fresh project — every
 * control's width plus the gaps between them — **before** this change and
 * **after** it. Both measured in this file's own Chromium, on a project with no
 * rows: `before` on `main` at `1ac9344` with `Teams`, `Priorities` and `Steps`
 * as three labelled buttons; `now` on this change.
 *
 * Two pins, and the second is the one that guards anything. D5 asks that the
 * folded toolbar at 1280 be "no wider than before", and the obvious reading —
 * the bar's content width — cannot fail at all: at 1280 the controls already
 * wrap, so the bar measures its own 1248px whatever is on it. Measuring what it
 * `laidOut` fixes that, but pinning it at the pre-change figure leaves 182px
 * of slack, because folding three controls into one really did save that much.
 * A check with 182px of headroom does not notice two whole extra labelled
 * buttons, and was watched passing with exactly that fault on 2026-08-30.
 *
 * So `BEFORE` is kept as documentation of the improvement and asserted loosely,
 * and `NOW` is the regression guard: the bar may not grow from where this change
 * left it. That is the assertion with the negative under it.
 *
 * Both pinned rather than re-derived, for `plan-toolbar-controls-gate`'s reason:
 * a budget resolved from the bar it is measuring is decoration.
 */
const LAID_OUT_BEFORE_AT_1280 = 1445.33;
const LAID_OUT_NOW_AT_1280 = 1265;
const ROWS_BEFORE_AT_1280 = 2;

/** Registers a throwaway account and opens an empty project. */
async function freshProject(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
}

/**
 * The toolbar's laid-out shape: every control's width plus the gaps between them
 * (what the bar has to fit, whatever it wrapped to) and how many rows it took.
 */
function measureToolbar(page: Page): Promise<{ laidOut: number; rows: number; controls: number }> {
  return page.evaluate(() => {
    const toolbar = document.querySelector('[data-toolbar]');
    if (toolbar === null) throw new Error('the plan has no toolbar');
    const boxes = [...toolbar.children].map((child) => child.getBoundingClientRect());
    if (boxes.length === 0) throw new Error('the toolbar has no controls');
    const gap = Number.parseFloat(getComputedStyle(toolbar).columnGap);
    if (!Number.isFinite(gap)) throw new Error('the toolbar has no column gap to read');
    return {
      laidOut: boxes.reduce((total, box) => total + box.width, 0) + gap * (boxes.length - 1),
      rows: new Set(boxes.map((box) => Math.round(box.top))).size,
      controls: boxes.length,
    };
  });
}

test.describe('the project settings control, in a browser', () => {
  test('the toolbar keeps its 1280 budget with one settings control', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await freshProject(page);

    // Precondition first, so the budget below cannot be met by a bar that
    // simply lost its controls: the one control is there and the three are not.
    await expect(page.getByRole('button', { name: 'Project settings' })).toBeVisible();
    for (const gone of ['Teams', 'Priorities', 'Steps']) {
      await expect(
        page.locator('[data-toolbar]').getByRole('button', { name: gone, exact: true }),
      ).toHaveCount(0);
    }

    const measured = await measureToolbar(page);
    // Non-vacuity: a bar with fewer controls than three-into-one leaves is a bar
    // that lost something else, and the width below would be flattering it.
    expect(measured.controls, 'the toolbar lost controls beyond the three').toBeGreaterThanOrEqual(
      16,
    );
    // The claim D5 states, kept as the record of what folding three controls
    // into one bought: 180px, and the bar is no wider than it was.
    expect(
      measured.laidOut,
      `${String(Math.round(measured.laidOut))}px of controls to lay out, against the ${String(
        LAID_OUT_BEFORE_AT_1280,
      )}px the bar had with three buttons`,
    ).toBeLessThanOrEqual(LAID_OUT_BEFORE_AT_1280 + NEARLY);

    // The guard. The bar may not grow from where this change left it — which is
    // 180px below the figure above, and the whole reason that figure cannot be
    // the assertion.
    //
    // Proof: two extra labelled buttons added to `toolbarControls` with names
    // matching none of the three the precondition names (`Squad`, `Precedence`,
    // so the precondition still passes). Against `BEFORE` that fault was
    // watched **passing** — 1428px against a 1447.33px ceiling. Against this
    // line it fails on `1428px of controls to lay out, against the 1265px this
    // change left`. Watched 2026-08-30, both arms.
    expect(
      measured.laidOut,
      `${String(Math.round(measured.laidOut))}px of controls to lay out, against the ${String(
        LAID_OUT_NOW_AT_1280,
      )}px this change left`,
    ).toBeLessThanOrEqual(LAID_OUT_NOW_AT_1280 + NEARLY);

    expect(measured.rows, 'the toolbar wraps to more rows than it did').toBeLessThanOrEqual(
      ROWS_BEFORE_AT_1280,
    );
  });

  test('opens on its control, offers five sections, and closes back onto it', async ({ page }) => {
    await freshProject(page);
    const control = page.getByRole('button', { name: 'Project settings' });
    await control.click();
    const dialog = page.getByRole('dialog', { name: 'Project settings' });
    await expect(dialog).toBeVisible();
    // Five since `dual-optimized-scheduler`: `Optimization` follows
    // `Estimating` as the final project-level scheduling section.
    await expect(dialog.getByRole('tab')).toHaveText([
      'Teams',
      'Priorities',
      'Steps',
      'Estimating',
      'Optimization',
    ]);

    // The arrow keys walk the list and select as they go — a real keydown on a
    // real focused tab, which is the half jsdom's synthetic dispatch cannot see.
    await dialog.getByRole('tab', { name: 'Teams' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('tab', { name: 'Priorities' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByLabel('Name of band 1')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(control).toBeFocused();
  });

  test('operates the optimization checkbox and schedule radios from the keyboard', async ({
    page,
  }) => {
    await freshProject(page);
    await page.getByRole('button', { name: 'Project settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Project settings' });
    await dialog.getByRole('tab', { name: 'Optimization' }).click();

    const optimization = dialog.getByRole('checkbox', { name: 'Optimize schedules' });
    await optimization.focus();
    await page.keyboard.press('Space');
    await expect(optimization).toBeChecked();

    const fast = dialog.getByRole('radio', { name: 'Fast' });
    const priority = dialog.getByRole('radio', { name: 'PRI' });
    const time = dialog.getByRole('radio', { name: 'Time' });
    await expect(fast).toBeEnabled();
    await fast.focus();
    await page.keyboard.press('ArrowRight');
    await expect(priority).toBeChecked();
    await expect(priority).toBeEnabled();
    await priority.focus();
    await page.keyboard.press('ArrowRight');
    await expect(time).toBeChecked();

    // Proof: these are browser default actions. Synthetic jsdom key events do
    // not toggle native controls, so deleting a control or breaking its native
    // grouping makes this real-key path fail instead of leaving a decorative
    // keydown assertion green.
    await expect(time).toBeEnabled();
    await time.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(priority).toBeChecked();
  });

  test('keeps the infeasible indicator inside a phone card plan and opens it by keyboard', async ({
    page,
  }) => {
    await freshProject(page);
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();
    const longWorkItemName = 'Deadline'.repeat(24);
    const name = page.getByLabel('Name of 010');
    const nameSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/commands') &&
        (response.request().postData() ?? '').includes('"kind":"patchWorkItem"') &&
        response.ok(),
    );
    await name.fill(longWorkItemName);
    await name.blur();
    await nameSaved;
    await expect(name).toHaveValue(longWorkItemName);

    await page.route('**/api/projects/*/work-items', async (route) => {
      const response = await route.fetch();
      const plan = (await response.json()) as PlanRead;
      const first = plan.workItems[0];
      const optimization: PlanOptimizationView = {
        enabled: true,
        engine: 'optimized',
        objective: 'pri',
        inputHash: 'e2e-phone-infeasible',
        generation: 1,
        contractVersion: '1.5+e2e',
        budgetMs: 60_000,
        displayed: 'fast',
        variants: {
          pri: {
            state: 'plan-infeasible',
            items: [
              {
                ownerWorkItemId: first.id,
                boundWorkItemId: first.id,
                effectiveDeadlineOffset: 4,
              },
            ],
          },
          time: { state: 'idle' },
        },
      };
      await route.fulfill({ response, json: { ...plan, startDate: '2026-09-07', optimization } });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('article', { name: 'Work item 010' })).toBeVisible();

    const indicator = page.locator('[data-optimization-indicator]');
    await expect(indicator).toContainText('Plan infeasible · 1 Work item deadline');
    const indicatorBox = await indicator.boundingBox();
    expect(indicatorBox, 'the phone indicator has no rendered box').not.toBeNull();
    expect(indicatorBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((indicatorBox?.x ?? 0) + (indicatorBox?.width ?? 391)).toBeLessThanOrEqual(390);

    const disclosure = page.getByText('Show affected work items');
    await expect(disclosure).toHaveAccessibleName('Show affected work items');
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Work item deadline 11 Sep/)).toBeVisible();
    const affectedItem = page
      .getByLabel('Affected work items')
      .locator('li')
      .filter({ hasText: longWorkItemName });
    await expect(affectedItem).toBeVisible();
    const overflow = await affectedItem.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);

    const openBox = await indicator.boundingBox();
    expect(openBox, 'the open phone indicator has no rendered box').not.toBeNull();
    expect((openBox?.x ?? 0) + (openBox?.width ?? 391)).toBeLessThanOrEqual(390);
  });
});
