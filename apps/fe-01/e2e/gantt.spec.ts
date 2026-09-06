import { readFile } from 'node:fs/promises';

import { expect, type Locator, type Page, type Response, test } from '@playwright/test';

import { calendarScale } from '../src/components/wbs/gantt-geometry';
import { CHART_PAD_PX, DAY_PX, LABEL_COLUMN_PX, ROW_PX } from '../src/components/wbs/gantt-panel';
import {
  differingColumns,
  isContiguousRun,
  sameColumns,
} from '../src/components/wbs/marker-rule-ink';
import { createProject } from './create-project';

/**
 * The batch that carries one `kind` — what a write is since `plan-commands`:
 * every plan edit is `POST …/commands` with the command inside, so the method
 * alone no longer says which write left the browser; the kind in the body does.
 * Registered before the gesture that sends it, as the note above says.
 */
/**
 * The write a date box sends: the project start date is still its own
 * `PATCH /api/projects/{id}`, while a row's earliest start is a `patchWorkItem`
 * command — `setDate` serves both, so it waits for whichever leaves.
 */
const savedDate = (page: Page): Promise<Response> =>
  page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() === 'PATCH' && /\/api\/projects\/[^/]+$/.test(response.url())) return true;
    return (
      request.method() === 'POST' &&
      response.url().includes('/commands') &&
      (request.postData() ?? '').includes('"kind":"patchWorkItem"')
    );
  });

const savedCommand = (page: Page, kind: string): Promise<Response> =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/commands') &&
      (response.request().postData() ?? '').includes(`"kind":"${kind}"`),
  );

/**
 * Delivers a day the way Chrome's own calendar popup delivers one: the value
 * arrives in the box, the focus stays in it, and **no key is pressed**.
 *
 * **Through the native prototype setter, and that is the whole of this
 * helper.** React installs an instance-level `value` setter on every input it
 * renders, to dedupe `change` against the value it last saw. Assigning
 * `node.value` goes through that setter, updates React's tracker, and React
 * then drops the event as "nothing changed" — so the component's `onChange`
 * never runs and a test written that way measures the harness rather than the
 * product. The descriptor off `HTMLInputElement.prototype` steps around the
 * tracker, which is what the browser's picker does when it writes the day in.
 *
 * Watched, 2026-08-23: with a plain `node.value = day`, the case below failed
 * on `waitForResponse` timing out — no write had left the browser at all,
 * against a component that does send one. The dev repro this bug was found
 * with (`queue/tasks/2026-08-23-wbs-gantt-stale-on-start-date.md`, chunk 2)
 * used the native setter, which is why it saw the real behaviour.
 */
async function pickDay(box: Locator, day: string): Promise<void> {
  await box.evaluate((node, chosen) => {
    if (!(node instanceof HTMLInputElement)) throw new Error('that is not a date input');
    // Bound at the point it is taken off the prototype: an unbound setter is a
    // `this` waiting to be the wrong object, and `.bind` is what the lint rule
    // that catches it asks for.
    const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
      node,
    );
    if (assign === undefined) throw new Error('HTMLInputElement has no value setter to borrow');
    node.focus();
    assign(chosen);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, day);
}

/**
 * Puts a whole date into a date field and leaves it, and waits for the write.
 *
 * **The write now leaves during the `fill`, not during the blur, and the wait
 * is registered before either.** Playwright's `fill` sets the value and fires
 * `input`/`change` with **no keydown**, and since 2026-08-23 a keyless `change`
 * is a picked day and is sent at once (`date-field.tsx`) — so a
 * `waitForResponse` created after the `fill`, as this helper had it, is
 * listening for a response that has already gone by. Watched: it times out at
 * 60 seconds, on cases that are otherwise fine.
 *
 * The blur stays, because it is what a person does and because it must stay
 * silent — `commitIfChanged` sends nothing when the box already holds the
 * agreed day, and a second PATCH here would be the old double-write back.
 * Leaving is still how a **typed** date is saved: `DateField` holds every
 * completed segment while keys are landing, because committing each of them
 * saved a plan starting in year 0002.
 *
 * The `aria-busy` wait afterwards is the refetch that commit starts — a click
 * that lands inside it hits a `disabled` control and goes nowhere.
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
  // Registered before the gesture, because the gesture is what sends: see the
  // note above.
  const saved = savedDate(page);
  await box.fill(day);
  await saved;
  // `blur`, not `press('Tab')`: Chrome's date input owns Tab for stepping
  // between its own day/month/year segments, so a Tab from the day segment
  // never leaves the field at all — probed here, `document.activeElement` was
  // still the box afterwards.
  //
  // The `aria-busy` after it is the refetch the write starts, and it is the
  // window every toolbar control is disabled for — a click that lands inside it
  // is dropped on the floor. Playwright's own "wait until enabled" cannot see
  // that: the button is still enabled at the moment it is checked and goes dead
  // a tick later, which is the same race a person loses by hand.
  await box.blur();
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
 * @param _account The legacy fixture label, retained to keep call sites descriptive.
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
 * @param fixture.zeroQa Whether each leaf's `QA` step is **stated** as `0/0/0`
 * rather than left blank. Since `assumed-duration-schedules` a blank step takes
 * two workdays, so a row's End is two workdays past its `Dev` bar's finish;
 * only the fixtures whose subject is a bar standing for its own row ask for
 * this, and they ask by stating the zero, because an absence and a zero are
 * different answers.
 */
