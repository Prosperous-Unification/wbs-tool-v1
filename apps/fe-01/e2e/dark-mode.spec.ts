import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The palette, measured by a browser.
 *
 * Everything here is a fact jsdom cannot state. It computes no colours, so a
 * contrast ratio read there is a ratio between two strings; it has no
 * `prefers-color-scheme`, so `vitest.setup.ts` installs a stand-in and what
 * that stand-in proves is that this app *listens* rather than what a platform
 * actually *answers*; and it performs no default action for a key, so the half
 * of R5 #14 that says a prevented Enter does not become a click can only be
 * seen in Chromium. `lib/theme.test.ts` and `account-menu.test.tsx` hold the
 * rest.
 *
 * The numbers quoted below are what each of these assertions read when the fix
 * it covers is reverted — watched, not remembered, and recorded with the
 * command that produced them in `openspec/changes/dark-mode/verify.md`.
 */

/** Opens the fixed local identity and makes a plan two estimated rows deep. */
async function seedPlan(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  const first = page.getByLabel('Name of 010');
  await first.fill('Survey the existing warehouse racking');
  await first.blur();
  const second = page.getByLabel('Name of 020');
  await second.fill('Draft the replacement layout');
  await second.blur();
  for (const number of ['010', '020']) {
    const estimate = page.getByLabel(`Dev estimate for ${number}`);
    await estimate.fill('2/4/6');
    await estimate.blur();
    await expect(estimate).not.toHaveValue('');
  }
}

/** The one button in the header that opens the account menu. */
const accountTrigger = (page: Page): Locator => page.locator('header button[aria-haspopup="menu"]');

/**
 * Waits for the palette to finish arriving.
 *
 * Every button and link in the chrome carries `transition-colors`, so flipping
 * the class starts a ~150ms colour transition on each of them and a
 * `getComputedStyle` read taken inside that window answers with an interpolated
 * `oklab(…)` — a colour neither palette names. Measured: the header's
 * `Directory` link read `oklab(0.5209 …)` mid-flight against the dark header,
 * **1.03:1**, where its resting `oklch(0.984 …)` is 15.9:1. A settle this test
 * did not wait for is a red about nothing, and worse, a green about nothing:
 * `nothing on the page is painted a colour the palette never names` compares
 * backgrounds against a literal, and an interpolating one matches no literal at
 * all.
 *
 * `document.getAnimations()` and not one element's, because the flip moves every
 * surface at once and the reads below walk ancestors. Nothing in this app
 * animates without end (checked: no `animate-spin`, no `infinite`), so the
 * moving ones drain rather than wait out the timeout.
 *
 * Counted by `playState` rather than by the length of that list, and the
 * difference between the two is the whole of the standing `pixels` red on
 * `main` (runs 32281560107, 32360096281 and 32409649802: this line, `Expected:
 * 0 / Received: 12`, timing out at 10s). The twelve, dumped out of a real
 * Chromium on h2puni: the six colour properties of the `Input` and the six of
 * the `Save` button inside the saved-views `<details>` panel, every one of them
 * `playState: 'finished'`, `progress: null`, `currentTime` 550ms against a
 * 150ms `endTime` — over four times done. Chromium drops a finished
 * `CSSTransition` from this list at the target's next style recalculation, and
 * a closed `<details>` is a subtree it skips recalculating, so those twelve are
 * never collected and the list never empties. Waiting for it to is waiting for
 * something that will not happen.
 *
 * A finished transition fills nothing after its end time, so it paints nothing
 * and no `getComputedStyle` read below can see it. What this function is for is
 * that no colour is still being *interpolated* — which is what `running` and
 * `paused` mean, and what `finished` and `idle` (cancelled) do not. Stated as
 * the two that do not count rather than the two that do, so that a state this
 * engine grows later reads as unsettled and fails loudly instead of passing
 * quietly.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.playState !== 'finished' && a.playState !== 'idle').length,
      ),
    )
    .toBe(0);
}

/** Opens the account menu, takes the answer asked for, and lets the paint land. */
async function chooseTheme(page: Page, answer: 'System' | 'Light' | 'Dark'): Promise<void> {
  await accountTrigger(page).click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await settled(page);
}

