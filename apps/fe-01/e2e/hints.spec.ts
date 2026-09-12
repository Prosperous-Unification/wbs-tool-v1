import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * Every hint this app shows, drawn by the page rather than by the browser.
 *
 * Dany, 2026-08-31: _"make sure that all places where we show hint — this is
 * not slow system hint, but custom instant pretty hint"_. `start-date-hover-card`
 * had already done it for one cell; `hints-are-the-page-s-own` does it for the
 * other ninety-odd, by moving the words to `data-hint` and drawing them all in
 * one `HintLayer`.
 *
 * Dany, 2026-09-01: _"this must avoid unnecessary interruptions while moving
 * the cursor over UI elements, rn this is more annoying than useful when you
 * already know what buttons or UI elements do"_. So `tool-hints-wait` splits
 * them: words about the reader's own project keep `data-fact` and open at once,
 * words about what a control does keep `data-hint` and wait two seconds
 * behind a ring at the cursor.
 *
 * **None of these assertions can be made upstairs.** `hint.test.tsx` drives the
 * layer's own listeners in jsdom and proves the two paths apart on fake timers.
 * What jsdom cannot say is whether a **native** tooltip is still in the document
 * racing them — jsdom renders no tooltip of any kind, so a `title` left on a
 * control is invisible to every test up there — whether the card is placed
 * anywhere near the mark it belongs to, which is `getBoundingClientRect`'s
 * answer and jsdom's zeroes, or whether the ring lands near the real cursor,
 * which jsdom has none of.
 */

/** A plan with a toolbar, which is where most of this app's hints live. */
async function aPlan(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
}

/**
 * A plan with a start date and one work item, which is what a **cell's** card
 * needs to exist at all.
 *
 * The date is not decoration: `readings.startDate === null` disables the Not
 * before and Deadline inputs (`noCalendar`), and Chromium dispatches no pointer
 * event on a disabled form control — it retargets to the nearest enabled
 * ancestor, where `closest` looks **up** and never finds the input's own mark.
 * Measured while writing this file: without the date, `Not before` opened no
 * card at all.
 */
async function aPlanWithARow(page: Page): Promise<void> {
  await aPlan(page);
  await page.getByLabel('Project start date').fill('2026-06-01');
  await page.getByLabel('Project start date').blur();
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  // Deadline is contextual — a plan with no deadline in it does not draw the
  // column — so the sweep below asks for it by name, the way `deadline.spec.ts`
  // does. Waited for by the header rather than by the menu closing: the check
  // is a write and the column arrives with the answer.
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Deadline', exact: true }).check();
  await expect(page.locator('thead th[data-column="deadline"]')).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
}

const rowOf = (page: Page, number: string): Locator =>
  page.locator('tbody tr').filter({ has: page.getByLabel(`Name of ${number}`) });