async function seedPlan(
  page: Page,
  _account: string,
  fixture: {
    estimate?: string;
    extraRows?: number;
    costedExtras?: boolean;
    zeroQa?: boolean;
  } = {},
): Promise<void> {
  void _account;
  const { estimate = '2/4/6', extraRows = 0, costedExtras = false, zeroQa = false } = fixture;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await createProject(page);
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
    // `zeroQa` makes a row's span its `Dev` slice's span, which is what it was
    // before `assumed-duration-schedules` (2026-08-30): a `QA` nobody estimates
    // now takes two workdays, so a row's End is two workdays past its `Dev`
    // bar's finish. Only the fixtures whose subject is a bar standing for its
    // own row ask for it, and they ask by **stating** the zero rather than by
    // leaving the step blank — an absence and a zero are different answers, and
    // this helper must not blur them.
    if (!zeroQa) continue;
    const qa = page.getByLabel(`QA estimate for ${number}`);
    await qa.fill('0/0/0');
    await qa.blur();
    await expect(qa).not.toHaveValue('');
  }

  const depends = page.getByLabel('Add a dependency to 010.2');
  await depends.click();
  await depends.fill('010.1');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 010.2 waiting for 010.1' })).toBeVisible();

  // The day be-01 says this row starts, typed back in as the day it may not
  // start before: the caret and the bar's left edge on the same workday.
  // From the cell's `data-start-said`, not its text: the columns print `14 Aug`
  // since `T2 compact-columns` and carry the whole `YYYY-MM-DD` in the attribute.
  //
  // **The attribute, not a `title`**, since `start-date-hover-card`
  // (2026-08-31): the Start cell shows this sentence in the page's own hover
  // card and has no native tooltip left to read. Reading the `title` here is
  // what **43** of this gate's 270 cases failed on when that change was first
  // run whole — the fixture threw before it had built a plan, and the failures
  // landed in files that have nothing to do with the Start column. A fixture
  // that reads a presentational attribute is a gate-wide dependency on it.
  //
  // **The first of two facts**, since `row-start-floor`: the sentence reads
  // `2026-08-14 — Waits for a dependency’s first estimated step`, the `End`
  // cell's own shape. This helper wants the day alone, and the guard below is
  // kept rather than loosened to a prefix match — it is what turned that change
  // into 26 named failures instead of a fixture quietly holding the wrong row
  // at the wrong date.
  const said = await rowOf(page, '010.2')
    .locator('[data-column="start"]')
    .getAttribute('data-start-said');
  const startsOn = said?.split(' — ')[0] ?? null;
  if (startsOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) {
    throw new Error(`010.2's Start cell reads ${String(said)}, which has no date to hold it at`);
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
 * A two-row chain whose predecessor nobody has estimated at all.
 *
 * `020` waits for `010`, `010` carries no estimate for either step, and `020`'s
 * `Dev` is costed so it draws a bar with area to measure. Before
 * `assumed-duration-schedules` (2026-08-29) every row of this plan sat at
 * workday 0 and the chart drew the successor beside the work it depends on;
 * `010`'s two unsized steps are two workdays each now, so it occupies the first
 * four workdays and `020` begins after them.
 */
async function seedUnestimatedChain(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
  await setDate(page, 'Project start date', PLAN_START);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // Only the successor is costed. The predecessor is left blank on purpose:
  // "nobody has looked at this yet" is the state this test is about.
  const estimate = page.getByLabel('Dev estimate for 020');
  await estimate.fill('2/4/6');
  await estimate.blur();
  await expect(estimate).not.toHaveValue('');

  const depends = page.getByLabel('Add a dependency to 020');
  await depends.click();
  await depends.fill('010');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 020 waiting for 010' })).toBeVisible();
  await depends.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/**
 * The smallest plan whose arrows leave the schedule at **both** ends.
 *
 * Four roots and two dependencies, and no indenting: `020` waits for `010`,
 * whose `Dev` is estimated at nothing at all, so both sit at workday 0 — the
 * successor's start is the canvas's own left edge, which is where an arrow's
 * approach goes negative. `040` waits for the estimated `030`, so it starts
 * further along the schedule and its arrow's outward leg reaches past its bar.
 *
 * **Costed at `0/0/0` rather than left blank, since
 * `assumed-duration-schedules`** (2026-08-30). Every row but `030` used to be
 * left unestimated on the reasoning that it is the state every row is in for
 * its first few minutes — and an unestimated step now takes two workdays, which
 * would move `020` off day zero, push the horizon out past `040`, and take both
 * of this test's arrows with it. A stated zero is the case that survives:
 * somebody has said this step costs nothing, and it finishes where it starts.
 * Every step of every row but `030`'s `Dev` therefore carries an explicit
 * `0/0/0`, which reproduces the schedule this fixture has always had.
 *
 * The consequence for the helper's caller: every mark in this plan but `030`'s
 * one bar has **no area** — a zero-day slice draws a `<rect width="0">` and a
 * `<line x1=x2>`, both of which a browser reports as hidden — so the chart
 * cannot be opened by waiting for a bar or a tick to be visible. It is opened
 * on the row labels, which are HTML, and the caller then waits for the one bar
 * that does have width. That second wait is this fixture's non-vacuity: it is
 * what says the chart being measured is the one this helper seeded.
 */
async function seedEdgeRoutes(page: Page, _account: string): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
  await setDate(page, 'Project start date', PLAN_START);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030', '040']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  // The one estimate that costs anything, so `040` starts four workdays along.
  const estimate = page.getByLabel('Dev estimate for 030');
  await estimate.fill('2/4/6');
  await estimate.blur();
  await expect(estimate).not.toHaveValue('');

  // And a stated zero everywhere else, which is what holds `020` at workday 0
  // and the horizon at `030`'s own finish — see this helper's docstring. Both
  // steps of every row, because a step left blank is two assumed workdays now.
  for (const number of ['010', '020', '030', '040']) {
    for (const step of ['Dev', 'QA']) {
      if (number === '030' && step === 'Dev') continue;
      const nothing = page.getByLabel(`${step} estimate for ${number}`);
      await nothing.fill('0/0/0');
      await nothing.blur();
      await expect(nothing).not.toHaveValue('');
    }
  }

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
 * Makes sure the detail is drawn, and waits for the marks it draws.
 *
 * Since TASK-38 a plan with dependency edges opens with the detail on, so the
 * switch is only pressed when the marks are not there. The counts are asserted
 * rather than assumed: a click that landed on nothing would otherwise leave the
 * assertions below measuring a chart with none of it on, which is exactly how
 * R5 #14 and #15 hid.
 *
 * The press is also the half jsdom cannot answer at all: a real click on a
 * button inside a sticky, z-indexed subtree of an `overflow-auto` scroller is
 * the arrangement that has eaten clicks here twice.
 *
 * @param page The page holding the chart.
 * @param heads How many arrow heads the fixture draws once they are asked for.
 */
async function askForTheDetail(page: Page, heads: number): Promise<void> {
  if ((await page.locator('[data-gantt-arrow]').count()) === 0) {
    await page.locator('[data-gantt-detail-toggle]').click();
  }
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
 * Requires every interactive control in one Gantt strip to expose a phone-sized
 * target in both dimensions.
 *
 * Proof: with the strip's production rule setting only `min-height`, this fails
 * on Detail at 39×44, Full/Close at 38×44, and the SVG download at 16×44.
 */
async function expectPhoneTargets(strip: Locator, where: string): Promise<void> {
  const targets = await strip.locator('button, select').evaluateAll((controls) =>
    controls.map((control) => {
      const box = control.getBoundingClientRect();
      return {
        name: control.getAttribute('aria-label') ?? control.textContent.trim(),
        width: box.width,
        height: box.height,
      };
    }),
  );
  expect(targets, `${where} has no Gantt controls to measure`).not.toHaveLength(0);
  for (const target of targets) {
    expect(target.width, `${where} ${target.name} is narrower than 44px`).toBeGreaterThanOrEqual(
      44,
    );
    expect(target.height, `${where} ${target.name} is shorter than 44px`).toBeGreaterThanOrEqual(
      44,
    );
  }
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
  options: { estimate?: string; extraRows?: number; costedExtras?: boolean } = {},
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

    // The chart at rest: the detail is on by default since TASK-38 (the seeded
    // plan has a dependency), so the ghost and the assumed QA slices are drawn
    // already — and one label per row of the plan all the same.
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    await expect(page.locator('[data-assumed]')).toHaveCount(2);
    const restingRows = await page.locator('tbody tr').count();
    expect(restingRows, 'the seeded plan has no rows to line the chart up against').toBe(3);
    await expect(page.locator('[data-gantt-label]')).toHaveCount(restingRows);

    await askForTheDetail(page, 1);

    // The bar the caret belongs to, found through the caret's own row and not
    // by counting: the first attempt at this took `bars.at(1)` on the reasoning
    // that `010` is a parent and draws no bar, and a new project lists **two**
    // steps — so index 1 is `010.1`'s unestimated QA slice, sitting at the same
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
   * The change's headline, in pixels: an entirely unestimated predecessor holds
   * its successor back.
   *
   * jsdom can say what `earliestStart` be-01 sent. Only a browser can say that
   * the bar a reader sees is drawn to the right of the bars it waits for, at a
   * width that is there to be seen — which is the whole complaint
   * `assumed-duration-schedules` answers: unsized work used to be free, and the
   * chart drew the plan as if it were.
   *
   * Every box is asserted to have area **before** any of them are compared, for
   * the reason `AGENTS.md` records against `G gantt-calendar-axis`: a
   * zero-width bar makes an overlap or ordering check unfailable, and the first
   * version of that test compared a caret against exactly such a mark and could
   * not see the fault it was written for.
   */
  test('draws a successor after the predecessor nobody estimated', async ({ page }) => {
    await seedUnestimatedChain(page, nextAccount());
    await openTheChart(page);
    // One arrow: `020` waits for `010` and there is nothing else in the plan.
    await askForTheDetail(page, 1);

    // The predecessor's two assumed bars and the successor's costed one, each
    // found through the row it is on rather than by index — `bars.at(n)` is the
    // shape R5 #16 was, and a project lists two steps so the indices are not
    // the rows.
    const drawn = await page.evaluate(() => {
      const boxOf = (mark: Element) => {
        const box = mark.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      };
      const onRow = (row: number, selector: string) =>
        [...document.querySelectorAll(selector)]
          .filter((bar) => Math.floor(Number(bar.getAttribute('y'))) === row)
          .map(boxOf);
      return {
        predecessor: onRow(0, '[data-gantt-bar][data-assumed]'),
        successor: onRow(1, '[data-gantt-bar]:not([data-assumed])'),
      };
    });

    // Non-vacuity first, and it is three separate claims: the predecessor draws
    // both of its unsized steps, each of them has area, and the successor's own
    // bar has area to be to the right of them.
    expect(
      drawn.predecessor,
      'the unestimated predecessor drew no assumed bars to measure',
    ).toHaveLength(2);
    expect(drawn.successor, 'the successor drew no costed bar of its own').toHaveLength(1);
    for (const bar of [...drawn.predecessor, ...drawn.successor]) {
      expect(bar.width, 'a bar with no width cannot be to the right of anything').toBeGreaterThan(
        0,
      );
      expect(bar.height, 'a bar with no height cannot be to the right of anything').toBeGreaterThan(
        0,
      );
    }

    // And the claim. `NEARLY` of tolerance, because the two are laid out by the
    // same transform and a sub-pixel boundary is not a schedule.
    //
    // Proof: `durationOf`'s assumed arm removed in `apps/be-01/src/service/
    // schedule.ts`, so an unestimated slice is zero days again — this failed on
    // `the successor is drawn left of the work it waits for: Expected: > 259 /
    // Received: 204`, the successor's bar back at the project's first workday
    // beside the work it depends on. The predecessor's two bars keep their
    // width through that fault, because the **drawing** has assumed two
    // workdays since `gantt-view`; it is the successor's placement that this
    // change moved, and it is the ordering rather than the widths that sees it.
    // Watched 2026-08-30.
    const holdsUntil = Math.max(...drawn.predecessor.map((bar) => bar.right));
    expect(
      drawn.successor[0].left,
      'the successor is drawn left of the work it waits for',
    ).toBeGreaterThan(holdsUntil - NEARLY);
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
    // Opened on the row labels, which are HTML and have area, because every
    // mark this fixture draws but one is zero-width — see `seedEdgeRoutes`.
    await openTheChart(page, { drawn: '[data-gantt-label]' });
    // And the one that is not: `030`'s costed bar. Polled rather than asserted
    // once, because it is the wait a bar selector would have been; and asserted
    // to be **exactly** one, because that is the schedule this test's arrows
    // are about — a second bar with width would mean an estimate reached a row
    // this fixture costed at nothing.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('[data-gantt-bar]')].filter(
              (bar) => bar.getBoundingClientRect().width > 0,
            ).length,
        ),
      )
      .toBe(1);
    // Two arrows: `020` waits for `010`, which costs nothing, so the successor
    // starts at workday 0 and the route reaches left of the schedule; `040`
    // waits for the estimated `030` and starts at the schedule's own finish, so
    // its route reaches right of it. Asserted inside the helper, because one
    // arrow would make half of this test vacuous.
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
  test('opens with the detail on, and keeps the answer through a reload', async ({ page }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    // The chart this plan opens with: the stored dependency's arrow and the two
    // other gated families, on by default since TASK-38 — a first-time reader
    // sees the arrows without hunting for the toggle. Both halves, so a chart
    // that drew nothing at all could not pass the presences alone.
    await expect(page.locator('[data-gantt-bar]').first()).toBeVisible();
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(1);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    await expect(page.locator('[data-assumed]')).toHaveCount(2);
    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Off, and the answer remembered across the reload.
    await page.locator('[data-gantt-detail-toggle]').click();
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);

    await page.reload();
    await openTheChart(page);
    // All three families stay off across the reload, and not the arrows alone:
    // the stored answer is one answer about the whole chart.
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-detail-toggle]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // And on again, remembered the same way round: a preference that only ever
    // remembers "off" is a switch with one direction.
    await askForTheDetail(page, 1);
    await expect(page.locator('[data-gantt-arrow]')).toHaveCount(1);
  });

  /**
   * The bars a fresh plan draws at rest, and the ones one press brings back.
   *
   * A new project lists two steps, and a leaf estimated for one of them draws a
   * dashed bar for the other — two bars a row, half of them widths nobody gave,
   * beside the parent's own ghost. At rest that is five marks on a three-row
   * chart and the reader sees two; the detail switch is the one control that
   * decides between them, which is the whole of `declutter-one-button`.
   *
   * The counts are the assertion, in both directions, and every drawn mark is
   * measured for area: a count of marks is not a count of things a reader can
   * see, which is the sixteenth check's lesson.
   */
  test('draws every mark at rest, and only costed work once the detail is off', async ({
    page,
  }) => {
    await seedPlan(page, nextAccount(), { estimate: PAST_THE_WEEKEND });
    await openTheChart(page);

    /** Every drawn bar's width, as the browser lays it out. */
    const barWidths = async (): Promise<number[]> =>
      page
        .locator('[data-gantt-bar]')
        .evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));

    // Two leaves, each estimated for Dev alone, under a parent: on by default
    // since TASK-38, so the two uncosted QA slices and the parent's ghost are
    // drawn at rest — four bars on a three-row chart.
    await expect(page.locator('[data-gantt-bar]')).toHaveCount(4);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(1);
    await expect(page.locator('[data-assumed]')).toHaveCount(2);
    const rows = await page.locator('tbody tr').count();
    expect(rows, 'the seeded plan has no rows to line the chart up against').toBe(3);
    await expect(page.locator('[data-gantt-label]')).toHaveCount(rows);
    expect(Math.min(...(await barWidths())), 'a drawn bar has no width at all').toBeGreaterThan(0);
    const ghost = await rectOf(page, '[data-gantt-bracket]');
    expect(ghost.width, 'the parent’s ghost bar has no width at all').toBeGreaterThan(0);
    expect(ghost.height, 'the parent’s ghost bar has no height at all').toBeGreaterThan(0);

    await page.locator('[data-gantt-detail-toggle]').click();

    // Asked off: two bars — the two Dev bars — and no ghost, no assumed QA.
    await expect(page.locator('[data-gantt-bar]')).toHaveCount(2);
    await expect(page.locator('[data-assumed]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-bracket]')).toHaveCount(0);
    // The plan and the chart still line up row for row, which is the one thing
    // the switch is not allowed to touch.
    await expect(page.locator('[data-gantt-label]')).toHaveCount(rows);
    expect(await page.locator('tbody tr').count()).toBe(rows);
    // And the bars it kept are bars, not boxes of nothing.
    expect(
      Math.min(...(await barWidths())),
      'a bar the detail switch kept has no width at all',
    ).toBeGreaterThan(0);
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
    // PERT. The dependent `010.2` follows — its own not-before still names day
    // 4, and the dependency out-floors it.
    //
    // **It follows to day 12, not day 10, and the two workdays between are the
    // whole of what `dep-reach-whole-item` and `assumed-duration-schedules`
    // compose to.** Under the anchor rule `010.2` waited for `010.1`'s first
    // *estimated* slice — its `Dev`, finishing at 10. Under `whole-item`, now
    // the default, it waits for the whole work item, and `010.1`'s last slice
    // is a `QA` nobody estimated, which since `assumed-duration-schedules`
    // takes two workdays rather than none. So `010.1` is 0→10 then 10→12, and
    // `010.2` is 12→16. Measured on the merged tree rather than re-derived:
    // every bar's `data-start`/`data-finish` read out of the page, 2026-08-30.
    const estimate = page.getByLabel('Dev estimate for 010.1');
    await estimate.fill('8/10/12');
    const savedEstimate = savedCommand(page, 'setEstimate');
    await estimate.blur();
    await savedEstimate;
    await expect(firstBar).toHaveAttribute('data-finish', '10');
    // `010.1`'s own assumed `QA`, which is the slice the dependency now reaches.
    await expect(page.locator('[data-gantt-bar][data-start="10"][data-finish="12"]')).toBeVisible();
    await expect(page.locator('[data-gantt-bar][data-start="12"][data-finish="16"]')).toBeVisible();

    // A not-before edit past everything else moves the row's bar to the day it
    // names: 2026-09-07 is workday 20 of a plan starting Monday 2026-08-10.
    await setDate(page, 'Earliest start for 010.2', '2026-09-07');
    await expect(page.locator('[data-gantt-bar][data-start="20"][data-finish="24"]')).toBeVisible();
  });

  test('moves the axis onto the day picked for the plan, with the box never left', async ({
    page,
  }) => {
    // **The bug Dany reported, and the one gesture that shows it**
    // (`wbs-gantt-stale-on-start-date`): *"changing the start date in WBS does
    // not automatically re-render the gantt chart."* It was never the chart —
    // `gantt-panel.tsx` memoises nothing and places the calendar in its render
    // body — it was that nothing had been **sent**. A day picked from Chrome's
    // popup lands in the box with the focus still in it, and `DateField` used
    // to hold every value until the box was left, so the axis, the table and
    // the server all still held the old day while the screen showed the new one.
    //
    // So this test leaves nothing and reloads nothing. The pick is delivered
    // the way the browser delivers one — the element's own `change`, focus kept,
    // no key — and then the axis has to move on its own.
    //
    // Proof: the `onChange` handler removed from `date-field.tsx`, this fails
    // on the axis still reading `2026-08-10` after the pick.
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // Day zero as seeded: the axis starts on the plan's own start date.
    await expect(page.locator('[data-axis-day="0"]')).toHaveAttribute('data-axis-date', PLAN_START);

    const starts = page.getByLabel('Project start date');
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH');
    await pickDay(starts, '2026-09-07');
    await saved;

    // The axis is drawn against the new day zero — with nothing in this test
    // having left the box, tabbed out of it or reloaded the page, which is the
    // whole claim.
    await expect(page.locator('[data-axis-day="0"]')).toHaveAttribute(
      'data-axis-date',
      '2026-09-07',
    );
    await expect(starts).toHaveValue('2026-09-07');
    // The write's own window, said out loud, is also the one thing the pick
    // costs the reader: the toolbar disables its controls while the refetch is
    // in flight (`busyAffordance`), and disabling a focused input drops the
    // focus out of it. The day is saved either way; the box is simply no longer
    // the one holding the caret afterwards.
    await expect(page.locator('[data-toolbar]')).toHaveAttribute('aria-busy', 'false');
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
/**
 * Cells wholly on screen, measured from the label column's **right** edge
 * rather than the panel's left.
 *
 * That is the difference between counting days and counting cells: the column
 * is `sticky left-0` and paints over the chart's first 176px, so a cell
 * scrolled under it has a rectangle inside the panel and is not on screen.
 * Counting from the panel's edge would have reported the collapse as buying
 * nothing — the same cells, still there, still hidden.
 *
 * At the describe's scope rather than inside one test since chunk 4: the
 * full-screen case below is the same measurement of the same defect, and two
 * copies of a counting rule this particular are two things to keep in step.
 */
const visibleDays = async (page: Page): Promise<number> =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-gantt-panel]');
    if (panel === null) throw new Error('no chart panel');
    const box = panel.getBoundingClientRect();
    const column = document.querySelector('[data-gantt-labels]');
    const leftEdge = column === null ? box.left : column.getBoundingClientRect().right;
    return [...document.querySelectorAll('[data-axis-day]')].filter((cell) => {
      const cellBox = cell.getBoundingClientRect();
      return cellBox.left >= leftEdge - 0.5 && cellBox.right <= box.right + 0.5;
    }).length;
  });

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

  test('shows more of the plan at every rung, and more again with the names put away', async ({
    page,
  }) => {
    // The task's own measurement, and the only one that answers it: **how many
    // days are on screen at once**. Everything the last two chunks changed —
    // the ladder, and now the 176px column — is worth exactly what this counts,
    // and jsdom cannot count it at all (no layout, so every cell is 0px wide
    // and every one of them is "visible").
    await seedOnALaptop(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page, { throughTheSheet: true });

    const atEachRung = async (): Promise<Record<string, number>> => {
      const counted: Record<string, number> = {};
      for (const rung of [28, 12, 4]) {
        await page.locator('[data-gantt-day-scale]').selectOption(String(rung));
        // The cells are re-sized by React, so the count is taken after the
        // width the rung asks for has actually landed on one.
        await expect(page.locator('[data-axis-day="0"]')).toHaveCSS('width', `${String(rung)}px`);
        counted[String(rung)] = await visibleDays(page);
      }
      return counted;
    };

    const withNames = await atEachRung();
    await page.locator('[data-gantt-labels-toggle]').click();
    await expect(page.locator('[data-gantt-labels]')).toHaveCount(0);
    const withoutNames = await atEachRung();
    // Printed rather than only asserted: the bounds below are brackets, and the
    // numbers this prints are what the next chunk tightens them to. A full-screen
    // mode (chunk 3) moves every one of them.
    console.log('visible days — names shown', withNames, '| names away', withoutNames);

    // A rung is worth something at every step, and the whole ladder is worth
    // several times its narrowest step. Ratios rather than pixels: the panel's
    // width is the page's business and has moved twice already.
    expect(withNames['28']).toBeLessThan(withNames['12']);
    expect(withNames['12']).toBeLessThan(withNames['4']);

    // The chunk's own claim. The column is 176px whatever the rung is, so what
    // it costs in **days** grows as the days get narrower: at 28px it is about
    // six days, at 4px about forty-four. Bracketed low, because these are the
    // first numbers this suite has ever had for it — the assertion that matters
    // is that the gain is real at the widest rung and large at the narrowest.
    expect(withoutNames['28']).toBeGreaterThan(withNames['28']);
    expect(withoutNames['4'] - withNames['4']).toBeGreaterThanOrEqual(30);

    // And the defect, in the numbers the sweep stated it in: a phone saw six
    // days of a 74-day plan. Upper bounds as well as lower, so a chart that
    // stopped drawing an axis at all cannot pass this by counting nothing.
    expect(withNames['28']).toBeGreaterThanOrEqual(3);
    expect(withNames['28']).toBeLessThanOrEqual(9);
    expect(withoutNames['4']).toBeGreaterThanOrEqual(60);
    expect(withoutNames['4']).toBeLessThanOrEqual(91);
  });

  test('gives the chart the whole screen, and gives it back on Escape', async ({ page }) => {
    // Chunk 4, and the task's first done-criterion: **a quarter, end to end,
    // without scrolling sideways**. The ladder and the collapsed column got a
    // 390px phone to about 79 days of the 91 a quarter needs, and the missing
    // ~47px is the page padding around the panel — which is the one thing
    // nothing inside the panel can win back.
    await seedOnALaptop(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page, { throughTheSheet: true });
    await page.locator('[data-gantt-labels-toggle]').click();
    await expect(page.locator('[data-gantt-labels]')).toHaveCount(0);
    await page.locator('[data-gantt-day-scale]').selectOption('4');
    await expect(page.locator('[data-axis-day="0"]')).toHaveCSS('width', '4px');
    const inThePage = await visibleDays(page);
    await expectPhoneTargets(page.locator('[data-gantt-controls]'), 'in-page strip');

    await page.locator('[data-gantt-fullscreen-toggle]').click();
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(1);
    // The rung is not re-picked: full screen is a bigger frame for the chart
    // already on screen, and a mode that silently re-scaled would be answering
    // a question the reader did not ask.
    await expect(page.locator('[data-axis-day="0"]')).toHaveCSS('width', '4px');
    const inFullScreen = await visibleDays(page);
    console.log('visible days at 4px — in the page', inThePage, '| full screen', inFullScreen);

    // Where the padding went. Both edges, because a layer that reached the
    // right edge alone would be one shifted sideways rather than widened.
    const panel = await rectOf(page, '[data-gantt-panel]');
    const window_ = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(
      panel.left,
      'the chart does not start at the left edge of the screen',
    ).toBeLessThanOrEqual(NEARLY);
    expect(
      window_.width - panel.right,
      'the chart does not reach the right edge of the screen',
    ).toBeLessThanOrEqual(NEARLY);

    // The strip is the way out, so it is on screen and it is inside the layer —
    // both, since a strip left behind in the page would be under the chart.
    const strip = await rectOf(page, '[data-gantt-controls]');
    expect(strip.bottom, 'the control strip is off the bottom of the screen').toBeLessThanOrEqual(
      window_.height + NEARLY,
    );
    expect(
      await page.locator('[data-gantt-fullscreen] [data-gantt-controls]').count(),
      'the way out is outside the layer it is the way out of',
    ).toBe(1);
    await expectPhoneTargets(
      page.locator('[data-gantt-fullscreen] [data-gantt-controls]'),
      'full-screen strip',
    );

    // The claim, in the unit the task states it in. A quarter is 91 days; the
    // brackets are wide on purpose — what this pins is that the padding is
    // worth about a dozen days at this rung and that the criterion is met.
    expect(inFullScreen).toBeGreaterThan(inThePage);
    expect(inFullScreen).toBeGreaterThanOrEqual(91);

    // **The hover surface still opens over the chart in here**, which is the
    // one thing a layer covering the app could take away.
    //
    // `hover` and not `click`, which is what the first run of this case got
    // wrong: on this face a **click** on a bar takes the plan to that row (the
    // case below asserts exactly that), so the card never opened at all —
    // `expect(locator).toBeVisible() failed / element(s) not found` at 390×844.
    await page.locator('[data-gantt-bar]').first().hover();
    const card = page.getByRole('tooltip');
    await expect(card).toBeVisible();

    // And the ordering that keeps it readable, asserted as the two facts that
    // decide it rather than by a hit test — which was this case's *second* red:
    // `elementFromPoint` at the card's own centre came back as something else
    // and it always will, because a fixed card is `pointer-events: none` on
    // purpose (`hover-card.tsx`: "A card does not take the pointer"). The
    // pointer passes through it by design, so no hit test can ever see it, and
    // the one that "failed" was measuring the design.
    //
    // What actually decides the paint: same `z-index`, and the card is
    // portalled to `document.body` **after** the app root, so tree order puts
    // it on top. Both halves are needed — raise this layer to `z-30` and the
    // first fails; portal the card into the panel and the second does.
    const layering = await page.evaluate(() => {
      const tooltip = document.querySelector('[role="tooltip"]');
      const layer = document.querySelector('[data-gantt-fullscreen]');
      if (tooltip === null || layer === null) throw new Error('no card, or no full-screen layer');
      return {
        card: Number(getComputedStyle(tooltip).zIndex),
        layer: Number(getComputedStyle(layer).zIndex),
        cardIsAfter:
          (tooltip.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
      };
    });
    expect(
      layering.layer,
      'the full-screen layer outranks the card a bar opens',
    ).toBeLessThanOrEqual(layering.card);
    expect(layering.cardIsAfter, 'the card is drawn before the layer that covers it').toBe(true);

    // Escape leaves, and leaves a chart behind rather than a closed panel.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-panel]')).toBeVisible();
    expect(await visibleDays(page), 'the chart came back wider than the page it is in').toBe(
      inThePage,
    );
  });

  test('keeps keyboard focus inside full screen and restores its trigger', async ({ page }) => {
    await seedOnALaptop(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page, { throughTheSheet: true });

    const toggle = page.locator('[data-gantt-fullscreen-toggle]');
    await toggle.click();
    const layer = page.locator('[data-gantt-fullscreen]');
    await expect(layer).toBeVisible();
    await expect(toggle).toBeFocused();

    const focusable = layer.locator(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable.first();
    const last = focusable.last();
    await last.focus();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(layer).toHaveCount(0);
    await expect(page.locator('[data-gantt-fullscreen-toggle]')).toBeFocused();
  });

  test('a picked scale reaches Reset layout on the phone, and Reset puts it back at Days', async ({
    page,
  }) => {
    // The phone's only reset, and the defect the task opened for: a browser
    // can pick a non-default scale, and the one Reset action reachable from
    // Plan actions has to clear it. jsdom cannot answer this — no reload, no
    // sheet round-trip — so it is measured here.
    await seedOnALaptop(page, nextAccount(), { estimate: '40/40/40' });
    await openTheChart(page, { throughTheSheet: true });

    // Pick a non-default scale, and prove it landed on the axis.
    await page.locator('[data-gantt-day-scale]').selectOption('4');
    await expect(page.locator('[data-axis-day="0"]')).toHaveCSS('width', '4px');

    // The scale survives a reload — remembered per project, which is what puts
    // Reset layout on the sheet.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Plan actions' })).toBeVisible();
    await page.getByRole('button', { name: 'Plan actions' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset layout' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset layout' }).click();

    // The tap cleared the scale and the action: after a reload the sheet no
    // longer offers Reset, and the chart opens back at Days.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Plan actions' })).toBeVisible();
    await page.getByRole('button', { name: 'Plan actions' }).click();
    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset layout' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Plan actions' })).toBeHidden();
    await openTheChart(page, { throughTheSheet: true });
    await expect(page.locator('[data-gantt-day-scale]')).toHaveValue('28');
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
 * Name cell opens, and naming it by its step is what says the two are one
 * surface rather than two that happen to look alike.
 */
const surface = (page: Page): Locator => page.getByRole('tooltip');

/**
 * The bar for one row **and one step**, found by the accessible name it carries.
 *
 * Never by its place in the list. A project is seeded with two steps, so every
 * leaf draws two bars and `[data-gantt-bar].nth(1)` is the *first* row's QA
 * slice rather than the second row's Dev one — the sixteenth check's own fault,
 * met again while writing this file and caught only because the dates on the
 * surface were a different row's. The label names both, which is what makes it
 * the handle: a bar found this way cannot be a bar about something else.
 */
const barOf = (page: Page, number: string, step: string): Locator =>
  page.locator(`[data-gantt-bar][aria-label^="${number} - "][aria-label*="${step} ·"]`);

/**
 * The rectangle of an element a locator names, or a throw.
 *
 * {@link rectOf} takes a selector and the surface is found by step, so this is
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
    //
    // `zeroQa`, so `010.2`'s span really is its `Dev` bar's span — see
    // `seedPlan`. Without it, since `assumed-duration-schedules`, the row's End
    // is two workdays past the bar being hovered and the assertion below
    // compares a bar's dates against a row's: watched failing on `unexpected
    // value "010.2 - (unnamed)Dev · UnassignedNo team5 Oct → 27 Nov · 40
    // days…"` against a Start cell reading further out.
    await seedPlan(page, nextAccount(), { estimate: '40/40/40', zeroQa: true });
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
    const saved = savedCommand(page, 'setEstimate');
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
 * The bar standing closest to the bottom of the window, measured **now**.
 *
 * Every coordinate comes back from the same `evaluate` that reads it, because
 * measuring a bar and then tapping where it used to be is how TASK-186's
 * investigation went wrong three separate times: an iframe whose layout said
 * 844 inside a window that was 770, a survey reused across cells while the
 * panel scrolled back to the top, and a bar that had moved 466px between the
 * measurement and the finger. Each time the hit test and the input dispatch
 * were answering different questions, and each time the result read as a
 * reproduced defect.
 *
 * Bars hanging off any edge are dropped rather than clamped: a clamped point is
 * a tap somewhere the mark is not.
 *
 * @param page The page holding the chart.
 * @returns The tap point, the bar's own edges — a card is placed *against* a
 * mark, so a claim about the card that never names the mark is a claim about a
 * rectangle in a window — how far its lower edge sits above the bottom of the
 * window, and its accessible name so a failure can say which mark it was
 * about.
 * @throws When no bar is wholly inside the window, which would leave the tap
 * below a claim about an empty chart.
 */
const lowestBarInTheWindow = (
  page: Page,
): Promise<{
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  gapBottom: number;
  named: string;
}> =>
  page.evaluate(() => {
    const height = window.innerHeight;
    const width = window.innerWidth;
    const inside = [...document.querySelectorAll('[data-gantt-bar]')]
      .map((mark) => ({ mark, box: mark.getBoundingClientRect() }))
      .filter(
        ({ box }) =>
          box.width > 0 &&
          box.height > 0 &&
          box.top >= 0 &&
          box.bottom <= height &&
          box.left >= 0 &&
          box.right <= width,
      )
      .map(({ mark, box }) => ({
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        left: box.left,
        right: box.right,
        top: box.top,
        gapBottom: height - box.bottom,
        named: mark.getAttribute('aria-label') ?? '(a bar with no name)',
      }))
      .sort((one, other) => one.gapBottom - other.gapBottom);
    if (inside.length === 0) throw new Error('no bar is wholly inside the window to tap');
    return inside[0];
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

  test('opens facts first in full screen, then dismisses or takes a deliberate second tap', async ({
    page,
  }) => {
    await seedOnALaptop(page, nextAccount(), { extraRows: 12 });
    await openTheChart(page, { throughTheSheet: true });
    await page.locator('[data-gantt-fullscreen-toggle]').tap();
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(1);

    const bar = page.locator('[data-gantt-bar]').first();
    await bar.tap();

    await expect(surface(page)).toBeVisible();
    await expect(surface(page)).toContainText('010.1');
    await expect(page.getByLabel('Name of 010.1')).not.toBeFocused();

    // A tap on the chart outside the open bar is the phone's dismissal route;
    // it leaves the reader in full screen and does not substitute another card.
    await page.locator('[data-axis-day="0"]').tap();
    await expect(surface(page)).toHaveCount(0);
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(1);

    // The first tap asks for facts again. The second tap on that same bar is a
    // deliberate navigation, so it leaves full screen and lands on the row.
    await bar.tap();
    await expect(surface(page)).toBeVisible();
    await bar.tap();
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(0);
    await expect(page.getByLabel('Name of 010.1')).toBeFocused();
  });

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

  test('opens a bar against the bottom edge, and keeps its card on the glass', async ({ page }) => {
    // **Costed extras, and that is what this fixture is for.** A row nobody has
    // estimated draws no bar at all since `gantt-declutter`, so free extra rows
    // give the chart height and leave every mark up at the top — which is
    // exactly why the coverage already here passed while TASK-186's bottom edge
    // was untested: every fixture bar sat in the top-left corner.
    // Thirty-two of them, and the count is measured rather than tasteful: full
    // screen is `inset-0`, so the chart's scroller is most of 844px and a row
    // is `ROW_PX` tall. Sixteen rows — the tallest fixture already in this file
    // — draw a chart shorter than the phone, `scrollTop` stays 0, and there is
    // no bottom edge to tap at all. Watched on h2puni, 2026-08-29: this test
    // failed on `the chart is not taller than the phone` before the bump.
    await seedOnALaptop(page, nextAccount(), { extraRows: 32, costedExtras: true });
    await openTheChart(page, { throughTheSheet: true });
    await page.locator('[data-gantt-fullscreen-toggle]').tap();
    await expect(page.locator('[data-gantt-fullscreen]')).toHaveCount(1);

    // The chart pinned to its own bottom, so the last mark drawn stands against
    // the lower edge of the phone instead of in the middle of it.
    const pinned = await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      panel.scrollTop = panel.scrollHeight;
      return { top: panel.scrollTop, scrollHeight: panel.scrollHeight, height: panel.clientHeight };
    });
    expect(
      pinned.top,
      `the chart is not taller than the phone (${String(pinned.scrollHeight)} in ${String(pinned.height)}), so no bar is at its bottom edge`,
    ).toBeGreaterThan(0);

    // Nothing open before the finger lands. Asserted rather than assumed: a
    // card left over from an earlier gesture makes every check below true
    // without this tap having opened anything, and a drive of this task that
    // did assume it reported a pass it had not earned.
    await expect(surface(page)).toHaveCount(0);

    const bar = await lowestBarInTheWindow(page);
    // The precondition, and the whole subject: within ~60px of the bottom, the
    // band the reported case sat in at `gapBottom 54`. Without it the tap could
    // land mid-window, where the card has room below it and this would be the
    // test above written a second time.
    expect(
      bar.gapBottom,
      `the lowest bar (${bar.named}) is ${String(Math.round(bar.gapBottom))}px off the bottom, which is not the edge`,
    ).toBeLessThanOrEqual(60);

    await page.touchscreen.tap(bar.x, bar.y);

    await expect(surface(page)).toBeVisible();
    // Full screen survived the tap. This is the one assertion about the touch
    // press rather than about placement: a press cleared between `pointerup`
    // and `click` falls through to `onPickRow`, which leaves full screen for
    // the row's card — a card opening is not by itself proof that it did not.
    await expect(
      page.locator('[data-gantt-fullscreen]'),
      'the tap fell through to the row instead of stopping at the facts',
    ).toHaveCount(1);

    const shown = await rectOfLocator(surface(page), 'the fact card');
    const window_ = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    // Placed below its bar this card would hang off the bottom, so the flip is
    // doing work here rather than agreeing with a placement that was inside the
    // window all along.
    expect(
      shown.height,
      'this bar has room for its card below it, so nothing had to flip',
    ).toBeGreaterThan(bar.gapBottom);
    // **Above the bar, and this is the assertion the rest hang off.** The four
    // window-bounds checks below cannot fail on their own: a card docked to the
    // bottom of the phone covering the bar, and a card that lost its anchor and
    // opened at `{0, 0}` seven hundred pixels away, both sit inside an 844px
    // window with a height greater than the gap. Named by the Gemini seat on
    // this PR, and it was right — the desktop flip test has compared against
    // `mark.top` since it was written and this one did not.
    expect(shown.bottom, 'the card was not drawn above its bar').toBeLessThanOrEqual(
      bar.top + NEARLY,
    );
    expect(shown.top, 'the card was flipped off the top of the phone').toBeGreaterThanOrEqual(
      -NEARLY,
    );
    expect(shown.bottom, 'the card hangs off the bottom of the phone').toBeLessThanOrEqual(
      window_.height + NEARLY,
    );
    expect(shown.left, 'the card hangs off the left of the phone').toBeGreaterThanOrEqual(-NEARLY);
    expect(shown.right, 'the card hangs off the right of the phone').toBeLessThanOrEqual(
      window_.width + NEARLY,
    );

    // And placed against the bar sideways too. Every number here is one the
    // browser measured — the bar's left edge, the card's own width, the window
    // — so this is an oracle rather than the placement rule restated: a card
    // reset to the left edge on touch, or clamped when it did not need to be,
    // fails it. `hover-card.test.tsx` unit-tests the arithmetic on numbers it is
    // handed; that the numbers are ever measured is only true in here.
    expect(
      shown.left,
      'the card does not open from its bar’s left edge, or from the clamp the phone forces',
    ).toBeCloseTo(Math.max(0, Math.min(bar.left, window_.width - shown.width)), 0);

    // Outside the chart's own scroller — the narrower claim this can honestly
    // make, and deliberately not called "not clipped": a card rendered inside
    // the panel is cut by the panel's `overflow` whatever its rectangle said,
    // and a rectangle is all the checks above can see. It does **not** rule out
    // a clipper elsewhere or a later overlay painted over the card; the
    // full-screen stacking relationship is held elsewhere in this suite, and
    // painted pixels are beyond any bounding box.
    //
    // **Not a `paintedAt`-style hit test, and that is deliberate.**
    // `pointer-events: none` is the default on a hover card and load-bearing
    // (`hover-card.tsx`): a card hangs over the row beneath it and one that
    // takes the mouse eats a click aimed at that row. So
    // `elementFromPoint` at the card's centre answers with the bar underneath
    // it, and an assertion written that way fails about a design decision
    // rather than about a fault. Watched here, 2026-08-29: `Received "<rect
    // data-gantt-bar …>"` on a card that was open, placed and readable.
    const clipper = await page.evaluate(() => {
      const card = document.querySelector('[role="tooltip"]');
      if (card === null) throw new Error('the fact card is not on the page');
      const panel = document.querySelector('[data-gantt-panel]');
      if (panel === null) throw new Error('the Gantt panel is not on the page');
      return { insideTheScroller: panel.contains(card) };
    });
    expect(
      clipper.insideTheScroller,
      'the card is rendered inside the chart’s scroller, which clips it',
    ).toBe(false);

    // The one window this case cannot close, named rather than papered over:
    // the survey and the tap are two protocol round trips, so a layout that
    // moved between them would be tapped where the bar used to be. The scroll
    // before it is synchronous and nothing here animates, and the card naming
    // its own row below is what catches a tap that landed on a different bar. A
    // locator `tap()` would not fix it either — its `scrollIntoViewIfNeeded` is
    // free to scroll the bar away from the very edge this case is about.

    // And it says something, about this bar. A card of the right size in the
    // right place with nothing legible in it meets every rectangle assertion
    // above.
    const [number] = bar.named.split(' - ');
    expect(number, 'the bar carries no row number to hold its card to').toBeTruthy();
    await expect(surface(page)).toContainText(number);
    const facts = (await surface(page).textContent()) ?? '';
    expect(facts.trim().length, 'the card is open and says nothing').toBeGreaterThan(20);
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

  test('stays inside the column it lives in', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // Far past anything the column can hold, and no further: this project's
    // viewport is 900 tall, so a drag that ran off the top of it would be
    // measuring Chromium's willingness to dispatch a move at a negative `y`
    // rather than the clamp. The reported drag was 419px up in a column with
    // 488px for the panel; 400 clears the room at this size several times over,
    // and the old `0.8 × 900` cap would have allowed all of it.
    await dragTheEdge(page, -400);

    const panel = await rectOf(page, '[data-gantt-panel]');
    // The plan's flex column, by the attribute the section already carries.
    const column = await rectOf(page, 'section[data-slice-count]');
    // **The assertion this test exists for.** Measured in Chrome 2026-08-29
    // with the viewport clamp in force: the panel's bottom landed at 1200
    // against a column bottom of 955 — 245px of chart drawn outside the box it
    // lives in. A sub-pixel of tolerance, for the same reason every other
    // measurement here carries one.
    //
    // **Containment is a conjunction, and each half alone is invisible here.**
    // Proof, watched in Chromium at 1400x900 on 2026-08-30, three injections:
    // the viewport cap put back in `clampedGanttHeight` alone — **passed**, the
    // measured `max-height` holding the panel at 425; `maxHeight: '80vh'` put
    // back alone — **passed**, the measured clamp holding the height at 425;
    // and the two together, which is the regime this change replaced — failed
    // on `the chart is drawn past the bottom of its column · Expected: <= 893 ·
    // Received: 956`, 64px of chart below a column bottom of 892. So a `Proof:`
    // naming only one of the two would be naming a fault this line never sees.
    expect(panel.bottom, 'the chart is drawn past the bottom of its column').toBeLessThanOrEqual(
      column.bottom + 1,
    );

    // And nothing scrolls to reach an overhang, which is what makes the line
    // above the whole of the guarantee rather than half of it. This pair
    // **passed through the fault** — `document.scrollHeight` was 963 against a
    // 963px window with 245px of chart off the bottom, because every ancestor
    // is `overflow: visible` inside a non-scrolling `h-full` column and an
    // overflow nothing clips makes no scrollbar. It is here to say so, not to
    // catch it.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      ),
      'the page grew instead',
    ).toBe(0);
    expect(panel.bottom, 'the chart is drawn past the bottom of the window').toBeLessThanOrEqual(
      await page.evaluate(() => window.innerHeight),
    );
  });

  /**
   * The panel's own height, read off the box the browser laid out.
   *
   * A function rather than a `Rect` so `expect.poll` can watch it across a
   * resize: the re-clamp happens on the `ResizeObserver`'s callback, which is a
   * frame or two after `setViewportSize` returns.
   */
  const panelHeight = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (!(panel instanceof HTMLElement)) throw new Error('no chart panel on the page');
      return Math.round(panel.getBoundingClientRect().height);
    });

  test('a height dragged in a tall window is clamped in a short one', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);
    await dragTheEdge(page, -400);
    const dragged = await panelHeight(page);
    // Measured in Chromium 2026-08-30: a 900px window gives this column 843px
    // and the panel 425 of them. The figure is read rather than written down —
    // what this test is about is the *relation* between two windows.
    expect(dragged).toBeGreaterThan(300);

    // The same page, 200px shorter. Nothing was dragged and nothing was
    // stored: only the column changed, and the height is drawn against the
    // column. Measured: 843 → 643 of column, 425 → 225 of panel.
    await page.setViewportSize({ width: 1400, height: 700 });
    await expect
      .poll(() => panelHeight(page), { message: 'the chart kept a height the column lost' })
      .toBeLessThan(dragged - 100);

    // **What this does not prove.** The panel's `max-height` is the same
    // measured room, so the browser contains it whether or not the height it is
    // handed was re-clamped: with `appliedGanttHeight` taken out of
    // `wbs-table.tsx` altogether — the raw claim passed down — this test was
    // watched **passing** (Chromium, 2026-08-30). What the re-clamp is
    // separately answerable for is the claim it leaves alone, which is the case
    // below and the assertion at the end of this one.
    const shortened = await rectOf(page, '[data-gantt-panel]');
    const column = await rectOf(page, 'section[data-slice-count]');
    expect(
      shortened.bottom,
      'the chart is drawn past the bottom of the column it was re-clamped into',
    ).toBeLessThanOrEqual(column.bottom + 1);
    // And the reader's claim is untouched by having been clamped: it is what
    // they dragged, not what today's window could show them.
    expect(await storedHeights(page)).toEqual([String(dragged)]);
  });

  test('a wider window gives the dragged height back', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);
    await dragTheEdge(page, -400);
    const dragged = await panelHeight(page);

    await page.setViewportSize({ width: 1400, height: 700 });
    await expect
      .poll(() => panelHeight(page), { message: 'the short window never re-clamped' })
      .toBeLessThan(dragged - 100);

    // **The assertion this pair exists for.** A re-clamp that wrote itself back
    // would have forgotten the gesture here, and the only window in which the
    // two are distinguishable is this one: a claim and a claim-clamped-once
    // draw the same panel in the short window and differ only once the room
    // comes back.
    //
    // Proof: with the re-clamp writing itself back — `setGanttHeightPx` and
    // `rememberGanttHeight` on the measured room, in the layout effect — this
    // failed on `the chart did not get the dragged height back · Expected: 425
    // · Received: 225`, and the case above failed on the stored array,
    // `- "425" + "225"`. Watched in Chromium 2026-08-30.
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect
      .poll(() => panelHeight(page), { message: 'the chart did not get the dragged height back' })
      .toBe(dragged);
    expect(await storedHeights(page)).toEqual([String(dragged)]);
  });

  /**
   * The room is re-measured when a **child** of the column changes height, not
   * only when the column itself does.
   *
   * Measured in Chromium at 768x900 on 2026-08-30, on the shipped clamp: the
   * toolbar is one row (68px) while nothing has been dragged, and the commit of
   * a drag puts `Reset layout` on it, which takes it to two rows (104px). The
   * column's own box never changes — it is `flex-1` in a full-height page — so
   * the `ResizeObserver` watching the column alone never fires, the room stays
   * at the 425 measured at `pointerdown`, and the panel's bottom lands at 904
   * against a column bottom of 892. Twelve pixels of chart outside the box it
   * lives in, by the control the gesture itself created.
   *
   * The wrap is asserted before the containment, and that is not decoration:
   * with the toolbar at one row this is `stays inside the column it lives in`
   * at a narrower window, and it would pass for a reason that has nothing to do
   * with what it is about.
   *
   * Proof, watched in Chromium 2026-08-30, two faults on the same line. With
   * the children left unobserved — the `ResizeObserver` on the column alone,
   * which is what shipped — this failed on `the chart is drawn past the bottom
   * of its column after the toolbar wrapped · Expected: <= 893 · Received:
   * 904`. And with `ganttRoomInColumn` replaced by the derived sum the slice
   * warns against (a nominal 68px toolbar, `TABLE_NEEDS_HEIGHT`, the handle and
   * a 24px footer) it failed identically — while `stays inside the column it
   * lives in` **passed** through that same fault, because at 1400x900 those
   * constants come to exactly the 418px the measurement does. That pair is the
   * whole argument for measuring: the derived sum is right at the one size
   * everything else is tested at.
   */
  test('re-measures the room when the toolbar wraps under a new control', async ({ page }) => {
    // Narrow enough that the toolbar takes a second row once `Reset layout`
    // joins it, and wide enough to stay on the table face: the cards renderer
    // takes over below this and has a different column entirely. Measured
    // 2026-08-30: 780 and 770 wrap as well, 790 and up do not.
    await page.setViewportSize({ width: 768, height: 900 });
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    /**
     * The plan toolbar's height, the panel's bottom and the column's, read
     * together so they describe one layout.
     *
     * The toolbar is found as the column child holding the chart toggle rather
     * than by an index, so a reordering of the column is a failure here rather
     * than a silent measurement of the wrong box.
     */
    const layout = (): Promise<{ toolbar: number; panelBottom: number; columnBottom: number }> =>
      page.evaluate(() => {
        const column = document.querySelector('section[data-slice-count]');
        if (!(column instanceof HTMLElement)) throw new Error('no plan column on the page');
        const toggle = Array.from(column.querySelectorAll('button')).find(
          (button) => button.textContent.trim() === 'Gantt',
        );
        if (toggle === undefined) throw new Error('no chart toggle in the plan column');
        const toolbar = Array.from(column.children).find((child) => child.contains(toggle));
        if (!(toolbar instanceof HTMLElement))
          throw new Error('the chart toggle is in no column child');
        const panel = document.querySelector('[data-gantt-panel]');
        if (!(panel instanceof HTMLElement)) throw new Error('no chart panel on the page');
        return {
          toolbar: toolbar.getBoundingClientRect().height,
          panelBottom: panel.getBoundingClientRect().bottom,
          columnBottom: column.getBoundingClientRect().bottom,
        };
      });

    const folded = await layout();
    await dragTheEdge(page, -400);
    const wrapped = await layout();

    expect(
      wrapped.toolbar,
      'the toolbar did not take a second row, so this is the 1400px case at a narrower window',
    ).toBeGreaterThan(folded.toolbar);
    expect(
      wrapped.panelBottom,
      'the chart is drawn past the bottom of its column after the toolbar wrapped',
    ).toBeLessThanOrEqual(wrapped.columnBottom + 1);
  });

  /**
   * The other half of the report, and the half this change does **not** fix.
   *
   * Measured on 2026-08-29: a drag of 178px up made the panel 178px taller and
   * left `handleTop` where it was, at 569. The cause is not the panel's
   * `shrink-0` and is not the clamp — it is that the column had 226px of
   * positive free space **below** the panel, and a flex column with every item
   * at `flex-grow: 0` leaves its leftover at the end. The panel spends that
   * before the boundary can move, whatever it is allowed to shrink to.
   *
   * Where that leftover goes is `unified-scroll-docking`'s decision, taken
   * deliberately: the frame is `flex: 0 1 auto` so that "nothing left over is
   * spent on a frame that has no rows to put in it" (`table-frame.ts`), which
   * is what put the leftover under the chart. Moving it back above the chart —
   * a `margin-top: auto` on the panel, or the frame growing again — restores
   * exactly the 508px of nothing between the last row and the chart that that
   * change removed.
   *
   * So this is a decision to revisit, not a bug to patch, and it is left
   * failing rather than quietly dropped. `test.fixme` and not a deletion: the
   * assertion is right, and the day the leftover moves it should go green
   * without being rewritten.
   */
  test.fixme('dragging up moves the boundary up', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);
    const panelAtRest = await rectOf(page, '[data-gantt-panel]');
    const handleAtRest = await rectOf(page, '[data-gantt-height-handle]');

    await dragTheEdge(page, -150);

    const panelDragged = await rectOf(page, '[data-gantt-panel]');
    const handleDragged = await rectOf(page, '[data-gantt-height-handle]');
    expect(panelDragged.height).toBeGreaterThan(panelAtRest.height);
    expect(handleDragged.top, 'the boundary did not follow the pointer').toBeLessThan(
      handleAtRest.top,
    );
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
 * The bottom edge of a panel the reader has dragged short.
 *
 * Dany's report, 2026-08-29, with screenshots: dragging the divider down leaves
 * the chart cut through a row, and macOS draws its scrollbars as overlays —
 * invisible until something moves them. Measured in Chromium against the dev
 * server at `height: 124` over a `scrollHeight` of 196: the panel scrolls, and
 * reads as broken.
 *
 * **Every check here is one jsdom cannot make**, which is the whole reason the
 * block is in this file rather than in `gantt-panel.test.tsx`. A fold is
 * `scrollHeight` against `clientHeight`, a sticky axis is a paint position, and
 * a bar sitting on its own label is two rectangles: jsdom answers 0 to all of
 * them and would watch every fault below pass. That is the fault class
 * `AGENTS.md` R5 counts five shipped instances of.
 */
