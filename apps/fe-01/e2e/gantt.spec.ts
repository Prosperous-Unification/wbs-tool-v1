import { expect, type Locator, type Page, test } from '@playwright/test';

import { calendarScale } from '../src/components/wbs/gantt-geometry';
import { CHART_PAD_PX, DAY_PX, ROW_PX } from '../src/components/wbs/gantt-panel';

/**
 * Types a whole date into a date field and leaves it, which is what saves one.
 *
 * `fill` alone is not a saved date any more, and that is the product's rule
 * rather than an automation quirk: `DateField` holds everything typed while the
 * box has the focus, because a native date input fires a `change` per completed
 * segment and committing each of them saved a plan starting in year 0002. Tab
 * is how a person leaves the box, and the wait afterwards is the refetch that
 * commit starts — a click that lands inside it hits a `disabled` control and
 * goes nowhere (`aria-busy` on the toolbar is that window, said out loud).
 */
async function setDate(page: Page, label: string, day: string): Promise<void> {
  // A row's earliest-start cell is text at rest since `T2 compact-columns` and
  // mounts its editor only for the cell being edited, so it is opened first.
  // The toolbar's project start date is always an editor and is left alone.
  // A click rather than a `mousedown`: React flushes inside the mousedown
  // dispatch and the browser's own focus default then closes what it opened —
  // see `e2e/keyboard.spec.ts`.
  if ((await page.getByLabel(label, { exact: true }).getAttribute('type')) !== 'date') {
    await page.getByLabel(label, { exact: true }).click();
  }
  const box = page.getByLabel(label, { exact: true });
  await expect(box).toHaveAttribute('type', 'date');
  await box.fill(day);
  // `blur`, not `press('Tab')`: Chrome's date input owns Tab for stepping
  // between its own day/month/year segments, so a Tab from the day segment
  // never leaves the field at all — probed here, `document.activeElement` was
  // still the box afterwards. Leaving is what saves, so leaving is what this
  // does.
  //
  // The response is awaited, and the `aria-busy` after it, because the write
  // and the refetch it starts are the window every toolbar control is disabled
  // for — a click that lands inside it is dropped on the floor. Playwright's
  // own "wait until enabled" cannot see that: the button is still enabled at
  // the moment it is checked and goes dead a tick later, which is the same race
  // a person loses by hand.
  const saved = page.waitForResponse((response) => response.request().method() === 'PATCH');
  await box.blur();
  await saved;
  await expect(page.locator('[data-toolbar]')).toHaveAttribute('aria-busy', 'false');
}

/**
 * The Gantt panel, measured by the engine that draws it.
 *
 * `gantt-geometry.test.ts` and `gantt-panel.test.tsx` are tests about
 * **numbers**: that a 3.5→6 slice reaches `x="3.5"`, that a parent's row holds
 * no mark, that a caret's points are above a bar's top edge. Every one of them is an
 * attribute, because jsdom lays nothing out — and this panel's whole contract
 * is a layout. `viewBox="0 0 horizon rowCount"` with
 * `preserveAspectRatio="none"` over a CSS box of `horizon × DAY_PX` by
 * `rowCount × ROW_PX` is a claim about a **transform a browser performs**, and
 * nothing without a rendering engine can be asked whether it holds.
 *
 * Six things live here and nowhere else:
 *
 * 1. **The scale.** That the **calendar day** the engine's workday resolves to
 *    is the pixel the browser draws the bar at, and that the HTML axis cell
 *    above it — a different element, in a different box, positioned by the same
 *    `DAY_PX` — lands on the same edge. jsdom can watch both numbers be
 *    computed and can never watch them meet. The seeded plan reaches past its
 *    own first weekend on purpose; see {@link PAST_THE_WEEKEND}.
 * 2. **The sticky label column.** `position: sticky` is layout, and a rule
 *    that arrives on an element proves only that it arrived.
 * 3. **The page not scrolling sideways**, at 1400 and at 390. The whole reason
 *    the panel has a scroll container of its own.
 * 4. **Click-to-row.** `scrollIntoView` and the focus that follows it are
 *    default actions, and jsdom performs none — the exact shape of R5 faults
 *    #14 and #15, where a synthetic event in jsdom watched a guard be deleted
 *    and could not watch it be left half-done.
 * 5. **The marks a live Chrome found invisible** on 2026-08-09, after every one
 *    of them was drawn, gated and green: a dependency arrow with no head,
 *    collapsed onto the successor's own left edge whenever the two bars
 *    touched; a not-before flag painted underneath the bar it belongs to; and a
 *    1px summary bracket. All were faults of **where** and **how heavy**, which
 *    is to say faults of pixels. The bracket outlived two redrawings and is
 *    behind the detail switch since `declutter-one-button`; it is measured in
 *    both states here, and the row it stands on is asserted to be there and
 *    empty at rest either way.
 * 6. **A stroke width.** `[stroke-width:2]` in a class attribute is a string;
 *    `getComputedStyle(...).strokeWidth` is the browser's answer.
 *
 * `DAY_PX` and `ROW_PX` are imported from the panel rather than written out
 * here, the way `layout.spec.ts` imports `table-frame`'s widths: a copy of a
 * constant is a second declaration that agrees until somebody changes one.
 */

/** The Monday the seeded plan begins on, so every workday offset is a weekday. */
const PLAN_START = '2026-08-10';

/**
 * The seeded plan's own scale, imported rather than re-derived here.
 *
 * The pixel a bar is drawn at is `startOf(data-start) × DAY_PX`, and the number
 * it is drawn at is the panel's own answer for the same workday — the two sides
 * of the transform this file exists to measure. A copy of the formula written
 * out here would be a second declaration that agrees until somebody changes one,
 * which is `layout.spec.ts`'s rule about `table-frame`'s widths.
 */
const SCALE = calendarScale(PLAN_START);

/**
 * A three-point estimate wide enough that the plan reaches past its own first
 * weekend.
 *
 * `2/4/6` is four days by PERT, and four workdays from a Monday is still the
 * same week: every calendar offset would equal its workday number and the whole
 * alignment check below would hold just as well on the axis this change
 * replaced. Six days puts the second leaf on the Tuesday after the weekend,
 * where the two numbers are two apart.
 */
const PAST_THE_WEEKEND = '6/6/6';

/**
 * How far a measured edge may be from the edge the arithmetic says, in CSS px.
 *
 * One pixel, and it is a tolerance for sub-pixel layout rather than for drift:
 * everything here runs at `deviceScaleFactor: 1`, and the numbers being
 * compared are a rect from the browser against a product of two integers.
 */
const NEARLY = 1;

/** The row of the plan holding this work item number, on the table face. */
const rowOf = (page: Page, number: string): Locator =>
  page.locator('tbody tr').filter({ has: page.getByLabel(`Name of ${number}`) });

/**
 * Signs up a throwaway account and builds the smallest plan that draws every
 * mark this file measures.
 *
 * Three rows: `010` is a parent, so its row is drawn empty rather than with a
 * bar; `010.1` and `010.2` are its leaves, and `010.2` waits for `010.1`. That
 * dependency is the point — a finish-to-start edge with no lag puts the
 * successor's start **on** the predecessor's finish, which is the commonest
 * shape in any plan and the one whose arrow used to collapse onto the
 * successor's own left edge.
 *
 * The not-before date is read off `010.2`'s own Start cell rather than computed
 * here, so the caret and the bar's left edge are the same workday whatever the
 * estimate is: the adjacency case, which is where the old flag disappeared
 * under the bar. Reading it out of the table also means the constraint does not
 * move the schedule — it names the day the row already starts on.
 *
 * @param page The page to seed, which it also navigates.
 * @param account The username to register, unique per test.
 * @param fixture What the two leaves are given beyond their shape.
 * @param fixture.estimate The three-point Dev estimate both leaves get. `2/4/6`
 * is four days by PERT, which is a small chart and stays inside the plan's
 * first week; the scale tests pass {@link PAST_THE_WEEKEND} and the
 * sticky-label tests one wider than the window.
 * @param fixture.extraRows Roots added after the three, for the tests that need
 * a plan taller than its own frame.
 * @param fixture.costedExtras Whether those extra roots are given the same Dev
 * estimate as the leaves. They draw a bar each when they are and **nothing at
 * all** when they are not (`gantt-declutter`), so a test that needs a mark at
 * the bottom of a tall chart — rather than only rows down there — asks for
 * this. Off by default: the tests that want height alone should not pay for
 * sixteen estimates they never read.
 */
