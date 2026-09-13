import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The Types cell, in a browser.
 *
 * `work-item-types` task 5.1, and every assertion here is one jsdom cannot
 * make. The claim the change ships is about **layout**: a row carrying three
 * types is the same height as a row carrying none, because the chip run is
 * clipped onto one line rather than wrapped onto three. jsdom computes no
 * layout at all, so `wbs-table.test.tsx` can watch `flex-wrap: nowrap` arrive
 * on the strip and can never see the box it produces — which is R5 tally
 * #14–16 and #20, every one of them a rule that was right in a unit test and
 * wrong on screen.
 *
 * It is also the case that made `deps-single-line` and `unified-reference-cell-ux`
 * necessary: the Tags cell shipped wrapping to three lines and was found by
 * Dany looking at it, on 2026-08-29, after a green suite.
 *
 * The column is hidden by default (`DEFAULT_HIDDEN_COLUMNS`), so every test
 * here turns it on from `Columns` first — which is itself the other half of
 * task 3.1's claim, checked in the one place a reader would find out.
 */

/** The at-rest height a row of one line may not exceed, in px — `layout.spec.ts`' budget. */
const ROW_HEIGHT_BUDGET = 28;

/**
 * Opens the app and waits for the session to be signed in.
 *
 * `page.goto('/')` and then the account button, which is what every other spec
 * in this directory does — and leaving it out is why the first run of this file
 * spent five minutes timing out on `New project`, a button that only exists
 * once a session has loaded.
 */
async function openSignedIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
}

/** Turns a hidden column on from the `Columns` control and waits for its header. */
async function showColumn(page: Page, label: string, columnId: string): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: label }).check();
  await expect(page.locator(`thead th[data-column="${columnId}"]`)).toHaveCount(1);
  // Close the control so it does not sit over the row the measurements read.
  await page.getByText('Columns', { exact: true }).click();
}

/** Names a type into a row's Types cell, creating it in the directory. */
async function addType(page: Page, rowNumber: string, name: string): Promise<void> {
  await page.getByLabel(`Add a type to ${rowNumber}`).click();
  // `getByRole('combobox')`, not `getByLabel`: the open picker gives that label
  // to **two** nodes — the `<input>` and the `<ul role="listbox">` it controls —
  // and a bare label lookup is a strict-mode violation the moment the list opens.
  const search = page.getByRole('combobox', { name: `Types for ${rowNumber}` });
  await search.fill(name);
  // **Enter, not a click on the option**, which is `deps-cell.spec.ts`' idiom and
  // is here for a reason the browser supplied. The option resolves —
  // `<li role="option" data-picker-take>Add “Story”</li>` — and then never
  // satisfies Playwright's actionability check: 115 retries of "waiting for
  // element to be visible, enabled and stable" before the test timed out. The
  // list sits inside the table's scrolling frame and is repositioned as the
  // strip re-renders, so it is never stable for two consecutive frames.
  //
  // `directory.spec.ts` clicks the identical option shape and passes, because
  // its picker is on a static page. A cell picker inside a scroll frame is not
  // the same target, and the idiom that works there does not transfer.
  await search.press('Enter');
  await expect(page.getByLabel(`Remove ${name} from ${rowNumber}`)).toBeVisible();
}

/** One row's `<tr>` height — the promise a reader cares about. */
async function rowHeight(page: Page, rowNumber: string): Promise<number> {
  const cell = page.getByLabel(`Name of ${rowNumber}`);
  return cell.evaluate((node) => {
    const row = node.closest('tr');
    if (row === null) throw new Error('the name cell is not in a row');
    return row.getBoundingClientRect().height;
  });
}

