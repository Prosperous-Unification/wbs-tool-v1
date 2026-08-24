import { expect, type Page, test } from '@playwright/test';

/**
 * The Tailwind integration and the scoped reset, measured by the browser that
 * has to run them.
 *
 * `src/styles.test.ts` asserts what comes out of the compiler; this file
 * asserts what a page does with it. The two halves are not the same claim — a
 * stylesheet can compile perfectly and never be linked, and a rule can be
 * correctly scoped in the file and still reach a cell because something else
 * pulled a second copy in.
 *
 * **What changed here in `F shadcn-foundation`, and why it is sound.** The
 * tailwind spike wrote two of these tests to prove a reset was *absent* —
 * heading margins untouched, form controls on the platform font — because in
 * `T` there was no reset at all and preflight would have been a document-wide
 * one. `F` ships a reset on purpose, scoped to the chrome by
 * `:not([data-grid], [data-grid] *)`, so "no reset anywhere" is no longer the
 * property worth guarding: it would fail on the correct implementation and pass
 * on one that reset nothing and left every vendored component mis-measured.
 *
 * The fault those two tests existed to catch is **unchanged** and still the
 * fault this file is shaped around — a reset reaching the table. What moved is
 * where it is measured. The two chrome assertions became positive ones (the
 * reset arrived where it was aimed), and two new assertions were added on the
 * other side of the line: the box model and the font of a dependency chip in a
 * seeded plan, which is where an unscoped reset would show up. Both were
 * watched failing with the guard removed —
 * `openspec/changes/shadcn-foundation/verify.md`.
 *
 * `layout.spec.ts` is still not the oracle for any of this, and is untouched.
 * It measures rectangles against a table that is styled inline, and an inline
 * style outranks every layer, so it stayed green through a fully enabled
 * preflight. That is the spike's finding and it has not changed.
 */

/** The tracer's value in `theme.css`: `--tracking-tight: -0.025em`. */
const TRACKING_TIGHT_EM = -0.025;

/**
 * Opens the fixed local identity and builds the smallest plan with a dependency chip in it.
 *
 * The chip is the point. Almost everything else inside the table carries an
 * inline style — `font: inherit`, `box-sizing: border-box` — and an inline
 * style outranks every layer, so measuring one of those would report
 * `border-box` whether or not the reset reached it. That is the vacuity the
 * tailwind spike found in the layout gate, and it is easy to reproduce: a `<td>`
 * is `border-box` by `table-frame.ts`'s own `CELL`, and the ⋯ button carries
 * `font: inherit` of its own. The chip in the Depends on cell
 * (`wbs-table.tsx:3106`) carries no `style` prop at all, so what it computes is
 * what the cascade gave it and nothing else.
 *
 * @param page The page to seed, which it also navigates.
 * @param _account The legacy fixture label, retained to keep call sites descriptive.
 */
async function seedChip(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  await addRow.click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  await addRow.click();
  await expect(page.getByLabel('Name of 020')).toBeVisible();

  const depends = page.getByLabel('Add a dependency to 020');
  await depends.click();
  await depends.fill('010');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 020 waiting for 010' })).toBeVisible();
}

/**
 * Waits until React has mounted authenticated chrome and opened its project-name control.
 *
 * `goto` resolves on the document's load event, and this app renders from
 * `main.tsx` after it — so a `document.querySelector` straight afterwards races
 * the first paint. Observed 2026-08-09: `leaves form controls the platform
 * font` failed on its own guard, `the chrome has no input to measure`,
 * on one run of many. That throw is the guard doing exactly its job — refusing
 * rather than measuring an empty page — and the bug was here, not in it.
 *
 * The username field rather than the heading, though `app.tsx` renders both in
 * the same pass: the field is what the second test measures, and the heading
 * would still be the weaker wait if that ever stopped being true.
 */
async function openChromeControl(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByLabel('Project name')).toBeVisible();
}