async function seedPlan(
  page: Page,
  account: string,
  fixture: { estimate?: string; extraRows?: number; costedExtras?: boolean } = {},
): Promise<void> {
  const { estimate = '2/4/6', extraRows = 0, costedExtras = false } = fixture;
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByLabel('Username').fill(account);
  await page.getByLabel('Password').fill('gantt-gate-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();

  // First, because the Not before field is disabled without a day zero to
  // count from — and a chart of workday offsets has no axis dates to check.
  await setDate(page, 'Project start date', PLAN_START);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // Tab at the caret's home position is the outliner's indent, and it puts the
  // row under its **previous sibling**. Twice on `020` and not on `020` then
  // `030`: indenting the first `020` renumbers what was `030` down to `020`,
  // and the second press then takes that row under `010` as well.
  for (const step of [0, 1]) {
    const box = page.getByLabel('Name of 020');
    await box.focus();
    await box.press('Tab');
    await expect(page.getByLabel(`Name of 010.${String(step + 1)}`)).toBeVisible();
  }

  for (const number of ['010.1', '010.2']) {
    const box = page.getByLabel(`Dev estimate for ${number}`);
    await box.fill(estimate);
    await box.blur();
    await expect(box).not.toHaveValue('');
  }

  const depends = page.getByLabel('Add a dependency to 010.2');
  await depends.click();
  await depends.fill('010.1');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 010.2 waiting for 010.1' })).toBeVisible();

  // The day be-01 says this row starts, typed back in as the day it may not
  // start before: the caret and the bar's left edge on the same workday.
  // From the cell's `title`, not its text: the columns print `14 Aug` since `T2
  // compact-columns` and carry the whole `YYYY-MM-DD` in the attribute.
  //
  // **The first of two facts**, since `row-start-floor`: the `title` reads
  // `2026-08-14 — Waits for a dependency’s first estimated role`, the `End`
  // cell's own shape. This helper wants the day alone, and the guard below is
  // kept rather than loosened to a prefix match — it is what turned that change
  // into 26 named failures instead of a fixture quietly holding the wrong row
  // at the wrong date.
  const title = await rowOf(page, '010.2').locator('[data-start]').getAttribute('title');
  const startsOn = title?.split(' — ')[0] ?? null;
  if (startsOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) {
    throw new Error(`010.2's Start cell reads ${String(title)}, which has no date to hold it at`);
  }
  await setDate(page, 'Earliest start for 010.2', startsOn);

  for (let added = 0; added < extraRows; added += 1) {
    const number = String((added + 2) * 10).padStart(3, '0');
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
    if (costedExtras) {
      const box = page.getByLabel(`Dev estimate for ${number}`);
      await box.fill(estimate);
      await box.blur();
      await expect(box).not.toHaveValue('');
    }
  }
}

/**
 * The smallest plan whose arrows leave the schedule at **both** ends.
 *
 * Four roots and two dependencies, and no indenting: `020` waits for `010` and
 * neither is estimated, so both sit at workday 0 — the successor's start is the
 * canvas's own left edge, which is where an arrow's approach goes negative.
 * `040` waits for the estimated `030`, so it starts at the far end of the
 * schedule and its arrow's outward leg reaches past it.
 *
 * Unestimated on purpose rather than by omission: it is the state every row of
 * every plan is in for its first few minutes, so the left-edge arrow is not an
 * edge case at all.
 */
async function seedEdgeRoutes(page: Page, account: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByLabel('Username').fill(account);
  await page.getByLabel('Password').fill('gantt-gate-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
  await setDate(page, 'Project start date', PLAN_START);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030', '040']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // The one estimate in the plan, so the horizon is four workdays and `040`
  // starts on it.
  const estimate = page.getByLabel('Dev estimate for 030');
  await estimate.fill('2/4/6');
  await estimate.blur();
  await expect(estimate).not.toHaveValue('');

  for (const [waiting, on] of [
    ['020', '010'],
    ['040', '030'],
  ]) {
    const depends = page.getByLabel(`Add a dependency to ${waiting}`);
    await depends.click();
    await depends.fill(on);
    await depends.press('Enter');
    await expect(
      page.getByRole('button', { name: `Stop ${waiting} waiting for ${on}` }),
    ).toBeVisible();
    // Enter commits the chip and leaves the list open on what is still
    // pickable, and that list hangs over the rows underneath — so the next
    // row's own box is behind it and the click below landed on an option
    // instead. Only since `column-rebalance`: the rows were two lines tall
    // while the 52px date columns wrapped their days, and the list stopped
    // short of the row this loop goes to next. Escape is the picker's own way
    // out, and it is asserted rather than assumed.
    await depends.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
  }
}

/**
 * Opens the Gantt panel and waits until it has drawn something.
 *
 * The toggle is one toolbar control under both renderers, but below the phone
 * breakpoint that toolbar is a sheet — so which gesture opens the chart is the
 * face's business and this is where it is written down once.
 */
async function openTheChart(
  page: Page,
  { throughTheSheet = false, drawn = '[data-gantt-bar]' } = {},
): Promise<void> {
  if (throughTheSheet) {
    await page.getByRole('button', { name: 'Plan actions' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('[data-gantt-chart]')).toBeVisible();
  // A chart with nothing on it would make every measurement below vacuous. The
  // mark is a parameter because a fixture may be about a mark other than a bar
  // — an arrow's route off either end of the schedule, say — and waiting on the
  // bars would say nothing about whether that mark was drawn.
  await expect(page.locator(drawn).first()).toBeVisible();
}

/**
 * Presses the detail switch and waits for the marks it draws.
 *
 * The chart opens with none of the three gated families since
 * `declutter-one-button` — no arrows, no parent brackets, no assumed bars — so
 * every measurement of an elbow, a head, a ghost or a guessed width has to ask
 * for them first. The counts are asserted rather than assumed: a click that
 * landed on nothing would otherwise leave the assertions below measuring a
 * chart with none of it on, which is exactly how R5 #14 and #15 hid.
 *
 * The press is also the half jsdom cannot answer at all: a real click on a
 * button inside a sticky, z-indexed subtree of an `overflow-auto` scroller is
 * the arrangement that has eaten clicks here twice.
 *
 * @param page The page holding the chart.
 * @param heads How many arrow heads the fixture draws once they are asked for.
 */
async function askForTheDetail(page: Page, heads: number): Promise<void> {
  await expect(
    page.locator('[data-gantt-arrow]'),
    'the chart drew arrows before anybody asked for them',
  ).toHaveCount(0);
  await expect(
    page.locator('[data-gantt-detail-toggle]'),
    'the detail switch was already pressed before this test asked',
  ).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-gantt-detail-toggle]').click();
  await expect(page.locator('[data-gantt-arrow-head]')).toHaveCount(heads);
  await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute('aria-pressed', 'true');
}

/** One rectangle, as the browser lays it out. */
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The rectangle of the one element this selector matches.
 *
 * @throws When nothing matches, or when the box has no area — an empty rect
 * compares equal to another empty rect, and two marks that are both not drawn
 * would agree about everything.
 */
async function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((where) => {
    const node = document.querySelector(where);
    if (node === null) throw new Error(`nothing on the page at ${where}`);
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(`${where} is drawn with no area: ${String(box.width)}×${String(box.height)}`);
    }
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  }, selector);
}

/**
 * What the browser actually paints at a point inside a mark's own box.
 *
 * The one question `getBoundingClientRect` cannot answer, and the reason this
 * fix needed a browser: an `<svg>` carries the UA's `overflow: hidden`, so a
 * path routed outside the viewBox is **not painted and not hit-testable** —
 * while its box goes on measuring exactly as if it were there. Every jsdom
 * assertion about such a mark passes, and so does every rectangle assertion
 * here. `elementFromPoint` is the browser saying which ink is on that pixel.
 *
 * @param page The page holding the chart.
 * @param selector The mark to probe.
 * @param at How far across the box to probe, 0 → 1. The arrow head is a
 * triangle pointing right, so a quarter in is thick and the tip is not.
 * @returns `'itself'` when the mark is what is painted there, and otherwise a
 * description of what was, so the failure names the thing in the way.
 * @throws When nothing matches the selector, or the box has no area.
 */
async function paintedAt(page: Page, selector: string, at = 0.25): Promise<string> {
  return page.evaluate(
    ({ where, across }) => {
      const node = document.querySelector(where);
      if (node === null) throw new Error(`nothing on the page at ${where}`);
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        throw new Error(`${where} is drawn with no area to probe`);
      }
      const hit = document.elementFromPoint(
        box.left + box.width * across,
        box.top + box.height / 2,
      );
      if (hit === node) return 'itself';
      if (hit === null) return 'nothing at all — the point is off the viewport';
      const attributes = [...hit.attributes].map((each) => each.name).join(' ');
      return `<${hit.tagName} ${attributes}>`;
    },
    { where: selector, across: at },
  );
}

/**
 * Puts the chart at its far right edge, and says how far that was.
 *
 * @throws When the chart does not scroll at all. Every sticky assertion below
 * would otherwise be made about an unscrolled chart, where a label column that
 * held nothing would hold the left edge anyway — the vacuity `layout.spec.ts`
 * guards the same way.
 */
async function scrollChartFullyRight(page: Page): Promise<number> {
  const reached = await page.evaluate(() => {
    const panel = document.querySelector('[data-gantt-panel]');
    if (panel === null) throw new Error('the Gantt panel is not on the page');
    panel.scrollLeft = panel.scrollWidth;
    return panel.scrollLeft;
  });
  expect(
    reached,
    'the chart is not wider than its panel, so nothing was scrolled past',
  ).toBeGreaterThan(0);
  return reached;
}

/**
 * Seeds the plan at laptop width, and hands the page back at the viewport it
 * came in on.
 *
 * The phone tests are about the **chart** on a phone. Typing a three-point
 * estimate and a dependency into a card through the toolbar sheet is
 * `mobile.spec.ts`'s subject and is proved there; a second seeding path here
 * would fail about the sheet rather than about the chart. The renderer swaps on
 * `window.innerWidth` through a resize listener (`plan-renderer.ts`), so the
 * plan a laptop typed is the plan a phone draws — and the assertion below is
 * what says the swap happened rather than assuming it.
 *
 * @throws When the project declares no viewport, which would leave nothing to
 * restore and quietly measure a phone claim at 1400px.
 */
async function seedOnALaptop(
  page: Page,
  account: string,
  options: { estimate?: string; extraRows?: number } = {},
): Promise<void> {
  const phone = page.viewportSize();
  if (phone === null) throw new Error('this project declares no viewport to seed away from');
  await page.setViewportSize({ width: 1400, height: 900 });
  await seedPlan(page, account, options);
  await page.setViewportSize(phone);
  await expect(page.locator('[data-plan-cards]')).toBeVisible();
}

let account = 0;

test.beforeEach(() => {
  account += 1;
});

const nextAccount = (): string => `e2e-chart-${String(Date.now())}-${String(account)}`;

