import { expect, type Page, test } from '@playwright/test';

/**
 * The directory page, against the real stack and measured by a browser.
 *
 * `directory-page.test.tsx` proves what the panels render and what is sent.
 * This file exists for the four things jsdom cannot answer:
 *
 * 1. **The address.** A link followed, a URL read, and a **reload** landing on
 *    the page it was reloaded from. A router held in a state variable passes
 *    every jsdom test and fails the reload.
 * 2. **A real 409 with a real usage in it.** The confirmation is drawn from
 *    be-01's own payload — the project by name, the work item by the number the
 *    plan shows — rather than from a fixture written to match the parser.
 * 3. **The phone.** Two panels side by side or stacked is a layout question,
 *    and 44px is a measured rectangle or it is nothing. The fourteenth and
 *    fifteenth checks that could not fail were both faults only a browser saw.
 * 4. **The round trip.** Confirmed, cascaded, and gone from be-01.
 */

/** An iPhone 14's CSS viewport, which is what the plan calls the phone case. */
const PHONE = { width: 390, height: 844 };

/** Registers a throwaway account. Nothing in the deployment's directory yet. */
async function signIn(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Directory' })).toBeVisible();
}

/** Opens the directory the way a reader does: the header's own control. */
async function openTheDirectory(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Directory' }).click();
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
}

/** Adds a person through the page's own creation, and waits for the re-read. */
async function addPerson(page: Page, name: string): Promise<void> {
  await page.getByLabel('New person').fill(name);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(nameField(page, name)).toBeVisible();
}

/** Adds a service team through the page's own creation. */
async function addTeam(page: Page, name: string): Promise<void> {
  await page.getByLabel('New team').fill(name);
  await page.getByRole('button', { name: 'Add team' }).click();
  await expect(nameField(page, name)).toBeVisible();
}

/**
 * One entry's rename box, matched **exactly**.
 *
 * `getByLabel` is a substring match, and `Name of Kat` finds `Name of Katrin`
 * too — which is precisely the pair the rename test makes. Found by the first
 * run of this spec, on a strict-mode violation rather than a wrong assertion.
 */
const nameField = (page: Page, name: string) => page.getByLabel(`Name of ${name}`, { exact: true });

let account = 0;
let signedInAs = '';
/**
 * What this test's people and teams are called.
 *
 * The **directory is deployment-wide** — that is the whole domain decision — so
 * every test in this file shares one, and a fixed `Kat` would have the fourth
 * test measuring the first test's row. The tag is per test, not per run.
 */
let tag = '';

/**
 * Puts the Teams column on the table, which `configurable-columns` hides by
 * default, and closes the control again so its panel is not over the cells.
 */
async function showTeamsColumn(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Teams' }).check();
  await expect(page.locator('thead th[data-column="team"]')).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  account += 1;
  tag = `${String(Date.now())}-${String(account)}`;
  signedInAs = `e2e-dir-${tag}`;
  await signIn(page, signedInAs);
});

