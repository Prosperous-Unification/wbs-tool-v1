import { expect, type Page, test } from '@playwright/test';

import type { PlanOptimizationView, PlanRead } from '../src/lib/wbs-api';
import { createProject } from './create-project';

/**
 * The schedule cue, in the only oracle that can say anything about it.
 *
 * Every claim here is a browser's: a rectangle, a default action, or the
 * document's own scroll width. jsdom lays nothing out and performs no default
 * action, so `optimization-cue.test.tsx` can say the pill carries the right
 * words and this file is what says the pill is a pill — R5 #14/#15/#17, three
 * faults found by driving Chromium and invisible to 2,500 jsdom cases.
 *
 * The optimizer is **faked at the wire** rather than solved for real: a solver
 * run needs the Python package, a seat and a plan big enough to be worth
 * optimizing, and none of that is what these five assertions are about. What
 * comes back is a payload be-01 really can produce — PRI ready and three
 * workdays ahead of Fast, Time still solving.
 */

/**
 * What the toolbar row has to lay out at 1280 with the cue on it — every
 * control's width plus the gaps — measured in this file's own Chromium on a
 * project with one row and optimization on.
 *
 * Pinned rather than derived from the bar it measures, which is
 * `plan-toolbar-controls`' lesson (R5): a budget read off its own subject is
 * decoration. `project-settings.spec.ts` pins the same row **without** the cue,
 * on a fresh project where the toggle is off and the pill is not drawn at all;
 * this is the figure with it.
 */
const LAID_OUT_WITH_THE_CUE_AT_1280 = 1563;

/** How far a measured edge may be from a pinned figure, in CSS px — `project-settings.spec.ts`'s. */
const NEARLY = 2;

const SUGGESTING: PlanOptimizationView = {
  enabled: true,
  engine: 'fast',
  objective: 'pri',
  inputHash: 'e2e-cue-input',
  generation: 1,
  contractVersion: '1.5+e2e',
  budgetMs: 60_000,
  displayed: 'fast',
  variants: { pri: { state: 'ready', proof: 'proven' }, time: { state: 'pending' } },
  finishDays: { fast: 10, pri: 7 },
  sameOrderAsFast: { pri: true },
};

/**
 * A project with one row whose plan read carries {@link SUGGESTING}, and a
 * handle that changes what the **next** read says.
 *
 * The handle is what makes a switch a switch: be-01's answer is intercepted, so
 * without it the plan read would keep saying Fast is displayed however many
 * times the reader chose Pri, and "nothing moved" would be a claim about a
 * screen that never changed.
 */
async function planWithACue(page: Page): Promise<{ serve: (next: PlanOptimizationView) => void }> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();

  let optimization = SUGGESTING;
  await page.route('**/api/projects/*/work-items', async (route) => {
    const response = await route.fetch();
    const plan = (await response.json()) as PlanRead;
    await route.fulfill({
      response,
      json: { ...plan, startDate: '2026-09-07', optimization },
    });
  });
  await page.reload();
  await expect(page.locator('[data-optimization-cue]')).toBeVisible();
  return {
    serve: (next) => {
      optimization = next;
    },
  };
}

const pill = (page: Page) => page.getByRole('button', { name: /is the active schedule/ });

/**
 * The one card that explains this pill — `HintLayer`'s, because the cue's
 * reading is a `data-fact` and the layer draws every one of those.
 *
 * There is exactly one card in the document for it. The cue drew a `HoverCard`
 * of its own for one commit, and this locator had to go through
 * `aria-describedby` to tell the two apart; that is gone.
 */
const cueCard = (page: Page) => page.locator('#hint-card');

async function boxOf(page: Page, selector: string): Promise<DOMRect> {
  const box = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  return box as DOMRect;
}