test.describe('the chart, after the browser has scaled it', () => {
  test('draws a bar at the pixel its calendar day says, under its own axis cell', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    const chart = await rectOf(page, '[data-gantt-chart]');
    const drawn = await page.evaluate(() =>
      [...document.querySelectorAll('[data-gantt-bar]')].map((bar) => {
        const box = bar.getBoundingClientRect();
        return {
          id: bar.getAttribute('data-gantt-bar') ?? '(a bar with no slice id)',
          // The engine's own **workday** number, carried on the element beside
          // the calendar geometry the browser drew from it.
          start: Number(bar.getAttribute('data-start')),
          userY: Number(bar.getAttribute('y')),
          left: box.left,
          top: box.top,
        };
      }),
    );
    expect(drawn.length, 'the seeded plan drew no bars to measure').toBeGreaterThan(0);
    const bars = drawn.map((bar) => ({ ...bar, at: SCALE.startOf(bar.start) }));

    // The fixture really does reach past its own first weekend, where the
    // calendar day and the workday are different numbers. Without this the
    // whole check below holds exactly as well on the axis this change replaced
    // — which is the shape of check R5 exists to stop, and it was watched
    // holding on the narrower plan before the estimate was widened.
    expect(
      bars.some((bar) => bar.at !== bar.start),
      'no bar in this plan is past a weekend, so the scale is not being measured',
    ).toBe(true);

    // The transform itself, on both axes: one calendar day is `DAY_PX` across
    // and one row is `ROW_PX` down, which is what `preserveAspectRatio="none"`
    // over a viewBox of days by rows means and what no jsdom test can perform.
    //
    // `CHART_PAD_PX` is in the arithmetic because the canvas begins one band
    // left of day 0 — the band the arrow routes and the caret live in, and
    // without which a browser clips them.
    for (const bar of bars) {
      expect(
        Math.abs(bar.left - chart.left - CHART_PAD_PX - bar.at * DAY_PX),
        `${bar.id} is not ${String(bar.at)} calendar days from the plan's first day`,
      ).toBeLessThanOrEqual(NEARLY);
      expect(
        Math.abs(bar.top - chart.top - bar.userY * ROW_PX),
        `${bar.id} is not on its own row`,
      ).toBeLessThanOrEqual(NEARLY);
    }

    // And the axis, which is HTML in a different box entirely: the cell for the
    // calendar day a bar starts on has to begin at the same pixel the bar does.
    // Two arrangements sized by the same constant, asserted against each other
    // rather than against the constant — and the cell is found by **calendar
    // offset**, because that is what a cell now stands for.
    //
    // Only the bars the axis has a cell for: whether the last bar starts on the
    // last cell is a fact about the fixture and not about the scale.
    const cells = await page.locator('[data-axis-day]').count();
    const printed = bars.filter((bar) => bar.at < cells);
    expect(printed, 'no bar starts on a day the axis prints').not.toHaveLength(0);
    for (const bar of printed) {
      const cell = await rectOf(page, `[data-axis-day="${String(bar.at)}"]`);
      expect(
        Math.abs(bar.left - cell.left),
        `${bar.id} does not begin under the axis cell for calendar day ${String(bar.at)}`,
      ).toBeLessThanOrEqual(NEARLY);
      // And that cell carries the workday the bar says it is on, which is the
      // join between the engine's number and the drawing's.
      await expect(page.locator(`[data-axis-day="${String(bar.at)}"]`)).toHaveAttribute(
        'data-axis-workday',
        String(bar.start),
      );
    }

    // The weekend is on the axis and under it, which is what the change is for:
    // cells 5 and 6 of a Monday-start plan are the Saturday and the Sunday, and
    // each has a column of its own in the chart.
    await expect(page.locator('[data-axis-day="5"]')).toHaveAttribute('data-axis-weekend', 'true');
    await expect(page.locator('[data-axis-day="6"]')).toHaveAttribute('data-axis-weekend', 'true');
    const saturday = await rectOf(page, '[data-gantt-weekend="5"]');
    expect(
      Math.abs(saturday.width - DAY_PX),
      'the Saturday column is not one day wide',
    ).toBeLessThanOrEqual(NEARLY);
    const fifthCell = await rectOf(page, '[data-axis-day="5"]');
    expect(
      Math.abs(saturday.left - fifthCell.left),
      'the Saturday column does not stand under its own axis cell',
    ).toBeLessThanOrEqual(NEARLY);
  });

  /**
   * The two marks the live inspection found, measured as rectangles.
   *
   * Each of them was drawn, and each of them was gated by a test that read its
   * `d` attribute. What none of those could say is whether the ink lands
   * anywhere a reader can see it.
   *
   * The third was the parent's ghost bar. It is behind the detail switch since
   * `declutter-one-button`, so this measures it in both states: absent on the
   * chart the reader opens, drawn once asked for, and the row alignment it was
   * standing in the middle of true either way.
   */
  test('draws the arrow head and the caret where they can be seen', async ({ page }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    // The chart at rest, before anything is asked of it: no ghost on the
    // parent's row, and one label per row of the plan all the same. Taken here
    // rather than after the press, because the press is what draws the ghost.
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
    const restingRows = await page.locator('tbody tr').count();
    expect(restingRows, 'the seeded plan has no rows to line the chart up against').toBe(3);
    await expect(page.locator('[data-gantt-label]')).toHaveCount(restingRows);

    await askForTheDetail(page, 1);

    // The bar the caret belongs to, found through the caret's own row and not
    // by counting: the first attempt at this took `bars.at(1)` on the reasoning
    // that `010` is a parent and draws no bar, and a new project lists **two**
    // roles — so index 1 is `010.1`'s unestimated QA slice, sitting at the same
    // workday as the bar that was wanted. Every assertion below passed against
    // it, including with the caret put back on top of the real bar: a
    // zero-height box cannot be overlapped. Watched, which is why the width is
    // asserted here.
    //
    // The costed bar specifically, through `:not([data-assumed])`. The detail
    // switch is on by now, so the row holds its uncosted QA slice's bar as well
    // — at the same workday, and since `declutter-one-button` with a real width
    // rather than the zero one R5 #16 could not fail against. The `!== 1` below
    // is what says the filter picked exactly one, rather than a filter quietly
    // picking a survivor.
    const successor = await page.evaluate(() => {
      const caret = document.querySelector('[data-gantt-not-before]');
      if (caret === null) throw new Error('no not-before caret was drawn to find a row by');
      const row = caret.getAttribute('data-gantt-not-before');
      const drawn = [...document.querySelectorAll('[data-gantt-bar]:not([data-assumed])')].filter(
        (bar) =>
          Math.floor(Number(bar.getAttribute('y'))) === Number(row) &&
          bar.getBoundingClientRect().width > 0,
      );
      if (drawn.length !== 1) {
        throw new Error(`row ${String(row)} holds ${String(drawn.length)} drawn bars, not one`);
      }
      const box = drawn[0].getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    });
    expect(successor.width, 'the successor’s bar has no width to measure against').toBeGreaterThan(
      0,
    );
    expect(
      successor.height,
      'the successor’s bar has no height to measure against',
    ).toBeGreaterThan(0);

    // 1. The head exists, has area, and its point is at the successor's left
    //    edge — which is the fact "the arrow has an arrowhead" reduces to.
    const head = await rectOf(page, '[data-gantt-arrow-head]');
    expect(
      Math.abs(head.right - successor.left),
      'the arrow head does not point at the successor’s left edge',
    ).toBeLessThanOrEqual(NEARLY);
    expect(head.left, 'the arrow head is not in front of the bar it points at').toBeLessThan(
      successor.left,
    );
    // And it is **painted**, which is a different claim from the three above:
    // a head clipped off the canvas reports this same box and puts no ink
    // anywhere. See {@link paintedAt}. The left-edge case, where that actually
    // happened, is the test below.
    expect(
      await paintedAt(page, '[data-gantt-arrow-head]'),
      'nothing of the arrow head is painted where its box says it is',
    ).toBe('itself');
    const viewport = page.viewportSize();
    expect(viewport, 'this project declares no viewport').not.toBeNull();
    expect(head.top).toBeGreaterThanOrEqual(0);
    expect(head.bottom).toBeLessThanOrEqual(viewport?.height ?? 0);

    // 2. The caret is clear of the bar it belongs to. The bar starts on the
    //    constrained day, so the two share an x — which is exactly the case
    //    that used to hide the flag, and the reason this is an intersection
    //    test rather than a "is it drawn" one.
    const caret = await rectOf(page, '[data-gantt-not-before]');
    const overlaps =
      caret.left < successor.right &&
      caret.right > successor.left &&
      caret.top < successor.bottom &&
      caret.bottom > successor.top;
    expect(overlaps, 'the not-before caret is drawn over the bar it belongs to').toBe(false);
    expect(
      Math.abs(caret.left - successor.left),
      'the caret does not stand at the day the bar starts on',
    ).toBeLessThanOrEqual(NEARLY);

    // 3. The parent's row: the ghost the switch has just drawn, with area, on
    //    the parent's own row — and the row count unmoved. The plan holds three
    //    rows — `010` and its two leaves — and the chart holds three labels
    //    beside them in both states, which is the alignment the table depends
    //    on and the thing the ghost bar was standing in the middle of. Counted
    //    against the table rather than against a number written here: a chart
    //    that dropped the parent's row would agree with a `3` and disagree
    //    with the plan.
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    const ghost = await rectOf(page, '[data-gantt-bracket]');
    expect(ghost.width, 'the parent’s ghost bar has no width a reader could see').toBeGreaterThan(
      0,
    );
    expect(ghost.top, 'the parent’s ghost is not on the top row of the chart').toBeLessThan(
      successor.top,
    );
    const planRows = await page.locator('tbody tr').count();
    expect(planRows, 'the seeded plan has no rows to line the chart up against').toBe(restingRows);
    await expect(page.locator('[data-gantt-label]')).toHaveCount(planRows);

    // 4. The paint, as the browser computed it rather than as a class
    //    attribute spells it: the arrow's stroke is heavy enough to be seen.
    const arrowStroke = await page.evaluate(() => {
      const arrow = document.querySelector('[data-gantt-arrow]');
      if (arrow === null) throw new Error('nothing on the chart at [data-gantt-arrow]');
      return Number.parseFloat(getComputedStyle(arrow).strokeWidth);
    });
    expect(arrowStroke, 'the dependency arrow is a hairline').toBeGreaterThanOrEqual(1.5);

    // 5. And the successor's bar really is past the plan's first weekend, so
    //    every measurement above was taken where a calendar coordinate and a
    //    workday number are different. On the narrower fixture this plan used
    //    to be seeded with they were the same and none of it was being tested.
    const onCalendar = await page.evaluate(() => {
      const caret = document.querySelector('[data-gantt-not-before]');
      if (caret === null) throw new Error('no not-before caret was drawn');
      const row = caret.getAttribute('data-gantt-not-before');
      const bar = [...document.querySelectorAll('[data-gantt-bar]:not([data-assumed])')].find(
        (each) => Math.floor(Number(each.getAttribute('y'))) === Number(row),
      );
      if (bar === undefined) throw new Error(`row ${String(row)} holds no drawn bar`);
      return { start: Number(bar.getAttribute('data-start')), x: Number(bar.getAttribute('x')) };
    });
    expect(
      onCalendar.x,
      'the successor is inside the first week, where a workday number is already a calendar day',
    ).toBeGreaterThan(onCalendar.start);
  });

  /**
   * The two arrows that route outside the schedule, and the fix that lets them
   * be seen.
   *
   * `arrowRoute` steps `ARROW_APPROACH_PX` clear of a bar before it turns, so a
   * successor at **workday 0** is approached through negative x and an arrow off
   * the **last** bar leaves past the horizon. The canvas used to be the
   * schedule exactly, and an `<svg>`'s own `overflow: hidden` clipped both: the
   * head of a left-edge arrow painted nothing at all, measured here, while its
   * `getBoundingClientRect` went on reporting a box 7px wide. jsdom cannot hold
   * this — it has no clip and no hit test — so this is the only place the fix
   * is a fact.
   */
  test('paints an arrow that routes off either end of the schedule', async ({ page }) => {
    await seedEdgeRoutes(page, nextAccount());
    // The one estimated row draws the one bar at rest, and the detail is asked
    // for after it: an arrow is drawn from the **rows'** own schedule, so the
    // two uncosted rows have routes between them either way.
    await openTheChart(page);
    // Two arrows: `020` waits for `010` and both are unestimated, so the
    // successor starts at workday 0 and the route reaches left of the
    // schedule; `040` waits for the estimated `030`, so it starts at the far
    // end of it and the route reaches right of that. Asserted inside the
    // helper, because one arrow would make half of this test vacuous.
    await askForTheDetail(page, 2);

    // 1. Every mark's box is inside the canvas it is drawn on. This is the
    //    arithmetic the padded viewBox exists for, and it is measurable here
    //    because a clipped box still measures — it is the *canvas* that moved.
    const chart = await rectOf(page, '[data-gantt-chart]');
    const outside = await page.evaluate((canvas) => {
      const marks = [...document.querySelectorAll('[data-gantt-arrow], [data-gantt-arrow-head]')];
      if (marks.length === 0) throw new Error('no arrows on the chart to measure');
      return marks
        .map((mark) => ({ name: mark.getAttribute('d') ?? '', box: mark.getBoundingClientRect() }))
        .filter((mark) => mark.box.left < canvas.left - 1 || mark.box.right > canvas.right + 1)
        .map((mark) => mark.name);
    }, chart);
    expect(outside, 'a mark is drawn outside the canvas, where nothing paints').toEqual([]);

    // 2. And the ink is really there. `elementFromPoint` at the left-most
    //    head's own centre: the case that used to paint zero pixels.
    //
    // Proof: the viewBox put back to `0 0 horizon rowCount`, the SVG's width
    // back to `horizon * DAY_PX`, and the axis's and labels' `CHART_PAD_PX`
    // offsets removed — the drawing as it was. Assertion 1 failed first, on `a
    // mark is drawn outside the canvas, where nothing paints`, listing all
    // three: the left-edge elbow `M 0 0.5 L 0.357… L -0.357… L 0 1.5`, its head
    // `M 0 1.5 L -0.25 1.375 L -0.25 1.625 Z`, and the right-edge elbow out to
    // `4.357…` past a horizon of 4. With that assertion replaced by a `void`,
    // assertion 2 failed on `the left-edge arrow head is not painted at its own
    // centre: expected "itself", received "<BUTTON type data-gantt-label title
    // class style>"` — the row label the clipped head's pixel actually belongs
    // to. Watched 2026-08-09.
    const heads = page.locator('[data-gantt-arrow-head]');
    const boxes = await heads.evaluateAll((marks) =>
      marks.map((mark, index) => ({ index, left: mark.getBoundingClientRect().left })),
    );
    const leftmost = [...boxes].sort((one, other) => one.left - other.left)[0];
    expect(leftmost, 'no arrow head to probe').toBeDefined();
    const id = await heads.nth(leftmost.index).getAttribute('data-gantt-arrow-head');
    expect(
      await paintedAt(page, `[data-gantt-arrow-head="${String(id)}"]`),
      'the left-edge arrow head is not painted at its own centre',
    ).toBe('itself');

    // 3. And the switch takes every mark away again. The click is the half
    //    jsdom cannot answer: a real press on a button inside a sticky,
    //    z-indexed subtree of an overflow-auto scroller — the exact
    //    arrangement that has eaten clicks here twice (R5 #14, #15).
    await page.locator('[data-gantt-detail-toggle]').click();
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-arrow-head]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
  });

  /**
   * The switch's answer, across a reload.
   *
   * jsdom can watch the state be read back on a remount; only a browser can say
   * that what a real click wrote is still there after the page has been thrown
   * away and rebuilt from storage — the session, the remembered project and the
   * preference all read at boot.
   */
  test('opens with the detail off, and keeps the answer through a reload', async ({ page }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    // The chart this plan opens with: costed bars, and none of the three gated
    // families. Both halves, so a chart that drew nothing at all could not pass
    // the absences alone.
    await expect(page.locator('[data-gantt-bar]').first()).toBeVisible();
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await askForTheDetail(page, 1);

    await page.reload();
    await openTheChart(page, { drawn: '[data-gantt-arrow-head]' });
    // All three families across the reload, and not the arrows alone: the
    // stored answer is one answer about the whole chart, which is the change.
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(1);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    await expect(page.locator('[data-assumed]')).toHaveCount(2);
    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // And off again, remembered the same way round: a preference that only
    // ever remembers "on" is a switch with one direction.
    await page.locator('[data-gantt-detail-toggle]').click();
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);
    await page.reload();
    await openTheChart(page);
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
  });

  /**
   * The bars a fresh plan draws at rest, and the ones one press brings back.
   *
   * A new project lists two roles, and a leaf estimated for one of them draws a
   * dashed bar for the other — two bars a row, half of them widths nobody gave,
   * beside the parent's own ghost. At rest that is five marks on a three-row
   * chart and the reader sees two; the detail switch is the one control that
   * decides between them, which is the whole of `declutter-one-button`.
   *
   * The counts are the assertion, in both directions, and every drawn mark is
   * measured for area: a count of marks is not a count of things a reader can
   * see, which is the sixteenth check's lesson.
   */
  test('draws only costed work at rest, and every mark once the detail is asked for', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    /** Every drawn bar's width, as the browser lays it out. */
    const barWidths = async (): Promise<number[]> =>
      page
        .locator('[data-gantt-bar]')
        .evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));

    // Two leaves, each estimated for Dev alone, under a parent that draws
    // nothing: two bars on a three-row chart.
    await expect(page.locator('[data-gantt-bar]')).toHaveCount(2);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
    const rows = await page.locator('tbody tr').count();
    expect(rows, 'the seeded plan has no rows to line the chart up against').toBe(3);
    await expect(page.locator('[data-gantt-label]')).toHaveCount(rows);
    expect(Math.min(...(await barWidths())), 'a drawn bar has no width at all').toBeGreaterThan(0);

    await page.locator('[data-gantt-detail-toggle]').click();

    // Asked for: four bars — the two Dev bars and the two uncosted QA slices —
    // and the parent's ghost over them. Five marks where the reader saw two.
    await expect(page.locator('[data-gantt-bar]')).toHaveCount(4);
    await expect(page.locator('[data-assumed]')).toHaveCount(2);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    // The plan and the chart still line up row for row, which is the one thing
    // the switch is not allowed to touch.
    await expect(page.locator('[data-gantt-label]')).toHaveCount(rows);
    expect(await page.locator('tbody tr').count()).toBe(rows);
    // And the marks it brought back are marks, not boxes of nothing: the
    // assumed bars have width, and so does the ghost.
    expect(
      Math.min(...(await barWidths())),
      'a bar the detail switch drew has no width at all',
    ).toBeGreaterThan(0);
    const ghost = await rectOf(page, '[data-gantt-bracket]');
    expect(ghost.width, 'the parent’s ghost bar has no width at all').toBeGreaterThan(0);
    expect(ghost.height, 'the parent’s ghost bar has no height at all').toBeGreaterThan(0);
  });

  test('holds the labels at the left edge with the chart scrolled fully right', async ({
    page,
  }) => {
    // Wide enough that 1400px cannot hold it: two chained 40-day slices is an
    // 80-workday horizon, which is 2240px of chart beside a 176px label column.
    await seedPlan(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page);
    await scrollChartFullyRight(page);

    const panel = await rectOf(page, '[data-gantt-panel]');
    const labels = await rectOf(page, '[data-gantt-labels]');
    expect(
      Math.abs(labels.left - panel.left),
      'the label column went with the chart instead of holding the edge',
    ).toBeLessThanOrEqual(NEARLY);

    // And the page itself never moved: the panel's own scroll container is what
    // takes the width, which is the half of design §4 a browser has to judge.
    const document_ = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(document_.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(
      document_.clientWidth,
    );
  });

  /**
   * The click that takes the plan to a row, in the one environment that
   * performs a default action.
   *
   * R5 #14 and #15 are both this shape: a jsdom test that dispatched a
   * synthetic event, watched the guard be deleted, and could never watch the
   * browser do the rest. `goToRow` focuses a cell and then calls
   * `scrollIntoView` behind a `typeof` guard — jsdom has no `scrollIntoView` at
   * all, so the guard's false branch is the **only** one its tests ever take.
   */
  test('scrolls the plan back to the row whose bar was clicked, and lands the caret', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount(), { extraRows: 12 });
    await openTheChart(page);

    // The plan pushed to its bottom, so the first leaf is off screen and
    // something has to happen for the caret to reach it.
    const scrolledTo = await page.evaluate(() => {
      const frame = document.querySelector('[data-table-frame]');
      if (frame === null) throw new Error('the scrolling frame is not on the page');
      frame.scrollTop = frame.scrollHeight;
      return frame.scrollTop;
    });
    expect(
      scrolledTo,
      'the plan is not taller than its frame, so nothing had to scroll back',
    ).toBeGreaterThan(0);

    // The first bar is `010.1`'s: `010` is a parent and draws no mark at all.
    // Asserted rather than assumed — a bar on the wrong row would make the
    // focus assertion below a different claim.
    const firstBar = page.locator('[data-gantt-bar]').first();
    await expect(firstBar).toHaveAttribute('data-start', '0');
    await firstBar.click();

    await expect(page.getByLabel('Name of 010.1')).toBeFocused();
    const after = await page.evaluate(() => {
      const frame = document.querySelector('[data-table-frame]');
      if (frame === null) throw new Error('the scrolling frame is not on the page');
      return frame.scrollTop;
    });
    expect(after, 'the plan did not scroll to the row the bar belongs to').toBeLessThan(scrolledTo);
    // And the box the caret is in is actually on screen, which is the thing
    // `scrollIntoView` was called for rather than a number about it.
    await expect(page.getByLabel('Name of 010.1')).toBeInViewport();
  });
});

