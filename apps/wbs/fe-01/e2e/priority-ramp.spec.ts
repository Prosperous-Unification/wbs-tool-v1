import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';
import { measureInk, NEUTRAL_CHROMA } from './measure-ink';

/**
 * The diverging priority ramp, measured by a browser in both palettes.
 *
 * `priority-band-style.test.ts` measures the **table**: five literals in one
 * array, parsed back into three numbers each. That is the right oracle for the
 * chroma margin and the wrong one for everything else, because jsdom computes no
 * colours at all — it cannot say that Chromium parses `oklch(0.59 0.06 240)`,
 * that the Prio cell's inline `color` survives the cascade, or that the ink
 * stands off the surface behind it in the palette the reader is in. Those are
 * facts about a rendering engine, and R5 #14/#15/#17 are three separate days
 * this repo shipped a jsdom green over a browser fault.
 *
 * Everything below is read through a canvas rather than off the string
 * `getComputedStyle` answers with, for `dark-mode.spec.ts`' reason: a colour
 * this engine will not parse leaves `fillStyle` where it was, so the sentinel is
 * what makes an unparsed colour loud instead of silently measuring the last one
 * again. It also makes the assertions independent of how Chromium chooses to
 * serialise a modern colour function.
 *
 * `openspec/changes/priority-default-medium/` — design.md D3, tasks 4.1.
 */

/** The rungs under test, as the default ladder's own default values. */
const ORDINARY = 50;
const LOW = 70;
const LOWEST = 90;

/** The row numbers the three rungs are typed onto, in order. */
const ROWS = ['010', '020', '030'] as const;

/**
 * The smallest chroma gap that still reads as two steps of one hue.
 *
 * The same number `priority-band-style.test.ts` holds, and stated rather than
 * measured off the table for the same reason: a margin read from the very values
 * under test is satisfied by any two numbers at all. The table's own gap is
 * 0.06, so an 8-bit round trip through a canvas has room to lose a thousandth
 * without this becoming flaky.
 */
const LEAST_CHROMA_STEP = 0.05;

/**
 * What the Prio chip is held to, and why it is 3 rather than 4.5.
 *
 * The cell renders its band at `font-weight: 600` (`priority-cell.tsx`), which is
 * WCAG's large-text case, and 3:1 is what that asks. A number chosen because it
 * is the standard for what is actually on screen, not because it is the number
 * these inks happen to clear.
 */
const READABLE = 3;

/** Opens the fixed local identity and makes a plan of three named rows. */
async function seedPlan(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  // Through the shared fixture and not the `+` directly: a create arms a
  // rename on the bar and that arming lands one round trip *after* the table
  // appears, so a fixture that clicks on into the plan can have the keyboard
  // pulled back to the header mid-flight. `create-project.ts` says the whole
  // of it. This file was written the day before that fixture existed and was
  // the one create site `d2024a3` did not reach.
  await createProject(page);
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ROWS) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  for (const [at, number] of ROWS.entries()) {
    const name = page.getByLabel(`Name of ${number}`);
    await name.fill(`Rung ${String(at)}`);
    await name.blur();
  }
}

/**
 * Types one priority into a row's Prio cell and waits for the **band** to land.
 *
 * The value and the paint are two different events, and waiting for the first
 * is how this spec produced a red that meant nothing. `toHaveValue` reads the
 * box's own draft, which Enter leaves in place immediately; the colour comes
 * from `priorityBandStyleOf` on the priority the **server** answered with, one
 * round trip later. Between the two the cell is an unprioritised cell — no
 * `color`, no weight, the table's own ink — and three cells measured in that
 * window are three copies of one colour.
 *
 * That is not hypothetical. On 2026-08-30, at a load average of 555 with three
 * browser gates sharing the machine, both palettes failed on
 * `expected 0 to be greater than or equal to 0.05` — the **exact** red this
 * spec's injected fault produces, with the colour table perfectly correct. The
 * assertion could not tell "these two ranks are the same colour" from "neither
 * rank has a colour yet", so its red was ambiguous and its green was luck.
 *
 * The signal is the cell's **`title`**, and picking it took two goes.
 * `font-weight` was the first answer — `priority-cell.tsx` sets 600 from
 * `paint !== null` alone — and it is a check that cannot fail *because of this
 * very change*: a created work item now carries the ladder's rank 2 default, so
 * every row is painted a band from birth and 600 is already there before
 * anything is typed. Watched: with the write held 3s and this wait in place,
 * both palettes still failed, in 1.6s, having waited for nothing.
 *
 * `title` is built from `paint.words`, which is `${label} — priority ${n}` off
 * the **stored** number, so it says which priority landed rather than that some
 * priority did. It is not a colour, so waiting on it is not waiting for the
 * answer the assertions below measure.
 */