/** The box a locator occupies, refused rather than defaulted when it has none. */
async function boxOf(
  locator: Locator,
  what: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box`);
  return box;
}

/**
 * The columns Dany named, and the mark in each whose card is measured.
 *
 * **Named one by one rather than swept off `td [data-fact]`**, for the reason
 * `tool-hints-wait` wrote down twice: a locator that says "the first mark of
 * this kind" is not about any particular mark, and a fresh row carries several.
 * A claim about the Slack column has to say Slack.
 *
 * `waits` is the split `tool-hints-wait` made, not a property of the placement:
 * Prio's words on an unprioritised row are about what the column is *for*, so
 * they are a `data-hint` and take two seconds. The other four are this row's own
 * facts and open at once.
 */
const DIAGONAL_COLUMNS: readonly {
  what: string;
  column: string;
  markOf: (row: Locator) => Locator;
  waits: boolean;
}[] = [
  {
    // The reorder grip, which is the leftmost column and a pinned one: its
    // card stands over the plan rather than over the chrome to its left.
    what: 'Reorder',
    column: 'drag',
    markOf: (row) => row.getByRole('button', { name: 'Reorder 010' }),
    waits: true,
  },
  {
    what: 'Prio',
    column: 'priority',
    markOf: (row) => row.getByLabel('Priority for 010'),
    waits: true,
  },
  {
    what: 'Not before',
    column: 'not-before',
    markOf: (row) => row.getByLabel('Earliest start for 010'),
    waits: false,
  },
  {
    what: 'Deadline',
    column: 'deadline',
    markOf: (row) => row.getByLabel('Work item deadline for 010'),
    waits: false,
  },
  {
    what: 'People at once',
    column: 'in-parallel',
    markOf: (row) => row.getByLabel('People at once for 010'),
    waits: true,
  },
  {
    what: 'End',
    column: 'finish',
    markOf: (row) => row.locator('td[data-column="finish"] [data-fact]'),
    waits: false,
  },
  {
    what: 'Slack',
    column: 'float',
    markOf: (row) => row.locator('td[data-column="float"] [data-fact]'),
    waits: false,
  },
];

test.describe('hints are the page’s own', () => {
  test('no control anywhere on the plan carries a native tooltip', async ({ page }) => {
    await aPlan(page);

    /*
      Every `title` **attribute** in the document, named by what carries it.

      An SVG `<title>` *element* is excluded and that is not a loophole: it is
      the accessible name of a shape, it draws no tooltip of its own in
      Chromium when the shape has an `aria-label`, and `gantt-panel.test.tsx`
      already asserts the bars have none. This is about the attribute, which is
      the one that makes Chromium wait a second and then draw in the platform's
      chrome.
    */
    const nativeTooltips = await page.evaluate(() =>
      [...document.querySelectorAll('[title]')].map((node) => ({
        tag: node.tagName.toLowerCase(),
        words: node.getAttribute('title'),
        name: node.getAttribute('aria-label') ?? node.textContent.slice(0, 40),
      })),
    );

    // Proof: `title="Undo your last change to this plan (Ctrl/⌘ + Z)"` put back
    // on the Undo button beside its `data-hint`. Watched failing on `Error: the
    // plan draws 1 native tooltips`, with the object the sweep found in the
    // diff under it.
    expect(
      nativeTooltips,
      `the plan draws ${String(nativeTooltips.length)} native tooltips`,
    ).toEqual([]);
  });

  test('no mark anywhere on the plan carries both a hint and a fact', async ({ page }) => {
    await aPlan(page);
    await page.getByRole('button', { name: 'Add work item' }).click();
    // The row's own number, and **not** `[data-fact]` unqualified: the first
    // mark carrying one is a facet `<label>` inside the closed Filters
    // disclosure, which is in the document and not visible, so waiting for it
    // to be seen waits for something that never happens. Measured — 63 polls
    // against `data-fact="No team owns a service yet…"`, "unexpected value
    // hidden". The sweep below reads the whole document either way; this is
    // only the wait that says the plan has finished drawing.
    await expect(page.locator('td [data-fact]').first()).toBeVisible();

    /*
      The two attributes are one choice, not a pair, and this is what keeps them
      one next month. Nesting is not the fault it guards — a fact chip inside a
      hinted toolbar is exactly what `closest` over both selectors is for — so
      the sweep is for **one node carrying both**, which is a call site that
      cannot say what kind of words it holds.
    */
    const carryingBoth = await page.evaluate(() =>
      [...document.querySelectorAll('[data-hint][data-fact]')].map((node) => ({
        tag: node.tagName.toLowerCase(),
        hint: node.getAttribute('data-hint'),
        fact: node.getAttribute('data-fact'),
      })),
    );

    // Proof: `data-fact="010"` added beside the Undo button's existing
    // `data-hint`. Watched failing on `Error: 1 marks carry both`, with the
    // button's two attributes printed in the diff under it.
    expect(carryingBoth, `${String(carryingBoth.length)} marks carry both`).toEqual([]);
  });

  test('a toolbar control waits two seconds, and rings while it does', async ({ page }) => {
    await aPlan(page);

    /*
      `Keyboard shortcuts` and not `Undo`, and the difference is the one thing
      worth knowing about this layer's reach: `buttonVariants`' base carries
      `disabled:pointer-events-none`, so a **disabled** control is not a hit
      target at all and no `pointerover` ever names it. Undo on a plan nobody
      has edited yet is disabled — measured, `elementFromPoint` at the button's
      own centre answering the toolbar `<div>` rather than the button. The
      controls that affects are Undo, Redo and Reset layout, whose hints restate
      what their labels already say; where the hint is the *reason* a control is
      off, the hint is on the live `<label>` around it rather than on the
      disabled `<input>` (`wbs-table.tsx`'s facet boxes).
    */
    const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
    await expect(shortcuts).toHaveAttribute('data-hint', /Keyboard shortcuts/);

    const control = await shortcuts.boundingBox();
    if (control === null) throw new Error('the control has no box to hover');
    const cursor = { x: control.x + control.width / 2, y: control.y + control.height / 2 };

    const card = page.getByRole('tooltip');
    const ring = page.locator('[data-wait-ring]');

    await shortcuts.hover();
    await page.waitForTimeout(200);

    // Nothing at all through the quiet, which is the whole of what makes a
    // cursor crossing this toolbar leave no mark behind it.
    //
    // **Counted, not awaited.** `expect(locator).toHaveCount(0)` is a
    // *retrying* assertion: it polls for thirty seconds and is satisfied the
    // moment the count reaches zero, which for a ring means the moment the card
    // replaces it. Written that way this passed with `RING_QUIET_MS` set to 0 —
    // watched — and the fault was caught two assertions later by the card
    // instead. Every silence in this file is read once, at the instant it is
    // about.
    //
    // Proof: `RING_QUIET_MS` set to 0.
    expect(await ring.count(), 'the ring is drawn inside the quiet').toBe(0);

    await page.waitForTimeout(800);

    // A full second in and still silent. Playwright's five-second default would
    // be satisfied by exactly the native tooltip this layer replaced, and by a
    // wait of any length at all; the claim is the silence, so the silence is
    // what is measured.
    //
    // Proof: `TOOL_HINT_WAIT_MS` set to 0.
    expect(await card.count(), 'the card came up inside the first second').toBe(0);

    // And the ring is up, beside the real cursor — the half jsdom has no
    // pointer to say anything about. Its area is asserted before its position:
    // a box with no area sits inside every other box there is, which is
    // `G gantt-calendar-axis`'s sixteenth fault.
    const ringBox = await ring.boundingBox();
    if (ringBox === null) throw new Error('no ring is drawn a second into the wait');
    expect(ringBox.width > 0 && ringBox.height > 0, 'the ring has no area').toBe(true);
    const fromCursor = Math.hypot(
      ringBox.x + ringBox.width / 2 - cursor.x,
      ringBox.y + ringBox.height / 2 - cursor.y,
    );
    // Proof: `RING_OFFSET_PX` set to 400, which is a ring drawn beside a
    // different control entirely. Watched failing on `Error: the ring is 573px
    // from the cursor · Expected: < 40 · Received: 573.0596...`.
    expect(
      fromCursor,
      `the ring is ${String(Math.round(fromCursor))}px from the cursor`,
    ).toBeLessThan(40);

    // The card arrives on time. A second of the two has already passed above,
    // so 1600ms is the rest of the wait plus 600ms of slack for the two
    // measurements between — a wait that had quietly grown longer fails here
    // rather than being absorbed by a generous default.
    //
    // Proof: `TOOL_HINT_WAIT_MS` put back to the `3000` it was before Dany
    // asked for two seconds. Watched failing on `expect(locator).toBeVisible()
    // failed · Expected: visible · Timeout: 1600ms · Error: element(s) not
    // found` — which is the whole reason this budget is the rest of the wait
    // and not Playwright's own default, a wait of any length at all passing
    // under that.
    await expect(card).toBeVisible({ timeout: 1600 });
    await expect(card).toHaveText(/Keyboard shortcuts/);

    // Proof: the `stopWaiting()` inside the opening timer removed — a ring left
    // spinning beside the card it had already delivered.
    expect(await ring.count(), 'the ring outlived the card it was waiting for').toBe(0);

    // And it is placed against the control, which is the half only a browser
    // can say: jsdom answers every rectangle with zeroes, so an unplaced card
    // and a placed one are the same object up there.
    const boxes = await page.evaluate(() => {
      const hinted = document.querySelector('[data-hint*="Keyboard shortcuts"]');
      const tip = document.querySelector('[role="tooltip"]');
      if (hinted === null || tip === null) throw new Error('the control or its card is missing');
      const a = hinted.getBoundingClientRect();
      const b = tip.getBoundingClientRect();
      return {
        cardHasArea: b.width > 0 && b.height > 0,
        below: b.top >= a.top,
        horizontalGap: Math.max(a.left - b.right, b.left - a.right),
      };
    });

    // The card has a size before anything is claimed about where it is, for the
    // ring's reason above.
    expect(boxes.cardHasArea, 'the card has no area').toBe(true);
    expect(boxes.below, 'the card is not under the control').toBe(true);
    expect(boxes.horizontalGap, 'the card is off to one side of the control').toBeLessThan(0);
  });

  /*
    **A browser case for "a scroll does not kill a wait" was written twice and
    shipped neither time.** The behaviour is real and is proved in
    `hint.test.tsx`, watched failing with the guard removed; what could not be
    made honest up here is the *oracle*.

    The first version added a work item and hovered `Gantt` — the arrangement a
    screenshot found the bug in. It is not an oracle: the same re-render both
    cancels the wait, through the scroll the settling table fires, and revives
    it, through a fresh `pointerover` on a button React has replaced under the
    cursor. Watched **passing** with the fault in, on one run of two.

    The second changed only the viewport height, so that nothing the pointer is
    over would move — the control's box was asserted identical either side of
    it. That one fails with the fix **in**: Chromium re-computes hit-testing
    after a resize and delivers a boundary event of its own, so the wait is
    ended by the browser rather than by this layer, and the case says nothing
    about the guard.

    A third try would need a page that scrolls without moving, re-rendering or
    re-hovering the control the pointer rests on, and this app has none. The
    jsdom case dispatches exactly one scroll and nothing else, which is the
    whole of what the guard is about.
  */

  test('a press ends the wait, and the ring with it', async ({ page }) => {
    await aPlan(page);

    /*
      Dany, 2026-09-01: _"interaction with the element must stop the spinner
      from appearing; if user clicks and interacts with the element, no need to
      show the tooltip; only show tooltip after prolonged hover without clicks"_.

      **This case cannot be made upstairs.** A press is a `pointerdown` *and*
      the focus Chromium performs as its **default action**, and jsdom performs
      no default action at all — so the seam the cancel has to beat is invisible
      to `hint.test.tsx`, which can only dispatch the two events by hand in an
      order it chooses itself. `AGENTS.md`'s R5 #14 and #17 are both this seam,
      both found in a browser after a jsdom suite had passed through the fault.

      `Keyboard shortcuts` for the reason the case above uses it: a disabled
      control is not a hit target, so `Undo` on an unedited plan never sees a
      pointer at all.
    */
    const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
    const card = page.getByRole('tooltip');
    const ring = page.locator('[data-wait-ring]');

    const box = await shortcuts.boundingBox();
    if (box === null) throw new Error('the control has no box to press');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(800);

    // The ring is up — which is what makes the next assertion about a wait that
    // was actually running, rather than about a page that was never waiting.
    expect(await ring.count(), 'no ring was drawn to take away').toBe(1);

    /*
      **`mouse.down()` and not `click()`, and the difference is what makes the
      assertion below able to fail.** Written as a full click, the ring was read
      after the dialog this button opens had already been drawn and dismissed —
      and that redraw clears the ring by itself, through a path that has nothing
      to do with the press. The check was watched **passing** with the whole
      `pointerdown` listener removed, the fault surfacing two assertions later
      as a card instead. Held at the press, the ring's absence is the press's
      own doing and nothing else's.
    */
    await page.mouse.down();

    // Read once, at the instant it is about. `toHaveCount(0)` polls for thirty
    // seconds and would be satisfied by a ring that goes at any point in them —
    // `LLM_README.md`'s landmine, and the fault it hid was in this very file.
    //
    // Proof: the `pointerdown` listener removed from `HintLayer`, watched
    // failing here on `Error: the ring outlived the press · Expected: 0 ·
    // Received: 1`.
    expect(await ring.count(), 'the ring outlived the press').toBe(0);

    await page.mouse.up();
    // The dialog the button opens is not this test's subject; it is dismissed
    // so that what follows is about a cursor resting on the control it pressed.
    await page.keyboard.press('Escape');

    /*
      And the whole of the rest of the wait passes with nothing drawn — through
      the dialog's own opening and closing, which fires `pointerover` twice
      under a cursor that has not moved. Measured in Chromium: both events
      report the press's own `834.47998046875,65`. Read as a departure and a
      return they restart the wait, and the card lands two seconds after the
      dialog closes over a button the reader has just used.
    */
    //
    // Proof: the `pressedAt` coordinate comparison removed from `pointed`,
    // watched failing on `Error: the card came up after the press · Expected: 0
    // · Received: 1`.
    await page.waitForTimeout(2400);
    expect(await card.count(), 'the card came up after the press').toBe(0);
    expect(await ring.count(), 'a ring came back after the press').toBe(0);
  });

  test('a pressed control explains itself again once the pointer has left', async ({ page }) => {
    await aPlan(page);

    /*
      **The quiet is a cancelled timer, not a control marked silent**, and this
      is the case that says so. Nothing in the layer remembers which control was
      pressed: the cursor moving is what ends the quiet, and the next rest is a
      wait like any other. A change that marked the control instead would pass
      every assertion in the case above and fail here.
    */
    const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
    const card = page.getByRole('tooltip');

    await shortcuts.hover();
    await shortcuts.click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2400);
    expect(await card.count(), 'the press did not silence the control').toBe(0);

    // Away, onto something carrying neither attribute, and back — a real move,
    // which is the only thing that ends the quiet.
    await page.mouse.move(4, 4);
    await page.waitForTimeout(100);
    await shortcuts.hover();

    // Proof: `pointed`'s `pressedAt = null` removed, so a cursor that has moved
    // never ends the quiet the press bought. Watched failing on
    // `expect(locator).toBeVisible() failed · Expected: visible · Error:
    // element(s) not found` — the control silent for the rest of the visit,
    // which is the design this case exists to refuse.
    await expect(card).toBeVisible({ timeout: 2600 });
    await expect(card).toHaveText(/Keyboard shortcuts/);
  });

  test('every column’s pop-up stands diagonally: past its cell and past its row', async ({
    page,
  }) => {
    // Dany, 2026-09-11: *"implement 'diagonal' pop-up for ALL columns including
    // PRIO, not before, deadline, end, slack; ALL of them, must have same look
    // and feel"*. The cards that open from a **cell** have been diagonal since
    // `cards-open-diagonally`; the columns swept here have no such card — the
    // hint layer is their pop-up, and it stood beside the mark with the tops
    // aligned, which left the column clear and the row covered.
    //
    // Both axes are asserted per column, because they are two different
    // measurements against two different boxes: the **cell** is what the pointer
    // runs down, and the **row** is the context the reader keeps.
    //
    // Proof, twice, both in Chromium on 2026-09-11:
    //
    // - The placement taken back to the aside one — `top` aligned with
    //   `clear.top` instead of standing past `clear.bottom`, which is exactly
    //   what shipped yesterday — failed on `Reorder: the card covers its own row
    //   · Expected: >= -0.5 · Received: -26.1875`, a whole row of overlap.
    // - The layer handed `{ anchor }` for an in-frame mark too, which is the
    //   placement before either change: `Reorder: the card stands over its own
    //   column · Expected: >= -0.5 · Received: -12`.
    await aPlanWithARow(page);
    const row = rowOf(page, '010');
    const card = page.getByRole('tooltip');
    const frame = await boxOf(page.locator('[data-table-frame]'), 'the scrolling frame');

    for (const each of DIAGONAL_COLUMNS) {
      // Away first, and read **once**: `toHaveCount(0)` retries for thirty
      // seconds and would be satisfied by the previous column's card closing
      // whenever it got round to it (R5, `tool-hints-wait`).
      await page.mouse.move(0, 0);
      expect(await card.count(), `${each.what}: a card was still open`).toBe(0);

      const mark = each.markOf(row);
      await expect(mark, `${each.what}: no mark to hover`).toBeVisible();
      await mark.hover();
      await expect(card, `${each.what}: no card opened`).toBeVisible({
        timeout: each.waits ? 3500 : 400,
      });

      const open = await boxOf(card, `${each.what}'s card`);
      const cell = await boxOf(
        row.locator(`td[data-column="${each.column}"]`),
        `${each.what}'s cell`,
      );
      const band = await boxOf(row, `${each.what}'s row`);

      // Its area first, for R5 #16's reason: a card of no area is clear of
      // everything and says nothing about placement.
      expect(open.width > 0 && open.height > 0, `${each.what}: the card has no area`).toBe(true);

      // Positive on either side: the card clear of the cell's right edge or
      // clear of its left, and clear below the row or clear above it. Negative
      // is an overlap, which is the fault in each axis. The placement abuts
      // exactly — no gap on either axis, so that a hint card and an in-cell
      // card stand in the same corner — so the tolerance is for the fraction of
      // a pixel a layout lands on, not for a lane.
      expect(
        Math.max(open.x - (cell.x + cell.width), cell.x - (open.x + open.width)),
        `${each.what}: the card stands over its own column`,
      ).toBeGreaterThanOrEqual(-0.5);
      expect(
        Math.max(open.y - (band.y + band.height), band.y - (open.y + open.height)),
        `${each.what}: the card covers its own row`,
      ).toBeGreaterThanOrEqual(-0.5);

      // And inside the plan, which is what clamping to the frame rather than to
      // the window is for: Slack and End stand within a card's width of the
      // frame's right edge, so their cards open to the **left**.
      expect(open.x, `${each.what}: the card starts left of the frame`).toBeGreaterThanOrEqual(
        frame.x - 1,
      );
      expect(
        open.x + open.width,
        `${each.what}: the card runs off the right of the frame`,
      ).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  });

  test('a card reads in the table’s own type, wherever it is drawn', async ({ page }) => {
    // The other half of Dany's _"must have same look and feel"_, 2026-09-11,
    // and the half no placement can see. A card that opens from a **cell** is a
    // child of that cell and inherits the grid's 13px over a 1.4 line; a
    // portalled one — the hint layer's, which is what most of these columns
    // answer with — is a child of `<body>`, outside the `font-sans` on `<main>`
    // and outside `[data-grid]` both, and came out in the user agent's own
    // `Times / 16px / normal`. Two typefaces and three points of size for one
    // pop-up, shipped since the hint layer was written.
    //
    // Measured against the **cell's** computed type rather than against
    // literals, because the claim is that the card reads like the table it
    // explains, and because the table's own size is asserted where it is set
    // (`e2e/layout.spec.ts`, `[data-grid] tbody`).
    //
    // Proof: `[role='tooltip']`'s block deleted from `styles.css`, this failed
    // on `the portalled card's type · Expected: "sans-serif / 13px / 18.2px" ·
    // Received: "Times / 16px / normal"`. Watched in Chromium, 2026-09-11.
    await aPlanWithARow(page);
    const row = rowOf(page, '010');
    // Notes, so the Name cell has a preview to open — the in-cell card this is
    // measured against.
    await page.getByLabel('Name of 010').fill('Row 010\n\nNotes with **markdown** in them.');
    await page.getByLabel('Name of 010').blur();

    const typeOf = (): Promise<{ card: string; cell: string; parent: string }> =>
      page.evaluate(() => {
        const card = document.querySelector('[role="tooltip"]');
        const cell = document.querySelector('td[data-column="float"]');
        if (!(card instanceof HTMLElement)) throw new Error('no card is open');
        if (!(cell instanceof HTMLElement)) throw new Error('the plan draws no Slack cell');
        const read = (node: HTMLElement): string => {
          const style = getComputedStyle(node);
          return `${style.fontFamily} / ${style.fontSize} / ${style.lineHeight}`;
        };
        return {
          card: read(card),
          cell: read(cell),
          parent: card.parentElement?.tagName ?? 'none',
        };
      });

    await row.locator('td[data-column="float"] [data-fact]').hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 400 });
    const hint = await typeOf();
    // The precondition that makes the claim about a **portalled** card: one
    // rendered inside its cell would inherit the type whatever this rule said,
    // and the assertion below would be true of the wrong thing.
    expect(hint.parent, 'the hint card is not portalled out of the table').toBe('BODY');
    expect(hint.card, "the portalled card's type").toBe(hint.cell);

    await page.mouse.move(0, 0);
    await page.getByLabel('Notes on 010').hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1500 });
    const preview = await typeOf();
    expect(preview.parent, 'the notes preview is no longer a child of its cell').not.toBe('BODY');
    expect(preview.card, "the in-cell card's type").toBe(preview.cell);
  });

  test('a project fact answers at once and never rings', async ({ page }) => {
    await aPlan(page);
    await page.getByRole('button', { name: 'Add work item' }).click();

    /*
      The End cell's answer for a row nobody has estimated, which is the
      plainest fact a fresh plan draws: four words about this row, in a cell
      showing a dash.

      **Named by its words and its column, not `td [data-fact]`.** Written as
      the first fact in a row, this case was watched **passing** with the mark's
      attribute turned back into a `data-hint`: the locator simply found the
      next mark that is still a fact — a fresh row carries four — and asserted
      the 400ms budget against a cell the fault had not touched. A test about
      one mark has to say which mark.

      It was the row's own number until `hint-press-cancels`, which stopped the
      `#` cell speaking for a number its column is not clipping. Dany,
      2026-09-01: "also remove tooltips from # cells; why it needed?"
    */
    const said = 'No estimate yet';
    const finish = page.locator(`td[data-column="finish"] [data-fact="${said}"]`);
    await expect(finish).toBeVisible();

    await finish.hover();

    /*
      **A tight budget, and it is the claim rather than a convenience.** The
      thing this replaced is a tooltip Chromium shows after about a second, and
      the thing beside it now waits three; a card asserted with Playwright's
      five-second default would be satisfied by either. 400ms is inside a hover
      the reader has not finished making and outside both.
    */
    // Proof: the End cell's `data-fact` changed back to `data-hint`, which is
    // this whole change applied to the wrong side of the split. Watched failing
    // **at the locator above**, not here — `Expect "toBeVisible" with timeout
    // 30000ms · waiting for locator('td[data-column="finish"]
    // [data-fact="No estimate yet"]')`. That is the fault
    // arriving one line earlier than expected and it is the right place for it:
    // the attribute is what says which kind of words a mark holds, so changing
    // it takes the mark out of this test's reach rather than making its card
    // late.
    const card = page.getByRole('tooltip');
    await expect(card).toBeVisible({ timeout: 400 });
    await expect(card).toHaveText(said);

    // And no ring, ever — read past the quiet, where one would be if this fact
    // had taken the tool path. Read before it, the assertion could not fail.
    await page.waitForTimeout(600);
    expect(await page.locator('[data-wait-ring]').count(), 'a fact drew a ring').toBe(0);
  });
});