/**
 * The chart while the plan under it is being edited.
 *
 * One claim: the open panel draws the read that followed the last edit, never
 * the one it was opened over. The pipeline is `run` → `refresh` →
 * `setChartRead` → a new `ganttPlan` every render, and every link in it is
 * invisible to jsdom the moment it is half-broken rather than deleted — the
 * exact shape of R5 faults #14 and #15 — so the claim is held here, in the
 * browser, against real requests.
 *
 * Proof: `refresh` in `wbs-table.tsx` given the fault its own comment names —
 * `setChartRead` keeping the slices it has whenever it has any — and this
 * failed inside `openTheChart` on `locator('[data-gantt-bar]').first()` never
 * becoming visible: the frozen slices named rows the plan had since
 * renumbered, `layOutGantt` refused the skew, and the boundary withheld the
 * whole chart. Restored, watched green. 2026-08-09.
 */
test.describe('the chart under a plan being edited', () => {
  test('redraws the open chart as each schedule input changes', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // The seeded plan in engine numbers: `010.1`'s Dev runs 0→4, and `010.2`,
    // held by the dependency and its own date at once, 4→8.
    const firstBar = page.locator('[data-gantt-bar]').first();
    await expect(firstBar).toHaveAttribute('data-finish', '4');

    // An estimate edit stretches the open bar: 2/4/6 → 8/10/12 is ten days by
    // PERT. The dependent `010.2` follows to day 10 — its own not-before still
    // names day 4, and the dependency out-floors it.
    const estimate = page.getByLabel('Dev estimate for 010.1');
    await estimate.fill('8/10/12');
    const savedEstimate = page.waitForResponse((response) => response.request().method() === 'PUT');
    await estimate.blur();
    await savedEstimate;
    await expect(firstBar).toHaveAttribute('data-finish', '10');
    await expect(page.locator('[data-gantt-bar][data-start="10"][data-finish="14"]')).toBeVisible();

    // A not-before edit past everything else moves the row's bar to the day it
    // names: 2026-09-07 is workday 20 of a plan starting Monday 2026-08-10.
    await setDate(page, 'Earliest start for 010.2', '2026-09-07');
    await expect(page.locator('[data-gantt-bar][data-start="20"][data-finish="24"]')).toBeVisible();
  });
});

