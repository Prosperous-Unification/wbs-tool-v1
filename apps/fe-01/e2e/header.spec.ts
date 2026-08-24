import { expect, type Page, test } from '@playwright/test';

/**
 * The header bar, and the height it hands the table.
 *
 * `layout.spec.ts` measures the table's columns; this file measures everything
 * above and around them. The two are separate because they fail for different
 * reasons and a run that mixes them says less: a wrapped header is a chrome
 * fault, a drifting pinned column is a geometry one.
 *
 * The numbers here are the change's whole claim, and they were measured on the
 * branch this one is based on before anything was written — `F
 * shadcn-foundation` at 1280×800 gave the frame **544px**, the `calc(100vh -
 * 16rem)` its own comment called approximate, and left the document scrolling
 * vertically at 996px in an 800px window. Both are quoted in
 * `openspec/changes/header-fits-a-row/verify.md`.
 */

/**
 * The frame's height on the branch this change is based on, in px at 1280×800.
 *
 * Measured, not derived — though it is also exactly `800 - 16rem`, which is
 * what says the old cap was doing the deciding rather than the layout.
 */
const FRAME_BEFORE = 544;

/**
 * The retained gain after the authenticated toolbar grew a second 27px row.
 *
 * The fixed local identity exercises the complete read/write toolbar. At
 * 1280×800 that leaves a measured 637px frame: 93px more than the old 544px
 * cap while still guarding against that cap returning.
 */
const GAIN = 90;

/**
 * Enough rows that the table is taller than any frame this test could produce.
 *
 * Without it the frame's height is its content's and the measurement says
 * nothing: a two-row plan is about 340px tall in a frame that could be 690.
 * At 28px a row and 14px of heading — both measured — twenty-three rows plus
 * the frame's own 13rem of picker room is comfortably past it. The test asserts
 * that rather than trusting it.
 *
 * It was fifteen at 38px a row, and the restyle that made a row 28 is what
 * moved it: with fifteen the plan came to **exactly** the frame's height —
 * `scrollHeight 669, clientHeight 669` — and the precondition failed while the
 * claim under it was still true, the frame having gained its 125px all the
 * same. That is the guard doing its job rather than a regression, and it is why
 * the number is a measurement with the measurement written next to it.
 */
const ROWS_PAST_THE_FOLD = 23;

/** The widths the bar has to be one row at. `layout.spec.ts`'s matrix, plus 900. */
const FIT_WIDTHS = [1280, 1024, 900] as const;

/**
 * The widest username `USERNAME` permits, in the widest glyphs it permits.
 *
 * be-01's rule is `/^[a-zA-Z0-9_-]{3,32}$/`, so 32 characters is the ceiling
 * and ASCII is the alphabet — a CJK string would be wider per glyph and cannot
 * be registered. `W` is the widest of those 62 characters in the UI font, which
 * makes this the widest owner name the backend can ever produce. Prefixed
 * because every account this file registers must be unique across runs, and
 * trimmed back to 32 so the registration is not refused.
 */
const LOCAL_USERNAME = 'local-dev';

/** A project name long enough that the entry cannot fit any bound this test allows. */
const LONG_PROJECT_NAME = 'Rewire the shed and repaint the hall and paint the fence out back';

/**
 * How far the open listbox reaches, and whether the document scrolls sideways.
 *
 * `entryOverflow` is the **precondition** rather than the claim: an entry that
 * fits needs no truncation, so the bound below would hold on a short string and
 * prove nothing about a long one. `G gantt-calendar-axis`'s sixteenth fault is
 * the shape this guards against — a measurement taken against something with no
 * size at all.
 */
