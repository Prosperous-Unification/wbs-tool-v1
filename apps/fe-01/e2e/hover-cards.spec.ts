import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The hover cards, measured by a browser.
 *
 * Three of the four assertions here are ones jsdom cannot make. jsdom sees a
 * card's presence, its text and its `pointer-events` declaration — and
 * `wbs-table.test.tsx` asserts all three — but it lays nothing out, so it can
 * see neither a card cut off at its cell's edge nor a click landing on the row
 * underneath one. Both of those are the exact shape of R5 tally #14–16: a green
 * unit suite over a fault only a browser performs.
 *
 * The fourth is instantness, and it is here because a delay is a thing a
 * browser has and jsdom does not: every assertion about an open card in this
 * file reads the DOM once, without Playwright's retrying matchers, so a card
 * that arrived a frame late would fail rather than be waited for.
 */

/** Signs up a throwaway account and makes a plan two rows deep. */
async function seedPlan(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  await addRow.click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  await addRow.click();
  await expect(page.getByLabel('Name of 020')).toBeVisible();

  const first = page.getByLabel('Name of 010');
  await first.fill('Survey the existing warehouse racking');
  await first.blur();
  const second = page.getByLabel('Name of 020');
  await second.fill('Draft the replacement layout');
  await second.blur();

  // The trio the folded cell hides behind one figure, and the row the card is
  // read from.
  const estimate = page.getByLabel('Dev estimate for 010');
  await estimate.fill('2/3/8');
  await estimate.blur();
  // `toHaveValue` reads the box's own value, which `fill` set synchronously —
  // it says nothing about the blur-commit reaching be-01 or the plan coming
  // back. The folded figure and the card are drawn from the *fetched* plan,
  // so block on the persisted estimate: the card the folded cell opens reads
  // 'No estimate yet' until that round trip lands, and 'optimistic 2' once it
  // has. (TASK-50, hover-card-estimate-race)
  await foldedDevCell(page, '010').hover();
  await expect(page.locator('[role="tooltip"]').first()).toContainText('optimistic 2');
  await page.mouse.move(0, 0);
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
}

/**
 * The folded Dev cell of one row — the wrapper the figure, the assignee and the
 * card share.
 *
 * Found through the box inside it rather than by `[data-final="…"]`: a role's
 * id is whatever be-01 minted when the project was made, so the only stable
 * handle on this cell is the label the column writes from the role's *name*.
 */
const foldedDevCell = (page: Page, number: string): Locator =>
  page.getByLabel(`Dev estimate for ${number}`).locator('..');

/** How many cards are open, read once — never waited for. */
const cardsOpen = (page: Page): Promise<number> => page.locator('[role="tooltip"]').count();

/** The open card's text, read once. */
async function cardText(page: Page): Promise<string> {
  const open = page.locator('[role="tooltip"]');
  expect(await open.count(), 'no card is open').toBe(1);
  return (await open.first().textContent()) ?? '';
}

/** The box a locator occupies, refused rather than defaulted when it has none. */
async function boxOf(locator: Locator, what: string): Promise<DOMRect> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box on this page`);
  return box as DOMRect;
}

let account = 0;

test.beforeEach(async ({ page }) => {
  account += 1;
  await seedPlan(page, `e2e-hover-${String(Date.now())}-${String(account)}`);
});

test.describe('a hover card answers at once, whole, and out past its cell', () => {
  test('opens the folded figure in the same breath as the mouse arrives', async ({ page }) => {
    await foldedDevCell(page, '010').hover();

    // One read, no retry: `toBeVisible` would wait up to ten seconds for a card
    // that opens on a timer, and a card that opens on a timer is the thing this
    // change exists to not build.
    expect(await cardsOpen(page), 'no card in the frame the mouse arrived in').toBe(1);
    const text = await cardText(page);
    expect(text).toContain('optimistic 2');
    expect(text).toContain('realistic 3');
    expect(text).toContain('pessimistic 8');
  });

  test('paints the card past the bottom of a 96px cell', async ({ page }) => {
    // The `<td>` clips its contents (`CELL`'s `overflow: hidden`) and
    // `opensAPopover` lifts that for this column. A clipped box still reports
    // its full geometry, so measuring the card is not enough — what is asked
    // here is whether anything is *painted* below the cell, which is a
    // screenshot of that strip with the card open against the same strip with
    // it closed.
    //
    // Hit testing would be the cheaper probe and it is not available: a card
    // takes no pointer events, so `elementFromPoint` returns whatever is under
    // it whether the card is clipped or not.
    //
    // Proof: `opensAPopover`'s `-final` suffix branch removed, this failed on
    // `expected true to be false // the strip below the cell looks the same
    // with the card open` — the card cut off at the cell edge. Watched,
    // 2026-08-09.
    const folded = foldedDevCell(page, '010');
    const cell = folded.locator('xpath=ancestor::td');

    await folded.hover();
    expect(await cardsOpen(page)).toBe(1);

    const card = await boxOf(page.locator('[role="tooltip"]').first(), 'the card');
    const cellBox = await boxOf(cell, 'the folded cell');
    // The precondition, and R5 tally #16 is why it is here: a card of no size,
    // or one that never reached past its cell, would make the strip below it
    // empty and the comparison meaningless.
    expect(card.width, 'the card has no width').toBeGreaterThan(0);
    expect(card.height, 'the card has no height').toBeGreaterThan(0);
    expect(
      Math.round(card.y + card.height - (cellBox.y + cellBox.height)),
      'the card does not reach past the bottom of its cell',
    ).toBeGreaterThan(8);

    // A strip strictly below the cell, inside the card's own width.
    const strip = {
      x: Math.round(card.x + 4),
      y: Math.round(cellBox.y + cellBox.height + 2),
      width: Math.round(Math.min(card.width - 8, 120)),
      height: 8,
    };
    const painted = await page.screenshot({ clip: strip });

    // Away, and the card with it — then the same strip again.
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
    const bare = await page.screenshot({ clip: strip });

    // Compared as text rather than through `Buffer.equals`, which this
    // project's `Buffer` types will not accept another `Buffer` for.
    expect(
      painted.toString('base64') === bare.toString('base64'),
      'the strip below the cell looks the same with the card open',
    ).toBe(false);
  });

  test('lets a click through to the row underneath it', async ({ page }) => {
    // The fault this rule was written for: a card hanging over the row below
    // eats a click aimed at that row. `pointer-events: none` is the fix, and a
    // browser is the only thing that performs a click through a box.
    //
    // Proof: `HoverCard`'s default flipped to `pointerEvents: 'auto'`, this
    // failed on `locator.click: Test timeout of 60000ms exceeded` with the call
    // log reading `<div role="tooltip" aria-label="Dev for 010">…</div> …
    // intercepts pointer events` — the click retried until the clock ran out.
    // Watched, 2026-08-09.
    await foldedDevCell(page, '010').hover();
    expect(await cardsOpen(page)).toBe(1);

    // The same column, one row down — which is where this card hangs.
    const under = page.getByLabel('Dev estimate for 020');
    const underBox = await boxOf(under, 'the second row’s Dev cell');
    const card = await boxOf(page.locator('[role="tooltip"]').first(), 'the card');
    expect(
      underBox.y,
      'the card does not reach the row below, so this test clicks nothing',
    ).toBeLessThan(card.y + card.height);

    await under.click({ position: { x: 4, y: 4 } });

    await expect(under).toBeFocused();
  });
});