/**
 * The same chart on a phone, where the toolbar is a sheet and the plan is
 * cards.
 *
 * Two claims and both are `M mobile-cards`' contract meeting this panel: the
 * chart takes its own scroll area rather than making the page one, and
 * click-to-row lands on the **card's** name box because `cellIn` names a cell
 * rather than a piece of markup.
 */
test.describe('the chart on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('holds its labels and leaves the page still', async ({ page }) => {
    await seedOnALaptop(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page, { throughTheSheet: true });
    await scrollChartFullyRight(page);

    const panel = await rectOf(page, '[data-gantt-panel]');
    const labels = await rectOf(page, '[data-gantt-labels]');
    expect(
      Math.abs(labels.left - panel.left),
      'the label column went with the chart instead of holding the edge',
    ).toBeLessThanOrEqual(NEARLY);

    const document_ = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    expect(document_.scrollWidth, 'the page scrolls sideways at 390').toBeLessThanOrEqual(
      document_.clientWidth,
    );
  });

  test('takes the cards face to a row when its bar is clicked', async ({ page }) => {
    // Enough cards that the list is taller than the phone: with three rows the
    // card is on screen wherever the list is, and every assertion below would
    // hold against a `goToRow` that scrolled nothing at all.
    await seedOnALaptop(page, nextAccount(), { extraRows: 12 });
    await openTheChart(page, { throughTheSheet: true });

    // The cards keep their own scroll area — `[data-plan-cards]`, not the page,
    // which never scrolls at all here. Measured rather than assumed: the
    // renderer's frame is `M mobile-cards`' and not this change's to know.
    const scrolledTo = await page.evaluate(() => {
      const cards = document.querySelector('[data-plan-cards]');
      if (cards === null) throw new Error('the phone is not showing the cards face');
      cards.scrollTop = cards.scrollHeight;
      return cards.scrollTop;
    });
    expect(
      scrolledTo,
      'the card list is not taller than the phone, so nothing had to scroll back',
    ).toBeGreaterThan(0);

    await page.locator('[data-gantt-bar]').first().click();

    await expect(page.getByLabel('Name of 010.1')).toBeFocused();
    const after = await page.evaluate(() => {
      const cards = document.querySelector('[data-plan-cards]');
      if (cards === null) throw new Error('the phone is not showing the cards face');
      return cards.scrollTop;
    });
    expect(after, 'the cards did not scroll to the row the bar belongs to').toBeLessThan(
      scrolledTo,
    );
    await expect(page.getByLabel('Name of 010.1')).toBeInViewport();
  });
});

/**
 * The hover surface a bar opens, which is the only thing on this chart that is
 * neither a mark nor a label.
 *
 * `role="tooltip"` and not a `data-` hook: it is the same the `HoverCard` the
 * Name cell opens, and naming it by its role is what says the two are one
 * surface rather than two that happen to look alike.
 */
const surface = (page: Page): Locator => page.getByRole('tooltip');

/**
 * The bar for one row **and one role**, found by the accessible name it carries.
 *
 * Never by its place in the list. A project is seeded with two phases, so every
 * leaf draws two bars and `[data-gantt-bar].nth(1)` is the *first* row's QA
 * slice rather than the second row's Dev one — the sixteenth check's own fault,
 * met again while writing this file and caught only because the dates on the
 * surface were a different row's. The label names both, which is what makes it
 * the handle: a bar found this way cannot be a bar about something else.
 */
const barOf = (page: Page, number: string, role: string): Locator =>
  page.locator(`[data-gantt-bar][aria-label^="${number} - "][aria-label*="${role} ·"]`);

/**
 * The rectangle of an element a locator names, or a throw.
 *
 * {@link rectOf} takes a selector and the surface is found by role, so this is
 * the same refusal on the other kind of handle: a box with no area compares
 * equal to every other box with no area, and two things that are both not
 * drawn would agree about everything.
 */
async function rectOfLocator(where: Locator, what: string): Promise<Rect> {
  const box = await where.boundingBox();
  if (box === null) throw new Error(`${what} is not on the page at all`);
  if (box.width <= 0 || box.height <= 0) {
    throw new Error(`${what} is drawn with no area: ${String(box.width)}×${String(box.height)}`);
  }
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  };
}

/** How far the Gantt panel is scrolled, in both directions. */
const panelScroll = (page: Page): Promise<{ left: number; top: number }> =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-gantt-panel]');
    if (panel === null) throw new Error('the Gantt panel is not on the page');
    return { left: panel.scrollLeft, top: panel.scrollTop };
  });

/**
 * The surface on a bar, and the three things only a browser can say about it.
 *
 * Every claim here is a **layout** claim, which is what puts them in this file
 * and not in `gantt-panel.test.tsx`: the surface is placed from a rectangle the
 * browser measured, flipped against a viewport height jsdom does not have, and
 * clamped against a width it does not have either. `surfacePlacement`'s own
 * arithmetic is unit-tested in `hover-card.test.tsx` on numbers handed to it;
 * that the numbers are ever measured at all is only true in here.
 */