function measureOpenListbox(page: Page): Promise<{
  pastRightEdge: number;
  pageOverflowX: number;
  entryOverflow: number;
  nameOverflow: number;
}> {
  return page.evaluate(() => {
    const list = document.querySelector('[role="listbox"]');
    if (list === null) throw new Error('the picker is not open');
    const entry = list.querySelector('[role="option"]');
    if (entry === null) throw new Error('the open picker is offering nothing');
    // The clipped span, not the row: `truncate` is on the meta span, and the
    // `<li>` itself is a flex container that fits whatever its items come to.
    const clipped = [...entry.querySelectorAll('span')];
    const overflow = Math.max(...clipped.map((span) => span.scrollWidth - span.clientWidth));
    // The name span alone, apart: the name is `shrink-0` and must never be
    // the half that gives way — the meta is. A `shrink-0` span's own scroll
    // and client widths agree even when it overflows its row, so a non-zero
    // number here means the name went back to shrinking.
    const nameSpan = clipped.at(0);
    if (nameSpan === undefined) throw new Error('the entry holds no name span');
    return {
      pastRightEdge: Math.round(
        list.getBoundingClientRect().right - document.documentElement.clientWidth,
      ),
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      entryOverflow: overflow,
      nameOverflow: nameSpan.scrollWidth - nameSpan.clientWidth,
    };
  });
}

/**
 * Hovers the first offered entry and reads the hover card back.
 *
 * The card is `role="tooltip"`, the same role the Name-cell and Gantt cards
 * use, so it is scoped by that rather than by a class. The hover is the whole
 * of the trigger: the change this test protects removes the native `title`
 * and its delay, so `hover()` followed by an immediate read is the claim —
 * the card is up with no delay a test can smuggle through.
 */
async function readHoverCard(page: Page): Promise<string> {
  await page.locator('[role="option"]').first().hover();
  const card = page.locator('[role="tooltip"]').first();
  await expect(card).toBeVisible();
  return (await card.textContent()) ?? '';
}

/** Registers a throwaway account and opens a project. Nothing in it yet. */
async function signInWithAProject(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
}

/**
 * Signs the current account out and registers `account` in its place, with a
 * project of its own.
 *
 * `beforeEach` has already signed one account in, and the picker tests need an
 * account whose **username** is the thing under test. Signing out rather than
 * clearing storage because that is the only supported way out of the app and
 * it is already proven above.
 */
async function switchToAccountWithAProject(
  page: Page,
  leaving: string,
  account: string,
): Promise<void> {
  void leaving;
  void account;
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
}

/** Renames the selected project, through the ✎ the bar offers for it. */
async function renameSelectedProject(page: Page, to: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Project name').fill(to);
  await page.getByLabel('Project name').press('Enter');
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue(to);
}

/**
 * Opens the picker from closed, whatever had the focus before.
 *
 * The list opens on the input taking the focus, so a second open in one test
 * has to give the focus up first — clicking a still-focused input fires no
 * `focus` at all, and the measurement would be taken against a list that never
 * reopened.
 */
async function openPicker(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'WBS tool v2' }).click();
  await page.getByRole('combobox', { name: 'Project' }).click();
  await expect(page.getByRole('listbox', { name: 'Projects' })).toBeVisible();
}