test.describe('the bottom edge of a chart dragged short', () => {
  /** What the panel's scroll box says about itself, as the browser has it. */
  const scrollOf = (
    page: Page,
  ): Promise<{ clientHeight: number; scrollHeight: number; scrollTop: number }> =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (!(panel instanceof HTMLElement)) throw new Error('the Gantt panel is not on the page');
      return {
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
        scrollTop: panel.scrollTop,
      };
    });

  /**
   * Drags the edge down and refuses to go on unless the chart really overflows
   * the panel afterwards.
   *
   * The premise of every case here is that there is chart below the edge. A
   * panel that still held all of it would draw no cue and take the bottom half
   * of each test with it — the check would be about a chart that is not there,
   * which is the shape of vacuity this repository keeps a tally of.
   */
  async function shrinkPastTheChart(page: Page, travel: number): Promise<void> {
    await dragTheEdge(page, travel);
    const port = await scrollOf(page);
    expect(
      port.scrollHeight,
      'the panel still holds the whole chart, so there is no fold to test',
    ).toBeGreaterThan(port.clientHeight + 1);
  }

  /** The painted fade, which is drawn only while there is chart below the edge. */
  const fade = (page: Page): Locator => page.locator('[data-gantt-more-below]');

  /** Puts the panel at a scroll offset and says where it landed. */
  const scrollThePanel = (page: Page, to: number): Promise<number> =>
    page.evaluate((offset) => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (!(panel instanceof HTMLElement)) throw new Error('the Gantt panel is not on the page');
      panel.scrollTop = offset;
      return panel.scrollTop;
    }, to);

  /**
   * How much of the panel's visible width the fade really covers, in CSS
   * pixels — their overlap, not the fade's own width.
   *
   * One number rather than an assertion on each edge, and that is R5's doing:
   * a fade that slides away with the calendar goes **left**, so a `left <=
   * panel.left` check passes for the very fault the case exists to catch and
   * could never be watched failing. The overlap falls for a fade that is too
   * narrow and for one displaced either way.
   */
  const bandCovered = (fade: Rect, panel: Rect): number =>
    Math.min(fade.right, panel.right) - Math.max(fade.left, panel.left);

  test('fades while there is chart below it, and lifts at the last row', async ({ page }) => {
    // Seven rows: enough that a dragged panel cannot hold them, few enough that
    // the panel at rest can — the two halves of this case are the same fixture
    // at two heights.
    await seedPlan(page, nextAccount(), { extraRows: 4 });
    await openTheChart(page);

    const atRest = await scrollOf(page);
    expect(
      atRest.scrollHeight,
      'the chart already overflows the panel at rest, so the cue below says nothing',
    ).toBeLessThanOrEqual(atRest.clientHeight + 1);
    // Proof: with the condition dropped — `{true && (…)}` in place of
    // `{moreBelow && (…)}` — this failed on `a chart with nothing below it is
    // still fading its edge … Expected: 0, Received: 1`. Watched in Chromium
    // 2026-08-29.
    await expect(fade(page), 'a chart with nothing below it is still fading its edge').toHaveCount(
      0,
    );

    await shrinkPastTheChart(page, 120);

    // Proof: with the cue never drawn — `{false && (…)}` in place of
    // `{moreBelow && (…)}` — this failed on `page.evaluate: Error: nothing on
    // the page at [data-gantt-more-below]`. Watched in Chromium 2026-08-29.
    const cue = await rectOf(page, '[data-gantt-more-below]');
    const panel = await rectOf(page, '[data-gantt-panel]');
    expect(
      Math.abs(cue.bottom - panel.bottom),
      'the fade is not on the edge it is about',
    ).toBeLessThanOrEqual(NEARLY);
    expect(cue.top, 'the fade covers the whole panel rather than its edge').toBeGreaterThan(
      panel.top,
    );
    // Proof: with `min-w-full` struck from the cue's class list, this failed on
    // `the fade does not reach across the panel … Expected: >= 1367, Received:
    // 536` — the fade as wide as the chart's own content (176px of names and a
    // six-day calendar) on a 1368px panel. Watched in Chromium 2026-08-29.
    expect(
      bandCovered(cue, panel),
      'the fade does not reach across the panel',
    ).toBeGreaterThanOrEqual(panel.width - NEARLY);

    // At the last row there is nothing below to promise, and the cue goes.
    //
    // Proof: with the reader's own offset dropped from the sum —
    // `chartBelowTheFold` returning `scrollHeight - clientHeight` — this failed
    // on `the fade is still over the chart at its last row … Expected: 0,
    // Received: 1`. That is the fault worth catching here rather than the cue
    // deleted: a chart that overflows at all would fade for ever, whatever the
    // reader did about it. Watched in Chromium 2026-08-29.
    const bottom = await scrollThePanel(page, 10_000);
    expect(bottom, 'the panel did not scroll, so the cue had no reason to lift').toBeGreaterThan(0);
    await expect(fade(page), 'the fade is still over the chart at its last row').toHaveCount(0);

    // And it comes back on the way up: the cue is a fact about where the reader
    // is, not a one-way switch. **Here to say so rather than to catch it** —
    // every fault that stops the cue tracking the scroll leaves it drawn at the
    // last row, so it is the line above that goes red, and this one has never
    // been watched failing on its own.
    await scrollThePanel(page, 0);
    await expect(fade(page), 'the fade did not come back above the last row').toHaveCount(1);
  });

  test('covers the visible band with the calendar scrolled right', async ({ page }) => {
    // Wide enough that 1400px cannot hold it — `holds the labels at the left
    // edge` uses the same 80-workday horizon — and tall enough that a dragged
    // panel cannot either.
    await seedPlan(page, nextAccount(), { estimate: '40/40/40', extraRows: 4 });
    await openTheChart(page);
    await shrinkPastTheChart(page, 120);
    await scrollChartFullyRight(page);

    // The cue lives in the panel's own scroll box, so a cue as wide as the box
    // is one pinned at the content's left edge: it slides away with the
    // calendar and leaves the fold it is about bare.
    //
    // Proof: with the measured span replaced by the box — `width: '100%'` in
    // place of `width: chartSpanPx ?? '100%'` — this failed on `the fade does
    // not reach across the panel … Expected: >= 1367, Received: -656`: the cue
    // had scrolled 656px past the panel's left edge and covered none of it.
    // Watched in Chromium 2026-08-29.
    const cue = await rectOf(page, '[data-gantt-more-below]');
    const panel = await rectOf(page, '[data-gantt-panel]');
    expect(
      bandCovered(cue, panel),
      'the fade does not reach across the panel',
    ).toBeGreaterThanOrEqual(panel.width - NEARLY);
  });

  test('keeps the calendar over the bars, and every bar on its own label', async ({ page }) => {
    // Costed extras, because this case is about bars: uncosted rows draw a
    // label and nothing beside it, and there would be nothing to pair.
    await seedPlan(page, nextAccount(), { extraRows: 4, costedExtras: true });
    await openTheChart(page);
    await shrinkPastTheChart(page, 120);

    const moved = await scrollThePanel(page, 2 * ROW_PX);
    expect(moved, 'the panel did not scroll, so nothing was carried past the axis').toBeGreaterThan(
      0,
    );

    // The dates stay put. A calendar that rides up with the chart takes every
    // bar's day with it, and a reader who scrolled two rows is looking at a
    // chart that no longer says when anything happens.
    //
    // Proof: with `sticky top-0` struck from `[data-gantt-axis]`'s class list,
    // this failed on `the calendar rode up with the chart … Expected: <= 1,
    // Received: 56` — the two rows the panel had been scrolled by. Watched in
    // Chromium 2026-08-29.
    const stuck = await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (!(panel instanceof HTMLElement)) throw new Error('the Gantt panel is not on the page');
      const axis = panel.querySelector('[data-gantt-axis]');
      if (axis === null) throw new Error('the chart drew no calendar axis');
      // The panel's own top border is not content: the axis stands under it.
      const border = Number.parseFloat(getComputedStyle(panel).borderTopWidth);
      if (!Number.isFinite(border)) throw new Error('the panel has no computed top border');
      return {
        contentTop: panel.getBoundingClientRect().top + border,
        axisTop: axis.getBoundingClientRect().top,
      };
    });
    expect(
      Math.abs(stuck.axisTop - stuck.contentTop),
      'the calendar rode up with the chart',
    ).toBeLessThanOrEqual(NEARLY);

    // And a name is still level with its own bar. The label column scrolls
    // vertically with the chart and holds only horizontally — the corner over
    // it is what keeps the first name beside the first cell rather than under
    // the axis, and a chart whose rows have slipped a row against their names
    // is worse than one that is merely cut.
    //
    // Proof: with the label column's sticky corner spacer deleted — the one row
    // of height that puts the first name beside the first cell — this failed on
    // `these bars are not on their own row`, four entries against an empty
    // array, the first `010.2: bar 566.3524780273438–584.2725219726562 against
    // label 533.3125–561.3125`. Watched in Chromium 2026-08-29.
    const paired = await page.evaluate(() => {
      const panel = document.querySelector('[data-gantt-panel]');
      if (!(panel instanceof HTMLElement)) throw new Error('the Gantt panel is not on the page');
      const axis = panel.querySelector('[data-gantt-axis]');
      if (axis === null) throw new Error('the chart drew no calendar axis');
      // Only what the reader can see under the calendar: a bar scrolled out of
      // the box is nobody's evidence about alignment.
      const band = {
        top: axis.getBoundingClientRect().bottom,
        bottom: panel.getBoundingClientRect().bottom,
      };
      const labels = new Map<string, DOMRect>();
      for (const label of panel.querySelectorAll('[data-gantt-label]')) {
        const id = label.getAttribute('data-gantt-label') ?? '';
        labels.set(id, label.getBoundingClientRect());
      }
      const checked: string[] = [];
      const slipped: string[] = [];
      for (const bar of panel.querySelectorAll('[data-gantt-bar]')) {
        const box = bar.getBoundingClientRect();
        if (box.top < band.top || box.bottom > band.bottom) continue;
        // A slice id is `${workItemId} ${stepId}`, and the label is the
        // work item's.
        const sliceId = bar.getAttribute('data-gantt-bar') ?? '';
        const rowId = sliceId.split(' ')[0] ?? '';
        const label = labels.get(rowId);
        if (label === undefined) throw new Error(`the bar ${sliceId} has no row label to sit on`);
        checked.push(rowId);
        if (box.top < label.top - 1 || box.bottom > label.bottom + 1) {
          const number = bar.getAttribute('aria-label')?.split(' - ')[0] ?? rowId;
          slipped.push(
            `${number}: bar ${String(box.top)}–${String(box.bottom)} against label ` +
              `${String(label.top)}–${String(label.bottom)}`,
          );
        }
      }
      return { checked, slipped };
    });
    expect(
      paired.checked.length,
      'no bar was on screen under the calendar, so nothing was compared',
    ).toBeGreaterThan(0);
    expect(paired.slipped, 'these bars are not on their own row').toEqual([]);
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
    // fixture that renumbered would otherwise quietly test one step twice.
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
    // `data-fact` since `tool-hints-wait`: a row's number and name are words
    // about the plan, so the label says them at once rather than after a wait.
    await expect(page.locator('[data-gantt-label-lit]')).toHaveAttribute('data-fact', /^010\.2 - /);

    // **And the row the pointer is on lights itself**, which is the half that
    // reversed in `pointed-row-one-ink`. It used to be left to `tr:hover` so the
    // alternating band would keep showing through: `data-row-lit` on every
    // hovered row makes `tr:not([data-row-lit])…:nth-child(even):hover`
    // unmatchable, which is how this failed four of `hover-cards.spec.ts`'s
    // assertions in 2026-08-14. Dany, 2026-09-01: "highlighted row is colored
    // independently of which odd or even row this is" — so the unmatchable rule
    // is the mechanism now, and exactly one row carries the light on each face.
    const lit = page.locator('tbody tr[data-row-lit]');
    await expect(lit).toHaveCount(1);
    await expect(lit.getByLabel('Name of 010.2')).toHaveCount(1);
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