/** How far under the pinned block the card's own column is pushed, in px. */
const PIN_OVERLAP = 60;

test.describe('a card and the pinned columns it slides under', () => {
  test('paints over the pinned cell of the row below it', async ({ page }) => {
    // agy round 3, finding 6: the row lift (`POPOVER_ROW_LAYER`) is applied to
    // the Name column alone, so does a depends or folded-role card paint *under*
    // a pinned cell of the row below?
    //
    // The answer is no, and the reason is the one the lift's own comment gives:
    // it exists because the Name cell is `position: sticky` **with a z-index**,
    // which makes that `<td>` a stacking context and traps the preview inside it
    // at the pinned layer. Neither `depends` nor `<roleId>-final` is pinned —
    // `table-frame.test.ts` asserts `pinnedCellStyle` answers `undefined` for
    // both — so nothing on the way from those cards to the frame establishes a
    // stacking context, and the card's own `z-index: 20` competes directly with
    // the pinned layer, which is 1.
    //
    // Reasoning is not evidence, hence this. The two never overlap sitting
    // still — the pinned block is to the *left* of both columns and a card opens
    // rightwards — so the frame is scrolled until the depends column is half
    // under the pin, and the strip compared is inside the pinned Name cell of
    // the row below.
    //
    // Proof: `zIndex: 20` removed from `HoverCard`, this failed on `the pinned
    // cell below hides the card: expected false, received true`. Watched,
    // 2026-08-09.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();

    const typed = page.getByLabel('Add a dependency to 010');
    await typed.fill('030');
    await typed.press('Enter');
    await expect(page.getByLabel('Stop 010 waiting for 030')).toBeVisible();
    // The picker owns the cell while the box has the focus, so the card only
    // opens once the box has been left — which is how a reader reaches it too.
    await page.getByLabel('Name of 020').click();

    const dependsCell = page.getByLabel('Add a dependency to 010').locator('..');
    // The pinned cell, not the box inside it: the `<td>` is what is sticky, what
    // carries the opaque background, and what would hide the card.
    const pinnedBelow = page.getByLabel('Name of 020').locator('xpath=ancestor::td');

    // Measured, not guessed: how far the frame has to travel to put the left
    // 60px of the depends column under the pinned block, leaving its right
    // edge clear for a pointer. Asserted rather than assumed, because a frame
    // that would not scroll leaves everything below overlapping nothing.
    const atRest = await boxOf(dependsCell, 'the depends cell');
    const pinRight = await boxOf(pinnedBelow, 'the pinned cell below').then(
      (pin) => pin.x + pin.width,
    );
    const slide = Math.round(atRest.x - pinRight + PIN_OVERLAP);
    expect(slide, 'the depends column already sits under the pin').toBeGreaterThan(0);
    const reached = await page.evaluate((left) => {
      const frame = document.querySelector('[data-table-frame]');
      if (frame === null) throw new Error('the scrolling frame is not on the page');
      frame.scrollLeft = left;
      return frame.scrollLeft;
    }, slide);
    expect(reached, 'the frame would not scroll that far').toBe(slide);

    // On the half of the cell that is still clear of the pinned block: a
    // pointer aimed at the half under it lands on the pin instead.
    await dependsCell.hover({ position: { x: PIN_OVERLAP + 16, y: 4 } });
    expect(await cardsOpen(page), 'no card opened on the depends cell').toBe(1);

    const card = await boxOf(page.locator('[role="tooltip"]').first(), 'the card');
    const pinned = await boxOf(pinnedBelow, 'the pinned cell below');
    // The overlap, and it is a precondition rather than a formality: an empty
    // rectangle would make the comparison below a screenshot of two identical
    // patches of nothing — R5 tally #16, which is exactly this mistake.
    const strip = {
      x: Math.round(Math.max(card.x, pinned.x)),
      y: Math.round(Math.max(card.y, pinned.y)),
      width: 0,
      height: 0,
    };
    strip.width = Math.round(Math.min(card.x + card.width, pinned.x + pinned.width) - strip.x);
    strip.height = Math.round(Math.min(card.y + card.height, pinned.y + pinned.height) - strip.y);
    expect(strip.width, 'the card and the pinned box below it do not overlap').toBeGreaterThan(8);
    expect(strip.height, 'the card and the pinned box below it do not overlap').toBeGreaterThan(4);

    const painted = await page.screenshot({ clip: strip });
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
    const bare = await page.screenshot({ clip: strip });

    expect(
      painted.toString('base64') === bare.toString('base64'),
      'the pinned cell below hides the card',
    ).toBe(false);
  });
});

/** The `<tr>` a numbered row's cells sit in, found through its own Name box. */
const rowOf = (page: Page, number: string): Locator =>
  page.getByLabel(`Name of ${number}`).locator('xpath=ancestor::tr');

/**
 * The painted colour of a row's pinned Name cell.
 *
 * The **pinned** cell on purpose: it paints an opaque inline background, so a
 * highlight only reaches it through the `--cell-bg` join — which is exactly
 * the wiring these tests exist to see. jsdom asserts the `data-dep-lit`
 * attribute; whether any pixel changes colour is the cascade's doing, and the
 * cascade runs here.
 */
const rowBg = (page: Page, number: string): Promise<string> =>
  rowOf(page, number)
    .locator('td[data-column="name"]')
    .evaluate((cell) => getComputedStyle(cell).backgroundColor);

