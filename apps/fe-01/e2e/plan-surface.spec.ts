import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The plan as one surface, measured by a browser.
 *
 * Two claims, and neither of them can be made anywhere else. jsdom lays nothing
 * out, so "the column wastes no room under the chart" and "the chart is showing
 * the row the table is showing" are both claims about boxes a rendering engine
 * put somewhere.
 *
 * Both come from the Browser Use Cloud audit of 2026-08-11
 * (`notes/wbs-cloud-test-run-2026-08-11.md`, Group C):
 *
 * - "508px dead white space on small plans (Gantt docked to viewport bottom)."
 * - "Table and Gantt scroll independently — can never read row N beside bar N;
 *   Gantt papers over it with a duplicate truncated 176px label column."
 *
 * **The first claim's answer was reversed on 2026-08-30.** The audit's 508px was
 * removed by pulling the chart *up* to the last row; Dany then asked for the
 * opposite — _"i need the whole gantt panel to go down"_ (`eb8968d`) — so the
 * slack moved above the chart and the chart went to the column's bottom edge.
 * The dead space is still gone; it is the side it was reclaimed from that
 * changed. The short-plan case below carries the history.
 *
 * `header.spec.ts` still owns the other half of the frame's height — that a
 * plan **taller** than the window still ends the frame at the bottom of it —
 * and this file asserts the same thing once more with the chart open, because
 * the chart is the sibling the frame now shares its column with.
 */

/**
 * How far a measured edge may be from where the arithmetic says, in CSS px.
 *
 * Two, not one: the numbers being compared here are two elements' rects against
 * each other rather than a rect against an integer, and a fractional row height
 * lands in both of them.
 */
const NEARLY = 2;

/**
 * How far apart the two faces may be, as a fraction of a row.
 *
 * A twentieth, which is 1.4px of a 28px chart row. The residue is a browser
 * rounding a written `scrollTop` to a whole pixel — a whole pixel of a row is
 * a thirty-sixth of one — plus the link's own {@link SETTLED_PX} deadband,
 * which is there so a follower moved into place does not push back (see
 * `plan-scroll-link.ts`).
 */
const A_ROW_APART = 0.05;

/** A plan short enough that the frame could never be filled by it. */
const SHORT_PLAN = 3;

/**
 * A plan taller than any frame this file produces, so a scroll is a real one.
 *
 * `header.spec.ts` measured twenty-three against a frame with no chart under
 * it; the chart takes a share of the same column, so the frame here is smaller
 * and twenty-three is past it with room to spare. The tests assert it rather
 * than trusting it.
 */
const TALL_PLAN = 23;

/** Signs up a throwaway account and opens a project with `rows` work items. */
async function seedPlan(page: Page, _account: string, rows: number): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (let added = 0; added < rows; added += 1) {
    const number = String((added + 1) * 10).padStart(3, '0');
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  // One estimate, so the chart has a mark on it as well as rows. A chart of
  // nothing but labels would still carry every measurement below, and it would
  // also be a chart nobody would ever have opened.
  const estimate = page.getByLabel('Dev estimate for 010');
  await estimate.fill('2/4/6');
  await estimate.blur();
  // `toHaveValue` reads the box's own value, which `fill` set synchronously —
  // it says nothing about the blur-commit reaching be-01 or the plan coming
  // back. The folded figure is drawn from the *fetched* plan, so block on the
  // persisted estimate: the card the folded cell opens reads 'No estimate yet'
  // until that round trip lands, and 'optimistic 2' once it has. (TASK-145,
  // hover-card-estimate-race sibling seed)
  await estimate.locator('..').hover();
  await expect(page.locator('[role="tooltip"]').first()).toContainText('optimistic 2');
  await page.mouse.move(0, 0);
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
}