test.describe('the surface a bar opens, as a browser places it', () => {
  test('reads the hovered bar’s own dates, with the chart scrolled partway', async ({ page }) => {
    // Wide enough that the panel really scrolls: at `PAST_THE_WEEKEND` the
    // whole chart fits in 1400px, `scrollLeft` stays 0 whatever it is set to,
    // and this would be a claim about an unscrolled chart. Measured, 2026-08-09.
    await seedPlan(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page);

    // Partway, and not at either end: a surface that only ever agreed with an
    // unscrolled chart would pass a check made at scrollLeft 0.
    await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      panel.scrollLeft = Math.floor(panel.scrollWidth / 3);
    });
    const scrolled = await panelScroll(page);
    expect(
      scrolled.left,
      'the chart did not scroll, so this is an unscrolled claim',
    ).toBeGreaterThan(0);

    // `010.2`'s **Dev** bar — the estimated one, and so the slice whose two
    // days are the row's own Start and End. Its left edge rather than its
    // middle: at forty days the bar is wider than the window, and a hover on
    // its centre would have Playwright scroll the chart to find it.
    const bar = barOf(page, '010.2', 'Dev');
    await bar.hover({ position: { x: 4, y: 4 } });
    await expect(surface(page)).toBeVisible();

    // The row's own printed days, off the table rather than computed here: two
    // derivations of one rule agree by construction and say nothing.
    const row = rowOf(page, '010.2');
    const from = await row.locator('[data-start]').textContent();
    const to = await row.locator('[data-finish]').textContent();
    expect(from, 'the Start cell prints nothing to compare against').not.toBe('');
    await expect(surface(page)).toContainText(`${String(from)} → ${String(to)}`);
    await expect(surface(page)).toContainText('010.2');
  });

  test('names an axis day’s month on hover, from the chart and not the browser', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // A dated cell past the first weekend, hovered by a real mouse: the card
    // is the chart's own `HoverCard`, portalled from a sticky axis inside an
    // overflow scroller — the arrangement jsdom cannot hit-test. The month in
    // words is the whole point of the card; the native title is gone, so the
    // browser has nothing slower to show instead.
    const cell = page.locator('[data-axis-day="7"]');
    await cell.hover();
    await expect(surface(page)).toBeVisible();
    await expect(surface(page)).toContainText(/[A-Z][a-z]{2} \d{4}/);
    await expect(cell).not.toHaveAttribute('title');
  });

  test('flips a surface above a bar that has no room below it', async ({ page }) => {
    // Costed extras, and that is this fixture's whole subject: the surface has
    // to open on a bar at the **bottom** of a tall chart, and a row nobody has
    // estimated draws no bar to open one on since `gantt-declutter`. Sixteen
    // uncosted rows give the panel height and leave the last mark up at row 2.
    await seedPlan(page, nextAccount(), { extraRows: 16, costedExtras: true });
    await openTheChart(page);

    // The panel at its bottom, so the last bar drawn stands on the panel's own
    // lower edge — which is the bottom of the window, this panel being the last
    // thing on the page.
    await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      panel.scrollTop = panel.scrollHeight;
    });

    const bar = page.locator('[data-gantt-bar]').last();
    await bar.hover();
    await expect(surface(page)).toBeVisible();

    // The bar first, and with an area — a mark of no height is one every
    // "above" comparison holds about (the sixteenth check).
    const mark = await rectOfLocator(bar, 'the last bar on the chart');
    const shown = await rectOfLocator(surface(page), 'the surface');
    const window_ = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    // The precondition: placed below, this surface would hang off the bottom.
    // Without it the flip has nothing to do and the assertion is about a
    // surface that would have been in the viewport anyway.
    expect(
      mark.bottom + shown.height,
      'this bar has room below it, so nothing had to flip',
    ).toBeGreaterThan(window_.height);
    expect(shown.bottom, 'the surface was not drawn above its bar').toBeLessThanOrEqual(
      mark.top + NEARLY,
    );
    expect(shown.top, 'the surface was flipped off the top of the window').toBeGreaterThanOrEqual(
      0,
    );
    expect(shown.bottom).toBeLessThanOrEqual(window_.height + NEARLY);
  });

  test('clamps the right-most bar’s surface inside the window', async ({ page }) => {
    await seedPlan(page, nextAccount());
    // A long first leaf and a short second one, so the right-most bar on the
    // chart is narrow and stands at the far end: a wide bar scrolled fully
    // right has its **left** edge in the middle of the window, where no clamp
    // is needed and the check below could not fail.
    const estimate = page.getByLabel('Dev estimate for 010.1');
    await estimate.fill('40/40/40');
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT');
    await estimate.blur();
    await saved;
    await openTheChart(page);
    await scrollChartFullyRight(page);

    const bar = page.locator('[data-gantt-bar]').last();
    await bar.hover();
    await expect(surface(page)).toBeVisible();

    const mark = await rectOfLocator(bar, 'the right-most bar');
    const shown = await rectOfLocator(surface(page), 'the surface');
    const width = await page.evaluate(() => window.innerWidth);
    // The precondition, and the whole reason this is not a check about a
    // surface that was inside the window all along: placed from the bar's own
    // left edge, this one would end past the right of the screen.
    expect(
      mark.left + shown.width,
      'this bar is far enough from the right edge that no clamp was needed',
    ).toBeGreaterThan(width);
    // **Its own rectangle**, and not `document.scrollWidth`: the layer is
    // `position: fixed`, so a surface hanging off the right edge widens
    // neither the page nor the panel and no scroll width can witness it.
    // Measured before this was believed — with the clamp deleted the page's
    // scrollWidth was unchanged and a scrollWidth check passed.
    expect(shown.left, 'the surface was clamped off the left edge').toBeGreaterThanOrEqual(0);
    expect(shown.right, 'the surface hangs off the right edge of the window').toBeLessThanOrEqual(
      width + NEARLY,
    );
  });

  test('takes the surface away when the panel is scrolled under it', async ({ page }) => {
    // Wide for the reason above: a panel with nothing to scroll fires no
    // scroll event, and the dismiss would look like it worked.
    await seedPlan(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page);

    await barOf(page, '010.1', 'Dev').hover({ position: { x: 4, y: 4 } });
    await expect(surface(page)).toBeVisible();

    await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      panel.scrollLeft += 120;
      if (panel.scrollLeft === 0) throw new Error('the panel did not scroll, so nothing dismissed');
    });

    // The surface is a fixed layer outside the panel's scroll box: the bar
    // moves and it does not, so a surface left open is one pointing at the
    // wrong bar.
    await expect(surface(page)).toHaveCount(0);
  });

  test('picks the row on Space, and does not scroll the panel doing it', async ({ page }) => {
    // Sixteen extra rows so the panel has somewhere to scroll **to**: Space's
    // own default is to page the nearest scrollable box, and a panel with no
    // overflow could not move whether or not the default was prevented.
    await seedPlan(page, nextAccount(), { extraRows: 16 });
    await openTheChart(page);

    await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      panel.scrollTop = 40;
      panel.scrollLeft = 20;
    });
    const bar = page.locator('[data-gantt-bar]').first();
    await expect(bar).toHaveAttribute('data-start', '0');
    const named = await page.getByLabel('Name of 010.1').inputValue();
    await bar.focus();
    await expect(bar).toBeFocused();
    const before = await panelScroll(page);
    expect(
      before.top,
      'the panel is not scrollable here, so a Space that scrolled it could not be seen',
    ).toBeGreaterThan(0);

    await page.keyboard.press(' ');

    await expect(page.getByLabel('Name of 010.1')).toBeFocused();
    // jsdom performs no default action at all, so this is the half of the
    // contract that only a browser can hold — R5 #14's shape exactly. Two
    // assertions, because the panel's scroll on its own **could not fail**:
    // the pick moves the focus into the row's name box before the browser
    // performs the key's default, and a Space typed into a text field scrolls
    // nothing at all. Watched, 2026-08-09: with `preventDefault` struck out,
    // the scroll assertion alone passed and this test was green about a bug.
    // What the unprevented Space actually does is put a space in the name.
    expect(await panelScroll(page), 'Space scrolled the chart out from under the reader').toEqual(
      before,
    );
    await expect(
      page.getByLabel('Name of 010.1'),
      'the Space reached the row’s name box and typed itself into it',
    ).toHaveValue(named);
  });
});

/**
 * The tap, on a device that really has touch.
 *
 * `hasTouch` is what makes Chromium synthesize a whole mouse sequence from a
 * tap — `pointerover`, `mouseover`, `mousemove`, `mousedown` — which is exactly
 * the seam the `pointerType` guard has to survive. A jsdom test cannot stand in
 * for this at any width: it dispatches whatever events it is told to and
 * synthesizes none.
 */
test.describe('a bar on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('takes the plan to the row and opens no surface at all', async ({ page }) => {
    await seedOnALaptop(page, nextAccount(), { extraRows: 12 });
    await openTheChart(page, { throughTheSheet: true });

    await page.locator('[data-gantt-bar]').first().tap();

    await expect(page.getByLabel('Name of 010.1')).toBeFocused();
    // Well past the open delay, so this is "no surface" rather than "not yet".
    await page.waitForTimeout(600);
    await expect(surface(page)).toHaveCount(0);
  });

  test('opens nothing under a finger that stays on the bar', async ({ page }) => {
    // **The test the guard is actually held by.** A `tap()` lifts the finger
    // at once, and the `pointerout` that comes with it cancels the opening
    // whether or not anything looked at `pointerType` — so with the guard
    // struck out the test above stayed green, watched 2026-08-09. A finger
    // that stays down is the case where the timer runs to the end, and it is
    // dispatched through CDP because Playwright's touchscreen has no hold.
    await seedOnALaptop(page, nextAccount());
    await openTheChart(page, { throughTheSheet: true });

    const bar = page.locator('[data-gantt-bar]').first();
    const box = await bar.boundingBox();
    if (box === null) throw new Error('there is no bar on the chart to press');
    const touch = await page.context().newCDPSession(page);
    const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
    try {
      // Longer than the open delay by a wide margin, with the finger still
      // down: a mouse resting this long has had a surface for hundreds of ms.
      await page.waitForTimeout(800);

      // Proof: the `pointerType` guard removed — this failed on `expected 0,
      // received 1`, a surface standing over the plan on a phone with no
      // pointer to dismiss it. Watched, 2026-08-09.
      await expect(surface(page)).toHaveCount(0);
    } finally {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  });
});