/**
 * The same colour, read only once the cell's 100ms background cross-fade has
 * finished — a CSS transition registers on `getAnimations()` while it runs.
 *
 * Every *remembered* colour goes through this. A colour captured mid-fade —
 * the rest shade read just after the pointer left the row, or the lit shade
 * read the frame the light arrived — is a value no settled frame will ever
 * show again, and an assertion against it fails on a timing nobody chose.
 * The change-detection polls stay on {@link rowBg}: "has it moved off rest"
 * is true mid-fade too, and sooner.
 */
async function settledRowBg(page: Page, number: string): Promise<string> {
  const cell = rowOf(page, number).locator('td[data-column="name"]');
  await expect.poll(() => cell.evaluate((td) => td.getAnimations().length)).toBe(0);
  return cell.evaluate((td) => getComputedStyle(td).backgroundColor);
}

/** The painted colour of an element's own background, whatever notation it is in. */
const bgOf = (locator: Locator): Promise<string> =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor);

/** A background nothing painted — what Chromium answers for `background: none`. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/**
 * The sRGB luminance of any colour the engine can parse, 0–255.
 *
 * **Rasterised, not parsed.** A computed `color-mix` comes back from Chromium as
 * `oklab(…)` and a resting grey as `rgb(…)`, and string equality between two
 * notations is exactly how "the card and the grid say this one in the same
 * voice" was recorded as true while the two were moving in opposite directions
 * on a dark page. Whether a tint is *lighter or darker than what it sits on* is
 * a question about one number, and the engine that paints the colour is the only
 * honest place to get it.
 *
 * A colour the engine refuses leaves `fillStyle` at whatever it held, so an
 * unparseable value would silently read as one more grey rather than as a
 * mistake. The sentinel is what makes that loud.
 */
const luminance = (page: Page, colour: string): Promise<number> =>
  page.evaluate((c) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d context to rasterise a colour in');
    const sentinel = '#ff00ff';
    ctx.fillStyle = sentinel;
    ctx.fillStyle = c;
    if (ctx.fillStyle === sentinel) throw new Error(`this engine will not parse ${c}`);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }, colour);

/** Points at the cell's own left padding, never at a chip that narrows the tint. */
async function hoverPassiveDependsCell(page: Page, number: string): Promise<void> {
  const cell = page
    .getByLabel(`Add a dependency to ${number}`)
    .locator('xpath=ancestor::td[@data-column="depends"]');
  const box = await cell.boundingBox();
  if (box === null) throw new Error(`the Depends on cell for ${number} has no box`);
  const point = { x: box.x + 2, y: box.y + box.height / 2 };
  expect(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest('button, [data-reference-chip]') === null;
    }, point),
    `the passive point in ${number}'s Depends on cell lands on a chip`,
  ).toBe(true);
  await page.mouse.move(point.x, point.y);
}

