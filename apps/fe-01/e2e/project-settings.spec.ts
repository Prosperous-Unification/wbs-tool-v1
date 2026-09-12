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
// Chromium153 on Linux resolves the same unchanged toolbar to1268.46875px;
// retain the measured cross-platform high-water mark rather than failing on a
// fractional glyph advance that added no control.
//
// **Moved from 1268.5 to 1303.5 by `arrange-by-schedule` on 2026-09-11**, which
// is the "named margin for exactly one more control" this file's comment
// promised, spent. The control is `Arrange by schedule`, an icon button, and it
// cost **34.77px** — 1303.265625 measured here against 1268.46875 before it.
//
// Re-pinned rather than loosened, and the figure that matters was measured
// alongside: `rows` is **2**, exactly what it was, so the bar wraps no further
// than it already did and `gantt.spec.ts:2605` still watches the wrap it is
// about. The margin is now genuinely gone — the next control to reach this bar
// has to take width away from something.
const LAID_OUT_NOW_AT_1280 = 1303.5;
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
  test.afterEach(async ({ page }) => {
    // Wait for route.fetch() and response.json() before Playwright tears down
    // the page and disposes the handler's APIResponse underneath that read.
    await page.unrouteAll({ behavior: 'wait' });
  });

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
    // line it failed on `Expected: <= 1268.5 · Received: 1427.21875`.
    // Re-watched in Chromium153 on Linux, 2026-09-08, after moving the
    // cross-platform pin to the measured high-water mark.
    //
    // Re-watched on 2026-09-11 against the pin `arrange-by-schedule` moved it
    // to, because a raised ceiling is a check that has to be proved again —
    // **and the two-button fault no longer reaches this line.** The bar is
    // 35px wider now, so two extra labelled buttons overshoot the loose
    // `BEFORE` assertion above first: `Expected: <= 1447.33 · Received:
    // 1466.015625`. That is a real failure and a proof about the wrong line.
    //
    // **One** extra labelled button is the fault this pin is for, and it was
    // watched failing here on `1370px of controls to lay out, against the
    // 1303.5px this change left · Expected: <= 1305.5 · Received:
    // 1369.96875`.
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
    const priority = dialog.getByRole('radio', { name: 'Pri' });
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

  test('keeps the infeasible cue inside a phone card plan and opens it by keyboard', async ({
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
        (response.request().postData() ?? '').includes(longWorkItemName) &&
        response.ok(),
    );
    await name.fill(longWorkItemName);
    await name.blur();
    await nameSaved;
    await expect(name).toHaveValue(longWorkItemName);

    let resolvePersistedName: (name: string | undefined) => void = () => undefined;
    const persistedName = new Promise<string | undefined>((resolve) => {
      resolvePersistedName = resolve;
    });
    await page.route('**/api/projects/*/work-items', async (route) => {
      // Only reads are synthetic. The long name above is a real persisted
      // command round trip; startDate and optimization below are renderer
      // fixtures because this is a layout/keyboard case, not a solver e2e.
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const plan = (await response.json()) as PlanRead;
      const first = plan.workItems.at(0);
      const firstId = first?.id ?? 'missing-persisted-work-item';
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
          pri: { state: 'ready', proof: 'proven' },
          time: {
            state: 'plan-infeasible',
            items: [
              {
                ownerWorkItemId: firstId,
                boundWorkItemId: firstId,
                effectiveDeadlineOffset: 4,
              },
            ],
          },
        },
        // Fast's finish and PRI's, which is what an enabled project with one
        // solved variant really carries; the infeasible one has no schedule and
        // so no figure.
        finishDays: { fast: 4, pri: 4 },
        sameOrderAsFast: { pri: true },
      };
      await route.fulfill({ response, json: { ...plan, startDate: '2026-09-07', optimization } });
      resolvePersistedName(first?.name);
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    // The route must settle first. An assertion inside its callback leaves the
    // request unresolved and hides this diagnostic behind a navigation timeout.
    const reloadedName = await persistedName;
    expect(reloadedName, 'the persisted plan has no first work item').toBeDefined();
    expect(reloadedName, 'the long-name command was not persisted before reload').toBe(
      longWorkItemName,
    );
    await expect(page.getByRole('article', { name: 'Work item 010' })).toBeVisible();

    const cue = page.locator('[data-optimization-cue]');
    await expect(cue).toBeVisible();
    const cueBox = await cue.boundingBox();
    expect(cueBox, 'the phone cue has no rendered box').not.toBeNull();
    expect(cueBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((cueBox?.x ?? 0) + (cueBox?.width ?? 391)).toBeLessThanOrEqual(390);
    // The count is on the pill's own sentence, which is its accessible name and
    // the text of its live region both.
    await expect(cue).toContainText('Finish-first: Plan infeasible · 1 Work item deadline');

    // By keyboard, and the focus is the whole of it: `HintLayer` opens the same
    // card from `focusin`, with no wait of either kind and no cursor to put a
    // ring beside, so a phone reader who has tabbed to the pill gets the same
    // words as one who pointed at it.
    const pill = page.getByRole('button', { name: /is the active schedule/ });
    await pill.focus();
    const card = page.locator('#hint-card');
    await expect(card).toBeVisible();
    const described = (await pill.getAttribute('aria-describedby'))?.split(/\s+/) ?? [];
    expect(described).toContain('hint-card');
    // Proof: before the persisted-write wait, CI's first complete pixels run
    // was red 1/294 here: the 192-character locator was absent and the snapshot
    // showed an empty textbox plus an orphan deadline bullet. The row's own
    // name is in the card now, with the effective workday deadline it cannot
    // meet — one unbroken token, which is what the overflow checks exercise.
    await expect(card).toContainText(longWorkItemName);
    await expect(card).toContainText('Work item deadline (effective workday) 11 Sep');
    const overflow = await card.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);

    const openCard = await card.boundingBox();
    expect(openCard, 'the open phone card has no rendered box').not.toBeNull();
    expect(openCard?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((openCard?.x ?? 0) + (openCard?.width ?? 391)).toBeLessThanOrEqual(390);
  });
});