/** Which palette the document is in, as the only thing that decides it. */
const paletteOf = (page: Page): Promise<'light' | 'dark'> =>
  page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));

/**
 * What an element's text stands off the surface behind it, as WCAG counts it.
 *
 * Composited rather than read off one node: almost nothing in this app paints
 * its own background, so `getComputedStyle(node).backgroundColor` is
 * `rgba(0, 0, 0, 0)` for the elements whose legibility is in question and a
 * ratio against transparent is a number about nothing. Every ancestor's paint
 * is stacked until an opaque one is found, which is what a reader's eye does.
 *
 * Rasterised through a canvas for `hover-cards.spec.ts`' reason: a token
 * resolves to `oklch(…)`, a `color-mix` to `oklab(…)`, and neither can be
 * turned into a luminance by reading the string. A colour this engine refuses
 * leaves `fillStyle` where it was, so the sentinel is what makes that loud
 * instead of silently measuring the last colour again.
 */
function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((node) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d context to rasterise a colour in');
    const rgbaOf = (colour: string): [number, number, number, number] => {
      const sentinel = '#ff00ff';
      ctx.fillStyle = sentinel;
      ctx.fillStyle = colour;
      if (ctx.fillStyle === sentinel) throw new Error(`this engine will not parse ${colour}`);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const painted = ctx.getImageData(0, 0, 1, 1).data;
      return [painted[0], painted[1], painted[2], painted[3] / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const luminance = (colour: [number, number, number]): number => {
      const channel = (raw: number): number => {
        const unit = raw / 255;
        return unit <= 0.03928 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
      };
      return (
        0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2])
      );
    };

    const stacked: [number, number, number, number][] = [];
    let ancestor: Element | null = node;
    while (ancestor !== null) {
      const painted = rgbaOf(getComputedStyle(ancestor).backgroundColor);
      if (painted[3] > 0) stacked.push(painted);
      if (painted[3] === 1) break;
      ancestor = ancestor.parentElement;
    }
    // White, because that is what a browser paints a document nothing painted —
    // and reaching this with an empty stack means the page itself named no
    // background, which is a fault worth measuring against the canvas it lands
    // on rather than throwing over.
    let surface: [number, number, number] = [255, 255, 255];
    for (const layer of stacked.reverse()) surface = over(layer, surface);

    const ink = over(rgbaOf(getComputedStyle(node).color), surface);
    const [brighter, dimmer] = [luminance(ink), luminance(surface)].sort((a, b) => b - a);
    return (brighter + 0.05) / (dimmer + 0.05);
  });
}

/** What WCAG asks of body text, and what every ratio below is held to. */
const READABLE = 4.5;

/**
 * The faces a `<button>` paints itself when no author stylesheet gives it one —
 * **both** of them.
 *
 * `ButtonFace` is not one colour: it is whatever the user agent thinks the page
 * is, and `color-scheme` is what tells it. On a light page Chromium paints
 * `rgb(239, 239, 239)`; the moment `color-scheme: dark` reaches the root it
 * paints `rgb(107, 107, 107)` instead. Measured on this branch, 2026-08-12, by
 * reverting each fix in turn.
 *
 * Naming only the light one is how this assertion was written first, and it was
 * a check that could not fail: with `color-scheme` fixed, no element on a dark
 * page is ever `rgb(239, 239, 239)`, so the sweep passed with the `<button>`
 * reset deleted. That is the exact defect class R5 exists for, caught by
 * watching the red that never came.
 *
 * The mid-grey is legible — 5.13:1 under the dark palette's near-white ink — so
 * this is not a contrast claim and could not be made as one. It is the claim the
 * requirement actually states: no surface is painted a colour the palette does
 * not name.
 */
const USER_AGENT_BUTTON_FACES = ['rgb(239, 239, 239)', 'rgb(107, 107, 107)'];