/**
 * Two roots, both steps of the first one estimated, and the second waiting on
 * it — the smallest plan the two dependency reaches disagree about.
 *
 * `010` is Dev 0→2 then QA 2→5; `020` is Dev alone. Under `whole-item` the
 * wait is `010`'s QA, so `020` starts at workday 5; under `anchor-slice` it is
 * `010`'s Dev and `020` starts at workday 2. A plan whose predecessor has one
 * estimated step — which is what `seedPlan` above builds — is a plan the two
 * reaches agree about entirely, and would make every assertion below vacuous.
 */
async function seedTwoStepChain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await createProject(page);
  await expect(page.getByRole('button', { name: 'Add work item' })).toBeVisible();
  await setDate(page, 'Project start date', PLAN_START);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  for (const [number, role, days] of [
    ['010', 'Dev', '2/2/2'],
    ['010', 'QA', '3/3/3'],
    ['020', 'Dev', '1/1/1'],
  ] as const) {
    const box = page.getByLabel(`${role} estimate for ${number}`);
    await box.fill(days);
    await box.blur();
    await expect(box).not.toHaveValue('');
  }

  const depends = page.getByLabel('Add a dependency to 020');
  await depends.click();
  await depends.fill('010');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 020 waiting for 010' })).toBeVisible();
}