async function setPriority(page: Page, number: string, priority: number): Promise<void> {
  const cell = page.getByLabel(`Priority for ${number}`);
  await cell.fill(String(priority));
  await cell.press('Enter');
  await expect(cell).toHaveValue(String(priority));
  // Proof: this line deleted, the spec run with `POST …/commands` held 3s by a
  // `page.route` handler, failed on `expected 0 to be greater than or equal to
  // 0.05` in both palettes — the load-average-555 red of 2026-08-30 reproduced
  // on an idle machine, with the colour table untouched. With the line in place
  // the same delayed run passes.
  await expect(
    cell,
    `the ${String(priority)} chip on ${number} never took its band's paint`,
  ).toHaveAttribute('data-fact', new RegExp(`priority ${String(priority)}\\.`));
}

/** The one button in the header that opens the account menu — `dark-mode.spec.ts`' locator. */
const accountTrigger = (page: Page): Locator => page.locator('header button[aria-haspopup="menu"]');

/**
 * Waits for the palette flip's colour transitions to finish interpolating.
 *
 * `dark-mode.spec.ts`' `settled`, and the reason is quoted there in full: a
 * `getComputedStyle` read taken inside the ~150ms transition answers with an
 * interpolated colour neither palette names, and a finished `CSSTransition` is
 * never dropped from `getAnimations()` for a subtree Chromium has stopped
 * recalculating — so the two states that do not count are named rather than the
 * two that do.
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

/** Opens the account menu, takes the palette asked for, and lets the paint land. */
async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await accountTrigger(page).click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await settled(page);
}

/** The rung glyph drawn in one row's Prio cell — `priority-chevron.tsx`. */
const glyphOf = (page: Page, number: string): Locator =>
  page
    .locator('tbody tr')
    .filter({ has: page.getByLabel(`Name of ${number}`) })
    .locator('[data-priority-glyph]');

test.describe('the rung glyph, in a browser', () => {
  test('is drawn beside the number and does not swallow the cell’s click', async ({ page }) => {
    await seedPlan(page);
    await setPriority(page, ROWS[0], ORDINARY);
    await settled(page);

    const glyph = glyphOf(page, ROWS[0]);
    await expect(glyph, 'the prioritised row drew no rung glyph').toHaveAttribute(
      'data-priority-glyph',
      'level',
    );

    // **Measured before it is clicked, and this is what stops the case being
    // vacuous.** With the glyph deleted outright a click at these coordinates
    // still lands on the input underneath and the list still opens — so the
    // assertion that follows would pass with nothing drawn at all. The box is
    // asserted to be the 8×8 the component says it is *first*, and the click is
    // then aimed at its own centre.
    const box = await glyph.boundingBox();
    if (box === null) throw new Error('the rung glyph has no box to click in');
    expect(box.width, 'the rung glyph is not 8px wide').toBe(8);
    expect(box.height, 'the rung glyph is not 8px tall').toBe(8);

    // Proof: `pointerEvents: 'none'` deleted from the glyph's style, watched
    // failing on `a click on the glyph did not reach the cell underneath it ·
    // expect(locator).toBeVisible() failed · Expected: visible · Error:
    // element(s) not found` — the glyph swallowed the press and no list opened,
    // which is the fault exactly. `page.mouse.click` is used rather than
    // `locator.click` on purpose: a locator click would refuse with
    // Playwright's own "intercepts pointer events" and never dispatch, and what
    // this case is about is what a **reader's** press does to the cell. jsdom
    // performs no hit-testing at all and can see none of it (R5 #14/#15/#18).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(
      page.getByRole('listbox', { name: `Priority bands for ${ROWS[0]}` }),
      'a click on the glyph did not reach the cell underneath it',
    ).toBeVisible();
  });

  test('shares the 40px column with the widest priority anybody can type', async ({ page }) => {
    await seedPlan(page);
    // Three digits, which is what `table-frame.ts` says the column holds since
    // 2026-09-13 — "`999` beside the glyph is what 32px of room holds, `9999`
    // clips" — and the glyph takes 8 of those pixels. It was four digits in
    // 48px until Dany asked for the column smaller. A two-digit probe would be
    // the easy fault to inject rather than the one this is about
    // (`estimate-triple-visible`: inject the fault the check is about).
    const cell = page.getByLabel(`Priority for ${ROWS[0]}`);
    await cell.fill('999');
    await cell.press('Enter');
    await expect(cell).toHaveValue('999');
    await settled(page);

    // The column did not grow to pay for the glyph. Dany's compaction of
    // 2026-08-08 is the non-goal this holds up.
    const column = page
      .locator('tbody tr')
      .filter({ has: page.getByLabel(`Name of ${ROWS[0]}`) })
      .locator('td[data-column="priority"]');
    const cellBox = await column.boundingBox();
    if (cellBox === null) throw new Error('the Prio cell has no box to measure');
    expect(cellBox.width, 'the Prio column grew').toBe(40);

    // And the digits are not clipped inside it. `scrollWidth` against
    // `clientWidth` is what an over-full input answers with — the box's own
    // measurement, taken in the layout the reader is in.
    //
    // **This check found a real fault the day it was written**, which is why it
    // is here rather than in jsdom. The glyph shipped with a 2px gap beside it —
    // 10px off the leading edge — and this failed on `the widest priority is
    // clipped by its own cell · Expected: <= 0 · Received: 1`. The column does
    // not grow to pay for a glyph, so the gap went: see
    // `PRIORITY_GLYPH_ROOM_PX`, whose whole JSDoc is this measurement.
    //
    // Proof: that 2px gap put back, watched failing on the line below with
    // `Received: 1`. The budget has one pixel of slack at the shipped width, so
    // it is a live constraint rather than a comfortable one — which is exactly
    // the case worth a browser.
    const overflow = await cell.evaluate((node) => {
      if (!(node instanceof HTMLInputElement)) throw new Error('that is not the Prio box');
      return node.scrollWidth - node.clientWidth;
    });
    expect(overflow, 'the widest priority is clipped by its own cell').toBeLessThanOrEqual(0);
  });

  test('leaves an unprioritised row’s cell blank', async ({ page }) => {
    await seedPlan(page);
    // A created row carries the ladder's rank 2 default since
    // `priority-default-medium`, so the blank state is reached by clearing —
    // not by looking at a fresh row, which is where this case was first written
    // and which would have measured a glyph that was there.
    const cell = page.getByLabel(`Priority for ${ROWS[0]}`);
    await cell.fill('');
    await cell.press('Enter');
    await expect(cell).toHaveValue('');
    await settled(page);

    // Proof: `paint !== null &&` dropped from the cell's render — the glyph given
    // `paint?.rank ?? 0` instead — watched failing on
    // `expect(locator).toHaveCount(expected) failed · Expected: 0 · Received: 1`.
    // Every unprioritised row in the plan grows rank 0's double chevron, which
    // reads as `Critical` on a row nobody has said anything about.
    await expect(glyphOf(page, ROWS[0])).toHaveCount(0);
  });
});