/** Opens the chart and waits until it has drawn the plan's rows. */
async function openTheChart(page: Page, rows: number): Promise<void> {
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('[data-gantt-chart]')).toBeVisible();
  // The invariant the whole link is built on, asserted where it is cheapest:
  // the chart draws exactly the rows the plan draws. Every measurement below
  // pairs a row with a label, and a chart one row short would pair them off by
  // one instead of failing.
  await expect(page.locator('[data-gantt-label]')).toHaveCount(rows);
}

/** Where the column has put the frame, the chart and the last row of the plan. */
function measureSurface(page: Page): Promise<{
  gap: number;
  reserved: number;
  belowChart: number;
  underTheScrollBox: number;
  frameBottom: number;
  chartTop: number;
  windowHeight: number;
  pageOverflow: number;
  rowsPastTheFrame: number;
}> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-table-frame]');
    const panel = document.querySelector('[data-gantt-panel]');
    if (frame === null) throw new Error('the scrolling frame is not on the page');
    if (panel === null) throw new Error('the chart is not on the page');
    // The chart is two boxes, and has been since the label column learned to
    // collapse: the scroll box, and the control strip below it. The strip is a
    // **sibling** of `[data-gantt-panel]` rather than a descendant, because a
    // control inside a box that scrolls 2000px sideways is a control that goes
    // with it (`gantt-panel.tsx`) — so the bottom of the chart is the strip's
    // bottom, and measuring the panel's would report the strip's own height as
    // dead space at the bottom of the window.
    //
    // Nullable rather than required: a plan whose dependencies run in a circle
    // draws its sentence under this same `[data-gantt-panel]` with no axis, no
    // rows and no controls at all, and the panel's own bottom is the honest
    // answer for that shape.
    const controls = document.querySelector('[data-gantt-controls]');
    const rows = [...frame.querySelectorAll('tbody tr[data-row-id]')];
    const last = rows.at(-1);
    if (last === undefined) throw new Error('the plan has no rows to measure');
    const frameBox = frame.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const controlsBox = controls === null ? null : controls.getBoundingClientRect();
    const frameStyle = getComputedStyle(frame);
    const room = Number.parseFloat(frameStyle.paddingBottom);
    const floor = Number.parseFloat(frameStyle.minHeight);
    const table = frame.querySelector('table');
    if (table === null) throw new Error('the plan is not drawn as a table');
    return {
      // What the audit measured: the white space between the plan's last row
      // and the top of the chart.
      gap: panelBox.top - last.getBoundingClientRect().bottom,
      // What that space is declared to be, by the two declarations that reserve
      // it: the picker room under the last row, and however much of the frame's
      // own floor a short plan does not fill.
      reserved: room + Math.max(0, floor - (table.getBoundingClientRect().height + room)),
      belowChart: document.documentElement.clientHeight - (controlsBox ?? panelBox).bottom,
      // How far the strip stands off the box it belongs to. Reported so that
      // "the surface reaches the bottom of the window" cannot be satisfied by a
      // strip that floated away from its chart and landed there on its own —
      // the substitution above is only sound while the two are adjacent.
      underTheScrollBox: (controlsBox?.top ?? panelBox.bottom) - panelBox.bottom,
      frameBottom: frameBox.bottom,
      chartTop: panelBox.top,
      windowHeight: document.documentElement.clientHeight,
      pageOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      // How much of the plan is past the bottom of the frame, which is what
      // says a measurement of a scrolled frame is not a measurement of a frame
      // that had nowhere to scroll.
      rowsPastTheFrame: frame.scrollHeight - frame.clientHeight,
    };
  });
}

/**
 * Which row the table is showing first, and where the chart's copy of that same
 * row stands.
 *
 * The row is found by a linear scan on purpose: `plan-scroll-link.ts` finds it
 * by a binary search, and a check that ran the same search over the same rects
 * would be the module agreeing with itself. What is asserted is only the
 * consequence — the two faces are showing one row, cut by the same amount.
 */