/** Picks a reach in the Phases dialog and closes it again. */
async function chooseTheReach(page: Page, option: string): Promise<void> {
  // Two gestures since `project-config-modal`: the toolbar's one `Project
  // settings` control, then its `Steps` tab (`Phases` until `steps-not-phases`).
  // The reach lives on that section because it is a statement about how the
  // steps above it chain.
  await page.getByRole('button', { name: 'Project settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Project settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Steps' }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      /\/api\/projects\/[^/]+$/.test(response.url()) &&
      (response.request().postData() ?? '').includes('"depReach"'),
  );
  await page.getByRole('radio', { name: new RegExp(option) }).click();
  await saved;
  // The modal refuses a close while any section holds a write in flight
  // (`project-config-modal` D3), and the reach's own re-read lands just after
  // the PATCH awaited above. Press until the surface is gone rather than once.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Project settings' })).toHaveCount(0);
  }).toPass();
}

test.describe('how far a dependency reaches, from the chart', () => {
  test('the successor bar moves when the project changes its reach', async ({ page }) => {
    // The change's headline in a browser: the same plan, the reach flipped, and
    // the successor's bar measured where the browser actually draws it.
    //
    // Both halves are asserted. `data-start` is the engine's own workday, which
    // is what moved; the rectangle is the layout, which jsdom cannot compute at
    // all and which is the only thing that can say the chart the reader sees
    // moved with it. The bar is found through its row and its role — never by
    // position, since every leaf here draws two bars — and `rectOfLocator`
    // refuses a box with no area, so a bar that stopped being drawn cannot
    // compare equal to one that moved.
    //
    // Proof: `attempt(() => setDepReach(reach))` in `phases-dialog.tsx`
    // replaced by a bare `void setDepReach(reach)` — the write made and the
    // plan never re-read, which is the fault a jsdom test that asserts on a
    // mock cannot see — and this failed on
    // `expect(received).toBe(expected) // Object.is equality
    //  Expected: "2"  Received: "5"`, the chart still drawn for the old reach
    // with be-01 already holding the new one. Watched 2026-08-29.
    await seedTwoStepChain(page);
    await openTheChart(page);

    const successor = barOf(page, '020', 'Dev');
    await expect(successor).toHaveAttribute('data-start', '5');
    const wholeItem = await rectOfLocator(successor, "020's Dev bar under whole-item");
    // The predecessor's own QA is what the wait reaches to, and it must not
    // move: the reach decides what an edge leaves from, never what a step costs.
    const qa = barOf(page, '010', 'QA');
    await expect(qa).toHaveAttribute('data-start', '2');
    const qaBefore = await rectOfLocator(qa, "010's QA bar");

    await chooseTheReach(page, 'The first estimated step');

    await expect(successor).toHaveAttribute('data-start', '2');
    const anchored = await rectOfLocator(successor, "020's Dev bar under anchor-slice");
    expect(anchored.left).toBeLessThan(wholeItem.left);
    // And back again, so the assertion above is about the reach rather than
    // about any write at all moving the chart leftwards.
    await chooseTheReach(page, 'The whole work item');
    await expect(successor).toHaveAttribute('data-start', '5');
    expect((await rectOfLocator(successor, "020's Dev bar, back")).left).toBe(wholeItem.left);
    // The dates that must not move, measured rather than argued.
    await expect(qa).toHaveAttribute('data-start', '2');
    expect(await rectOfLocator(qa, "010's QA bar, after")).toEqual(qaBefore);
  });

  test('the arrow leaves the slice the reach names', async ({ page }) => {
    // The drawing and the schedule cannot disagree. Under `whole-item` the
    // arrow leaves `010`'s **QA** bar; under `anchor-slice` it leaves its Dev.
    // Measured as the arrow's own left-hand end against the two bars, because
    // an arrow keyed on the wrong reach reads as slack that is not there — and
    // no jsdom test can say where a path was painted.
    await seedTwoStepChain(page);
    await openTheChart(page);
    await askForTheDetail(page, 1);

    const dev = await rectOfLocator(barOf(page, '010', 'Dev'), "010's Dev bar");
    const qa = await rectOfLocator(barOf(page, '010', 'QA'), "010's QA bar");
    // The precondition: the two bars are at different places, or "leaves the QA
    // bar" and "leaves the Dev bar" would be the same claim.
    expect(qa.right).toBeGreaterThan(dev.right);

    const wholeItem = await rectOf(page, '[data-gantt-arrow]');
    expect(wholeItem.left).toBeGreaterThanOrEqual(dev.right);

    await chooseTheReach(page, 'The first estimated step');
    await expect(barOf(page, '020', 'Dev')).toHaveAttribute('data-start', '2');

    const anchored = await rectOf(page, '[data-gantt-arrow]');
    expect(anchored.left).toBeLessThan(wholeItem.left);
  });
});

test.describe('the chart docks to the bottom of its column', () => {
  /**
   * Dany, 2026-08-30, looking at a four-row plan: _"i need the whole gantt panel
   * to go down"_.
   *
   * The chart was stacked directly under a short plan's table frame and left
   * half a screen of white below it — measured in Chromium at 1600×1000 on a
   * one-row plan: the column 943px, its children 439px, **528px of dead space
   * under the panel**. Every child was `flex-grow: 0`, so the room a short plan
   * did not use went to nobody.
   *
   * `GANTT_DOCK_SLACK` is where it goes now. Both halves are asserted here
   * because jsdom lays nothing out and can see neither.
   */
  test('sits at the column’s bottom edge however short the plan is', async ({ page }) => {
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    // The column's bottom against its last **in-flow** child's. Read in the page
    // rather than through a selector: `div:last-of-type` picks the toast stack,
    // which is `position: fixed` and 0×0, and the first cut of this failed on
    // exactly that — `is drawn with no area: 0×0`.
    const docked = await page.evaluate(() => {
      const column = document.querySelector('[data-slice-count]');
      if (column === null) throw new Error('the chart column is not on the page');
      const inFlow = [...column.children].filter((child) => {
        const position = getComputedStyle(child).position;
        return position !== 'fixed' && position !== 'absolute';
      });
      const last = inFlow.at(-1);
      if (last === undefined) throw new Error('the column has no in-flow children');
      return {
        columnBottom: column.getBoundingClientRect().bottom,
        lastBottom: last.getBoundingClientRect().bottom,
        columnHeight: column.getBoundingClientRect().height,
      };
    });
    const panel = await rectOf(page, '[data-gantt-height-handle] + *');

    expect(docked.columnHeight, 'the column was not laid out').toBeGreaterThan(0);
    expect(panel.height, 'the panel was not laid out').toBeGreaterThan(0);
    // Nothing left over: the docked group ends where the column does.
    //
    // Proof: `GANTT_DOCK_SLACK` deleted, watched failing with 528px between the
    // two on a one-row plan.
    expect(
      docked.columnBottom - docked.lastBottom,
      'the column has room left under its last child, so the chart is not docked',
    ).toBeLessThanOrEqual(NEARLY);
  });

  test('and the handle still grows the chart, which an auto margin stopped', async ({ page }) => {
    // **The half that was broken by the first attempt at the docking above.**
    // `mt-auto` on the handle docked the panel correctly and killed the drag:
    // Chromium resolves an auto margin on a flex item to its *used* value, and
    // `ganttRoomInColumn` reads margins, so the room came back as nearly nothing
    // and the chart could not grow. 113px before the drag and 113px after it.
    //
    // The spacer is free of that because it declares a definite `min-height` and
    // can shrink to it, so the room sum credits it 0 rather than the slack it is
    // standing in — the rule that function already documents.
    await seedPlan(page, nextAccount());
    await openTheChart(page);

    const before = await rectOf(page, '[data-gantt-height-handle] + *');
    const handle = page.locator('[data-gantt-height-handle]');
    const grip = await handle.boundingBox();
    if (grip === null) throw new Error('the height handle is not on the page');

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y - 200, { steps: 12 });
    await page.mouse.up();

    const after = await rectOf(page, '[data-gantt-height-handle] + *');
    expect(after.height, 'dragging the handle up did not grow the chart').toBeGreaterThan(
      before.height + 50,
    );
    // And it is still docked, so the growth came out of the slack above it.
    expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(NEARLY);
  });
});

/**
 * The downloaded file's gutter, measured in the browser that drew it.
 *
 * jsdom measures no text at all, so the arithmetic half of this lives in
 * `gantt-panel.test.tsx` against a stand-in ruler and the half that is about a
 * real font in a real font stack lives here. The file is mounted back into the
 * page rather than parsed: an SVG's own `getBBox` answers in the document's
 * user units, which is the same space the divider's `x1` is written in, so the
 * two are directly comparable without a scale anywhere in the middle.
 */
test.describe('the chart downloaded as a standalone .svg', () => {
  test('a name longer than the gutter ends before the first day column', async ({ page }) => {
    // Long enough that it cannot fit 176px at 10px — and asserted below to
    // really not fit, rather than assumed: a name that fits would make every
    // assertion here true of a file with the fault still in it.
    const longName =
      'Hull, frames, plating and the whole of the forward compartment, welded and surveyed';
    await seedPlan(page, nextAccount());
    const named = page.getByLabel('Name of 010.1');
    await named.fill(longName);
    await named.blur();
    await expect(named).toHaveValue(longName);
    await openTheChart(page);

    // Block on the **chart** carrying the name rather than on the box holding
    // it. `toHaveValue` above reads an uncontrolled box, which holds what was
    // typed from the keystroke onwards and is therefore satisfied by its first
    // sample — before the blur's write has reached be-01 — while the chart's
    // labels are drawn from the *fetched* plan. Under the whole gate's load the
    // download then held the previous name and this failed on `the downloaded
    // file draws no “Hull, frames, plating and the whole of the forward
    // compartment, welded and surveyed”`, once in 274 cases, 2026-09-01; alone
    // it passed in 2.4s. Same shape as `hover-cards.spec.ts`'s seed blocking on
    // the persisted estimate (TASK-50, hover-card-estimate-race).
    await expect(page.locator('[data-gantt-label]').filter({ hasText: longName })).toHaveCount(1);

    const saving = page.waitForEvent('download');
    await page.locator('[data-gantt-svg-download]').click();
    const saved = await saving;
    const onDisk = await saved.path();
    const file = await readFile(onDisk, 'utf8');

    const measured = await page.evaluate(
      ({ text, name }) => {
        const host = document.createElement('div');
        host.style.position = 'absolute';
        host.style.left = '-10000px';
        host.style.top = '0';
        document.body.appendChild(host);
        try {
          host.innerHTML = text.replace(/^<\?xml[^?]*\?>\s*/, '');
          const root = host.querySelector('svg');
          if (root === null) throw new Error('the downloaded file holds no <svg>');
          // Direct children only: the nested live geometry brings its own
          // lines, and the divider is the outer document's own.
          const kids = [...root.children];
          const divider = kids.find(
            (kid) => kid.tagName === 'line' && kid.getAttribute('x1') === kid.getAttribute('x2'),
          );
          const label = kids.find(
            (kid) => kid.tagName === 'text' && kid.textContent.includes(name),
          );
          const plot = kids.find((kid) => kid.tagName === 'svg');
          if (divider === undefined) throw new Error('the downloaded file draws no divider');
          if (label === undefined) throw new Error(`the downloaded file draws no “${name}”`);
          if (plot === undefined) throw new Error('the downloaded file nests no chart');
          const box = (label as SVGGraphicsElement).getBBox();
          return {
            dividerX: Number(divider.getAttribute('x1')),
            plotX: Number(plot.getAttribute('x')),
            labelLeft: box.x,
            labelRight: box.x + box.width,
            labelWidth: box.width,
            labelHeight: box.height,
          };
        } finally {
          host.remove();
        }
      },
      { text: file, name: longName },
    );

    // The label was really drawn — a `<text>` with no area sits left of
    // everything and would satisfy the comparison below whatever the gutter is
    // (R5 #16's zero-width bar, in this file).
    expect(
      measured.labelWidth,
      'the label has no width, so nothing below is a measurement',
    ).toBeGreaterThan(0);
    expect(measured.labelHeight).toBeGreaterThan(0);
    // And it really is a name the old constant could not hold, which is what
    // makes this case able to fail at all.
    expect(
      measured.labelRight,
      'this name fits the old gutter, so the file under test has nothing to widen',
    ).toBeGreaterThan(LABEL_COLUMN_PX);

    expect(
      measured.labelRight,
      'the name is drawn across the divider and under the bars',
    ).toBeLessThanOrEqual(measured.dividerX);
    // And the plot begins where the divider stands, so what the gutter took is
    // room the chart gave up rather than room drawn over.
    expect(measured.plotX).toBe(measured.dividerX);
  });
});

/**
 * Slice 8.2a's browser tier — the half jsdom cannot reach.
 *
 * The jsdom tier (`gantt-panel.test.tsx`) pins the rule's tag, its
 * `vector-effect` attribute and its declared width. None of those three says
 * the stroke reaches the screen as a hairline: the chart's user space is days
 * by rows stretched to `dayPx` (`viewBox` with `preserveAspectRatio="none"`),
 * so a declared `1` without the mechanism rasterizes **a whole day wide** and
 * passes every attribute assertion there is. Only pixels can tell those two
 * renderers apart, and only at two rungs — a single rung cannot distinguish a
 * non-scaling stroke from a width that happens to equal that rung's day pixels.
 *
 * **The oracle is painted columns, not `boundingBox().width`.** The rule is a
 * vertical `<line>` with `x1 === x2` and therefore has no area; this file's own
 * `seedEdgeRoutes` note records that a browser reports such a line hidden. The
 * box cannot see the stroke, which is painted outside the geometry it measures.
 *
 * Three clips per rung, and the two derived sets are what close the two holes a
 * single comparison leaves. `totalInk` is what the marker adds; `ruleInk` is
 * what the queried element itself adds. A coincident untagged 2px line makes
 * `ruleInk` empty; an adjacent untagged 1px line makes the two sets differ; an
 * auxiliary line in some other row band survives both, and is caught by the
 * whole-body identity instead. The arithmetic between the clips lives in
 * `marker-rule-ink.ts`, where each of its faults is watchable on a box with no
 * browser on it.
 */
