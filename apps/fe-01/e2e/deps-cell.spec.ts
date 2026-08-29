import { expect, type Locator, type Page, test } from '@playwright/test';

/** The painted colour of an element's own background, whatever notation it is in. */
const bgOf = (locator: Locator): Promise<string> =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor);

/** A background nothing painted — what Chromium answers for `background: none`. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/**
 * `deps-single-line`, measured by a browser.
 *
 * jsdom watches the declarations arrive on the strip (`wbs-table.test.tsx`:
 * the strip exists, it clips, the wrapper still positions the listbox).
 * Whether a seven-chip row really rests at a chipless row's height, and
 * whether a clipped chip really is invisible, are questions about layout and
 * hit testing — the exact fault class of R5 #14–16, where a green jsdom suite
 * sat over a behaviour only a browser performs. Both are answered here, in
 * Chromium, against a row with real area (#16's lesson: assert the area
 * before believing the invisibility).
 */

/**
 * Signs up a throwaway account and builds the deep-plan fixture's dependency
 * shape: nine root rows, `020` waiting for seven of them — enough chips that
 * a 110px column is overrun several times — and `030` waiting for nothing,
 * as the chipless row the height claim is measured against.
 */
async function seedSevenChips(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030', '040', '050', '060', '070', '080', '090']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // Seven siblings — no ancestor or descendant among them, so be-01 refuses
  // none and the chip count below is exact.
  const waitedFor = ['030', '040', '050', '060', '070', '080', '090'];
  const depends = page.getByLabel('Add a dependency to 020');
  await depends.click();
  await depends.fill(waitedFor.join(', '));
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: /^Stop 020 waiting for / })).toHaveCount(7);

  // At rest: the picker owns the cell while the box has the focus, and every
  // claim in this file is about the cell once it has been left.
  await page.getByLabel('Name of 010').click();
  await page.getByLabel('Name of 010').blur();
}

/**
 * Switches the palette the way a reader does: the account menu, and the answer
 * in it.
 *
 * `Escape` afterwards because choosing a palette deliberately leaves the menu
 * open — the page changing colour underneath it is the whole feedback — and an
 * open popover over the grid is a surface the measurements below would read by
 * accident. `theme-choice.tsx` has the reason it stays open;
 * `dark-mode.spec.ts` has the assertion that it does.
 */
async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitemradio', { name: answer })).toBeHidden();
  // The chrome carries `transition-colors`, so the flip is a ~150ms colour
  // animation on every surface at once and a read taken inside it answers with
  // an interpolated `oklab(…)` belonging to neither palette. Drained rather
  // than waited out: nothing in this app animates without end.
  // `dark-mode.spec.ts` has the measurement that made this necessary.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
}

let account = 0;

test.beforeEach(async ({ page }) => {
  account += 1;
  await seedSevenChips(page, `e2e-deps-${String(Date.now())}-${String(account)}`);
});

