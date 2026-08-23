import { expect, type Page, test } from '@playwright/test';

/**
 * The plan on a phone, measured by a browser.
 *
 * `plan-cards.test.tsx` proves what the cards render and which cells they are.
 * This file exists for the four things jsdom cannot answer, and every one of
 * them is the reason `M mobile-cards` was asked for:
 *
 * 1. **Nothing scrolls sideways.** jsdom lays nothing out, so a card whose
 *    figure box is 8px wider than the screen looks identical to one that fits.
 * 2. **A finger can hit the controls.** 44px is a measured rectangle or it is
 *    nothing.
 * 3. **A real focus trap.** Radix moves the focus with `focusin` listeners and
 *    sentinels, none of which jsdom performs — so the claim that the toolbar
 *    sheet gets out of the way of the caret can only be made here. It is the
 *    half `lands the focus in the card of a work item it just created` names
 *    and cannot see.
 * 4. **A round trip.** Typed on a card, written by be-01, read back after a
 *    reload — and a peer's edit arriving mid-word over a real socket rather
 *    than a dispatched event.
 */

/** An iPhone 14's CSS viewport, which is what the plan calls the phone case. */
test.use({ viewport: { width: 390, height: 844 } });

/** The name every card test types, long enough to wrap on a 390px screen. */
const A_LONG_NAME = 'Survey the existing warehouse racking and photograph every aisle end';

/**
 * `plan-renderer.ts`'s rule, restated because a Playwright process cannot
 * import a module that calls `useSyncExternalStore`.
 *
 * Restated and not approximated: the two numbers are the two exported there,
 * and the case below that turns the phone sideways is what keeps this copy
 * honest — get either number wrong here and the fixture builds no rows, which
 * fails loudly rather than quietly measuring the wrong renderer.
 */
const CARDS_BELOW = 768;
const TABLE_NEEDS_HEIGHT = 500;

function drawsCards(page: Page): boolean {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  return viewport.width < CARDS_BELOW || viewport.height < TABLE_NEEDS_HEIGHT;
}

/** Opens the toolbar sheet, which is the only way to any toolbar control here. */
async function openTheSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Plan actions' }).click();
  await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeVisible();
}

/**
 * Signs up a throwaway account and builds the smallest plan with two cards in
 * it, through the UI and therefore through the sheet.
 *
 * Two rows because the peer test needs a row to be edited that is not the one
 * being typed in — the whole question is whether somebody else's change to
 * another card disturbs this one.
 */