test.describe('hovering a dependency lights the rows it names', () => {
  /** A third row, waiting for the two the shared seed made. */
  async function seed030WaitingForBoth(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    const depends = page.getByLabel('Add a dependency to 030');
    await depends.click();
    await depends.fill('010, 020');
    await depends.press('Enter');
    await expect(page.getByRole('button', { name: /^Stop 030 waiting for / })).toHaveCount(2);
    // At rest: the picker owns the cell while the box has the focus.
    await page.getByLabel('Name of 010').click();
    await page.getByLabel('Name of 010').blur();
    await page.mouse.move(0, 0);
  }

  /** A top-row owner whose card has three reachable dependency rows. */
  async function seed010WaitingForThree(page: Page): Promise<void> {
    const addRow = page.getByRole('button', { name: 'Add work item' });
    await addRow.click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    await page.getByLabel('Name of 030').fill('Price the replacement racks');
    await page.getByLabel('Name of 030').blur();
    await addRow.click();
    await expect(page.getByLabel('Name of 040')).toBeVisible();
    await page.getByLabel('Name of 040').fill('Order the installation crew');
    await page.getByLabel('Name of 040').blur();

    const depends = page.getByLabel('Add a dependency to 010');
    await depends.click();
    await depends.fill('020, 030, 040');
    await depends.press('Enter');
    await expect(page.getByRole('button', { name: /^Stop 010 waiting for / })).toHaveCount(3);
    await page.getByLabel('Name of 010').click();
    await page.getByLabel('Name of 010').blur();
    await page.mouse.move(0, 0);
  }

  test('the cell lights every dependency’s row, and dark again on leaving', async ({ page }) => {
    await seed030WaitingForBoth(page);
    // The rest colours differ (banding), which is what makes the equality at
    // the bottom a claim about one shared tint rather than about any change.
    const rest010 = await settledRowBg(page, '010');
    const rest020 = await settledRowBg(page, '020');

    await hoverPassiveDependsCell(page, '030');

    await expect(rowOf(page, '010')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '020')).toHaveAttribute('data-dep-lit', 'true');
    // Not the hovered row itself: the lit set is its dependencies, not it.
    await expect(rowOf(page, '030')).not.toHaveAttribute('data-dep-lit', 'true');
    // Polled: the cells cross-fade their background over 100ms.
    await expect.poll(() => rowBg(page, '010')).not.toBe(rest010);
    await expect.poll(() => rowBg(page, '020')).not.toBe(rest020);
    // One tint: a banded and an unbanded row land on the same colour, so the
    // rule re-pointed `--cell-bg` rather than nudging each row's own grey.
    expect(await settledRowBg(page, '010')).toBe(await settledRowBg(page, '020'));

    await page.mouse.move(0, 0);
    await expect.poll(() => rowBg(page, '010')).toBe(rest010);
    await expect.poll(() => rowBg(page, '020')).toBe(rest020);
  });

  test('a pill narrows the light to its row and tints its line in the card', async ({ page }) => {
    await seed030WaitingForBoth(page);
    const rest010 = await settledRowBg(page, '010');
    const rest020 = await settledRowBg(page, '020');

    await page.getByRole('button', { name: 'Stop 030 waiting for 010' }).hover();

    await expect(rowOf(page, '010')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '020')).not.toHaveAttribute('data-dep-lit', 'true');
    await expect.poll(() => rowBg(page, '010')).not.toBe(rest010);
    expect(await rowBg(page, '020')).toBe(rest020);

    // The card is open — the pill is inside the cell the card belongs to — and
    // the pill's own line, and only it, carries a swatch, at the card's
    // ordinary weight: emphasis by background, not by heading.
    //
    // *Which* colour that swatch is belongs to the next test, not this one.
    // Asserting the lit row's exact value here is what hid the fault this test
    // ran green through for a day: in the default palette `--background` and
    // `--popover` are the same white, so the grid's tint and the card's are the
    // same number, and an assertion that they are equal is satisfied by a
    // token that moves the two surfaces in opposite directions on a dark page.
    // Direction against each surface is the real claim, and it takes both
    // palettes to make it.
    expect(await cardsOpen(page)).toBe(1);
    const card = page.locator('[role="tooltip"]');
    const emphasised = card.getByText('010 - Survey the existing warehouse racking', {
      exact: true,
    });
    const other = card.getByText('020 - Draft the replacement layout', { exact: true });
    expect(await bgOf(emphasised)).not.toBe(TRANSPARENT);
    expect(await emphasised.evaluate((line) => getComputedStyle(line).fontWeight)).toBe('400');
    expect(await bgOf(other)).toBe(TRANSPARENT);

    // Off the pill onto the cell's passive owner area: the light widens back
    // to every dependency — the browser's own leave, `relatedTarget` and all.
    // The input itself may be clipped behind a full strip at rest.
    await hoverPassiveDependsCell(page, '030');
    await expect(rowOf(page, '020')).toHaveAttribute('data-dep-lit', 'true');
    await expect.poll(() => rowBg(page, '020')).not.toBe(rest020);
  });

  test('travels through passive card space to the third row and leaves empty padding click-through', async ({
    page,
  }) => {
    await seed010WaitingForThree(page);
    const owner = page.getByLabel('Add a dependency to 010');
    const card = page.getByRole('tooltip', { name: 'What 010 waits for' });
    const third = card.getByText('040 - Order the installation crew', { exact: true });

    await owner.hover();
    expect(await cardsOpen(page), 'the owner did not open its dependency card').toBe(1);
    await expect(card.locator('[data-depends-card-target]')).toHaveCount(3);

    const ownerBox = await boxOf(owner, 'the dependency owner');
    const cardBox = await boxOf(card, 'the dependency card');
    const thirdBox = await boxOf(third, 'the third dependency row');
    const passive = { x: thirdBox.x + thirdBox.width / 2, y: cardBox.y + 4 };
    const passiveProbe = await page.evaluate(
      ({ point, cardSelector, targetSelector }) => {
        const cardNode = document.querySelector(cardSelector);
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          insideCard:
            cardNode instanceof HTMLElement &&
            point.x >= cardNode.getBoundingClientRect().left &&
            point.x <= cardNode.getBoundingClientRect().right &&
            point.y >= cardNode.getBoundingClientRect().top &&
            point.y <= cardNode.getBoundingClientRect().bottom,
          hitsTarget: hit instanceof Element && hit.closest(targetSelector) !== null,
        };
      },
      {
        point: passive,
        cardSelector: '[aria-label="What 010 waits for"]',
        targetSelector: '[data-depends-card-target]',
      },
    );
    expect(passiveProbe.insideCard, 'the bridge point is outside the card').toBe(true);
    expect(passiveProbe.hitsTarget, 'the bridge point is not passive padding').toBe(false);

    await page.mouse.move(ownerBox.x + ownerBox.width / 2, ownerBox.y + ownerBox.height / 2);
    await page.mouse.move(passive.x, passive.y);
    expect(await cardsOpen(page), 'the card closed while crossing passive padding').toBe(1);
    await page.mouse.move(thirdBox.x + thirdBox.width / 2, thirdBox.y + thirdBox.height / 2);

    expect(
      await third.evaluate((line) => {
        const box = line.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && line.contains(hit);
      }),
      'the third dependency row target does not own its painted pixels',
    ).toBe(true);

    await expect(rowOf(page, '040')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '020')).not.toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '030')).not.toHaveAttribute('data-dep-lit', 'true');
    expect(await bgOf(third), 'the third card line has no tint').not.toBe(TRANSPARENT);
    expect(await bgOf(card.getByText('020 - Draft the replacement layout', { exact: true }))).toBe(
      TRANSPARENT,
    );

    for (const staleEvent of ['scroll', 'resize', 'pointercancel'] as const) {
      if (staleEvent === 'scroll') {
        await page.locator('[data-table-frame]').dispatchEvent('scroll');
      } else if (staleEvent === 'resize') {
        await page.setViewportSize({ width: 1279, height: 899 });
      } else {
        await page.evaluate(() => {
          document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
        });
      }
      await expect(card).toHaveCount(0);
      await expect(rowOf(page, '040')).not.toHaveAttribute('data-dep-lit', 'true');
      await owner.hover();
      await third.hover();
      await expect(rowOf(page, '040')).toHaveAttribute('data-dep-lit', 'true');
    }

    const underneath = page.getByRole('button', { name: 'Make 020 wait for something' });
    const underneathBox = await boxOf(underneath, 'the action under the card padding');
    const clickPoint = {
      x: underneathBox.x + underneathBox.width / 2,
      y: underneathBox.y + underneathBox.height / 2,
    };
    const clickProbe = await page.evaluate(
      ({ point }) => {
        const hit = document.elementFromPoint(point.x, point.y);
        const button = document.querySelector('[aria-label="Make 020 wait for something"]');
        const cardNode = document.querySelector('[aria-label="What 010 waits for"]');
        return {
          hitsButton: hit !== null && button instanceof HTMLElement && button.contains(hit),
          hitsCardTarget:
            hit instanceof Element && hit.closest('[data-depends-card-target]') !== null,
          insideCard:
            cardNode instanceof HTMLElement &&
            point.x >= cardNode.getBoundingClientRect().left &&
            point.x <= cardNode.getBoundingClientRect().right &&
            point.y >= cardNode.getBoundingClientRect().top &&
            point.y <= cardNode.getBoundingClientRect().bottom,
        };
      },
      { point: clickPoint },
    );
    expect(clickProbe.insideCard, 'the underlying action is not covered by the card').toBe(true);
    expect(clickProbe.hitsCardTarget, 'a dependency row swallowed the empty-card click').toBe(
      false,
    );
    expect(clickProbe.hitsButton, 'the empty card area intercepted the underlying action').toBe(
      true,
    );

    await page.mouse.click(clickPoint.x, clickPoint.y);
    await expect(page.getByLabel('Add a dependency to 020')).toBeFocused();
  });

  test('the tint moves the same way on both surfaces, in both palettes', async ({ page }) => {
    await seed030WaitingForBoth(page);
    const pill = page.getByRole('button', { name: 'Stop 030 waiting for 010' });
    const card = page.locator('[role="tooltip"]');
    const line = card.getByText('010 - Survey the existing warehouse racking', { exact: true });

    // Both palettes, and it has to be both: the grid sits on `--background` and
    // the card on `--popover`, which are the same white in the default theme and
    // `oklch(0.129 …)` against `oklch(0.208 …)` in the dark one. One absolute
    // tint mixed against the page therefore lands *between* the two dark
    // surfaces — lighter than the rows, darker than the card — and the single
    // emphasis reads as a tint in the grid and as a cutout in the card. Light
    // alone can never see that, because light alone has one surface.
    //
    // The app **ships a theme switch** since `dark-mode`, and this still sets
    // the class by hand: the control is three items in the account menu, and an
    // open popover over the grid is exactly the kind of second surface these
    // reads would pick up by accident. `deps-cell.spec.ts` walks the real
    // control for the direction rule instead, so the two are covered between
    // them; that the class is the whole mechanism is `styles.css`'s own claim
    // (`.dark` re-points the custom properties every token is mixed from), and
    // `dark-mode.spec.ts` is what holds the control to reaching it.
    for (const palette of ['light', 'dark'] as const) {
      await page.evaluate((wanted) => {
        document.documentElement.classList.toggle('dark', wanted === 'dark');
      }, palette);

      await page.mouse.move(0, 0);
      await expect(rowOf(page, '010')).not.toHaveAttribute('data-dep-lit', 'true');
      const gridRest = await luminance(page, await settledRowBg(page, '010'));

      await pill.hover();
      await expect(rowOf(page, '010')).toHaveAttribute('data-dep-lit', 'true');
      // One card, so the two reads below are of the surface and the line on it.
      expect(await cardsOpen(page), `${palette}: no card to read the swatch off`).toBe(1);
      const gridLit = await luminance(page, await settledRowBg(page, '010'));
      const cardRest = await luminance(page, await bgOf(card));
      const cardLit = await luminance(page, await bgOf(line));

      // Non-vacuous first, in both places: a tint that did not move cannot be
      // said to have moved the right way, and `Math.sign(0)` is `0`, which would
      // otherwise agree with itself.
      expect(
        Math.abs(gridLit - gridRest),
        `${palette}: the row's tint did not move`,
      ).toBeGreaterThan(1);
      expect(
        Math.abs(cardLit - cardRest),
        `${palette}: the card's swatch did not move`,
      ).toBeGreaterThan(1);

      // The claim: the same emphasis, the same way, off whatever it sits on.
      // Lighter than both surfaces on a dark page, darker than both on a light
      // one — never one of each.
      expect(
        Math.sign(gridLit - gridRest),
        `${palette}: the row goes ${gridLit > gridRest ? 'lighter' : 'darker'} and the card's line goes ${cardLit > cardRest ? 'lighter' : 'darker'}`,
      ).toBe(Math.sign(cardLit - cardRest));
    }
  });

  test('the keyboard gets the same light, from the box’s focus', async ({ page }) => {
    await seed030WaitingForBoth(page);
    const rest010 = await settledRowBg(page, '010');
    const rest020 = await settledRowBg(page, '020');

    // Focus, with the pointer parked at the origin by the seed: the light is
    // the change's one visual answer to "what does this row wait for", and a
    // pointer-only answer is no answer to somebody who never holds a mouse.
    // Tab through the plan lands on this box — `deps-single-line` keeps the
    // chips out of the rested tab order — so the box is the keyboard's handle
    // on the cell, and the cell-level light is what it gets.
    await page.getByLabel('Add a dependency to 030').focus();

    await expect(rowOf(page, '010')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '020')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '030')).not.toHaveAttribute('data-dep-lit', 'true');
    // Painted, not merely attributed — the pinned cells, through `--cell-bg`,
    // which is the whole reason these reads are a browser's and not jsdom's.
    await expect.poll(() => rowBg(page, '010')).not.toBe(rest010);
    await expect.poll(() => rowBg(page, '020')).not.toBe(rest020);

    // Out of the cell to a control outside the grid, so nothing else in a row
    // is focused and painting over what is being read.
    await page.getByRole('button', { name: 'Add work item' }).focus();
    await expect(rowOf(page, '010')).not.toHaveAttribute('data-dep-lit', 'true');
    await expect.poll(() => rowBg(page, '010')).toBe(rest010);
    await expect.poll(() => rowBg(page, '020')).toBe(rest020);
  });

  test('the light outranks the pointer on a banded row as well as a plain one', async ({
    page,
  }) => {
    // The stripe the light lands on must not decide what the light looks
    // like. `table-mechanics` added a second hover token for banded rows, and
    // `[data-grid] tbody tr:nth-child(even):hover` outweighs
    // `tr[data-dep-lit]` — one attribute and two pseudo-classes against one
    // attribute — so source order, which is what that block's comment said
    // held the two apart, decided nothing at all. On an odd row the light
    // won; on an even one the pointer painted straight over it.
    //
    // Reachable without a drag, which is why this test is here and not in a
    // drag spec: `data-dep-lit` comes from `depHover ?? depFocus`, and the
    // *focus* half lights a row while the pointer is resting somewhere else
    // of the reader's choosing.
    //
    // 020 is the second body row, so it is the banded one — the assertion at
    // the top, that the two lit rows are one colour, is what says so without
    // reading the stripe out of the stylesheet.
    //
    // Proof, watched in CI's `pixels` job at `b441c414`, 2026-08-12 — the two
    // `:not()`s not yet on the banded-hover rule: `the pointer repainted the
    // lit row on a banded stripe … Expected: "oklab(0.96448 -0.00109706
    // -0.00467295)" Received: "oklab(0.917255 -0.000368904 -0.00397291)"`.
    // The received value is `--grid-band-hover` exactly; the expected one is
    // `--grid-dep-lit`, which is what the odd row beside it kept.
    await seed030WaitingForBoth(page);

    // The keyboard's light, with the pointer parked at the origin by the seed.
    await page.getByLabel('Add a dependency to 030').focus();
    await expect(rowOf(page, '010')).toHaveAttribute('data-dep-lit', 'true');
    await expect(rowOf(page, '020')).toHaveAttribute('data-dep-lit', 'true');
    const lit = await settledRowBg(page, '020');
    expect(lit, 'the lit tint differs by stripe before the pointer is anywhere near').toBe(
      await settledRowBg(page, '010'),
    );

    // The pointer onto the banded lit row, and nothing else: the Name cell
    // opens no preview of its own, and hovering moves no focus, so the light
    // is still the box's.
    await rowOf(page, '020').locator('td[data-column="name"]').hover();
    await expect(rowOf(page, '020')).toHaveAttribute('data-dep-lit', 'true');

    expect(
      await settledRowBg(page, '020'),
      'the pointer repainted the lit row on a banded stripe',
    ).toBe(lit);
    // And the unhovered lit row has not moved either, so the equality above is
    // a claim about the pointer rather than about the whole page settling.
    expect(await settledRowBg(page, '010')).toBe(lit);
  });

  test('a clipped chip has no hover target, and the cell still lights its row', async ({
    page,
  }) => {
    // The U3→U4 case, named in the plan rather than discovered: after
    // `deps-single-line` the strip clips, so a chip can stand out of sight
    // with no pixel to hover — its *row* must still light from the cell-level
    // hover. Seven siblings onto 020, the deep-plan shape `deps-cell.spec.ts`
    // proves the clipping of.
    const addRow = page.getByRole('button', { name: 'Add work item' });
    for (const number of ['030', '040', '050', '060', '070', '080', '090']) {
      await addRow.click();
      await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
    }
    const waitedFor = ['030', '040', '050', '060', '070', '080', '090'];
    const depends = page.getByLabel('Add a dependency to 020');
    await depends.click();
    await depends.fill(waitedFor.join(', '));
    await depends.press('Enter');
    await expect(page.getByRole('button', { name: /^Stop 020 waiting for / })).toHaveCount(7);
    await page.getByLabel('Name of 010').click();
    await page.getByLabel('Name of 010').blur();
    await page.mouse.move(0, 0);
    const rest090 = await settledRowBg(page, '090');

    const probed = await page.evaluate(() => {
      const chip = document.querySelector('[aria-label="Stop 020 waiting for 090"]');
      if (!(chip instanceof HTMLElement)) throw new Error('no chip for 090 on the page');
      const strip = chip.closest('[data-depends-strip]');
      if (!(strip instanceof HTMLElement)) throw new Error('the 090 chip is not in a strip');
      const box = chip.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      // Somewhere in the cell that is neither a chip nor the box: the first
      // pixel along the strip's midline that hit-tests to the strip itself —
      // a gap between chips. That is what "cell-level hover" is once chips
      // crowd the cell, and finding it by hit test rather than by offset
      // keeps the probe honest about what the pointer would really land on.
      const stripBox = strip.getBoundingClientRect();
      const y = stripBox.y + stripBox.height / 2;
      let cellPoint: { x: number; y: number } | null = null;
      for (let x = Math.ceil(stripBox.x) + 1; x < stripBox.right - 1; x += 1) {
        if (document.elementFromPoint(x, y) === strip) {
          cellPoint = { x, y };
          break;
        }
      }
      return {
        chipWidth: box.width,
        chipHeight: box.height,
        clippedChipIsHoverable: at !== null && chip.contains(at),
        stripClips: strip.scrollWidth > strip.clientWidth,
        cellPoint,
      };
    });
    // The preconditions, before the claim (R5 #16): the chip is laid out with
    // real area, the strip really clips, and the chip's own centre answers to
    // something else — there is genuinely no hover target on it.
    expect(probed.chipWidth).toBeGreaterThan(0);
    expect(probed.chipHeight).toBeGreaterThan(0);
    expect(probed.stripClips, 'nothing is clipped; this fixture stopped overrunning').toBe(true);
    expect(probed.clippedChipIsHoverable, 'the 090 chip still answers a hit test').toBe(false);
    if (probed.cellPoint === null) throw new Error('no cell-level hover point in the strip');

    await page.mouse.move(probed.cellPoint.x, probed.cellPoint.y);

    // Every dependency's row lights — the clipped chip's included.
    for (const number of waitedFor) {
      await expect(rowOf(page, number)).toHaveAttribute('data-dep-lit', 'true');
    }
    await expect.poll(() => rowBg(page, '090')).not.toBe(rest090);
  });
});

