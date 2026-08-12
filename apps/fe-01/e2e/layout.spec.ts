import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { type Box, findOverlap, findOverrun } from '../src/components/wbs/box-geometry';
import { shortIsoDate } from '../src/components/wbs/short-date';
import {
  DAY_ENVELOPE,
  FLEXIBLE_COLUMNS,
  FLEXIBLE_FLOOR,
  frameLayout,
  type FrameLayoutState,
  hierarchyIndentFor,
  NUMBER_ENVELOPE,
  numberIndentFor,
  PINNED_COLUMN_IDS,
  widthFor,
} from '../src/components/wbs/table-frame';

/**
 * The plan {@link seedPlan} builds, as far as a column's width depends on it.
 *
 * No row in it sets an earliest start, so the `not-before` column is at its
 * narrow 56px here. A test that dates a row says so with its own state — see
 * `the earliest-start column is as narrow as the plan lets it be`.
 */
const SEEDED_PLAN: FrameLayoutState = { hasAnyNotBefore: false };

/**
 * The layout gate.
 *
 * The overlap this change removes shipped because nothing with a rendering
 * engine ever saw the table: jsdom lays nothing out, so every unit test in
 * `wbs-table.test.tsx` could watch the right rules arrive on the right
 * elements while a pinned Name painted straight over "Depends on". This is the
 * one spec that measures rectangles.
 *
 * Everything here is arithmetic on `getBoundingClientRect`, deliberately: no
 * pixel diffing, no screenshot baseline. A baseline would fail on a font
 * update and pass on the bug. The screenshot this run leaves behind is a
 * diagnostic and the thing widths get judged from by eye — it is not an
 * assertion.
 *
 * Each test seeds its own account and its own plan. That is two seconds a test
 * against a local stack, and it buys the thing that matters when this fails in
 * CI on a machine nobody can reproduce: eight independent reports rather than
 * one failure and seven skips.
 */

/**
 * How far the frame is scrolled sideways for the sticky half of the checks.
 *
 * Small, because the table fits now. Since 2026-08-08 it is `width: 100%` with
 * a minimum of about 1219px for a two-role plan, so at any ordinary viewport
 * there is nothing to scroll at all — {@link NARROW} is the width these tests
 * run at, and this is inside what it leaves over.
 */
const SCROLLED = 150;

/**
 * A viewport narrower than the table's own minimum, which is the only state
 * the pinned columns are visible in.
 *
 * That is the backstop Dany kept: above the minimum there is no horizontal
 * scroll and the pins do nothing, below it the frame scrolls and they hold the
 * left edge. Every sticky assertion in this file has to be made down here now.
 */
const NARROW = { width: 900, height: 900 } as const;

/** The columns held at the left edge, and the offsets they are held at. */
const PINNED_IDS = PINNED_COLUMN_IDS;

/**
 * Where the pinned column with this id is declared to sit, in px from the
 * frame's left edge.
 *
 * Read from `table-frame.ts` rather than written out here on purpose, and the
 * limit of that is worth stating: this spec cannot catch a width table that is
 * wrong in itself, because the browser is being asked to agree with the same
 * numbers. `table-frame.test.ts` pins the literals; what a browser adds is
 * whether the layout it produces *matches* the declaration — which is exactly
 * what drifted in the bug, and what no amount of unit testing could see.
 *
 * @throws When asked about a column that is not pinned, which would otherwise
 * compare a measured offset against nothing at all.
 */
function declaredLeft(columnId: string, state: FrameLayoutState = SEEDED_PLAN): number {
  // Resolved from the pinned columns alone, which is all an offset is: each is
  // the sum of the declared widths in front of it, and every column in front
  // of a pinned one is itself pinned.
  const geometry = frameLayout(PINNED_COLUMN_IDS, state).pinned.get(columnId);
  if (geometry === undefined) throw new Error(`${columnId} is not a pinned column`);
  return geometry.left;
}

/**
 * The plan above with one column dragged to `width`.
 *
 * The state a reader who has resized that column is looking at, so every
 * assertion about the dragged table is re-derived through `frameLayout` rather
 * than written out as a second set of numbers.
 */
const dragged = (columnId: string, width: number): FrameLayoutState => ({
  ...SEEDED_PLAN,
  columnWidthOverrides: new Map([[columnId, width]]),
});

/**
 * What the `<colgroup>` declares for one column and what the browser really
 * lays it out at, together.
 *
 * Both, because they are the two halves of the only question worth asking: a
 * declaration nothing honours and a rectangle nothing declared are different
 * failures, and a test that read one of them could not say which it had.
 *
 * @throws When the table has no such column, or no `<col>` for it — a probe
 * that silently measured nothing would pass for any width.
 */
function columnGeometry(
  page: Page,
  columnId: string,
): Promise<{ declared: string; laidOut: number }> {
  return page.evaluate((id) => {
    const headers = [...document.querySelectorAll('thead th')];
    const header = headers.find((each) => each.getAttribute('data-column') === id);
    if (header === undefined) throw new Error(`the table has no ${id} column`);
    // A `<col>` carries no name of its own: the `<colgroup>` is positional, and
    // the position of this heading is the whole of how the two are paired.
    const cols = [...document.querySelectorAll('colgroup col')];
    const at = headers.indexOf(header);
    if (at >= cols.length) throw new Error(`no <col> declares the ${id} column`);
    const col = cols[at];
    return {
      declared: col instanceof HTMLElement ? col.style.width : '(not an element)',
      laidOut: header.getBoundingClientRect().width,
    };
  }, columnId);
}

/**
 * Drags one column's header edge `travel` px sideways, the way a pointer does.
 *
 * Several moves rather than one jump: a drag is a stream of `pointermove`s, and
 * a handler that only ever saw its last one would pass a single-step gesture
 * while doing nothing under a real hand. The button goes down on the handle and
 * comes up wherever the travel ended — which is off the handle, and off the
 * column, which is what the pointer capture is for.
 *
 * @throws When the column has no handle on screen. A drag against nothing would
 * leave every width where it was and read as a column that refused to move.
 */
async function dragColumnEdge(page: Page, columnId: string, travel: number): Promise<void> {
  const handle = page.locator(`thead th[data-column="${columnId}"] [data-resize-handle]`);
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`the ${columnId} column has no resize handle on screen`);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(from.x + travel * step, from.y);
  }
  await page.mouse.up();
}

/**
 * Signs up a throwaway account and builds the smallest plan that exercises
 * every kind of cell: two rows with names long enough to wrap, one dependency
 * chip, one estimate.
 *
 * Through the UI rather than through the API, because half of what is being
 * measured is what the controls inside the cells do to them — a chip strip
 * that clips, a textarea that grew to fit its name — and none of that exists
 * in a plan seeded behind the table's back.
 */
async function seedPlan(page: Page, account: string): Promise<void> {
  await page.goto('/');

  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByLabel('Username').fill(account);
  await page.getByLabel('Password').fill('layout-gate-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  await addRow.click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  await addRow.click();
  await expect(page.getByLabel('Name of 020')).toBeVisible();

  // Long enough to wrap in a 360px column, which is the case the name cell was
  // widened for and the one an unwrapped `22em` textarea used to run out of.
  const first = page.getByLabel('Name of 010');
  await first.fill('Survey the existing warehouse racking and photograph every aisle end');
  await first.blur();
  const second = page.getByLabel('Name of 020');
  await second.fill('Draft the replacement layout, including the mezzanine access stairs');
  await second.blur();

  const depends = page.getByLabel('Add a dependency to 020');
  await depends.click();
  await depends.fill('010');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop 020 waiting for 010' })).toBeVisible();

  const estimate = page.getByLabel('Dev estimate for 010');
  await estimate.fill('2/3/8');
  await estimate.blur();
  await expect(estimate).not.toHaveValue('');

  // A project start date, because without one the earliest-start cells are a
  // rendered disabled state that never opens an editor — and the editor is
  // what {@link measure} has to measure. No row sets an earliest start of its
  // own, so the column stays at its narrow width; see {@link SEEDED_PLAN}.
  await page.getByLabel('Project start date').fill('2026-06-01');
  await page.getByLabel('Project start date').blur();
  await expect(page.getByLabel('Earliest start for 010')).toBeEnabled();
}

/**
 * Opens the first row's earliest-start editor, the way a reader does.
 *
 * The cell is text at rest since `T2 compact-columns`, so there is no date
 * input on the page until one is asked for.
 */
async function openEarliestStart(page: Page): Promise<void> {
  await page.getByLabel('Earliest start for 010').click();
  await expect(page.locator('tbody tr:first-child input[type="date"]')).toBeVisible();
}

/**
 * The number of the row that fills the Number column's display envelope: two
 * levels, drawn at the indent a two-level row is drawn at, with a child under
 * it so it carries an expander too.
 *
 * A root's own three characters plus one dotted single-character segment, which
 * is exactly {@link NUMBER_ENVELOPE}'s shape — `030` here rather than `010`
 * because {@link seedDeepBranch} builds the branch under the third root.
 */
const ENVELOPE_NUMBER = '030.1';

/**
 * And the nearest number past it: one level deeper, which is the tightest case
 * the clip has to hold for — anything deeper only overruns further.
 *
 * Depth is only one of the three ways be-01 grows a number past the envelope —
 * a group past nine siblings and an insertion against a frozen anchor are the
 * others — and it is the one a browser can build in five keystrokes.
 */
const PAST_ENVELOPE_NUMBER = '030.1.1';

/**
 * Builds a branch five levels deep under the third root.
 *
 * Two facts about the numbering decide every string below, and both cost a
 * browser run to learn: Tab indents a row under its **previous sibling**, so
 * getting one level deeper takes one more press; and every number is derived
 * from position, so indenting a root **renumbers the roots after it** — which
 * is why each chain starts at `040` again rather than at the row that was
 * called `050` a moment ago.
 */
async function seedDeepBranch(page: Page): Promise<void> {
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['030', '040', '050', '060', '070', '080', '090']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }

  const chains = [
    ['040', '030.1'],
    ['040', '030.2', '030.1.1'],
    ['040', '030.2', '030.1.2', '030.1.1.1'],
    ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.1'],
    ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.2', '030.1.1.1.1.1'],
    ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.2', '030.1.1.1.1.2', '030.1.1.1.1.1.1'],
  ];
  for (const chain of chains) {
    for (const [step, number] of chain.entries()) {
      if (step === 0) continue;
      // `exact`, because a deeper row's number has this one as its prefix and
      // the accessible names are `Name of 030.1.1.1.1` and `Name of
      // 030.1.1.1.1.1`. Without it the locator matches both and refuses.
      const box = page.getByLabel(`Name of ${chain[step - 1] ?? ''}`, { exact: true });
      await box.focus();
      await box.press('Tab');
      await expect(page.getByLabel(`Name of ${number}`, { exact: true })).toBeVisible();
    }
  }
}

/** Everything one Number cell's geometry has to answer for. */
interface NumberCell {
  /** How wide the drawn content is, including the indent in front of it. */
  contentWidth: number;
  /** The indent itself, so the fixture cannot drift to a row at another depth. */
  indent: string;
  /** Its right edge, and the cell's, so "fits" is a fact rather than an arithmetic claim. */
  contentRight: number;
  cellRight: number;
  cellWidth: number;
  cellHeight: number;
  /** More content than the cell shows, which is the truncation. */
  clipped: boolean;
  /** The whole number, wherever the cell carries it. */
  title: string | null;
  hasExpander: boolean;
  hasLock: boolean;
}

/** Measures the Number cell of the row numbered `number`. */
function numberCellNeeds(page: Page, number: string): Promise<NumberCell> {
  return page.evaluate((wanted) => {
    const cell = [...document.querySelectorAll('td[data-column="number"]')].find(
      (each) => each.querySelector('[data-number]')?.textContent === wanted,
    );
    if (cell === undefined) throw new Error(`no row is numbered ${wanted}`);
    const drawn = cell.firstElementChild;
    if (drawn === null) throw new Error(`the ${wanted} Number cell draws nothing`);
    const cellBox = cell.getBoundingClientRect();
    const drawnBox = drawn.getBoundingClientRect();
    return {
      // The padding the declared width includes: `CELL` is `border-box`, so a
      // content width compared against the column has to carry it.
      contentWidth: drawnBox.width + (cellBox.width - cell.clientWidth) + 8,
      indent: getComputedStyle(drawn).paddingLeft,
      contentRight: drawnBox.right,
      cellRight: cellBox.right,
      cellWidth: Math.round(cellBox.width),
      cellHeight: Math.round(cellBox.height),
      clipped: cell.scrollWidth > cell.clientWidth,
      title: drawn.getAttribute('title'),
      hasExpander: cell.querySelector('button') !== null,
      hasLock: cell.querySelector('[aria-label="Number is frozen"]') !== null,
    };
  }, number);
}