async function seedPlan(page: Page, account: string): Promise<void> {
  await page.goto('/');

  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByLabel('Username').fill(account);
  await page.getByLabel('Password').fill('mobile-gate-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('button', { name: 'New project' }).click();

  // The desktop case at the bottom of this file shares this fixture and asks
  // one thing of it: a dialog, whose density is a fact about the dialog and not
  // about what is in the plan behind it. It gets no rows because the control
  // that adds one here is on a sheet that does not exist at that size —
  // `rendererForViewport` draws the table from 768 wide up, and only where the
  // viewport is at least `TABLE_NEEDS_HEIGHT` tall.
  if (!drawsCards(page)) {
    await expect(page.getByRole('button', { name: 'Teams' })).toBeVisible();
    return;
  }

  await expect(page.getByRole('button', { name: 'Plan actions' })).toBeVisible();

  for (const number of ['010', '020']) {
    await openTheSheet(page);
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
}

/**
 * One edit by somebody else, made the way somebody else makes it: a request to
 * be-01 from outside this page's own UI, which gw-01 then tells the page about.
 *
 * The session token is read out of the same `localStorage` the app keeps it in.
 * A second browser context signed into a second account would be the purer
 * fixture and is a change of its own — every project in this deployment is
 * readable by every account, but nothing in this spec's stack seeds a second
 * one, and what is being measured is what arrives at *this* page rather than
 * who sent it.
 */
async function aPeerRenames(page: Page, workItemId: string, name: string): Promise<void> {
  const status = await page.evaluate(
    async ([id, newName]) => {
      const raw = localStorage.getItem('wbs.session');
      if (raw === null) throw new Error('no session to borrow a token from');
      const session = JSON.parse(raw) as { token: string };
      const res = await fetch(`/api/work-items/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-wbs-token': session.token },
        body: JSON.stringify({ name: newName }),
      });
      return res.status;
    },
    [workItemId, name] as const,
  );
  expect(status, 'the peer edit was refused by be-01').toBe(200);
}

/**
 * Everything a finger is ever aimed at, as one selector.
 *
 * Roles as well as tags, because two of the three surfaces measured here answer
 * a tap through a bare `<button>` carrying `role="menuitem"` rather than through
 * anything the tag list would find on its own merits.
 */
const A_CONTROL = [
  'button',
  'summary',
  'select',
  'textarea',
  'input',
  'a[href]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
].join(', ');

/** What a control on `surface` is called, and how tall the box a finger hits is. */
interface TapTarget {
  name: string;
  height: number;
}

/**
 * Every control inside `surface` whose tap target is shorter than 44px.
 *
 * **The tap target is the `<label>` wherever one wraps the control**, and that
 * is a measurement decision worth stating: a click anywhere inside a label
 * activates the control inside it, so the rectangle a finger can hit for a tick
 * box is the whole row and not the 13px glyph. Measuring the `<input>` would
 * report a target the reader does not have — in either direction. `the row of a
 * tick box is the tick box` below proves the equivalence with a click rather
 * than leaving it as a claim about HTML.
 */
async function shortTargetsIn(page: Page, surface: string): Promise<TapTarget[]> {
  return page.evaluate(
    ([surfaceSelector, controlSelector]) => {
      const root = document.querySelector(surfaceSelector);
      if (root === null) throw new Error(`nothing matching ${surfaceSelector} is on screen`);
      return [...root.querySelectorAll(controlSelector)]
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => {
          const target = control.closest('label') ?? control;
          // `textContent` without a `?.`: it is `string` on an `Element` this
          // lib types, and the optional chain lint refuses is not a spelling
          // choice — `no-unnecessary-condition` reads the type and errors.
          const words = control.textContent.trim();
          return {
            name:
              control.getAttribute('aria-label') ??
              (words === '' ? control.tagName : words.slice(0, 32)),
            height: Math.round(target.getBoundingClientRect().height),
          };
        })
        .filter((target) => target.height < 44);
    },
    [surface, A_CONTROL] as const,
  );
}

let account = 0;
/** The account this test's page is signed into, which is what names its menu. */
let username = '';

test.beforeEach(async ({ page }) => {
  account += 1;
  username = `e2e-mb-${String(Date.now())}-${String(account)}`;
  await seedPlan(page, username);
});

test.describe('the plan on a phone, measured by a browser', () => {
  test('is cards, and nothing on the page scrolls sideways', async ({ page }) => {
    await expect(page.locator('[data-plan-cards]')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);

    await page.getByLabel('Name of 010').fill(A_LONG_NAME);
    await page.getByLabel('Name of 010').blur();

    // The document first: the whole failure this renderer exists to remove is a
    // page you drag sideways to read one column of.
    const page_ = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(page_.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(page_.clientWidth);

    // Then each card, because a card that overflows its own box is the same
    // failure one level in — and the page can hide it behind `overflow`.
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('[data-card]')].map((card) => ({
        number: card.querySelector('[data-number]')?.textContent ?? '?',
        scrollWidth: card.scrollWidth,
        clientWidth: card.clientWidth,
      })),
    );
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.scrollWidth, `card ${card.number} overflows itself`).toBeLessThanOrEqual(
        card.clientWidth,
      );
    }
  });

  test('keeps the card’s number at the card’s own size, not the table’s', async ({ page }) => {
    // `table-mechanics` took the table's work-item number down to 11px to buy
    // back a 93px column at depth 4, and wrote that rule as `[data-grid]
    // [data-number]`. This renderer carries `data-grid` too — `plan-cards.tsx`
    // sets it so `editable-grid.ts` can find the grid at all — and its header
    // renders the same span, so the rule reached a surface that change's Known
    // limits say it is not touching. Nothing here is `table-layout: fixed`,
    // nothing beside the span holds a 16px line box, and `cardIndentFor` kept
    // the old outline: the card would have carried a shrunken number for no
    // reason at all.
    //
    // Asserted against the header the span sits in rather than against a
    // literal, so it is a claim about the number not being singled out —
    // restyle the cards and this keeps meaning what it says. The floor below
    // it is what stops it passing vacuously if the cards themselves ever go
    // to 11px.
    //
    // Proof, watched in CI's `pixels` job at `b441c414`, 2026-08-12, with the
    // rule still written `[data-grid] [data-number]`: `the table's 11px
    // reached the phone's card … Expected: "16px" Received: "11px"`.
    const sizes = await page.evaluate(() => {
      const span = document.querySelector('[data-card] [data-number]');
      if (!(span instanceof HTMLElement)) throw new Error('no numbered span on any card');
      const header = span.parentElement;
      if (!(header instanceof HTMLElement)) throw new Error('the number sits in no header');
      return {
        number: getComputedStyle(span).fontSize,
        header: getComputedStyle(header).fontSize,
      };
    });

    expect(sizes.number, 'the table’s 11px reached the phone’s card').toBe(sizes.header);
    expect(
      Number.parseFloat(sizes.number),
      'the cards themselves shrank, so the equality above proves nothing',
    ).toBeGreaterThan(11);
  });

  test('gives every control a finger has to hit at least 44px', async ({ page }) => {
    const controls = [
      page.getByRole('button', { name: 'Plan actions' }),
      page.getByLabel('Name of 010'),
      page.getByLabel('Dev estimate for 010'),
      // The team field, added with the sheet that made it a control
      // (`card-field-pickers` chunk 1). It belongs in this list and not in the
      // sweep below for a reason worth stating: the 44px floor in `styles.css`
      // is scoped to `[data-modal-surface]` and `[data-account-menu]`, and a
      // card is neither — so every control a card grows has to carry its own
      // height, and this list is the only thing that checks that it did.
      page.getByRole('button', { name: 'Service or team for 010' }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box, 'the control is not on screen at all').not.toBeNull();
      expect(
        box?.height ?? 0,
        `${(await control.getAttribute('aria-label')) ?? 'control'} is short`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  /**
   * The other three surfaces, which the test above never reached.
   *
   * `gives every control a finger has to hit at least 44px` names three controls
   * and all three are on a **card**, so the sizing `plan-cards.tsx` writes is the
   * only sizing it has ever proved. The sweep of 2026-08-22 measured what that
   * left out at 390×844: 36 of 36 controls on the `Plan actions` sheet under
   * 44px, the filter tick boxes at 13, 9 of 9 in the Teams dialog, 4 of 4 in the
   * account menu. Every one of those is a control a phone has no other route to
   * — the sheet *is* the toolbar here.
   *
   * Soft per surface, which is the one place this file wants it: three surfaces
   * fail for three different reasons, and a hard failure on the sheet would hide
   * whatever the account menu is doing until the next run.
   *
   * Watched red at `22b9a73` — the sheet reported 30 short controls (13px tick
   * rows, 25px `Close`, 32px buttons), the Teams dialog 2, the account menu 4.
   */
  test('gives every control on the phone’s own surfaces at least 44px', async ({ page }) => {
    // The account menu **first**, and the order is not arbitrary: it is chrome
    // rather than plan, and every modal on this page lays a `fixed inset-0`
    // overlay over the chrome. Measured after the sheet, this click spent its
    // full 60s on `<div class="fixed inset-0 z-50 bg-black/40"> intercepts
    // pointer events` — and an Escape between the two did not put the sheet away
    // either, watched at `f9781b0`. A surface reached before anything covers it
    // needs no dismissal to be right.
    await page.getByTitle('This account').click();
    await expect(page.getByRole('menu', { name: `Signed in as ${username}` })).toBeVisible();
    expect
      .soft(await shortTargetsIn(page, '[data-account-menu]'), 'in the account menu')
      .toEqual([]);

    // A 44px control that pushed the page sideways would be a worse phone than
    // a 32px one, and the menu is the surface that can: it is `absolute` in the
    // header rather than in a portal, and three palette buttons that will not
    // fit take the document with them. The first test in this file makes the
    // same assertion with nothing open.
    const root = await page.evaluate(() => {
      const element = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(
      root.scrollWidth,
      'the grown controls made the page scroll sideways',
    ).toBeLessThanOrEqual(root.clientWidth);
    await page.getByTitle('This account').click();

    // The sheet, with `Filters` expanded — the state the sweep measured, and the
    // one holding the 13px controls. A `<summary>` is not the `<button>` that
    // closes the sheet, so this leaves it open (`closingControlIn`).
    await openTheSheet(page);
    await page.locator('[data-modal-surface] [data-facets] summary').click();
    await expect(page.locator('[data-facet-panel]')).toBeVisible();
    expect
      .soft(await shortTargetsIn(page, '[data-modal-surface]'), 'on the Plan actions sheet')
      .toEqual([]);

    // The Teams dialog, opened from that sheet because there is no other way in
    // at this width. This plan carries no team labels — nothing on a card edits
    // one — so what is on screen is the empty sentence, `Done` and the ✕ rather
    // than the seven capacity boxes the sweep measured. The floor those boxes
    // sit under is the same `input` rule, and it *is* measured above: the sheet
    // carries the Find box.
    await page.getByRole('button', { name: 'Teams' }).click();
    await expect(page.getByRole('dialog', { name: 'Teams on this plan' })).toBeVisible();
    expect
      .soft(await shortTargetsIn(page, '[data-modal-surface="centre"]'), 'in the Teams dialog')
      .toEqual([]);
  });

  /**
   * The claim the measurement above rests on: a tick box's target is its row.
   *
   * Without this, `shortTargetsIn` measuring the `<label>` would be a way of
   * passing rather than a way of measuring — 44px of label around a 13px box
   * that only answers a tap on the glyph is the same broken control with a
   * better number. So: a tap at the far end of the row, 40px down it, and the
   * box changes.
   */
  test('makes the row of a tick box the tick box, for the whole 44px', async ({ page }) => {
    await openTheSheet(page);
    await page.locator('[data-modal-surface] [data-facets] summary').click();

    const box = page.getByLabel('Unestimated only');
    const row = page.locator('[data-facet-group="state"] label').first();
    await expect(box).not.toBeChecked();

    const rect = await row.boundingBox();
    expect(rect, 'the tick box has no row on screen').not.toBeNull();
    await row.click({ position: { x: (rect?.width ?? 0) - 6, y: 40 } });

    await expect(box).toBeChecked();
  });

  test('sends a name typed on a card, and reads it back after a reload', async ({ page }) => {
    const name = page.getByLabel('Name of 010');
    await name.fill(A_LONG_NAME);
    await name.blur();
    // The plan, not the box: a value still on screen proves only that nothing
    // wiped it. The reload is what asks be-01.
    await page.reload();

    await expect(page.getByLabel('Name of 010')).toHaveValue(A_LONG_NAME);
  });

  /**
   * The team field's round trip, by touch alone — the criterion `card-field-pickers`
   * lists for every one of its four fields and the one jsdom structurally cannot
   * make.
   *
   * `plan-cards.test.tsx` has three cases over this sheet and all three answer a
   * **fake** api: they prove the box is `rowId::team`, that Enter binds the name
   * typed rather than the one it sits inside, and that a row with no team can
   * still make one. What none of them can prove is that anything left the
   * browser. "Commits and survives a reload" is a claim about be-01, so it is
   * made here or nowhere — chunk 2 of that task retracted it for exactly this
   * reason.
   *
   * **No key is pressed.** `Add “…”` is *tapped*, not taken with Enter, because
   * the whole subject is a face with no keyboard: the tap has to survive
   * `PickerList`'s `mousedown` `preventDefault` (without which the blur closes
   * the list before the click can land) and the sheet's focus scope. Enter would
   * pass through a broken list.
   *
   * The name carries `username` because `service_team` has **no owner column**
   * and that is deliberate (Dany, 2026-08-06) — the directory is shared across
   * every plan in the deployment, so a fixed name would be found by the second
   * run of this file and ranked ahead of the `Add` line it is here to tap.
   */
  test('makes a team from a card by tapping alone, and still says so after a reload', async ({
    page,
  }) => {
    const team = `Racking crew ${username}`;
    const field = page.getByRole('button', { name: 'Service or team for 010' });

    // Nothing is claimed yet, which is what stops the assertion at the end
    // passing vacuously: `data-card-team` is the claim, and a row that inherits
    // or carries nothing does not draw it at all.
    await expect(field.locator('[data-card-team]')).toHaveCount(0);

    await field.click();
    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeVisible();

    const box = page.getByRole('combobox', { name: 'Service or team for 010' });
    await box.click();
    await box.fill(team);

    // `data-picker-take` is the first line and therefore the one the ranking
    // says is about to be taken. Asserting its text before tapping it is what
    // makes this a test of the *offer* as well as of the write: a directory
    // entry ranked above the `Add` line would fail here rather than quietly
    // labelling the row with somebody else's team.
    const add = page.locator('[data-picker-take]');
    await expect(add).toHaveText(`Add “${team}”`);
    await add.click();

    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeHidden();
    await expect(field.locator('[data-card-team]')).toHaveText(team);

    // The plan, not the card: the line above proves only that React heard the
    // choice. This is the one that asks be-01.
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Service or team for 010' }).locator('[data-card-team]'),
    ).toHaveText(team);
  });

  /**
   * The sheet gets out of the way, and the caret goes where the create asked
   * for it.
   *
   * This is the browser half of `plan-cards.test.tsx`'s focus test: there, a
   * sheet left open still let the caret through, because jsdom performs none of
   * a focus scope. Here it would not.
   */
  test('closes the sheet on a control that acts, and lands the caret in the new card', async ({
    page,
  }) => {
    await openTheSheet(page);
    await page.getByRole('button', { name: 'Add work item' }).click();

    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeHidden();
    await expect(page.getByLabel('Name of 030')).toBeFocused();
  });

  /**
   * The other half of that close, and the one that shipped broken: a control
   * that aims the caret nowhere must hand the focus back to the trigger.
   *
   * `onCloseAutoFocus` refused Radix's restore for **every** control on the
   * sheet, so `Collapse all`, `Gantt`, `Undo` and the exports each closed it and
   * left the focus on `<body>`. On a phone the sheet is the only route to any of
   * them, so that is a reader with nothing focused and nothing to Tab from,
   * every time they fold the plan.
   *
   * The browser is the honest oracle for this even though jsdom can see the
   * restore itself: what is being claimed is where a real `FocusScope` leaves
   * the focus as it unmounts, and jsdom performs none of the `focusin`
   * bookkeeping that scope is made of. `plan-cards.test.tsx` makes the same
   * assertion one layer down; this is the one that counts.
   *
   * Proof: `sheetControlTakesTheFocus.current` pinned back to the unconditional
   * `true` that shipped, this failed on `expect(locator).toBeFocused() …
   * Expected: focused / Received: inactive` for the `Plan actions` trigger, with
   * `document.activeElement` on `<body>`. Watched in Chromium at 390×844,
   * 2026-08-09.
   */
  test('gives the focus back to the trigger on a control that aims the caret nowhere', async ({
    page,
  }) => {
    const trigger = page.getByRole('button', { name: 'Plan actions' });
    await openTheSheet(page);
    await page.getByRole('button', { name: 'Collapse all' }).click();

    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  /**
   * A peer's edit arriving mid-word, over a real socket: it must take neither
   * the focus nor the half-typed value.
   *
   * Rule 2 of `live-editing.ts`, on the card renderer — the rule the whole
   * live-editing module exists for, and the one a second renderer was most
   * likely to lose. Typed and **not** left: the word is still being written.
   */
  test('keeps the focus and the half-typed word when somebody else edits another card', async ({
    page,
  }) => {
    const mine = page.getByLabel('Name of 010');
    await mine.click();
    await mine.pressSequentially('Strip the wir');

    const theirs = await page.locator('[data-card]').nth(1).getAttribute('data-card');
    expect(theirs, 'the second card has no id to rename by').not.toBeNull();
    await aPeerRenames(page, theirs ?? '', 'Their new name');

    await expect(page.getByLabel('Name of 020')).toHaveValue('Their new name');
    await expect(mine).toBeFocused();
    await expect(mine).toHaveValue('Strip the wir');
  });
});

/**
 * The same phone, turned sideways — 390×844 becomes 844×390.
 *
 * A rotation is the one resize that makes the window **wider**, so a renderer
 * that only read `innerWidth` answered it by clearing 768 and drawing the
 * 1471px table on a screen 390px tall: 689px of horizontal scroll and 243
 * controls under 44px, measured on dev at `9b62ef1` by `wbs-mobile-sweep`.
 *
 * Here rather than in `plan-renderer.test.ts` because jsdom lays nothing out.
 * The unit spec can prove the rule returns `'cards'`; only a browser can prove
 * that what is then on screen does not scroll sideways and is not sized for a
 * mouse, which are the two things the reader actually loses.
 */
test.describe('the same phone, turned sideways', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('is still cards, at a finger’s size, and still does not scroll sideways', async ({
    page,
  }) => {
    await expect(page.locator('[data-plan-cards]')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);

    const root = await page.evaluate(() => {
      const element = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(root.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(root.clientWidth);

    // The 44px floor is a media query and therefore has its own copy of the
    // rule (`styles.css`). A renderer fixed without it is a landscape phone
    // holding cards it cannot hit: the sheet is where the sweep counted the
    // 13px tick rows, so it is the surface that answers.
    await openTheSheet(page);
    await page.locator('[data-modal-surface] [data-facets] summary').click();
    await expect(page.locator('[data-facet-panel]')).toBeVisible();
    expect(
      await shortTargetsIn(page, '[data-modal-surface]'),
      'on the Plan actions sheet, sideways',
    ).toEqual([]);
  });
});

/**
 * The other end of the same rule: a desktop keeps the density it was built with.
 *
 * The 44px floor is written as a media query, which means it has a **boundary**,
 * and a boundary is a place a rule can be wrong in a way no 390px test can see.
 * Both widths here are that check rather than a second sizing test: 1400 is an
 * ordinary desktop, and 768 is `CARDS_BELOW` itself — the first width that draws
 * a table, and therefore the first that must not carry a phone's sizing. Write
 * the query as `max-width: 768px` instead of `767.98` and this file goes red at
 * the second width while every other test in it passes.
 */
test.describe('the same dialog on a desktop, where the density is the point', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('leaves a dialog and the account menu at their own size at 1400 and at 768', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Teams' }).click();
    await expect(page.getByRole('dialog', { name: 'Teams on this plan' })).toBeVisible();

    const done = page.getByRole('button', { name: 'Done' });
    const close = page.getByRole('button', { name: 'Close' });
    const account = page.getByTitle('This account');

    for (const width of [1400, 768]) {
      await page.setViewportSize({ width, height: 900 });

      // `h-9`, which is what `<Button>` is at its default size. Named as the
      // number rather than as "under 44" because criterion 2 is that the
      // desktop is *unchanged*, and a `Done` that had grown to 40 would pass
      // the looser claim while still being a phone's button on a mouse's page.
      expect(
        Math.round((await done.boundingBox())?.height ?? 0),
        `the phone’s floor reached Done at ${String(width)}px`,
      ).toBe(36);

      // The ✕, which is the control the floor changes most: 25px to 44, and
      // square. Under 44 here is the whole claim.
      expect(
        Math.round((await close.boundingBox())?.height ?? 0),
        `the phone’s floor reached the ✕ at ${String(width)}px`,
      ).toBeLessThan(44);

      // The account menu is chrome rather than a dialog, and it is reached by
      // `[data-account-menu]` — a selector with no modal surface in it, and
      // therefore the one most able to leak past the media query.
      expect(
        Math.round((await account.boundingBox())?.height ?? 0),
        `the phone’s floor reached the account trigger at ${String(width)}px`,
      ).toBe(32);
    }
  });
});