test.describe('the marker rule, measured in the columns it paints', () => {
  /**
   * 28 and 4 are the ends of the ladder and are what make the mechanism
   * visible; 12 is rendered too because the requirement says *every* rung and a
   * fault conditioned on the middle one would otherwise reach no browser
   * assertion at all.
   */
  const RUNGS = [DAY_PX, 12, 4] as const;

  /**
   * The day the marker stands on: far enough in that the strip clears the
   * chart's left padding at the narrowest rung, early enough that the last
   * row's bar has not started yet, so the band the strip crosses is empty.
   */
  const MARKED_OFFSET = 3;

  /** Half the strip's width, in columns either side of the rule. */
  const STRIP_REACH_PX = 6;

  /** A clip of the chart, as the page can carry it back in. */
  interface Strip {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  /**
   * Where to clip, recomputed from live geometry every time.
   *
   * Chart-relative rather than absolute: creating the marker puts a chip in the
   * sticky header, and a header that grows moves the body down. Absolute clips
   * taken either side of that would compare different content and the identity
   * below would fail for the wrong reason.
   */
  async function geometryOf(page: Page): Promise<{ strip: Strip; body: Strip }> {
    return page.evaluate(
      ({ offset, reach }) => {
        const chart = document.querySelector('[data-gantt-chart]');
        const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
        const rows = [...document.querySelectorAll('[data-gantt-row-line]')];
        if (chart === null) throw new Error('nothing on the chart at [data-gantt-chart]');
        if (cell === null) throw new Error(`no axis cell at day ${String(offset)}`);
        // The length rather than the element: without `noUncheckedIndexedAccess`
        // an index off a non-empty-typed array is not `undefined` to the
        // checker, and the guard would read as an impossible comparison.
        if (rows.length === 0) throw new Error('the chart draws no row lines');
        const band = rows[rows.length - 1];
        const chartBox = chart.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        const bandBox = band.getBoundingClientRect();
        return {
          // A short horizontal strip crossing the rule, in a row band with no
          // bar in it. The rule stands at the axis cell's own left edge: the
          // band carries the same `CHART_PAD_PX` the SVG keeps at its left, so
          // day 0's cell starts where user x=0 does.
          strip: {
            x: Math.round(cellBox.x - reach),
            y: Math.round(bandBox.y + 4),
            width: reach * 2 + 1,
            height: 8,
          },
          // The rows and not the axis band: the chip is header ink and is
          // supposed to differ. `[data-gantt-chart]` is the body SVG alone,
          // clamped to what the viewport can actually photograph.
          body: {
            x: Math.round(Math.max(chartBox.x, 0)),
            y: Math.round(Math.max(chartBox.y, 0)),
            width: Math.round(
              Math.min(chartBox.right, window.innerWidth) - Math.max(chartBox.x, 0),
            ),
            height: Math.round(
              Math.min(chartBox.bottom, window.innerHeight) - Math.max(chartBox.y, 0),
            ),
          },
        };
      },
      { offset: MARKED_OFFSET, reach: STRIP_REACH_PX },
    );
  }

  /** Both clips of one state, as base64 PNGs. */
  async function photograph(page: Page): Promise<{ strip: string; body: string }> {
    const where = await geometryOf(page);
    const strip = await page.screenshot({ clip: where.strip });
    const body = await page.screenshot({ clip: where.body });
    // `toString('base64')` rather than `Buffer.equals`, which this project's
    // `Buffer` types will not accept another `Buffer` for — `hover-cards.spec.ts`
    // compares two clips the same way.
    return { strip: strip.toString('base64'), body: body.toString('base64') };
  }

  /**
   * Decodes two clips **in the page** and returns the columns they differ in.
   *
   * `page.screenshot` hands back a Node `Buffer` and there is no PNG decoder in
   * this workspace, so the bytes are carried in as a data URL and drawn into a
   * canvas — the extraction `measure-ink.ts:78` already uses, with the loading
   * spelled out because two of its steps throw or truncate when left implicit:
   * `img.decode()` before drawing, and the canvas sized from the image before
   * that, since a fresh `<canvas>` is 300×150 and would crop a wider clip.
   */
  async function differingColumnsOf(page: Page, before: string, after: string): Promise<number[]> {
    const pixels = await page.evaluate(
      async ([first, second]) => {
        const read = async (
          encoded: string,
        ): Promise<{ width: number; height: number; data: number[] }> => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx === null) throw new Error('this browser gave no 2d context');
          ctx.drawImage(image, 0, 0);
          // All four arguments: `getImageData()` with none is a `TypeError`, not
          // a whole-canvas read.
          const got = ctx.getImageData(0, 0, canvas.width, canvas.height);
          return { width: got.width, height: got.height, data: [...got.data] };
        };
        return [await read(first), await read(second)];
      },
      [before, after] as const,
    );
    return differingColumns(pixels[0], pixels[1]);
  }

  /** Moves the ladder, and waits for the day columns to have really moved. */
  async function pickRung(page: Page, rung: number): Promise<void> {
    await page.locator('[data-gantt-day-scale]').selectOption(String(rung));
    await expect
      .poll(async () =>
        page
          .locator(`[data-axis-day="${String(MARKED_OFFSET)}"]`)
          .evaluate((cell) => Math.round(cell.getBoundingClientRect().width)),
      )
      .toBe(rung);
  }

  /**
   * The first end-to-end reading this feature has: a marker made through the
   * real composer, persisted through the real route, drawn by the real chart.
   *
   * It was held at `fixme` twice and both holds are closed. The first was the
   * host — `wbs-table.tsx` passed `<GanttPanel>` no marker props at all, so
   * Save reported upward into nothing and the `POST …/calendar-markers` never
   * left the browser; slice 9.0 wired that seam and the request now lands. The
   * second was this file's own gesture: with the pointer left where Save
   * unmounted the composer, a bar's hover-card stood open over the strip and
   * **every one of its thirteen columns** differed from the marker-free clip —
   * `STRIP_REACH_PX` 6 makes the strip `6 * 2 + 1` wide, and the failure named
   * exactly `0…12`, which is the whole of it. The park above closes that.
   */
  test('is one opaque hairline at every rung, and the only body ink the marker adds', async ({
    page,
  }) => {
    await seedPlan(page, 'marker-rule-ink');
    await openTheChart(page);

    // Marker absent, at every rung, before anything is created: the geometry is
    // read off the axis cell rather than the rule, so these clips need no
    // marker to exist yet.
    const absent = new Map<number, { strip: string; body: string }>();
    for (const rung of RUNGS) {
      await pickRung(page, rung);
      absent.set(rung, await photograph(page));
    }

    await pickRung(page, DAY_PX);
    await page.locator(`[data-axis-day="${String(MARKED_OFFSET)}"]`).click();
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill('Ink');
    // A REST `POST …/calendar-markers` and **not** a `/commands` batch: markers
    // are their own route, so `savedCommand`'s kind matcher would wait forever.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await saved;

    // Park the pointer before any `present` clip is cut. The composer is
    // `fixed bottom-4 left-1/2`; Save unmounts it and drops the pointer onto
    // whatever is underneath, which in this plan is a bar — and a bar under the
    // pointer opens a hover-card. The `absent` clips were cut before any click
    // and carry no card, so the two states would then differ over the whole
    // strip for a reason that is not marker ink. `(0, 0)` and a wait for the
    // count to reach zero is `hover-cards.spec.ts:54`'s own inert park.
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

    const rule = page.locator('[data-gantt-marker-rule]');
    await expect(rule).toHaveCount(1);
    // The rule really stands where the strip was cut, which is what stops every
    // measurement below from being a photograph of empty chart.
    expect(
      await rule.evaluate((line) => line.getBoundingClientRect().x),
      'the rule does not stand at its axis cell, so the strip crosses nothing',
    ).toBeCloseTo(
      await page
        .locator(`[data-axis-day="${String(MARKED_OFFSET)}"]`)
        .evaluate((cell) => cell.getBoundingClientRect().x),
      0,
    );

    // The cascade's resolved width, in the one engine that resolves a cascade
    // at all. This is **not** a proof of `vector-effect` — computed style
    // cannot see that property — it is the one thing it reports faithfully, and
    // it closes the renderer whose inline style overrides a declared `1`.
    const painted = await rule.evaluate((line) => {
      const style = getComputedStyle(line);
      // Every element from the rule up to the chart `<svg>` inclusive: CSS
      // `opacity` does not inherit, so a `<g opacity="0.5">` around the rule
      // leaves the rule itself computing `1`.
      const opacities: string[] = [];
      let walk: Element | null = line;
      while (walk !== null) {
        opacities.push(getComputedStyle(walk).opacity);
        if (walk.hasAttribute('data-gantt-chart')) break;
        walk = walk.parentElement;
      }
      return {
        strokeWidth: style.strokeWidth,
        strokeOpacity: style.strokeOpacity,
        stroke: style.stroke,
        opacities,
      };
    });
    expect(painted.strokeWidth, 'the rule resolves to something other than one pixel').toBe('1px');
    expect(painted.strokeOpacity).toBe('1');
    // A separate channel from the colour, so the alpha is checked in both
    // places it can live: `oklch(… / 0.4)` is the form this stylesheet's own
    // tokens take and it leaves `stroke-opacity` computing `1`.
    expect(painted.stroke, 'the rule’s colour carries an alpha component').toMatch(
      /^rgb\([^)]*\)$/,
    );
    expect(
      painted.opacities.every((each) => each === '1'),
      `something between the rule and the chart is translucent: ${painted.opacities.join(', ')}`,
    ).toBe(true);
    // And the walk really reached the chart, rather than stopping at a detached
    // parent — an `every` over one element would pass whatever is above it.
    expect(painted.opacities.length).toBeGreaterThan(1);

    for (const rung of RUNGS) {
      await pickRung(page, rung);
      const present = await photograph(page);

      // `visibility` rather than `display`, so nothing reflows between the two
      // clips — and on **the element the assertions above queried**, which is
      // what binds the width to the paint.
      await rule.evaluate((line) => {
        line.style.visibility = 'hidden';
      });
      const hidden = await photograph(page);
      await rule.evaluate((line) => {
        line.style.visibility = '';
      });

      const before = absent.get(rung);
      if (before === undefined) throw new Error(`no absent clip at ${String(rung)}px`);

      const totalInk = await differingColumnsOf(page, before.strip, present.strip);
      const ruleInk = await differingColumnsOf(page, hidden.strip, present.strip);

      // A hairline against a day. The bound is deliberately not tight enough to
      // tell 1 CSS pixel from 2 — the rule sits on a pixel boundary and Skia
      // paints it at partial coverage into the two columns it straddles — but
      // 28 or 4 against 2 is the discrimination that matters.
      expect(
        isContiguousRun(ruleInk),
        `the rule paints ${String(ruleInk.length)} columns at ${String(rung)}px, ` +
          `and they are not one run: ${ruleInk.join(', ')}`,
      ).toBe(true);
      expect(
        ruleInk.length,
        `the rule is ${String(rung)}px wide, not a hairline`,
      ).toBeLessThanOrEqual(2);

      // An equality, not a bound: the 1-or-2 slack cannot hide inside it. An
      // adjacent untagged line makes the marker's ink a strict superset of the
      // rule's, and a containment would pass it.
      expect(
        sameColumns(totalInk, ruleInk),
        `at ${String(rung)}px the marker paints ${totalInk.join(', ') || '(nothing)'} ` +
          `and the rule paints ${ruleInk.join(', ') || '(nothing)'}`,
      ).toBe(true);

      // The binding, over the whole body rather than the strip: a strip cannot
      // prove the absence of paint it does not cover. If hiding one element
      // returns the chart to its marker-free state, that element is the only
      // body ink the marker adds, anywhere.
      expect(
        hidden.body === before.body,
        `at ${String(rung)}px the marker leaves body ink the queried rule does not account for`,
      ).toBe(true);
      // And the marker really drew something, so the identity above is not two
      // photographs of the same empty chart.
      expect(
        present.body === before.body,
        `at ${String(rung)}px the marker changes nothing in the body at all`,
      ).toBe(false);
    }
  });
});

/**
 * Slice 9.2 — the round trip, in a browser.
 *
 * Section 8 asserts positions in jsdom and section 6 asserts the panel's own
 * behaviour with props a test supplied. This is the only case that watches a
 * marker survive the one thing neither can reach: a reload, which throws away
 * every piece of component state and rebuilds the chart from what be-01 kept.
 */
test.describe('a calendar marker, made and unmade in a browser', () => {
  /** The day the marker goes on, as an offset into the drawn axis. */
  const MARKED_OFFSET = 3;
  const MARKER_NAME = 'Kickoff';

  /** The one dated axis cell this case operates, at whatever rung is showing. */
  const axisCell = (page: Page): Locator =>
    page.locator(`[data-axis-day="${String(MARKED_OFFSET)}"]`);

  test('survives a reload, and a delete takes both its marks away', async ({ page }) => {
    await seedPlan(page, 'marker-round-trip');
    await openTheChart(page);

    // Nothing yet, and asserted rather than assumed: a chip already on the
    // chart would make every count below pass without the composer doing
    // anything at all.
    await expect(page.locator('[data-marker-chip]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-marker-rule]')).toHaveCount(0);

    await axisCell(page).click();
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill(MARKER_NAME);
    // The REST route markers have of their own, not a `/commands` batch — the
    // same wait `the marker rule` uses, and for the same reason.
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await created;

    // Both marks, which are two different layers: the chip is a `<span>` in the
    // sticky header band and the rule is a `<line>` in the body SVG, and a
    // marker that drew only one of them would be half a feature.
    const chip = page.locator(`[data-marker-chip]`);
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText(MARKER_NAME);
    await expect(chip).toHaveAttribute('data-marker-offset', String(MARKED_OFFSET));
    const rule = page.locator(`[data-gantt-marker-rule="${String(MARKED_OFFSET)}"]`);
    await expect(rule).toHaveCount(1);

    // **The rule is a colour a person can see, and this is the assertion 9.2's
    // negative moves.** A count or a position would pass a rule stroked in the
    // chart's own background — an element at the right `x` painted invisibly is
    // precisely what only a browser catches (round-4 Sol review), and every
    // other assertion in this case would stay green through it. Resolved
    // through `getComputedStyle` on both sides so a token, a variable and a
    // literal all compare as the same rendered rgb.
    const paint = await rule.evaluate((line) => {
      const chart = line.closest('[data-gantt-chart]');
      if (chart === null) throw new Error('the rule is not inside a chart');
      // **Both sides rasterized before they are compared, and the string forms
      // are kept only for the failure message.** This project's tokens are
      // `oklch()` and the SVG `stroke` resolves to `rgb()`, so the two computed
      // values are in different syntaxes: comparing them as text would call
      // white and white different and the negative below could never fail.
      // A 1×1 canvas is the one thing in the page that resolves any CSS colour
      // to the same four bytes.
      // `color-mix(in srgb, …)` and **not** a canvas: this engine's
      // `fillStyle` silently rejects `oklch()` and leaves the swatch
      // transparent, which was watched — the guard below is what caught it.
      // Mixing into `srgb` makes the engine convert, and a computed `color` is
      // reported in the mix's own space, so both sides come back comparable.
      const swatch = document.createElement('span');
      swatch.style.display = 'none';
      document.body.append(swatch);
      const rasterize = (colour: string): string => {
        swatch.style.color = '';
        swatch.style.color = `color-mix(in srgb, ${colour} 100%, transparent)`;
        return getComputedStyle(swatch).color;
      };
      // The nearest ancestor that actually paints: `background-color` computes
      // to `rgba(0, 0, 0, 0)` on anything transparent, and comparing the rule
      // against *that* would compare it against nothing.
      let behind: Element | null = chart;
      let backdrop = 'rgba(0, 0, 0, 0)';
      while (behind !== null) {
        const seen = getComputedStyle(behind).backgroundColor;
        if (seen !== 'rgba(0, 0, 0, 0)' && seen !== 'transparent') {
          backdrop = seen;
          break;
        }
        behind = behind.parentElement;
      }
      const stroke = getComputedStyle(line).stroke;
      const measured = {
        stroke,
        backdrop,
        strokePixels: rasterize(stroke),
        backdropPixels: rasterize(backdrop),
      };
      swatch.remove();
      return measured;
    });
    expect(paint.backdrop, 'nothing behind the rule paints a background to contrast with').not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    // And the mix really resolved it, rather than leaving the swatch at the
    // transparent default a colour the engine cannot parse would give it —
    // which would make the comparison below true for the wrong reason. This
    // guard is not hypothetical: it is what caught the canvas.
    expect(
      paint.backdropPixels,
      `the backdrop ${paint.backdrop} did not resolve to a comparable colour`,
    ).not.toBe('rgba(0, 0, 0, 0)');
    expect(
      paint.strokePixels,
      `the rule is painted in the chart's own background — stroke ${paint.stroke} against ` +
        `backdrop ${paint.backdrop}, both resolving to ${paint.strokePixels} — and cannot be seen`,
    ).not.toBe(paint.backdropPixels);

    // **The step nothing else in this plan can take.** Every jsdom case above
    // renders a panel that was handed its markers; this drops all of it and
    // rebuilds from be-01's answer, which is the only thing that says the save
    // persisted rather than merely updated the screen.
    await page.reload();
    await openTheChart(page, { drawn: '[data-marker-chip]' });
    await expect(page.locator('[data-marker-chip]')).toHaveText(MARKER_NAME);
    await expect(page.locator(`[data-gantt-marker-rule="${String(MARKED_OFFSET)}"]`)).toHaveCount(
      1,
    );

    // A day that already carries a marker opens the sheet, not the composer
    // (`gantt-panel.tsx:3204-3212`) — so this click is also what says the two
    // affordances are told apart by the data rather than by which one was
    // wired last.
    await axisCell(page).click();
    const sheet = page.getByRole('dialog', { name: /^Calendar markers on / });
    await expect(sheet).toBeVisible();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && response.url().includes('/calendar-markers'),
    );
    await sheet.getByRole('button', { name: `Delete ${MARKER_NAME}` }).click();
    await deleted;

    // Gone from both layers, and gone from the server too: the second reload is
    // what separates a delete from a hidden element.
    await expect(page.locator('[data-marker-chip]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-marker-rule]')).toHaveCount(0);
    await page.reload();
    await openTheChart(page);
    await expect(page.locator('[data-marker-chip]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-marker-rule]')).toHaveCount(0);
  });
});

