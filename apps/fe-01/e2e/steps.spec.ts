import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The Steps surface, in a browser.
 *
 * `steps-panel.test.tsx` proves what the section sends and what it says; this
 * file exists for the things jsdom cannot answer, and every one of them is
 * about the modal itself. `F shadcn-foundation` vendored `Modal` on Radix and
 * shipped it with **no production caller at all** — its focus trap, its Escape,
 * its click-away and the page-keyboard rule had a harness behind them and
 * nothing else. This is the first time any of them meets a browser:
 *
 * 1. **A real focus trap.** Radix moves the focus with `focusin` listeners and
 *    a sentinel at each end of the surface; jsdom fires none of that from a
 *    synthetic Tab, so a test there is asserting what it dispatched.
 * 2. **A real Escape and a real click away.** Both are Radix's own dismissal,
 *    and the second is a pointer event on the overlay rather than on anything
 *    this repository renders.
 * 3. **A real chord.** Ctrl+Enter typed into a field on the surface has to
 *    survive the capture-step listener `usePageShortcutsSuspended` registers on
 *    `window` and reach the dialog's own handler. That split was corrected on
 *    review with a jsdom test behind it; this is the browser saying so.
 * 4. **The three-step table.** `layout.spec.ts` has been measuring two steps
 *    since it was written, because two is all a project could ever have. C3-4
 *    in `openspec/changes/table-geometry-and-tab-order/verify.md` is the open
 *    item this closes: a third step, added through the UI, and the columns it
 *    brings with it.
 */

/** The chord, spelled for both platforms: `commandChord` takes Ctrl or Meta on Enter. */
const SUBMIT_CHORD = 'Control+Enter';

/** Registers a throwaway account and opens an empty project. */
async function signInWithAProject(page: Page, _account: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
}

/** Every column the table lays out, in order, read off the header cells. */
function columnsOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('thead [data-column]')].map(
      (cell) => cell.getAttribute('data-column') ?? '',
    ),
  );
}

/** Whether the focus is on the modal surface — the question a trap answers. */
function focusIsOnTheSurface(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest('[data-modal-surface]') !== null);
}

/**
 * Opens the Steps section: the `Project settings` control, then its tab.
 *
 * Two gestures since `project-config-modal` (2026-08-30), where this was one
 * button on the bar. The dialog it opens is the project's whole settings
 * surface, and every assertion below about the modal — the trap, Escape, the
 * click away, the focus restore — is now an assertion about that one modal
 * rather than about a steps dialog of its own.
 */
async function openSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Project settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Project settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Steps' }).click();
  await expect(page.getByLabel('New step')).toBeVisible();
}

let account = 0;

test.beforeEach(() => {
  account += 1;
});

/*
 * Not `e2e-steps-…`: the account menu's button is named after the account, and
 * `getByRole('button', { name: 'Steps' })` matched an accessible name by
 * substring — so a username with "steps" in it resolved that locator to two
 * elements. The button is `Project settings` now and the tab is what carries
 * `Steps`; this stays as the belt beside that.
 */
const throwaway = (): string => `e2e-ph-${String(Date.now())}-${String(account)}`;