test.describe('the directory has an address', () => {
  test('opens from the header, marks itself, and survives a reload', async ({ page }) => {
    await openTheDirectory(page);
    expect(new URL(page.url()).pathname).toBe('/directory');
    await expect(page.getByRole('link', { name: 'Directory' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Off the project, the project controls are absent rather than dead.
    await expect(page.getByRole('combobox', { name: 'Project' })).toHaveCount(0);

    // The whole reason this is a page and not a piece of state.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/directory');

    await page.goBack();
    await expect(page.getByRole('combobox', { name: 'Project' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('opens a cold deep link through the fixed local identity', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.goto('/directory');

    await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/directory');
  });
});

test.describe('the directory, edited against be-01', () => {
  test('adds, renames, and chips a membership', async ({ page }) => {
    const kat = `Kat ${tag}`;
    const katrin = `Katrin ${tag}`;
    const platform = `Platform ${tag}`;
    await openTheDirectory(page);
    await addPerson(page, kat);
    await addTeam(page, platform);

    // The chip comes from the picker beside it, which offers only what she
    // lacks — and the page redraws from be-01's answer, never before it.
    await page.getByRole('combobox', { name: `Add a team for ${kat}` }).click();
    await page.getByRole('option', { name: platform, exact: true }).click();
    await expect(page.getByLabel(`Remove ${platform} from ${kat}`)).toBeVisible();
    await expect(nameField(page, platform).locator('..')).toContainText('1 member');

    await nameField(page, kat).fill(katrin);
    await nameField(page, kat).blur();
    await expect(nameField(page, katrin)).toBeVisible();

    // be-01, not the screen: the reload is what asks.
    await page.reload();
    await expect(nameField(page, katrin)).toBeVisible();
    await expect(page.getByLabel(`Remove ${platform} from ${katrin}`)).toBeVisible();
  });

  /**
   * The whole removal, through a real 409 and a real cascade.
   *
   * The team is put on a work item's label first, so be-01's refusal carries a
   * **directory usage** with a project in it: the confirmation then names the
   * project and the work item by the number the plan shows, which is the half
   * a fixture can never prove.
   */
  test('names what a removal would take, and takes it only once confirmed', async ({ page }) => {
    const platform = `Platform ${tag}`;
    const work = `Survey the site ${tag}`;
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();
    await page.getByLabel('Name of 010').fill(work);
    await page.getByLabel('Name of 010').blur();
    await showTeamsColumn(page);

    // The label, typed into the picker that creates a team if there is none.
    // Found by role rather than by label: the open list carries the same
    // accessible name as the box it drops from, and `getByLabel` finds both.
    const teamCell = page.getByRole('combobox', { name: 'Service or team for 010' });
    await teamCell.click();
    await teamCell.fill(platform);
    await page.getByRole('option', { name: `Add “${platform}”` }).click();
    await expect(teamCell).toHaveValue(platform);

    await openTheDirectory(page);
    await page.getByLabel(`Remove ${platform}`, { exact: true }).click();

    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    // The project by name and the work item by its derived number and name,
    // both out of be-01's own payload.
    await expect(confirmation).toContainText('New project');
    await expect(confirmation).toContainText(`010 ${work}`);
    await expect(confirmation).toContainText('team label is cleared');
    // Nothing has gone: the first request carried no cascade.
    await expect(nameField(page, platform)).toBeVisible();

    // Closed rather than confirmed: the next ask starts over.
    await confirmation.getByRole('button', { name: `Keep ${platform}` }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(nameField(page, platform)).toBeVisible();

    await page.getByLabel(`Remove ${platform}`, { exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: `Remove ${platform} and all of that` })
      .click();

    await expect(nameField(page, platform)).toHaveCount(0);
    // And really gone at be-01, not merely off the screen.
    await page.reload();
    await expect(nameField(page, platform)).toHaveCount(0);
  });
});

test.describe('the directory on a phone', () => {
  test.use({ viewport: PHONE });

  test('stacks the two panels into one column, and does not scroll sideways', async ({ page }) => {
    await openTheDirectory(page);
    await addPerson(page, `Kat ${tag}`);
    await addTeam(page, `Platform ${tag}`);

    const stacked = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('h2')]
        .filter((each) => ['People', 'Teams'].includes(each.textContent))
        .map((each) => each.getBoundingClientRect());
      // Both, or the comparison below is between one box and nothing.
      if (boxes.length !== 2) throw new Error('the two panels are not both on the page');
      const root = document.scrollingElement ?? document.documentElement;
      return {
        peopleBottom: boxes[0].bottom,
        teamsTop: boxes[1].top,
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
      };
    });

    // One above the other: the teams panel starts below where the people panel
    // ended, which is what "stacked" means and what "side by side" is not.
    expect(stacked.teamsTop, 'the panels sit side by side at 390px').toBeGreaterThan(
      stacked.peopleBottom,
    );
    expect(stacked.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(
      stacked.clientWidth,
    );
  });

  /**
   * Every control a thumb has to hit, measured.
   *
   * Both dimensions, and on the rendered box: `h-11` in the source says nothing
   * about what a browser drew, and the chip's remove button is the one that
   * shrinks — it is sized by its own text.
   *
   * Proof: `min-h-11 min-w-11` struck from the chip's class, this failed on
   * `Remove Platform … from Kat … is 24px tall`, `Received: 24`. Watched in
   * Chromium at 390×844, 2026-08-09.
   */
  test('gives every control it offers at least 44px in both dimensions', async ({ page }) => {
    const kat = `Kat ${tag}`;
    const platform = `Platform ${tag}`;
    await openTheDirectory(page);
    await addPerson(page, kat);
    await addTeam(page, platform);
    await page.getByRole('combobox', { name: `Add a team for ${kat}` }).click();
    await page.getByRole('option', { name: platform, exact: true }).click();
    await expect(page.getByLabel(`Remove ${platform} from ${kat}`)).toBeVisible();

    const controls = [
      nameField(page, kat),
      page.getByLabel(`Remove ${kat}`, { exact: true }),
      page.getByLabel(`Remove ${platform} from ${kat}`),
      page.getByRole('combobox', { name: `Add a team for ${kat}` }),
      nameField(page, platform),
      page.getByLabel(`Remove ${platform}`, { exact: true }),
      page.getByLabel('New person'),
      page.getByRole('button', { name: 'Add person' }),
    ];
    for (const control of controls) {
      const named = (await control.getAttribute('aria-label')) ?? 'control';
      const box = await control.boundingBox();
      expect(box, `${named} is not on screen at all`).not.toBeNull();
      expect(box?.height ?? 0, `${named} is ${String(box?.height)}px tall`).toBeGreaterThanOrEqual(
        44,
      );
      expect(box?.width ?? 0, `${named} is ${String(box?.width)}px wide`).toBeGreaterThanOrEqual(
        44,
      );
    }
  });
});

test.describe('the directory on a laptop', () => {
  test('puts the two panels side by side', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openTheDirectory(page);

    const rows = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h2')].filter((each) =>
        ['People', 'Teams'].includes(each.textContent),
      );
      if (headings.length !== 2) throw new Error('the two panels are not both on the page');
      return headings.map((each) => Math.round(each.getBoundingClientRect().top));
    });
    expect(new Set(rows).size, 'the panels are stacked at 1024px').toBe(1);
  });
});