test.describe('the Name cell answers from its marker alone', () => {
  test('opens nothing from the cell and the rendered notes from the marker', async ({ page }) => {
    const name = page.getByLabel('Name of 010');
    await name.fill('Racking survey\n\n## Risks\n\n- the mezzanine is *unsurveyed*');
    await name.blur();

    await name.hover();
    expect(await cardsOpen(page), 'the cell itself opened a preview').toBe(0);

    await page.getByLabel('Notes on 010').hover();

    expect(await cardsOpen(page), 'the marker opened no preview').toBe(1);
    // Rendered, not printed: the heading and the emphasis are elements, which
    // is the whole difference between the preview and the box under it.
    const preview = page.getByRole('tooltip', { name: 'Notes for 010, rendered' });
    expect(await preview.locator('h2').textContent()).toBe('Risks');
    expect(await preview.locator('li em').textContent()).toBe('unsurveyed');
  });

  test('scrolls a note taller than the preview once the pointer is on it', async ({ page }) => {
    // The one card that scrolls, and the only way to scroll it is to put the
    // pointer on it — which means crossing the name box between the marker at
    // the top right of the cell and the card hanging off its bottom edge. While
    // the marker owned the `mouseleave`, that trip unmounted the card before the
    // pointer arrived, and everything past 320px of a note was unreadable (codex
    // round 3, finding 1). The leave belongs to the cell, which holds both.
    //
    // A browser and nothing else can say this: jsdom lays nothing out, so it has
    // no 320px to overflow, no wheel, and no pointer that is anywhere. The
    // companion unit test — `keeps the preview open while the pointer crosses
    // the cell to reach it` — can see the state; only this can see the note.
    //
    // Proof: the `onMouseLeave` put back on the notes marker, this failed on
    // `the card closed on the way to it: expected 1, received 0`. Watched,
    // 2026-08-09.
    const lines = Array.from({ length: 40 }, (_, at) => `- line ${String(at + 1)}`);
    const name = page.getByLabel('Name of 010');
    await name.fill(`Racking survey\n\n${lines.join('\n')}`);
    await name.blur();

    await page.getByLabel('Notes on 010').hover();
    const card = page.locator('[role="tooltip"]');
    expect(await cardsOpen(page), 'the marker opened no preview').toBe(1);

    // The precondition, and R5 tally #16 is why it is stated: a note that fitted
    // the card would scroll nowhere, and every assertion below would hold of a
    // card nobody could break.
    const overflow = await card.evaluate((scrolled) => ({
      scrollHeight: scrolled.scrollHeight,
      clientHeight: scrolled.clientHeight,
    }));
    expect(
      overflow.scrollHeight,
      'the note fits the card, so there is nothing to scroll to',
    ).toBeGreaterThan(overflow.clientHeight + 40);

    const box = await boxOf(card.first(), 'the preview');
    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));

    expect(await cardsOpen(page), 'the card closed on the way to it').toBe(1);

    await page.mouse.wheel(0, 4000);
    // Polled rather than read once: a wheel is applied on the compositor's own
    // schedule, and this is the one assertion in the file that is about a
    // gesture rather than about the frame a card opened in.
    await expect
      .poll(async () =>
        card.evaluate((scrolled) =>
          Math.round(scrolled.scrollHeight - scrolled.clientHeight - scrolled.scrollTop),
        ),
      )
      .toBeLessThanOrEqual(2);

    // And the last line is on screen, which is what a reader wanted: the numbers
    // above could be right about a box painted somewhere nobody can see.
    const lastBox = await boxOf(card.getByText('line 40', { exact: true }), 'the note’s last line');
    expect(lastBox.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(box.y + box.height + 1);
  });

  test('marks only the rows that have notes', async ({ page }) => {
    const name = page.getByLabel('Name of 010');
    await name.fill('Racking survey\nthe mezzanine is unsurveyed');
    await name.blur();

    await expect(page.getByLabel('Notes on 010')).toBeVisible();
    await expect(page.getByLabel('Notes on 020')).toHaveCount(0);
  });
});