function measureAgreement(page: Page): Promise<{
  id: string;
  index: number;
  cutInTable: number;
  cutInChart: number;
  panelScrollLeft: number;
  frameScrollLeft: number;
}> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-table-frame]');
    const panel = document.querySelector('[data-gantt-panel]');
    if (frame === null || panel === null) throw new Error('the plan is not drawn twice');
    // The heading **cell**, because the cells are what is sticky here — a
    // `<thead>` rides up with the scroll and would move this measurement with
    // the rows it is supposed to be measured against.
    const heading = frame.querySelector('thead th');
    const axis = panel.querySelector('[data-gantt-axis]');
    if (heading === null || axis === null) throw new Error('one of the two faces has no heading');
    const headingBottom = heading.getBoundingClientRect().bottom;
    const rows = [...frame.querySelectorAll('tbody tr[data-row-id]')];
    const shown = rows.find((row) => row.getBoundingClientRect().bottom > headingBottom + 1);
    if (shown === undefined) throw new Error('the table is showing no row at all');
    const id = shown.getAttribute('data-row-id') ?? '';
    const label = panel.querySelector(`[data-gantt-label="${id}"]`);
    if (label === null) throw new Error(`the chart draws no row ${id}`);
    const shownBox = shown.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    return {
      id,
      index: rows.indexOf(shown),
      // How much of that one row each face has under its own heading, as a
      // fraction of that face's own row. A fraction and not pixels, because the
      // two rows are not the same height — a table row is 26.19px in this font
      // and a chart row is a declared 28 — and the same fraction of each is
      // what "showing the same thing" means when they are not.
      cutInTable: (headingBottom - shownBox.top) / shownBox.height,
      cutInChart: (axis.getBoundingClientRect().bottom - labelBox.top) / labelBox.height,
      panelScrollLeft: panel.scrollLeft,
      frameScrollLeft: frame.scrollLeft,
    };
  });
}