/**
 * Slice 9.2a — the visible focus ring on a dated axis cell.
 *
 * Its own case rather than an assertion inside 9.2, because 9.2's negative
 * mutates the marker rule's stroke and a focus ring cannot observe that: two
 * guarantees in one slice share whichever fault is injected, and the one that
 * shares gets no proof.
 *
 * Section 6 gave these cells `role="button"` and `tabIndex={0}` so the calendar
 * could be operated by keyboard. That is the whole reason this case exists: a
 * row of tab stops that all look the same is worse than no tab stops, and jsdom
 * computes no styles, so nothing in section 6 can tell whether the stop a
 * reader is standing on says so.
 */
test.describe('a dated axis cell says where the keyboard is', () => {
  /** The cell the keyboard walks to — the first one on the axis. */
  const FOCUSED_OFFSET = 0;

  /** What a focus indicator is made of, read off one cell in one state. */
  interface Indicator {
    outlineStyle: string;
    outlineWidth: string;
    boxShadow: string;
  }

  const indicatorOf = (cell: Locator): Promise<Indicator> =>
    cell.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });

  test('grows a focus indicator when the keyboard reaches it', async ({ page }) => {
    await seedPlan(page, 'axis-focus-ring');
    await openTheChart(page);

    const cell = page.locator(`[data-axis-day="${String(FOCUSED_OFFSET)}"]`);
    // Dated, and asserted rather than assumed: an undated cell is
    // `aria-disabled` and is a different slice's contract (6.4a), so a fixture
    // that lost its project start date would test the wrong cell silently.
    await expect(cell).toHaveAttribute('data-axis-date', /^\d{4}-\d{2}-\d{2}$/);

    // Read at rest **first**. The assertion below is a transition, and a
    // resting reading cannot be taken after the cell already holds focus.
    const resting = await indicatorOf(cell);

    // **Arrived at by a keypress, and not by `.focus()`.** The ring is authored
    // under `focus-visible`, which Chromium matches when focus moved by
    // keyboard — a bare programmatic `focus()` reads the resting style straight
    // back and would call the ring missing on a healthy build.
    //
    // The keypress is one `Shift+Tab` off the **next** cell rather than a walk
    // from the top of the document: the tab order ahead of the axis is the
    // whole WBS table, which is more than 200 stops deep on this fixture, so a
    // walk fails on the fixture's row count instead of on the ring. The
    // starting `focus()` is only a seek — Chromium's heuristic reads the input
    // that *moved* focus, and that is the keypress below.
    await page
      .locator(`[data-axis-day="${String(FOCUSED_OFFSET + 1)}"]`)
      .evaluate((node: HTMLElement) => {
        node.focus();
      });
    await page.keyboard.press('Shift+Tab');
    await expect(cell).toBeFocused();
    // The precondition, asserted rather than assumed: if the keypress did not
    // engage `:focus-visible` this case would read two resting styles and fail
    // on a healthy build. It stays green under the fault below — the selector
    // matches whether or not the classes it selects draw anything.
    expect(
      await cell.evaluate((node) => node.matches(':focus-visible')),
      'the keypress did not make the cell focus-visible, so no ring could apply',
    ).toBe(true);

    const focused = await indicatorOf(cell);

    // **The transition is the assertion, and a static reading is not.** "the
    // focused outline is not none" passes against a global reset that outlines
    // every element permanently, which indicates nothing about focus at all.
    expect(
      focused,
      `the cell reads the same focused as at rest — ${JSON.stringify(resting)}`,
    ).not.toEqual(resting);

    // And what it changed into is something a person can see. Tailwind emits
    // `outline-style: none` for `outline-none` and drives `ring-*` through
    // `box-shadow`, so a cell carrying only the `outline-none` half reads
    // `none`/`0px`/`none` in **both** states — which is exactly the fault this
    // case is watched failing on.
    const indicated =
      (focused.outlineStyle !== 'none' && focused.outlineWidth !== '0px') ||
      focused.boxShadow !== 'none';
    expect(indicated, `the focused cell draws no indicator — ${JSON.stringify(focused)}`).toBe(
      true,
    );
  });
});

/**
 * Slice 9.2b, opaque half — the bar layer's pixels.
 *
 * 8.2 asserts the rule's `x`, its `width` and the critical-path class, and all
 * three survive a rule painted straight through a bar that is supposed to hide
 * it: `jsdom` has no rasterizer, so the guarantee needs a browser and cannot
 * live in that file. Its own slice for 9.2a's reason — 9.2's fault mutates the
 * rule's stroke, which this case would see too, and a slice that shares a fault
 * gets no proof of its own.
 *
 * The crop **is** the bar's footprint, so "differs" and "inside the bar" are
 * one predicate rather than two. Read over the whole chart instead, "every
 * differing pixel lies inside the footprint" is satisfied by *zero* differing
 * pixels and rejects the correct renderer, whose rule differs everywhere it is
 * drawn.
 */