test.describe('the deps cell rests on one line', () => {
  test('rests the seven-chip row at a chipless row’s height', async ({ page }) => {
    const measured = await page.evaluate(() => {
      const rowOf = (number: string): HTMLTableRowElement => {
        const box = document.querySelector(`[aria-label="Add a dependency to ${number}"]`);
        const row = box?.closest('tr');
        if (!(row instanceof HTMLTableRowElement))
          throw new Error(`no row on screen for ${number}`);
        return row;
      };
      const strip = rowOf('020').querySelector('[data-depends-strip]');
      if (!(strip instanceof HTMLElement)) throw new Error('020 has no depends strip');
      // The chips by their own name, not every button in the cell: since
      // `dep-add-button` the strip also carries the add affordance, and a bare
      // `button` query would count it as an eighth chip.
      const chips = [
        ...rowOf('020').querySelectorAll<HTMLElement>(
          'td[data-column="depends"] button[aria-label^="Stop "]',
        ),
      ];
      return {
        chipBoxes: chips.map((chip) => {
          const box = chip.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        // The clip engaged for real: more strip content than strip.
        stripScrollWidth: strip.scrollWidth,
        stripClientWidth: strip.clientWidth,
        heavy: rowOf('020').getBoundingClientRect().height,
        chipless: rowOf('030').getBoundingClientRect().height,
      };
    });

    // Preconditions before the claim, or the equality below would hold for a
    // table that rendered no chips at all (R5 #16): seven chips, each laid
    // out with real area, and a strip that really is clipping.
    expect(measured.chipBoxes).toHaveLength(7);
    for (const [at, chip] of measured.chipBoxes.entries()) {
      expect(chip.width, `chip ${String(at)} has no width`).toBeGreaterThan(0);
      expect(chip.height, `chip ${String(at)} has no height`).toBeGreaterThan(0);
    }
    expect(
      measured.stripScrollWidth,
      'nothing is clipped, so this test is about an uncrowded cell',
    ).toBeGreaterThan(measured.stripClientWidth);

    // The claim: seven chips cost the row nothing. Within a pixel — rect
    // edges are sub-pixel.
    expect(
      Math.abs(measured.heavy - measured.chipless),
      `the seven-chip row is ${String(measured.heavy)}px where the chipless row is ${String(measured.chipless)}px`,
    ).toBeLessThanOrEqual(1);
  });

  test('a clipped chip is invisible at rest, and an unclipped one is not', async ({ page }) => {
    const probed = await page.evaluate(() => {
      const chipAt = (label: string): HTMLElement => {
        const chip = document.querySelector(`[aria-label="${label}"]`);
        if (!(chip instanceof HTMLElement)) throw new Error(`no chip on screen: ${label}`);
        return chip;
      };
      // Row 020's strip — reached from one of its own chips, never by a
      // document-wide query that would answer with the first row's.
      const strip = chipAt('Stop 020 waiting for 030').closest('[data-depends-strip]');
      // Hit-test one chip: what the page answers at its centre. `overflow:
      // hidden` clips hit testing along with paint, so this is what
      // distinguishes a chip somebody can see (and click) from one the strip
      // has clipped — `getBoundingClientRect` alone cannot, since a clipped
      // box still reports its full geometry.
      const probe = (label: string) => {
        const chip = chipAt(label);
        const box = chip.getBoundingClientRect();
        const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          width: box.width,
          height: box.height,
          left: box.left,
          answersToTheChip: at !== null && chip.contains(at),
          answered: at === null ? '(nothing)' : `<${at.tagName.toLowerCase()}>`,
        };
      };
      if (strip === null) throw new Error('no depends strip on the page');
      return {
        stripVisibleRight: strip.getBoundingClientRect().right,
        first: probe('Stop 020 waiting for 030'),
        last: probe('Stop 020 waiting for 090'),
      };
    });

    // The probe can see a chip at all — without this, "the last chip answers
    // to something else" would also be true of a page with no chips and of a
    // probe aimed wrong (R5 #16 again, and `D directory-page`'s lesson:
    // assert where the fault lives, with the probe proven live beside it).
    expect(probed.first.width).toBeGreaterThan(0);
    expect(probed.first.height).toBeGreaterThan(0);
    expect(
      probed.first.answersToTheChip,
      `the first chip's own centre answers ${probed.first.answered}`,
    ).toBe(true);

    // The last chip is laid out with real area — a zero-width chip would be
    // invisible for the wrong reason —
    expect(probed.last.width).toBeGreaterThan(0);
    expect(probed.last.height).toBeGreaterThan(0);
    // — stands wholly past the cell's visible edge —
    expect(
      probed.last.left,
      'the last chip is not even clipped, so this fixture stopped overrunning',
    ).toBeGreaterThanOrEqual(probed.stripVisibleRight - 1);
    // — and is invisible where it stands: the pixel at its centre belongs to
    // whatever the table put there instead.
    expect(
      probed.last.answersToTheChip,
      'a clipped chip still answered a hit test at its centre',
    ).toBe(false);
  });
});

/**
 * `dep-add-button`, measured by a browser.
 *
 * jsdom watches the button arrive at the head of the strip, focus the box on a
 * click, and cancel its own press (`wbs-table.test.tsx`). What it cannot watch
 * is any of the three reasons the button is shaped the way it is: whether the
 * head of a clipping line really escapes the clip, whether a real click really
 * lands the caret in the box, and whether a real press really leaves a
 * half-typed search alone — the last two being the exact fault class of R5
 * #12/#14/#15, where a green jsdom suite sat over a default action only a
 * browser performs.
 */
test.describe('the deps cell offers an always-visible add button', () => {
  test('keeps the add button visible in a cell whose chips are clipped', async ({ page }) => {
    const probed = await page.evaluate(() => {
      const at = (label: string): HTMLElement => {
        const found = document.querySelector(`[aria-label="${label}"]`);
        if (!(found instanceof HTMLElement)) throw new Error(`not on screen: ${label}`);
        return found;
      };
      const probe = (label: string) => {
        const node = at(label);
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          width: box.width,
          height: box.height,
          answersToItself: hit !== null && node.contains(hit),
          answered: hit === null ? '(nothing)' : `<${hit.tagName.toLowerCase()}>`,
        };
      };
      const strip = at('Stop 020 waiting for 030').closest('[data-depends-strip]');
      if (!(strip instanceof HTMLElement)) throw new Error('no depends strip on the page');
      return {
        // The clip is engaged: more strip content than strip. Without this the
        // whole test would be about an uncrowded cell, where nothing is at risk
        // and the button's placement decides nothing (R5 #16).
        stripScrollWidth: strip.scrollWidth,
        stripClientWidth: strip.clientWidth,
        add: probe('Make 020 wait for something'),
        chip: probe('Stop 020 waiting for 030'),
        lastChip: probe('Stop 020 waiting for 090'),
      };
    });

    expect(
      probed.stripScrollWidth,
      'nothing is clipped, so this test is about an uncrowded cell',
    ).toBeGreaterThan(probed.stripClientWidth);
    // And the clip really does hide what it overruns — the fact the button's
    // placement is chosen against, re-established here so the claim below is
    // read against a cell that is genuinely cutting things off.
    expect(
      probed.lastChip.answersToItself,
      'the last chip is not clipped, so this fixture stopped overrunning',
    ).toBe(false);

    // The claim: the affordance is laid out with real area and answers a hit
    // test at its own centre, in the crowded cell that clipped the chip above.
    expect(probed.add.width).toBeGreaterThan(0);
    expect(probed.add.height).toBeGreaterThan(0);
    expect(
      probed.add.answersToItself,
      `the add button's own centre answers ${probed.add.answered}`,
    ).toBe(true);

    // And it costs the strip's line nothing: no taller than the chips, which
    // are what set that line's height and so the row's. Sub-pixel tolerance,
    // rect edges being fractional.
    expect(probed.chip.height).toBeGreaterThan(0);
    expect(
      probed.add.height,
      `the add button is ${String(probed.add.height)}px where a chip is ${String(probed.chip.height)}px`,
    ).toBeLessThanOrEqual(probed.chip.height + 1);
  });

  test('opens the picker from the add button, with the caret in the box', async ({ page }) => {
    // 010 waits for nothing in this fixture and so has rows left to be offered
    // — 020 already waits for seven of the nine, and a cell with nothing to
    // offer opens no list at all (the same trap `layout.spec.ts` records).
    await page.getByRole('button', { name: 'Make 010 wait for something' }).click();

    await expect(page.getByRole('listbox')).toBeVisible();
    // The caret is where somebody can type, which is the whole point of the
    // affordance: it is not a second path to the picker, it is the first path
    // to the box.
    await expect(page.getByLabel('Add a dependency to 010')).toBeFocused();
  });

  test('keeps a half-typed search when the add button is pressed', async ({ page }) => {
    // The press must not move the focus. Without the `preventDefault` on it the
    // button takes the focus, the box blurs, and this cell's blur closes the
    // picker and drops what was typed into it — a control that means "search"
    // eating the search. jsdom can only see the cancel; this sees the effect.
    const box = page.getByLabel('Add a dependency to 010');
    await box.click();
    await box.fill('03');
    await expect(page.getByRole('listbox')).toBeVisible();

    await page.getByRole('button', { name: 'Make 010 wait for something' }).click();

    await expect(box).toHaveValue('03');
    await expect(box).toBeFocused();
    await expect(page.getByRole('listbox')).toBeVisible();
  });

  /**
   * Every rect this file needs off one row, in one round trip: the row itself,
   * the strip's two flex items, and the list hanging under them.
   */
  async function measure(page: Page, number: string) {
    return page.evaluate((n) => {
      const box = document.querySelector(`[aria-label="Add a dependency to ${n}"]`);
      const row = box?.closest('tr');
      if (!(row instanceof HTMLTableRowElement)) throw new Error(`no row on screen for ${n}`);
      const add = row.querySelector('button[data-dep-add]');
      const list = document.querySelector('[role="listbox"]');
      const rect = (el: Element | null | undefined) =>
        el instanceof HTMLElement ? el.getBoundingClientRect() : null;
      const r = (el: Element | null | undefined) => {
        const found = rect(el);
        // The middle as well as the top, because "on the same line" is a claim
        // about the middles: the strip is `align-items: center` and the box and
        // the `+` are different heights — 24.19px against 19.5px, measured on
        // h2puni once `spreadsheet-geometry` typed the grid's buttons — so
        // their tops differ by half that difference while sitting on one line,
        // and their centres do not differ at all.
        return found === null
          ? null
          : { top: found.top, height: found.height, middle: found.top + found.height / 2 };
      };
      return { row: r(row), add: r(add), box: r(box), list: r(list) };
    }, number);
  }

  test('rests an empty cell at its own height while the picker is open', async ({ page }) => {
    // The box claims `width: 100%`, so under `flex-wrap: wrap` its hypothetical
    // size is the whole strip and it can share a line with nothing — the `+`
    // beside it pushed it onto a second one, and a cell with no chips at all
    // grew by a line the moment somebody clicked into it, carrying the list
    // they had just opened down the page.
    //
    // Measured on dev at `2b2affec` in a cloud Chromium, 2026-08-11, before the
    // fix: row 030 **26px** at rest and **44.98px** open, the box dropping from
    // `y=198` to `y=219.98` and the listbox from `219` to `240.98`. Clicking
    // the cell and clicking the `+` measured the same, which is what made it
    // the strip's layout rather than the button's handler.
    //
    // jsdom watches the declaration that decides this (`wbs-table.test.tsx`,
    // `leaves an empty cell’s open strip on one nowrap line`); whether the row
    // is really one line tall is layout, and jsdom lays nothing out — R5
    // #14–16, the same reason the seven-chip claim above lives here.
    //
    // 010 waits for nothing in this fixture and has rows left to offer, so its
    // list really opens; 020 is the crowded row and is deliberately not it.
    const rest = await measure(page, '010');
    // Real area before the equality, or a table that rendered nothing would
    // satisfy it (R5 #16).
    expect(rest.row?.height, 'the rested row has no height to compare against').toBeGreaterThan(0);
    expect(rest.add?.height, 'no add button on the rested row').toBeGreaterThan(0);
    expect(rest.list, 'a listbox is open before anything was clicked').toBeNull();
    // At rest the two share one line, which is the state the open one must
    // hold. Centres, not tops — see the measurement above; the fault this
    // catches puts a whole line between them.
    expect(Math.abs((rest.box?.middle ?? 0) - (rest.add?.middle ?? 0))).toBeLessThanOrEqual(2);

    // Into the cell itself, not the `+`: the finding is about the click a
    // reader has always had, and the button's own path is checked below it.
    await page.getByLabel('Add a dependency to 010').click();
    await expect(page.getByRole('listbox')).toBeVisible();

    const open = await measure(page, '010');
    expect(open.list, 'the picker opened no list to measure').not.toBeNull();
    // The claim: the row is the height it was. Sub-pixel tolerance, rect edges
    // being fractional — the fault this catches was 19px.
    expect(
      Math.abs((open.row?.height ?? 0) - (rest.row?.height ?? 0)),
      `the open row is ${String(open.row?.height)}px where it rests at ${String(rest.row?.height)}px`,
    ).toBeLessThanOrEqual(1);
    // And it is one line because the box is still beside the `+`, not under it
    // — the row height above could also be held by a `+` that vanished.
    expect(
      Math.abs((open.box?.middle ?? 0) - (open.add?.middle ?? 0)),
      'the box wrapped under the add button',
    ).toBeLessThanOrEqual(2);
    expect(open.add?.height, 'the add button left the open cell').toBeGreaterThan(0);

    // The same, through the affordance's own click.
    await page.keyboard.press('Escape');
    await page.getByLabel('Name of 020').click();
    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: 'Make 010 wait for something' }).click();
    await expect(page.getByRole('listbox')).toBeVisible();

    const viaAdd = await measure(page, '010');
    expect(
      Math.abs((viaAdd.row?.height ?? 0) - (rest.row?.height ?? 0)),
      `the row opened from the + is ${String(viaAdd.row?.height)}px where it rests at ${String(rest.row?.height)}px`,
    ).toBeLessThanOrEqual(1);
    // The list is where the rested cell's bottom is, rather than a line below.
    expect(
      Math.abs((viaAdd.list?.top ?? 0) - (open.list?.top ?? 0)),
      'the two ways into the picker anchor its list differently',
    ).toBeLessThanOrEqual(1);
  });

  /**
   * The sRGB luminance of any colour the engine can parse, 0–255 — rasterised
   * rather than parsed, because a computed `color-mix` comes back as
   * `oklab(…)` and a resting grey as `rgb(…)`, and no string comparison
   * between the two notations answers "lighter or darker". `hover-cards.spec.ts`
   * carries the same helper and the incident that produced it (PR #38).
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

  test('picks the add button up off the row it is hovered on, in both palettes', async ({
    page,
  }) => {
    // The hover paint was `var(--accent)`, an absolute `oklch(0.968)`, and a
    // row under the pointer is `--grid-hover` at `oklch(0.939)`: on a light
    // page the patch came out *lighter* than the row it sits in, so the
    // affordance read as a hole punched through the row rather than as
    // something the pointer had picked up. Measured in a cloud Chromium on dev
    // at `2b2affec`, 2026-08-11: button `oklch(0.968 0.007 247.896)`, cell
    // `oklab(0.93903 …)`. Dark mode was right by accident, `--accent` being
    // `oklch(0.279)` above an `oklab(0.18885 …)` row — one absolute value
    // answering for two themes, and getting one of them.
    //
    // Both palettes, and it has to be both: light alone cannot tell "darker
    // than the row" from "an absolute colour that happens to be darker here",
    // and the direction is the whole claim. The app **ships a theme switch**
    // since `dark-mode`, and this walks it rather than putting the class on the
    // root by hand: a rule about what a reader sees is worth only as much as
    // the reader's own way of getting there, and a class set from
    // `page.evaluate` would keep passing on the day the control stopped
    // reaching it. `hover-cards.spec.ts` still toggles the class directly — it
    // measures a hover card that an open menu would take off the screen — and
    // says so where it does.
    const add = page.getByRole('button', { name: 'Make 010 wait for something' });
    const depsCell = page
      .getByLabel('Add a dependency to 010')
      .locator('xpath=ancestor::td[@data-column="depends"]');

    for (const palette of ['light', 'dark'] as const) {
      await chooseTheme(page, palette === 'dark' ? 'Dark' : 'Light');
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          ),
        )
        .toBe(palette);

      // The row under the pointer but not the affordance: the surface the
      // patch is judged against is the row's *hovered* colour, not its rest.
      await page.getByLabel('Name of 010').hover();
      await expect.poll(() => depsCell.evaluate((td) => td.getAnimations().length)).toBe(0);
      const rowColour = await bgOf(depsCell);
      // Nothing painted on the button yet, or the reads below would compare a
      // hover state with itself.
      expect(await bgOf(add), `${palette}: the add button is painted at rest`).toBe(TRANSPARENT);

      await add.hover();
      await expect.poll(() => bgOf(add)).not.toBe(TRANSPARENT);
      const buttonColour = await bgOf(add);
      // The row is the same colour it was: the pointer only moved within it,
      // so any difference below is the button's and not the row's.
      expect(await bgOf(depsCell), `${palette}: the row moved under the pointer`).toBe(rowColour);

      const rowLuminance = await luminance(page, rowColour);
      const buttonLuminance = await luminance(page, buttonColour);

      // Non-vacuous first: a patch that did not move cannot have moved the
      // right way, and `Math.sign(0)` agrees with everything.
      expect(
        Math.abs(buttonLuminance - rowLuminance),
        `${palette}: the hovered add button is the row's own colour`,
      ).toBeGreaterThan(1);

      // The claim: down on a light page, up on a dark one — the affordance
      // lifting off the row in whichever direction that row's own ink runs,
      // never toward the page behind it.
      expect(
        Math.sign(buttonLuminance - rowLuminance),
        `${palette}: the hovered add button is ${buttonLuminance > rowLuminance ? 'lighter' : 'darker'} (${String(Math.round(buttonLuminance))}) than the row it sits on (${String(Math.round(rowLuminance))})`,
      ).toBe(palette === 'light' ? -1 : 1);
    }
  });
});

test.describe('the cell answers the pointer that is in it', () => {
  /**
   * A row waiting for exactly two others, at the Depends on column's own
   * resolved width.
   *
   * Two rather than the fixture's seven, because two is the case the
   * 2026-08-14 cloud regression measured and the case a real plan is full of:
   * at 110px two pills, both gaps and the add button already fill the strip
   * edge to edge, and the box `deps-single-line` shrinks behind them is laid
   * out **outside its own cell**. Seven would prove the same thing and would
   * prove it about a cell nobody would call reasonable.
   */
  async function waitOnTwo(page: Page): Promise<void> {
    const depends = page.getByLabel('Add a dependency to 030');
    await depends.click();
    await depends.fill('040, 050');
    await depends.press('Enter');
    await expect(page.getByRole('button', { name: /^Stop 030 waiting for / })).toHaveCount(2);
    // Off the cell entirely: the picker owns the cell while the box has the
    // focus, and every claim below is about the cell at rest.
    await page.getByLabel('Name of 010').click();
    await page.getByLabel('Name of 010').blur();
  }

  /** The numbers of the rows lit right now, in table order. */
  const litRows = (page: Page): Promise<string[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll('tbody tr[data-dep-lit]')].map(
        (row) => row.querySelector('[data-number]')?.textContent ?? '(unnumbered)',
      ),
    );

  /**
   * Puts the pointer somewhere no Depends on cell is and waits for the table to
   * go dark.
   *
   * **Not tidiness — this is the whole of what makes the two tests below
   * non-vacuous.** Building the fixture drives a real pointer across the cell:
   * the picker is clicked, pills appear under it, and a pill's own `mouseleave`
   * widens the light back to the cell "because the pointer is still in the
   * cell". So the plan arrives at these tests already lit, and an assertion
   * made from there reads a light nothing in the test produced. Watched: with
   * the cell-level handler removed outright, `resting on the cell's own padding
   * lights nothing` **passed**, on a light left over from `fill()`.
   *
   * Asserting the dark state also asserts the leave, which is the other half of
   * the handler being where it should be.
   */
  async function pointerAwayFromTheTable(page: Page): Promise<void> {
    await page.mouse.move(4, 4);
    await expect
      .poll(() => litRows(page), {
        message: 'the plan is still lit with the pointer off the table',
      })
      .toEqual([]);
  }

  test('lights the whole set from a crowded cell at its default width', async ({ page }) => {
    // B4's gesture — "the pointer is in this cell" — in the state the manual
    // suite could not reach: the Depends on column at the width the table
    // resolves for it, with two pills on the strip.
    //
    // Only a browser can answer it, and that is not a formality here: whether a
    // point inside the cell is covered by a pill is a hit-testing fact, and
    // jsdom lays nothing out, so `wbs-table.test.tsx` can watch the handlers
    // arrive on the right element and can never watch a pill cover the place
    // they were supposed to answer from (R5 #14–16).
    //
    // Proof: the enter and the leave put back on the wrapper `<span>` inside
    // the cell — where they lived until this change — and this failed on
    // `the plan is still lit with the pointer off the table: - Expected - 1 /
    // + Received + 4`, at the reset above. Both halves of the move are on the
    // wrong element under that fault, and the **leave** is the one that shows
    // first: with the handlers inside the cell the light the fixture left
    // behind is never put out at all. Watched on h2puni, 2026-08-14 (fault
    // F3), and the same failure with the handler deleted outright (fault F0).
    //
    // It did **not** fail on the first writing of it, and `pointerAwayFromThe
    // Table` above is why: building the fixture leaves the cell lit, so every
    // assertion here read a light the test had not produced and the whole case
    // passed with the handler deleted altogether. R5's own lesson, one more
    // time — write the negative before you believe the line.
    await waitOnTwo(page);
    await pointerAwayFromTheTable(page);

    const cell = page.locator('tbody tr[data-row-id] td[data-column="depends"]').nth(2);
    const box = await cell.boundingBox();
    if (box === null) throw new Error('the 030 Depends on cell is not on screen');

    // The state this is a test about, established rather than assumed: the
    // pills really do cover the cell, and the box really is outside it. A
    // widened column would satisfy every assertion below while proving nothing.
    const crowded = await cell.evaluate((node) => {
      const strip = node.querySelector('[data-depends-strip]');
      const input = node.querySelector('[data-depends-input]');
      if (strip === null || input === null) throw new Error('no strip or box in the cell');
      const midline = node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2;
      const hit = document.elementFromPoint(
        node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2,
        midline,
      );
      return {
        boxLeft: input.getBoundingClientRect().left,
        cellRight: node.getBoundingClientRect().right,
        stripOverruns: strip.scrollWidth > strip.clientWidth,
        midpointAnswers:
          hit === null ? '(nothing)' : (hit.getAttribute('aria-label') ?? hit.tagName),
      };
    });
    expect(crowded.boxLeft, 'the box is still inside its own cell').toBeGreaterThan(
      crowded.cellRight,
    );
    expect(crowded.stripOverruns, 'the strip is not crowded, so this proves nothing').toBe(true);
    expect(crowded.midpointAnswers).toMatch(/^Stop 030 waiting for /);

    // The claim. The cell's own padding — 4px in from its left edge, which is
    // outside the wrapper the handlers used to sit on and inside the cell every
    // reader would point at.
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await expect
      .poll(() => litRows(page), {
        message: "resting on the cell's own padding lights nothing",
      })
      .toEqual(['040', '050']);

    // And the padding at the other end, which is the half the add button
    // cannot stand in for: the button is leading, so a pointer arriving from
    // the Prio column never crosses it.
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await expect
      .poll(() => litRows(page), { message: 'the trailing padding lights nothing' })
      .toEqual(['040', '050']);
  });

  test('narrows to one pill when the pointer settles on it, from the cell', async ({ page }) => {
    // The half the move must not have cost. `mouseenter` fires on every
    // element being entered, outermost first, so a pointer arriving straight
    // onto a pill runs the cell's handler and then the pill's — and the pill's
    // is the write that lands. Reasoning; this is the browser agreeing.
    //
    // Proof: the pill's own `onMouseEnter` deleted, this failed on the
    // `toEqual(['040'])` below with `- Expected - 0 / + Received + 1` — the
    // cell's whole set standing where the pill's one row should be, which is
    // the enter order reversing. Watched on h2puni, 2026-08-14 (fault F4).
    await waitOnTwo(page);
    await pointerAwayFromTheTable(page);

    await page.getByRole('button', { name: 'Stop 030 waiting for 040' }).hover();
    await expect.poll(() => litRows(page)).toEqual(['040']);

    // And leaving the pill for the cell widens it back, which is the pill's own
    // `mouseleave` still doing its job from inside a cell that now answers too.
    const cell = page.locator('tbody tr[data-row-id] td[data-column="depends"]').nth(2);
    const box = await cell.boundingBox();
    if (box === null) throw new Error('the 030 Depends on cell is not on screen');
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await expect.poll(() => litRows(page)).toEqual(['040', '050']);

    // Leaving the cell puts the rows back.
    await page.mouse.move(box.x - 40, box.y + box.height / 2);
    await expect.poll(() => litRows(page)).toEqual([]);
  });

  test('holds the card while the pointer crosses its padding over the row beneath', async ({
    page,
  }) => {
    // The card's padding is passive by the spec — a click through it reaches
    // the row beneath — and the bridge in `depends-card.tsx` is what keeps the
    // card open while the pointer crosses it. Chromium delivers that crossing
    // to the row beneath as a `mouseenter`, and when that row's own Depends on
    // cell has something to say, its handler took the card over: 020's list
    // became 030's on the way to it. Found in Chrome, 2026-08-29, where it read
    // as "the card closes for rows with fewer than three dependencies" — the
    // height at which the card happened to stop covering such a row.
    //
    // The fixture is the shape it needs: 020 waits for seven rows and 030,
    // the row directly beneath it, waits for two of its own.
    await waitOnTwo(page);
    await pointerAwayFromTheTable(page);

    const owner = page.locator('tbody tr[data-row-id] td[data-column="depends"]').nth(1);
    const ownerBox = await owner.boundingBox();
    if (ownerBox === null) throw new Error('the 020 Depends on cell is not on screen');
    // The cell's own leading padding rather than `hover()`'s centre, which may
    // land on a pill and emphasise a card line — an emphasised line grows into
    // the padding this test is about to measure.
    await page.mouse.move(ownerBox.x + 2, ownerBox.y + ownerBox.height / 2);
    const card = page.getByRole('tooltip', { name: 'What 020 waits for' });
    await expect(card).toBeVisible();
    const everything = ['030', '040', '050', '060', '070', '080', '090'];
    await expect.poll(() => litRows(page)).toEqual(everything);

    const cardBox = await card.boundingBox();
    const firstLine = card.locator('[data-depends-card-target]').first();
    const lineBox = await firstLine.boundingBox();
    const beneath = page.locator('tbody tr[data-row-id] td[data-column="depends"]').nth(2);
    const beneathBox = await beneath.boundingBox();
    if (cardBox === null || lineBox === null || beneathBox === null) {
      throw new Error('the card, its first line or the cell beneath is not on screen');
    }

    // The band this is about, established rather than assumed: card padding
    // above the first line, standing over the Depends on cell of the row
    // beneath. Without area here every assertion below is about a point that
    // does not exist. (Over that cell's *pills* the same band is under 1px —
    // measured at 0.9px — so the pill's own guard is proved in jsdom alone.)
    const bandTop = Math.max(cardBox.y, beneathBox.y);
    const bandBottom = lineBox.y;
    expect(bandBottom - bandTop, 'no card padding stands over the cell beneath').toBeGreaterThan(1);
    const point = { x: beneathBox.x + beneathBox.width / 2, y: (bandTop + bandBottom) / 2 };

    // And it really is passive there — the spec's other half. The hit is the
    // cell beneath, not the card.
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('td')
            ?.querySelector('[data-depends-input]')
            ?.getAttribute('aria-label'),
        point,
      ),
    ).toBe('Add a dependency to 030');

    // The claim. Read straight after the move rather than polled: the enter is
    // handled before `mouse.move` resolves, and a poll for the unchanged state
    // would pass on the instant before the takeover.
    await page.mouse.move(point.x, point.y);
    expect(await litRows(page), 'the row beneath took the hover').toEqual(everything);
    await expect(card).toBeVisible();
    await expect(page.getByRole('tooltip', { name: 'What 030 waits for' })).toHaveCount(0);

    // On to the line itself, which narrows the light to the one row it names.
    await page.mouse.move(point.x, lineBox.y + lineBox.height / 2);
    await expect.poll(() => litRows(page)).toEqual(['030']);
    await expect(card).toBeVisible();
  });
});