/*
 * PROVING THESE CAN FAIL — watched 2026-08-09 against a real chromium on
 * ports 3111/3211/4211, one fault at a time, each reverted. Every message is
 * quoted in `openspec/changes/gantt-view/verify.md`.
 *
 * FAULT A — the arrow head deleted.
 *   `gantt-panel.tsx`: the `<path data-gantt-arrow-head>` struck from the SVG.
 * `draws the arrow head…` alone, on `nothing on the page at
 * [data-gantt-arrow-head]`.
 *
 * FAULT C — the not-before caret back on the bar.
 *   Its old `d`: a triangle hanging off the bar's own top-left corner.
 * `draws the arrow head…` alone, on `the not-before caret is drawn over the bar
 * it belongs to: expected true to be false`.
 *
 * FAULT B — `[stroke-width:2]` struck from the bracket.
 * `draws the arrow head…` alone, on `the summary bracket is a hairline:
 * expected 1 to be >= 2`. **No jsdom assertion in this repository could see
 * this one**: a class attribute is a string until a browser computes it. Kept
 * for the lesson; the mark itself is gone since `gantt-declutter`, and the
 * computed-style assertion left in that test is the arrow's own stroke width.
 *
 * FAULT S — the SVG's CSS height 20px taller than `rowCount × ROW_PX`.
 * `draws a bar at the pixel…` on `… is not on its own row: expected
 * 7.866677246093751 to be <= 1`.
 *
 * FAULT X — an axis cell one pixel wider than `DAY_PX`.
 * `draws a bar at the pixel…` on `… does not begin under the axis cell for
 * workday 4: expected 4 to be <= 1`. Recorded against the workday axis this
 * change replaced; the assertion now names a calendar day.
 *
 * FAULT L — `sticky left-0` dropped from the label column.
 * Both label tests, on `the label column went with the chart instead of holding
 * the edge: expected 1048 to be <= 1`.
 *
 * FAULT F — the scroll suppressed: `goToRow` reduced to
 *   `cell.focus({ preventScroll: true })`.
 * Both click tests, on `the plan did not scroll to the row the bar belongs to`
 * and `the cards did not scroll…`. All 31 of `gantt-panel.test.tsx` passed
 * through it — jsdom takes the options bag and does nothing with it, and lays
 * nothing out to scroll.
 *
 * And one fault that is **not** in the list, because it cannot be caught here.
 * `tasks.md` named "the click's `scrollIntoView` guard inverted" as this
 * slice's negative. Inverted, all six tests passed: Chromium scrolls a focused
 * element into view of its own accord, so the guarded call is belt-and-braces
 * in a browser and load-bearing only in jsdom, which has no `scrollIntoView` at
 * all. FAULT F is the negative that does hold the behaviour, and it is the one
 * recorded.
 */

test.describe('the chart edge the reader drags', () => {
  /**
   * Every `wbs.ganttHeight.*` value this page holds. The project's id is
   * be-01's and unknown to the test, so the keys are found by their prefix —
   * one project per fresh account means at most one entry.
   */
  const storedHeights = (page: Page): Promise<string[]> =>
    page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('wbs.ganttHeight.'))
        .map((key) => localStorage.getItem(key) ?? ''),
    );

  /**
   * Grabs the edge, drags it `travel` px down (negative is up) with real
   * moves, and measures the panel **before letting go**. Mid-flight, not
   * after: the release commits the height on its own, so a follow that died
   * would be papered over by the commit — this run's first negative, watched
   * doing exactly that with the move application short-circuited and both
   * tests green through it. The mid-drag height is what the pointer is owed.
   */
  async function dragTheEdge(page: Page, travel: number): Promise<Rect> {
    const grip = await page.locator('[data-gantt-height-handle]').boundingBox();
    if (grip === null) throw new Error('the height handle is not on the page');
    const fromX = grip.x + grip.width / 2;
    const fromY = grip.y + grip.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(fromX, fromY + travel, { steps: 8 });
    const midFlight = await rectOf(page, '[data-gantt-panel]');
    await page.mouse.up();
    return midFlight;
  }

  test('gives the chart the screen the pointer asks for, remembers it, and resets', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);
    const panelAtRest = await rectOf(page, '[data-gantt-panel]');
    const planAtRest = await rectOf(page, '[data-table-frame]');

    const inFlight = await dragTheEdge(page, -150);

    // The chart followed the pointer while the button was still down, and is
    // 150px taller once it is let go — the plan above gave that strip up; the
    // section they share did not grow.
    expect(Math.abs(inFlight.height - (panelAtRest.height + 150))).toBeLessThanOrEqual(1.5);
    const panelDragged = await rectOf(page, '[data-gantt-panel]');
    expect(Math.abs(panelDragged.height - (panelAtRest.height + 150))).toBeLessThanOrEqual(1.5);
    const planDragged = await rectOf(page, '[data-table-frame]');
    // The plan never grows to pay for the chart — and since
    // `unified-scroll-docking` it is not always what pays either: this fixture
    // is a three-row plan, so the frame is as tall as its own rows and the
    // strip the chart took was the dead space under them, down to whatever the
    // frame had over its floor. What the assertion is really about is the
    // sentence above it — that the section they share did not grow — and the
    // page not scrolling is what says so, at any plan length.
    //
    // It read `planAtRest.height - 140` until then, which was true only while
    // the frame was as tall as the window whatever it held: at `0 1 auto` it
    // failed on `expected 320 to be less than or equal to 180`, the frame
    // sitting on its own 20rem floor. Watched on h2puni, 2026-08-12.
    expect(planDragged.height).toBeLessThanOrEqual(planAtRest.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      ),
      'the section grew and took the page with it',
    ).toBe(0);

    // A reload reads the height back — the remembered claim, believed.
    await page.reload();
    await openTheChart(page);
    const panelReloaded = await rectOf(page, '[data-gantt-panel]');
    expect(Math.abs(panelReloaded.height - panelDragged.height)).toBeLessThanOrEqual(1.5);

    // The reset returns the default share and forgets the key — pressed on
    // the toolbar row, where the control lives.
    await page.getByRole('button', { name: 'Reset layout' }).click();
    const panelReset = await rectOf(page, '[data-gantt-panel]');
    expect(Math.abs(panelReset.height - panelAtRest.height)).toBeLessThanOrEqual(1.5);
    expect(await storedHeights(page)).toEqual([]);
  });

  test('stops at the floor, and is still there to be dragged back open', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // Far past the bottom of the screen: a gesture that got away.
    await dragTheEdge(page, 2000);
    const floored = await rectOf(page, '[data-gantt-panel]');
    expect(Math.abs(floored.height - 3 * ROW_PX)).toBeLessThanOrEqual(1.5);

    // And the same edge gives the chart its screen back.
    await dragTheEdge(page, -100);
    const reopened = await rectOf(page, '[data-gantt-panel]');
    expect(Math.abs(reopened.height - (3 * ROW_PX + 100))).toBeLessThanOrEqual(1.5);
  });

  /**
   * What the browser says it would hand a press at each point — the element it
   * hit-tests to, named the way a failure can be read.
   *
   * `elementFromPoint` and a real press answer the same question: both walk the
   * paint order top down. A point the handle does not own is a point the reader
   * cannot start a drag from.
   */
  const whatIsUnderThePointer = (
    page: Page,
    points: { x: number; y: number }[],
  ): Promise<string[]> =>
    page.evaluate(
      (sweep) =>
        sweep.map(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          if (hit === null) return 'nothing at all';
          if (hit.closest('[data-gantt-height-handle]') !== null) return 'the handle';
          const where =
            hit.closest('[data-gantt-panel]') === null ? 'outside the chart' : 'the chart';
          return `${hit.tagName.toLowerCase()} in ${where}`;
        }),
      points,
    );

  test('owns every point on its strip, rather than the chart sliding under it', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    const grip = await rectOfLocator(
      page.locator('[data-gantt-height-handle]'),
      'the height handle',
    );
    // The strip is only contested where the chart has something drawn under
    // it, so the sweep is taken **across the chart's own top row** rather than
    // across the panel: the sticky label column, its corner, and the calendar
    // axis beside it. Measuring those two boxes first is what stops this test
    // going vacuous the day the fixture's plan gets narrower than the window —
    // an empty strip belongs to the handle whatever the layering says.
    const labels = await rectOfLocator(
      page.locator('[data-gantt-labels]'),
      "the chart's label column",
    );
    const axis = await rectOfLocator(
      page.locator('[data-gantt-axis]'),
      "the chart's calendar axis",
    );
    const contested = Math.min(axis.right, grip.right);
    expect(contested).toBeGreaterThan(labels.right);

    // Top to bottom of the 6px as well as across it: a strip that only answers
    // on its first row is not a strip a hand can find.
    const sweep = [1, 3, 5].flatMap((down) =>
      [0.02, 0.5, 0.98].flatMap((across) =>
        [
          labels.left + labels.width * across,
          labels.right + (contested - labels.right) * across,
        ].map((x) => ({ x: Math.round(x), y: Math.round(grip.top + down) })),
      ),
    );
    expect(await whatIsUnderThePointer(page, sweep)).toEqual(sweep.map(() => 'the handle'));

    // And the press really lands: a click at the strip's far left — the corner
    // the label column's sticky header covers — is a gesture the handle takes.
    const farLeft = { x: Math.round(grip.left + 4), y: Math.round(grip.top + 3) };
    const before = await rectOf(page, '[data-gantt-panel]');
    await page.mouse.move(farLeft.x, farLeft.y);
    await page.mouse.down();
    await page.mouse.move(farLeft.x, farLeft.y - 120, { steps: 8 });
    const inFlight = await rectOf(page, '[data-gantt-panel]');
    await page.mouse.up();
    expect(Math.abs(inFlight.height - (before.height + 120))).toBeLessThanOrEqual(1.5);
  });
});

