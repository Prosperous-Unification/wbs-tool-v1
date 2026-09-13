import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * A name's markdown, in a browser.
 *
 * **Every assertion here is one jsdom cannot make**, and that is the whole
 * reason this file exists rather than another `describe` in
 * `wbs-table.test.tsx`. Three of this repository's recorded checks-that-cannot-
 * fail were unit tests standing over a browser's fault (`AGENTS.md`, R5
 * #14/#15, `M mobile-cards`, `T2 compact-columns`), and this change has the
 * same shape twice over:
 *
 * - **jsdom computes no layout.** A `p` margin, a `pre` block or a wrapped
 *   `<h1>` costs it nothing, so every DOM assertion about a name's markdown
 *   passes straight through the fault D3 is about.
 * - **jsdom applies no stylesheet.** The swap between the two boxes of a Name
 *   cell — the textarea's ink transparent at rest, the rendered box gone on
 *   focus — is two rules in `styles.css` and nothing else. A unit test can see
 *   the attribute they hang off and can never see the swap.
 *
 * The rendered box is deliberately out of the flow (`position: absolute`), so
 * "a row's height never moves" is true by **construction** rather than by
 * measurement. That makes the row-height assertion here the weaker half of the
 * claim, and it is written down as such: the load-bearing measurement is the
 * **rendered box's own height**, which does move when the block allowlist goes.
 */

/** The four names the height claim is made over, and what each of them is for. */
const NAMES = {
  /** A name with no markdown in it at all: the height every other row is held to. */
  plain: 'Strip the wiring',
  /** The inline grammar, which renders — and must still be one line high. */
  inline: '**bold** and *italic*',
  /** A heading marker, which must render as the characters it is. */
  heading: '# heading',
  /** A list marker, the other half of D3's block case. */
  list: '- list',
  /**
   * A link whose source is far longer than its reading, which is the whole of
   * the row-height claim below. Dany's own, from `010.1.1` on 2026-08-30.
   *
   * **The reading was shortened on 2026-08-31, and that makes the check
   * stronger rather than weaker.** It read `hey hey hey The San Juan Mountains
   * are beautiful` — 47 drawn characters, which at the Name column's own width
   * sits about 6px from wrapping, so the row-height case became a canary for
   * every change to any *other* column's width: it went red when `depends` was
   * left alone and the Name column lost 17px, on the same 42px this test's own
   * negative is watched by. The claim was never about that. It is "the row is
   * as tall as its **reading**, not its source", and the way to say it is a
   * reading that cannot wrap beside a source that must: 7 characters drawn,
   * 107 of source.
   *
   * **62 of source until 2026-09-13**, when the day's column compaction gave
   * the Name column 51px more and the precondition guard below fired on CI —
   * `the source of this name fits one line, so there is no fault to fix`. The
   * URL grew a query string: 107 characters wrap at every width up to the
   * Name cap (`FLEXIBLE_CAP`, 420px), so the case is no longer a canary for
   * the other columns' widths, which was never what it was about.
   */
  link: '**hey** [SJM](https://en.wikipedia.org/wiki/San_Juan_Mountains?section=Geography_and_geology&oldid=1234567890)',
} as const;

/** The four rows, in the order they are made. */
const NUMBERS = ['010', '020', '030', '040'] as const;

/**
 * Signs up a throwaway account and makes a plan of `rows` empty work items.
 *
 * Through the UI, like the other browser gates: the boxes being measured are
 * ones somebody has typed into, sized by the same render path a real session
 * takes.
 */