test.describe('the Types cell at a laptop width', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSignedIn(page);
    await createProject(page, 'Types');
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 020')).toBeVisible();
    await showColumn(page, 'Types', 'type');
  });

  test('is off the table until Columns turns it on', async ({ page }) => {
    // The other half of task 3.1: hidden by default, so the folded table is the
    // table it was. `beforeEach` has already shown it, so this hides it again
    // and asserts the column is gone rather than merely unticked — a control
    // that unticks without removing the column would pass a `checked` assertion
    // and change nothing on screen.
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Types' }).uncheck();
    await expect(page.locator('thead th[data-column="type"]')).toHaveCount(0);
    await expect(page.getByLabel('Add a type to 010')).toHaveCount(0);
  });

  test('a row of three types is the same height as a row of none', async ({ page }) => {
    // **The claim, and the whole reason this file exists.** Three chips in a
    // 120px column have nowhere to go: clipped they stay on one line, wrapped
    // they take three and the row grows to match.
    //
    // Measured against the *sibling row*, not against a pinned number: a font
    // change moves both and means nothing, while a wrap moves only the row that
    // carries the chips. A pinned figure would fail on a font update and pass on
    // the bug.
    //
    // Proof: `flexWrap: 'wrap'` put on `REFERENCE_SET_STRIP_STYLE` and on both
    // chip-group rules, watched failing on `three types grew the row past a
    // single line … Expected: 26.1875 / Received: 87.1875` — 61px, which is two
    // extra lines of chips. Watched in Chromium, 2026-08-31.
    const bare = await rowHeight(page, '020');

    await addType(page, '010', 'Story');
    await addType(page, '010', 'Spike');
    await addType(page, '010', 'Epic');

    // **At rest, and that one word is what turned this case from a claim into a
    // check.** Until 2026-08-31 the height was read with the cell still being
    // edited, and the named negative — `flex-wrap: wrap` on the strip and both
    // chip groups — was watched leaving all five cases green. An edited strip is
    // an absolutely positioned panel: it is not in the row's flow at all, so it
    // can wrap to any height it likes and the row will not move. Leaving the
    // cell first puts the strip back in the flow, which is the state a reader
    // spends every second but one in, and the same injection then failed by
    // 61px.
    //
    // The old explanation for the vacuity — that `CELL` clips the `<td>`, so a
    // wrapped strip is cut off rather than pushing the row taller — was wrong as
    // well as superseded: `type` is exempt from that clip since
    // `reference-cell-escape-and-hover`, and the case still passed with the
    // fault in. The panel was the reason all along.
    await page.getByRole('combobox', { name: 'Types for 010' }).blur();
    const carrying = await rowHeight(page, '010');
    expect(carrying, 'three types grew the row past a single line').toBe(bare);
    expect(carrying).toBeLessThanOrEqual(ROW_HEIGHT_BUDGET);

    // **Still no strip-height assertion here**, and that half of the original
    // finding stands. The strip is 87px with three chips and 48px with one
    // **under `nowrap`** — it holds the search box as well as the chips and
    // grows with them either way — so a strip comparison fails on correct code,
    // and a threshold picked to sit between 48 and 87 on this font at this width
    // would be a number reverse-engineered from one run. The row is the promise
    // a reader cares about, and the row is now what answers for it.
  });

  test('clips the chip run at the cell rather than letting it paint out', async ({ page }) => {
    // **Rewritten after the browser corrected the first version, which measured
    // the wrong thing.** It compared the strip's border box against the cell's
    // and demanded the strip end inside it — and got `Received: 2`, a two-pixel
    // box overrun. That is not a bug and the assertion was not a claim about
    // anything: `CELL` sets `overflow: clip` on the `<td>`, so an inner box may
    // extend past the cell edge and still paint nothing there. A box comparison
    // measures layout the clip is allowed to ignore.
    //
    // What the design actually promises is the clip, so that is what this reads:
    // the box clips, **and** the content is genuinely wider than it, so the clip
    // is doing work. Without the second half this passes on a row whose chips
    // fit, which is a check that cannot fail — the fault `G gantt-view` shipped,
    // one file over. Which box is the clipper changed on 2026-08-31; see below.
    await addType(page, '010', 'Story');
    await addType(page, '010', 'Spike');
    await addType(page, '010', 'Epic');

    // **Rewritten a second time on 2026-08-31, and the move is the finding.**
    // This used to read `overflow-x: clip` off the `<td>`. It cannot any more:
    // `type` joined `POPOVER_COLUMNS` that day, because the cell opens a
    // picker list and a hover card and both were being cut to the height of one
    // row (`reference-cell-escape-and-hover`) — which is the exemption Teams,
    // Tags and Services have had all along. So the rest-line clip is where
    // theirs is: on the **strip**, which is `overflow: hidden` at rest and
    // `visible` only while its panel is open, with the edge fade over it.
    //
    // The promise a reader cares about has not moved an inch; the rule that
    // delivers it has, so this reads the rule where it now lives — and reads
    // the crowding first, so a fixture that stopped crowding the cell would
    // fail here rather than make everything below vacuous.
    //
    // **At rest, which now has to be arranged.** `addType` leaves the box with
    // the focus — since 2026-08-31 a landed take no longer knocks it out
    // (`reference-cell-escape-and-hover`) — and a focused strip is the open
    // panel, whose whole job is to stop clipping so the list can be read. Read
    // without this the assertion below failed on `Expected: "hidden" /
    // Received: "visible"`, measuring the panel and calling it the rest line.
    await page.getByRole('combobox', { name: 'Types for 010' }).blur();

    const strip = page.locator('td[data-column="type"] [data-reference-strip]').first();
    const clipped = await strip.evaluate((node) => ({
      overflowX: getComputedStyle(node).overflowX,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));

    // The strip is genuinely narrower than what it holds, or everything below
    // is a rule with nothing to clip — `G gantt-view`'s zero-width bar, which
    // this file's first version very nearly repeated. First, because a fixture
    // that stopped crowding the cell would make the rest of this vacuous rather
    // than failing.
    expect(clipped.clientWidth, 'the strip was not laid out').toBeGreaterThan(0);
    expect(
      clipped.scrollWidth,
      'three chips fit the column, so the clip is untested here',
    ).toBeGreaterThan(clipped.clientWidth);
    // `hidden` and not `clip`, unlike the `<td>` rule this replaces: the strip
    // is the box the edge fade is masked onto and the box the picker's list
    // opens inside, and it turns this off entirely while the panel is open —
    // see `reference-set-field.tsx`, where both halves are proved.
    //
    // Proof: the rest `overflow: 'hidden'` on **both** of the strip's flex
    // containers changed to `'visible'` — one alone leaves the other clipping,
    // the same "one nowrap beside one wrap" arithmetic this component's own
    // comments record — watched failing on `Expected: "hidden" / Received:
    // "visible"` in Chromium, 2026-08-31.
    //
    // **And a third attempt at measuring the paint was deleted rather than
    // shipped**, which is the same finding this test's second paragraph
    // records, one layer down. It sampled `elementFromPoint` four pixels past
    // the cell's right edge and asserted nothing of this cell was found there.
    // With the fault above injected it passed: the next `<td>` is later in the
    // DOM and paints its own background over an overflowing chip, so a hit test
    // outside the cell finds the neighbour whether the strip clips or not. A
    // check that answers the same either way is not a check — `T1
    // column-widths-drag`'s rule, and this file already carries two of its
    // relatives.
    expect(clipped.overflowX).toBe('hidden');
  });

  test('every chip carries a remove, because nothing here is inherited', async ({ page }) => {
    // The dimension's defining rule, drawn: a type does not inherit
    // (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`), so every
    // chip on screen was stated on the row it is drawn in and every one of them
    // is removable. The Tags cell after `tags-accumulate` will draw inherited
    // chips with no ✕; this cell has no such state to draw.
    await addType(page, '010', 'Story');

    await expect(page.getByLabel('Remove Story from 010')).toBeVisible();
    // And the child of a typed row carries nothing.
    await page.getByLabel('Name of 020').click();
    await expect(page.getByLabel('Remove Story from 020')).toHaveCount(0);
  });
});