test.describe('the Name cell’s preview takes the room around its cell', () => {
  /** A note far taller than any window, so the card is always sized by its room. */
  const LONG_NOTE = Array.from({ length: 120 }, (_, at) => `- line ${String(at + 1)}`).join('\n');

  /** Fills a row's note and opens its preview, answering the card. */
  async function previewOf(page: Page, number: string): Promise<Locator> {
    const name = page.getByLabel(`Name of ${number}`);
    await name.fill(`Racking survey\n\n${LONG_NOTE}`);
    await name.blur();
    await page.getByLabel(`Notes on ${number}`).hover();
    expect(await cardsOpen(page), 'the marker opened no preview').toBe(1);
    return page.locator('[role="tooltip"]').first();
  }

  /**
   * Adds rows until the plan is taller than the frame holding it.
   *
   * The frame takes the remainder of the window only while it has rows to put
   * in it (`table-frame.ts`), so a test about the room around a cell has to say
   * which of the two states it is measuring. This is the full one, and it is
   * asserted rather than counted to.
   */
  async function fillTheFrame(page: Page): Promise<void> {
    const addRow = page.getByRole('button', { name: 'Add work item' });
    const overflow = () =>
      page.evaluate(() => {
        const frame = document.querySelector('[data-table-frame]');
        if (frame === null) throw new Error('the scrolling frame is not on the page');
        return frame.scrollHeight - frame.clientHeight;
      });
    for (let row = 3; row <= 40 && (await overflow()) === 0; row += 1) {
      await addRow.click();
      await expect(page.getByLabel(`Name of ${`${String(row)}0`.padStart(3, '0')}`)).toBeVisible();
    }
    expect(await overflow(), 'the plan never filled its frame').toBeGreaterThan(0);
  }

  test('gives a long note the room below rather than 320px of it', async ({ page }) => {
    // The whole of the change, in a browser: jsdom lays nothing out, so the
    // 320px this replaces and the room that replaces it are both invisible to
    // `hover-card.test.tsx` — it can see the number the component computed, not
    // the box the browser drew.
    //
    // Proof: `maxHeight` in `HoverCard` pinned back to a flat 320 — failed on
    // `the card is still the old 320px slot: expected 320 to be greater than
    // 321`. Watched 2026-08-11.
    //
    // The plan is filled out first since `unified-scroll-docking`, and that is
    // this test's own subject read from the other end: the room is the frame's
    // and the frame is as tall as its rows, so on the two-row plan this used to
    // run against there is 267px of room and no assertion about 320 can say
    // anything. Watched on h2puni, 2026-08-12: `the card is still the old 320px
    // slot: expected 267 to be greater than 321`.
    await fillTheFrame(page);
    const card = await previewOf(page, '010');
    const box = await boxOf(card, 'the preview');
    const height = page.viewportSize()?.height ?? 0;
    expect(height, 'the viewport has no height to measure against').toBeGreaterThan(0);

    expect(box.height, 'the card is still the old 320px slot').toBeGreaterThan(321);
    expect(box.height, 'the card is taller than nine tenths of the window').toBeLessThanOrEqual(
      height * 0.9 + 1,
    );
    expect(box.y, 'the card starts above the top of the window').toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height, 'the card runs off the bottom of the window').toBeLessThanOrEqual(
      height + 1,
    );
  });

  test('opens the card above a row low in the table', async ({ page }) => {
    // A tall card below a low row is a card mostly off the bottom of the
    // screen, which is exactly what raising the height cap would have caused
    // and why `roomForCard` picks a side at all.
    //
    // Proof: the side forced to `'below'` in `roomForCard` — failed on `the
    // card opened downward from a row with no room below it: Expected: <= 459,
    // Received: 936`, a card whose bottom edge is 36px past a 900px window's.
    // Watched 2026-08-11.
    const addRow = page.getByRole('button', { name: 'Add work item' });
    const height = page.viewportSize()?.height ?? 0;

    // Rows until one of them is past the middle of the window, which is where
    // the room above a cell first exceeds the room below it. Stated rather
    // than assumed: R5 #16 is a flip asserted on a row that would have opened
    // downward anyway, which no injected fault can fail.
    let last = '020';
    for (let row = 3; row <= 18; row += 1) {
      await addRow.click();
      last = `${String(row)}0`.padStart(3, '0');
      await expect(page.getByLabel(`Name of ${last}`)).toBeVisible();
      const box = await boxOf(page.getByLabel(`Name of ${last}`), `row ${last}`);
      if (box.y > height / 2) break;
    }
    const cell = await boxOf(page.getByLabel(`Name of ${last}`), 'the low row');
    expect(
      height - (cell.y + cell.height),
      'the low row still has more room below it than above, so there is no flip to see',
    ).toBeLessThan(cell.y);

    const card = await previewOf(page, last);
    const box = await boxOf(card, 'the preview');

    expect(
      box.y + box.height,
      'the card opened downward from a row with no room below it',
    ).toBeLessThanOrEqual(cell.y + 1);
    expect(box.y, 'the flipped card runs off the top of the window').toBeGreaterThanOrEqual(-1);

    // And the pointer still reaches it: the card is above the marker now, so
    // the trip crosses the cell the other way. The card staying inside its
    // cell's own subtree is what makes that survivable — see `HoverCard`.
    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    expect(await cardsOpen(page), 'the flipped card closed on the way to it').toBe(1);
  });
});