test.describe('the steps surface, in a browser', () => {
  test('opens from the toolbar and holds the focus inside itself', async ({ page }) => {
    await signInWithAProject(page, throwaway());

    await openSteps(page);

    // More Tabs than there are controls on the surface, so the trap is asked
    // the only question worth asking: what happens past the last one. Radix
    // does this with sentinels and `focusin`, neither of which jsdom performs
    // for a dispatched key.
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      expect(await focusIsOnTheSurface(page), `Tab ${String(press + 1)} left the surface`).toBe(
        true,
      );
    }
  });

  test('Escape closes it and gives the focus back to the button that opened it', async ({
    page,
  }) => {
    await signInWithAProject(page, throwaway());
    const opener = page.getByRole('button', { name: 'Project settings' });
    await openSteps(page);

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('a click away closes it', async ({ page }) => {
    await signInWithAProject(page, throwaway());
    await openSteps(page);

    // The overlay, at a corner the surface cannot reach: a centred dialog is
    // at most 672px wide in the middle of the window, so 5,5 is the page behind it.
    await page.mouse.click(5, 5);

    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('Ctrl+Enter in the new-step box adds the step', async ({ page }) => {
    await signInWithAProject(page, throwaway());
    await openSteps(page);

    await page.getByLabel('New step').fill('Design');
    // The whole point of the split `F` shipped on review: the capture listener
    // on `window` claims `?`, Cmd+Z and the command chords for a target on the
    // page, and lets a chord through for a target on the surface. If it did
    // not, this keystroke would never reach the dialog and nothing would be
    // added.
    await page.keyboard.press(SUBMIT_CHORD);

    await expect(page.getByRole('button', { name: 'Remove Design' })).toBeVisible();
  });

  /**
   * A bare Enter in the new-step box adds the step, through the browser's own
   * implicit form submission and nothing this repository wrote.
   *
   * `steps-panel.test.tsx`'s `leaves a bare Enter to the form it is in` is the
   * jsdom half, and on its own it is satisfied by the environment rather than by
   * the code: jsdom performs **no** implicit submission at all, so a keydown it
   * dispatches never reaches a `submit` handler whatever `onChord` does with it.
   * That assertion cannot distinguish "the chord handler left Enter alone" from
   * "nothing here submits on Enter ever". Only a browser can.
   *
   * Proof: an unconditional `event.preventDefault()` at the top of `onChord` in
   * `steps-panel.tsx` — the fault the jsdom test is blind to — this failed on
   * `expect(locator).toBeVisible() … waiting for getByRole('button', { name:
   * 'Remove Design' })`, the step never added, while `leaves a bare Enter to
   * the form it is in` went on passing. Watched in Chromium, 2026-08-09.
   */
  test('a bare Enter in the new-step box adds the step', async ({ page }) => {
    await signInWithAProject(page, throwaway());
    await openSteps(page);

    await page.getByLabel('New step').fill('Design');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Remove Design' })).toBeVisible();

    // The plan behind the dialog, not only the list inside it: the step is a
    // column the table lays out, and the refetch the submit asked for is what
    // puts it there. A dialog that listed a step the table never grew would be
    // this test passing about half the behaviour.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Unfold Design estimates' })).toBeVisible();
  });

  test('a third step gives the table a third set of columns', async ({ page }) => {
    // C3-4, closed. The fixture the layout gate could never build: a project
    // with three steps, made the way somebody really makes one.
    await signInWithAProject(page, throwaway());
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();

    const twoSteps = await columnsOnScreen(page);
    expect(twoSteps.filter((id) => id.endsWith('-final'))).toHaveLength(2);
    const minWidthBefore = await page.evaluate(() =>
      Number.parseInt(document.querySelector('table')?.style.minWidth ?? '', 10),
    );
    expect(minWidthBefore).toBeGreaterThan(0);

    await openSteps(page);
    await page.getByLabel('New step').fill('Design');
    await page.getByRole('button', { name: 'Add step' }).click();
    await expect(page.getByRole('button', { name: 'Remove Design' })).toBeVisible();

    // The arithmetic the surface prints, while it is still open to print it.
    // 1343 → 1303 with contextual Links: a fresh plan has no references, so
    // its base layout no longer pays the Links column's 40px folded width.
    await expect(page.getByText('3 steps need ≥1303px of width to sit side by side')).toBeVisible();
    await page.keyboard.press('Escape');

    const threeSteps = await columnsOnScreen(page);
    expect(threeSteps.filter((id) => id.endsWith('-final'))).toHaveLength(3);
    await expect(page.getByRole('button', { name: 'Unfold Design estimates' })).toBeVisible();
    // One folded step is 96px. Compare the rendered before/after widths so
    // globally-created optional Tag/Service columns may be present without
    // turning this step-layout test into a cross-test directory-state test.
    const minWidthAfter = await page.evaluate(() =>
      Number.parseInt(document.querySelector('table')?.style.minWidth ?? '', 10),
    );
    expect(minWidthAfter - minWidthBefore).toBe(96);
  });

  test('a removal names what it would take, and takes nothing until the box is ticked', async ({
    page,
  }) => {
    await signInWithAProject(page, throwaway());
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();

    // A real estimate on QA, typed the way the folded cell takes one, so
    // be-01 has something to count.
    const qa = page.getByLabel('QA estimate for 010');
    await qa.click();
    await qa.fill('2/3/8');
    await page.getByLabel('Name of 010').click();
    // **`2/3/8`, not the `3.7` this asserted until `estimate-triple-visible`.**
    // The folded cell used to collapse a typed trio to its PERT figure the moment
    // it was left; that change is precisely the decision that it keeps the trio
    // and shows what it comes to beside it. `layout.spec.ts` asserts the same
    // value for the Dev cell.
    //
    // What this case actually needs from the line is unchanged and is why it is
    // still here: be-01 has a real estimate on QA to count, so the removal below
    // has something to name. The figure it settles to was never this test's
    // subject.
    await expect(qa).toHaveValue('2/3/8');

    await openSteps(page);
    await page.getByRole('button', { name: 'Remove QA' }).click();

    await expect(
      page.getByText('Removing the step QA would delete 1 estimate and 0 assignments.'),
    ).toBeVisible();
    // The cascade is a decision. The confirm is dead until it is made.
    const confirm = page.getByRole('button', { name: 'Remove QA' });
    await expect(confirm).toBeDisabled();

    await page.getByLabel('Delete them along with the step').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByRole('button', { name: 'Remove QA' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Unfold QA estimates' })).toBeHidden();
  });
});