test.describe('the Types dimension on a phone', () => {
  test('does not put the column on a phone, because the phone has no table', async ({ page }) => {
    // **Task 5.1 asked for the cell measured at 390×844, and that measurement
    // does not exist.** At 390 the plan is `mobile-cards`' card list, not a
    // table: there is no `<thead>`, no Types column and no cell to lay out, and
    // the first version of this test spent a minute timing out on `Add work
    // item` — a control that on a phone lives behind the `Plan actions` sheet.
    //
    // So this asserts what is true instead of measuring what is not there, and
    // it is a real check rather than a shrug: it fails the moment somebody
    // renders the table at 390, which is the change that would make the missing
    // measurement matter. Putting a row's types onto a card is
    // `mobile-card-facts`' decision about what a card carries, and that change
    // does not list them — so there is nothing here for this one to draw.
    await page.setViewportSize({ width: 390, height: 844 });
    await openSignedIn(page);
    await createProject(page, 'Types phone');

    // The phone's own face, and the control the table's `Add work item` becomes.
    await expect(page.getByRole('button', { name: 'Plan actions' })).toBeVisible();
    // No table, so no column and no cell — and `toHaveCount(0)` rather than a
    // negated visibility check, which would also pass on a table that is present
    // and merely scrolled out of view.
    await expect(page.locator('thead th[data-column="type"]')).toHaveCount(0);
    await expect(page.getByLabel('Add a type to 010')).toHaveCount(0);
  });
});