/**
 * What the pointer does to a row, on both phases of the stripe.
 *
 * `--grid-hover` was one absolute shade, and the body is banded: a plain row
 * moved `oklab(1)` → `oklab(0.939 …)` under the pointer and a banded one
 * `oklab(0.978 …)` → the same `oklab(0.939 …)`. The pointer therefore said two
 * different things on alternate rows and said the quieter one on half the
 * plan — which is the "hovering a striped row shows nothing" of the UI audit,
 * 2026-08-12.
 *
 * A browser is the only oracle: every shade here is a `color-mix` resolved at
 * computed-value time, `:hover` is a state jsdom never enters, and the pinned
 * Name cell reaches its colour only through the `--cell-bg` join. What is
 * asserted is the *step*, in rasterised luminance, because that is the
 * quantity a reader sees — and it is asserted on both phases, because one
 * phase passing is how this shipped.
 */
test.describe('the pointer moves a row by the same ink on both phases of the stripe', () => {
  /** Where the pointer goes to be nowhere near a row. */
  const parkPointer = (page: Page): Promise<void> => page.mouse.move(0, 0);

  /** The settled luminance of a row's pinned Name cell. */
  const rowLuminance = async (page: Page, number: string): Promise<number> =>
    luminance(page, await settledRowBg(page, number));

  /**
   * Puts the page in one palette, the way the test above it does and for the
   * same reason: the control is three items in an account menu, and an open
   * popover over the grid is another surface these reads would pick up.
   */
  const wearPalette = (page: Page, palette: 'light' | 'dark'): Promise<void> =>
    page.evaluate((wanted) => {
      document.documentElement.classList.toggle('dark', wanted === 'dark');
    }, palette);

  /**
   * **Both palettes since `dark-mode`, and that is not symmetry for its own
   * sake.** `--grid-hover` and `--grid-band-hover` carry no `.dark` twin, on
   * the argument written over them in `styles.css`: both are mixes of
   * `--foreground` into `--background`, which `.dark` re-points, so the pair is
   * supposed to invert by itself. That argument was written while `.dark` was
   * **unreachable** — nothing in the app put the class on the document — so it
   * had never been measured against a browser. This change is what makes it
   * reachable, which makes the measurement this change's to take. The
   * arithmetic says the dark steps are 0.05985 against light's 0.06097; what
   * a rasteriser makes of that is what these two now read.
   *
   * **The dark case is real but blunter, and that is worth stating rather than
   * discovering.** `--grid-band-hover` overridden to `--grid-hover`'s own 7%
   * (below the grid's `:root` block, which is the only place such an override
   * wins — see `styles.css`) fails the light case at `Received: 7.0` against
   * the `< 3` bar and the dark case at `Received: 3.5748`. The same
   * two-and-a-half-percentage-point fault, a third of the signal, because sRGB
   * luminance compresses hard at the dark end. The bar is left where it is —
   * it is the reader-visible quantity in both palettes — but a *smaller*
   * mismatch than that one would pass in dark and fail in light. Watched on
   * h2puni, 2026-08-12.
   */
  for (const palette of ['light', 'dark'] as const) {
    test(`a banded row moves as far under the pointer as a plain one, in ${palette}`, async ({
      page,
    }) => {
      // The plan is the file's `beforeEach`'s — seeding a second one here signs
      // up over an account that is already signed in, and the Register button
      // the helper clicks is not on that page.
      await wearPalette(page, palette);
      await parkPointer(page);

      // 010 is the first body row and 020 the second, which is the one
      // `tr:nth-child(even)` bands. The precondition is that they differ at
      // rest: with no stripe at all this whole test would be about one colour.
      const restPlain = await rowLuminance(page, '010');
      const restBand = await rowLuminance(page, '020');
      expect(
        Math.abs(restPlain - restBand),
        'there is no stripe to hover, so this test measures nothing',
      ).toBeGreaterThan(2);

      await rowOf(page, '010').hover();
      const hoverPlain = await rowLuminance(page, '010');
      await parkPointer(page);
      await expect.poll(() => rowLuminance(page, '010')).toBe(restPlain);

      await rowOf(page, '020').hover();
      const hoverBand = await rowLuminance(page, '020');

      // Signed toward the page's own ink rather than always downward: on a
      // light page the pointer darkens a row and on a dark one it lightens it,
      // and a subtraction fixed one way would call the dark half a failure for
      // doing exactly what the tokens promise.
      const toward = palette === 'light' ? 1 : -1;
      const stepPlain = (restPlain - hoverPlain) * toward;
      const stepBand = (restBand - hoverBand) * toward;

      // Each phase moves at all, and the right way.
      expect(stepPlain, 'the pointer did not move a plain row toward the ink').toBeGreaterThan(8);
      expect(stepBand, 'the pointer did not move a banded row toward the ink').toBeGreaterThan(8);
      // And by the same amount. This is the assertion the single absolute token
      // failed: 19.6 against 12.6 on the palette this ships with.
      expect(
        Math.abs(stepPlain - stepBand),
        'the pointer moves a banded row and a plain row by different amounts',
      ).toBeLessThan(3);
    });

    test(`a hovered banded row is nobody else’s colour, in ${palette}`, async ({ page }) => {
      // The other half of "reads on both phases": the hovered banded row has to
      // be distinct from the rest shade of *both* kinds of row, or the pointer
      // is saying something one row along already says.
      await wearPalette(page, palette);
      await parkPointer(page);

      const restPlain = await rowLuminance(page, '010');
      const restBand = await rowLuminance(page, '020');

      await rowOf(page, '020').hover();
      const hoverBand = await rowLuminance(page, '020');

      expect(
        Math.abs(hoverBand - restBand),
        'a hovered banded row is its own rest shade',
      ).toBeGreaterThan(8);
      expect(
        Math.abs(hoverBand - restPlain),
        'a hovered banded row is the colour of every unbanded row',
      ).toBeGreaterThan(8);
    });
  }
});