test.describe('the schedule cue, in a browser', () => {
  test.afterEach(async ({ page }) => {
    // Wait for route.fetch() and response.json() before Playwright tears down
    // the page and disposes the handler's APIResponse underneath that read.
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('stands inside the toolbar row and takes the saving with it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planWithACue(page);

    const cue = await boxOf(page, '[data-optimization-cue]');
    const toolbar = await boxOf(page, '[data-toolbar]');
    // Non-zero first, both of them: an assertion that one empty box is inside
    // another empty box is the vacuity `gantt-calendar-axis` shipped once (R5
    // #16).
    expect(cue.width, 'the cue has no rendered width').toBeGreaterThan(0);
    expect(cue.height, 'the cue has no rendered height').toBeGreaterThan(0);
    expect(toolbar.width).toBeGreaterThan(0);
    expect(cue.y).toBeGreaterThanOrEqual(toolbar.y - NEARLY);
    expect(cue.y + cue.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + NEARLY);
    expect(cue.x).toBeGreaterThanOrEqual(toolbar.x - NEARLY);
    expect(cue.x + cue.width).toBeLessThanOrEqual(toolbar.x + toolbar.width + NEARLY);

    // The saving is on the pill, drawn, and not merely in the markup.
    const saving = await boxOf(page, '[data-cue-suggestion]');
    expect(saving.width, 'the suggestion has no rendered width').toBeGreaterThan(0);
    await expect(page.locator('[data-cue-suggestion]')).toHaveText('· Pri 3 days earlier');
  });

  test('lays the 1280 toolbar out inside its budget with the cue on it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planWithACue(page);

    const measured = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-toolbar]');
      if (toolbar === null) throw new Error('the plan has no toolbar');
      const boxes = [...toolbar.children].map((child) => child.getBoundingClientRect());
      if (boxes.length === 0) throw new Error('the toolbar has no controls');
      const gap = Number.parseFloat(getComputedStyle(toolbar).columnGap);
      if (!Number.isFinite(gap)) throw new Error('the toolbar has no column gap to read');
      return {
        laidOut: boxes.reduce((total, box) => total + box.width, 0) + gap * (boxes.length - 1),
        controls: boxes.length,
        rows: new Set(boxes.map((box) => Math.round(box.y))).size,
      };
    });
    // A bar that lost controls would flatter the budget below.
    expect(measured.controls, 'the toolbar lost controls').toBeGreaterThanOrEqual(16);
    // Proof: the pill's face given `reading.sentence` instead of the active
    // schedule's label — the banner this change deleted, wearing a pill's
    // clothes — and this failed on `2082px of controls to lay out, against the
    // 1563px this change left · Expected: <= 1565 · Received: 2081.92`.
    // Watched 2026-09-08.
    expect(
      measured.laidOut,
      `${String(Math.round(measured.laidOut))}px of controls to lay out, against the ${String(
        LAID_OUT_WITH_THE_CUE_AT_1280,
      )}px this change left`,
    ).toBeLessThanOrEqual(LAID_OUT_WITH_THE_CUE_AT_1280 + NEARLY);
    expect(measured.rows, 'the toolbar wraps to more rows than two').toBeLessThanOrEqual(2);
  });

  test('adds no sideways scroll to a phone, open or closed', async ({ page }) => {
    // The project is made at desktop width and the viewport narrowed after:
    // below `md` the plan draws itself as cards and `Add work item` is not on
    // the toolbar row at all, so building the fixture at 390px waits two
    // minutes for a button that is somewhere else.
    await planWithACue(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('[data-optimization-cue]')).toBeVisible();

    const scrolls = () =>
      page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      }));
    const atRest = await scrolls();
    expect(atRest.documentWidth).toBeLessThanOrEqual(atRest.viewportWidth);

    // Proof: the same fault as the budget case above — the sentence on the
    // pill's face — and this failed on `Expected: <= 390 · Received: 719`, a
    // cue hanging 329px off the side of the screen. Watched 2026-09-08.
    const cue = await boxOf(page, '[data-optimization-cue]');
    expect(cue.width).toBeGreaterThan(0);
    expect(cue.x).toBeGreaterThanOrEqual(0);
    expect(cue.x + cue.width).toBeLessThanOrEqual(390 + NEARLY);

    // And with the card open — the layer's, opened from the keyboard, which is
    // the path a phone reader with a keyboard gets and the one that needs no
    // pointer at all.
    await pill(page).focus();
    const card = cueCard(page);
    await expect(card).toBeVisible();
    const open = await boxOf(page, '#hint-card');
    expect(open.width).toBeGreaterThan(0);
    expect(open.x).toBeGreaterThanOrEqual(0);
    expect(open.x + open.width).toBeLessThanOrEqual(390 + NEARLY);
    const withCardOpen = await scrolls();
    expect(withCardOpen.documentWidth).toBeLessThanOrEqual(withCardOpen.viewportWidth);
  });

  test('explains the plan at once, with no wait ring, and holds the whole reading', async ({
    page,
  }) => {
    await planWithACue(page);
    // A **fact**, not a tool hint: the words are about the project rather than
    // about what the control does, so they open on arrival and behind no ring
    // (`tool-hints-wait` split the two; `hint.ts` holds both attributes).
    await pill(page).hover();
    await expect(cueCard(page)).toBeVisible();
    // Read once, at the instant it is about. `toHaveCount(0)` is a *retrying*
    // assertion and would be satisfied by a ring that had simply finished —
    // R5's own note on `tool-hints-wait`.
    expect(await page.locator('[data-wait-ring]').count()).toBe(0);

    const card = cueCard(page);
    // Every schedule, its figures, its comparison and which one is active.
    await expect(card).toContainText('Fast · 10 days · active');
    await expect(card).toContainText('Pri · 7 days · Earlier project deadline by 3 days');
    await expect(card).toContainText('Time · Optimizing…');
    // What the three algorithms are, which a three-letter name cannot say.
    await expect(card).toContainText('Fast places the plan in milliseconds');
    await expect(card).toContainText('CP-SAT searches from Google OR-Tools');
    // And the identity of the run, which is the only place a reader can find
    // out which plan and which solver contract produced the figures above.
    await expect(card).toContainText('Solver 1.5+e2e · 60s budget · generation 1 · plan e2e-cue-');
    // The blocks are really separate lines rather than one run-on paragraph:
    // the attribute keeps its newlines and the layer renders them.
    const lines = await card.evaluate((element) => {
      const style = getComputedStyle(element.firstElementChild ?? element);
      return { whiteSpace: style.whiteSpace, breaks: element.textContent.split('\n').length };
    });
    expect(lines.whiteSpace).toBe('pre-line');
    expect(lines.breaks).toBeGreaterThan(6);

    const box = await boxOf(page, '#hint-card');
    expect(box.width, 'the card has no rendered width').toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
  });

  /**
   * The cue is the **last** control in the plan toolbar, so on a window wide
   * enough not to wrap that row it stands at the right edge — which is where a
   * menu hanging from `left: 0` runs off the screen.
   *
   * Proof: `menuShift` returning `0` unconditionally, and this failed on `the
   * menu is cropped on the right at 1600: 1400px + 359px · Expected: <= 1600 ·
   * Received: 1758.77` — 159px of items with no way to read or reach them.
   * With the clamp the same box opens at x=1233. The three narrower widths are
   * unshifted in both arms, which is what says the clamp only acts where it is
   * needed. Watched 2026-09-08.
   */
  test('keeps its open menu inside the screen, wherever the pill sits', async ({ page }) => {
    for (const width of [1600, 1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (width === 1600) await planWithACue(page);
      else {
        await page.reload();
        await expect(page.locator('[data-optimization-cue]')).toBeVisible();
      }
      await pill(page).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const box = await boxOf(page, '[role="menu"]');
      expect(box.width, `the menu has no rendered width at ${String(width)}`).toBeGreaterThan(0);
      expect(box.x, `the menu is cropped on the left at ${String(width)}`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        box.x + box.width,
        `the menu is cropped on the right at ${String(width)}: ${String(Math.round(box.x))}px + ${String(Math.round(box.width))}px`,
      ).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
    }
  });

  /**
   * The jitter (Dany, 2026-09-08): the pill's words change on every switch and
   * on every solve that lands, and this control is the **last** item in a
   * wrapping toolbar row — so a box that grows with its words can push itself
   * over the wrap threshold and re-lay the entire row.
   *
   * Proof: `w-[11.5rem]` removed from `PILL`, so the box is the width of its
   * words again, and this failed on `the toolbar moved under a switch: Starts ·
   * Expected: 1049.55 · Received: 1192.48` — the project's start-date control
   * **143px** to the right of where it had been, because the pill shrank by
   * that much when its saving went and the row re-laid itself around it.
   * Watched 2026-09-08.
   */
  test('a switch moves nothing else on the toolbar row', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const plan = await planWithACue(page);
    const shapeOf = () =>
      page.evaluate(() => {
        const toolbar = document.querySelector('[data-toolbar]');
        if (toolbar === null) throw new Error('the plan has no toolbar');
        const box = toolbar.getBoundingClientRect();
        return {
          height: Math.round(box.height),
          rows: new Set(
            [...toolbar.children].map((child) => Math.round(child.getBoundingClientRect().y)),
          ).size,
          children: [...toolbar.children].map((child) => {
            const rect = child.getBoundingClientRect();
            return { at: child.textContent.slice(0, 24), x: rect.x, y: rect.y };
          }),
        };
      });
    const before = await shapeOf();
    expect(before.children.length).toBeGreaterThanOrEqual(16);

    // The switch, all the way through: the menu item asks be-01, the next plan
    // read says Pri is displayed, and the pill loses its saving and changes its
    // name — the two changes that used to move the row.
    plan.serve({
      ...SUGGESTING,
      engine: 'optimized',
      displayed: 'pri',
      variants: {
        pri: { state: 'ready', proof: 'proven' },
        time: { state: 'ready', proof: 'proven' },
      },
      finishDays: { fast: 10, pri: 7, time: 10 },
      sameOrderAsFast: { pri: true, time: true },
    });
    await pill(page).click();
    await page.getByRole('menuitem', { name: /^Pri/ }).click();
    await expect(page.locator('[data-cue-active]')).toHaveText('Pri');
    expect(await page.locator('[data-cue-suggestion]').count()).toBe(0);

    const after = await shapeOf();
    for (const [at, child] of before.children.entries()) {
      // `.at` so the check is a check: a plain index is typed non-optional
      // under this workspace's compiler options.
      const found = after.children.at(at);
      if (found === undefined) throw new Error(`the toolbar lost a control: ${child.at}`);
      expect(found.x, `the toolbar moved under a switch: ${child.at}`).toBeCloseTo(child.x, 0);
      expect(found.y, `the toolbar moved under a switch: ${child.at}`).toBeCloseTo(child.y, 0);
    }
    expect(after.rows, 'the toolbar re-wrapped under a switch').toBe(before.rows);
    expect(after.height, 'the toolbar changed height under a switch').toBe(before.height);
  });

  test('opens on a click, and Escape gives the focus back to the pill', async ({ page }) => {
    await planWithACue(page);
    // Default actions: a click on a button, and Escape inside a menu. jsdom
    // performs neither, which is why this claim cannot be made there.
    await pill(page).click();
    const items = page.getByRole('menuitem');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('Escape');
    expect(await page.getByRole('menuitem').count()).toBe(0);
    await expect(pill(page)).toBeFocused();
  });

  test('asks be-01 for the schedule the reader picked', async ({ page }) => {
    await planWithACue(page);
    await pill(page).click();
    // The settings live on the project row, so the switch is a project PATCH
    // carrying the two schedule fields — not an optimization-scoped endpoint.
    const patched = page.waitForRequest(
      (request) =>
        request.method() === 'PATCH' &&
        /\/api\/projects\/[^/]+$/.test(new URL(request.url()).pathname),
    );
    await page.getByRole('menuitem', { name: /^Pri/ }).click();
    const request = await patched;
    expect(JSON.parse(request.postData() ?? '{}')).toEqual({
      scheduleEngine: 'optimized',
      scheduleObjective: 'pri',
    });
  });
});
