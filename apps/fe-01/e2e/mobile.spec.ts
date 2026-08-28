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
 * Gives the plan a day zero, which is the one thing standing between a phone
 * and its earliest-start field.
 *
 * `CardNotBeforeField` is **disabled without a project start date** — the
 * table cell's own refusal, word for word, because be-01 ignores the
 * constraint when there is no day to count from. `seedPlan` builds a dateless
 * plan (nothing else in this file needs a calendar), so the case below has to
 * set one, and on a phone the only route to that control is the `Plan actions`
 * sheet: `toolbarControls` is one array rendered either into the toolbar row
 * or into the sheet, and at 390×844 it is the sheet.
 *
 * **`fill` then `blur`, not `fill` then a tap on Save** — `DateField`'s one
 * rule is *the box is left, then it is sent*, which is why `keyboard.spec.ts`
 * and `layout.spec.ts` both blur this same box rather than pressing anything.
 *
 * Escape closes the sheet afterwards, and a tap outside would not do: the
 * sheet closes itself on any `<button>` taken inside it
 * (`closingControlIn`), and a date input is not one — so without this the
 * sheet is still over the cards the case is about to touch.
 */
async function giveThePlanADayZero(page: Page, day: string): Promise<void> {
  await openTheSheet(page);
  const starts = page.getByLabel('Project start date');
  await starts.fill(day);
  await starts.blur();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeHidden();
}

/**
 * Signs up a throwaway account and builds the smallest plan with two cards in
 * it, through the UI and therefore through the sheet.
 *
 * Two rows because the peer test needs a row to be edited that is not the one
 * being typed in — the whole question is whether somebody else's change to
 * another card disturbs this one.
 */
async function seedPlan(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

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

  // The card fields follow the table's documented bootstrap rule: the first
  // vocabulary entry is made on the Directory, then every row can search or
  // add from its card sheet. Seed that prerequisite through the same API the
  // Directory uses, so the 44px case below measures real, non-vacuous fields.
  const vocabularyStatuses = await page.evaluate(async () => {
    const make = async (path: string, name: string) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).status;
    return Promise.all([
      make('/api/tags', 'mobile e2e tag'),
      make('/api/services', 'mobile e2e service'),
    ]);
  });
  expect(vocabularyStatuses, 'the card-label vocabularies were not seeded').toEqual([200, 200]);

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
 * The request uses the page's httpOnly session cookie. A second browser
 * context signed into a second account would be the purer fixture and is a
 * change of its own — what is being measured is what arrives at *this* page
 * rather than who sent it.
 */