async function seedRows(page: Page, rows: number): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (let made = 1; made <= rows; made += 1) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${String(made * 10).padStart(3, '0')}`)).toBeVisible();
  }
}

/** Types `text` into a Name cell and leaves it, which is what saves it. */
async function writeInto(cell: Locator, text: string): Promise<void> {
  await cell.fill(text);
  await cell.blur();
}

/**
 * The rendered reading of one Name cell — the box a reader actually sees.
 *
 * Found through the row's own id rather than by position: the two boxes carry
 * the same cell key, which is the one identity the grid and this file can agree
 * on (`cell-input.tsx`).
 */
async function renderedNameOf(page: Page, number: string): Promise<Locator> {
  const rowId = await page.getByLabel(`Name of ${number}`).getAttribute('data-name-input');
  expect(rowId, `the Name cell of ${number} carries no work item id`).not.toBeNull();
  return page.locator(`[data-cell-rendered="${rowId ?? ''}::name"]`);
}

/** Puts the page in one palette, the way `hover-cards.spec.ts` does. */
const wearPalette = (page: Page, palette: 'light' | 'dark'): Promise<void> =>
  page.evaluate((wanted) => {
    document.documentElement.classList.toggle('dark', wanted === 'dark');
  }, palette);

/** The height of a box that must be on screen, refusing a measurement of nothing. */
async function heightOf(box: Locator, what: string): Promise<number> {
  const measured = await box.boundingBox();
  expect(measured, `${what} is not on screen to be measured`).not.toBeNull();
  expect(measured?.height ?? 0, `${what} has no height at all`).toBeGreaterThan(0);
  return measured?.height ?? 0;
}

/** The metrics that decide whether the drawn text sits over the typed text. */
const boxMetrics = (node: Element) => {
  const style = getComputedStyle(node);
  return {
    paddingLeft: style.paddingLeft,
    paddingTop: style.paddingTop,
    borderLeftWidth: style.borderLeftWidth,
    borderTopWidth: style.borderTopWidth,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
  };
};

test.describe('a name of block markdown does not grow what it is drawn in', () => {
  for (const palette of ['light', 'dark'] as const) {
    test(`four rows, four names, one height — in ${palette}`, async ({ page }) => {
      await seedRows(page, NUMBERS.length);
      await wearPalette(page, palette);

      await writeInto(page.getByLabel('Name of 010'), NAMES.plain);
      await writeInto(page.getByLabel('Name of 020'), NAMES.inline);
      await writeInto(page.getByLabel('Name of 030'), NAMES.heading);
      await writeInto(page.getByLabel('Name of 040'), NAMES.list);

      // The precondition, and it is not a formality: a run where the markdown
      // never rendered would compare four identical plain rows and pass.
      await expect(page.locator('[data-cell-rendered] strong')).toHaveText('bold');
      await expect(page.locator('[data-cell-rendered] em')).toHaveText('italic');
      await expect(await renderedNameOf(page, '030')).toHaveText(NAMES.heading);
      await expect(await renderedNameOf(page, '040')).toHaveText(NAMES.list);

      // **The load-bearing measurement.** The rendered box is out of the flow,
      // so a block box inside it grows *it* and not the row: with the block
      // allowlist removed, `# heading` renders an `<h1>` whose margins and 2em
      // type stand well clear of one line of a 13px cell.
      const drawn: number[] = [];
      for (const number of NUMBERS) {
        drawn.push(await heightOf(await renderedNameOf(page, number), `the name of ${number}`));
      }
      for (const [at, height] of drawn.entries()) {
        expect(
          height,
          `${palette}: the rendered name of ${NUMBERS[at] ?? ''} is not one line high`,
        ).toBeCloseTo(drawn[0] ?? 0, 0);
      }

      // And the row itself, which is what a reader sees move. Weaker than the
      // measurement above **by construction** — the rendered box is absolutely
      // positioned, so nothing inside it can push a row — and here because that
      // is the requirement's own words, and because the day somebody puts the
      // rendered box back in the flow this is the assertion that notices.
      const rows: number[] = [];
      for (const number of NUMBERS) {
        rows.push(
          await heightOf(
            page.getByLabel(`Name of ${number}`).locator('xpath=ancestor::tr[1]'),
            `row ${number}`,
          ),
        );
      }
      for (const [at, height] of rows.entries()) {
        expect(height, `${palette}: row ${NUMBERS[at] ?? ''} is not the height of the first`).toBe(
          rows[0],
        );
      }
    });
  }
});