/**
 * Every day the table can print, as `shortIsoDate` prints it, for a year that
 * is not the reader's own.
 *
 * The formatter's own output rather than a hand-picked string, which is the
 * whole point: {@link DAY_ENVELOPE} is a claim about the widest day this table
 * can ever show, and a claim measured against a string somebody chose is a
 * claim about that person's guess. Days that do not exist are left out — a
 * `31 Feb` would widen the envelope for a day no plan can hold.
 */
function everyPrintedDay(year: number, today: Date): string[] {
  const days: string[] = [];
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 31; day += 1) {
      const at = new Date(Date.UTC(year, month - 1, day));
      if (at.getUTCMonth() !== month - 1) continue;
      days.push(
        shortIsoDate(
          `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          today,
        ),
      );
    }
  }
  return days;
}

/** How a date column draws one row's day, and whether it took one line to do it. */
interface DateCell {
  text: string;
  /** How many lines the day was drawn on: its own height over one line's. */
  lines: number;
  cellWidth: number;
}

/**
 * The Start and End cells of every row on screen.
 *
 * The line count is a height against the same string drawn `nowrap` in the
 * same cell, and it is that rather than `getClientRects().length` for a reason
 * worth writing down: **that count is fragments, not lines**. React renders
 * End's day and its no-estimate marker as two adjacent text nodes, and
 * Chromium hands back a rect for each of them on one unwrapped line — so a
 * check written on the count reported two lines for a cell that had not
 * wrapped at all, and would have failed at every width. Measured 2026-08-10,
 * before it was believed.
 *
 * @throws When a row draws no day at all, which would read as a date that fits
 * rather than as a cell nothing rendered.
 */
function dateCells(page: Page, columnId: string): Promise<DateCell[]> {
  return page.evaluate((column) => {
    const cells = [...document.querySelectorAll(`tbody td[data-column="${column}"]`)];
    if (cells.length === 0) throw new Error(`no row has a ${column} cell`);
    return cells.map((cell) => {
      const drawn = cell.firstElementChild;
      if (drawn === null) throw new Error(`a ${column} cell draws nothing`);
      const text = drawn.textContent;
      // The same day, in the same cell, on one line by construction.
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.whiteSpace = 'nowrap';
      probe.style.visibility = 'hidden';
      probe.textContent = text;
      cell.append(probe);
      const oneLine = probe.getBoundingClientRect().height;
      probe.remove();
      if (oneLine === 0) throw new Error(`the ${column} column draws no line at all`);
      return {
        text,
        lines: Math.round(drawn.getBoundingClientRect().height / oneLine),
        cellWidth: Math.round(cell.getBoundingClientRect().width),
      };
    });
  }, columnId);
}

/**
 * The widest of `days` as a Start cell would draw it, in px, and the day that
 * was widest.
 *
 * Measured **inside** the cell, so the probe inherits every font rule the
 * cell's own text has. A probe on `document.body` answered 85px where the cell
 * answers 92.5 for the same string — measured 2026-08-10, and the reason this
 * takes a cell rather than a font.
 */
function measureDaysIn(
  page: Page,
  columnId: string,
  days: readonly string[],
): Promise<{ widest: { text: string; width: number }; envelope: number; chrome: number }> {
  return page.evaluate(
    ({ column, candidates, envelopeText }) => {
      const cell = document.querySelector(`tbody tr:first-child td[data-column="${column}"]`);
      if (cell === null) throw new Error(`the first row has no ${column} cell`);
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.whiteSpace = 'nowrap';
      probe.style.visibility = 'hidden';
      cell.append(probe);
      const width = (text: string) => {
        probe.textContent = text;
        return probe.getBoundingClientRect().width;
      };
      let widest = { text: '', width: 0 };
      for (const day of candidates) {
        const drawn = width(day);
        if (drawn > widest.width) widest = { text: day, width: drawn };
      }
      const envelope = width(envelopeText);
      probe.remove();
      const style = getComputedStyle(cell);
      return {
        widest,
        envelope,
        // What the declared width holds besides the text: `CELL` is
        // `border-box`, so the padding and any border are inside the number
        // the column declares.
        chrome:
          Number.parseFloat(style.paddingLeft) +
          Number.parseFloat(style.paddingRight) +
          (cell.getBoundingClientRect().width - cell.clientWidth),
      };
    },
    { column: columnId, candidates: [...days], envelopeText: DAY_ENVELOPE },
  );
}

/**
 * Moves the whole plan into a year that is not the reader's, which is the state
 * a date column is widest in: the short date carries its year only when that
 * year is not the current one.
 */
async function dateThePlanOffThisYear(page: Page): Promise<number> {
  const year = new Date().getFullYear() + 1;
  const start = page.getByLabel('Project start date');
  await start.fill(`${String(year)}-05-20`);
  await start.blur();
  await expect(page.locator('tbody tr:first-child [data-start]')).toContainText(String(year));
  return year;
}

/** Puts the frame at `scrollLeft`, deterministically — never a wheel gesture. */
async function scrollFrameTo(page: Page, scrollLeft: number): Promise<void> {
  const reached = await page.evaluate((left) => {
    const frame = document.querySelector('[data-table-frame]');
    if (frame === null) throw new Error('the scrolling frame is not on the page');
    frame.scrollLeft = left;
    return frame.scrollLeft;
  }, scrollLeft);
  // Asserted rather than assumed: a frame that cannot scroll that far leaves
  // `scrollLeft` at its maximum, and every sticky assertion below would then
  // be made about an unscrolled table and pass without meaning anything.
  expect(reached).toBe(scrollLeft);
}

/** Every cell of every row matching this selector, in DOM order, as boxes. */
function rowBoxes(page: Page, rowsSelector: string): Promise<Box[][]> {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    if (rows.length === 0) throw new Error(`no rows matched ${selector}`);
    return rows.map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => {
        const box = cell.getBoundingClientRect();
        return {
          id: cell.getAttribute('data-column') ?? '(a cell with no data-column)',
          x: box.x,
          width: box.width,
        };
      }),
    );
  }, rowsSelector);
}

/** Every control in a body cell, paired with the cell it has to stay inside. */
function controlBoxes(page: Page): Promise<{ cell: Box; control: Box }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('tbody td')].flatMap((cell) => {
      const cellBox = cell.getBoundingClientRect();
      const column = cell.getAttribute('data-column') ?? '(a cell with no data-column)';
      // Inputs and textareas, which is every control in this table that has
      // ever asserted a width of its own. Not the chip buttons: since
      // `deps-single-line` those rest clipped behind their strip's fade — a
      // clipped chip's rect overruns on purpose while painting nothing
      // outside the cell, and `e2e/deps-cell.spec.ts` is what measures that.
      return [...cell.querySelectorAll('input, textarea')].map((control) => {
        const box = control.getBoundingClientRect();
        return {
          cell: { id: column, x: cellBox.x, width: cellBox.width },
          control: {
            id: `${control.getAttribute('aria-label') ?? control.tagName} in ${column}`,
            x: box.x,
            width: box.width,
          },
        };
      });
    }),
  );
}

/** Where the three pinned columns actually sit, in px from the frame's edge. */
function measuredLefts(page: Page, columnIds: readonly string[]): Promise<Record<string, number>> {
  return page.evaluate((ids) => {
    const frame = document.querySelector('[data-table-frame]');
    if (frame === null) throw new Error('the scrolling frame is not on the page');
    const edge = frame.getBoundingClientRect().x;
    const lefts: Record<string, number> = {};
    for (const id of ids) {
      const cell = document.querySelector(`tbody tr:first-child td[data-column="${id}"]`);
      if (cell === null) throw new Error(`the first row has no ${id} cell`);
      // Rounded to the nearest pixel, which states the half-pixel tolerance as
      // a comparison a failure message can print: `{name: 208}` against
      // `{name: 196}` says what moved and by how much.
      lefts[id] = Math.round(cell.getBoundingClientRect().x - edge);
    }
    return lefts;
  }, columnIds);
}

/**
 * Which column the width table declares at `tableX` px from the table's own
 * left edge, given the columns this plan is showing in the order it shows them.
 *
 * @throws When no column covers that offset — a probe past the right edge of
 * the declared table would otherwise be compared against nothing at all.
 */
function declaredColumnAt(
  order: readonly string[],
  tableX: number,
  measured: Readonly<Partial<Record<string, number>>>,
): string {
  let right = 0;
  for (const id of order) {
    // A flexible column has no declared width — it is whatever the frame left
    // over — so its own measurement stands in for one. Everything else is
    // still held against the number `table-frame.ts` declares, which is what
    // makes this a check rather than a tautology.
    if (FLEXIBLE_COLUMNS.has(id)) {
      const width = measured[id];
      if (width === undefined) throw new Error(`the flexible ${id} column was not measured`);
      right += width;
    } else {
      right += widthFor(id, SEEDED_PLAN);
    }
    if (tableX < right) return id;
  }
  throw new Error(`${String(Math.round(tableX))}px is past the right edge of the declared table`);
}

/** The two laptops the table has to fit, named so a failure says which one. */
const VIEWPORTS = [
  { name: '1280×800', width: 1280, height: 800 },
  { name: '1512×982', width: 1512, height: 982 },
] as const;

/**
 * Everything the width equation makes a claim about, measured at once.
 *
 * One `evaluate` rather than six, because every number here has to describe the
 * same layout: a viewport resize between two of them would compare a column
 * from one table against a frame from another.
 */
interface Measured {
  /** The page itself. `scrollWidth > clientWidth` here is the failure R6 is about. */
  document: { scrollWidth: number; clientWidth: number };
  /** The scrolling frame. Its own overflow is the h-scroll people see. */
  frame: { scrollWidth: number; clientWidth: number; left: number; right: number };
  /** Every leaf column of the header row, in order, with its rect. */
  columns: { id: string; left: number; right: number; width: number }[];
  /**
   * The first row's earliest start: the cell at rest, the editor open on it,
   * and how wide the browser would make an unconstrained date input.
   *
   * Three numbers rather than two since `T2 compact-columns`, because the cell
   * and the editor are no longer the same thing: the cell holds a short date
   * and is 84px or 56, and the editor is opened on demand and is deliberately
   * wider than its column — it escapes the cell rather than sizing it.
   *
   * `scrollWidth <= clientWidth` was the obvious check on the editor and it is
   * a check that cannot fail: Chromium lays an `input[type=date]` out at
   * whatever width it is given and clips its own internals inside the element,
   * so a 60px box reports no overflow at all while showing about half a date.
   * Watched on h2puni, 2026-08-08, with `not-before` deliberately at 60px —
   * every assertion passed. The intrinsic width is the one that answers the
   * question, and this is the number `DATE_EDITOR_WIDTH` is sized by.
   */
  earliestStart: { cell: number; editor: number; intrinsic: number };
}

/**
 * Everything the width equation claims, with an editor open on the first row's
 * earliest start.
 *
 * The editor is opened because the platform's own number can only be measured
 * against one that exists, and closed again on the way out so the next thing
 * this test does sees the table at rest. Everything else is read in a single
 * `evaluate`, because every number has to describe the same layout.
 */
async function measure(page: Page): Promise<Measured> {
  await openEarliestStart(page);
  const measured = await page.evaluate(() => {
    const frame = document.querySelector('[data-table-frame]');
    if (frame === null) throw new Error('the scrolling frame is not on the page');
    const frameBox = frame.getBoundingClientRect();
    const headers = [...document.querySelectorAll('thead th')];
    if (headers.length === 0) throw new Error('the table has no heading row');
    const restCell = document.querySelector('tbody tr:first-child td[data-column="not-before"]');
    if (restCell === null) throw new Error('the first row has no earliest-start cell');
    const dateInput = restCell.querySelector('input[type="date"]');
    if (dateInput === null) throw new Error('no earliest-start editor is open on the first row');
    // What this browser would make the field if the column did not tell it
    // otherwise: the same element, the same font, off screen, unconstrained.
    // Measured rather than assumed, because it is a platform's number — the
    // spinner, the separators and the picker icon — and not one this
    // repository gets to choose.
    const probe = document.createElement('input');
    probe.type = 'date';
    probe.value = '2026-08-08';
    probe.style.font = getComputedStyle(dateInput).font;
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.width = 'auto';
    probe.style.boxSizing = 'border-box';
    document.body.append(probe);
    const intrinsic = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      frame: {
        scrollWidth: frame.scrollWidth,
        clientWidth: frame.clientWidth,
        left: frameBox.left,
        right: frameBox.right,
      },
      columns: headers.map((header) => {
        const box = header.getBoundingClientRect();
        return {
          id: header.getAttribute('data-column') ?? '(a cell with no data-column)',
          left: box.left,
          right: box.right,
          width: box.width,
        };
      }),
      earliestStart: {
        cell: restCell.getBoundingClientRect().width,
        editor: dateInput.getBoundingClientRect().width,
        intrinsic,
      },
    };
  });
  // Escape rather than a click elsewhere: it abandons the edit, so measuring
  // cannot leave a date on a row that never had one.
  await page.keyboard.press('Escape');
  return measured;
}

/** What the width table says this state needs, from the columns really on screen. */
const equationFor = (measured: Measured): number =>
  frameLayout(
    measured.columns.map((column) => column.id),
    SEEDED_PLAN,
  ).minWidth;

/**
 * Every assertion that holds whenever the equation fits the frame.
 *
 * Written once and called from each state, because the point of the matrix is
 * that the same claims hold in every one of them — a per-state copy would be
 * six chances to assert something slightly weaker where it mattered.
 */
function expectItFits(measured: Measured, where: string): void {
  // The page never scrolls sideways, in any state: that is what the frame is
  // for, and it is the assertion Dany's R6 actually asks for.
  expect(
    measured.document.scrollWidth,
    `${where}: the page itself scrolls sideways`,
  ).toBeLessThanOrEqual(measured.document.clientWidth);
  // And where the equation fits the frame, neither does the frame.
  expect(
    measured.frame.scrollWidth,
    `${where}: the frame scrolls sideways with ${String(equationFor(measured))}px of table in ${String(measured.frame.clientWidth)}px of frame`,
  ).toBeLessThanOrEqual(measured.frame.clientWidth);
  // Every column inside the frame it is laid out in, to the pixel. Rounded by
  // 1px: sub-pixel layout is the browser's, and a column half a pixel past the
  // edge is not the failure this is looking for.
  expect(
    measured.columns
      .filter(
        (column) =>
          column.left < measured.frame.left - 1 || column.right > measured.frame.right + 1,
      )
      .map((column) => `${column.id} is outside the frame`),
    where,
  ).toEqual([]);
  // The name column keeps its floor, which is the number the equation budgets.
  const name = measured.columns.find((column) => column.id === 'name');
  expect(name?.width, `${where}: the name column`).toBeGreaterThanOrEqual(FLEXIBLE_FLOOR - 1);
  // The native date input's own furniture — the separators, the spinner and
  // the picker icon — decides `DATE_EDITOR_WIDTH`, and this is the assertion
  // that number is chosen by rather than argued about. A narrower editor shows
  // half a date, silently, because the element clips its own internals.
  expect(
    measured.earliestStart.editor,
    `${where}: the earliest-start editor is ${String(Math.round(measured.earliestStart.editor))}px where this browser wants ${String(Math.round(measured.earliestStart.intrinsic))}px, so its value is cut off`,
  ).toBeGreaterThanOrEqual(measured.earliestStart.intrinsic - 1);
  // And the column it opened over is the narrow one it is meant to be. The
  // editor escaping its cell is the whole reason the column may be this small.
  expect(
    measured.columns.find((column) => column.id === 'not-before')?.width,
    `${where}: the earliest-start column`,
  ).toBeLessThan(measured.earliestStart.intrinsic);
}

/**
 * How far a popover opened in `columnId` on the first row hangs below that
 * cell, and whether the pixels below the cell are really its own.
 *
 * Both halves are needed and neither is the other. `getBoundingClientRect` is
 * **not** clipped by an ancestor's `overflow: hidden` — a listbox cut off at
 * the cell edge still reports its full height — so the overhang is only the
 * precondition that makes the probe meaningful. `elementFromPoint` is hit
 * testing, and hit testing does respect the clip: it is what says the popover
 * is visible rather than merely laid out.
 */
function popoverEscape(
  page: Page,
  columnId: string,
  popoverSelector: string,
  /**
   * The cell to look in, where it is not the first row's `columnId` one — a
   * last-row probe, or a column named for a role that only exists at runtime.
   * `columnId` then names the cell for the failure message and nothing else.
   */
  cellSelector?: string,
): Promise<{ overhang: number; ownsPixelBelow: boolean; found: string }> {
  return page.evaluate(
    ({ column, selector, cell: where }) => {
      const inside = where ?? `tbody tr:first-child td[data-column="${column}"]`;
      const popover = document.querySelector(`${inside} ${selector}`);
      if (popover === null) {
        throw new Error(`no ${selector} is open in ${inside}`);
      }
      const cell = popover.closest('td');
      if (cell === null) throw new Error(`the ${column} popover is not in a cell`);
      const popoverBox = popover.getBoundingClientRect();
      const cellBox = cell.getBoundingClientRect();
      const at = document.elementFromPoint(popoverBox.x + popoverBox.width / 2, cellBox.bottom + 4);
      return {
        overhang: Math.round(popoverBox.bottom - cellBox.bottom),
        ownsPixelBelow: at !== null && popover.contains(at),
        // What is at that pixel instead, for the failure message: a clipped
        // popover leaves the row underneath showing through.
        found:
          at === null
            ? 'nothing at all'
            : `<${at.tagName.toLowerCase()}> in the ${
                at.closest('td')?.getAttribute('data-column') ?? 'no'
              } column`,
      };
    },
    { column: columnId, selector: popoverSelector, cell: cellSelector },
  );
}

let account = 0;

test.beforeEach(async ({ page }) => {
  account += 1;
  await seedPlan(page, `e2e-${String(Date.now())}-${String(account)}`);
});

test.describe('the table, measured by a browser', () => {
  test('leaves a picture of the table for the eye that has to judge the widths', async ({
    page,
  }, testInfo) => {
    // The one artifact here that is not an assertion. Widths were settled by
    // eye before this gate existed; this is how the next person sees what CI
    // saw without a browser of their own.
    const picture = join(testInfo.project.outputDir, 'wbs-table.png');
    await page.screenshot({ path: picture });
    expect(existsSync(picture)).toBe(true);
  });

  test('lays the heading row out with no two cells on top of each other', async ({ page }) => {
    await scrollFrameTo(page, 0);
    const [heading] = await rowBoxes(page, 'thead tr');
    // Or an empty list would satisfy `findOverlap` without a table being laid
    // out at all. Thirteen fixed columns plus a folded column per role.
    expect(heading.length).toBeGreaterThan(12);
    expect(findOverlap(heading)).toBe(undefined);
  });

  test('lays every body row out with no two cells on top of each other', async ({ page }) => {
    await scrollFrameTo(page, 0);
    const rows = await rowBoxes(page, 'tbody tr');
    expect(rows.flat().length).toBeGreaterThan(24);
    expect(rows.map((row) => findOverlap(row)).filter((found) => found !== undefined)).toEqual([]);
  });

  test('keeps every control inside the cell it belongs to', async ({ page }) => {
    await scrollFrameTo(page, 0);
    const controls = await controlBoxes(page);
    // Or an empty table would satisfy the assertion below without laying
    // anything out at all. Seven boxes to a row — the name, the dependency
    // box, the priority cell, the service/team picker, two folded role cells
    // and the date — over the
    // two rows this plan seeds. Written as the number it is: it was `> 12`
    // until a browser first ran this, which was one more than a row has held
    // since the Notes column was folded into the Name cell.
    expect(controls.length).toBeGreaterThanOrEqual(12);
    expect(
      controls
        .filter(({ cell, control }) => findOverrun(cell, control) !== undefined)
        .map(({ cell, control }) => `${control.id} runs past the ${cell.id} cell`),
    ).toEqual([]);
  });

  test('puts the pinned columns exactly where they are declared to sit', async ({ page }) => {
    await scrollFrameTo(page, 0);
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag'),
      number: declaredLeft('number'),
      name: declaredLeft('name'),
    });
  });

  test('holds the pinned columns there once the table is scrolled sideways', async ({ page }) => {
    // The invariant that drifted in the bug. Sticky offsets are prefix sums of
    // the declared widths, so a column laid out wider than it was declared
    // moves the pin and nothing else — visible only once something scrolls
    // behind it.
    await page.setViewportSize(NARROW);
    await scrollFrameTo(page, SCROLLED);
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag'),
      number: declaredLeft('number'),
      name: declaredLeft('name'),
    });
  });

  test('widens a column by dragging its header edge, and moves every pin behind it', async ({
    page,
  }) => {
    /*
     * The gesture, in the only thing that can perform one. jsdom carries out no
     * default action for a pointer event at all, so the whole of
     * `wbs-table.test.tsx` can watch the handle arrive on the right headers and
     * never watch a drag do anything — the fourteenth and fifteenth failures,
     * both of which were a browser's to find.
     *
     * Made at NARROW with the frame scrolled, because that is the only state
     * the pins are visible in: above the table's minimum there is nothing to
     * scroll and an offset that is wrong costs nothing.
     *
     * Fault: the handle's `pointerdown`/`pointermove`/`pointerup` handlers
     * removed, leaving it rendered and inert. This failed on `expected 169px to
     * be 209px` — the Number column's width and its width plus the drag, which
     * are 93 and 133 since `column-rebalance` — while the whole 955-test jsdom
     * suite stayed green — `offers a
     * handle on every column that declares a width` can see that the strip is
     * there and can never see it do nothing. Watched, 2026-08-09.
     */
    await page.setViewportSize(NARROW);
    await scrollFrameTo(page, SCROLLED);
    const before = await columnGeometry(page, 'number');
    expect(before.declared).toBe(`${String(widthFor('number', SEEDED_PLAN))}px`);

    await dragColumnEdge(page, 'number', 40);

    const wider = dragged('number', widthFor('number', SEEDED_PLAN) + 40);
    const after = await columnGeometry(page, 'number');
    // The `<col>` says 209 and the browser lays 209 out: the declaration and
    // the rectangle, which is the pair that drifted apart in the overlap bug.
    expect(after.declared).toBe(`${String(widthFor('number', wider))}px`);
    expect(Math.round(after.laidOut - before.laidOut)).toBe(40);
    // And every pinned column behind it moved by exactly the same 40, because
    // the offsets are summed from the widths this render resolved rather than
    // from the defaults.
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag', wider),
      number: declaredLeft('number', wider),
      name: declaredLeft('name', wider),
    });
    expect(declaredLeft('name', wider) - declaredLeft('name')).toBe(40);
  });

  test('still has the width it was dragged to after the browser is reloaded', async ({ page }) => {
    /*
     * The half a single page can never show: the width is written when the
     * drag is let go of, and nothing but a reload reads it back.
     *
     * Fault: the `rememberWidthOverrides` call in the drag's commit removed.
     * This failed on `expected '169px' to be '209px'` (93 and 133 now) after the reload, with
     * the drag itself still working perfectly on the page that made it —
     * invisible to every test that does not come back. Watched, 2026-08-09.
     */
    await page.setViewportSize(NARROW);
    await dragColumnEdge(page, 'number', 40);
    const wider = dragged('number', widthFor('number', SEEDED_PLAN) + 40);
    expect((await columnGeometry(page, 'number')).declared).toBe(
      `${String(widthFor('number', wider))}px`,
    );

    await page.reload();
    await expect(page.getByLabel('Name of 010')).toBeVisible();

    expect((await columnGeometry(page, 'number')).declared).toBe(
      `${String(widthFor('number', wider))}px`,
    );
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag', wider),
      number: declaredLeft('number', wider),
      name: declaredLeft('name', wider),
    });
  });

  test('gives every column back to the width the layout resolves for it now', async ({ page }) => {
    /*
     * The reset, measured rather than read off the markup: what it has to
     * restore is not one `<col>` but the whole frame, offsets included.
     *
     * Fault: the reset re-written to store the widths resolved at the moment it
     * was pressed rather than to forget the key. This failed on `expected
     * '209px' to be '169px'` (133 and 93 now) — a reset that renamed the override instead of
     * removing it. Watched, 2026-08-09, alongside the jsdom case that watches
     * the same fault against a default that has moved since.
     */
    await page.setViewportSize(NARROW);
    await scrollFrameTo(page, SCROLLED);
    // Nothing to reset until something has been dragged, so the control is not
    // there to be pressed: a button that provably does nothing reads as broken.
    await expect(page.getByRole('button', { name: 'Reset layout' })).toHaveCount(0);

    await dragColumnEdge(page, 'number', 40);
    await page.getByRole('button', { name: 'Reset layout' }).click();

    expect((await columnGeometry(page, 'number')).declared).toBe(
      `${String(widthFor('number', SEEDED_PLAN))}px`,
    );
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag'),
      number: declaredLeft('number'),
      name: declaredLeft('name'),
    });
    await expect(page.getByRole('button', { name: 'Reset layout' })).toHaveCount(0);
  });

  test('offers a handle on every column, the Name column included', async ({ page }) => {
    // The set, measured in the browser rather than in the markup. Until
    // `name-column-drag` the Name column was refused a handle — the
    // remainder-absorber had nothing to write — and this test asserted the
    // refusal; a dragged Name writes an override now, so the handle set is
    // every rendered column.
    await scrollFrameTo(page, 0);
    const handled = await page.evaluate(() =>
      [...document.querySelectorAll('thead th')]
        .filter((header) => header.querySelector('[data-resize-handle]') !== null)
        .map((header) => header.getAttribute('data-column') ?? '(a cell with no data-column)'),
    );
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('thead th')].map(
        (header) => header.getAttribute('data-column') ?? '(a cell with no data-column)',
      ),
    );

    expect(handled).toEqual(shown);
    expect(handled).toContain('name');
  });

  test('widens the Name column by dragging its header edge, with its <col> silent', async ({
    page,
  }) => {
    /*
     * The Name gesture, in the only thing that can perform one: jsdom carries
     * out no default action for a pointer event, so `wbs-table.test.tsx` can
     * see Name's handle arrive and can never see it do anything — the
     * fourteenth/fifteenth/sixteenth failures' shape, and `T1
     * column-widths-drag`'s row 16 one column along.
     *
     * Made at NARROW, below the table's minimum, because that is where a
     * dragged Name is laid out at the dragged width itself: above the minimum
     * the unsized column absorbs the viewport's slack and the drag moves only
     * the minimum. Down here Name stands at exactly its 200px floor before
     * the drag, which is also what the gesture's measured from-width has to
     * find.
     */
    await page.setViewportSize(NARROW);
    await scrollFrameTo(page, SCROLLED);
    const before = await columnGeometry(page, 'name');
    // No override yet: no `<col>` width, and the floor is what is laid out.
    expect(before.declared).toBe('');
    expect(Math.round(before.laidOut)).toBe(FLEXIBLE_FLOOR);

    await dragColumnEdge(page, 'name', 60);

    const after = await columnGeometry(page, 'name');
    // The `<col>` stays silent — the dragged width lives on the Name cells —
    // and the browser lays out exactly the width the gesture wrote: the
    // measured 200px floor plus the travel.
    expect(after.declared).toBe('');
    expect(Math.round(after.laidOut)).toBe(FLEXIBLE_FLOOR + 60);
    // The pinned offsets in front of Name do not move: it is the last pinned
    // column, so no offset ever sums it.
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag'),
      number: declaredLeft('number'),
      name: declaredLeft('name'),
    });
    // And the one minimum the whole frame reads counts the override: the
    // table's declared floor grew by exactly the travel.
    const minWidth = await page.evaluate(
      () => document.querySelector('table')?.style.minWidth ?? '(no table)',
    );
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('thead th')].map(
        (header) => header.getAttribute('data-column') ?? '(a cell with no data-column)',
      ),
    );
    expect(minWidth).toBe(
      `${String(frameLayout(shown, dragged('name', FLEXIBLE_FLOOR + 60)).minWidth)}px`,
    );
  });

  test('keeps every other column on its envelope while Name holds a dragged width', async ({
    page,
  }) => {
    /*
     * The excess-width measurement, at the widest viewport the header matrix
     * covers — and the measurement that decided task 5's branch. The design
     * tried first expressed the override as `width` + `min-width` on the Name
     * cells against a `width: 100%` table, and this test watched Chromium
     * refuse it: with every column effectively sized, fixed layout
     * distributed the viewport's slack across all of them — `Expected: 93 /
     * Received: 103.484375` for the Number column (CI `pixels` run
     * 31430669282, 2026-08-10). So the winner is the fallback the plan named:
     * with a Name override in force the table declares its own width as the
     * resolved sum, every column stands at exactly its resolved width, and
     * the viewport — not the table — keeps the slack. The losing branch is
     * deleted, not kept as dead config; the same failure is this test's
     * negative, watched red with the gate in place before the winning line
     * existed.
     */
    await page.setViewportSize({ width: 1512, height: 982 });
    await dragColumnEdge(page, 'name', -150);

    // The override the drag wrote, read back rather than predicted: the
    // gesture counts from the rendered width, which owns a scrollbar's worth
    // of variance this test must not.
    const written = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((each) => each.startsWith('wbs.columnWidths.'));
      if (key === undefined) throw new Error('the drag stored no widths');
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    });
    const override = written['name'];
    if (typeof override !== 'number') throw new Error('the drag stored no width for name');

    const measured = await measure(page);
    // The precondition that makes this a slack measurement at all: the table's
    // resolved sum with the override is inside the viewport, so there is
    // excess for a wrong design to distribute.
    const ids = measured.columns.map((column) => column.id);
    const resolvedSum = frameLayout(ids, dragged('name', override)).minWidth;
    expect(resolvedSum).toBeLessThan(measured.frame.clientWidth);
    // The envelopes hold: the slack went nowhere near the sized columns.
    for (const id of ['number', 'start', 'finish']) {
      const column = measured.columns.find((each) => each.id === id);
      expect(column?.width, id).toBeCloseTo(widthFor(id, SEEDED_PLAN), 0);
    }
    // Name stands at exactly the override — the table is exactly as wide as
    // its columns, and the slack is the frame's own blank space rather than
    // anybody's column.
    const name = measured.columns.find((column) => column.id === 'name');
    expect(name?.width).toBeCloseTo(override, 0);
    expect(measured.frame.scrollWidth).toBeLessThanOrEqual(measured.frame.clientWidth);
    expect((await columnGeometry(page, 'name')).declared).toBe('');
  });

  test('keeps a depth-6 name readable and editable with Name dragged to its floor', async ({
    page,
  }) => {
    /*
     * The combined case both cross-reviews asked for: the narrowest Name a
     * drag can produce (its 200px floor) under the deepest indent the fixture
     * draws — a depth-6 row spends the 24px share the Number column's cap
     * withheld inside the Name cell — with a name long enough to need several
     * lines. Each half is proven on its own elsewhere (the floor by the drag
     * clamp, the share by the deep-plan outline case); nothing else proves
     * the three survive each other.
     *
     * Watched red first, honestly: on a probe branch the width assertion was
     * pointed at the pre-drag width — the drag's effect denied — and failed
     * on `Expected: 397 / Received: 200` in CI's `pixels` (run 31434774350,
     * 2026-08-10), the wrap and typing assertions standing behind it.
     *
     * Then this version threw before it could assert, on its own fixture: the
     * yardstick named `040`, a row {@link seedDeepBranch} indents away — `Name
     * of 040 is not on screen`, CI `pixels` run 31435567028, 2026-08-11. The
     * drag half stood; only the lookup was wrong. Yardstick repointed at `030`
     * below, with the reason it cannot be any other row written beside it —
     * green on that gesture in CI `pixels` run 31441016178, 6.9s, 117 passed.
     */
    await seedDeepBranch(page);
    const deep = page.getByLabel('Name of 030.1.1.1.1.1.1', { exact: true });
    await deep.fill('Reticulating the splines across every warehouse aisle end simultaneously');
    await deep.blur();

    // To the floor, from wherever this viewport lays Name out: aimed a step
    // past it so the clamp is what stops the gesture, with the pointer still
    // inside the viewport.
    const before = await columnGeometry(page, 'name');
    await dragColumnEdge(page, 'name', -(Math.ceil(before.laidOut) - FLEXIBLE_FLOOR + 20));
    const cell = await columnGeometry(page, 'name');
    expect(Math.round(cell.laidOut)).toBe(FLEXIBLE_FLOOR);

    // Visible, wrapped vertically, and inside its own cell: the auto-sizing
    // textarea answers a 168px writing width with more lines, never with an
    // overflow — a shallow row's one-line box is the yardstick.
    //
    // `030` is that row, and the choice is forced: {@link seedDeepBranch}
    // spends one spare root per chain, so of the seven rows it adds only the
    // branch's own parent is left un-indented by the time it returns — and
    // the two rows the fixture seeds before it, `010` and `020`, carry names
    // long enough to wrap at this width themselves, which is no yardstick at
    // all. `030` is empty and at depth 0: one line, by construction.
    await expect(deep).toBeVisible();
    const boxes = await page.evaluate(() => {
      const boxFor = (label: string) => {
        const node = document.querySelector(`[aria-label="${label}"]`);
        if (!(node instanceof HTMLElement)) throw new Error(`${label} is not on screen`);
        return node.getBoundingClientRect();
      };
      const deepBox = boxFor('Name of 030.1.1.1.1.1.1');
      const deepCell = document
        .querySelector('[aria-label="Name of 030.1.1.1.1.1.1"]')
        ?.closest('td')
        ?.getBoundingClientRect();
      if (deepCell === undefined) throw new Error('the depth-6 row has no Name cell');
      return {
        deepHeight: deepBox.height,
        deepRight: deepBox.right,
        cellRight: deepCell.right,
        shallowHeight: boxFor('Name of 030').height,
      };
    });
    expect(boxes.deepHeight).toBeGreaterThan(boxes.shallowHeight);
    expect(boxes.deepRight).toBeLessThanOrEqual(boxes.cellRight + 1);

    // And typing still lands in it — an editor, not a picture of one.
    await deep.click();
    await page.keyboard.type('zz9');
    await expect(deep).toHaveValue(/zz9/);
  });

  test('paints the pinned block over the row that scrolls behind it, and stops there', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await scrollFrameTo(page, SCROLLED);
    // `elementFromPoint`, not a sweep over the boxes. Once the frame is
    // scrolled, unpinned cells legitimately sit *underneath* the pinned block
    // — that is what sticky columns are — so their rectangles overlap by
    // design and an adjacent-pair check would fail on a correct paint. The
    // only question worth asking is which cell owns the pixel on each side of
    // the pinned block's right edge.
    const edge = await page.evaluate(() => {
      const row = document.querySelector('tbody tr:first-child');
      if (row === null) throw new Error('the plan has no rows');
      const name = row.querySelector('td[data-column="name"]');
      if (name === null) throw new Error('the first row has no name cell');
      const frame = document.querySelector('[data-table-frame]');
      if (frame === null) throw new Error('the scrolling frame is not on the page');
      const box = name.getBoundingClientRect();
      const middle = box.y + box.height / 2;
      const columnAt = (x: number) =>
        document.elementFromPoint(x, middle)?.closest('td')?.getAttribute('data-column') ?? null;
      return {
        inside: columnAt(box.right - 2),
        outside: columnAt(box.right + 2),
        // The outside probe in the table's own coordinates, so the id painted
        // there can be held against the id the width table declares for it.
        outsideAt: box.right + 2 - frame.getBoundingClientRect().x + frame.scrollLeft,
        order: [...row.querySelectorAll('td')].map(
          (cell) => cell.getAttribute('data-column') ?? '(a cell with no data-column)',
        ),
        // The flexible column's own width, which the declared widths cannot
        // supply: it is whatever the frame left over.
        measured: Object.fromEntries(
          [...row.querySelectorAll('td')].map((cell) => [
            cell.getAttribute('data-column') ?? '(a cell with no data-column)',
            cell.getBoundingClientRect().width,
          ]),
        ),
      };
    });

    expect(edge.inside).toBe('name');
    // Three assertions where there was one, because the one they replace could
    // not fail. `expect(PINNED_IDS).not.toContain(edge.outside ?? 'nothing at
    // all')` passed when the probe found *nothing* — and a pinned block
    // painting over the whole row, or a table that never laid out, is exactly
    // what "nothing at all" looks like.
    expect(edge.outside, 'no cell owns the pixel past the pinned block').not.toBeNull();
    // Not a pinned column: that is the pinned block painting past its own
    // declared width, which is the fault this probe exists for.
    expect(PINNED_IDS.map(String)).not.toContain(edge.outside);
    // And it is the column the width table puts at that offset. Not written
    // out as `depends`: `depends` is the first unpinned column, but by
    // `SCROLLED` px it has scrolled in behind the pinned block along with
    // `team`, so which column shows at the block's right edge is a fact about
    // the declared widths — computed from them here, the same way the pinned
    // offsets are.
    expect(edge.outside).toBe(declaredColumnAt(edge.order, edge.outsideAt, edge.measured));
  });

  test('opens the dependency list out past the bottom of its own cell', async ({ page }) => {
    await scrollFrameTo(page, 0);
    // Two more rows first. The list 010 can depend on holds one entry in the
    // seeded pair, and one line is short enough to fit inside a cell made tall
    // by a wrapped name — which would leave the escape below with nothing to
    // measure. Three entries cannot fit.
    const addRow = page.getByRole('button', { name: 'Add work item' });
    await addRow.click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    await addRow.click();
    await expect(page.getByLabel('Name of 040')).toBeVisible();

    await page.getByLabel('Add a dependency to 010').click();
    await expect(page.getByRole('listbox')).toBeVisible();

    const escape = await popoverEscape(page, 'depends', '[role="listbox"]');
    // Or the probe below the cell is a probe of empty space, and "the list
    // owns that pixel" would be a question nobody asked.
    expect(escape.overhang).toBeGreaterThan(8);
    expect(
      escape.ownsPixelBelow,
      `4px below the depends cell is ${escape.found}, not the open list`,
    ).toBe(true);
  });

  test('opens the notes preview out past the bottom of the name cell', async ({ page }) => {
    // The notes are written under the name, in the Name cell, and the rendered
    // preview hangs off that cell now — which is a pinned column, so this is
    // also where "pinned" and "must not clip" are asked to hold at once.
    const name = page.getByLabel('Name of 010');
    // A name and three paragraphs under it, so the rendered preview is taller
    // than the box it hangs off — the same reason the dependency list above is
    // given three entries. The clamp on the box is what makes that true: at
    // rest it shows the name alone, and the preview holds everything under it
    // (`e2e/name-cell.spec.ts`). It used to show four lines of the note and
    // the overhang was smaller for it.
    await name.fill(
      'Racking survey\nAisle ends photographed\n\nMezzanine measured\n\nFire doors checked\n\nSprinkler heads counted',
    );
    await name.blur();
    // The marker at the cell's right edge, not the cell: since 2026-08-09 the
    // preview opens from there and from nowhere else, and this test is about
    // where the box it opens is allowed to reach. `e2e/hover-cards.spec.ts`
    // owns the trigger itself.
    await page.getByLabel('Notes on 010').hover();
    await expect(page.getByRole('tooltip', { name: 'Notes for 010, rendered' })).toBeVisible();

    const escape = await popoverEscape(page, 'name', '[role="tooltip"]');
    expect(escape.overhang).toBeGreaterThan(8);
    expect(
      escape.ownsPixelBelow,
      `4px below the name cell is ${escape.found}, not the preview`,
    ).toBe(true);
  });

  test('moves the caret through a wrapped name before it leaves the row', async ({ page }) => {
    // The one assertion in this change that jsdom cannot make, and the reason
    // the caret rule is "position 0 and the end of the value" rather than
    // "the first and last logical line". This name is ONE logical line, long
    // enough to wrap onto several visual ones in a 360px column: Up pressed in
    // the middle of it must walk the caret up a visual line — the browser's own
    // behaviour — and must not move the focus to the row above.
    const name = page.getByLabel('Name of 020');
    await name.fill(
      'Draft the replacement layout including the mezzanine access stairs, the fire doors, the sprinkler heads and every aisle end that has to be photographed before the racking comes out',
    );
    await name.blur();

    // Wrapped for real, or this test is about a one-line box: the rendered box
    // is taller than a single line of its own font.
    const lines = await name.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      // Chromium answers `normal` for a `line-height` nothing set, and
      // `parseFloat('normal')` is `NaN` — which made every comparison below
      // false and this precondition unfailable in the one direction that
      // mattered. Observed on h2puni, 2026-08-08: `expected > 2, received
      // NaN`. The font's own size is the fallback the browser is describing.
      const lineHeight =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      return Math.round(box.height / lineHeight);
    });
    expect(lines, 'the name has to wrap for this test to be about wrapping').toBeGreaterThan(2);

    // The caret in the middle of the value, which is the middle of a wrapped
    // line rather than the start of a logical one.
    const middle = await name.evaluate((node) => {
      const box = node as HTMLTextAreaElement;
      box.focus();
      const at = Math.floor(box.value.length / 2);
      box.setSelectionRange(at, at);
      return at;
    });

    await page.keyboard.press('ArrowUp');
    await expect(name).toBeFocused();
    const moved = await name.evaluate((node) => (node as HTMLTextAreaElement).selectionStart);
    // The browser moved it, and it moved up rather than to the start: a visual
    // line back is fewer characters than the whole first half of the value.
    expect(moved).toBeLessThan(middle);
    expect(moved).toBeGreaterThan(0);

    // And from position 0 the row above takes the focus, the next press.
    await name.evaluate((node) => {
      (node as HTMLTextAreaElement).setSelectionRange(0, 0);
    });
    await page.keyboard.press('ArrowUp');
    await expect(page.getByLabel('Name of 010')).toBeFocused();
  });

  test('opens a row’s actions menu out past the bottom of its own cell', async ({ page }) => {
    // A row with nothing typed into it, so its cells are one line high and a
    // two-item menu cannot fit inside one — the same reason the dependency list
    // above is given three entries. The seeded rows have wrapped names and are
    // two lines tall.
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();

    const actions = page.getByRole('button', { name: 'Actions for 030' });
    // `actions` is the last column of the table and `elementFromPoint` takes
    // viewport coordinates: unscrolled, the probe would be off screen.
    await actions.scrollIntoViewIfNeeded();
    await actions.click();
    await expect(page.getByRole('menu')).toBeVisible();

    // The row whose menu is open is 030, the one just added — which is the
    // LAST row, not the first. Probing `tr:first-child` looked right and
    // could only ever throw: observed on h2puni, 2026-08-08, `no [role="menu"]
    // is open in tbody tr:first-child td[data-column="actions"]`.
    const escape = await popoverEscape(
      page,
      'actions',
      '[role="menu"]',
      'tbody tr:last-child td[data-column="actions"]',
    );
    // Or the probe below the cell is a probe of empty space.
    expect(escape.overhang).toBeGreaterThan(8);
    expect(
      escape.ownsPixelBelow,
      `4px below the actions cell is ${escape.found}, not the open menu`,
    ).toBe(true);
  });

  test('drives the actions menu from the keyboard, and gives the focus back', async ({ page }) => {
    // The half jsdom cannot have. `fireEvent` performs no default action, so a
    // unit test can assert that Tab was left alone and that the button holds
    // the focus — but not where the browser's own Tab then carries it, and not
    // that a click on an item lands before the blur closes the menu under it.
    const label = (): Promise<string | null> =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    const focusedText = (): Promise<string | null> =>
      page.evaluate(() => document.activeElement?.textContent ?? null);

    const actions = page.getByRole('button', { name: 'Actions for 010' });
    await actions.focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('menu')).toBeVisible();
    expect(await focusedText()).toBe('Duplicate');
    await page.keyboard.press('ArrowDown');
    expect(await focusedText()).toBe('Delete');
    await page.keyboard.press('ArrowUp');
    expect(await focusedText()).toBe('Duplicate');

    // Escape closes and hands the focus back to the button it opened from.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await label()).toBe('Actions for 010');

    // Tab out of an open menu is not trapped: the menu closes, the focus goes
    // back to the button, and the browser's own Tab carries it on from there —
    // to the next tab stop in the DOM, which is the next row's Name.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await label()).toBe('Name of 020');

    // And taking an item leaves the caret where the work carries on: in the
    // copy's Name, which the table asks for once be-01 has taken the copy.
    await actions.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Name of 020')).toHaveValue(
      'Survey the existing warehouse racking and photograph every aisle end (copy)',
    );
    await expect(page.getByLabel('Name of 020')).toBeFocused();
  });

  // ---------------------------------------------------------------------
  // SPIKE (C0, capacity), round 2. Round 1 measured a standalone In-parallel
  // column at 48px and got headroom=-19 at 1280x800 with the roles folded, so
  // the column does not fit. This round measures the baseline it is -19
  // against, and the alternative that needs no column at all: the number said
  // inside the Team cell, `Platform x3`.
  // ---------------------------------------------------------------------

  test('SPIKE C0-2: the baseline equation with no new column', async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const measured = await measure(page);
      const needed = equationFor(measured);
      console.log(
        `SPIKE-C0-2 baseline ${viewport.name}: columns=${String(measured.columns.length)} ` +
          `equation=${String(needed)} frame=${String(measured.frame.clientWidth)} ` +
          `headroom=${String(measured.frame.clientWidth - needed)}`,
      );
      expect(needed).toBeLessThanOrEqual(measured.frame.clientWidth);
    }
  });

  test('SPIKE C0-2: what the Team cell can hold at its declared 120px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const team = page.getByLabel('Service or team for 010');
    await expect(team).toBeVisible();
    const measured = await page.evaluate(() => {
      const cell = document.querySelector('tbody tr:first-child td[data-column="team"]');
      if (cell === null) throw new Error('the first row has no team cell');
      const box = cell.getBoundingClientRect();
      const style = getComputedStyle(cell);
      // The strings measured in the cell's own font, off screen and
      // unconstrained -- the platform's number, not one this repository picks.
      const probe = document.createElement('span');
      probe.style.font = style.font;
      probe.style.position = 'fixed';
      probe.style.left = '-9999px';
      probe.style.whiteSpace = 'nowrap';
      document.body.append(probe);
      const widthOf = (text: string): number => {
        probe.textContent = text;
        return probe.getBoundingClientRect().width;
      };
      const strings: Record<string, number> = {};
      for (const text of [
        'Platform',
        'Platform x3',
        'Platform x1000',
        'Infrastructure and platform',
        'Infrastructure and platform x1000',
      ]) {
        strings[text] = widthOf(text);
      }
      probe.remove();
      return {
        cellWidth: box.width,
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        strings,
      };
    });
    console.log(
      `SPIKE-C0-2 team-cell 1280x800: cell=${String(measured.cellWidth)} ` +
        `padding=${String(measured.paddingLeft)}+${String(measured.paddingRight)} ` +
        Object.entries(measured.strings)
          .map(([text, width]) => `"${text}"=${String(width)}`)
          .join(' '),
    );
    // Or the probe measured nothing and every number above is zero.
    expect(measured.strings['Platform']).toBeGreaterThan(0);
  });

  test('fits every laptop width with the roles folded', async ({ page }) => {
    // The state a plan is read in, and the one R6 is actually about: two roles
    // folded is 827px of fixed columns plus two 96px roles plus Name's 200
    // floor — 1219px — so both of these have room to spare.
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const measured = await measure(page);
      // Or this is a check about a table that never laid out. Twelve fixed
      // columns and one per folded role.
      expect(measured.columns.length).toBeGreaterThan(11);
      expect(
        equationFor(measured),
        `${viewport.name}: the folded equation should fit this viewport`,
      ).toBeLessThanOrEqual(measured.frame.clientWidth);
      expectItFits(measured, `${viewport.name}, both roles folded`);
    }
  });

  test('gives the name column everything the other columns did not take', async ({ page }) => {
    // The half of "fits" that a minimum width alone would not prove: the table
    // is as wide as the frame and the flexible column is where the difference
    // went. A fixed Name width satisfies the overflow assertions above and
    // fails this one.
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const measured = await measure(page);
      const name = measured.columns.find((column) => column.id === 'name');
      const others = measured.columns
        .filter((column) => column.id !== 'name')
        .reduce((total, column) => total + column.width, 0);
      expect(name?.width, viewport.name).toBeCloseTo(measured.frame.clientWidth - others, 0);
      // And it really did grow past its floor at these widths, or the
      // assertion above would hold for a table that simply fitted.
      expect(name?.width, viewport.name).toBeGreaterThan(FLEXIBLE_FLOOR);
    }
  });

  test('holds the equation with one role unfolded, and scrolls only where it must', async ({
    page,
  }) => {
    // The accordion's arithmetic, measured: one role open is 1430px, which
    // fits 1512 and does not fit 1280. Both answers are asserted — the second
    // is the pinned backstop doing its job, not a failure.
    for (const role of ['Dev', 'QA']) {
      await page.getByRole('button', { name: `Unfold ${role} estimates` }).click();
      await expect(page.getByLabel(`${role} optimistic for 010`)).toBeVisible();
      // The other role folded itself, which is what keeps this to 1430.
      const other = role === 'Dev' ? 'QA' : 'Dev';
      await expect(page.getByLabel(`${other} optimistic for 010`)).toHaveCount(0);

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const measured = await measure(page);
        const needed = equationFor(measured);
        expect(
          measured.document.scrollWidth,
          `${viewport.name}, ${role} unfolded: the page itself scrolls sideways`,
        ).toBeLessThanOrEqual(measured.document.clientWidth);
        if (needed <= measured.frame.clientWidth) {
          expectItFits(measured, `${viewport.name}, ${role} unfolded`);
        } else {
          // Below the minimum the frame scrolls — that is the whole of the
          // backstop, and asserting it is what stops "it fits" being a claim
          // about a table that quietly clipped instead.
          expect(
            measured.frame.scrollWidth,
            `${viewport.name}, ${role} unfolded: ${String(needed)}px of table in ${String(measured.frame.clientWidth)}px of frame and nothing to scroll`,
          ).toBeGreaterThan(measured.frame.clientWidth);
        }
      }
    }
  });

  test('fits a deep plan with an unbreakable name and six dependencies', async ({ page }) => {
    // The content fixture: the deepest numbering the indent goes to, a name
    // with no space in it to wrap at, and enough chips in a 110px column to
    // make a row several lines tall. Every one of those is a way a cell has
    // pushed its column wider than declared in the past.
    const addRow = page.getByRole('button', { name: 'Add work item' });
    for (const number of ['030', '040', '050', '060', '070', '080', '090']) {
      await addRow.click();
      await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
    }

    // Six levels deep — two past `numberIndentFor`'s cap, which is the depth
    // `deep-indent` is about. Two facts about the numbering decide every
    // string below, and both cost a browser run to learn: Tab indents a row
    // under its **previous sibling**, so getting one level deeper takes one
    // more press; and every number is derived from position, so indenting a
    // root **renumbers the roots after it** — which is why each chain starts
    // at `040` again rather than at the row that was called `050` a moment
    // ago. Guessing produced `030.1.1` from one press, and then `040.1` from
    // a row that had quietly been renumbered.
    const chains = [
      ['040', '030.1'],
      ['040', '030.2', '030.1.1'],
      ['040', '030.2', '030.1.2', '030.1.1.1'],
      ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.1'],
      ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.2', '030.1.1.1.1.1'],
      ['040', '030.2', '030.1.2', '030.1.1.2', '030.1.1.1.2', '030.1.1.1.1.2', '030.1.1.1.1.1.1'],
    ];
    for (const chain of chains) {
      for (const [step, number] of chain.entries()) {
        if (step === 0) continue;
        const box = page.getByLabel(`Name of ${chain[step - 1] ?? ''}`);
        await box.focus();
        await box.press('Tab');
        await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
      }
    }

    const deep = page.getByLabel('Name of 030.1.1.1.1.1.1');
    await deep.fill('Reticulating-the-splines-across-every-warehouse-aisle-end-simultaneously');
    await deep.blur();

    // The outline the reader's eye adds up, one row per depth. No single
    // element's edge moves at every level — the Number cell's padding is flat
    // past its cap, and the Name cell's share is zero below it — so what is
    // measured is the **sum** of the two: the Number cell's used padding plus
    // how far the Name box stands from its own cell's edge. That sum is
    // `hierarchyIndentFor`, and it must be strictly deeper at every level,
    // depth 6 included — the two levels past the cap used to draw flush.
    const outlineNumbers = [
      '030',
      '030.1',
      '030.1.1',
      '030.1.1.1',
      '030.1.1.1.1',
      '030.1.1.1.1.1',
      '030.1.1.1.1.1.1',
    ];
    const outline = await page.evaluate((numbers) => {
      return numbers.map((number) => {
        const nameBox = document.querySelector(`[aria-label="Name of ${number}"]`);
        const numberSpan =
          nameBox?.closest('tr')?.querySelector<HTMLElement>(`span[title="${number}"]`) ?? null;
        const nameCell = nameBox?.closest('td') ?? null;
        if (!(nameBox instanceof HTMLElement) || numberSpan === null || nameCell === null) {
          throw new Error(`no indent-carrying cells on screen for ${number}`);
        }
        return {
          number,
          numberIndent: Number.parseFloat(getComputedStyle(numberSpan).paddingLeft),
          nameShare: nameBox.getBoundingClientRect().left - nameCell.getBoundingClientRect().left,
        };
      });
    }, outlineNumbers);
    for (const [depth, measured] of outline.entries()) {
      // Each half is the arithmetic it claims: the capped indent on the
      // Number cell, the withheld share in front of the Name box.
      expect(measured.numberIndent, `${measured.number}'s Number indent`).toBe(
        numberIndentFor(depth),
      );
      // Within half a pixel of the arithmetic — rect edges are sub-pixel.
      expect(measured.nameShare, `${measured.number}'s Name share`).toBeCloseTo(
        hierarchyIndentFor(depth) - numberIndentFor(depth) + (outline[0]?.nameShare ?? 0),
        0,
      );
      // And the sum steps right at this level — strictly, which is the claim
      // the capped indent broke past depth 4.
      if (depth > 0) {
        const shallower = outline[depth - 1];
        expect(
          measured.numberIndent + measured.nameShare,
          `${measured.number} stands deeper than ${shallower.number}`,
        ).toBeGreaterThan(shallower.numberIndent + shallower.nameShare);
      }
    }

    // The Gantt label rail takes the uncapped indent whole — it has no 93px
    // column to protect — so its own edge keeps stepping right to depth 6 too.
    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('[data-gantt-labels]')).toBeVisible();
    const railPads = await page.evaluate((numbers) => {
      return numbers.map((number) => {
        const label = [...document.querySelectorAll<HTMLElement>('[data-gantt-label]')].find(
          (each) => each.textContent.startsWith(`${number} `),
        );
        if (label === undefined) throw new Error(`no label on the rail for ${number}`);
        return Number.parseFloat(getComputedStyle(label).paddingLeft);
      });
    }, outlineNumbers);
    for (const [depth, pad] of railPads.entries()) {
      expect(pad, `the rail label at depth ${String(depth)}`).toBe(hierarchyIndentFor(depth) + 8);
    }
    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('[data-gantt-labels]')).toHaveCount(0);

    // Six more roots for 020 to wait for — its own subtree cannot supply them,
    // and an ancestor is a dependency be-01 refuses.
    const chips = ['040', '050', '060', '070', '080', '090'];
    for (const number of chips) {
      await addRow.click();
      await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
    }
    const depends = page.getByLabel('Add a dependency to 020');
    await depends.click();
    await depends.fill(chips.join(', '));
    await depends.press('Enter');
    // Seven, with the one the plan was seeded with. This used to make a
    // `depends` cell several lines tall; since `deps-single-line` the cell
    // rests clipped to one line, and `e2e/deps-cell.spec.ts` owns what that
    // looks like — here the seven chips are simply the heaviest content the
    // width equation has to keep inside its column.
    await expect(page.getByRole('button', { name: /^Stop 020 waiting for / })).toHaveCount(7);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const measured = await measure(page);
      expectItFits(measured, `${viewport.name}, a deep plan with long content`);
    }
  });

  test('scrolls the frame below the table’s minimum, with the name still pinned', async ({
    page,
  }) => {
    // The backstop, at a width no laptop has: the table cannot be 1219px wide
    // in a 900px window, so the frame scrolls and the three identity columns
    // hold the left edge — Name at 117, the sum of the two fixed columns in
    // front of it, while it is scrolling.
    await page.setViewportSize(NARROW);
    const measured = await measure(page);
    expect(equationFor(measured)).toBeGreaterThan(measured.frame.clientWidth);
    expect(
      measured.frame.scrollWidth,
      'the frame has nothing to scroll at a width below the table’s own minimum',
    ).toBeGreaterThan(measured.frame.clientWidth);
    // And the page still does not, which is what the frame is for.
    expect(measured.document.scrollWidth).toBeLessThanOrEqual(measured.document.clientWidth);

    await scrollFrameTo(page, SCROLLED);
    expect(await measuredLefts(page, PINNED_IDS)).toEqual({
      drag: declaredLeft('drag'),
      number: declaredLeft('number'),
      name: declaredLeft('name'),
    });
    // Written out as well as derived, because 117 is the number the change is
    // judged by and a geometry that agreed with itself about 0 would satisfy
    // the comparison above.
    expect(declaredLeft('name')).toBe(117);
  });

  test('keeps the page from scrolling sideways at 125% zoom', async ({ page }) => {
    // A reader with larger type is the case a fixed-width table fails first.
    // Chromium's `zoom` on the root scales the layout the way the browser's
    // own zoom control does, so 1280 becomes 1024 CSS px — below the folded
    // minimum — and the frame is what has to absorb it.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addStyleTag({ content: 'html { zoom: 1.25; }' });
    const measured = await measure(page);
    expect(
      measured.document.scrollWidth,
      'the page scrolls sideways at 125% zoom',
    ).toBeLessThanOrEqual(measured.document.clientWidth);
    // The frame took it, which is the only way the assertion above can be true
    // here — or the zoom did nothing and this test is about 1280 again.
    expect(equationFor(measured)).toBeGreaterThan(measured.frame.clientWidth);
    expect(measured.frame.scrollWidth).toBeGreaterThan(measured.frame.clientWidth);
  });

  test('opens the dependency list wider than the column it drops from', async ({ page }) => {
    // 110px of column, and an entry is a number and a work item's name. The
    // list is declared at 260 and hangs over its neighbours; this is the
    // measurement that number is chosen by.
    await page.setViewportSize({ width: 1280, height: 800 });
    // Two more rows first. 020 already depends on 010 in the seeded plan, so
    // its own list has nothing left to offer and never opens — observed on
    // h2puni, 2026-08-08, `waiting for getByRole('listbox')`. 010 has three
    // rows it could wait for.
    const addRow = page.getByRole('button', { name: 'Add work item' });
    await addRow.click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    await addRow.click();
    await expect(page.getByLabel('Name of 040')).toBeVisible();

    await page.getByLabel('Add a dependency to 010').click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();

    const box = await list.boundingBox();
    expect(
      box?.width,
      'the dependency list is narrower than an entry needs',
    ).toBeGreaterThanOrEqual(260);
    const cell = await page.locator('tbody tr:first-child td[data-column="depends"]').boundingBox();
    // Wider than its own cell, which is the thing the clip exemption is for.
    expect(box?.width).toBeGreaterThan(cell?.width ?? 0);
  });

  test('opens the folded role’s @ picker out past the bottom of a 96px cell', async ({ page }) => {
    // The narrowest clip in the table, on the last row and at a laptop width:
    // a list of people hanging off a cell 96px wide and one line high.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();

    const folded = page.getByLabel('QA estimate for 030');
    await folded.scrollIntoViewIfNeeded();
    await folded.click();
    // A name, not a bare `@`: this deployment has no contributors yet, so a
    // bare `@` offers nobody to assign and nobody to remove and the list does
    // not open at all. Observed on h2puni, 2026-08-08, `waiting for
    // getByRole('listbox', { name: 'QA assignee for 030' })`.
    await folded.fill('@Kat');
    await expect(page.getByRole('listbox', { name: 'QA assignee for 030' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Add “Kat”' })).toBeVisible();

    const escape = await popoverEscape(
      page,
      'last',
      '[role="listbox"]',
      'tbody tr:last-child td[data-column$="-final"]',
    );
    expect(escape.overhang).toBeGreaterThan(8);
    expect(
      escape.ownsPixelBelow,
      `4px below the folded QA cell is ${escape.found}, not the open list`,
    ).toBe(true);
  });

  test('opens the last row’s actions menu at the right edge of a laptop', async ({ page }) => {
    // The menu, in the state the table is actually used in: 1280px, roles
    // folded, on the bottom row and against the right-hand edge — which is
    // where a clipped popover is invisible rather than merely cut short.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Add work item' }).click();
    await expect(page.getByLabel('Name of 030')).toBeVisible();

    const actions = page.getByRole('button', { name: 'Actions for 030' });
    await actions.scrollIntoViewIfNeeded();
    await actions.click();
    await expect(page.getByRole('menu')).toBeVisible();

    const escape = await popoverEscape(
      page,
      'last',
      '[role="menu"]',
      'tbody tr:last-child td[data-column="actions"]',
    );
    expect(escape.overhang).toBeGreaterThan(8);
    expect(
      escape.ownsPixelBelow,
      `4px below the last row's actions cell is ${escape.found}, not the open menu`,
    ).toBe(true);
    // And the whole menu is inside the window, or "visible" means visible to
    // `elementFromPoint` and to nobody else.
    const box = await page.getByRole('menu').boundingBox();
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(box?.x, 'the menu opens off the left of the window').toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  });

  test('is as narrow as the plan lets the earliest-start column be', async ({ page }) => {
    // The two at-rest states, measured. The seeded plan sets no earliest start
    // anywhere, so the column is the narrow one; the moment any row in the
    // project sets a day it is the wide one, on every row at once.
    //
    // Proof: `PLAN_WIDTHS`'s `not-before` entry replaced by a constant 84, the
    // first assertion here failed on `expected 84 to be 56`. Watched,
    // 2026-08-09.
    const undated = await measure(page);
    expect(undated.columns.find((column) => column.id === 'not-before')?.width).toBe(56);
    // The cell really is that column: a `<colgroup>` that declared one width
    // while the browser laid out another is the whole fault this file exists
    // for.
    expect(Math.round(undated.earliestStart.cell)).toBe(56);

    await openEarliestStart(page);
    await page.locator('tbody tr:first-child input[type="date"]').fill('2026-06-10');
    await page.locator('tbody tr:first-child input[type="date"]').blur();
    await expect(page.getByLabel('Earliest start for 010')).toHaveValue('10 Jun');

    const dated = await measure(page);
    expect(dated.columns.find((column) => column.id === 'not-before')?.width).toBe(84);
    expect(Math.round(dated.earliestStart.cell)).toBe(84);
  });

  test('opens an editor no narrower than this browser’s own unconstrained field', async ({
    page,
  }) => {
    // The one number in `table-frame.ts` this repository does not get to
    // choose, held against what Chromium actually wants. `scrollWidth <=
    // clientWidth` was the obvious check here and it could not fail: a date
    // input clips its own internals and reports no overflow at 60px while
    // showing about half a date. Watched on h2puni, 2026-08-08.
    //
    // Proof: `DATE_EDITOR_WIDTH` set to 60, this failed on `Expected: >= 137 /
    // Received: 60`, and `fits every laptop width with the roles folded` with
    // it. Watched, 2026-08-09.
    const measured = await measure(page);

    expect(measured.earliestStart.editor).toBeGreaterThanOrEqual(
      measured.earliestStart.intrinsic - 1,
    );
    // And it is wider than the cell it opened in, which is the whole design:
    // the editor escapes its column rather than sizing it.
    expect(measured.earliestStart.editor).toBeGreaterThan(measured.earliestStart.cell);
  });

  test('draws a dated Start and End on one line', async ({ page }) => {
    // The screenshot this change came from: at 52px `29 Sep` wrapped onto two
    // lines and `29 Sep 2027` onto three, and a wrapped date makes its row
    // taller than every other row on the plan.
    //
    // Proof: `start` and `finish` put back to 52, this failed on `010's Start
    // reads "20 May 2027" on 3 lines`. Watched, 2026-08-10.
    const year = await dateThePlanOffThisYear(page);

    const starts = await dateCells(page, 'start');
    const finishes = await dateCells(page, 'finish');

    // Non-vacuity first, and it is not decoration: without a project start
    // date these cells read `0` and `2.5`, which fit any width ever declared —
    // the check would pass at 52px while saying nothing. The year is what
    // makes the day the widest thing this column prints, and the marker is
    // what End prints besides it.
    expect(starts.map((cell) => cell.text)).toContain(`20 May ${String(year)}`);
    expect(
      finishes.filter((cell) => cell.text.endsWith(' ?')).length,
      'no row is unestimated, so nothing carries the marker End is sized for',
    ).toBeGreaterThan(0);

    for (const [column, cells] of [
      ['Start', starts],
      ['End', finishes],
    ] as const) {
      expect(
        cells
          .filter((cell) => cell.lines !== 1)
          .map((cell) => `${column} reads "${cell.text}" on ${String(cell.lines)} lines`),
        `${column} wraps its day`,
      ).toEqual([]);
    }
  });

  test('is as wide as the widest day the formatter can print', async ({ page }) => {
    // The width both date columns are picked by, measured rather than argued
    // with — and measured against every day the table can print rather than
    // against one somebody chose, so the envelope cannot quietly stop being the
    // widest one.
    //
    // Proof: `DATE_COLUMN_WIDTH` set to 84 — the width `not-before` uses, and
    // the number this change was planned with — this failed on `Start declares
    // 84px where the widest day it can print, "20 May 2027 ?", needs 114`.
    // Watched, 2026-08-10.
    const year = await dateThePlanOffThisYear(page);
    const printable = everyPrintedDay(year, new Date());
    // End draws the marker after the day on an unestimated row, and a marker
    // that wraps is the same failure as a date that wraps — so it is inside
    // the envelope both columns are sized by.
    const candidates = [...printable, ...printable.map((day) => `${day} ?`)];

    const measured = await measureDaysIn(page, 'start', candidates);

    // Or the fixture measured nothing at all and every comparison below is
    // between two zeroes.
    expect(candidates.length).toBeGreaterThan(700);
    expect(measured.envelope).toBeGreaterThan(0);
    // Nothing the formatter prints is wider than the envelope. Stated as
    // widths rather than as `widest.text === DAY_ENVELOPE`: several days are
    // exactly as wide as each other in this font — `10 May 2027 ?` and
    // `20 May 2027 ?` measure the same — so a string comparison would pin
    // which of a set of ties the loop happened to see first, and would have
    // failed for that reason rather than for a day that did not fit.
    expect(
      measured.widest.width,
      `"${measured.widest.text}" is wider than the envelope "${DAY_ENVELOPE}" this column is sized by`,
    ).toBeLessThanOrEqual(measured.envelope);
    for (const column of ['start', 'finish'] as const) {
      expect(
        widthFor(column, SEEDED_PLAN),
        `${column} declares ${String(widthFor(column, SEEDED_PLAN))}px where the widest day it can print, "${DAY_ENVELOPE}", needs ${String(Math.ceil(measured.envelope + measured.chrome))}`,
      ).toBeGreaterThanOrEqual(measured.envelope + measured.chrome);
    }
  });

  test('the Number column fits its envelope', async ({ page }) => {
    // There is no longest work item number, so the column is sized to a stated
    // envelope instead: two levels of number, drawn at the indent a two-level
    // row is drawn at, beside the row's expander and its frozen-number lock.
    // This is the browser that picks that width — `COLUMN_WIDTHS`'s figure is
    // asserted against a measurement, never read off the markup.
    //
    // Proof: `['number', 93]` set to 56, this failed on `Expected: >=
    // 92.5625 / Received: 56`. Watched, 2026-08-10. The same assertion was
    // watched failing at 169 → 56 on 2026-08-09, when the envelope was eleven
    // characters at the deepest indent.
    //
    // 93 is what that measurement picked: 12px of indent, a 12.5px expander, a
    // 20px lock, five characters of number and the cell's 8px of padding.
    await seedDeepBranch(page);
    const envelope = page.getByLabel(`Name of ${ENVELOPE_NUMBER}`, { exact: true });
    await expect(envelope).toBeVisible();
    expect(ENVELOPE_NUMBER.length).toBe(NUMBER_ENVELOPE.length);

    // Frozen, so the lock is on the row and the measurement includes it.
    await page.getByRole('button', { name: 'Freeze numbering' }).click();
    await expect(page.getByLabel('Number is frozen').first()).toBeVisible();

    const needed = await numberCellNeeds(page, ENVELOPE_NUMBER);

    expect(needed.contentWidth).toBeGreaterThan(0);
    // Drawn at the indent the envelope names, or this measurement is about a
    // row at some other depth and the width it picks is that row's.
    expect(needed.indent).toBe(
      `${String(numberIndentFor(NUMBER_ENVELOPE.split('.').length - 1))}px`,
    );
    // The declared width holds everything the cell has to draw: the indent, the
    // expander, the lock and two levels of number.
    expect(widthFor('number', SEEDED_PLAN)).toBeGreaterThanOrEqual(needed.contentWidth);
    // And all of it is really inside the column rather than merely declared to
    // be: `overflow: hidden` would hide the difference otherwise.
    expect(needed.contentRight).toBeLessThanOrEqual(needed.cellRight + 1);
    expect(needed.hasExpander).toBe(true);
    expect(needed.hasLock).toBe(true);
  });

  test('clips a number past the envelope and keeps it whole in the title', async ({ page }) => {
    // The bargain the short dates make, in the Number column: a number the
    // envelope cannot hold is truncated rather than allowed to widen a column
    // that every row in the table would then move with. Nothing is lost — the
    // whole number is in the cell's `title`.
    //
    // Proof: `whiteSpace: 'nowrap'` removed from the Number cell, this failed
    // on `expected true to be false` — a wrapped number overflows its cell
    // downwards rather than sideways, so there is no clip left to observe and
    // the row grows instead. Watched, 2026-08-09.
    await seedDeepBranch(page);
    const past = page.getByLabel(`Name of ${PAST_ENVELOPE_NUMBER}`, { exact: true });
    await expect(past).toBeVisible();
    expect(PAST_ENVELOPE_NUMBER.length).toBeGreaterThan(NUMBER_ENVELOPE.length);
    // Frozen, so both rows carry the lock and the two measurements below differ
    // by their numbers and by nothing else.
    await page.getByRole('button', { name: 'Freeze numbering' }).click();
    await expect(page.getByLabel('Number is frozen').first()).toBeVisible();

    const envelope = await numberCellNeeds(page, ENVELOPE_NUMBER);
    const overrun = await numberCellNeeds(page, PAST_ENVELOPE_NUMBER);

    // The column is the width it was: a longer number moved nothing.
    expect(overrun.cellWidth).toBe(envelope.cellWidth);
    // Clipped rather than wrapped — one line, and more content than fits.
    expect(overrun.clipped).toBe(true);
    expect(overrun.cellHeight).toBe(envelope.cellHeight);
    // And still readable, whole, on hover.
    expect(overrun.title).toBe(PAST_ENVELOPE_NUMBER);
  });

  test('walks the row with Tab in the order the cells are in the DOM', async ({ page }) => {
    // The production grid's own selector, `readonly` and `disabled` included:
    // a parent's rolled-up figures and the earliest-start cell of a plan with
    // no start date are both deliberately stepped over, and a walk that
    // expected them would fail on correct behaviour.
    const expected = await page.evaluate(() => {
      const row = document.querySelector('tbody tr');
      if (row === null) throw new Error('the plan has no rows');
      return [...row.querySelectorAll('[data-cell]:not([readonly]):not([disabled])')].map((cell) =>
        cell.getAttribute('data-cell'),
      );
    });
    expect(expected.length).toBeGreaterThan(4);

    await page.evaluate(() => {
      const name = document.querySelector<HTMLTextAreaElement>('tbody tr [data-cell$="::name"]');
      if (name === null) throw new Error('the first row has no name cell');
      name.focus();
      // The caret at the end, never at zero. At position zero Tab is the
      // outliner's indent — deliberately kept — and a walk started there would
      // restructure the plan instead of moving.
      name.setSelectionRange(name.value.length, name.value.length);
    });

    const walked: (string | null)[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      if (step > 0) await page.keyboard.press('Tab');
      walked.push(
        await page.evaluate(() => document.activeElement?.getAttribute('data-cell') ?? null),
      );
    }

    expect(walked).toEqual(expected);
  });
});

/*
 * PROVING THIS GATE CAN FAIL — every fault below has now been watched.
 *
 * Run on h2puni on 2026-08-08, one fault at a time against the real stack and a
 * real chromium, each reverted before the next. What each run reported is in
 * `openspec/changes/table-geometry-and-tab-order/verify.md`; the observed
 * failure is repeated in one line here so the fault and its evidence stay
 * together. Two predictions written before a browser had ever seen this table
 * turned out to be wrong, and both are corrected below rather than quietly
 * dropped — an expectation nobody checked is the same category of claim R5 is
 * about.
 *
 * FAULT A — a control that asserts a width of its own, in a column too narrow
 * for it. This is the fault class the change removes.
 *   `table-frame.ts`:  ['name', 360]  ->  ['name', 100]
 *   `wbs-table.tsx`:   the Name cell's `width: '100%'`  ->  `width: '22em'`
 * Observed: `keeps every control inside the cell it belongs to` failed on
 * `["Name of 010 in name runs past the name cell", "Name of 020 …"]` against
 * `[]`. The adjacency tests did NOT fail on it, as written: a table never lays
 * two cells on top of each other, so a control overrunning its column is only
 * ever visible as containment. Two other tests did fail, for a reason the
 * prediction missed — a 260px-narrower table no longer scrolls 400px, so
 * `scrollFrameTo` failed its own precondition with `expected 400, received
 * 376`. That is the precondition doing its job, not the pin being measured.
 *
 * FAULT B — two width tables again, which is the bug that shipped.
 *   `table-frame.ts`: replace the derived `PINNED_COLUMNS` with literals,
 *   `[{ id: 'drag', width: 28 }, { id: 'number', width: 180 }, { id: 'name', width: 360 }]`
 * Observed: exactly the two adjacency tests failed, both on the same pair —
 * `{id: 'name', x: 248, width: 360}` followed by `{id: 'depends', x: 596}`,
 * Name pinned 12px into "Depends on" with the frame unscrolled.
 * `table-frame.test.ts` catches this one too; the point of running it here is
 * that this spec sees it in the paint rather than in the numbers.
 *
 * FAULT C — the pin itself.
 *   `table-frame.ts`: drop `position: 'sticky'` from `pinnedCellStyle`.
 * Observed: `holds the pinned columns there once the table is scrolled
 * sideways` failed on `{drag: -400, number: -372, name: -204}` against
 * `{drag: 0, number: 28, name: 196}` — the block scrolled away with its row.
 * The prediction that `paints the pinned block over the row that scrolls
 * behind it` would fail with it was WRONG, and it is worth knowing why: that
 * test asks which cell owns the pixel either side of the *measured* right edge
 * of the Name cell, and an unpinned table answers that question correctly —
 * the neighbour is where the declared widths say it is. Losing the pin is
 * invisible to a probe that follows the cell.
 *
 * FAULT C2 — what the probe does see, found by injecting faults until one bit.
 *   `table-frame.ts`: pin `['name', 'number', 'drag']` instead of
 *   `['drag', 'number', 'name']`.
 * Observed: `paints the pinned block over the row that scrolls behind it, and
 * stops there` failed on `expect(PINNED_IDS).not.toContain('number')`, the
 * received array `["name", "number", "drag"]` — a pinned column painting past
 * the block's own right edge, which is the fault that assertion exists for.
 * Two earlier candidates did NOT break it and are recorded because a failed
 * attempt at a negative test is evidence too: dropping `zIndex` from
 * `pinnedCellStyle` (a sticky cell is positioned, so it still paints over the
 * unpositioned cells sliding behind it — the z-indexes only order the sticky
 * elements against each other), and fault C above.
 *
 * FAULT D — the cell clipping the popovers that have to leave it. This is the
 * fault the first version of this change shipped, on a wrong reading of the
 * CSS: an absolutely positioned box escapes an `overflow: hidden` ancestor
 * only when its containing block is *outside* that ancestor, and both popovers'
 * containing block is a wrapper span inside the cell.
 *   `wbs-table.tsx`: drop the `opensAPopover` spread from the `<td>` style.
 * Observed: both popover tests failed on `ownsPixelBelow`, naming what showed
 * through instead — `4px below the depends cell is <input> in the team column,
 * not the open list` and `4px below the notes cell is <textarea> in the notes
 * column, not the preview`. That second observation was made while a Notes
 * column still existed; the preview hangs off the Name cell since 2026-08-08
 * and the same fault has not been re-run against it — see fault G. The
 * overhang assertions did NOT fail, deliberately:
 * `getBoundingClientRect` reports a clipped box at its full unclipped size, so
 * a check written only on the rectangles would pass with both popovers sliced
 * off at the cell edge. That is the vacuous version of this test, and the
 * reason the hit test is the assertion and the overhang only its precondition.
 *
 * FAULT E — the actions cell clipping the menu that has to leave it. This is
 * the narrowest clip the actions column can have: a 140px menu off a 40px cell
 * one line high.
 *   `wbs-table.tsx`: drop `'actions'` from `POPOVER_COLUMNS`.
 * Observed on h2puni, 2026-08-08: BOTH menu-escape tests failed on
 * `ownsPixelBelow` — `4px below the actions cell is <div> in the no column,
 * not the open menu`, and the same sentence for the last row's. The overhang
 * assertions did NOT fail, as fault D predicted, and `drives the actions menu
 * from the keyboard` passed throughout: clipping is invisible to the focus.
 *
 * FAULT F — the focus not really moving into the menu.
 *   `actions-menu.tsx`: drop `item.focus()` from the effect that follows the
 *   active item.
 * Observed on h2puni, 2026-08-08: `drives the actions menu from the keyboard,
 * and gives the focus back` failed at the first `expect(await
 * focusedText()).toBe('Duplicate')` — `Expected: "Duplicate", Received: "⋯"`,
 * the ⋯ button still holding the focus, exactly as predicted.
 *
 * THE TAB PREDICTION, SETTLED. `actions-menu/verify.md` named the assertion
 * most likely to be wrong: Tab out of an open menu was expected to land on the
 * next row's Name, and would have landed on the still-open menu item if React
 * flushed the close after the browser's default action — a real focus trap.
 * It lands on `Name of 020`. The whole keyboard test passed on the first
 * browser run and on every run since. No bug, no change.
 *
 * FAULT G — the Name cell clipping the preview that now hangs off it. It is a
 * pinned column as well, which is the combination nothing had measured.
 *   `wbs-table.tsx`: drop `'name'` from `POPOVER_COLUMNS`.
 * Observed on h2puni, 2026-08-08: `opens the notes preview out past the bottom
 * of the name cell` failed on `4px below the name cell is <textarea> in the
 * name column, not the preview`. The overhang assertion did not fail.
 *
 * AND THE SAME SENTENCE WITH NO FAULT AT ALL, which is how this test found a
 * real bug on its very first browser run. A pinned cell is `position: sticky`
 * **with a z-index**, so it is a stacking context — the preview inside it was
 * trapped there and the *next* row's pinned Name cell painted straight over
 * it, whatever the preview's own z-index said. `opensAPopover` was already
 * correct and made no difference. Fixed by lifting the hovered row's Name cell
 * to `POPOVER_ROW_LAYER` (`table-frame.ts`), which is why the fault above can
 * now be told apart from the bug underneath it.
 *
 * FAULT H — the caret rule written against logical lines instead of the ends
 * of the value, which is what a browser is needed to tell apart.
 *   `cell-navigation.ts`: the `caret.multiline` gate's `caret.atStart`
 *   replaced by `true`. The plan's instruction named
 *   `!caret.textBefore.includes('\n')`, and `Caret` has no such field — for a
 *   name that is ONE logical line, which this fixture's is, that rule is
 *   `true` at every caret position, so this is that rule injected.
 * Observed on h2puni, 2026-08-08: `moves the caret through a wrapped name
 * before it leaves the row` failed at `await expect(name).toBeFocused()` —
 * `Expected: focused, Received: inactive`, the row above taken while the caret
 * still had visual lines to climb. jsdom cannot see this at all.
 *
 * FAULT I — a fixed width for the Name column, which is the table that made
 * the window fit it rather than the other way round.
 *   `table-frame.ts`: `['name', 360]` back in `COLUMN_WIDTHS` and `name` out
 *   of `FLEXIBLE_COLUMNS`.
 * Observed on h2puni, 2026-08-08: three failed — `fits every laptop width with
 * the roles folded` on `1280×800: the folded equation should fit this viewport,
 * Expected: <= 1200, Received: 1304`; `gives the name column everything the
 * other columns did not take` on `Expected: 256, Received: 360`; and the deep
 * fixture on `the frame scrolls sideways with 1304px of table in 1200px of
 * frame`.
 *
 * FAULT J — the backstop under the minimum: the pin itself.
 *   `table-frame.ts`: drop `'name'` from `PINNED_COLUMNS`.
 * Observed on h2puni, 2026-08-08: three failed, all on `declaredLeft`'s own
 * refusal — `Error: name is not a pinned column` — including `scrolls the
 * frame below the table's minimum, with the name still pinned`. That throw is
 * the check doing its job: a spec that asked where an unpinned column sits
 * would otherwise compare a measurement against nothing.
 *
 * FAULT K — the date column narrower than the browser will have it.
 *   `table-frame.ts`: `['not-before', 146]` → 60.
 * Observed on h2puni, 2026-08-08: two failed — `the earliest-start field is
 * 52px where this browser wants 138px, so its value is cut off, Expected: >=
 * 137, Received: 52`.
 * THE FIRST VERSION OF THIS ASSERTION COULD NOT FAIL, and it is recorded
 * because that is the failure mode this repository keeps having. It compared
 * the input's `scrollWidth` against its `clientWidth`; Chromium lays an
 * `input[type=date]` out at whatever width it is given and clips its own
 * internals *inside* the element, so at 60px it reported no overflow at all
 * and every assertion passed. What replaced it measures an unconstrained
 * `input[type=date]` in the table's own font and holds the column against that
 * — which is also what moved `not-before` from the planned 108 to 146.
 *
 * FAULT L — the folded role's cell clipping the `@` people picker, which is
 * the narrowest clip in the table: a list off a 96px cell one line high.
 *   `wbs-table.tsx`: drop the `-final` suffix from `opensAPopover`.
 * Observed on h2puni, 2026-08-08: `opens the folded role's @ picker out past
 * the bottom of a 96px cell` failed on `4px below the folded QA cell is <div>
 * in the no column, not the open list`.
 *
 * FOUR TESTS IN THIS FILE COULD NOT HAVE PASSED, and a browser is the only
 * thing that could say so. They were written on a machine with none, over
 * changes 1 and 2, and the first run on h2puni reported every one of them:
 * `keeps every control inside the cell it belongs to` wanted more than twelve
 * boxes from a plan that has held exactly twelve since the Notes column moved
 * into the Name cell; `opens a row's actions menu out past the bottom of its
 * own cell` opened the LAST row's menu and probed the FIRST row's cell, which
 * could only ever throw; `moves the caret through a wrapped name` divided by
 * `parseFloat('normal')`, which is `NaN`, so its wrapping precondition was
 * unfailable; and the dependency-list test clicked a box on the one row whose
 * list has nothing left to offer. All four are fixed above.
 */