async function aPeerRenames(page: Page, workItemId: string, name: string): Promise<void> {
  const status = await page.evaluate(
    async ([id, newName]) => {
      const res = await fetch(`/api/work-items/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
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

const LOCAL_USERNAME = 'local-dev';
/** The account this test's page is signed into, which is what names its menu. */
let username = '';

test.beforeEach(async ({ page }) => {
  username = LOCAL_USERNAME;
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
      page.getByRole('button', { name: 'Tags for 010' }),
      page.getByRole('button', { name: 'Services for 010' }),
      // The earliest-start field, `card-field-pickers` chunk 4, in this list for
      // the reason the line above states: chunk 3 shipped the team trigger
      // without `TAP` and CI measured it at **21px**, so every control a card
      // grows gets measured here on the way in rather than after the next sweep.
      // Measured whether or not the plan has a start date — a disabled trigger
      // is still the thing a thumb lands on.
      page.getByRole('button', { name: 'Earliest start for 010' }),
      // The priority field, `card-field-pickers` chunk 6, in this list on the
      // way in for the same reason. It is the one trigger of the four that was
      // already drawn before it was a control — the chip has been in the card
      // header since `priority-bands` — so it is also the one where "it was
      // visible, therefore it was hittable" is easiest to believe and wrong: a
      // `text-xs` chip with `py-0.5` is about 20px.
      page.getByRole('button', { name: 'Priority for 010' }),
      // The dependencies field, `card-field-pickers` chunk 7 and the last of
      // the four, in this list on the way in for the reason above. Like the
      // priority it was already *drawn* before it was a control — `waits for
      // 010, 030` has been on the card since `M mobile-cards` — and unlike the
      // priority it is a bare `<span>` of body text, so what it measured before
      // `TAP` is the line-height of the meta row.
      page.getByRole('button', { name: 'Depends on for 020' }),
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

    // A chosen team must expose its clear action as soon as the phone sheet
    // opens. The sheet autofocuses the combobox, so this also guards the exact
    // focus transition that used to hide the only way to clear the row.
    //
    // Proof: with the clear action still gated on `typed === null`, Chromium
    // timed out waiting for `Clear Service or team for 010` after the sheet's
    // autofocus changed `typed` to `''`. Watched at 390×844, 2026-08-23.
    await field.click();
    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeVisible();

    // **The Clear control's box, measured rather than assumed.** TASK-106
    // measured it on dev at 26×44 — reachable by accident of the CSS
    // `min-height` floor, not a tappable square like the sheet's own Close ✕
    // at 44×44. Unmeasured, an edit like a font-change that clips the box
    // could only ever regress it further while this test still clicked it
    // happily.
    const clear = page.getByRole('button', { name: `Remove ${team} from 010` });
    const clearBox = await clear.boundingBox();
    expect(clearBox, 'the sheet Clear is a measured square target').not.toBeNull();
    expect(clearBox!.width, 'clear width ≥ 44').toBeGreaterThanOrEqual(44);
    expect(clearBox!.height, 'clear height ≥ 44').toBeGreaterThanOrEqual(44);
    expect(clearBox!.x + clearBox!.width, 'clear stays inside the viewport').toBeLessThanOrEqual(
      390,
    );
    await clear.click();

    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeVisible();
    await expect(field.locator('[data-card-team]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Close Service or team for 010' }).click();
    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeHidden();

    await page.reload();
    await expect(field.locator('[data-card-team]')).toHaveCount(0);
  });

  /**
   * The team picker's option rows, measured the way
   * `wbs-team-picker-option-rows-20px` measured them on dev: an `li[role=option]`
   * is 44px or it is a 20px stripe a finger cannot aim at, with no gap to the
   * next row — so a miss lands on the neighbouring team, a silent wrong write.
   *
   * The card's *trigger* for this sheet is covered by
   * `gives every control a finger has to hit at least 44px`, and the buttons
   * and inputs the sheet itself draws by the `[data-modal-surface]` floor in
   * `styles.css` — but that floor is a list of
   * `button`/`summary`/`select`/`textarea`/`input` selectors, and a picker's
   * options are `<li role="option">`, which none of them reach. The rows
   * therefore sat at `padding: 2px 6px` — about 20px.
   *
   * Teams are seeded rather than taken for granted: the database behind this
   * run is fresh (`tmp/e2e-<ts>.db`), and an empty directory renders no list
   * for an empty search, so the measurement would pass vacuously. The seed goes
   * through the API the page talks to and then a reload, because `addTeam`
   * announces no `directory_changed` event — there is nothing to push a new
   * team into a plan that has already loaded its directory.
   */
  test('sizes the team picker option rows to a finger', async ({ page }) => {
    await page.evaluate(
      async (names) => {
        for (const name of names) {
          const res = await fetch('/api/teams', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (res.status !== 200)
            throw new Error(`seeding "${name}" failed: ${String(res.status)}`);
        }
      },
      ['Platform', 'Carpentry crew', 'Casting crew'],
    );
    await page.reload();

    await page.getByRole('button', { name: 'Service or team for 010' }).click();
    await expect(page.getByRole('dialog', { name: 'Service or team for 010' })).toBeVisible();

    // The shared sheet exposes the search box directly; tapping it opens the
    // whole directory with no key pressed.
    await page.getByRole('combobox', { name: 'Service or team for 010' }).click();
    const list = page.getByRole('listbox', { name: 'Service or team for 010' });
    await expect(list).toBeVisible();

    const shortRows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-modal-surface] [role="option"]')]
        .filter((option) => option.getClientRects().length > 0)
        .map((option) => Math.round(option.getBoundingClientRect().height))
        .filter((height) => height < 44),
    );
    expect(shortRows, 'the team picker shipped options under 44px').toEqual([]);
  });

  /**
   * The earliest start's round trip, by touch alone — `card-field-pickers`
   * chunk 4's fifth criterion, and the only one that chunk left unticked.
   *
   * `plan-cards.test.tsx` has five cases over this sheet and every one of them
   * answers a **fake** api: they prove the box is `rowId::not-before`, that the
   * day and the words leave as **one** patch, and that a draft backed out of
   * does not come back on the next open. None of them can prove anything left
   * the browser — and the rule the whole design is shaped around lives in
   * be-01, not in the client: a reason with no date to be about is
   * `not_before_reason_needs_a_date`, **400**, checked inside the transaction
   * that would write it.
   *
   * **So the words are set in the same gesture on purpose, and that is what
   * this case is really for.** `run` is fire-and-forget, so a card that sent
   * the date and the reason as two patches would have them arrive unordered
   * and 400 roughly half the time — on exactly the rows a planner had bothered
   * to explain. Reading the reason back out of the `title` *after* the reload
   * turns the third parameter of `setNotBefore` from a design note into a fact
   * about a request that happened.
   *
   * The day is asserted as a substring rather than in full because
   * `shortIsoDate` omits the year only when it is the reader's own: `not
   * before 15 Jul` is what survives a run in any year, `15 Jul 2026` is what a
   * run in 2027 would read.
   */
  test('sets an earliest start from a card by touch, and still says so after a reload', async ({
    page,
  }) => {
    const reason = 'waiting on the client sign off';
    const field = page.getByRole('button', { name: 'Earliest start for 010' });

    // Disabled first, and this is not a formality. It is the state every other
    // case in this file finds the field in, it is why chunk 4 could not write
    // this case at all, and without it a day zero that silently failed to
    // commit would leave this case tapping a dead button and timing out with
    // nothing to say about which half broke.
    await expect(field).toBeDisabled();
    await giveThePlanADayZero(page, '2026-06-01');
    await expect(field).toBeEnabled();

    // Nothing is claimed yet, which is what stops the assertion at the end
    // passing vacuously: `data-card-not-before` is the claim, and a row that
    // constrains nothing does not draw it at all.
    await expect(field.locator('[data-card-not-before]')).toHaveCount(0);

    await field.click();
    await expect(page.getByRole('dialog', { name: 'Earliest start for 010' })).toBeVisible();

    // No key is pressed to *end* the edit, the team case's rule one field over:
    // the subject is a face with no keyboard, and `Save` is the gesture this
    // sheet chose instead of the table's `focusout` over both boxes — which
    // needs a `relatedTarget` a thumb does not produce.
    await page.locator('[data-card-not-before-input]').fill('2026-07-15');
    await page.locator('[data-card-not-before-reason]').fill(reason);
    await page.locator('[data-card-not-before-save]').click();

    await expect(page.getByRole('dialog', { name: 'Earliest start for 010' })).toBeHidden();
    await expect(field.locator('[data-card-not-before]')).toContainText('not before 15 Jul');

    // The plan, not the card: the line above proves only that React heard the
    // Save. This is the one that asks be-01, and it asks about both halves of
    // the patch at once — a pair that arrived split would have been refused.
    await page.reload();
    const saved = page
      .getByRole('button', { name: 'Earliest start for 010' })
      .locator('[data-card-not-before]');
    await expect(saved).toContainText('not before 15 Jul');
    await expect(saved).toHaveAttribute('title', new RegExp(`Why: ${reason}`));
  });

  /**
   * The third field's round trip: a priority set on a phone, by both of the two
   * languages the sheet speaks, surviving a reload.
   *
   * `card-field-pickers`' fifth done-criterion for `priority`, and the one no
   * jsdom case can make — those answer a fake api, and "it committed" is a
   * claim about be-01.
   *
   * **Both gestures in one case, and deliberately so.** Dany asked for two
   * (2026-08-13: _"select priority by labels or input a number manually"_), and
   * they are not two skins on one path — a tapped band sends the band's *name*
   * and a typed number sends digits, and it is `priorityTyped`, behind
   * `setPriority`, that turns the first into the second. Splitting them into two
   * cases would leave the interesting half untested: that the tapped line and
   * the typed number agree about what lands on the row. So the case taps `High`,
   * checks the row reads `High 30`, then types `42` over it and checks the row
   * reads `Medium 42` — a number nothing in the ladder would ever have written,
   * resolved to a band by the same one function the table's cell reads.
   *
   * The reload is between them rather than only at the end, because a chip
   * re-rendered from React state and a chip re-rendered from the server look
   * identical and are not the same claim.
   *
   * Non-vacuous at the start: `data-card-priority` is the *ranking*, and a row
   * nobody has prioritised does not draw it — so `toHaveCount(0)` before the
   * first tap is what stops a selector typo passing as a pass.
   */
  test('sets a priority from a card by touch, both ways, and still says so after a reload', async ({
    page,
  }) => {
    const field = page.getByRole('button', { name: 'Priority for 010' });

    // Unlike the earliest start, this field needs nothing arranged first: a
    // priority is a number on a row, not a constraint against a calendar, so
    // there is no day zero to give the plan and no disabled state to clear.
    await expect(field).toBeEnabled();
    await expect(field.locator('[data-card-priority]')).toHaveCount(0);

    await field.click();
    await expect(page.getByRole('dialog', { name: 'Priority for 010' })).toBeVisible();
    // A band is one tap and no Save — the team sheet's rule, because choosing
    // *is* the whole gesture. `data-card-priority-band` is keyed on the rung
    // and never on the label: a project may rename `High`, and the rung is what
    // "more important" means.
    await page.locator('[data-card-priority-band="1"]').click();
    await expect(page.getByRole('dialog', { name: 'Priority for 010' })).toBeHidden();

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Priority for 010' }).locator('[data-card-priority]'),
    ).toHaveText('High 30');

    // The other language, over the top of the first. The box takes digits and
    // needs a Save, because there is no keystroke on this face that means "and
    // I am done" — the date field's rule, for the date field's reason.
    await page.getByRole('button', { name: 'Priority for 010' }).click();
    await page.locator('[data-card-priority-input]').fill('42');
    await page.locator('[data-card-priority-save]').click();
    await expect(page.getByRole('dialog', { name: 'Priority for 010' })).toBeHidden();

    await page.reload();
    // `Medium 42`: the number is what was typed and the word is what the ladder
    // makes of it — 42 falls in Medium's range (41–60) and no band would have
    // written it, so this line is the shared resolution being read back rather
    // than the input being echoed.
    await expect(
      page.getByRole('button', { name: 'Priority for 010' }).locator('[data-card-priority]'),
    ).toHaveText('Medium 42');
  });

  /**
   * The sheet must not cover the card it is editing.
   *
   * `wbs-card-priority-qa`'s defect, measured on dev at 28 rows (2026-08-23):
   * the last card's `priority…` trigger sat at y=469–513 and the sheet it
   * opened at y=291–844 — the whole control underneath its own sheet. The
   * scroll room this case adds (`useTriggerAboveSheet` in `plan-cards.tsx`)
   * is padding at the bottom of the `[data-plan-cards]` scroller, taken off
   * again on close.
   *
   * Parameterised over the five card sheets, which is `wbs-card-sheets-cover-row`:
   * priority had the guard from `wbs-card-priority-sheet-covers-row` and the
   * other four shared its geometry without it. The trio sheet opens from
   * inside each phase's `<details>` disclosure, so that case opens one before
   * tapping; the earliest-start sheet needs a day zero, set once up front.
   *
   * The rows are made through be-01 rather than through the sheet: 28 rows,
   * at ~two UI gestures each, would put the measurement behind half a minute
   * of fixture, and what is being measured is the geometry — the fixture is
   * only in the way of it. `afterId` is chained so the list reads in order
   * rather than reversed.
   */
  interface SheetSpec {
    name: string;
    triggerSelector: string;
    dialogName: RegExp;
    controlSelector: string;
    openDisclosureFirst: boolean;
  }
  const CARD_SHEETS: readonly SheetSpec[] = [
    {
      name: 'priority',
      triggerSelector: '[data-card-priority-field]',
      dialogName: /Priority for \d+/,
      controlSelector: '[data-card-priority-save]',
      openDisclosureFirst: false,
    },
    {
      name: 'team',
      triggerSelector: '[data-card-team-field]',
      dialogName: /Service or team for \d+/,
      controlSelector: '[role="combobox"]',
      openDisclosureFirst: false,
    },
    {
      name: 'tags',
      triggerSelector: '[data-card-tags-field]',
      dialogName: /Tags for \d+/,
      controlSelector: '[role="combobox"]',
      openDisclosureFirst: false,
    },
    {
      name: 'services',
      triggerSelector: '[data-card-service-field]',
      dialogName: /Services for \d+/,
      controlSelector: '[role="combobox"]',
      openDisclosureFirst: false,
    },
    {
      name: 'dependency',
      triggerSelector: '[data-card-waits-field]',
      dialogName: /Depends on for \d+/,
      controlSelector: '[data-card-depends-input]',
      openDisclosureFirst: false,
    },
    {
      name: 'earliest start',
      triggerSelector: '[data-card-not-before-field]',
      dialogName: /Earliest start for \d+/,
      controlSelector: '[data-card-not-before-save]',
      openDisclosureFirst: false,
    },
    {
      name: 'estimate trio',
      triggerSelector: '[data-card-trio-field]',
      dialogName: /estimate for \d+/,
      controlSelector: '[data-card-trio-save]',
      openDisclosureFirst: true,
    },
  ];

  test('no card sheet covers the card it edits, also at the end of a list', async ({ page }) => {
    const cards = page.locator('[data-plan-cards] > article');
    const fixtureRows = await cards.count();
    await page.evaluate(async (count: number) => {
      const projectId = window.localStorage.getItem('wbs.project');
      if (projectId === null) throw new Error('no wbs.project in localStorage');
      let afterId: string | null = null;
      for (let each = 0; each < count; each += 1) {
        const res = await fetch(`/api/projects/${projectId}/work-items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ afterId }),
        });
        if (!res.ok) throw new Error(`create refused: ${String(res.status)}`);
        afterId = ((await res.json()) as { id: string }).id;
      }
    }, 28);
    // The creates went straight to be-01, so nothing here measures a long
    // list until the SPA has actually rendered one: without the count wait
    // the case below could be reading the fixture's own rows.
    await expect(cards).toHaveCount(fixtureRows + 28);

    // The earliest-start sheet is disabled without a day zero — one up front
    // covers both cards it gets measured on, and the other sheets read it no
    // differently.
    await giveThePlanADayZero(page, '2030-01-01');

    const scroller = page.locator('[data-plan-cards]');
    const viewport = page.viewportSize();

    // One sheet on one card, opened and measured: the trigger stays above
    // the sheet it opened, the sheet stays fully on screen with its controls
    // reachable, nothing goes sideways, and the close hands the pre-open
    // scroll position back.
    const expectAboveSheet = async (spec: SheetSpec, index: number): Promise<void> => {
      const card = cards.nth(index);
      await expect(card).toBeVisible();
      if (spec.openDisclosureFirst) {
        // The trio trigger lives inside a `<details>`; a shut one hides its
        // own contents from a click, so it opens first unless it already is.
        const summary = card.locator('details[data-phase-detail] summary').first();
        const closed = await summary.evaluate(
          (el) => !(el.parentElement as HTMLDetailsElement).open,
        );
        if (closed) await summary.click();
      }
      const trigger = card.locator(spec.triggerSelector).first();
      const sheet = page.getByRole('dialog', { name: spec.dialogName });
      // The reader has to be looking at the card to tap it, so scroll it
      // into view BEFORE capturing the offset the close must hand back:
      // Playwright's click scrolls an off-screen trigger into view itself,
      // and an offset captured before that auto-scroll measures a position
      // the card was never read from (measured as a 13089px phantom drift
      // on the close assertion — the guard had restored its own capture
      // exactly).
      await trigger.evaluate((el) => {
        el.scrollIntoView({ block: 'center' });
      });
      const scrollBefore = await scroller.evaluate((el) => el.scrollTop);

      await trigger.click();
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(spec.controlSelector)).toBeVisible();
      // The guard is async by design — it measures on animation frames,
      // because Radix mounts its portal from an internal effect after the
      // click and an open animation settles after that. Poll the geometry
      // until the guard lands rather than racing it (measured from the
      // layout gate: `toBeVisible` then one `boundingBox` snapshot caught
      // the trigger 222px under the sheet on pass 1).
      interface Box {
        x: number;
        y: number;
        width: number;
        height: number;
      }
      const guardedBox = async (): Promise<{ trig: Box; sheet: Box }> => {
        const trig = await trigger.boundingBox();
        const sh = await sheet.boundingBox();
        if (trig === null || sh === null) throw new Error('no box to measure');
        return { trig, sheet: sh };
      };
      await expect
        .poll(
          async () => {
            const { trig, sheet: sh } = await guardedBox();
            return sh.y - (trig.y + trig.height);
          },
          // The guard's own retry budget is ~10s; headless CI under load
          // has made Radix's portal mount take most of it.
          { timeout: 15000, message: 'the guard has not landed' },
        )
        .toBeGreaterThan(0);

      const { trig: where, sheet: sheetBox } = await guardedBox();
      if (viewport === null) {
        throw new Error('the viewport has no size to measure against');
      }
      expect(
        where.y + where.height,
        'the edited card stayed above the sheet it opened',
      ).toBeLessThan(sheetBox.y);
      expect(sheetBox.y, 'the sheet top is on screen').toBeGreaterThanOrEqual(0);
      expect(sheetBox.y + sheetBox.height, 'the sheet bottom is on screen').toBeLessThanOrEqual(
        viewport.height,
      );
      expect(sheetBox.x, 'the sheet left edge is on screen').toBeGreaterThanOrEqual(0);
      expect(sheetBox.x + sheetBox.width, 'the sheet right edge is on screen').toBeLessThanOrEqual(
        viewport.width,
      );
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(horizontalOverflow, 'the guard added no horizontal overflow').toBeLessThanOrEqual(0);

      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      // The close puts the reader back where the list was — the pre-open
      // offset itself, within a pixel, not merely "the trigger is visible
      // somewhere".
      const scrollAfter = await scroller.evaluate((el) => el.scrollTop);
      expect(Math.abs(scrollAfter - scrollBefore), 'page position preserved').toBeLessThanOrEqual(
        1,
      );
    };

    // The end of the list is where the defect lives: the last card has no
    // trailing room of its own, and the penultimate is the off-by-one next
    // to it — the criterion names both, for every sheet.
    const total = await cards.count();
    for (const spec of CARD_SHEETS) {
      await expectAboveSheet(spec, total - 1);
      await expectAboveSheet(spec, total - 2);
    }
  });

  /**
   * The last of `card-field-pickers`' four fields, and the only one that edits a
   * **set** — so the round trip has to cover both directions: an edge taken on
   * and the same edge taken off, each surviving a reload.
   *
   * **No Save is pressed anywhere in it, and that is the claim.** Chunk 6 closed
   * predicting this sheet would need the date field's explicit Save, on the
   * grounds that a set has no equivalent of the single tap that finished the
   * team and the priority. It does not, and be-01 is the reason rather than the
   * gesture: an edge is complete on its own, judged against the graph including
   * the edges just added, so there is nothing to batch and nothing a half-sent
   * request could break. Each tap is its own write, and the reload after each is
   * what proves it was a write and not React state.
   *
   * **The sheet stays open between the two taps**, which is the table's
   * `pickDependency` bargain and the second thing this case measures: 030 waits
   * for two rows after one visit, not two.
   *
   * Non-vacuous at both ends: `data-card-waits` is the *claim* and a row waiting
   * for nothing does not draw it, so `toHaveCount(0)` before the first tap stops
   * a selector typo passing, and the same assertion after the Remove stops the
   * removal passing on a card that never redrew.
   */
  test('makes and unmakes a dependency from a card by touch, and still says so after a reload', async ({
    page,
  }) => {
    // 020, not 010: the fixture's second row is the one with a predecessor to
    // choose. A row cannot wait for itself, and `pickerEntries` does not offer
    // it — so on a two-row plan 010's only candidate is 020.
    const field = page.getByRole('button', { name: 'Depends on for 020' });
    await expect(field).toBeEnabled();
    await expect(field.locator('[data-card-waits]')).toHaveCount(0);

    await field.click();
    await expect(page.getByRole('dialog', { name: 'Depends on for 020' })).toBeVisible();
    // The offered row, by its number. One tap and no Save, and the sheet is
    // still open afterwards — the line it just wrote appears above the box.
    await page.locator('[data-card-depends-option="010"]').click();
    await expect(page.locator('[data-card-wait="010"]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Depends on for 020' })).toBeVisible();
    // Escape and not a tap outside: `closingControlIn` closes the sheet on any
    // `<button>` taken inside it, and this sheet's controls are all buttons — a
    // stray tap would land on the card list the case is about to read.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Depends on for 020' })).toBeHidden();

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Depends on for 020' }).locator('[data-card-waits]'),
    ).toHaveText('waits for 010');

    // The other direction, through the control the table spells as a 12px `✕`
    // inside a pill. Its name says which edge goes, because a row waiting for
    // four things would otherwise offer four buttons all called Remove.
    await page.getByRole('button', { name: 'Depends on for 020' }).click();
    await page.getByRole('button', { name: 'Stop 020 waiting for 010' }).click();
    await expect(page.locator('[data-card-wait="010"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Depends on for 020' }).locator('[data-card-waits]'),
    ).toHaveCount(0);
  });

  /**
   * The dependency sheet's scroll, on a plan longer than the phone —
   * `wbs-dependency-sheet-search-scrolls-away`.
   *
   * Found by `wbs-card-depends-qa` on dev at `5d53948`, Browser Use Cloud at
   * this exact viewport: a forty-row plan offered thirty-nine candidates, the
   * whole sheet was one scroll container (`scrollHeight` 2108 against a
   * `clientHeight` of 716), and by the bottom of the list the search box sat at
   * top=-1136px. Narrowing a second search meant scrolling the whole way back.
   *
   * The fix makes the surface a fixed column — header, the waits already
   * taken, the box — and gives the long scroll to the candidate list alone.
   * This case is the measurement, and every assertion in it is a line the old
   * layout failed:
   *
   * - `scrollHeight > clientHeight` on the candidate `<ul>`: before the fix the
   *   list simply grew and the two were equal, the surface doing the scrolling.
   * - The last candidate in view after the list is walked to its end: before,
   *   it lived below the surface's fold.
   * - The search box still in view at that depth: the fault itself.
   * - All four waits in view with no scrolling at all: the fixed region holds
   *   them.
   *
   * The fixture is seeded through the API — thirty-eight rows plus four edges
   * is forty-two round trips no thumb should make — and reloaded before a
   * measurement is taken, for `aPeerRenames`'s reason: what is measured is
   * what be-01 holds, not what React remembers.
   */
  test('keeps the dependency search and the waits in view at the bottom of a long sheet', async ({
    page,
  }) => {
    const seeded = await page.evaluate(async () => {
      const { projects } = (await (await fetch('/api/projects')).json()) as {
        projects: { id: string }[];
      };
      // One project exactly: this run's database is fresh (`tmp/e2e-<ts>.db`)
      // and `seedPlan` made it. Destructured rather than guarded, the lint's
      // `no-unnecessary-condition` reading an empty-list check as dead.
      const [{ id: projectId }] = projects;
      const tree = (await (await fetch(`/api/projects/${projectId}/work-items`)).json()) as {
        workItems: { id: string; number: string }[];
      };
      let after = tree.workItems[tree.workItems.length - 1]?.id ?? null;
      const made: { id: string; number: string }[] = [];
      for (let i = 0; i < 38; i += 1) {
        const res = await fetch(`/api/projects/${projectId}/work-items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parentId: null,
            afterId: after,
            name: `Fixture row ${String(i)}`,
          }),
        });
        if (res.status !== 200)
          throw new Error(`seeding row ${String(i)} failed: ${String(res.status)}`);
        const { id } = (await res.json()) as { id: string };
        after = id;
        made.push({ id, number: '' });
      }
      // Four waits on 020, the shape the fault was found in: a header, four
      // rows already taken, then the long list.
      const successor = tree.workItems.find((each) => each.number === '020');
      if (successor === undefined) throw new Error('no 020 in the seeded plan');
      for (const predecessor of made.slice(0, 4)) {
        const res = await fetch(`/api/work-items/${successor.id}/dependencies`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ predecessorId: predecessor.id }),
        });
        if (res.status !== 200) throw new Error(`seeding a wait failed: ${String(res.status)}`);
      }
      return { rows: tree.workItems.length + made.length };
    });
    expect(seeded.rows, 'the plan did not take the forty rows').toBe(40);
    await page.reload();

    await page.getByRole('button', { name: 'Depends on for 020' }).click();
    // The dialog element IS the sheet surface (`data-modal-surface` on
    // `ModalContent`), and every measurement below is scoped to it — a global
    // attribute locator could just as well match a plan card behind the sheet.
    const dialog = page.getByRole('dialog', { name: 'Depends on for 020' });
    await expect(dialog).toBeVisible();

    const candidates = page.getByRole('list', { name: 'Rows 020 could wait for' });
    await expect(candidates).toBeVisible();
    const scrollable = await candidates.evaluate((list) => ({
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    }));
    expect(
      scrollable.scrollHeight > scrollable.clientHeight,
      'the candidate list is not the scroll region — it grew instead of scrolling',
    ).toBe(true);

    // The other half of the fix: the surface itself no longer scrolls. Before,
    // it was the scroll container (scrollHeight 2108 against clientHeight 716).
    const surface = await dialog.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(surface.overflowY, 'the sheet surface is a scroll container again').toBe('hidden');
    expect(
      surface.scrollHeight <= surface.clientHeight,
      `the sheet surface still outgrows itself (${String(surface.scrollHeight)} > ${String(surface.clientHeight)})`,
    ).toBe(true);

    // To the bottom of the list, the depth the fault was measured at.
    await candidates.evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
    await expect(dialog.locator('[data-card-depends-option]').last()).toBeInViewport();
    // The box the whole fix is for: still on screen at the bottom of the list.
    await expect(dialog.locator('[data-card-depends-input]')).toBeInViewport();
    // And the four waits, which the fixed region holds with no scrolling.
    await expect(dialog.locator('[data-card-wait]')).toHaveCount(4);
    for (const wait of await dialog.locator('[data-card-wait]').all()) {
      await expect(wait).toBeInViewport();
    }
  });

  /**
   * The whole trio, entered the way a thumb enters it — `wbs-mobile-orp-input`.
   *
   * Dany, 2026-08-23: *"I cannot input o/r/p on WBS from mobile."* The card's
   * figure box takes `2/3/8`, and the keypad it asks for has no `/` on it. The
   * mobile sweep's `2/3/8 → 3.7d` pass is not a counter-example: it typed
   * through CDP, which bypasses the on-screen keyboard entirely — and so does
   * `fill()` here, which is exactly why **this case never types a separator at
   * all**. Three boxes, three separate fills, nothing between them. A fix that
   * kept one box and taught it a new separator would still pass a CDP test and
   * still be untypeable on a phone; this one cannot pass unless the three boxes
   * exist.
   *
   * `3.7` is the round trip's proof rather than `2 · 3 · 8`: the final figure is
   * PERT over the three points — (2 + 4×3 + 8) / 6 — computed by be-01 and read
   * back after a reload, so a card that only redrew what React was holding
   * fails here.
   */
  test('types a whole estimate on a card without a slash, and it survives a reload', async ({
    page,
  }) => {
    // **The ids are read off the page, not written into this file.** Two drafts
    // died here first: `data-phase-detail="role-dev"` is `plan-cards.test.tsx`'s
    // fixture id and a real deployment's roles are rows in be-01 with generated
    // ones; and filtering the `<details>` by `has:` a `getByRole` inside it
    // cannot work either, because a shut `<details>` hides its contents from the
    // accessibility tree and a role query looks nowhere else. `data-cell` is the
    // one string that carries both ids — `rowId::roleId-final`, the same cell
    // the table's own box for this estimate carries.
    const cell = await page.getByLabel('Dev estimate for 010').getAttribute('data-cell');
    expect(cell, 'no cell id on the estimate box').toMatch(/^.+::.+-final$/);
    const [rowId, roleFinal] = (cell ?? '').split('::');
    const roleId = roleFinal.replace(/-final$/, '');

    // Scoped to 010's card, because the plan has two of them and both carry a
    // Dev phase.
    const detail = page.locator(`[data-card="${rowId}"] details[data-phase-detail="${roleId}"]`);
    const field = page.getByRole('button', { name: 'Dev o, r and p for 010' });

    // The trio lives behind the `o·r·p` disclosure the card already had — the
    // read view is where the edit belongs, and a `<details>` that is shut hides
    // its own contents from a click.
    await detail.locator('summary').click();

    // Non-vacuous: nothing is estimated yet, and the words say so. A selector
    // typo or a card that never drew the trigger fails here rather than at the
    // end.
    await expect(field.locator('[data-phase-trio]')).toHaveText('No estimate yet');
    // Chunk 3's 21px lesson, applied rather than re-learned: the 44px floor in
    // `styles.css` is scoped to `[data-modal-surface]` and `[data-account-menu]`,
    // and a card is neither — so a trigger a card grows has to carry its own
    // height. Measured here and not in the sweep above, because that list walks
    // controls a `<details>` keeps hidden until it is opened.
    const trigger = await field.boundingBox();
    expect(
      trigger?.height ?? 0,
      'the trio trigger is under a finger’s size',
    ).toBeGreaterThanOrEqual(44);

    await field.click();
    await expect(page.getByRole('dialog', { name: 'Dev estimate for 010' })).toBeVisible();

    await page.getByLabel('Dev optimistic for 010').fill('2');
    await page.getByLabel('Dev realistic for 010').fill('3');
    await page.getByLabel('Dev pessimistic for 010').fill('8');
    await page.locator('[data-card-trio-save]').click();
    await expect(page.getByRole('dialog', { name: 'Dev estimate for 010' })).toBeHidden();

    await page.reload();
    await detail.locator('summary').click();
    await expect(detail.locator('[data-phase-trio]')).toHaveText(
      'optimistic 2 · realistic 3 · pessimistic 8',
    );
    await expect(detail.locator('[data-phase-final]')).toHaveText('Final 3.7 days');
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