test.describe('the Name cell shows one of its two boxes at a time', () => {
  test('the rendered reading at rest, the source the moment it is written in', async ({ page }) => {
    await seedRows(page, 1);

    const box = page.getByLabel('Name of 010');
    await writeInto(box, NAMES.inline);
    const rendered = await renderedNameOf(page, '010');

    // At rest: the drawn box is on screen and the box under it has no ink of
    // its own, so the asterisks are not read twice.
    await expect(rendered).toBeVisible();
    expect(
      await box.evaluate((node) => getComputedStyle(node).color),
      'the source is still inked under the rendered name',
    ).toBe('rgba(0, 0, 0, 0)');

    // Written in: the drawn box is gone and the source is back, ink and all.
    await box.click();
    await expect(rendered).toBeHidden();
    expect(await box.inputValue(), 'the box holds something other than the source').toBe(
      NAMES.inline,
    );
    expect(
      await box.evaluate((node) => getComputedStyle(node).color),
      'the source somebody is typing is still invisible',
    ).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('the drawn text sits exactly where the typed text sits', async ({ page }) => {
    await seedRows(page, 1);

    const box = page.getByLabel('Name of 010');
    await writeInto(box, NAMES.plain);
    const rendered = await renderedNameOf(page, '010');

    // One spelling, two boxes: the rendered box takes the user agent's own
    // `<textarea>` metrics from `[data-cell-rendered]` in `styles.css`, and a
    // caller that gives its box a padding of its own puts the same class on
    // both. A mismatch here is a name that jumps sideways when it is clicked.
    expect(await rendered.evaluate(boxMetrics)).toEqual(await box.evaluate(boxMetrics));
  });

  test('a link in a name is followed by ⌘-click, and edited by a plain one', async ({ page }) => {
    // **This test has been rewritten twice in two days, and both turns are
    // worth keeping.** A link in the grid was a `<span>` — not followable at
    // all — on the reasoning that the cell's own click opens the editor. Dany
    // reversed that on 2026-08-30 ("make the links in markdown of the workitem
    // clickable"), and then, having used it, asked for the middle position on
    // 2026-08-31: _"clicking the links in the markdown - make it so that it is
    // only clickable for cmd + click"_.
    //
    // So a name is a field first and a document second: the plain click, which
    // somebody makes dozens of times an hour, opens the editor, and the
    // deliberate modified click follows the link. The tab half has never moved
    // and is asserted beside both, so the three cannot drift apart.
    await seedRows(page, 1);

    const box = page.getByLabel('Name of 010');
    await writeInto(box, 'see [the plan](http://example.test/plan)');

    const drawn = await renderedNameOf(page, '010');
    const link = drawn.locator('[data-name-link]');
    await expect(link).toHaveText('the plan');
    await expect(link).toHaveAttribute('href', 'http://example.test/plan');
    await expect(link).toHaveAttribute('target', '_blank');
    // `noopener` beside `noreferrer`, which is what `external-refs` writes down
    // as the rule for a followable external link.
    await expect(link).toHaveAttribute('rel', 'noreferrer noopener');

    // **Not a tab stop.** The grid's tab order is a matrix of cells and a link
    // somebody typed is not one of them, so Tab from the name goes to the next
    // column rather than into the anchor inside it.
    await expect(link).toHaveAttribute('tabindex', '-1');
    await box.focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-name-link') !== null),
      'Tab out of the name landed on the link inside it',
    ).toBe(false);

    // **The box still owns every pixel but the link's.** A real click through
    // `page.mouse` rather than `drawn.click()`: Playwright's actionability
    // check is itself hit-testing, which is the claim, and `force: true` would
    // bypass the very thing being proved.
    const whole = await drawn.boundingBox();
    if (whole === null) throw new Error('the rendered name has no box to click');
    await page.mouse.click(whole.x + whole.width - 2, whole.y + whole.height / 2);
    await expect(box, 'a click past the link did not reach the editor').toBeFocused();
    await box.blur();

    // **A plain click on the link's own pixels opens the editor too**, which is
    // the whole of the 2026-08-31 change and the half easiest to lose: the
    // anchor takes the pointer, so cancelling its navigation without handing
    // the click on would leave the commonest gesture in the grid doing nothing
    // at all.
    const at = await link.boundingBox();
    if (at === null) throw new Error('the link has no box to click');
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(box, 'a plain click on the link did not open the editor').toBeFocused();
    await box.blur();
    await expect(drawn).toBeVisible();

    // **And the modified click is left alone**, which is the one thing this
    // change controls: the handler returns without `preventDefault` when a
    // modifier is held, so the browser performs the anchor's own default and
    // the editor does **not** take the focus.
    //
    // **Nothing here waits for the tab.** Three shapes were tried and all three
    // were about Chromium's scheduling rather than about this code:
    // `page.waitForEvent('popup')` timed out (a modified click opens a
    // background tab, not a popup); `followed.waitForURL(…)` timed out (the tab
    // is created before it loads); and reading `followed.url()` straight after
    // the event gave `""`. `context().waitForEvent('page')` did pass — and then
    // timed out at 60s in the **full** gate under parallel load, twice, while
    // passing 3/3 alone. A check that only holds when the machine is quiet is
    // not a check.
    //
    // Where the tab would go is already pinned by the `href`, `target` and
    // `rel` assertions above, which are the attributes the browser acts on.
    // What is left is exactly the boundary this code owns, and the negative
    // still bites through it: with the modifier guard removed the plain-click
    // path runs, `openEditorUnder` focuses the box, and the assertion below
    // fails.
    //
    // `ControlOrMeta`, so this reads the same on the Mac it was written on and
    // on CI's Linux.
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await page.keyboard.up('ControlOrMeta');
    await expect(box, 'a modified click opened the editor as well').not.toBeFocused();
  });

  test('a javascript: URL in a name is not a link at all', async ({ page }) => {
    // The rule `external-refs` 5.3 names, made load-bearing the day a name's
    // links became followable: a scheme that is not `http`/`https` renders as
    // text with no `href`, so a name somebody else typed cannot run script by
    // being clicked. `react-markdown`'s own `urlTransform` is what refuses it,
    // and this is the assertion that says so on the production path rather
    // than in its changelog.
    await seedRows(page, 1);

    const box = page.getByLabel('Name of 010');
    await writeInto(box, 'see [the plan](javascript:alert(1))');

    const drawn = await renderedNameOf(page, '010');
    const link = drawn.locator('[data-name-link]');
    await expect(link).toHaveText('the plan');
    expect(
      await link.getAttribute('href'),
      'a javascript: URL was written into the href of a name',
    ).not.toContain('javascript:');
  });
});

test.describe('a row is as tall as the name it shows', () => {
  test('a link whose source outruns its reading does not grow the row', async ({ page }) => {
    // Dany, 2026-08-30, on row `010.1.1`: "the row is expanded when the
    // rendered markdown does not need this expansion; it expands because the
    // orig text md version needs this expansion not the renderd one".
    //
    // The Name cell is two boxes and only one of them is in the flow: the
    // `<textarea>` holding the **source**. It auto-sizes to its own
    // `scrollHeight`, so a link whose source is twice its reading wrapped the
    // box and took the row with it, while the drawn box beside it was one
    // short line. **Only a browser can see this** — jsdom wraps nothing and
    // measures every box at 0 (`AGENTS.md`, R5 #14/#15).
    await seedRows(page, 2);

    // The plain row first, and it is the control: whatever a row of one line
    // is at this width, both of these must be it.
    await writeInto(page.getByLabel('Name of 010'), NAMES.plain);
    await writeInto(page.getByLabel('Name of 020'), NAMES.link);

    // The reading is on screen before anything is measured, or a run where the
    // markdown never rendered would compare two plain rows and pass.
    const drawn = await renderedNameOf(page, '020');
    await expect(drawn.locator('[data-name-link]')).toHaveText('SJM');
    await expect(drawn.locator('strong')).toHaveText('hey');

    const rowOf = (number: string) =>
      page.getByLabel(`Name of ${number}`).locator('xpath=ancestor::tr[1]');
    const plain = await heightOf(rowOf('010'), 'the row of a plain name');
    const linked = await heightOf(rowOf('020'), 'the row of a linked name');

    // The source really is longer than the reading, or the two rows would be
    // the same height for a reason that has nothing to do with the fix. This
    // is the precondition the fault needs to exist at all.
    const source = await page.getByLabel('Name of 020').evaluate((node) => {
      if (!(node instanceof HTMLTextAreaElement))
        throw new Error('the Name cell is not a textarea');
      const was = node.style.height;
      node.style.height = 'auto';
      const measured = node.scrollHeight;
      node.style.height = was;
      return measured;
    });
    const reading = await heightOf(drawn, 'the rendered name of 020');
    expect(
      source,
      'the source of this name fits one line, so there is no fault to fix',
    ).toBeGreaterThan(reading + 1);

    // Proof: `drawnBoxHeight` made to answer `null`, so the textarea measures
    // its own source again — this failed on `Expected: 26.1875 / Received: 42`,
    // the row 15.8px taller than the reading in it. Watched in Chromium,
    // 2026-08-30, and **re-watched on 2026-08-31** on the same message after
    // the fixture's reading was shortened: the source is two lines either way,
    // and what changed is that the *unfaulted* row is now one line by a margin
    // instead of by 6px. Before that it was the shipped code that drew 42, the
    // moment any other column's width moved.
    expect(linked, 'the row is as tall as the source, not as the reading').toBeCloseTo(plain, 0);
  });
});