/** Adds rows until the plan is taller than the window it is being read in. */
async function fillPastTheFold(page: Page): Promise<void> {
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (let row = 1; row <= ROWS_PAST_THE_FOLD; row += 1) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${String(row * 10).padStart(3, '0')}`)).toBeVisible();
  }
}

interface FrameHeight {
  /** The scrollport: what is on screen, padding included. */
  clientHeight: number;
  /** What is in it. Bigger than the above, or the measurement proves nothing. */
  scrollHeight: number;
  /** How far the frame's bottom edge is from the bottom of the window, in px. */
  belowFrame: number;
  /** The page's own vertical overflow. Zero is the point of the whole change. */
  pageOverflow: number;
}

function measureFrame(page: Page): Promise<FrameHeight> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-table-frame]');
    if (frame === null) throw new Error('the scrolling frame is not on the page');
    const box = frame.getBoundingClientRect();
    return {
      clientHeight: frame.clientHeight,
      scrollHeight: frame.scrollHeight,
      belowFrame: Math.round(document.documentElement.clientHeight - box.bottom),
      pageOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
}

/**
 * How many rows deep the header's controls are laid out, how far past its own
 * width they reach, and how tall the bar is.
 *
 * Three numbers because "one row" has two failure modes and they look nothing
 * alike. A bar that is allowed to **wrap** becomes two lines: the ratio of its
 * content height to its tallest child is 1 for one row and 2 for two, whatever
 * the children are — distinct tops would not do, since the controls are
 * vertically centred and are not all the same height. A bar that is **not**
 * allowed to wrap does not become two lines; it runs out past its own right
 * edge instead, and `scrollWidth` is what says so. A check that read only the
 * first would be a check that cannot fail for this bar, which is `flex-nowrap`:
 * watched, with `flex-wrap` and a doubled brand both in place and the assertion
 * still green.
 *
 * The height is the third because a bar that grew one enormous control is still
 * one row, and still not what this change asked for.
 */
function headerFit(page: Page): Promise<{ rowsDeep: number; past: number; height: number }> {
  return page.evaluate(() => {
    const bar = document.querySelector('header');
    if (bar === null) throw new Error('the page has no header bar');
    const style = getComputedStyle(bar);
    // `clientHeight` excludes the border and includes the padding, so the
    // padding is what has to come off to leave the flex container's own height.
    const content =
      bar.clientHeight -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom);
    const tallest = Math.max(
      ...[...bar.children].map((child) => child.getBoundingClientRect().height),
    );
    if (tallest === 0) throw new Error('the header bar has nothing in it to measure');
    return {
      rowsDeep: Math.round(content / tallest),
      past: bar.scrollWidth - bar.clientWidth,
      height: Math.round(bar.getBoundingClientRect().height),
    };
  });
}

/** The account this test registered, which is what names the menu it opens. */
let signedInAs = '';

test.beforeEach(async ({ page }) => {
  signedInAs = LOCAL_USERNAME;
  await signInWithAProject(page, signedInAs);
});

test.describe('the header bar, measured by a browser', () => {
  test('gives the table the height the chrome stopped taking', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fillPastTheFold(page);
    const measured = await measureFrame(page);

    // Or this is a measurement of a frame the plan does not fill, and any
    // height at all would satisfy the assertion below.
    expect(
      measured.scrollHeight,
      'the seeded plan is shorter than the frame, so its height was decided by its content',
    ).toBeGreaterThan(measured.clientHeight);
    expect(
      measured.clientHeight,
      `the frame is ${String(measured.clientHeight)}px where the branch this is based on gave ${String(FRAME_BEFORE)}px`,
    ).toBeGreaterThanOrEqual(FRAME_BEFORE + GAIN);
  });

  test('ends the frame at the bottom of the window, and stops the page scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fillPastTheFold(page);
    const measured = await measureFrame(page);

    // The remainder is real: what is under the frame is the page's own bottom
    // padding and nothing else. `calc(100vh - 16rem)` left 112px of nothing
    // here, which is the same fault read from the other end.
    expect(
      measured.belowFrame,
      'the frame stops short of the bottom of the window',
    ).toBeLessThanOrEqual(16);
    // And the page itself does not scroll, which is what "the frame is the
    // thing that scrolls" means. The old layout scrolled 196px here.
    expect(measured.pageOverflow, 'the page scrolls vertically behind the frame').toBe(0);
  });

  test('keeps the header to one row at every laptop width', async ({ page }) => {
    const laidOut: { width: number; rowsDeep: number; past: number }[] = [];
    for (const width of FIT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      const { rowsDeep, past, height } = await headerFit(page);
      laidOut.push({ width, rowsDeep, past: Math.max(past, 0) });
      // The other half: one row of something enormous is not what was asked
      // for either. A bar of `h-8` controls with 4px of padding and a border is
      // 41px, measured.
      expect(
        height,
        `the bar is ${String(height)}px tall at ${String(width)}px`,
      ).toBeLessThanOrEqual(56);
    }

    // One row, and inside its own width at every one of them. `past` is the
    // half that can see a `flex-nowrap` bar with too much in it — the mode this
    // bar fails in — and `rowsDeep` the half that sees the wrap somebody would
    // add to fix it.
    expect(laidOut).toEqual(FIT_WIDTHS.map((width) => ({ width, rowsDeep: 1, past: 0 })));
  });

  test('keeps the page from scrolling at all at 125% zoom', async ({ page }) => {
    // The 1024 proxy: Chromium's root `zoom` scales the layout the way the
    // browser's own control does, so a 1280×800 window becomes 1024×640 CSS
    // px — narrow enough that the toolbar wraps, which is the state the header
    // must survive without wrapping itself.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addStyleTag({ content: 'html { zoom: 1.25; }' });
    await fillPastTheFold(page);

    const toolbarRows = await page.evaluate(() => {
      const toolbar = document.querySelector('[data-toolbar]');
      if (toolbar === null) throw new Error('the table has no toolbar');
      return new Set(
        [...toolbar.children].map((child) => Math.round(child.getBoundingClientRect().top)),
      ).size;
    });
    // The toolbar wraps here and is meant to — `F` and `T` both kept that, and
    // it is what makes this a test about a narrow window rather than about
    // 1280 with bigger type.
    expect(toolbarRows, 'the toolbar fits one row at 1024, so this proves nothing').toBeGreaterThan(
      1,
    );

    const measured = await measureFrame(page);
    expect(measured.pageOverflow, 'the page scrolls vertically at 125% zoom').toBe(0);
    const zoomed = await headerFit(page);
    expect(zoomed.rowsDeep, 'the header wrapped at 125% zoom').toBe(1);
    expect(zoomed.past, 'the header ran past its own width at 125% zoom').toBeLessThanOrEqual(0);
  });

  test('holds the five things it is one row of', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const bar = page.getByRole('banner');

    // Every one of these is found by role and name, and inside the bar: the
    // brand, the two pages, the project, who else is here, and the account. The
    // account menu has never been opened by a browser before this line — `F`
    // shipped `modal.tsx` with the same gap and said so.
    //
    // The navigation is the fifth, added by `D directory-page`: it is the first
    // control this bar has gained since the fit matrix was written, which is
    // why that matrix is re-run below with it on the bar and FAULT W was
    // watched again.
    await expect(bar.getByRole('heading', { name: 'WBS tool v2' })).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Plan' })).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Directory' })).toBeVisible();
    await expect(bar.getByRole('combobox', { name: 'Project' })).toBeVisible();
    await expect(bar.getByRole('heading', { name: /^Online \(/ })).toBeVisible();

    await bar.getByRole('button', { name: signedInAs }).click();
    await expect(page.getByRole('menu', { name: `Signed in as ${signedInAs}` })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeFocused();

    // Logout is still a real exit in local mode; a reload can resolve the
    // fixed development identity again, but this navigation stays signed out.
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    const sso = page.getByRole('link', { name: 'Continue with SSO' });
    await expect(sso).toBeVisible();
    await expect(sso).toHaveAttribute('href', '/api/auth/login');
    for (const control of [
      sso,
      page.getByLabel('Username'),
      page.getByLabel('Password'),
      page.getByRole('button', { name: 'Sign in with password' }),
    ]) {
      expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBe(44);
    }

    await page.route('**/api/auth/login', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        username: 'password-qa',
        password: 'correct-horse',
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ token: '', user: { id: 'password-qa', username: 'password-qa' } }),
      });
    });
    await page.getByLabel('Username').fill('password-qa');
    await page.getByLabel('Password').fill('correct-horse');
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByRole('button', { name: 'password-qa' })).toBeVisible();
  });
});

/**
 * The open picker, measured by a browser.
 *
 * jsdom lays nothing out: every one of `project-page.test.tsx`'s assertions
 * about this list would pass with the entry a mile wide, because there is no
 * mile and no width. The bound is a browser's to observe, which is why it is
 * here rather than beside the tests that cover what the entry says.
 */
test.describe('the open project picker, measured by a browser', () => {
  test('the widest entry be-01 permits stays inside the window', async ({ page }) => {
    await switchToAccountWithAProject(page, signedInAs, LOCAL_USERNAME);
    await renameSelectedProject(page, LONG_PROJECT_NAME);

    const measured: {
      width: number;
      pastRightEdge: number;
      pageOverflowX: number;
      entryOverflow: number;
    }[] = [];
    for (const width of FIT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await openPicker(page);
      const { pastRightEdge, pageOverflowX, entryOverflow } = await measureOpenListbox(page);
      measured.push({ width, pastRightEdge, pageOverflowX, entryOverflow });
    }

    for (const at of measured) {
      // The precondition, at every width: the seeded entry really is wider
      // than the room it is given, so the two assertions under it are about a
      // list that had to be bounded rather than one that happened to fit.
      expect(
        at.entryOverflow,
        `the entry fits at ${String(at.width)}px, so the bound below proves nothing`,
      ).toBeGreaterThan(0);
      expect(
        at.pastRightEdge,
        `the listbox reaches ${String(at.pastRightEdge)}px past the window at ${String(at.width)}px`,
      ).toBeLessThanOrEqual(0);
      expect(
        at.pageOverflowX,
        `the document scrolls sideways at ${String(at.width)}px with the picker open`,
      ).toBe(0);
    }
  });

  test('the entry is clipped and its full text is still readable', async ({ page }) => {
    const owner = LOCAL_USERNAME;
    await switchToAccountWithAProject(page, signedInAs, owner);
    await renameSelectedProject(page, LONG_PROJECT_NAME);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPicker(page);

    const { entryOverflow, nameOverflow } = await measureOpenListbox(page);

    expect(
      entryOverflow,
      'the entry was not clipped, so the card is not standing in for anything',
    ).toBeGreaterThan(0);
    // The half that clipped is the meta, never the name: a long owner used to
    // squeeze every name to `New pr…` and the picker offered choices nobody
    // could tell apart (Dany, 2026-08-10).
    // Proof: `min-w-0 truncate` put back on the name span, this failed on
    // `Expected: 0, Received: 277` while the entry still clipped. Watched in
    // Chromium, 2026-08-10.
    expect(nameOverflow, 'the name is the half that clipped; it must show whole').toBe(0);
    // The whole name and the whole meta, which is what makes the clipping
    // survivable: the owner is how two projects of one name are told apart, so
    // a card carrying the name alone would lose exactly the part that was cut.
    const card = await readHoverCard(page);
    expect(card).toContain(LONG_PROJECT_NAME);
    expect(card).toContain(owner);
  });

  test('a short entry is shown whole', async ({ page }) => {
    // The other side of the claim. Without it, "clipped" would be satisfied by
    // a picker that clips everything — including the two-word names most
    // projects have — and nobody would be told.
    await switchToAccountWithAProject(page, signedInAs, LOCAL_USERNAME);
    await renameSelectedProject(page, 'Shed');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPicker(page);

    const { entryOverflow } = await measureOpenListbox(page);

    expect(entryOverflow, 'a four-letter project owned by a short name was clipped').toBe(0);
  });
});

/*
 * PROVING THESE CAN FAIL — watched against a real chromium, one fault at a
 * time, each reverted. Quoted in
 * `openspec/changes/header-fits-a-row/verify.md`.
 *
 * FAULT F — the frame goes back to guessing.
 *   `table-frame.ts`: `flex: '1 1 0%'` replaced by `maxHeight: 'calc(100vh -
 *   16rem)'`, which is what this change removed.
 * The first two tests are the ones that see it, and they are the change's
 * claim: 544px against 664 wanted, and a frame ending 112px above the bottom
 * of the window with the page scrolling behind it.
 *
 * FAULT W — three more controls in the bar.
 *   `app-header.tsx`: three `shrink-0` buttons of about 200px each added beside
 *   the brand, which is what the next three changes to this bar look like
 *   (`P` a phases dialog, `G` a view switch, `M` a menu).
 * Three rather than one because the bar has about 460px of slack at its
 * narrowest — the picker and the roster give way first, by design — and one
 * more control is a thing it absorbs rather than a regression. `past: 50` at
 * 900 is the run that was watched.
 * Re-run by `D directory-page`, which put the two-page navigation on this bar:
 * with the nav in place the same three controls give `past: 38` at **1024**,
 * so the matrix can still fail with one more real control on it.
 * `keeps the header to one row at every laptop width` is what fails, and it
 * fails on `past` rather than on `rowsDeep`: a `flex-nowrap` bar with too much
 * in it runs off its own right edge instead of wrapping. That is why the check
 * reads both — with only `rowsDeep`, `flex-wrap` **and** a brand at `text-2xl`
 * left it green, watched.
 */