/** Turns the wheel over an element's middle, and lets the scroll settle. */
async function wheelOver(page: Page, selector: string, downBy: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} is not on the page to scroll`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, downBy);
  // The link runs inside the scroll event, so one frame after the wheel is
  // enough — this waits for a paint rather than for a duration.
  await page.evaluate(
    () => new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled))),
  );
}

/** The account this test registered, unique per run and per case. */
let signedInAs = '';

test.beforeEach(() => {
  signedInAs = 'local-dev';
});

test.describe('the plan and its chart as one surface', () => {
  /**
   * **This case asserted the opposite rule until 2026-08-30, and Dany reversed
   * it.** It read `docks the chart under the last row rather than at the bottom
   * of the window`: the chart hugged the plan's last row and the slack fell
   * below the chart. `eb8968d` — his words, on a four-row plan: _"i need the
   * whole gantt panel to go down"_ — put the slack **above** the chart instead,
   * via `GANTT_DOCK_SLACK`, and the chart group now ends at the column's own
   * bottom however short the plan is.
   *
   * That change did not edit this file, so the two rules sat on `main` together
   * and this case was red: `527.4375px` of gap against a `217.4375px`
   * frame-derived allowance. Both figures come from the frame's own computed
   * style, so it was never two tests measuring different things — it was one
   * layout with two contradictory owners. Reproduced independently by a second
   * session before this rewrite.
   *
   * **What is asserted now is the same concern in its new place.** The original
   * complaint was 508px of white nobody asked for; the guarantee is still "the
   * column wastes nothing", and the only thing that moved is which side of the
   * chart the reclaimed space is on. The consequence, stated because it is what
   * a reader will see: on a short plan there is now a large gap **between the
   * table and the chart**, and that gap is the feature.
   *
   * `gantt.spec.ts`'s `sits at the column's bottom edge however short the plan
   * is` makes the same claim from the column's side. This one makes it from the
   * window's, which is what catches a column that docks correctly inside a page
   * that has itself grown a scrollbar.
   */
  test('ends the chart at the window’s bottom however short the plan is', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, SHORT_PLAN);
    await openTheChart(page, SHORT_PLAN);
    const measured = await measureSurface(page);

    // Or the frame was full and there was never any dead space to reclaim.
    expect(
      measured.rowsPastTheFrame,
      'the seeded plan fills its frame, so this measures nothing',
    ).toBe(0);
    // The claim, and the whole of what `eb8968d` bought: nothing is left under
    // the chart on a plan far too short to fill the column. 16px rather than
    // `NEARLY`, matching the tall-plan case below — the two now assert one rule
    // at both ends of the fixture range instead of opposite ones.
    //
    // Proof: `GANTT_DOCK_SLACK` deleted from `table-frame.ts`, watched failing
    // on `the column stops 528px short of the window`; watched 2026-08-30.
    expect(
      measured.belowChart,
      `the column stops ${String(Math.round(measured.belowChart))}px short of the window`,
    ).toBeLessThanOrEqual(16);
    // And what reaches the bottom is the chart itself, not a control strip that
    // parted company with it and got there alone.
    expect(
      measured.underTheScrollBox,
      `the control strip stands ${String(
        Math.round(measured.underTheScrollBox),
      )}px off the chart it belongs to`,
    ).toBeLessThanOrEqual(NEARLY);
    // The reclaimed space is above the chart now, so the gap this case used to
    // bound is *expected* to be large — but not unbounded. It cannot exceed the
    // window, which is what a slack that grew without limit would do.
    expect(
      measured.gap,
      `${String(Math.round(measured.gap))}px between the last row and the chart, past the window`,
    ).toBeLessThan(measured.windowHeight);
    expect(measured.pageOverflow, 'the page scrolls vertically behind the frame').toBe(0);
  });

  test('still ends the chart at the bottom of the window when the plan fills the frame', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, TALL_PLAN);
    await openTheChart(page, TALL_PLAN);
    const measured = await measureSurface(page);

    // The half the shrink keeps: a plan past the remainder still gets the whole
    // remainder, and the frame is still the thing that scrolls.
    expect(
      measured.rowsPastTheFrame,
      'the seeded plan is shorter than the frame, so nothing here is being shrunk',
    ).toBeGreaterThan(0);
    expect(
      measured.belowChart,
      `the column stops ${String(Math.round(measured.belowChart))}px short of the window`,
    ).toBeLessThanOrEqual(16);
    // And the bottom of the column is the chart's own bottom, not a strip that
    // parted company with it. Both halves are needed: the line above says the
    // column reaches the window, this one says the thing that reaches it is
    // still attached to the chart.
    expect(
      measured.underTheScrollBox,
      `the control strip stands ${String(
        Math.round(measured.underTheScrollBox),
      )}px off the chart it belongs to`,
    ).toBeLessThanOrEqual(NEARLY);
    // The two faces are adjacent, which is the other half of one surface: the
    // frame ends exactly where the chart begins.
    expect(measured.chartTop - measured.frameBottom).toBeLessThanOrEqual(NEARLY);
    expect(measured.pageOverflow, 'the page scrolls vertically behind the frame').toBe(0);
  });

  test('takes the chart to the row the table was scrolled to', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, TALL_PLAN);
    await openTheChart(page, TALL_PLAN);

    const atRest = await measureAgreement(page);
    // Both faces start on the first row, so a check that only ever compared
    // them would pass on a link that does nothing at all.
    expect(atRest.index, 'the plan does not open on its first row').toBe(0);

    await wheelOver(page, '[data-table-frame]', 8 * 28);
    const scrolled = await measureAgreement(page);

    expect(scrolled.index, 'the wheel did not scroll the table').toBeGreaterThan(0);
    expect(
      Math.abs(scrolled.cutInChart - scrolled.cutInTable),
      `the table is showing ${scrolled.id} cut by ${scrolled.cutInTable.toFixed(3)} of a row and the chart by ${scrolled.cutInChart.toFixed(3)}`,
    ).toBeLessThanOrEqual(A_ROW_APART);
  });

  test('takes the table to the row the chart was scrolled to', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, TALL_PLAN);
    await openTheChart(page, TALL_PLAN);

    expect((await measureAgreement(page)).index).toBe(0);
    await wheelOver(page, '[data-gantt-panel]', 5 * 28);
    const scrolled = await measureAgreement(page);

    // Neither face is the master: a wheel over the chart is as much a scroll of
    // the plan as a wheel over the table.
    expect(scrolled.index, 'the wheel did not scroll the chart').toBeGreaterThan(0);
    expect(Math.abs(scrolled.cutInChart - scrolled.cutInTable)).toBeLessThanOrEqual(A_ROW_APART);
  });

  test('follows the keyboard down the plan, and leaves the focus where it walked to', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, TALL_PLAN);
    await openTheChart(page, TALL_PLAN);

    // Ctrl+J is the plan's own "next row, same column", and a browser scrolls
    // the cell it focuses into view — which is the third way this surface is
    // scrolled and the one that must not cost anybody their place.
    await page.getByLabel('Name of 010').focus();
    for (let step = 0; step < 15; step += 1) {
      await page.keyboard.press('Control+j');
    }
    await page.evaluate(
      () => new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled))),
    );
    const walked = await measureAgreement(page);

    // The walk reached a cell the frame had to scroll for, or this says nothing
    // about scrolling.
    expect(walked.index, 'the keyboard walk never scrolled the frame').toBeGreaterThan(0);
    expect(Math.abs(walked.cutInChart - walked.cutInTable)).toBeLessThanOrEqual(A_ROW_APART);
    // And the cell it walked to still has the focus. A link that scrolled by
    // `scrollIntoView` on the other face, or that moved the focus to bring a
    // row into view, would take the reader out of the cell they were typing in.
    await expect(page.getByLabel('Name of 160')).toBeFocused();
  });

  test('never moves either face sideways for the other', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedPlan(page, signedInAs, TALL_PLAN);
    await openTheChart(page, TALL_PLAN);

    // An unfolded step is what makes the frame scroll sideways at all
    // (`unfolding-may-scroll`), and the chart's own sideways position is which
    // fortnight of the calendar it is showing. The two are different facts and
    // the link is not allowed to confuse them.
    await page.getByRole('button', { name: 'Unfold Dev estimates', exact: true }).click();
    await page.evaluate(() => {
      const frame = document.querySelector('[data-table-frame]');
      const panel = document.querySelector('[data-gantt-panel]');
      if (frame === null || panel === null) throw new Error('the plan is not drawn twice');
      frame.scrollLeft = 240;
      panel.scrollLeft = 0;
    });
    // Read back rather than assumed: 240 is past the end of this frame's own
    // sideways range at this width, and a browser clamps. What matters is that
    // it is somewhere sideways and stays there.
    const sideways = await measureAgreement(page);
    expect(sideways.frameScrollLeft, 'the frame did not scroll sideways at all').toBeGreaterThan(0);

    await wheelOver(page, '[data-table-frame]', 8 * 28);
    const scrolled = await measureAgreement(page);

    expect(scrolled.index, 'the wheel did not scroll the table').toBeGreaterThan(0);
    expect(Math.abs(scrolled.cutInChart - scrolled.cutInTable)).toBeLessThanOrEqual(A_ROW_APART);
    // The frame kept the columns it was scrolled to, and the calendar did not
    // move under a caption that names the month at its left edge.
    expect(scrolled.frameScrollLeft, 'the table lost the columns it was scrolled to').toBe(
      sideways.frameScrollLeft,
    );
    expect(scrolled.panelScrollLeft, 'the chart was scrolled sideways by the table').toBe(0);
  });
});