test.describe("a marker's rule against the bars, in pixels", () => {
  /** The day the marker stands on — the same column 8.2a marks. */
  const MARKED_OFFSET = 3;

  /** A clip of the page, as `page.screenshot` takes one. */
  interface Clip {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  /**
   * The footprint of the bar the rule crosses, recomputed from live geometry.
   *
   * Recomputed and not cached: creating the marker puts a chip in the sticky
   * header, and a header that grows moves the whole body down. Two clips taken
   * at one set of absolute coordinates either side of that would photograph
   * different content and the identity below would fail for the wrong reason.
   *
   * Inset by a pixel on every side. The bar's box has fractional edges, the
   * clip is whole pixels, and a rounded edge either side of a body shift can
   * catch a sliver of the chart behind the bar — which is a difference the
   * renderer did not draw. The interior is still the footprint, and the rule
   * crosses the bar's full height, so nothing this case is looking for lives in
   * the pixel that is dropped.
   */
  async function footprintOf(page: Page): Promise<Clip> {
    return page.evaluate((offset) => {
      const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
      if (cell === null) throw new Error(`no axis cell at day ${String(offset)}`);
      const at = cell.getBoundingClientRect();
      // The bar the rule really crosses, found by geometry rather than named:
      // a bar picked by id would silently stop spanning the marked day the
      // first time the fixture's dates move.
      // The rule stands at the axis cell's **left edge**, so a bar it passes
      // under is one whose footprint contains that single x — not one that
      // contains the whole cell, which the first draft asked for and which no
      // bar in this fixture does.
      const bars = [...document.querySelectorAll('[data-gantt-bar]')];
      const crossed = bars.find((bar) => {
        const box = bar.getBoundingClientRect();
        return box.x < at.x && at.x < box.right && box.height > 2;
      });
      if (crossed === undefined) {
        const seen = bars
          .map((bar) => {
            const box = bar.getBoundingClientRect();
            return `${String(Math.round(box.x))}…${String(Math.round(box.right))}`;
          })
          .join(', ');
        throw new Error(
          `no bar passes under day ${String(offset)} at x ${String(Math.round(at.x))} — bars at ${seen}`,
        );
      }
      const box = crossed.getBoundingClientRect();
      return {
        x: Math.round(box.x) + 1,
        y: Math.round(box.y) + 1,
        width: Math.round(box.width) - 2,
        height: Math.round(box.height) - 2,
      };
    }, MARKED_OFFSET);
  }

  test('leaves an opaque bar it passes under pixel-identical', async ({ page }) => {
    await seedPlan(page, 'marker-rule-pixels');
    await openTheChart(page);

    const before = await footprintOf(page);
    // A footprint with no room in it would make the comparison below vacuous —
    // two empty clips are identical whatever the renderer does.
    expect(before.width, 'the bar the rule crosses is too narrow to photograph').toBeGreaterThan(4);
    expect(before.height, 'the bar the rule crosses is too short to photograph').toBeGreaterThan(2);
    const bare = (await page.screenshot({ clip: before })).toString('base64');

    await page.locator(`[data-axis-day="${String(MARKED_OFFSET)}"]`).click();
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill('Under');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await saved;

    // Park the pointer before the second clip. Save unmounts a `fixed` composer
    // and drops the pointer onto whatever is beneath — a bar, here — and a bar
    // under the pointer opens a hover-card over the very pixels this case
    // compares. 8.2a's own park, and it cost that slice a chunk.
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

    // The rule exists and stands in this bar's column, which is what stops the
    // identity below from being a photograph of a chart with no marker on it.
    const rule = page.locator('[data-gantt-marker-rule]');
    await expect(rule).toHaveCount(1);
    const after = await footprintOf(page);
    expect(
      await rule.evaluate((line) => line.getBoundingClientRect().x),
      'the rule does not stand inside the bar it is supposed to pass under',
    ).toBeGreaterThan(after.x);

    const marked = (await page.screenshot({ clip: after })).toString('base64');

    // **The assertion.** The rule is drawn in `marksUnderLight` and the bars in
    // `marksOverLight`, so an opaque bar covers it: the bar's own footprint is
    // the one place on the chart a correct renderer changes nothing at all.
    // Compared as text rather than through `Buffer.equals`, which this
    // project's `Buffer` types will not accept another `Buffer` for.
    expect(marked === bare, "the marker's rule shows through an opaque bar it passes under").toBe(
      true,
    );
  });

  /**
   * The assumed bar the rule is asked to show through, and the axis day it
   * stands on — both found by geometry, neither named.
   *
   * `[data-assumed]` is the seam: a slice nobody estimated is drawn across the
   * assumed span at `[fill-opacity:0.35]`, and only with the detail asked for.
   * Which day such a bar covers is the schedule's business —
   * it moves with the estimate, the weekend and the assumed span — so the day
   * is read off the bar rather than written here, the way the opaque case
   * reads its bar off the day.
   *
   * The day is required **strictly** inside the bar, by more than the inset
   * below on each side: a rule standing on the footprint's own edge is a rule
   * the clip can drop, and the case would then fail against a correct
   * renderer.
   */
  async function assumedDay(page: Page): Promise<number> {
    return page.evaluate(() => {
      const bars = [...document.querySelectorAll('[data-gantt-bar][data-assumed]')];
      for (const bar of bars) {
        const box = bar.getBoundingClientRect();
        if (box.height <= 4 || box.width <= 8) continue;
        for (const cell of document.querySelectorAll('[data-axis-day]')) {
          const at = cell.getBoundingClientRect();
          if (box.x + 2 < at.x && at.x < box.right - 2) {
            return Number(cell.getAttribute('data-axis-day'));
          }
        }
      }
      throw new Error(
        `no assumed bar wide enough to hold an axis day — ${String(bars.length)} drawn`,
      );
    });
  }

  /**
   * The footprint of the assumed bar standing over `day`, inset like
   * {@link footprintOf} and for its reasons.
   *
   * Recomputed after the save for {@link footprintOf}'s reason too — the new
   * chip grows the sticky header and moves the body down — and that recompute
   * is what makes the comparison below a comparison of the same bar rather
   * than of two different slices of the chart. The opaque case is the proof
   * that it is shift-stable: it takes its two clips across the same shift and
   * asserts them byte-**identical**.
   */
  async function assumedFootprintOn(page: Page, day: number): Promise<Clip> {
    return page.evaluate((offset) => {
      const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
      if (cell === null) throw new Error(`no axis cell at day ${String(offset)}`);
      const at = cell.getBoundingClientRect();
      const crossed = [...document.querySelectorAll('[data-gantt-bar][data-assumed]')].find(
        (bar) => {
          const box = bar.getBoundingClientRect();
          return box.x < at.x && at.x < box.right && box.height > 2;
        },
      );
      if (crossed === undefined) {
        throw new Error(`no assumed bar passes under day ${String(offset)}`);
      }
      const box = crossed.getBoundingClientRect();
      return {
        x: Math.round(box.x) + 1,
        y: Math.round(box.y) + 1,
        width: Math.round(box.width) - 2,
        height: Math.round(box.height) - 2,
      };
    }, day);
  }

  test('shows the rule through an assumed bar it passes under', async ({ page }) => {
    await seedPlan(page, 'marker-rule-assumed-pixels');
    await openTheChart(page);
    // The assumed bars are the half of the chart that is drawn only when the
    // detail is asked for, so the state is pressed and asserted rather than
    // inherited: a fixture that opened without them would leave every
    // measurement below reading a chart with no assumed bar on it at all.
    await askForTheDetail(page, 1);
    await expect(page.locator('[data-gantt-bar][data-assumed]')).toHaveCount(2);

    const day = await assumedDay(page);
    const before = await assumedFootprintOn(page, day);
    expect(before.width, 'the assumed bar is too narrow to photograph').toBeGreaterThan(4);
    expect(before.height, 'the assumed bar is too short to photograph').toBeGreaterThan(2);
    const bare = (await page.screenshot({ clip: before })).toString('base64');

    await page.locator(`[data-axis-day="${String(day)}"]`).click();
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill('Through');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await saved;

    // The opaque case's park, for its reason: save drops the pointer onto
    // whatever the `fixed` composer was covering, and a hover-card opened over
    // these pixels is a difference this case would read as the rule.
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

    const rule = page.locator('[data-gantt-marker-rule]');
    await expect(rule).toHaveCount(1);
    const after = await assumedFootprintOn(page, day);
    // Same bar, same size. Without this the comparison is vacuous in the
    // permissive direction: two clips of different dimensions differ whatever
    // the renderer drew, and the assertion below would pass over a rule that
    // never reached the screen.
    expect(after.width, 'the photographed bar changed width across the save').toBe(before.width);
    expect(after.height, 'the photographed bar changed height across the save').toBe(before.height);

    const marked = (await page.screenshot({ clip: after })).toString('base64');

    // **The assertion.** The crop **is** the bar's footprint, so "differs" and
    // "inside the bar" are one predicate: read over the whole chart instead,
    // "every differing pixel lies inside the footprint" is satisfied by *zero*
    // differing pixels — which is exactly what a rule masked under assumed
    // bars produces — and rejects the correct renderer, whose rule differs
    // everywhere it is drawn.
    //
    // Two PNGs of equal dimensions from one deterministic encoder: identical
    // pixels give identical bytes, which is the fact the opaque case above
    // asserts directly. So differing bytes here are differing pixels, and at
    // this size a difference is the rule and nothing else — the footprint holds
    // one translucent bar whose own geometry the guards above pinned.
    expect(marked === bare, 'the assumed bar hides the rule that passes under it').toBe(false);
  });
});

/**
 * Slice 9.2c, the light pair's weekday half — the chip's **rendered** contrast.
 *
 * 3.2 proves the palette's eight literals against computed backdrops, and 8.1
 * and 6.x read the chip's colour at the DOM seam. None of them sees what the
 * compositor put on screen: a chip carrying `opacity: 0.5`, an alpha-bearing
 * fill or an opacity-reducing ancestor passes every one of them while its
 * composited colour falls under 3:1.
 *
 * **`measureInk` is the right precedent for the pipeline and the wrong oracle
 * for this bar**, and both reasons are in its source. It returns `contrast`
 * between a node's `color` and its composited ground — the 4.5:1 *label* bar —
 * while the claim here is the chip **fill** against the header backdrop, two
 * surfaces and a ratio it never forms. And its walk reads
 * `getComputedStyle(ancestor).backgroundColor` alone
 * (`apps/fe-01/e2e/measure-ink.ts:110-115`), breaking at the first layer with
 * alpha 1: `opacity` is a separate property and group opacity is not a
 * per-layer alpha, so the negative this slice exists for passes `measureInk`
 * **unchanged**. A negative that cannot fail is how the Criticals before it
 * were written, so the oracle here is the pixel the screenshot already carries.
 */
test.describe("a marker chip's contrast, as the compositor drew it", () => {
  /** A clip of the page, as `page.screenshot` takes one. */
  interface Shot {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  /**
   * The contrast between two clips of the page, each read at its **modal** RGB.
   *
   * Modal rather than mean because the chip carries its own label glyphs, and a
   * mean of fill and ink is a colour neither of them is: the fill is the
   * majority of the box and the mode is what a reader would call "the colour of
   * that chip".
   *
   * Decoded in the page, per `apps/fe-01/e2e/hover-cards.spec.ts:148-158`'s
   * pipeline — the two clips arrive as base64, `img.decode()` resolves before
   * anything is drawn, and the canvas takes its size from `naturalWidth` and
   * `naturalHeight` **before** `drawImage`, because a canvas left at its
   * default 300×150 silently scales the pixels being counted.
   *
   * The transfer function is `measure-ink.ts:89-94`'s, spelled out again rather
   * than imported: that module's export is the `color`-against-ground walk this
   * slice's own docblock explains cannot answer this question, and copying the
   * four lines it does share is cheaper than exporting a second entry point out
   * of a helper whose subject is a different bar.
   */
  async function contrastBetween(page: Page, top: string, under: string): Promise<number> {
    return page.evaluate(
      async ([first, second]) => {
        const modal = async (data: string): Promise<[number, number, number]> => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('no 2d context to count pixels in');
          context.drawImage(img, 0, 0);
          const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
          const tally = new Map<string, number>();
          for (let at = 0; at < pixels.length; at += 4) {
            const key = `${String(pixels[at])},${String(pixels[at + 1])},${String(pixels[at + 2])}`;
            tally.set(key, (tally.get(key) ?? 0) + 1);
          }
          let best = '';
          let seen = -1;
          for (const [key, count] of tally) {
            if (count > seen) {
              best = key;
              seen = count;
            }
          }
          const [red, green, blue] = best.split(',').map(Number);
          return [red, green, blue];
        };
        const linear = (raw: number): number => {
          const unit = raw / 255;
          return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
        };
        const luminance = (colour: [number, number, number]): number =>
          0.2126 * linear(colour[0]) + 0.7152 * linear(colour[1]) + 0.0722 * linear(colour[2]);
        const one = luminance(await modal(first));
        const other = luminance(await modal(second));
        const brighter = Math.max(one, other);
        const dimmer = Math.min(one, other);
        return (brighter + 0.05) / (dimmer + 0.05);
      },
      [top, under],
    );
  }

  /**
   * A weekday axis day with no marker on it, and one clear of the chip's own
   * column.
   *
   * The weekend cells carry `bg-muted-foreground/10`
   * (`gantt-panel.tsx:4704`) and the weekday ones nothing, so "of the same
   * kind" is that class being absent from both the marked cell and the cell the
   * backdrop is read from. Read off the page rather than computed from the plan
   * start: which offsets fall on a Saturday is the calendar's business and it
   * moves with `PLAN_START`.
   */
  async function weekdayDays(page: Page): Promise<number[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll('[data-axis-day]')]
        .filter((cell) => !cell.className.includes('bg-muted-foreground/10'))
        .map((cell) => Number(cell.getAttribute('data-axis-day'))),
    );
  }

  /** The weekend axis days, by the shading class only they carry. */
  async function weekendDays(page: Page): Promise<number[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll('[data-axis-day]')]
        .filter((cell) => cell.className.includes('bg-muted-foreground/10'))
        .map((cell) => Number(cell.getAttribute('data-axis-day'))),
    );
  }

  /**
   * Puts a marker on `day` and returns the clip of the chip it draws.
   *
   * Inset, for 9.2b's reason: the chip has `rounded-sm` corners and fractional
   * edges, and a whole-pixel clip on them catches the header behind it — which
   * would land in the tally as a colour the chip is not.
   */
  async function chipShotOn(page: Page, day: number, name: string): Promise<Shot> {
    await page.locator(`[data-axis-day="${String(day)}"]`).click();
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill(name);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await saved;

    // The opaque case's park, for its reason — a hover-card over the header is
    // a surface neither clip is supposed to contain.
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

    const chip = page.locator('[data-marker-chip]');
    await expect(chip).toHaveCount(1);
    const box = await chip.boundingBox();
    if (box === null) throw new Error('the chip is not in the layout');
    const shot: Shot = {
      x: Math.round(box.x) + 2,
      y: Math.round(box.y) + 1,
      width: Math.round(box.width) - 4,
      height: Math.round(box.height) - 2,
    };
    expect(shot.width, 'the chip is too narrow to photograph').toBeGreaterThan(2);
    expect(shot.height, 'the chip is too short to photograph').toBeGreaterThan(2);
    return shot;
  }

  /**
   * An equal-sized box at the chip's own height on a markerless `day`.
   *
   * The backdrop is **measured from the page** and never recomputed, so a theme
   * change moves the chip and its ground together instead of leaving these
   * cases asserting against a literal nobody repaints. The chip is
   * `maxWidth: dayPx` at its own column's left edge and this clip is inset
   * inside `day`'s column, so the control cannot photograph the chip it is the
   * control for even when the two columns are adjacent.
   */
  async function controlShotOn(page: Page, day: number, like: Shot): Promise<Shot> {
    const at = await page.evaluate((offset) => {
      const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
      if (cell === null) throw new Error(`no axis cell at day ${String(offset)}`);
      return Math.round(cell.getBoundingClientRect().x) + 2;
    }, day);
    return { x: at, y: like.y, width: like.width, height: like.height };
  }

  /** The base64 PNG of one clip of the page. */
  const shotOf = async (page: Page, clip: Shot): Promise<string> =>
    (await page.screenshot({ clip })).toString('base64');

  /**
   * The composited ratio between a chip on a `kind` cell and the same kind of
   * cell with no marker on it.
   *
   * One body for all four cases, because the four differ only in which cells
   * they read and which palette the page is in: a case written out four times
   * is four places for the pipeline above to drift, and this slice's whole
   * subject is that the pipeline is the oracle.
   *
   * On the weekend it also proves its own binding. `bg-muted-foreground/10`
   * over the base is a different colour from the base, so the weekend control
   * is asserted **different** from a weekday control photographed in the same
   * pass: a control that had landed on an unshaded cell — the way an unbound
   * duplicate of the weekday case would — reads the weekday ground, and two
   * cases then measure one surface. Against a cell photographed in the same
   * pass and not against a literal, for `controlShotOn`'s reason.
   */
  async function ratioOn(
    page: Page,
    kind: 'weekday' | 'weekend',
    palette: 'light' | 'dark' = 'light',
  ): Promise<number> {
    await seedPlan(page, 'marker-chip-contrast');
    await openTheChart(page);
    // Asserted here rather than before the navigation: the root's `dark` class
    // is the app's answer to the media preference and there is no root to read
    // it off until something has loaded. A case that skipped this would
    // measure the light palette twice and call the second one dark.
    expect(
      await page.evaluate(() =>
        document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      ),
      'the page is not in the palette this case is about',
    ).toBe(palette);

    const weekdays = await weekdayDays(page);
    expect(weekdays.length, 'the fixture draws no pair of weekday cells').toBeGreaterThan(3);
    if (kind === 'weekday') {
      const shot = await chipShotOn(page, weekdays[0], 'Cut');
      const backdrop = await controlShotOn(page, weekdays[2], shot);
      return contrastBetween(page, await shotOf(page, shot), await shotOf(page, backdrop));
    }

    const weekend = await weekendDays(page);
    expect(weekend.length, 'the fixture draws no pair of weekend cells').toBeGreaterThan(1);
    const shot = await chipShotOn(page, weekend[0], 'Cut');
    const backdrop = await controlShotOn(page, weekend[1], shot);
    const weekdayGround = await controlShotOn(page, weekdays[0], shot);
    expect(
      await shotOf(page, backdrop),
      'the weekend control photographs the same surface as a weekday cell',
    ).not.toBe(await shotOf(page, weekdayGround));
    return contrastBetween(page, await shotOf(page, shot), await shotOf(page, backdrop));
  }

  test('clears 3:1 against the weekday cell it stands on, in light', async ({ page }) => {
    expect(
      await ratioOn(page, 'weekday'),
      'the chip the compositor drew does not clear 3:1 against the weekday cell behind it',
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * The weekend half, and the one whose negative had to be **computed**.
   *
   * `ratioOn`'s binding assertion proves the two controls are different
   * surfaces. The stronger claim — that the difference is enough to decide a
   * case — needs a fill this case fails while the weekday case above stays
   * green, and no fill on offer is one. The recolour list writes `PALETTE`
   * (`gantt-panel.tsx:5171-5185`), and all eight of its entries were built to a
   * single ratio against `--background`: 4.232–4.249 over the base, 3.740–3.755
   * over base-over-weekend. Every one clears 3:1 on both grounds, so the
   * separating fill has to be **injected**, not picked.
   *
   * The window it has to land in is fixed by the two grounds the page paints.
   * `--background` is `oklch(1 0 0)`, luminance 1; the weekend cell is
   * `bg-muted-foreground/10` over it, which composites to `rgb(239, 241, 244)`,
   * luminance 0.87793. A darker fill therefore reads `1.05 / (L + 0.05)` on the
   * weekday cell and `0.92793 / (L + 0.05)` on the weekend one — the same
   * denominator under a numerator 1.133x smaller — so it separates the two
   * cases only for `0.2589 < L <= 0.3`, a window 13% wide and the reason this
   * negative is arithmetic rather than a class edit.
   *
   * **Watched (2026-09-06):** `backgroundColor: '#909090'` in place of
   * `backgroundColor: fill` — luminance 0.28088, the widest-margin integer grey
   * in that window. The weekday case **passes** at a predicted 3.1925 and this
   * one **fails**, `Received: 2.8195195603146335` against `Expected: >= 3`.
   * The model was checked before it was trusted: a first pass at `#b0b0b0`
   * predicted 2.1687 and 1.9154 and the browser returned 2.16873306642071 and
   * 1.915350293503602, so the grounds above are the page's and not a guess.
   */
  test('clears 3:1 against the weekend cell it stands on, in light', async ({ page }) => {
    expect(
      await ratioOn(page, 'weekend'),
      'the chip the compositor drew does not clear 3:1 against the weekend cell behind it',
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * The dark pair, and the emulation comes **before the first navigation**.
   *
   * `dark-mode.spec.ts:302` drives the palette with `emulateMedia`, and this
   * app resolves the root's `dark` class off that preference. Set after
   * `seedPlan` the sign-up and the project creation would paint light and only
   * the chart would repaint, which is a page these cases are not about.
   */
  test.describe('in dark', () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
    });

    test('clears 3:1 against the weekday cell it stands on', async ({ page }) => {
      expect(
        await ratioOn(page, 'weekday', 'dark'),
        'the chip the compositor drew does not clear 3:1 against the weekday cell behind it',
      ).toBeGreaterThanOrEqual(3);
    });

    test('clears 3:1 against the weekend cell it stands on', async ({ page }) => {
      expect(
        await ratioOn(page, 'weekend', 'dark'),
        'the chip the compositor drew does not clear 3:1 against the weekend cell behind it',
      ).toBeGreaterThanOrEqual(3);
    });
  });
});

/**
 * Slice 8.4's browser tier — the half `gantt-panel.test.tsx` cannot reach.
 *
 * The jsdom cases already fix the arithmetic: three chips and `+1` at 28px, two
 * and `+2` at 12px, one and `+3` at 4px, the uncrowded neighbour left alone, and
 * the badge's own `aria-label`. What they cannot say is the word the acceptance
 * criterion actually uses — **hover**. A `pointerenter` fired at a detached
 * jsdom node proves the handler runs; it does not prove a real pointer can
 * reach the badge at all, and reaching it is the whole question here: the band
 * is `pointer-events-none` with exactly one element opting back in, and at the
 * 4px rung that element is wider than the day it belongs to and hangs left off
 * its own column. Either of those is a way for the badge to be un-hoverable
 * while every jsdom assertion in the slice stays green.
 *
 * Seeded once and re-read at each rung. Four markers on one day is four
 * composer round trips — the first through the axis cell, the rest through the
 * day's sheet, because `operateDay` routes a cell that already carries a marker
 * to the sheet and not to the composer — and paying that per rung would be
 * twelve round trips for a ladder the module tier has already measured.
 */
test.describe('the crowded day collapses to a +N a pointer can open', () => {
  /**
   * The rungs and what `MARKER_BAND_MAX_PER_CELL` lets each of them draw.
   *
   * All three, not just the ends: a badge that only the widest rung can be
   * pointed at is exactly the fault this tier exists to catch, and it lives at
   * the narrow end of the ladder.
   */
  const LADDER = [
    { rung: DAY_PX, drawn: 3 },
    { rung: 12, drawn: 2 },
    { rung: 4, drawn: 1 },
  ] as const;

  /**
   * The day everything is piled onto. Offset 3 for `marker-rule-ink`'s reason:
   * far enough in that the cell clears the chart's left padding at the
   * narrowest rung, so the badge hanging left off it still has page to hang
   * into.
   */
  const CROWDED_OFFSET = 3;

  /** One more name than the widest rung will draw. */
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'] as const;

  /** Moves the ladder, and waits for the day columns to have really moved. */
  async function pickRung(page: Page, rung: number): Promise<void> {
    await page.locator('[data-gantt-day-scale]').selectOption(String(rung));
    await expect
      .poll(async () =>
        page
          .locator(`[data-axis-day="${String(CROWDED_OFFSET)}"]`)
          .evaluate((cell) => Math.round(cell.getBoundingClientRect().width)),
      )
      .toBe(rung);
  }

  /**
   * Puts one more marker on `offset`, through whichever surface that day's
   * click opens.
   *
   * `throughTheSheet` is passed rather than probed, so the branch is itself an
   * assertion: `operateDay` opens the composer on an empty day and the sheet on
   * a day that already carries one, and a routing change would fail here on the
   * dialog that did not appear rather than quietly seeding fewer markers and
   * failing later as a wrong `+N`.
   */
  async function addMarkerOn(
    page: Page,
    offset: number,
    name: string,
    { throughTheSheet }: { throughTheSheet: boolean },
  ): Promise<void> {
    await page.locator(`[data-axis-day="${String(offset)}"]`).click();
    if (throughTheSheet) {
      const sheet = page.getByRole('dialog', { name: /^Calendar markers on / });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('button', { name: /^Add a calendar marker on / }).click();
    }
    const composer = page.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill(name);
    // A REST `POST …/calendar-markers` and **not** a `/commands` batch, per the
    // rule-ink case: markers are their own route.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/calendar-markers'),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await saved;
  }

  /**
   * Puts the pointer somewhere that opens nothing, and waits for the page to
   * agree.
   *
   * Save unmounts the composer and drops the pointer onto whatever is under it,
   * which in this fixture is a bar — and a bar under the pointer opens a
   * hover-card. Every card assertion below counts the cards on the page, so a
   * stray one is not a nuisance, it is a wrong count.
   */
  async function park(page: Page): Promise<void> {
    await page.mouse.move(0, 0);
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
  }

  test('draws its rung’s chips, counts the rest, and names the whole day on hover', async ({
    page,
  }) => {
    await seedPlan(page, 'marker-band-overflow');
    await openTheChart(page);

    // Seeded at the widest rung: at 4px the axis cell is four pixels across and
    // this is a fixture step, not the thing under test.
    await pickRung(page, DAY_PX);
    for (const [at, name] of NAMES.entries()) {
      await addMarkerOn(page, CROWDED_OFFSET, name, { throughTheSheet: at > 0 });
    }
    await park(page);

    for (const { rung, drawn } of LADDER) {
      await pickRung(page, rung);
      const hidden = NAMES.length - drawn;
      const at = `rung ${String(rung)}px`;

      await expect(
        page.locator(`[data-marker-chip][data-marker-offset="${String(CROWDED_OFFSET)}"]`),
        `${at}: the band drew the wrong number of chips on the crowded day`,
      ).toHaveCount(drawn);

      const badge = page.locator(`[data-marker-overflow="${String(CROWDED_OFFSET)}"]`);
      await expect(badge, `${at}: the badge does not read the markers it hid`).toHaveText(
        `+${String(hidden)}`,
      );
      // The count beside the pixels: text alone reads the formatter as much as
      // the arithmetic.
      await expect(badge).toHaveAttribute('data-marker-hidden', String(hidden));
      await expect(badge).toHaveAttribute('aria-expanded', 'false');

      // The assertion this whole tier is for: a real pointer, landing on a real
      // badge, through a layer that refuses pointer events everywhere else.
      await badge.hover();
      const card = page.getByRole('tooltip');
      await expect(card, `${at}: hovering the badge opened no card`).toBeVisible();
      await expect(badge).toHaveAttribute('aria-expanded', 'true');
      // Exactly one: `showMarkerOverflow` clears the day surface as it opens, so
      // two cards would mean the pointer opened the axis cell's card as well and
      // the list read below could be either of them.
      await expect(card).toHaveCount(1);

      const listed = await card.locator('[data-marker-listed]').allTextContents();
      // The whole day and not the hidden tail — a list opened from `+3` that
      // named only the undrawn markers is one the reader has to join to the chip
      // still on screen.
      expect(
        [...listed].sort(),
        `${at}: the card does not name every marker standing on the day`,
      ).toEqual([...NAMES].sort());
      // Sorted, and only here. `CalendarMarkerRepository.listFor` orders by
      // `(date, createdAt, id)`, so four writes that land inside one clock tick
      // fall back to an id this fixture does not choose. The order the band
      // draws in is fixed by the jsdom case, which owns its own ids; what this
      // tier owes is that the pointer opened a card naming the day entire.

      await park(page);
      await expect(badge, `${at}: the card outlived the pointer that opened it`).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
  });
});