test.describe('the priority ramp, in a browser', () => {
  for (const palette of ['Light', 'Dark'] as const) {
    test(`diverges around the middle rung in the ${palette.toLowerCase()} palette`, async ({
      page,
    }) => {
      await seedPlan(page);
      await chooseTheme(page, palette);
      await setPriority(page, ROWS[0], ORDINARY);
      await setPriority(page, ROWS[1], LOW);
      await setPriority(page, ROWS[2], LOWEST);
      await settled(page);

      const ordinary = await measureInk(page.getByLabel(`Priority for ${ROWS[0]}`));
      const low = await measureInk(page.getByLabel(`Priority for ${ROWS[1]}`));
      const lowest = await measureInk(page.getByLabel(`Priority for ${ROWS[2]}`));

      // The middle rung is the commonest value on any screen now that a create
      // stamps it, and it must not carry a hue anybody can name.
      expect(ordinary.chroma).toBeLessThan(NEUTRAL_CHROMA);

      // **Each cool rung carries a hue of its own, said before the two are
      // compared.** A margin is a difference, and a difference of zero has two
      // causes: the ramp collapsed, or nothing was painted at all. The second
      // is what a contended machine produces, and the line below cannot tell
      // the two apart — so the ambiguity is removed here rather than left in
      // the message. `setPriority` now waits for the paint, which is the fix;
      // this is the assertion that says so out loud if that wait ever stops
      // working. Both cool inks carry more chroma than the neutral rung by
      // construction (0.06 and 0.12 against 0.02), so the floor they are held
      // to is the one the middle rung is held under.
      expect(low.chroma, 'the Low rung was never painted its band').toBeGreaterThan(NEUTRAL_CHROMA);
      expect(lowest.chroma, 'the Lowest rung was never painted its band').toBeGreaterThan(
        NEUTRAL_CHROMA,
      );

      // Proof: ranks 3 and 4 in `BAND_INKS` set to one value, watched failing on
      // this line in both palettes. A `toBeDefined`-shaped assertion on either
      // ink could not see it, and neither could an equality against a serialised
      // string — the two cells would simply hold the same legal colour.
      expect(lowest.chroma - low.chroma).toBeGreaterThanOrEqual(LEAST_CHROMA_STEP);
      // One cool hue, and the same one. A generous window because an 8-bit
      // round trip moves a low-chroma hue further than a high-chroma one.
      expect(Math.abs(low.hue - lowest.hue)).toBeLessThan(8);
      // One lightness band: they are two steps of chroma, not a ramp that also
      // gets darker and says "less important" twice.
      expect(Math.abs(low.lightness - lowest.lightness)).toBeLessThan(0.03);

      // And all three are legible against the surface they are actually on,
      // which is the whole reason this is measured here and not in jsdom.
      for (const measured of [ordinary, low, lowest]) {
        expect(measured.contrast).toBeGreaterThanOrEqual(READABLE);
      }
    });
  }
});