/** What Chromium paints an unstyled `<a href>` on a page it has been told is dark. */
const USER_AGENT_DARK_LINK = 'rgb(158, 158, 255)';

/**
 * Every visible element on the page painted one of the user agent's own button
 * faces, named so a failure says which.
 *
 * Palette-agnostic on purpose, and used from both palettes: the requirement is
 * "no surface is painted a colour the palette does not name", and neither of
 * {@link USER_AGENT_BUTTON_FACES} is named by either palette.
 */
function unnamedFaces(page: Page): Promise<string[]> {
  return page.evaluate((unnamed) => {
    const found: string[] = [];
    for (const node of document.querySelectorAll('*')) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (unnamed.includes(style.backgroundColor)) {
        found.push(`${node.tagName.toLowerCase()} «${node.textContent.slice(0, 24)}»`);
      }
    }
    return found;
  }, USER_AGENT_BUTTON_FACES);
}

let account = 0;

test.beforeEach(async ({ page }) => {
  account += 1;
  await seedPlan(page, `dark${String(Date.now()).slice(-8)}${String(account)}`);
});

test.describe('the theme control', () => {
  test('repaints the page, and the answer outlives the tab', async ({ page }) => {
    expect(await paletteOf(page)).toBe('light');

    await chooseTheme(page, 'Dark');

    expect(await paletteOf(page)).toBe('dark');
    // Not only the class: the tokens it re-points are what anything is painted
    // from, and a class nothing hangs off is the state this change found.
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await expect(accountTrigger(page)).toBeVisible();
    expect(await paletteOf(page)).toBe('dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      background,
    );

    await accountTrigger(page).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('is dark at the first paint, before the app has mounted', async ({ page }) => {
    await chooseTheme(page, 'Dark');

    // The app's own entry module, refused. Without it React never mounts, so
    // whatever is on the root element at this point was put there by the
    // bootstrap in `index.html` and by nothing else — which is the claim, and
    // it cannot be made against a page that has already rendered.
    await page.route('**/src/main.tsx', (route) => route.abort());
    await page.goto('/');

    expect(await page.locator('#root').innerHTML()).toBe('');
    expect(await paletteOf(page)).toBe('dark');

    // The class, and deliberately not `color-scheme`. Under the dev server the
    // stylesheet is an import of the entry module this test just refused, so
    // there is no `.dark { color-scheme: dark }` on the page to read and
    // Chromium answers `normal` — a fact about Vite's dev pipeline rather than
    // about the bootstrap. Watched: asserting it here failed on
    // `expected 'normal' to be 'dark'` with the bootstrap working perfectly.
    // `hands the platform its own controls in the right palette` makes that
    // claim against a page whose stylesheet has loaded, which is the only page
    // it is a claim about.
  });

  test('follows the machine while nothing has been chosen, and stops when something is', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(accountTrigger(page)).toBeVisible();
    expect(await paletteOf(page)).toBe('dark');

    // Live, on the open page: no reload between these two.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => paletteOf(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => paletteOf(page)).toBe('dark');

    await chooseTheme(page, 'Light');

    // Chosen outranks the machine, which is the whole reason there are three
    // states and not a checkbox.
    expect(await paletteOf(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(accountTrigger(page)).toBeVisible();
    expect(await paletteOf(page)).toBe('light');
  });

  test('hands the platform its own controls in the right palette', async ({ page }) => {
    const scheme = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    expect(await scheme()).toBe('light');

    await chooseTheme(page, 'Dark');

    // What a scrollbar, a caret and a date picker read — none of which is a
    // token, and all of which stay light on a dark page without this.
    expect(await scheme()).toBe('dark');
  });

  test('takes the platform’s grey off the light page too, not only the dark one', async ({
    page,
  }) => {
    // **The light palette changes here, and until 2026-08-12 nothing said so.**
    // `button:not([data-grid], …) { background-color: transparent }` is in
    // `@layer base` and is not scoped to `.dark`, so the three buttons that
    // carried Chromium's `rgb(239, 239, 239)` — the Gantt's `Arrows` switch and
    // its two row labels, none of which any rule paints — lose it on a light
    // page as well. That is an improvement and it is what the requirement
    // states, since the grey chip was never a token; what it was not is
    // measured. Every other assertion in this file runs behind
    // `chooseTheme(page, 'Dark')`, and no other spec reads a `backgroundColor`
    // at all, so a real change to the light UI shipped inside a change whose
    // body describes dark-palette repairs. Cross-review, 2026-08-12.
    //
    // Proof: the `<button>` reset deleted, this failed on `the Gantt chart …
    // Received + Array [ "button «Arrows»", "button «010 - Survey the
    // existin»", "button «020 - Draft the replacem»" ]` — the same three
    // elements, by name, that `verify.md`'s red records against the **dark**
    // page. Watched on h2puni in the Playwright image, 2026-08-12, before
    // `declutter-one-button` landed: that switch reads `Detail` now and gates
    // three families rather than the arrows alone, so the same injection
    // reports `button «Detail»` in its place. The assertion is a count of
    // unnamed faces and names no button, so nothing here depends on the word.
    expect(await paletteOf(page), 'this test is about the palette nothing chose').toBe('light');

    expect(await unnamedFaces(page), 'the plan').toEqual([]);

    await page.getByRole('button', { name: 'Gantt' }).click();
    await expect(page.locator('[data-gantt-panel]')).toBeVisible();
    expect(await unnamedFaces(page), 'the Gantt chart').toEqual([]);

    await accountTrigger(page).click();
    expect(await unnamedFaces(page), 'the account menu').toEqual([]);
  });

  test('answers the arrows after a palette was taken with the mouse', async ({ page }) => {
    // The menu is kept open on purpose after a palette is chosen, so a reader
    // can compare and keep choosing — and until 2026-08-12 the next arrow key
    // after a **mouse** click was dead. `active` is the roving tab stop's
    // index and only the arrows ever moved it, so a click left it at the way
    // out (index 3) while Chromium put the DOM focus on the clicked radio.
    // Press the arrow that computes 3 from where the eye is — ArrowDown from
    // `Dark` at index 2 — and `setActive` is handed the value it already
    // holds: React bails out, the focus effect's deps do not change, and
    // nothing moves.
    //
    // Only a browser can see it. `account-menu.test.tsx` drives by keyboard,
    // where the two never disagree, and jsdom's `fireEvent.click` moves no
    // focus even where it does.
    //
    // Proof: `onFocus` taken back off `itemProps` in `account-menu.tsx`, this
    // failed on `the arrow after a click moved no focus … 24 × locator
    // resolved to <button tabindex="0" … role="menuitem">Log out</button> -
    // unexpected value "inactive"` — the item the arrow should have reached
    // was on the page, tabbable, and never focused. Watched on h2puni in the
    // Playwright image, 2026-08-12.
    await accountTrigger(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();

    await page.keyboard.press('ArrowDown');

    // Past the last radio is the way out, which is what index 3 is.
    await expect(
      page.getByRole('menuitem', { name: 'Log out' }),
      'the arrow after a click moved no focus',
    ).toBeFocused();

    // And back up the way it came, which is what says the index the arrow
    // computed from was the clicked item's and not a number left over.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();
  });

  test('leaves a modified Enter to whatever it was aimed at', async ({ page }) => {
    await accountTrigger(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).focus();

    await page.keyboard.press('Control+Enter');

    // R5 #14's fault, in a browser: a guard that returned without
    // `preventDefault` would leave Chromium to fire the button's own click and
    // take the item anyway. jsdom performs no default action, so it can see
    // the guard deleted and never the guard left half-done.
    expect(await paletteOf(page)).toBe('light');
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

test.describe('what the dark palette paints', () => {
  test.beforeEach(async ({ page }) => {
    await chooseTheme(page, 'Dark');
  });

  test('the Gantt’s row labels stand off the column they are in', async ({ page }) => {
    await page.getByRole('button', { name: 'Gantt' }).click();
    await expect(page.locator('[data-gantt-panel]')).toBeVisible();

    const label = page.locator('[data-gantt-label]').first();
    await expect(label).toBeVisible();

    // 1.10:1 before this change: a `<button>` naming no background kept the
    // user agent's `ButtonFace`, and with the root still declaring no
    // `color-scheme` that face was the light one — `rgb(239, 239, 239)` under
    // the dark palette's near-white ink. Fixed by `color-scheme: dark` first
    // and by the `<button>` reset second; `nothing on the page is painted a
    // colour the palette never names` is what holds the second one.
    const ratio = await contrastOf(label);
    expect(ratio, `a Gantt row label reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      READABLE,
    );
  });

  test('the way out of the app stands off the menu it is in', async ({ page }) => {
    await accountTrigger(page).click();
    const logOut = page.getByRole('menuitem', { name: 'Log out' });
    await expect(logOut).toBeVisible();

    // The same 1.10:1, and the same fault: the menu is a `bg-popover` card and
    // the item on it painted itself grey.
    const ratio = await contrastOf(logOut);
    expect(ratio, `Log out reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(READABLE);

    // The three answers above it are read on the same card.
    for (const answer of ['System', 'Light', 'Dark']) {
      const item = page.getByRole('menuitemradio', { name: answer });
      const itemRatio = await contrastOf(item);
      expect(itemRatio, `${answer} reads at ${itemRatio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        READABLE,
      );
    }
  });

  test('the header’s page links are chrome rather than the browser’s blue', async ({ page }) => {
    const link = page.getByRole('link', { name: 'Directory' });
    await expect(link).toBeVisible();

    // 2.14:1 before: `buttonVariants` names no colour for `ghost` at rest and
    // the reset gives `color: inherit` to form controls and not to anchors, so
    // these kept `-webkit-link` — `rgb(0, 0, 238)` on a near-black page.
    const ratio = await contrastOf(link);
    expect(ratio, `the Directory link reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      READABLE,
    );

    // The ratio alone is a check that cannot fail here, and it was written as
    // one. `color-scheme: dark` moves the user agent's own link colour to
    // `rgb(158, 158, 255)`, which reads at 8.0:1 — so with `text-foreground`
    // deleted this test stayed green while the header was painted a periwinkle
    // no token names. Watched, 2026-08-12. The claim is therefore what the
    // requirement says: the link is the palette's ink, not the browser's guess
    // at one.
    const colour = await link.evaluate((node) => getComputedStyle(node).color);
    expect(colour, 'the Directory link kept a user agent link colour').not.toBe(
      USER_AGENT_DARK_LINK,
    );
    expect(colour, 'the Directory link is not the palette’s own ink').toBe(
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--foreground)';
        document.body.append(probe);
        const painted = getComputedStyle(probe).color;
        probe.remove();
        return painted;
      }),
    );
  });

  test('the dependency picker is a card of the palette’s own colour', async ({ page }) => {
    await page.getByLabel('Add a dependency to 020').click();
    const option = page.locator('[role="option"]').first();
    await expect(option).toBeVisible();

    // 1.05:1 before: the one popover in the app that never took the palette,
    // a `#fff` card under near-white text.
    const ratio = await contrastOf(option);
    expect(ratio, `a dependency option reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      READABLE,
    );

    const list = page.locator('[role="listbox"]').first();
    expect(await list.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--popover)';
        document.body.append(probe);
        const painted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return painted;
      }),
    );
  });

  test('nothing on the page is painted a colour the palette never names', async ({ page }) => {
    const face = (): Promise<string[]> => unnamedFaces(page);

    expect(await face(), 'the plan').toEqual([]);

    await page.getByRole('button', { name: 'Gantt' }).click();
    await expect(page.locator('[data-gantt-panel]')).toBeVisible();
    expect(await face(), 'the Gantt chart').toEqual([]);

    await accountTrigger(page).click();
    expect(await face(), 'the account menu').toEqual([]);
  });
});