test.describe('Tailwind, in the browser', () => {
  test('applies the tracer class the brand heading carries', async ({ page }) => {
    await page.goto('/');
    const brand = page.getByRole('heading', { name: 'WBS tool v2' });
    await expect(brand).toBeVisible();

    const applied = await brand.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        letterSpacing: style.letterSpacing,
        fontSize: Number.parseFloat(style.fontSize),
        // Read back rather than assumed: a class in the markup with no rule
        // behind it is exactly the state this whole change is about, and the
        // two facts together are what say the stylesheet arrived.
        classes: node.getAttribute('class'),
      };
    });

    expect(applied.classes).toContain('tracking-tight');
    // Computed, not declared: Chromium resolves `-0.025em` against the h1's own
    // font size, so this is the rule having been found, cascaded and applied.
    // `normal` — the value with no stylesheet at all — parses to NaN and fails
    // here, which is the failure this test exists to produce.
    expect(Number.parseFloat(applied.letterSpacing)).toBeCloseTo(
      applied.fontSize * TRACKING_TIGHT_EM,
      1,
    );
  });

  // One assertion per test throughout: `expect` throws on the first failure, so
  // a second assertion in the same body is never evaluated in the run that
  // proves the first can fail — and a check nobody has watched break is what R5
  // is about.
  test('takes the user agent’s margin off a chrome heading', async ({ page }) => {
    await page.goto('/');
    await openChromeControl(page);

    const margin = await page.evaluate(() => {
      const heading = document.querySelector('h1');
      if (heading === null) throw new Error('the chrome has no brand heading');
      return getComputedStyle(heading).marginBlockStart;
    });

    // The user agent gives an `h1` `0.67em`, about 21px at this size. The
    // chrome now spaces itself with `mb-*` and `gap-*`, so the reset takes that
    // away — the assertion the spike made here was the opposite one, and this
    // is the same measurement read for the state that is now correct.
    expect(Number.parseFloat(margin)).toBe(0);
  });

  test('gives a chrome control the page’s own font', async ({ page }) => {
    await page.goto('/');
    await openChromeControl(page);

    const families = await page.getByLabel('Project name').evaluate((field) => {
      const around = field.parentElement;
      if (around === null) throw new Error('the input has no chrome surroundings to measure');
      return {
        field: getComputedStyle(field).fontFamily,
        // Its own surroundings, not `document.body`: nothing styles `body`, so
        // that comparison would be against the user agent's serif and would
        // pass for a page with no stylesheet at all.
        around: getComputedStyle(around).fontFamily,
      };
    });

    // `font: inherit` on form controls, which is what lets a vendored `<Input>`
    // be sized in `text-sm` at all: without it the box keeps the platform's own
    // 13.3px Arial and every type utility on it is a rule with no effect.
    expect(families.field).toBe(families.around);
  });

  test('leaves a control inside the grid the platform’s text size', async ({ page }) => {
    await seedChip(page, `reset-size-${String(Date.now())}`);

    const sizes = await page.evaluate(() => {
      const chip = document.querySelector('[data-grid] [aria-label^="Stop "]');
      if (chip === null) throw new Error('the seeded plan grew no dependency chip');
      const cell = chip.closest('td');
      if (cell === null) throw new Error('the chip is not in a cell');
      return { chip: getComputedStyle(chip).fontSize, cell: getComputedStyle(cell).fontSize };
    });

    // The same reset line as the test below, read the other way. `font:
    // inherit` sets the face **and** the size, and the size is what decides how
    // wide a chip is and therefore how many of them fit on a line of the
    // Depends on cell — `fits a deep plan with an unbreakable name and six
    // dependencies` is the layout test that cares, and it cannot see this fault
    // because the widths are declared rather than measured.
    //
    // `box-sizing` is deliberately not the assertion here, and the reason is
    // worth recording: Chromium's own user agent stylesheet already gives a
    // `<button>` `border-box`, so a test asserting `content-box` on this
    // element failed against a correctly scoped reset — watched 2026-08-09 —
    // and one asserting `border-box` would have passed with the guard gone.
    //
    // What this margin is, since `spreadsheet-geometry`: 13.333px against
    // 13px, where it used to be 13.333px against 16px. A third of a pixel is
    // the whole distance, and it is still the right distance — a lost guard
    // makes the two **equal**, and a rule that typed the grid's buttons at the
    // body's size does too. That is not hypothetical: one commit of
    // `spreadsheet-geometry` did exactly that and this test caught it in CI's
    // `pixels` (run 31617201732). The buttons stayed on the platform's face
    // because of it. Do not close the third of a pixel.
    expect(sizes.chip).not.toBe(sizes.cell);
  });

  test('paints the grid with the page’s own foreground token, deliberately', async ({ page }) => {
    await seedChip(page, `grid-colour-${String(Date.now())}`);

    const colours = await page.evaluate(() => {
      const cell = document.querySelector('[data-grid] td');
      if (cell === null) throw new Error('the seeded plan put no cell in the grid');
      // The token resolved the way any rule reading it would, rather than the
      // `oklch(…)` text `getPropertyValue` hands back: a probe whose colour is
      // the custom property, read as the browser computed it.
      const probe = document.createElement('span');
      probe.style.color = 'var(--foreground)';
      document.body.append(probe);
      const token = getComputedStyle(probe).color;
      probe.remove();
      return { cell: getComputedStyle(cell).color, token };
    });

    expect(colours.cell).toBe(colours.token);
  });

  test('leaves a control inside the grid the platform’s font', async ({ page }) => {
    await seedChip(page, `reset-font-${String(Date.now())}`);

    const families = await page.evaluate(() => {
      const chip = document.querySelector('[data-grid] [aria-label^="Stop "]');
      if (chip === null) throw new Error('the seeded plan grew no dependency chip');
      const cell = chip.closest('td');
      if (cell === null) throw new Error('the chip is not in a cell');
      return {
        chip: getComputedStyle(chip).fontFamily,
        // The cell it sits in, which is the font `font: inherit` would give it.
        cell: getComputedStyle(cell).fontFamily,
      };
    });

    // `font: inherit` is the reset line the table's geometry cannot survive:
    // `table-frame.ts` sized the `not-before` column from what Chromium makes
    // of an unconstrained `input[type=date]` in the table's own font, and every
    // control in a cell is measured against the same unaided defaults.
    expect(families.chip).not.toBe(families.cell);
  });
});

/*
 * PROVING THESE CAN FAIL — watched 2026-08-09 against a real chromium, one
 * fault at a time, each reverted. Quoted in
 * `openspec/changes/shadcn-foundation/verify.md`; the two faults the spike
 * watched are in `docs/plans/2026-08-08-tailwind-spike-verify.md`.
 *
 * FAULT M — the stylesheet never linked.
 *   `main.tsx`: drop `import './styles.css'`.
 * Observed by the spike: `applies the tracer class the brand heading carries`
 * failed on `expected NaN to be close to -0.8`, the class still in `className`
 * and no rule behind it. That NaN is `normal`, the letter-spacing of an h1
 * nothing styled, and it is why the assertion is on the computed value rather
 * than on the class attribute, which passes in both worlds.
 *
 * FAULT G — the grid guard removed.
 *   `styles.css`: `:not([data-grid], [data-grid] *)` struck from every rule in
 *   `@layer base`, leaving the same reset unscoped.
 * This is the fault the whole change is shaped around, and the two grid tests
 * are the only things in the repository that see it: the chrome tests stay
 * green (the chrome wanted the reset), and so does every one of
 * `layout.spec.ts`'s 22 geometry assertions.
 */