/**
 * The **pointed row**, measured by the engine that paints it.
 *
 * Every assertion here is one jsdom cannot make, and that is the whole reason
 * the file is this one. `wbs-table.test.tsx` and `gantt-panel.test.tsx` assert
 * the attributes — `data-row-lit`, `data-gantt-label-lit`, `data-gantt-row-lit`
 * — and an attribute arriving proves only that it arrived. Whether any pixel
 * changes colour is the cascade's doing, and the cascade runs here.
 *
 * This is R5 tally #17's own fault class, and the repo has already paid for it
 * once at this exact spot: `dep-hover-highlights`' `--cell-bg` rule was
 * withheld from PR #38's first head, the attribute set, jsdom green throughout,
 * and only the `pixels` job saw it. So the rule that paints a pointed row has
 * its negative in here rather than upstairs.
 *
 * Two claims are load-bearing beyond "it turns a colour":
 *
 * 1. **Both stripes, one colour.** The banded-hover rule holds the lit rules up
 *    by predicate rather than by source order, so a `data-row-lit` missing from
 *    its `:not()` chain gives an even row a different colour from an odd one.
 *    A pointed row written from a **bar** is as likely to be even as odd, and
 *    the pointer is not over the table at all when it is.
 * 2. **Nothing moves.** No face scrolls to a pointed row, which is a promise
 *    about a `scrollTop` only a browser has.
 */
test.describe('the pointed row, across both faces', () => {
  /**
   * The painted colour of a row's pinned Name cell, once its cross-fade is done.
   *
   * The **pinned** cell on purpose: it paints an opaque inline background, so a
   * tint reaches it only through the `--cell-bg` join, which is the wiring under
   * test. Settled first, because a colour captured mid-fade is a value no frame
   * will show again and an assertion against it fails on a timing nobody chose.
   */
  async function settledRowBg(row: Locator): Promise<string> {
    const cell = row.locator('td[data-column="name"]');
    await expect.poll(() => cell.evaluate((td) => td.getAnimations().length)).toBe(0);
    return cell.evaluate((td) => getComputedStyle(td).backgroundColor);
  }

  /** The same colour, read now, mid-fade or not — for polling "has it moved". */
  const rowBg = (row: Locator): Promise<string> =>
    row
      .locator('td[data-column="name"]')
      .evaluate((cell) => getComputedStyle(cell).backgroundColor);

  test('lights the table row, the row label and a band from a bar', async ({ page }) => {
    await seedPlan(page, `pointed-from-bar-${String(Date.now())}`);
    await openTheChart(page);

    const rest = await settledRowBg(rowOf(page, '010.1'));

    await barOf(page, '010.1', 'Dev').hover();

    // The attributes first, so a colour assertion that failed for want of a
    // hover would fail as itself rather than as a missing tint.
    await expect(rowOf(page, '010.1')).toHaveAttribute('data-row-lit', 'true');
    await expect(page.locator('[data-gantt-label-lit]')).toHaveCount(1);
    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(1);

    // And the paint, which is the half only this file can see.
    await expect.poll(() => rowBg(rowOf(page, '010.1'))).not.toBe(rest);

    const lit = await settledRowBg(rowOf(page, '010.1'));
    const label = await page
      .locator('[data-gantt-label-lit]')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const band = await page
      .locator('[data-gantt-row-lit]')
      .evaluate((node) => getComputedStyle(node).fill);

    // One ink in three places. Read as colours rather than as "not rest", so a
    // build that tinted the table and left the chart grey cannot pass.
    expect(lit, 'the table row is not painted the row light').toBe(label);
    expect(band, 'the chart band is not painted the row light').toBe(label);
  });

  test('lights the same colour on an even row as on an odd one', async ({ page }) => {
    // The `:not()` chain's negative, and finding the case it is really about
    // took two wrong tries worth recording.
    //
    // The chain matters only where `data-row-lit` and `:hover` land on **one**
    // row, because `nth-child(even):hover` needs the pointer on the `<tr>`. That
    // rules out both obvious readings: pointing from a bar never matches
    // `:hover` at all (watched passing with the chain removed — a check that
    // could not fail), and the pointer on a table row no longer writes
    // `data-row-lit` on it, precisely so the banded hover keeps working.
    //
    // What is left is the one combination that does both: a **bar holding the
    // keyboard focus** lights its row while the **pointer** rests on that same
    // row in the table. `depFocus` reaches the identical arrangement, which is
    // why the rule above this one was already written for it.
    //
    // Both stripes asserted to the *same* colour rather than each to "not rest":
    // a build where only one works would pass a pair of not-rest checks, and a
    // highlight that behaves differently on alternate stripes is the defect
    // `dep-hover-highlights` existed to remove.
    await seedPlan(page, `pointed-stripes-${String(Date.now())}`, {
      extraRows: 2,
      costedExtras: true,
    });
    await openTheChart(page);

    // `010` is the parent and draws no bar, so the pair is `010.1` and `010.2` —
    // and their stripes are read from the DOM rather than assumed, because a
    // fixture that renumbered would otherwise quietly test one phase twice.
    const stripes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-grid] tbody tr')].map((tr, index) => ({
        number: tr.querySelector('[data-number]')?.textContent ?? '(none)',
        even: index % 2 === 1,
      })),
    );
    const parityOf = (number: string): boolean => {
      const found = stripes.find((row) => row.number === number);
      if (found === undefined) throw new Error(`${number} is not a row of this plan`);
      return found.even;
    };
    expect(parityOf('010.1'), '010.1 is not on the even stripe').toBe(true);
    expect(parityOf('010.2'), '010.2 is not on the odd stripe').toBe(false);

    /** Lights `number` from a bar's focus, with the pointer on its table row. */
    const litWithBothOn = async (number: string): Promise<string> => {
      await barOf(page, number, 'Dev').focus();
      const row = rowOf(page, number);
      await row.locator('td[data-column="name"]').hover();
      await expect(row).toHaveAttribute('data-row-lit', 'true');
      return settledRowBg(row);
    };

    const litOdd = await litWithBothOn('010.2');
    const litEven = await litWithBothOn('010.1');

    expect(litEven, 'the even row is lit differently from the odd row').toBe(litOdd);
  });

  test('lights the chart from a table row', async ({ page }) => {
    await seedPlan(page, `pointed-from-table-${String(Date.now())}`);
    await openTheChart(page);

    await rowOf(page, '010.2').locator('td[data-column="name"]').hover();

    await expect(page.locator('[data-gantt-label-lit]')).toHaveCount(1);
    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(1);
    await expect(page.locator('[data-gantt-label-lit]')).toHaveAttribute('title', /^010\.2 - /);

    // And the row the pointer is on does **not** light itself: `tr:hover` is
    // already tinting it, and `data-row-lit` on every hovered row makes
    // `tr:not([data-row-lit])…:nth-child(even):hover` unmatchable — which
    // stopped the stripe moving under the pointer at all and failed four of
    // `hover-cards.spec.ts`'s assertions. Watched, 2026-08-14.
    await expect(page.locator('[data-row-lit]')).toHaveCount(0);
  });

  test('clears when the pointer leaves both faces', async ({ page }) => {
    await seedPlan(page, `pointed-cleared-${String(Date.now())}`);
    await openTheChart(page);

    await barOf(page, '010.1', 'Dev').hover();
    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(1);

    // Onto the panel's own heading, which is on neither face's rows.
    await page.getByRole('button', { name: 'Detail' }).hover();

    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(0);
    await expect(page.locator('[data-row-lit]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-label-lit]')).toHaveCount(0);
  });

  test('moves neither face', async ({ page }) => {
    await seedPlan(page, `pointed-still-${String(Date.now())}`, {
      extraRows: 12,
      costedExtras: true,
    });
    await openTheChart(page);

    const before = await panelScroll(page);
    const pageBefore = await page.evaluate(() => window.scrollY);

    await barOf(page, '010.1', 'Dev').hover();
    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(1);

    expect(await panelScroll(page)).toEqual(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageBefore);
  });

  test('keeps an open editor and its half-typed value', async ({ page }) => {
    // 1.4's jsdom negative sees the `columns` memo dep; this sees what a real
    // pointer sequence does to a real focus — R5 #14/#15's fault class, where
    // jsdom performs no default action and cannot watch a guard be left
    // half-done.
    await seedPlan(page, `pointed-editor-${String(Date.now())}`, {
      extraRows: 3,
      costedExtras: true,
    });
    await openTheChart(page);

    const name = page.getByLabel('Name of 010.1');
    await name.click();
    await name.fill('Survey the racking bef');
    await expect(name).toBeFocused();

    for (const number of ['010.1', '010.2', '020', '030']) {
      await barOf(page, number, 'Dev').hover();
    }

    await expect(page.locator('[data-gantt-row-lit]')).toHaveCount(1);
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Survey the racking bef');
  });
});
